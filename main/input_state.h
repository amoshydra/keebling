#pragma once

#include <stdint.h>
#include <stdbool.h>

// Initialize input state. Call once from app_main.
void input_state_init(void);

// Keyboard: set modifier bitmask and up to 6 keycodes. Sends report.
void input_keyboard(uint8_t mod, const uint8_t keys[6]);

// Mouse: set button mask and relative deltas. Sends report.
void input_mouse(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel);

// Consumer control: send usage (0 = release).
void input_consumer(uint16_t usage);

// Absolute pointer position, 0..32767 across whatever desktop the host maps it
// to. Stateless on purpose: see the note in input_state.c.
void input_pointer(uint16_t x, uint16_t y, uint8_t buttons);

// Release everything — all keys, modifiers, mouse buttons.
void input_release_all(void);

// Call periodically (e.g. from a 10ms task). Handles watchdog.
void input_tick(void);

// Check if any keys/buttons are currently held.
bool input_is_active(void);

// Called by web server on heartbeat/ping to reset watchdog.
void input_heartbeat(void);

// Send anything still outstanding. Called after every input change, from the
// USB task's report-complete callback (which is exactly when the endpoint frees
// up), and from the tick task as a backstop.
void input_hid_flush(void);
