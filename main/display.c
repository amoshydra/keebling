#include "display.h"

#include "bsp/esp_lcd_st7735.h"
#include "qr/qrcodegen.h"

#include "driver/ledc.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

#include <string.h>

static const char *TAG = "display";

// ---- T-Dongle-S3 pins (from LILYGO's official bsp_lcd example) ----
#define PIN_MOSI  3
#define PIN_CLK   5
#define PIN_CS    4
#define PIN_DC    2
#define PIN_RST   1
#define PIN_BCKL  38     // NOTE: active LOW on this board

#define LCD_HOST  SPI2_HOST

// Backlight is active low and driven by LEDC PWM (0 duty = full brightness).
#define BCKL_TIMER     LEDC_TIMER_1
#define BCKL_CHANNEL   LEDC_CHANNEL_1
#define BCKL_MODE      LEDC_LOW_SPEED_MODE
#define BCKL_RES       LEDC_TIMER_8_BIT
#define BCKL_FREQ_HZ   1000

#define FB_SIZE (LCD_W * LCD_H * 2)

static esp_lcd_panel_handle_t s_panel = NULL;
static bool s_ok = false;
static uint8_t s_fb[FB_SIZE];   // RGB565, high byte first (matches panel byte order)

// While a mode owns the whole screen - the boot QR, the user's custom text -
// status updates must not draw over it.
static bool s_full_screen = false;

// display_status() is called from the WiFi event task, the WebSocket task and
// the tick task. The framebuffer is shared, so every mutation plus its flush
// happens under this lock - otherwise two callers interleave their pixels and
// the screen shows a mangled blend of both strings.
static SemaphoreHandle_t s_fb_lock;

