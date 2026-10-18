#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

// Device-side settings, stored as one JSON object in NVS.
//
// The firmware deliberately does not model every field: it stores the blob
// verbatim and reads only the keys it cares about (currently just the USB
// product name). That keeps adding a UI-only setting from becoming a firmware
// change.

#define SETTINGS_MAX 1024

// Load the stored blob. Call after NVS init, before anything reads settings.
void settings_init(void);

// The stored JSON. Never NULL; "{}" when nothing has been saved.
const char *settings_json(void);

// Validate and store a new blob.
esp_err_t settings_set_json(const char *json);

// Read one string field. Returns false when absent or empty.
bool settings_get_str(const char *key, char *out, size_t outlen);

// Read one numeric field, for settings the firmware acts on.
int settings_get_int(const char *key, int def);

// Longest USB string descriptor the driver can carry (MAX_DESC_BUF_SIZE - 1).
#define SETTINGS_HID_NAME_MAX 31
