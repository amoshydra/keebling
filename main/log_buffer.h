#pragma once

#include <stddef.h>

// Small in-RAM log ring, exposed over HTTP.
//
// Once TinyUSB owns the USB port there is no serial console, so a bug (like a
// WebSocket that will not re-establish) is otherwise completely invisible. This
// keeps the most recent output where a browser can read it.

// Install the capture hook. Call after NVS/security, before anything worth
// logging happens.
void log_buffer_init(void);

// Copy the retained log into `out`, oldest first, NUL-terminated.
void log_buffer_read(char *out, size_t outlen);
