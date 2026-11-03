#include "wifi_manager.h"
#include "security.h"
#include "web_server.h"   // AP_SSID

#include "esp_log.h"
#include "esp_mac.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <stdlib.h>
#include <string.h>

static const char *TAG = "wifi_mgr";

#define NVS_NS     "esp32remote"
#define KEY_NETS   "wifi_nets"     // one blob, in fallback order
#define KEY_LAST   "wifi_last"     // the one that worked last, not the order
// Keys written by the one-network build. Read once and moved into the blob so
// an already-provisioned dongle does not come up in access-point mode.
#define KEY_SSID   "wifi_ssid"
#define KEY_PASS   "wifi_pass"

// When provisioned we start STA-only: no SoftAP, so there is no mode switch
// later. This matters because esp_wifi_set_mode() restarts the WiFi stack --
// it drops every TCP connection and can cost the DHCP lease. Turning the AP
// off "once the link is healthy" therefore broke the very connection it was
// meant to leave alone.
//
// The SoftAP is only brought up if a full pass over the stored networks fails,
// which is the one case where it is actually needed.
#define AP_FALLBACK_AFTER_MS   20000

#define RECONNECT_INTERVAL_MS   5000
// Ceiling for the retry backoff. A network that comes back is still found, just
// not by shouting at it every five seconds while it is gone.
#define RECONNECT_MAX_MS        120000
// One candidate gets this long. Association alone is not success; the address
// has to arrive, so the timer also covers DHCP.
#define ATTEMPT_TIMEOUT_MS      8000

// In memory. The password is only read when an attempt starts.
typedef struct {
    char ssid[33];
    char pass[65];
    bool hidden;
} wifi_net_t;

// The NVS layout is fixed and packed: it is a file format, not a C struct to be
// handed around. hidden is a byte so no compiler can insert a padding trap.
typedef struct {
    char ssid[33];
    char pass[65];
    uint8_t hidden;
} __attribute__((packed)) wifi_net_disk_t;

typedef struct {
    uint8_t count;
    wifi_net_disk_t nets[WIFI_MGR_MAX_NETS];
} __attribute__((packed)) wifi_nets_disk_t;

static esp_netif_t *s_ap_netif;
static esp_netif_t *s_sta_netif;

static wifi_mgr_state_t s_state = WIFI_MGR_AP_ONLY;
static wifi_mode_t s_mode = WIFI_MODE_NULL;

static bool s_ap_on;              // SoftAP currently up

static wifi_net_t s_nets[WIFI_MGR_MAX_NETS];   // fallback order
static int s_net_count;
static char s_last_ssid[33];                   // remembered separately from order
static bool s_has_last;

static char s_ip[16];
static char s_joined[33];
static volatile int s_clients;

// One pass over the stored networks. The candidate list is rebuilt once per
// pass; a scan may add to it behind the first attempt.
static bool s_pass_active;
static bool s_scan_pending;
static char s_candidates[WIFI_MGR_MAX_NETS][33];
static int s_candidate_count;
static int s_candidate_pos;

static bool s_attempting;
static bool s_attempt_failed;
static char s_attempt_ssid[33];
static int64_t s_attempt_started_ms;

// A user action can ask for a particular network (or for "do not scan this
// time"). The tick task picks it up, so the HTTP handler never restarts the
// radio underneath itself.
static char s_forced_ssid[33];
static bool s_skip_scan_once;

static int64_t s_disconnected_since_ms;
static int64_t s_next_pass_ms;
static int64_t s_retry_interval_ms = RECONNECT_INTERVAL_MS;

static void ap_apply(bool on);

static inline int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

