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

// Draw a status line (line 0..9). 160x80 landscape => 26 chars x 10 lines.
void display_status(int line, const char *text);

// Shared line layout, so main.c and web_server.c agree on the screen.
#define LCD_LINE_TITLE   0
#define LCD_LINE_NET     1
#define LCD_LINE_ADDR    2
#define LCD_LINE_HINT    3
#define LCD_LINE_WEBUI   4
#define LCD_LINE_WIFI    5
#define LCD_LINE_RESET   6    // why the chip last reset (diagnostic)
#define LCD_LINE_CODE    7    // the device code stays visible at all times
#define LCD_LINE_PANIC   9

// Backlight on/off.
void display_backlight(uint8_t on);
