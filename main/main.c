#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "driver/gpio.h"

#include "display.h"
#include "usb_hid.h"
#include "web_server.h"
#include "input_state.h"

static const char *TAG = "main";

#define PIN_BOOT_BUTTON  GPIO_NUM_0

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
            display_status(8, "! PANIC !");
        } else if (!pressed && prev_pressed) {
            display_status(8, "");
        }
        prev_pressed = pressed;

        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void app_main(void) {
    ESP_LOGI(TAG, "ESP32 Remote starting");

    // --- Display (non-fatal) ---
    display_init();
    display_status(0, "ESP32 Remote");
    display_status(1, "booting...");

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

    // --- USB HID (must come up before WiFi so the host sees us quickly) ---
    usb_hid_init();
    display_status(2, "USB HID init");

    // --- WiFi SoftAP + HTTP + WebSocket (identity of NVS is handled here) ---
    if (web_server_start() == ESP_OK) {
        display_status(3, "AP: esp-remote");
        display_status(4, "http://192.168.4.1");
        ESP_LOGI(TAG, "Ready. Join WiFi 'esp-remote' and open http://192.168.4.1");
    } else {
        display_status(3, "WiFi FAILED");
        ESP_LOGE(TAG, "web_server_start failed - HID still available");
    }

    xTaskCreate(tick_task, "tick", 3072, NULL, 5, NULL);
}
