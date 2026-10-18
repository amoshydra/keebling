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

static const char *TAG = "main";

#define PIN_BOOT_BUTTON  GPIO_NUM_0

// How long the pairing QR stays up before the status screen takes over.
// The code never changes, so this is only needed when pairing a new device -
// a power cycle is a reasonable way to ask for it again.
#define QR_SHOW_MS       20000

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

// Pairing screen: QR on the left, the essential facts on the right.
// The QR carries the bare device code - scanning it yields the 12 characters,
// which serve as both the WiFi password and the web UI token.
static void show_qr_screen(void) {
    if (!display_qr(security_code())) return;   // no QR: leave status up

    display_text(80,  0, "ESP32 Remote");
    display_text(80,  8, "AP esp-remote");
    display_text(80, 16, "192.168.4.1");
    display_text(80, 40, "code");
    display_text(80, 48, security_code());
}

static void show_status_screen(void) {
    display_clear();
    display_status(LCD_LINE_TITLE, "ESP32 Remote");
    display_status(LCD_LINE_NET,   "AP: " AP_SSID);
    display_status(LCD_LINE_ADDR,  "http://192.168.4.1");
    display_status(LCD_LINE_WIFI,  web_server_client_count() ? "client joined"
                                                              : "waiting for client");

    char line[32];
    snprintf(line, sizeof(line), "reset: %s", reset_reason_str(esp_reset_reason()));
    display_status(LCD_LINE_RESET, line);

    snprintf(line, sizeof(line), "code: %s", security_code());
    display_status(LCD_LINE_CODE, line);
}

// ---------------------------------------------------------------------------
// Watchdog + panic-button task.
//
// - input_tick() releases all held keys/buttons if the browser stops
//   heartbeating (see input_state.c).
// - Holding the BOOT button forcibly releases everything. This is the physical
//   panic switch: if a modifier ever gets stuck, hold BOOT for a moment.
// - Also times the pairing QR out to the status screen.
// ---------------------------------------------------------------------------
static void tick_task(void *arg) {
    bool prev_pressed = false;
    bool reverted = false;
    const int64_t start = esp_timer_get_time();

    while (1) {
        input_tick();

        if (!reverted && (esp_timer_get_time() - start) > (int64_t)QR_SHOW_MS * 1000) {
            reverted = true;
            show_status_screen();
        }

        bool pressed = (gpio_get_level(PIN_BOOT_BUTTON) == 0);
        if (pressed && !prev_pressed) {
            ESP_LOGW(TAG, "PANIC: BOOT pressed - releasing all inputs");
            input_release_all();
        }
        prev_pressed = pressed;

        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void app_main(void) {
    ESP_LOGI(TAG, "ESP32 Remote starting");

    // --- Display first, so we can report progress on it (non-fatal) ---
    display_init();
    display_status(LCD_LINE_TITLE, "ESP32 Remote");
    display_status(LCD_LINE_HINT,  "booting...");

    // --- NVS is required by both security and WiFi ---
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // --- Device code: loaded from NVS, or generated on first boot ---
    security_init();

    // --- BOOT button as panic switch ---
    gpio_config_t boot_cfg = {
        .pin_bit_mask = (1ULL << PIN_BOOT_BUTTON),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&boot_cfg);

    // --- Input state machine ---
    input_state_init();

    // --- USB HID (before WiFi, so the host sees us quickly) ---
    usb_hid_init();
    display_status(LCD_LINE_HINT, "USB HID ready");

    // --- WiFi SoftAP + HTTP + WebSocket ---
    if (web_server_start() != ESP_OK) {
        ESP_LOGE(TAG, "web_server_start failed - HID still available");
        display_status(LCD_LINE_NET, "WiFi FAILED");
    }

    // --- Pairing screen ---
    show_qr_screen();

    xTaskCreate(tick_task, "tick", 3072, NULL, 5, NULL);

    ESP_LOGI(TAG, "Ready. Scan the LCD's QR for the device code, join WiFi '%s' "
                  "with that code, then open http://192.168.4.1", AP_SSID);
}
