#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "driver/gpio.h"

#include "display.h"
#include "usb_hid.h"
#include "web_server.h"
#include "input_state.h"
#include "security.h"
#include "wifi_manager.h"
#include "log_buffer.h"
#include "settings.h"
#include "ui_fs.h"

static const char *TAG = "main";

#define PIN_BOOT_BUTTON  GPIO_NUM_0

// Button gestures. Escalating holds, so the destructive action needs the
// longest press and cannot be triggered by fumbling. A release between TAP and
// PANIC does nothing at all, which is deliberate.
//
//   tap  (<600 ms)      wake the screen, or cycle the display mode if awake
//   hold (>=3 s)        release all held inputs (panic)
//   hold (>=10 s)       forget the saved network and restart
#define BOOT_TAP_MS           600
#define BOOT_PANIC_MS        3000
#define BOOT_FORGET_MS      10000

// What the LCD is showing. Cycled with a tap.
//
// Sleep is orthogonal to the mode: after the timeout the screen blanks and
// the backlight goes off, and a press wakes it showing the same mode. A
// separate "off" mode would now be redundant with sleeping.
typedef enum {
    DISP_QR = 0,
    DISP_STATUS,
    DISP_CUSTOM,   // text from the screen_text setting
    DISP_MODE_COUNT
} display_mode_t;

// The setting behind DISP_CUSTOM. Nothing about it is cached: it is read back
// from settings each time the screen is drawn, so a wake-up cannot show a stale
// copy.
#define SCREEN_TEXT_KEY "screen_text"

static display_mode_t s_mode = DISP_QR;
static bool s_sleeping = false;
static int64_t s_last_press_us = 0;
static int s_screen_timeout_s = 10;   // 0 disables sleeping

// The whole stored string, because the renderer's "no room left" marker is only
// honest if it sees the text that was dropped - and the settings blob caps the
// string at under a kilobyte anyway.
static char s_screen_text[SETTINGS_MAX];

static bool read_screen_text(void) {
    if (!settings_get_str(SCREEN_TEXT_KEY, s_screen_text, sizeof(s_screen_text))) return false;

    // Whitespace alone draws an empty screen, which is what "not set" means
    // here - so it counts as not set and the tap cycle skips it.
    for (const char *p = s_screen_text; *p; p++) {
        if ((unsigned char)*p > ' ') return true;
    }
    return false;
}

// Shown on the LCD so a reboot can be diagnosed without a serial console.
static const char *reset_reason_str(esp_reset_reason_t r) {
    switch (r) {
    case ESP_RST_POWERON:   return "power-on";
    case ESP_RST_EXT:       return "ext pin";
    case ESP_RST_SW:        return "software";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_INT_WDT:   return "int wdt";
    case ESP_RST_TASK_WDT:  return "task wdt";
    case ESP_RST_WDT:       return "wdt";
    case ESP_RST_DEEPSLEEP: return "deep sleep";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_SDIO:      return "sdio";
#ifdef ESP_RST_USB
    case ESP_RST_USB:       return "usb";
#endif
#ifdef ESP_RST_JTAG
    case ESP_RST_JTAG:      return "jtag";
#endif
    default:                return "unknown";
    }
}

// Right-hand panel beside the QR. x = 80 leaves 13 characters.
static void draw_qr_panel(void) {
    display_text_line(80, 0, "ESP32 Remote");
    if (wifi_mgr_state() == WIFI_MGR_STA) {
        char l[16];
        snprintf(l, sizeof(l), "STA %.9s", wifi_mgr_joined_ssid());
        display_text_line(80, 1, l);
        display_text_line(80, 2, wifi_mgr_ip());
    } else {
        display_text_line(80, 1, "AP esp-remote");
        display_text_line(80, 2, "192.168.4.1");
    }
    display_text_line(80, 5, "code");
    display_text_line(80, 6, security_code());
}