static int net_index(const char *ssid) {
    if (!ssid || !ssid[0]) return -1;
    for (int i = 0; i < s_net_count; i++) {
        if (strcmp(s_nets[i].ssid, ssid) == 0) return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// NVS
// ---------------------------------------------------------------------------

static esp_err_t nets_save(void) {
    wifi_nets_disk_t d;
    memset(&d, 0, sizeof(d));
    d.count = (uint8_t)s_net_count;
    for (int i = 0; i < s_net_count; i++) {
        snprintf(d.nets[i].ssid, sizeof(d.nets[i].ssid), "%s", s_nets[i].ssid);
        snprintf(d.nets[i].pass, sizeof(d.nets[i].pass), "%s", s_nets[i].pass);
        d.nets[i].hidden = s_nets[i].hidden ? 1 : 0;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;

    err = nvs_set_blob(h, KEY_NETS, &d, sizeof(d));
    if (err == ESP_OK) {
        if (s_has_last && s_last_ssid[0]) {
            err = nvs_set_str(h, KEY_LAST, s_last_ssid);
        } else {
            err = nvs_erase_key(h, KEY_LAST);
            if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
        }
    }
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

// Returns true when a usable blob was found. A missing/corrupt blob is not an
// error: the caller then tries the old single-network keys.
static bool nets_load(void) {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return false;

    wifi_nets_disk_t d;
    size_t sz = sizeof(d);
    bool any = false;
    if (nvs_get_blob(h, KEY_NETS, &d, &sz) == ESP_OK && sz == sizeof(d) &&
        d.count <= WIFI_MGR_MAX_NETS) {
        for (int i = 0; i < d.count; i++) {
            if (d.nets[i].ssid[0] == '\0') continue;
            wifi_net_t *n = &s_nets[s_net_count++];
            snprintf(n->ssid, sizeof(n->ssid), "%s", d.nets[i].ssid);
            snprintf(n->pass, sizeof(n->pass), "%s", d.nets[i].pass);
            n->hidden = d.nets[i].hidden != 0;
            any = true;
        }
    }

    if (any) {
        size_t n = sizeof(s_last_ssid);
        if (nvs_get_str(h, KEY_LAST, s_last_ssid, &n) != ESP_OK) s_last_ssid[0] = '\0';
        s_has_last = s_last_ssid[0] && net_index(s_last_ssid) >= 0;
        if (!s_has_last) s_last_ssid[0] = '\0';
    }
    nvs_close(h);
    return any;
}

static void creds_migrate_legacy(void) {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;

    char ssid[33] = {0};
    char pass[65] = {0};
    size_t n = sizeof(ssid);
    esp_err_t err = nvs_get_str(h, KEY_SSID, ssid, &n);
    if (err == ESP_OK && ssid[0]) {
        n = sizeof(pass);
        if (nvs_get_str(h, KEY_PASS, pass, &n) != ESP_OK) pass[0] = '\0';

        snprintf(s_nets[0].ssid, sizeof(s_nets[0].ssid), "%s", ssid);
        snprintf(s_nets[0].pass, sizeof(s_nets[0].pass), "%s", pass);
        s_nets[0].hidden = false;
        s_net_count = 1;
        snprintf(s_last_ssid, sizeof(s_last_ssid), "%s", ssid);
        s_has_last = true;
        nets_save();

        // The blob is authoritative from now on. Leaving the old pair behind
        // would make a later rollback silently revive a network the user has
        // since forgotten.
        nvs_erase_key(h, KEY_SSID);
        nvs_erase_key(h, KEY_PASS);
        nvs_commit(h);
        ESP_LOGI(TAG, "migrated the single stored network to the list");
    }
    nvs_close(h);
}

static void creds_load(void) {
    if (!nets_load()) creds_migrate_legacy();
    if (s_net_count > 0) {
        ESP_LOGI(TAG, "%d stored network%s%s%s", s_net_count,
                 s_net_count == 1 ? "" : "s",
                 s_has_last ? ", last good " : "",
                 s_has_last ? s_last_ssid : "");
    }
}

bool wifi_mgr_has_creds(void) { return s_net_count > 0; }
int wifi_mgr_network_count(void) { return s_net_count; }
const char *wifi_mgr_last_ssid(void) { return s_has_last ? s_last_ssid : ""; }
const char *wifi_mgr_attempt_ssid(void) {
    if (s_attempting) return s_attempt_ssid;
    return s_forced_ssid[0] ? s_forced_ssid : "";   // handed to the tick task
}

bool wifi_mgr_is_saved(const char *ssid) { return net_index(ssid) >= 0; }

int wifi_mgr_list(wifi_mgr_net_t *out, int max) {
    if (!out || max <= 0) return 0;
    int n = s_net_count < max ? s_net_count : max;
    for (int i = 0; i < n; i++) {
        snprintf(out[i].ssid, sizeof(out[i].ssid), "%s", s_nets[i].ssid);
        out[i].hidden = s_nets[i].hidden;
        out[i].secure = s_nets[i].pass[0] != '\0';
        out[i].last = s_has_last && strcmp(s_nets[i].ssid, s_last_ssid) == 0;
    }
    return n;
}

esp_err_t wifi_mgr_save_net(const char *ssid, const char *pass, bool hidden) {
    if (!ssid || !ssid[0] || strlen(ssid) > 32) return ESP_ERR_INVALID_ARG;
    if (strlen(pass ? pass : "") > 64) return ESP_ERR_INVALID_ARG;

    int idx = net_index(ssid);
    bool was_empty = s_net_count == 0;
    bool is_new = idx < 0;
    if (is_new) {
        if (s_net_count >= WIFI_MGR_MAX_NETS) return ESP_ERR_INVALID_STATE;
        idx = s_net_count++;
    }

    snprintf(s_nets[idx].ssid, sizeof(s_nets[idx].ssid), "%s", ssid);
    snprintf(s_nets[idx].pass, sizeof(s_nets[idx].pass), "%s", pass ? pass : "");
    s_nets[idx].hidden = hidden;

    esp_err_t err = nets_save();
    if (err != ESP_OK) return err;

    // A network the user just added should not wait out a backoff that
    // accumulated while nothing was reachable. If we are already joined, keep
    // the link: the new network is only used when chosen or next time.
    s_retry_interval_ms = RECONNECT_INTERVAL_MS;
    if (s_state != WIFI_MGR_STA && !s_pass_active) s_next_pass_ms = 0;
    if (was_empty) s_state = WIFI_MGR_CONNECTING;
    ESP_LOGI(TAG, "stored network %s: \"%s\"%s", is_new ? "added" : "updated",
             ssid, hidden ? " (hidden)" : "");
    return ESP_OK;
}

// Kept for the old settings endpoint and any caller that predates the list.
esp_err_t wifi_mgr_set_creds(const char *ssid, const char *pass) {
    return wifi_mgr_save_net(ssid, pass, false);
}

static void clear_all(void) {
    s_net_count = 0;
    s_last_ssid[0] = '\0';
    s_has_last = false;
    s_candidate_count = 0;
    s_candidate_pos = 0;
    s_pass_active = false;
    s_attempting = false;
    s_attempt_failed = false;
    s_attempt_ssid[0] = '\0';
    s_forced_ssid[0] = '\0';
    s_skip_scan_once = false;
    nets_save();
}

void wifi_mgr_forget(void) {
    bool was_joined = s_state == WIFI_MGR_STA;
    clear_all();
    s_ip[0] = '\0';
    s_joined[0] = '\0';
    s_state = WIFI_MGR_AP_ONLY;
    if (was_joined) esp_wifi_disconnect();
    ap_apply(true);
    ESP_LOGW(TAG, "all stored networks erased");
}

esp_err_t wifi_mgr_forget_net(const char *ssid) {
    int idx = net_index(ssid);
    if (idx < 0) return ESP_ERR_NOT_FOUND;

    bool was_active = s_joined[0] && strcmp(s_joined, ssid) == 0;
    bool was_last = s_has_last && strcmp(s_last_ssid, ssid) == 0;
    bool was_attempt = s_attempting && strcmp(s_attempt_ssid, ssid) == 0;

    for (int i = idx; i + 1 < s_net_count; i++) s_nets[i] = s_nets[i + 1];
    s_net_count--;
    memset(&s_nets[s_net_count], 0, sizeof(s_nets[0]));

    if (was_last) {
        s_last_ssid[0] = '\0';
        s_has_last = false;
    }
    nets_save();

    if (s_net_count == 0) {
        s_pass_active = false;
        s_attempting = false;
        s_attempt_failed = false;
        s_attempt_ssid[0] = '\0';
        s_candidate_count = 0;
        s_candidate_pos = 0;
        s_state = WIFI_MGR_AP_ONLY;
        if (was_active) esp_wifi_disconnect();
        s_ip[0] = '\0';
        s_joined[0] = '\0';
        ap_apply(true);
        ESP_LOGW(TAG, "last stored network erased");
        return ESP_OK;
    }

    if (was_active || was_attempt) {
        // Move on to the next stored candidate without a scan: the user has
        // just said this one is not wanted, so waiting on the radio to survey
        // the room would only make the UI feel broken.
        s_skip_scan_once = true;
        s_pass_active = false;
        s_attempting = false;
        s_attempt_failed = false;
        s_attempt_ssid[0] = '\0';
        s_candidate_count = 0;
        s_candidate_pos = 0;
        s_retry_interval_ms = RECONNECT_INTERVAL_MS;
        s_next_pass_ms = 0;
        s_state = WIFI_MGR_CONNECTING;
        if (was_active) esp_wifi_disconnect();
        s_ip[0] = '\0';
        s_joined[0] = '\0';
    }
    ESP_LOGW(TAG, "network erased: \"%s\"", ssid);
    return ESP_OK;
}

esp_err_t wifi_mgr_set_order(const char *const *order, int count) {
    if (!order || count != s_net_count || count < 0) return ESP_ERR_INVALID_ARG;

    wifi_net_t tmp[WIFI_MGR_MAX_NETS];
    bool used[WIFI_MGR_MAX_NETS] = { false };
    for (int i = 0; i < count; i++) {
        int found = -1;
        for (int j = 0; j < s_net_count; j++) {
            if (!used[j] && order[i] && strcmp(s_nets[j].ssid, order[i]) == 0) {
                found = j;
                break;
            }
        }
        if (found < 0) return ESP_ERR_INVALID_ARG;   // not a permutation
        used[found] = true;
        tmp[i] = s_nets[found];
    }
    memcpy(s_nets, tmp, sizeof(wifi_net_t) * (size_t)count);
    return nets_save();
}

esp_err_t wifi_mgr_connect_net(const char *ssid) {
    if (net_index(ssid) < 0) return ESP_ERR_NOT_FOUND;

    bool joined = s_state == WIFI_MGR_STA && s_joined[0] && strcmp(s_joined, ssid) == 0;
    snprintf(s_last_ssid, sizeof(s_last_ssid), "%s", ssid);
    s_has_last = true;
    nets_save();

    if (joined) {
        ESP_LOGI(TAG, "already joined \"%s\"", ssid);
        return ESP_OK;
    }

    // The tick task owns the radio. Hand it the requested network as the first
    // candidate and let the normal fallback run if it does not answer.
    snprintf(s_forced_ssid, sizeof(s_forced_ssid), "%s", ssid);
    s_skip_scan_once = false;
    s_pass_active = false;
    s_attempting = false;
    s_attempt_failed = false;
    s_attempt_ssid[0] = '\0';
    s_candidate_count = 0;
    s_candidate_pos = 0;
    s_retry_interval_ms = RECONNECT_INTERVAL_MS;
    s_next_pass_ms = 0;
    s_state = WIFI_MGR_CONNECTING;
    esp_wifi_disconnect();
    s_ip[0] = '\0';
    s_joined[0] = '\0';
    ESP_LOGI(TAG, "connecting to \"%s\" on request", ssid);
    return ESP_OK;
}

// ---------------------------------------------------------------------------
// Mode / AP control
// ---------------------------------------------------------------------------

// Build and apply the SoftAP config. Only valid once the mode includes AP --
// esp_wifi_set_config() rejects an interface the current mode does not have,
// which is why this is never called while running STA-only.
static esp_err_t ap_config(void) {
    wifi_config_t ap = { 0 };
    snprintf((char *)ap.ap.ssid, sizeof(ap.ap.ssid), "%s", AP_SSID);
    ap.ap.ssid_len = strlen(AP_SSID);
    ap.ap.channel = 1;
    ap.ap.max_connection = 4;
    ap.ap.authmode = WIFI_AUTH_WPA2_PSK;
    snprintf((char *)ap.ap.password, sizeof(ap.ap.password), "%s", security_code());
    return esp_wifi_set_config(WIFI_IF_AP, &ap);
}

// Switching mode restarts the WiFi interfaces, so it is only ever done once,
// and only to bring the SoftAP *up* -- never to take it away.
static void ap_apply(bool on) {
    if (on == s_ap_on) return;

    wifi_mode_t want = on ? WIFI_MODE_APSTA : WIFI_MODE_STA;
    esp_err_t err = esp_wifi_set_mode(want);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "set_mode(%d) failed: %s", (int)want, esp_err_to_name(err));
        return;
    }
    s_ap_on = on;
    s_mode = want;

    if (on) {
        err = ap_config();
        if (err != ESP_OK) ESP_LOGE(TAG, "AP config: %s", esp_err_to_name(err));
    }
    ESP_LOGI(TAG, "SoftAP %s", on ? "up" : "down");
}

// ---------------------------------------------------------------------------
// One pass over the stored networks
// ---------------------------------------------------------------------------

static void candidate_add(const char *ssid) {
    if (!ssid || !ssid[0]) return;
    if (s_candidate_count >= WIFI_MGR_MAX_NETS) return;
    for (int i = 0; i < s_candidate_count; i++) {
        if (strcmp(s_candidates[i], ssid) == 0) return;
    }
    snprintf(s_candidates[s_candidate_count++], sizeof(s_candidates[0]), "%s", ssid);
}

// After the remembered network has failed, ask the radio what is actually in
// range. Only stored networks are candidates; the strongest of those goes
// first. Hidden networks never appear here, which is why the stored order is
// appended afterwards.
static void candidates_scan(void) {
    if (!s_scan_pending) return;
    s_scan_pending = false;

    // Scanning takes the radio away from the access point we may be serving.
    // If someone is on it, skip the survey and use the stored order instead.
    if (s_clients == 0) {
        wifi_ap_record_t *recs = NULL;
        uint16_t n = 0;
        if (wifi_mgr_scan(&recs, &n) == ESP_OK) {
            int8_t rssi[WIFI_MGR_MAX_NETS];
            bool seen[WIFI_MGR_MAX_NETS] = { false };
            for (uint16_t i = 0; i < n; i++) {
                int idx = net_index((const char *)recs[i].ssid);
                if (idx < 0) continue;
                if (!seen[idx] || recs[i].rssi > rssi[idx]) {
                    rssi[idx] = recs[i].rssi;
                    seen[idx] = true;
                }
            }
            free(recs);

            // The strongest visible candidate goes next; everything else is
            // tried in the stored order below. That order is what covers a
            // hidden SSID, which never appears in a scan at all.
            int best = -1;
            for (int i = 0; i < s_net_count; i++) {
                if (!seen[i]) continue;
                if (best < 0 || rssi[i] > rssi[best]) best = i;
            }
            if (best >= 0) candidate_add(s_nets[best].ssid);
        }
    }

    for (int i = 0; i < s_net_count; i++) candidate_add(s_nets[i].ssid);
}

static void attempt_start(const char *ssid) {
    int idx = net_index(ssid);
    if (idx < 0) return;

    wifi_config_t sta = { 0 };
    // strncpy rather than snprintf: the source buffers are one byte larger than
    // the fields, which makes -Wformat-truncation fire on a copy that is in
    // fact always terminated by the zero-initialised struct.
    strncpy((char *)sta.sta.ssid, s_nets[idx].ssid, sizeof(sta.sta.ssid) - 1);
    strncpy((char *)sta.sta.password, s_nets[idx].pass, sizeof(sta.sta.password) - 1);
    sta.sta.threshold.authmode = WIFI_AUTH_OPEN;   // accept whatever the AP uses
    if (s_nets[idx].hidden) sta.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;

    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &sta);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "STA config \"%s\": %s", ssid, esp_err_to_name(err));
        return;   // tick calls us again, and candidate_pos has already moved on
    }

    snprintf(s_attempt_ssid, sizeof(s_attempt_ssid), "%s", ssid);
    s_attempting = true;
    s_attempt_failed = false;
    s_attempt_started_ms = now_ms();
    s_state = WIFI_MGR_CONNECTING;
    ESP_LOGI(TAG, "trying \"%s\"%s", ssid, s_nets[idx].hidden ? " (hidden)" : "");

    err = esp_wifi_connect();
    if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) {
        ESP_LOGD(TAG, "connect \"%s\": %s", ssid, esp_err_to_name(err));
        s_attempt_failed = true;
    }
}

