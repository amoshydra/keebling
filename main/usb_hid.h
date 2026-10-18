#pragma once

#include <stdint.h>
#include <stdbool.h>

// Report IDs
#define HID_RID_KEYBOARD  1
#define HID_RID_MOUSE     2
#define HID_RID_CONSUMER  3

// Init USB HID subsystem. Call once from app_main.
void usb_hid_init(void);

// Send a keyboard report. mod = modifier bitmask, keys = up to 6 usage IDs.
// Returns true if queued successfully.
bool usb_hid_keyboard_report(uint8_t mod, const uint8_t keys[6]);

// Send a mouse report. buttons = bitmask, dx/dy/wheel = relative deltas.
bool usb_hid_mouse_report(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel);

// Send a consumer (media) control report. usage = consumer usage ID (0 = release).
bool usb_hid_consumer_report(uint16_t usage);

// True if USB is mounted by host.
bool usb_hid_mounted(void);

// True if ready to accept a report.
bool usb_hid_ready(void);
