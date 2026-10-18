#include "input_state.h"
#include "usb_hid.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "input_state";

// If the browser stops sending heartbeats while something is held down,
// release everything. Covers dropped WebSockets, crashed tabs, dead WiFi.
#define WATCHDOG_TIMEOUT_US  (5 * 1000 * 1000)

// Serialises access to the USB report API: reports arrive from the WebSocket
// task, the watchdog task, and the WiFi event task.
static SemaphoreHandle_t s_lock;

static uint8_t s_mod = 0;
static uint8_t s_keys[6] = {0};
static uint8_t s_mouse_buttons = 0;

// True when a key, modifier or mouse button is currently held down.
static bool    s_held = false;
// Wall-clock of the last heartbeat. Watchdog only arms once we've seen one,
// so the device is never "released" before a browser has ever connected.
static int64_t s_last_ping_us = 0;
static bool    s_watchdog_armed = false;

static inline void lock(void)   { xSemaphoreTake(s_lock, portMAX_DELAY); }
static inline void unlock(void) { xSemaphoreGive(s_lock); }

// s_held is derived from the actual held state, never set ad hoc.
static void recompute_held(void) {
    bool any = (s_mod != 0) || (s_mouse_buttons != 0);
    for (int i = 0; i < 6; i++) if (s_keys[i]) any = true;
    s_held = any;
}

void input_state_init(void) {
    s_lock = xSemaphoreCreateMutex();
    ESP_LOGI(TAG, "Input state ready");
}

void input_keyboard(uint8_t mod, const uint8_t keys[6]) {
    lock();
    s_mod = mod;
    for (int i = 0; i < 6; i++) s_keys[i] = keys[i];
    recompute_held();
    unlock();

    usb_hid_keyboard_report(mod, keys);
}

void input_mouse(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel) {
    lock();
    s_mouse_buttons = buttons;
    recompute_held();
    unlock();

    usb_hid_mouse_report(buttons, dx, dy, wheel);
}

void input_consumer(uint16_t usage) {
    usb_hid_consumer_report(usage);
}

void input_release_all(void) {
    lock();
    bool was_held = s_held;
    s_mod = 0;
    for (int i = 0; i < 6; i++) s_keys[i] = 0;
    s_mouse_buttons = 0;
    s_held = false;
    s_watchdog_armed = false;
    unlock();

    if (was_held) ESP_LOGW(TAG, "Releasing all held inputs");

    usb_hid_keyboard_report(0, (const uint8_t[6]){0, 0, 0, 0, 0, 0});
    usb_hid_mouse_report(0, 0, 0, 0);
    usb_hid_consumer_report(0);
}

void input_heartbeat(void) {
    lock();
    s_last_ping_us = esp_timer_get_time();
    s_watchdog_armed = true;
    unlock();
}

void input_tick(void) {
    bool fire = false;
    lock();
    if (s_watchdog_armed && s_held &&
        (esp_timer_get_time() - s_last_ping_us) > WATCHDOG_TIMEOUT_US) {
        s_watchdog_armed = false;   // one shot
        fire = true;
    }
    unlock();

    if (fire) {
        ESP_LOGW(TAG, "Watchdog: heartbeat lost while inputs held");
        input_release_all();
    }
}

bool input_is_active(void) {
    return s_held;
}
