#pragma once

#include <stdint.h>
#include <stdbool.h>

// Initialize ST7735 display. NON-FATAL: if the panel fails to init,
// every subsequent draw call becomes a no-op and the device keeps running.
void display_init(void);

// Clear the framebuffer to a colour.
void display_fill(uint16_t color);

// Push the framebuffer to the panel.
void display_flush(void);

// Draw a status line (line 0..15, ~13 chars per line at 6px/char on 80px).
void display_status(int line, const char *text);

// Backlight on/off.
void display_backlight(uint8_t on);
