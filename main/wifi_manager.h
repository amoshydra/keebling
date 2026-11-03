#pragma once

#include <stdbool.h>
#include "esp_err.h"
#include "esp_wifi_types.h"

// WiFi state machine.
//
// The dongle prefers to join an existing network (STA) so that a phone or
// laptop can reach it without leaving its own network. Running its own SoftAP
// forces the controlling device to switch networks, which loses internet.
//
// Up to five networks are stored in fallback order. The one that joined last is
// remembered separately, so reordering the list does not change where the next
// boot starts.
//
// Security note: the SoftAP is only brought up when it is actually needed --
// either because nothing has been provisioned yet, or because a full pass over
// the stored networks failed. Keeping it up permanently would leave a second,
// always-available way in.

#define WIFI_MGR_MAX_NETS 5

typedef enum {
    WIFI_MGR_AP_ONLY = 0,   // no usable credentials, or STA gave up
    WIFI_MGR_CONNECTING,    // trying to associate with the stored networks
    WIFI_MGR_STA,           // associated and holding an address
} wifi_mgr_state_t;

// One row of the ordered list, as the web UI shows it.
typedef struct {
    char ssid[33];
    bool hidden;
    bool secure;            // a password is stored for it
    bool last;              // this is the remembered last-good network
} wifi_mgr_net_t;

// Netif + event loop + esp_wifi_init. Call once after NVS and security_init.
esp_err_t wifi_mgr_init(void);

// Apply stored credentials: join if we have them, otherwise start the SoftAP.
esp_err_t wifi_mgr_start(void);

// Periodic housekeeping (connect attempts, scan assist, AP fallback). Call from
// a task; it owns the radio and the HTTP handlers only ask it for changes.
void wifi_mgr_tick(void);

// Credentials. The list is ordered; the first one is the normal fallback.
bool wifi_mgr_has_creds(void);
int wifi_mgr_network_count(void);
esp_err_t wifi_mgr_save_net(const char *ssid, const char *pass, bool hidden);
esp_err_t wifi_mgr_forget_net(const char *ssid);   // one network, no reboot
void wifi_mgr_forget(void);                        // all networks
esp_err_t wifi_mgr_set_order(const char *const *order, int count);
esp_err_t wifi_mgr_connect_net(const char *ssid);  // choose and try now

// The old single-network API, kept for callers that still use it.
esp_err_t wifi_mgr_set_creds(const char *ssid, const char *pass);

// Ordered list and membership. Returns how many rows were written.
int wifi_mgr_list(wifi_mgr_net_t *out, int max);
bool wifi_mgr_is_saved(const char *ssid);
const char *wifi_mgr_last_ssid(void);      // "" when none is remembered
const char *wifi_mgr_attempt_ssid(void);   // "" when no attempt is in flight

// Status.
wifi_mgr_state_t wifi_mgr_state(void);
const char *wifi_mgr_ip(void);            // "" when not associated
const char *wifi_mgr_ap_ip(void);         // SoftAP gateway address, "" if down
const char *wifi_mgr_joined_ssid(void);   // "" when not associated
int wifi_mgr_client_count(void);          // stations on the SoftAP

// Scan. Caller frees *out with heap_caps_free().
esp_err_t wifi_mgr_scan(wifi_ap_record_t **out, uint16_t *count);