// ---- 5x7 font, ASCII 32..127, column-major, bit0 = top row ----
static const uint8_t FONT5X7[96][5] = {
    {0x00,0x00,0x00,0x00,0x00}, // space
    {0x00,0x00,0x5F,0x00,0x00}, // !
    {0x00,0x07,0x00,0x07,0x00}, // "
    {0x14,0x7F,0x14,0x7F,0x14}, // #
    {0x24,0x2A,0x7F,0x2A,0x12}, // $
    {0x23,0x13,0x08,0x64,0x62}, // %
    {0x36,0x49,0x55,0x22,0x50}, // &
    {0x00,0x05,0x03,0x00,0x00}, // '
    {0x00,0x1C,0x22,0x41,0x00}, // (
    {0x00,0x41,0x22,0x1C,0x00}, // )
    {0x14,0x08,0x3E,0x08,0x14}, // *
    {0x08,0x08,0x3E,0x08,0x08}, // +
    {0x00,0x50,0x30,0x00,0x00}, // ,
    {0x08,0x08,0x08,0x08,0x08}, // -
    {0x00,0x60,0x60,0x00,0x00}, // .
    {0x20,0x10,0x08,0x04,0x02}, // /
    {0x3E,0x51,0x49,0x45,0x3E}, // 0
    {0x00,0x42,0x7F,0x40,0x00}, // 1
    {0x42,0x61,0x51,0x49,0x46}, // 2
    {0x21,0x41,0x45,0x4B,0x31}, // 3
    {0x18,0x14,0x12,0x7F,0x10}, // 4
    {0x27,0x45,0x45,0x45,0x39}, // 5
    {0x3C,0x4A,0x49,0x49,0x30}, // 6
    {0x01,0x71,0x09,0x05,0x03}, // 7
    {0x36,0x49,0x49,0x49,0x36}, // 8
    {0x06,0x49,0x49,0x29,0x1E}, // 9
    {0x00,0x36,0x36,0x00,0x00}, // :
    {0x00,0x56,0x36,0x00,0x00}, // ;
    {0x08,0x14,0x22,0x41,0x00}, // <
    {0x14,0x14,0x14,0x14,0x14}, // =
    {0x00,0x41,0x22,0x14,0x08}, // >
    {0x02,0x01,0x51,0x09,0x06}, // ?
    {0x32,0x49,0x79,0x41,0x3E}, // @
    {0x7E,0x11,0x11,0x11,0x7E}, // A
    {0x7F,0x49,0x49,0x49,0x36}, // B
    {0x3E,0x41,0x41,0x41,0x22}, // C
    {0x7F,0x41,0x41,0x22,0x1C}, // D
    {0x7F,0x49,0x49,0x49,0x41}, // E
    {0x7F,0x09,0x09,0x09,0x01}, // F
    {0x3E,0x41,0x49,0x49,0x7A}, // G
    {0x7F,0x08,0x08,0x08,0x7F}, // H
    {0x00,0x41,0x7F,0x41,0x00}, // I
    {0x20,0x40,0x41,0x3F,0x01}, // J
    {0x7F,0x08,0x14,0x22,0x41}, // K
    {0x7F,0x40,0x40,0x40,0x40}, // L
    {0x7F,0x02,0x0C,0x02,0x7F}, // M
    {0x7F,0x04,0x08,0x10,0x7F}, // N
    {0x3E,0x41,0x41,0x41,0x3E}, // O
    {0x7F,0x09,0x09,0x09,0x06}, // P
    {0x3E,0x41,0x51,0x21,0x5E}, // Q
    {0x7F,0x09,0x19,0x29,0x46}, // R
    {0x46,0x49,0x49,0x49,0x31}, // S
    {0x01,0x01,0x7F,0x01,0x01}, // T
    {0x3F,0x40,0x40,0x40,0x3F}, // U
    {0x1F,0x20,0x40,0x20,0x1F}, // V
    {0x3F,0x40,0x38,0x40,0x3F}, // W
    {0x63,0x14,0x08,0x14,0x63}, // X
    {0x07,0x08,0x70,0x08,0x07}, // Y
    {0x61,0x51,0x49,0x45,0x43}, // Z
    {0x00,0x7F,0x41,0x41,0x00}, // [
    {0x02,0x04,0x08,0x10,0x20}, // backslash
    {0x00,0x41,0x41,0x7F,0x00}, // ]
    {0x04,0x02,0x01,0x02,0x04}, // ^
    {0x40,0x40,0x40,0x40,0x40}, // _
    {0x00,0x01,0x02,0x04,0x00}, // `
    {0x20,0x54,0x54,0x54,0x78}, // a
    {0x7F,0x48,0x44,0x44,0x38}, // b
    {0x38,0x44,0x44,0x44,0x20}, // c
    {0x38,0x44,0x44,0x48,0x7F}, // d
    {0x38,0x54,0x54,0x54,0x18}, // e
    {0x08,0x7E,0x09,0x01,0x02}, // f
    {0x0C,0x52,0x52,0x52,0x3E}, // g
    {0x7F,0x08,0x04,0x04,0x78}, // h
    {0x00,0x44,0x7D,0x40,0x00}, // i
    {0x20,0x40,0x44,0x3D,0x00}, // j
    {0x7F,0x10,0x28,0x44,0x00}, // k
    {0x00,0x41,0x7F,0x40,0x00}, // l
    {0x7C,0x04,0x18,0x04,0x78}, // m
    {0x7C,0x08,0x04,0x04,0x78}, // n
    {0x38,0x44,0x44,0x44,0x38}, // o
    {0x7C,0x14,0x14,0x14,0x08}, // p
    {0x08,0x14,0x14,0x18,0x7C}, // q
    {0x7C,0x08,0x04,0x04,0x08}, // r
    {0x48,0x54,0x54,0x54,0x20}, // s
    {0x04,0x3F,0x44,0x40,0x20}, // t
    {0x3C,0x40,0x40,0x20,0x7C}, // u
    {0x1C,0x20,0x40,0x20,0x1C}, // v
    {0x3C,0x40,0x30,0x40,0x3C}, // w
    {0x44,0x28,0x10,0x28,0x44}, // x
    {0x0C,0x50,0x50,0x50,0x3C}, // y
    {0x44,0x64,0x54,0x4C,0x44}, // z
    {0x00,0x08,0x36,0x41,0x00}, // {
    {0x00,0x00,0x7F,0x00,0x00}, // |
    {0x00,0x41,0x36,0x08,0x00}, // }
    {0x08,0x04,0x08,0x10,0x08}, // ~
    {0x00,0x06,0x09,0x09,0x06}, // DEL
};

