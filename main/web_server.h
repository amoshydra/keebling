#pragma once

#include "esp_err.h"

#include "web_origin.h"   // WEB_APP_ORIGIN, WEB_APP_ORIGIN_DEV

// Network identity. Note the SoftAP password is NOT here: it is the random
// per-device code produced by security.c, so there is exactly one secret.
//
// The SoftAP name carries a suffix from the AP MAC (see wifi_mgr_ap_ssid), so
// several dongles in the same room do not advertise the same network. The
// suffix is public - it is a MAC, which every beacon already reveals - and the
// code is not in it, because a beacon is public too.
#define AP_SSID_PREFIX "keebling"
#define AP_MDNS_NAME   "keebling"   // reachable as keebling.local (not advertised)

// Start SoftAP + HTTP server + WebSocket.
// Requires NVS and security_init() to have run first.
esp_err_t web_server_start(void);

// Stop the HTTP server.
void web_server_stop(void);

// Number of associated WiFi stations.
int web_server_client_count(void);
