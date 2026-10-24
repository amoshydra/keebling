#include "input_state.h"
#include <string.h>
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
static uint16_t s_consumer = 0;

// What still needs to reach the host. tud_hid_report() returns false when the
// endpoint is busy, and TinyUSB then sends nothing - the host keeps polling the
// previous report. For a keyboard that means a dropped press never arrives and a
// dropped release leaves the key down; for a mouse a dropped release leaves a
// button held. So nothing here assumes a report was delivered.
//
// States (keys, buttons, media) are cheap to resend and idempotent. Movement is
// not: a lost delta is lost distance, so unsent movement is accumulated and
// carried until the endpoint accepts it.
static bool    s_kbd_dirty, s_mouse_btn_dirty, s_consumer_dirty;
static int16_t s_pending_dx, s_pending_dy, s_pending_wheel;

// True when a key, modifier or mouse button is currently held down.
static bool    s_held = false;
// Wall-clock of the last heartbeat. Watchdog only arms once we've seen one,
// so the device is never "released" before a browser has ever connected.
static int64_t s_last_ping_us = 0;
static bool    s_watchdog_armed = false;

// The report field is a signed byte; unsent movement is carried in int16_t.
static inline int8_t clamp8(int16_t v) {
    return (int8_t)(v > 127 ? 127 : v < -127 ? -127 : v);
}

// Saturating add for the movement accumulator: a burst (or an unplugged gap)
// must not wrap a signed 16-bit value into the opposite direction.
static inline int16_t sat16(int16_t a, int16_t b) {
    int32_t v = (int32_t)a + b;
    return (int16_t)(v > 32000 ? 32000 : v < -32000 ? -32000 : v);
}

static inline void lock(void)   { xSemaphoreTake(s_lock, portMAX_DELAY); }
static inline void unlock(void) { xSemaphoreGive(s_lock); }

// s_held is derived from the actual held state, never set ad hoc.
static void recompute_held(void) {
    bool any = (s_mod != 0) || (s_mouse_buttons != 0) || (s_consumer != 0);
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
    s_kbd_dirty = true;
    recompute_held();
    unlock();

    input_hid_flush();
}

void input_mouse(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel) {
    lock();
    s_mouse_buttons = buttons;
    s_mouse_btn_dirty = true;
    s_pending_dx = sat16(s_pending_dx, dx);
    s_pending_dy = sat16(s_pending_dy, dy);
    s_pending_wheel = sat16(s_pending_wheel, wheel);
    recompute_held();
    unlock();

    input_hid_flush();
}

void input_consumer(uint16_t usage) {
    lock();
    // A held media key counts as activity so the watchdog can release it -
    // otherwise a stuck volume key would repeat forever.
    s_consumer = usage;
    s_consumer_dirty = true;
    recompute_held();
    unlock();

    input_hid_flush();
}

// Send whatever is outstanding. Clearing the dirty flag *before* the send is
// deliberate: a change that lands while the report is in flight sets it again,
// and would otherwise be cleared by this call and never sent.
void input_hid_flush(void) {
    // Nothing is listening: drop what is outstanding rather than let it pile up.
    // Movement queued while unplugged is not worth delivering when the host comes
    // back - replaying it would fling the cursor - and the host re-reads the
    // keyboard state when it enumerates, so the dirty flags are moot.
    if (!usb_hid_mounted()) {
        lock();
        s_pending_dx = s_pending_dy = s_pending_wheel = 0;
        s_kbd_dirty = s_mouse_btn_dirty = s_consumer_dirty = false;
        unlock();
        return;
    }

    uint8_t mod, keys[6], buttons;
    uint16_t consumer;
    int8_t sx, sy, sw;
    bool kbd, btn, cons;

    lock();
    kbd  = s_kbd_dirty;       s_kbd_dirty = false;
    btn  = s_mouse_btn_dirty; s_mouse_btn_dirty = false;
    cons = s_consumer_dirty;  s_consumer_dirty = false;
    mod = s_mod;
    memcpy(keys, s_keys, sizeof(keys));
    buttons = s_mouse_buttons;
    consumer = s_consumer;

    // Take only what one report can carry, and give that much back on failure.
    // Draining the whole accumulator here would drop everything past +-127 even
    // when the send succeeded.
    sx = clamp8(s_pending_dx);
    sy = clamp8(s_pending_dy);
    sw = clamp8(s_pending_wheel);
    s_pending_dx -= sx;
    s_pending_dy -= sy;
    s_pending_wheel -= sw;
    const bool move = (sx || sy || sw);
    unlock();

    if (kbd && !usb_hid_keyboard_report(mod, keys)) {
        lock(); s_kbd_dirty = true; unlock();
    }
    if (cons && !usb_hid_consumer_report(consumer)) {
        lock(); s_consumer_dirty = true; unlock();
    }
    if ((btn || move) && !usb_hid_mouse_report(buttons, sx, sy, sw)) {
        lock();
        s_mouse_btn_dirty = true;
        s_pending_dx = sat16(s_pending_dx, sx);
        s_pending_dy = sat16(s_pending_dy, sy);
        s_pending_wheel = sat16(s_pending_wheel, sw);
        unlock();
    } else if (s_pending_dx || s_pending_dy || s_pending_wheel) {
        // More movement than one report could carry. The report-complete
        // callback will fire for the one just sent and flush the rest.
        lock(); s_mouse_btn_dirty = true; unlock();
    }
}

void input_release_all(void) {
    lock();
    bool was_held = s_held;
    s_mod = 0;
    for (int i = 0; i < 6; i++) s_keys[i] = 0;
    s_mouse_buttons = 0;
    s_consumer = 0;
    s_held = false;
    s_watchdog_armed = false;
    s_kbd_dirty = s_mouse_btn_dirty = s_consumer_dirty = true;
    unlock();

    if (was_held) ESP_LOGW(TAG, "Releasing all held inputs");

    input_hid_flush();
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

    // Backstop: retry anything the USB task has not managed to deliver. Rare,
    // and harmless when there is nothing outstanding.
    input_hid_flush();

}

bool input_is_active(void) {
    return s_held;
}