// ---------------------------------------------------------------------------
// Backlight (LEDC PWM, active low: duty 0 => full brightness)
// ---------------------------------------------------------------------------

static void backlight_init(void) {
    ledc_timer_config_t timer = {
        .speed_mode = BCKL_MODE,
        .duty_resolution = BCKL_RES,
        .timer_num = BCKL_TIMER,
        .freq_hz = BCKL_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ledc_timer_config(&timer);

    ledc_channel_config_t ch = {
        .gpio_num = PIN_BCKL,
        .speed_mode = BCKL_MODE,
        .channel = BCKL_CHANNEL,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = BCKL_TIMER,
        .duty = 255,      // active low => 255 = off
        .hpoint = 0,
    };
    ledc_channel_config(&ch);
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

void display_init(void) {
    s_fb_lock = xSemaphoreCreateMutex();
    backlight_init();

    spi_bus_config_t bus = ST7735_PANEL_BUS_SPI_CONFIG(PIN_CLK, PIN_MOSI, FB_SIZE);
    esp_err_t err = spi_bus_initialize(LCD_HOST, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_initialize failed: %s - display disabled", esp_err_to_name(err));
        return;   // NON-FATAL
    }

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t io_config = ST7735_PANEL_IO_SPI_CONFIG(PIN_CS, PIN_DC, NULL, NULL);
    err = esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_config, &io);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "new_panel_io_spi failed: %s - display disabled", esp_err_to_name(err));
        return;   // NON-FATAL
    }

    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = PIN_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .data_endian = LCD_RGB_DATA_ENDIAN_LITTLE,
        .bits_per_pixel = 16,
    };
    err = esp_lcd_new_panel_st7735(io, &panel_config, &s_panel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "new_panel_st7735 failed: %s - display disabled", esp_err_to_name(err));
        return;   // NON-FATAL
    }

    err = esp_lcd_panel_reset(s_panel);
    if (err == ESP_OK) err = esp_lcd_panel_init(s_panel);
    if (err == ESP_OK) err = esp_lcd_panel_invert_color(s_panel, true);
    if (err == ESP_OK) err = esp_lcd_panel_set_gap(s_panel, 1, 26);
    if (err == ESP_OK) err = esp_lcd_panel_swap_xy(s_panel, true);
    if (err == ESP_OK) err = esp_lcd_panel_mirror(s_panel, false, true);
    if (err == ESP_OK) err = esp_lcd_panel_disp_on_off(s_panel, true);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "panel setup failed: %s - display disabled", esp_err_to_name(err));
        s_panel = NULL;
        return;   // NON-FATAL
    }

    s_ok = true;
    memset(s_fb, 0, sizeof(s_fb));
    display_backlight(255);
    ESP_LOGI(TAG, "Display ready (%dx%d landscape)", LCD_W, LCD_H);
}

void display_backlight(uint8_t level) {
    // level 0..255, where 255 = brightest. Panel is active low.
    uint32_t duty = 255 - level;
    ledc_set_duty(BCKL_MODE, BCKL_CHANNEL, duty);
    ledc_update_duty(BCKL_MODE, BCKL_CHANNEL);
}

void display_fill(uint16_t color) {
    if (!s_ok || !s_fb_lock) return;
    uint8_t hi = color >> 8, lo = color & 0xFF;
    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    for (size_t i = 0; i < sizeof(s_fb); i += 2) { s_fb[i] = hi; s_fb[i + 1] = lo; }
    xSemaphoreGive(s_fb_lock);
}

// Caller must hold s_fb_lock.
static void flush_locked(void) {
    if (!s_ok || !s_panel) return;
    esp_lcd_panel_draw_bitmap(s_panel, 0, 0, LCD_W, LCD_H, s_fb);
}

void display_flush(void) {
    if (!s_ok || !s_fb_lock) return;
    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    flush_locked();
    xSemaphoreGive(s_fb_lock);
}

