// ESP-IDF error type: only the success value is needed by the headers the
// host tests compile.
#pragma once

typedef int esp_err_t;

#define ESP_OK    0
#define ESP_FAIL  -1
