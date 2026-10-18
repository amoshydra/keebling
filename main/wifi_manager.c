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

#include <string.h>

static const char *TAG = "wifi_mgr";

#define NVS_NS    "esp32remote"
#define KEY_SSID  "wifi_ssid"
#define KEY_PASS  "wifi_pass"

// When provisioned we start STA-only: no SoftAP, so there is no mode switch
// later. This matters because esp_wifi_set_mode() restarts the WiFi stack --
// it drops every TCP connection and can cost the DHCP lease. Turning the AP
// off "once the link is healthy" therefore broke the very connection it was
// meant to leave alone.
//
// The SoftAP is only brought up if STA cannot associate, which is the one case
// where it is actually needed.
#define AP_FALLBACK_AFTER_MS   20000

#define RECONNECT_INTERVAL_MS   5000

static esp_netif_t *s_ap_netif;
static esp_netif_t *s_sta_netif;

static wifi_mgr_state_t s_state = WIFI_MGR_AP_ONLY;
static wifi_mode_t s_mode = WIFI_MODE_NULL;

static bool s_ap_on;              // SoftAP currently up

static bool s_creds;              // credentials present
static char s_ssid[33];
static char s_pass[65];

static char s_ip[16];
static char s_joined[33];
static volatile int s_clients;

static int64_t s_disconnected_since_ms;
static int64_t s_last_retry_ms;

static inline int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

// ---------------------------------------------------------------------------
// NVS
// ---------------------------------------------------------------------------

static void creds_load(void) {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return;

    size_t n = sizeof(s_ssid);
    if (nvs_get_str(h, KEY_SSID, s_ssid, &n) != ESP_OK || s_ssid[0] == '\0') {
        nvs_close(h);
        return;
    }
    n = sizeof(s_pass);
    if (nvs_get_str(h, KEY_PASS, s_pass, &n) != ESP_OK) s_pass[0] = '\0';
    s_creds = true;
    nvs_close(h);
    ESP_LOGI(TAG, "stored network: \"%s\"", s_ssid);
}

bool wifi_mgr_has_creds(void) { return s_creds; }

esp_err_t wifi_mgr_set_creds(const char *ssid, const char *pass) {
    if (!ssid || !ssid[0] || strlen(ssid) > 32) return ESP_ERR_INVALID_ARG;
    if (strlen(pass) > 64) return ESP_ERR_INVALID_ARG;

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;

    err = nvs_set_str(h, KEY_SSID, ssid);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_PASS, pass ? pass : "");
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) return err;

    snprintf(s_ssid, sizeof(s_ssid), "%s", ssid);
    snprintf(s_pass, sizeof(s_pass), "%s", pass ? pass : "");
    s_creds = true;
    ESP_LOGI(TAG, "stored network updated: \"%s\"", s_ssid);
    return ESP_OK;
}

void wifi_mgr_forget(void) {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_key(h, KEY_SSID);
        nvs_erase_key(h, KEY_PASS);
        nvs_commit(h);
        nvs_close(h);
    }
    s_creds = false;
    s_ssid[0] = '\0';
    s_pass[0] = '\0';
    ESP_LOGW(TAG, "network credentials erased");
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
// Events
// ---------------------------------------------------------------------------

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    switch (id) {
    case WIFI_EVENT_STA_START:
        if (s_creds) esp_wifi_connect();
        break;

    case WIFI_EVENT_STA_DISCONNECTED: {
        wifi_event_sta_disconnected_t *e = data;
        ESP_LOGW(TAG, "STA disconnected, reason %d", e->reason);
        if (s_state == WIFI_MGR_STA) s_state = WIFI_MGR_CONNECTING;
        s_ip[0] = '\0';
        s_joined[0] = '\0';
        if (s_disconnected_since_ms == 0) s_disconnected_since_ms = now_ms();
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
    }
    s_state = WIFI_MGR_STA;
    s_disconnected_since_ms = 0;
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
    wifi_mode_t mode = s_creds ? WIFI_MODE_STA : WIFI_MODE_APSTA;
    esp_err_t err = esp_wifi_set_mode(mode);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "set_mode(%d): %s", (int)mode, esp_err_to_name(err));
        return err;
    }
    s_mode = mode;
    s_ap_on = (mode == WIFI_MODE_APSTA);
    s_state = s_creds ? WIFI_MGR_CONNECTING : WIFI_MGR_AP_ONLY;
    s_disconnected_since_ms = now_ms();

    if (s_ap_on) {
        err = ap_config();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "AP config: %s", esp_err_to_name(err));
            return err;
        }
    }

    if (s_creds) {
        wifi_config_t sta = { 0 };
        // strncpy rather than snprintf: the source buffers are one byte larger
        // than the fields, which makes -Wformat-truncation fire on a copy that
        // is in fact always terminated by the zero-initialised struct.
        strncpy((char *)sta.sta.ssid, s_ssid, sizeof(sta.sta.ssid) - 1);
        strncpy((char *)sta.sta.password, s_pass, sizeof(sta.sta.password) - 1);
        sta.sta.threshold.authmode = WIFI_AUTH_OPEN;   // accept whatever the AP uses
        err = esp_wifi_set_config(WIFI_IF_STA, &sta);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "STA config: %s", esp_err_to_name(err));
            return err;
        }
    }

    err = esp_wifi_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_start: %s", esp_err_to_name(err));
        return err;
    }
    esp_wifi_set_ps(WIFI_PS_NONE);   // keep HID latency low

    ESP_LOGI(TAG, "%s", s_creds ? "joining stored network (STA only)"
                                : "no stored network - SoftAP only");
    // No explicit esp_wifi_connect() here: the WIFI_EVENT_STA_START handler
    // does it. Calling it in both places just logs "sta is connecting".
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

    // Not associated. If this drags on, bring the SoftAP up so the device is
    // still reachable - and leave it up, so a flaky network cannot make the
    // mode flap.
    if (s_disconnected_since_ms == 0) s_disconnected_since_ms = t;

    if (!s_ap_on && (t - s_disconnected_since_ms) > AP_FALLBACK_AFTER_MS) {
        ESP_LOGW(TAG, "STA unreachable for %d s - bringing the SoftAP back",
                 AP_FALLBACK_AFTER_MS / 1000);
        ap_apply(true);
    }

    // Retry the association at a steady interval.
    if (s_creds && (t - s_last_retry_ms) > RECONNECT_INTERVAL_MS) {
        s_last_retry_ms = t;
        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) {
            ESP_LOGD(TAG, "reconnect: %s", esp_err_to_name(err));
        }
    }
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