static void draw_char(int x, int y, char c, uint16_t fg, uint16_t bg) {
    if (c < 32 || c > 127) c = '?';
    const uint8_t *glyph = FONT5X7[(int)c - 32];
    for (int col = 0; col < 6; col++) {
        uint8_t bits = (col < 5) ? glyph[col] : 0;   // 6th column = inter-char gap
        for (int row = 0; row < 8; row++) {
            int px = x + col, py = y + row;
            if (px < 0 || px >= LCD_W || py < 0 || py >= LCD_H) continue;
            uint16_t color = (bits & (1 << row)) ? fg : bg;
            size_t off = (size_t)(py * LCD_W + px) * 2;
            s_fb[off] = color >> 8;
            s_fb[off + 1] = color & 0xFF;
        }
    }
}

// Caller must hold s_fb_lock. Bounded variant: `len` characters are drawn from
// `text`, which may not be NUL-terminated at that point (wrapped lines are
// slices of a longer string).
static void draw_text_n(int x, int y, const char *text, int len, uint16_t fg, uint16_t bg) {
    for (int i = 0; i < len && x + 6 <= LCD_W; i++, x += 6) {
        draw_char(x, y, text[i], fg, bg);
    }
}

// Caller must hold s_fb_lock.
static void draw_text(int x, int y, const char *text, uint16_t fg, uint16_t bg) {
    draw_text_n(x, y, text, (int)strlen(text), fg, bg);
}

void display_status(int line, const char *text) {
    if (!s_ok || !s_fb_lock || !text) {
        ESP_LOGI(TAG, "LCD[%d]: %s", line, text ? text : "");
        return;
    }
    if (line < 0) return;
    if (s_full_screen) return;        // a full-screen mode owns the display
    int y = line * 8;
    if (y + 8 > LCD_H) return;

    xSemaphoreTake(s_fb_lock, portMAX_DELAY);

    for (int px = 0; px < LCD_W; px++) {
        size_t off = (size_t)(y * LCD_W + px) * 2;
        s_fb[off] = 0x00; s_fb[off + 1] = 0x00;
    }
    draw_text(1, y, text, 0xFFFF, 0x0000);

    flush_locked();
    xSemaphoreGive(s_fb_lock);
}

void display_text(int x, int y, const char *text) {
    if (!s_ok || !s_fb_lock || !text) return;
    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    draw_text(x, y, text, 0xFFFF, 0x0000);
    flush_locked();
    xSemaphoreGive(s_fb_lock);
}

// Clear from x to the right edge of the line, then draw - so a shorter string
// cannot leave the tail of a longer previous one behind.
void display_text_line(int x, int line, const char *text) {
    if (!s_ok || !s_fb_lock || !text || line < 0) return;
    int y = line * 8;
    if (y + 8 > LCD_H) return;
    if (x < 0) x = 0;

    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    for (int px = x; px < LCD_W; px++) {
        size_t off = (size_t)(y * LCD_W + px) * 2;
        s_fb[off] = 0x00; s_fb[off + 1] = 0x00;
    }
    draw_text(x, y, text, 0xFFFF, 0x0000);
    flush_locked();
    xSemaphoreGive(s_fb_lock);
}

void display_clear(void) {
    if (!s_ok || !s_fb_lock) return;
    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    s_full_screen = false;
    memset(s_fb, 0, sizeof(s_fb));
    flush_locked();
    xSemaphoreGive(s_fb_lock);
}

// ---------------------------------------------------------------------------
// Custom text screen (settings key screen_text)
//
// The 5x7 font cell is 6x8 px, so one 160x80 screen holds 26 columns x 10 lines
// and that is all the text gets. Wrapping is greedy - the words that fit stay
// whole and only a single word longer than a line is cut - so a pasted
// paragraph degrades into a readable screenful plus a marker rather than one
// chopped-off line.
// ---------------------------------------------------------------------------

#define LCD_COLS  26
#define LCD_LINES 10

typedef struct {
    const char *p;
    uint8_t len;
} text_line_t;

