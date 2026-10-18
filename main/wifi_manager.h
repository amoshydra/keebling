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
// Security note: the SoftAP is only brought up when it is actually needed --
// either because nothing has been provisioned yet, or because STA cannot reach
// the network. Keeping it up permanently would leave a second, always-available
// way in.

typedef enum {
    WIFI_MGR_AP_ONLY = 0,   // no usable credentials, or STA gave up
    WIFI_MGR_CONNECTING,    // trying to associate with the stored network
    WIFI_MGR_STA,           // associated and holding an address
} wifi_mgr_state_t;

// Netif + event loop + esp_wifi_init. Call once after NVS and security_init.
esp_err_t wifi_mgr_init(void);

// Apply stored credentials: join if we have them, otherwise start the SoftAP.
esp_err_t wifi_mgr_start(void);

// Periodic housekeeping (connect retries, AP fallback). Call from a task.
void wifi_mgr_tick(void);

// Credentials.
bool wifi_mgr_has_creds(void);
esp_err_t wifi_mgr_set_creds(const char *ssid, const char *pass);
void wifi_mgr_forget(void);

// Status.
wifi_mgr_state_t wifi_mgr_state(void);
const char *wifi_mgr_ip(void);            // "" when not associated
const char *wifi_mgr_ap_ip(void);         // SoftAP gateway address, "" if down
const char *wifi_mgr_joined_ssid(void);   // "" when not associated
int wifi_mgr_client_count(void);          // stations on the SoftAP

// Scan. Caller frees *out with heap_caps_free().
esp_err_t wifi_mgr_scan(wifi_ap_record_t **out, uint16_t *count);
