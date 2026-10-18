#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "driver/gpio.h"

#include "display.h"
#include "usb_hid.h"
#include "web_server.h"
#include "input_state.h"
#include "security.h"

static const char *TAG = "main";

#define PIN_BOOT_BUTTON  GPIO_NUM_0

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

// ---------------------------------------------------------------------------
// Watchdog + panic-button task.
//
// - input_tick() releases all held keys/buttons if the browser stops
//   heartbeating (see input_state.c).
// - Holding the BOOT button forcibly releases everything. This is the physical
//   panic switch: if a modifier ever gets stuck, hold BOOT for a moment.
// ---------------------------------------------------------------------------
static void tick_task(void *arg) {
    bool prev_pressed = false;

    while (1) {
        input_tick();

        bool pressed = (gpio_get_level(PIN_BOOT_BUTTON) == 0);
        if (pressed && !prev_pressed) {
            ESP_LOGW(TAG, "PANIC: BOOT pressed - releasing all inputs");
            input_release_all();
            display_status(LCD_LINE_PANIC, "! PANIC - released");
        } else if (!pressed && prev_pressed) {
            display_status(LCD_LINE_PANIC, "");
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

    // Diagnostic: why did we last reset? (no serial console available)
    char rline[32];
    snprintf(rline, sizeof(rline), "reset: %s", reset_reason_str(esp_reset_reason()));
    display_status(LCD_LINE_RESET, rline);
    ESP_LOGI(TAG, "Reset reason: %s", reset_reason_str(esp_reset_reason()));

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
    if (web_server_start() == ESP_OK) {
        display_status(LCD_LINE_NET,    "AP: " AP_SSID);
        display_status(LCD_LINE_ADDR,   "http://192.168.4.1");
        display_status(LCD_LINE_WIFI,   "waiting for client");
    } else {
        display_status(LCD_LINE_NET, "WiFi FAILED");
        ESP_LOGE(TAG, "web_server_start failed - HID still available");
    }

    // --- The one secret, shown so it can be read off the screen ---
    // It doubles as the SoftAP password. Anyone who can read this screen can
    // control the host, which is the intended trust boundary: physical access.
    char code_line[32];
    snprintf(code_line, sizeof(code_line), "code: %s", security_code());
    display_status(LCD_LINE_CODE, code_line);

    xTaskCreate(tick_task, "tick", 3072, NULL, 5, NULL);

    ESP_LOGI(TAG, "Ready. Join WiFi '%s' using the code on the LCD, then open "
                  "http://192.168.4.1/?token=<code>", AP_SSID);
}