static void pass_begin(const char *first, bool allow_scan) {
    s_pass_active = true;
    s_attempting = false;
    s_attempt_failed = false;
    s_attempt_ssid[0] = '\0';
    s_candidate_count = 0;
    s_candidate_pos = 0;
    s_scan_pending = allow_scan && s_clients == 0;
    s_state = WIFI_MGR_CONNECTING;
    s_disconnected_since_ms = now_ms();
    s_next_pass_ms = 0;

    const char *seed = (first && net_index(first) >= 0) ? first
                     : (s_has_last && net_index(s_last_ssid) >= 0) ? s_last_ssid
                     : (s_net_count > 0) ? s_nets[0].ssid
                     : NULL;
    if (seed) candidate_add(seed);

    // Without a scan to wait for, the whole fallback order is known up front.
    if (!s_scan_pending) {
        for (int i = 0; i < s_net_count; i++) candidate_add(s_nets[i].ssid);
    }
}

static void pass_finish(void) {
    s_pass_active = false;
    s_attempting = false;
    s_attempt_failed = false;
    s_attempt_ssid[0] = '\0';
    s_state = s_net_count > 0 ? WIFI_MGR_CONNECTING : WIFI_MGR_AP_ONLY;
    s_disconnected_since_ms = now_ms();

    // A complete pass has failed, so the device would otherwise be invisible.
    // The AP stays up from here: a flaky network must not make the mode flap.
    if (!s_ap_on) {
        ESP_LOGW(TAG, "no stored network answered - bringing the SoftAP back");
        ap_apply(true);
    }

    // Retry the whole list, backing off while it keeps failing. Each pass takes
    // the radio away from the access point, so a fixed five seconds would cost
    // the AP a large share of its packets - measured.
    s_next_pass_ms = now_ms() + s_retry_interval_ms;
    if (s_retry_interval_ms < RECONNECT_MAX_MS) {
        s_retry_interval_ms = (s_retry_interval_ms * 2 > RECONNECT_MAX_MS)
                                ? RECONNECT_MAX_MS : s_retry_interval_ms * 2;
    }
    ESP_LOGW(TAG, "network pass finished without a link");
}

