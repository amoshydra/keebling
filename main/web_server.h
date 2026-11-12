#pragma once

#include "esp_err.h"

// Network identity. Note the SoftAP password is NOT here: it is the random
// per-device code produced by security.c, so there is exactly one secret.
#define AP_SSID       "keebling"
#define AP_MDNS_NAME  "keebling"    // reachable as keebling.local

// Where the UI is also published. Serving it from a trusted HTTPS origin is
// what unlocks the browser's Keyboard Lock API, which is the difference between
// a remote keyboard that can send Esc and one that cannot.
//
// These are compile-time constants, and the CORS code answers with the matching
// literal rather than echoing the request header: esp_http_server stores the
// header value pointer, not a copy, so a value built on a handler's stack is
// dangling by the time the response is written.
#ifndef WEB_APP_ORIGIN
#define WEB_APP_ORIGIN "https://amoshydra.github.io"
#endif
// A second origin for local work: serve site/ from this address and the probe
// can exercise CORS without a Pages deploy. Define it as "" to lock the device
// to the published UI alone.
#ifndef WEB_APP_ORIGIN_DEV
#define WEB_APP_ORIGIN_DEV "http://localhost:8080"
#endif

// Start SoftAP + HTTP server + WebSocket.
// Requires NVS and security_init() to have run first.
esp_err_t web_server_start(void);

// Stop the HTTP server.
void web_server_stop(void);

// Number of associated WiFi stations.
int web_server_client_count(void);
