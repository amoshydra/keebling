#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>

// LILYGO run this panel in LANDSCAPE: 160 wide x 80 tall. Public because the
// packed screen image is sized from it and a mismatch must be a build error.
#define LCD_W  160
#define LCD_H  80

// Initialize ST7735 display. NON-FATAL: if the panel fails to init,
// every subsequent draw call becomes a no-op and the device keeps running.
void display_init(void);

// Clear the framebuffer to a colour.
void display_fill(uint16_t color);

// Push the framebuffer to the panel.
void display_flush(void);

// Draw a status line (line 0..9). 160x80 landscape => 26 chars x 10 lines.
void display_status(int line, const char *text);

// Draw text at an absolute pixel position (used beside the boot QR).
void display_text(int x, int y, const char *text);

// Draw the 32x16 googly-dongle mark at (x, y), top-left. Mutates and flushes
// the framebuffer like display_text(); safe to call from the tick task.
void display_mark(int x, int y);

// Clear from x to the end of `line`, then draw - safe for redrawing.
void display_text_line(int x, int line, const char *text);

// Wipe the screen and hand it back to display_status().
void display_clear(void);

// Render `text` as a QR code on the left of the screen, with a light quiet
// zone. While this is up, display_status() calls are ignored - call
// display_clear() to take the screen back. Returns false if it did not fit.
bool display_qr(const char *text);

// Rightmost column used by the last QR drawn, so callers can lay text beside it
// without guessing how wide the code turned out.
int display_qr_right(void);

// Ask for a redraw of whatever mode is current. Safe to call from any task: it
// only sets a flag that the tick task consumes.
void display_request_refresh(void);

// True once per request, then cleared. Called by the tick task.
bool display_take_refresh(void);

// Show `text` full screen, white on black: the 5x7 font cell is 6x8 px, so the
// panel holds 26 columns x 10 lines. Wraps at the last space that fits (a single
// word longer than a line is broken), '\n' and '\r\n' force a break. Bytes the
// font has no glyph for - a tab, a curly quote, any UTF-8 continuation byte -
// render as '?', one per byte, rather than being dropped. Text past the tenth
// line is dropped and the last drawn line ends with "..." - an unmarked cut
// would look like the whole string. Like the QR, this owns the screen, so
// display_status() calls are ignored until display_clear().
//
// Pass the whole stored string: the marker can only be honest when the renderer
// actually sees the text that was dropped.
void display_message(const char *text);

// Draw a packed 4-bit greyscale image: 80 rows of 80 bytes, high nibble first,
// exactly the payload the browser produces. Reads one row at a time through a
// 16-entry RGB565 LUT straight into the framebuffer, so the image is never held
// in RAM. Returns false (having flushed nothing) when the stream ends early.
bool display_grey4(FILE *f);

// Draw a packed RGB565 image: 80 rows of 320 bytes, two little-endian bytes per
// pixel, exactly the payload the browser produces. Reads one row at a time
// straight into the framebuffer, so the image is never held in RAM and no row
// buffer is needed. Returns false (having flushed nothing) when the stream ends
// early.
bool display_rgb565(FILE *f);

// Shared line layout, so main.c and web_server.c agree on the screen.
#define LCD_LINE_TITLE   0
#define LCD_LINE_NET     1
#define LCD_LINE_ADDR    2
#define LCD_LINE_HINT    3
#define LCD_LINE_WEBUI   4
#define LCD_LINE_WIFI    5
#define LCD_LINE_RESET   6    // why the chip last reset (diagnostic)
#define LCD_LINE_CODE    7    // the device code stays visible at all times
#define LCD_LINE_BOOT_HINT 8  // "tap BOOT: view"
#define LCD_LINE_PANIC   9

// Backlight on/off.
void display_backlight(uint8_t on);