static void pass_advance(void) {
    if (!s_pass_active || s_attempting) return;

    // The remembered network (or a network the user chose) is attempted before
    // the survey: a scan costs seconds and is only useful once that one has
    // failed. This is the fast path for the common case.
    if (s_candidate_pos > 0) candidates_scan();
    if (s_candidate_pos < s_candidate_count) {
        const char *ssid = s_candidates[s_candidate_pos++];
        attempt_start(ssid);
        return;
    }
    pass_finish();
}

// A successful association is not enough: the address is the point. Move the
// winner to the front so the next boot starts there, and remember it
// separately so a later reorder does not lose it.
static void note_success(const char *ssid) {
    if (!ssid || !ssid[0]) return;
    int idx = net_index(ssid);
    if (idx < 0) return;

    bool order_changed = idx != 0;
    if (order_changed) {
        wifi_net_t won = s_nets[idx];
        for (int i = idx; i > 0; i--) s_nets[i] = s_nets[i - 1];
        s_nets[0] = won;
    }

    bool last_changed = !s_has_last || strcmp(s_last_ssid, ssid) != 0;
    snprintf(s_last_ssid, sizeof(s_last_ssid), "%s", ssid);
    s_has_last = true;
    if (order_changed || last_changed) nets_save();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    switch (id) {
    case WIFI_EVENT_STA_START:
        // The tick task starts the first pass. Doing it here as well only
        // produced "sta is connecting" and raced the candidate order.
        break;

    case WIFI_EVENT_STA_DISCONNECTED: {
        wifi_event_sta_disconnected_t *e = data;
        const bool had_link = s_state == WIFI_MGR_STA;
        // Logged only when we were actually associated. A network that has gone
        // away is retried every few seconds, and a warning per retry fills the
        // whole 4 KB log ring - which then hides everything else, including
        // whatever you opened the log to find.
        if (had_link) {
            ESP_LOGW(TAG, "STA disconnected, reason %d", e->reason);
            s_state = WIFI_MGR_CONNECTING;
        }
        s_ip[0] = '\0';
        s_joined[0] = '\0';

        // ASSOC_LEAVE is what our own esp_wifi_disconnect() produces: it is a
        // deliberate move to the next candidate, not a failure of this one.
        if (s_attempting && e->reason != WIFI_REASON_ASSOC_LEAVE) {
            s_attempt_failed = true;
        }
        if (!s_pass_active) {
            if (s_disconnected_since_ms == 0) s_disconnected_since_ms = now_ms();
            // Only a link we actually had should start a new pass immediately.
            // A mode switch during pass_finish also emits a disconnect, and
            // resetting the backoff there made the device scan and retry in a
            // tight loop while the SoftAP was up.
            if (had_link) s_next_pass_ms = 0;
        }
        break;
    }

    case WIFI_EVENT_AP_STACONNECTED: {
        wifi_event_ap_staconnected_t *e = data;
        s_clients++;
        ESP_LOGI(TAG, "AP client " MACSTR " joined (%d)", MAC2STR(e->mac), s_clients);
        break;
    }
    case WIFI_EVENT_AP_STADISCONNECTED: {
        wifi_event_ap_stadisconnected_t *e = data;
        if (s_clients > 0) s_clients--;
        ESP_LOGI(TAG, "AP client " MACSTR " left (%d)", MAC2STR(e->mac), s_clients);
        break;
    }
    default:
        break;
    }
}

