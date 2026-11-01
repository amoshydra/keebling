#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

// Report IDs
#define HID_RID_KEYBOARD  1
#define HID_RID_MOUSE     2
#define HID_RID_CONSUMER  3

// Init USB HID subsystem. Call once from app_main.
void usb_hid_init(void);

// True while a host is enumerated. Reports sent while false go nowhere.
bool usb_hid_mounted(void);

// Send a keyboard report. mod = modifier bitmask, keys = up to 6 usage IDs.
// Returns true if queued successfully.
bool usb_hid_keyboard_report(uint8_t mod, const uint8_t keys[6]);

// Send a mouse report. buttons = bitmask, dx/dy/wheel = relative deltas.
bool usb_hid_mouse_report(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel);

// Send a consumer (media) control report. usage = consumer usage ID (0 = release).
bool usb_hid_consumer_report(uint16_t usage);

// Send an absolute pointer position, 0..32767 across the desktop the host
// chooses to map it to. Absolute reports carry the whole position, so a refused
// one is corrected by the next - there is no backlog to keep.
bool usb_hid_pointer_report(uint16_t x, uint16_t y, uint8_t buttons);
bool usb_hid_pointer_ready(void);

// For diagnostics: the report descriptor we hand to the host, and the HID
// interface parameters from the configuration descriptor.
const uint8_t *usb_hid_report_descriptor(size_t *len);
int usb_hid_endpoint_size(void);
int usb_hid_poll_interval_ms(void);
const char *usb_hid_product_name(void);

// String descriptor by index (1 manufacturer, 2 product, 3 serial, 4 interface).
const char *usb_hid_string(int index);

// True if ready to accept a report.
bool usb_hid_ready(void);

// The host's keyboard LED byte, as last sent to us (bit 0 Num, 1 Caps,
// 2 Scroll). Returns false until the host has sent one, which is why it is a
// pair rather than a bare zero: 0 means every LED off, and unknown is not that.
bool usb_hid_led_state(uint8_t *out);