static void show_status_screen(void) {
    display_clear();

    display_status(LCD_LINE_TITLE, "ESP32 Remote");

    if (wifi_mgr_state() == WIFI_MGR_STA) {
        char l[40];
        snprintf(l, sizeof(l), "STA: %.16s", wifi_mgr_joined_ssid());
        display_status(LCD_LINE_NET, l);
        snprintf(l, sizeof(l), "http://%s", wifi_mgr_ip());
        display_status(LCD_LINE_ADDR, l);
    } else {
        display_status(LCD_LINE_NET,  "AP: " AP_SSID);
        display_status(LCD_LINE_ADDR, "http://192.168.4.1");
    }

    display_status(LCD_LINE_WIFI, wifi_mgr_client_count() ? "client joined"
                                                          : "waiting for client");

    char l[32];
    snprintf(l, sizeof(l), "reset: %s", reset_reason_str(esp_reset_reason()));
    display_status(LCD_LINE_RESET, l);

    snprintf(l, sizeof(l), "code: %s", security_code());
    display_status(LCD_LINE_CODE, l);

    display_status(LCD_LINE_BOOT_HINT, "tap BOOT: view");
}

// Draw whatever the current mode calls for.
static void apply_display_mode(void) {
    switch (s_mode) {
    case DISP_QR:
        display_clear();
        if (!display_qr(security_code())) {
            s_mode = DISP_STATUS;      // payload would not fit: fall back
            apply_display_mode();
            return;
        }
        display_backlight(255);
        draw_qr_panel();
        break;

    case DISP_STATUS:
        display_backlight(255);
        show_status_screen();
        break;

    case DISP_CUSTOM:
        // The web UI can clear the setting while this mode is up; fall back to
        // the status screen rather than leave the user on a blank one.
        if (!read_screen_text()) {
            s_mode = DISP_STATUS;
            apply_display_mode();
            return;
        }
        display_backlight(255);
        display_message(s_screen_text);
        break;

    default:
        break;
    }
}

// Blank the pixels as well as the backlight. The panel keeps its memory and
// the case is transparent, so darkening the backlight alone still leaves the
// text readable in ambient light.
static void sleep_display(void) {
    if (s_sleeping) return;
    s_sleeping = true;
    display_clear();
    display_backlight(0);
    ESP_LOGI(TAG, "screen asleep");
}

static void wake_display(void) {
    if (!s_sleeping) return;
    s_sleeping = false;
    ESP_LOGI(TAG, "screen awake");
    apply_display_mode();
}

// Re-draw after something changed, but never light up a sleeping screen.
static void refresh_display(void) {
    if (s_sleeping) return;
    apply_display_mode();
}

static void cycle_display_mode(void) {
    // Skip the custom screen while there is no text for it: a tap should never
    // stop on a blank screen, and the mode exists to show what the user wrote.
    do {
        s_mode = (display_mode_t)((s_mode + 1) % DISP_MODE_COUNT);
    } while (s_mode == DISP_CUSTOM && !read_screen_text());

    ESP_LOGI(TAG, "display mode -> %d", (int)s_mode);
    apply_display_mode();
}