static void on_ip_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (id != IP_EVENT_STA_GOT_IP) return;
    ip_event_got_ip_t *e = data;

    snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&e->ip_info.ip));
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        snprintf(s_joined, sizeof(s_joined), "%s", (const char *)ap.ssid);
    } else if (s_attempt_ssid[0]) {
        snprintf(s_joined, sizeof(s_joined), "%s", s_attempt_ssid);
    }
    s_attempting = false;
    s_attempt_failed = false;
    s_pass_active = false;
    s_state = WIFI_MGR_STA;
    s_disconnected_since_ms = 0;
    s_retry_interval_ms = RECONNECT_INTERVAL_MS;   // joined: forget the backoff
    note_success(s_joined);
    ESP_LOGI(TAG, "joined \"%s\" as %s", s_joined, s_ip);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

esp_err_t wifi_mgr_init(void) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    s_ap_netif = esp_netif_create_default_wifi_ap();
    s_sta_netif = esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &on_ip_event, NULL, NULL));

    creds_load();
    return ESP_OK;
}

esp_err_t wifi_mgr_start(void) {
    // Order matters: esp_wifi_set_config() rejects an interface that the
    // current mode does not include, so the mode has to be chosen first.
    // Configuring the AP while heading for STA-only is what produced a boot
    // loop -- ESP_ERROR_CHECK turned that rejection into an abort.
    wifi_mode_t mode = s_net_count > 0 ? WIFI_MODE_STA : WIFI_MODE_APSTA;
    esp_err_t err = esp_wifi_set_mode(mode);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "set_mode(%d): %s", (int)mode, esp_err_to_name(err));
        return err;
    }
    s_mode = mode;
    s_ap_on = (mode == WIFI_MODE_APSTA);
    s_state = s_net_count > 0 ? WIFI_MGR_CONNECTING : WIFI_MGR_AP_ONLY;
    s_disconnected_since_ms = now_ms();
    s_next_pass_ms = 0;

    if (s_ap_on) {
        err = ap_config();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "AP config: %s", esp_err_to_name(err));
            return err;
        }
    }

    err = esp_wifi_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_start: %s", esp_err_to_name(err));
        return err;
    }
    esp_wifi_set_ps(WIFI_PS_NONE);   // keep HID latency low

    ESP_LOGI(TAG, "%s", s_net_count > 0 ? "joining a stored network (STA only)"
                                        : "no stored network - SoftAP only");
    // No explicit esp_wifi_connect() here: the tick task starts the first pass,
    // which knows the remembered network and the fallback order.
    return ESP_OK;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