// Wrap `text` into at most `max` lines, no allocation. Returns the number of
// lines and sets *overflow when text was left over. '\n' (and '\r\n', which is
// one break) forces a line break, so a trailing newline does not add an empty
// line - only a genuine blank line does.
static int wrap_text(const char *text, text_line_t *out, int max, bool *overflow) {
    const char *p = text;
    int n = 0;
    *overflow = false;

    while (*p) {
        if (n == max) { *overflow = true; break; }

        int len = 0;
        while (len < LCD_COLS && p[len] && p[len] != '\n' && p[len] != '\r') len++;

        // The line is full and the text continues, and the next character is
        // not a space we could simply drop: retreat to the last space in the
        // line so the words stay whole.
        if (p[len] && p[len] != '\n' && p[len] != '\r' && p[len] != ' ') {
            for (int i = len - 1; i > 0; i--) {
                if (p[i] == ' ') { len = i; break; }
            }
        }

        out[n].p = p;
        out[n].len = (uint8_t)len;
        n++;
        p += len;

        // Consume the break that ended the line, if there was one: a newline
        // terminates a line rather than starting a new one. When the line was
        // cut at LCD_COLS instead, *p is the next character to draw.
        if (*p == ' ') {
            p++;
        } else if (*p == '\n' || *p == '\r') {
            p += (*p == '\r' && p[1] == '\n') ? 2 : 1;
        }
    }
    return n;
}

void display_message(const char *text) {
    if (!s_ok || !s_fb_lock || !text) return;

    text_line_t lines[LCD_LINES];
    bool overflow = false;
    int n = wrap_text(text, lines, LCD_LINES, &overflow);

    // What did not fit is marked rather than silently dropped. The marker
    // follows the last line, trimmed to make room for it.
    if (overflow && n > 0 && lines[n - 1].len > LCD_COLS - 3) {
        lines[n - 1].len = LCD_COLS - 3;
    }

    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    s_full_screen = true;
    memset(s_fb, 0, sizeof(s_fb));
    for (int i = 0; i < n; i++) {
        draw_text_n(0, i * 8, lines[i].p, lines[i].len, 0xFFFF, 0x0000);
    }
    if (overflow && n > 0) {
        draw_text_n(lines[n - 1].len * 6, (n - 1) * 8, "...", 3, 0xFFFF, 0x0000);
    }
    flush_locked();
    xSemaphoreGive(s_fb_lock);
}

// ---------------------------------------------------------------------------
// Custom screen image (see screen_image.c for the file format)
//
// Grey level i is i * 17, so the 16 levels are evenly spaced across 0..255. The
// LUT is RGB565 of that ramp: the panel takes 5/6/5 bits, which truncates the
// low bits anyway, and a table keeps the per-pixel cost to two lookups and four
// byte stores.
// ---------------------------------------------------------------------------

static const uint16_t GREY4_RGB565[16] = {
    0x0000, 0x1082, 0x2104, 0x3186, 0x4228, 0x52AA, 0x632C, 0x73AE,
    0x8C51, 0x9CD3, 0xAD55, 0xBDD7, 0xCE79, 0xDEFB, 0xEF7D, 0xFFFF,
};

bool display_grey4(FILE *f) {
    if (!s_ok || !s_fb_lock || !f) return false;

    const int row_bytes = LCD_W / 2;
    uint8_t row[LCD_W / 2];

    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    s_full_screen = true;

    for (int y = 0; y < LCD_H; y++) {
        if (fread(row, 1, row_bytes, f) != (size_t)row_bytes) {
            // A short file must not leave the rest of the screen black: the
            // caller falls back, which clears and redraws.
            xSemaphoreGive(s_fb_lock);
            return false;
        }

        uint8_t *dst = &s_fb[(size_t)y * LCD_W * 2];
        for (int x = 0; x < row_bytes; x++) {
            const uint16_t hi = GREY4_RGB565[row[x] >> 4];
            const uint16_t lo = GREY4_RGB565[row[x] & 0x0F];
            *dst++ = (uint8_t)(hi >> 8);
            *dst++ = (uint8_t)hi;
            *dst++ = (uint8_t)(lo >> 8);
            *dst++ = (uint8_t)lo;
        }
    }

    flush_locked();
    xSemaphoreGive(s_fb_lock);
    return true;
}

