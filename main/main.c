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

static const char *TAG = "main";

#define PIN_BOOT_BUTTON  GPIO_NUM_0

// How long the pairing QR stays up before the status screen takes over.
#define QR_SHOW_MS          20000

// Holding BOOT this long wipes the stored network and restarts into AP mode.
// It has to be a runtime gesture: holding BOOT during power-on triggers the
// ROM's download mode instead of booting this firmware.
#define BOOT_LONG_PRESS_MS   3000

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

static bool s_qr_showing;

// Right-hand panel beside the QR, or the full status screen.
// x = 80 leaves 13 characters before the edge.
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
    s_qr_showing = false;

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
}

// ---------------------------------------------------------------------------
// Housekeeping task
//
// - releases held keys if the browser stops heartbeating (input_state.c)
// - BOOT short press = panic (release everything)
// - BOOT long press  = wipe network credentials and restart in AP mode
// - times the pairing QR out to the status screen
// - keeps the LCD in step with the WiFi state
// ---------------------------------------------------------------------------
static void tick_task(void *arg) {
    bool prev_pressed = false;
    bool reverted = false;
    int64_t pressed_at = 0;
    const int64_t start = esp_timer_get_time();

    wifi_mgr_state_t last_state = (wifi_mgr_state_t)-1;
    int last_clients = 0;

    while (1) {
        input_tick();
        wifi_mgr_tick();

        const int64_t now = esp_timer_get_time();

        // Pairing QR -> status screen
        if (s_qr_showing && (now - start) > (int64_t)QR_SHOW_MS * 1000) {
            reverted = true;
            show_status_screen();
        }

        // Keep the screen in step with the network
        wifi_mgr_state_t st = wifi_mgr_state();
        int clients = wifi_mgr_client_count();
        if (st != last_state || clients != last_clients) {
            last_state = st;
            last_clients = clients;
            if (s_qr_showing) draw_qr_panel();
            else show_status_screen();
        }

        // An AP client leaving must not leave a key held.
        if (clients < last_clients) input_release_all();

        // BOOT button
        bool pressed = (gpio_get_level(PIN_BOOT_BUTTON) == 0);
        if (pressed && !prev_pressed) {
            ESP_LOGW(TAG, "PANIC: BOOT pressed - releasing all inputs");
            input_release_all();
            pressed_at = now;
        }
        if (pressed && pressed_at &&
            (now - pressed_at) > (int64_t)BOOT_LONG_PRESS_MS * 1000) {
            ESP_LOGW(TAG, "BOOT held %d ms - forgetting network credentials",
                     BOOT_LONG_PRESS_MS);
            wifi_mgr_forget();
            display_clear();
            display_status(LCD_LINE_TITLE, "network forgotten");
            display_status(LCD_LINE_NET, "restarting in AP");
            vTaskDelay(pdMS_TO_TICKS(800));
            esp_restart();
        }
        if (!pressed) pressed_at = 0;
        prev_pressed = pressed;

        vTaskDelay(pdMS_TO_TICKS(20));
    }
    (void)reverted;
}

void app_main(void) {
    log_buffer_init();   // capture logs for the web UI from here on
    ESP_LOGI(TAG, "ESP32 Remote starting");

    // --- Display first, so we can report progress on it (non-fatal) ---
    display_init();
    display_status(LCD_LINE_TITLE, "ESP32 Remote");

    // A boot loop is otherwise a black box: the LCD keeps its content across a
    // reset, so showing the reason and a step marker means the last thing on
    // screen before the reset identifies where it died.
    char rline[32];
    snprintf(rline, sizeof(rline), "reset: %s", reset_reason_str(esp_reset_reason()));
    display_status(LCD_LINE_RESET, rline);
    display_status(LCD_LINE_HINT,  "step 1 nvs");

    // --- NVS is required by security, WiFi credentials and WiFi itself ---
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // --- Device code: loaded from NVS, or generated on first boot ---
    display_status(LCD_LINE_HINT, "step 2 security");
    security_init();

    // --- BOOT button as panic switch / network reset ---
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

    // --- HTTP + WebSocket, which also starts WiFi ---
    display_status(LCD_LINE_HINT, "step 6 http");
    if (web_server_start() != ESP_OK) {
        ESP_LOGE(TAG, "web_server_start failed - HID still available");
        display_status(LCD_LINE_NET, "WiFi FAILED");
    }

    // --- Pairing screen ---
    if (display_qr(security_code())) {
        s_qr_showing = true;
        draw_qr_panel();
    } else {
        show_status_screen();
    }

    xTaskCreate(tick_task, "tick", 4096, NULL, 5, NULL);

    ESP_LOGI(TAG, "Ready. The code on the LCD is both the SoftAP password and "
                  "the web UI token. Open the device's address in a browser.");
}