void wifi_mgr_tick(void) {
    const int64_t t = now_ms();

    if (s_state == WIFI_MGR_STA) {
        s_disconnected_since_ms = 0;
        return;
    }

    if (s_net_count == 0) {
        if (!s_ap_on) ap_apply(true);
        return;
    }

    if (s_pass_active) {
        if (!s_attempting) {
            pass_advance();
            return;
        }

        // A known failure advances immediately; a silent one gets the timeout.
        // Either way this covers a full pass before the AP fallback is used.
        if (s_attempt_failed || (t - s_attempt_started_ms) >= ATTEMPT_TIMEOUT_MS) {
            if (!s_attempt_failed) {
                ESP_LOGW(TAG, "\"%s\" timed out after %d s", s_attempt_ssid,
                         ATTEMPT_TIMEOUT_MS / 1000);
                esp_wifi_disconnect();
            }
            s_attempting = false;
            s_attempt_failed = false;
            s_attempt_ssid[0] = '\0';
            pass_advance();
        }
        return;
    }

    if (t >= s_next_pass_ms) {
        char first[33];
        snprintf(first, sizeof(first), "%s", s_forced_ssid);
        bool scan = !s_skip_scan_once;
        s_forced_ssid[0] = '\0';
        s_skip_scan_once = false;
        pass_begin(first[0] ? first : NULL, scan);
        pass_advance();
        return;
    }

    // Between passes the SoftAP should be up (pass_finish put it there). Keep
    // that true even if a mode change failed earlier.
    if (!s_ap_on && (t - s_disconnected_since_ms) > AP_FALLBACK_AFTER_MS) ap_apply(true);
}