// ---------------------------------------------------------------------------
// Housekeeping task
//
// - releases held keys if the browser stops heartbeating (input_state.c)
// - BOOT tap / 3 s / 10 s as described above
// - redraws the LCD when the WiFi state or the client count changes, so the
//   status lines stay current without demoting the mode the user chose
// ---------------------------------------------------------------------------
static void tick_task(void *arg) {
    bool prev_pressed = false;
    bool panic_done = false;
    int64_t pressed_at = 0;

    wifi_mgr_state_t last_state = (wifi_mgr_state_t)-1;
    int last_clients = 0;

    while (1) {
        input_tick();
        wifi_mgr_tick();

        const int64_t now = esp_timer_get_time();

        // Re-read the timeout periodically so the setting applies without a
        // restart (about every 2 s at this tick rate).
        static int timeout_poll = 0;
        if (++timeout_poll >= 100) {
            timeout_poll = 0;
            s_screen_timeout_s = settings_get_int("screen_timeout_s", 10);
        }

        // Screen timeout. Any button press resets it.
        if (!s_sleeping && s_screen_timeout_s > 0 &&
            (now - s_last_press_us) > (int64_t)s_screen_timeout_s * 1000000) {
            sleep_display();
        }

        // WiFi state changes keep the screen current.
        wifi_mgr_state_t st = wifi_mgr_state();
        int clients = wifi_mgr_client_count();
        if (st != last_state || clients != last_clients) {
            last_state = st;
            last_clients = clients;
            refresh_display();
        }
        if (clients < last_clients) input_release_all();

        // ---- BOOT button ----
        bool pressed = (gpio_get_level(PIN_BOOT_BUTTON) == 0);

        if (pressed && !prev_pressed) {
            pressed_at = now;
            panic_done = false;
            // Count the press itself as activity: a 3 s or 10 s hold is still
            // someone using the device, and must not blank mid-hold.
            s_last_press_us = now;
        }

        if (pressed && pressed_at) {
            const int64_t held = now - pressed_at;

            if (held >= (int64_t)BOOT_FORGET_MS * 1000) {
                ESP_LOGW(TAG, "BOOT held %d ms - forgetting network",
                         BOOT_FORGET_MS);
                wifi_mgr_forget();
                display_backlight(255);
                display_clear();
                display_status(LCD_LINE_TITLE, "network forgotten");
                display_status(LCD_LINE_NET, "restarting in AP");
                vTaskDelay(pdMS_TO_TICKS(800));
                esp_restart();
            }

            if (!panic_done && held >= (int64_t)BOOT_PANIC_MS * 1000) {
                ESP_LOGW(TAG, "BOOT held %d ms - releasing all inputs",
                         BOOT_PANIC_MS);
                input_release_all();
                panic_done = true;
                if (!s_sleeping) display_status(LCD_LINE_PANIC, "! released !");
            }
        }

        // Decide on release, so a press shorter than the panic threshold is a
        // tap and anything in between does nothing.
        if (!pressed && prev_pressed) {
            const int64_t held = now - pressed_at;
            if (!panic_done && held < (int64_t)BOOT_TAP_MS * 1000) {
                if (s_sleeping) {
                    wake_display();          // waking does not change the mode
                } else {
                    cycle_display_mode();
                }
                s_last_press_us = now;
            }
            if (!panic_done && !s_sleeping) display_status(LCD_LINE_PANIC, "");
            pressed_at = 0;
        }

        prev_pressed = pressed;
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void app_main(void) {
    log_buffer_init();   // capture logs for the web UI from here on
    ESP_LOGI(TAG, "ESP32 Remote starting");

    // --- Display first, so we can report progress on it (non-fatal) ---
    display_init();
    display_status(LCD_LINE_TITLE, "ESP32 Remote");

    // A boot loop is otherwise a black box: the LCD keeps its content across a
    // reset, so the reason and the last step identify where it died.
    char rline[32];
    snprintf(rline, sizeof(rline), "reset: %s", reset_reason_str(esp_reset_reason()));
    display_status(LCD_LINE_RESET, rline);
    display_status(LCD_LINE_HINT,  "step 1 nvs");

    // --- NVS is required by security, settings, WiFi credentials and WiFi ---
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // --- Device code + settings (both live in NVS) ---
    display_status(LCD_LINE_HINT, "step 2 security");
    security_init();
    settings_init();   // before usb_hid_init: the USB name comes from here

    // --- BOOT button ---
    gpio_config_t boot_cfg = {
        .pin_bit_mask = (1ULL << PIN_BOOT_BUTTON),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&boot_cfg);

    // --- Input state machine ---
    display_status(LCD_LINE_HINT, "step 3 input");
    input_state_init();

    // --- USB HID (before WiFi, so the host sees us quickly) ---
    display_status(LCD_LINE_HINT, "step 4 usb hid");
    usb_hid_init();

    // --- WiFi: join the stored network, or fall back to our own SoftAP ---
    display_status(LCD_LINE_HINT, "step 5 wifi");
    ret = wifi_mgr_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "wifi_mgr_init: %s", esp_err_to_name(ret));
        display_status(LCD_LINE_NET, "wifi init FAILED");
    }

    // --- Uploaded UI files (LittleFS). Non-fatal: without it the embedded
    //     copies are served and uploads report that there is no filesystem ---
    display_status(LCD_LINE_HINT, "step 6 ui files");
    if (ui_fs_init() != ESP_OK) {
        display_status(LCD_LINE_NET, "ui fs FAILED");
    }

    // --- HTTP + WebSocket, which also starts WiFi ---
    display_status(LCD_LINE_HINT, "step 7 http");
    if (web_server_start() != ESP_OK) {
        ESP_LOGE(TAG, "web_server_start failed - HID still available");
        display_status(LCD_LINE_NET, "WiFi FAILED");
    }

    // --- Pairing screen ---
    s_mode = DISP_QR;
    apply_display_mode();

    xTaskCreate(tick_task, "tick", 4096, NULL, 5, NULL);

    ESP_LOGI(TAG, "Ready. Tap BOOT to cycle the display mode.");
}
