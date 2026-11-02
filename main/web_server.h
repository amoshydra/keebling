#pragma once

#include "esp_err.h"

// Network identity. Note the SoftAP password is NOT here: it is the random
// per-device code produced by security.c, so there is exactly one secret.
#define AP_SSID       "keebling"
#define AP_MDNS_NAME  "keebling"    // reachable as keebling.local

// Start SoftAP + HTTP server + WebSocket.
// Requires NVS and security_init() to have run first.
esp_err_t web_server_start(void);

// Stop the HTTP server.
void web_server_stop(void);

// Number of associated WiFi stations.
int web_server_client_count(void);