wifi_mgr_state_t wifi_mgr_state(void) { return s_state; }
const char *wifi_mgr_ip(void) { return s_ip; }
const char *wifi_mgr_joined_ssid(void) { return s_joined; }
int wifi_mgr_client_count(void) { return s_clients; }

const char *wifi_mgr_ap_ip(void) {
    static char buf[16];
    if (!s_ap_on || !s_ap_netif) return "";     // down: do not match 0.0.0.0
    esp_netif_ip_info_t ip;
    if (esp_netif_get_ip_info(s_ap_netif, &ip) != ESP_OK || ip.ip.addr == 0) return "";
    snprintf(buf, sizeof(buf), IPSTR, IP2STR(&ip.ip));
    return buf;
}

esp_err_t wifi_mgr_scan(wifi_ap_record_t **out, uint16_t *count) {
    if (!out || !count) return ESP_ERR_INVALID_ARG;
    *out = NULL;
    *count = 0;

    wifi_scan_config_t sc = { 0 };
    // Scanning briefly disturbs the AP; that is acceptable for a setup page.
    esp_err_t err = esp_wifi_scan_start(&sc, true);
    if (err != ESP_OK) return err;

    uint16_t n = 0;
    ESP_ERROR_CHECK(esp_wifi_scan_get_ap_num(&n));
    if (n == 0) return ESP_OK;

    wifi_ap_record_t *recs = calloc(n, sizeof(wifi_ap_record_t));
    if (!recs) return ESP_ERR_NO_MEM;
    if (esp_wifi_scan_get_ap_records(&n, recs) != ESP_OK) {
        free(recs);
        return ESP_FAIL;
    }
    *out = recs;
    *count = n;
    return ESP_OK;
}