// RGB565 arrives little-endian and the framebuffer holds the high byte first,
// so each row is read straight into the framebuffer and its bytes swapped in
// place. That is the whole decode: no LUT, no row buffer, and the panel's own
// 5-6-5 quantisation is exactly what the file already carries.
bool display_rgb565(FILE *f) {
    if (!s_ok || !s_fb_lock || !f) return false;

    const int row_bytes = LCD_W * 2;

    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    s_full_screen = true;

    for (int y = 0; y < LCD_H; y++) {
        uint8_t *row = &s_fb[(size_t)y * row_bytes];
        if (fread(row, 1, row_bytes, f) != (size_t)row_bytes) {
            // A short file must not leave the rest of the screen black: the
            // caller falls back, which clears and redraws.
            xSemaphoreGive(s_fb_lock);
            return false;
        }

        for (int i = 0; i < row_bytes; i += 2) {
            const uint8_t lo = row[i];
            row[i] = row[i + 1];
            row[i + 1] = lo;
        }
    }

    flush_locked();
    xSemaphoreGive(s_fb_lock);
    return true;
}

// Render the device code as a QR on the left half, white-on-black with a light
// quiet zone (scanners need that margin to be the *light* colour).
//
// Payload is the bare 12-character code, not a URL: the code never changes
// while the URL can (DHCP address, mDNS name), and 12 bytes fits version 1 at
// EC level Q, which keeps the modules large enough to actually scan.
bool display_qr(const char *text) {
    if (!s_ok || !s_fb_lock || !text) return false;

    // Static: these are 4 KB buffers, too big for the stack.
    static uint8_t qr[qrcodegen_BUFFER_LEN_MAX];
    static uint8_t tmp[qrcodegen_BUFFER_LEN_MAX];

    // boostEcl=true raises the error-correction level as far as the version
    // allows without growing it - free robustness for a small payload.
    if (!qrcodegen_encodeText(text, tmp, qr, qrcodegen_Ecc_LOW,
                              qrcodegen_VERSION_MIN, qrcodegen_VERSION_MAX,
                              qrcodegen_Mask_AUTO, true)) {
        ESP_LOGW(TAG, "QR encode failed for %zu chars", strlen(text));
        return false;
    }

    const int n = qrcodegen_getSize(qr);
    const int quiet = 2;                       // modules of light margin
    const int total = n + quiet * 2;
    int scale = LCD_H / total;                 // largest whole module that fits
    if (scale < 1) scale = 1;
    const int side = total * scale;
    const int ox = 2;
    const int oy = (LCD_H - side) / 2;

    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    s_full_screen = true;

    // Dark quiet zone and background, light modules - the same polarity as the
    // text drawn beside it, so the panel reads as one screen rather than a white
    // slab next to white words. Reversed codes are accepted by most scanners; if
    // one refuses this, these two colour pairs are the only thing to swap back.
    for (int y = 0; y < side; y++) {
        int fy = oy + y;
        if (fy < 0 || fy >= LCD_H) continue;
        for (int x = 0; x < side; x++) {
            int fx = ox + x;
            if (fx < 0 || fx >= LCD_W) continue;
            size_t off = (size_t)(fy * LCD_W + fx) * 2;
            s_fb[off] = 0x00; s_fb[off + 1] = 0x00;
        }
    }

    // light modules
    for (int my = 0; my < n; my++) {
        for (int mx = 0; mx < n; mx++) {
            if (!qrcodegen_getModule(qr, mx, my)) continue;
            int bx = ox + (quiet + mx) * scale;
            int by = oy + (quiet + my) * scale;
            for (int dy = 0; dy < scale; dy++) {
                int fy = by + dy;
                if (fy < 0 || fy >= LCD_H) continue;
                for (int dx = 0; dx < scale; dx++) {
                    int fx = bx + dx;
                    if (fx < 0 || fx >= LCD_W) continue;
                    size_t off = (size_t)(fy * LCD_W + fx) * 2;
                    s_fb[off] = 0xFF; s_fb[off + 1] = 0xFF;
                }
            }
        }
    }

    flush_locked();
    xSemaphoreGive(s_fb_lock);

    ESP_LOGI(TAG, "QR: %d x %d modules, %d px/module (%d px square)", n, n, scale, side);
    return true;
}
