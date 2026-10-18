#pragma once

#include "esp_err.h"

// Start SoftAP + HTTP server + WebSocket. Initialises NVS internally.
esp_err_t web_server_start(void);

// Stop the HTTP server.
void web_server_stop(void);

// Number of associated WiFi stations.
int web_server_client_count(void);
