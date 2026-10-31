// Recording stand-in for usb_hid.c.
//
// The real module talks to TinyUSB and the USB PHY, neither of which exists on
// the host. Every call is logged with its arguments and its accept/refuse
// decision, so a test can assert what the host would have seen and can script
// the busy endpoint that motivated the retry logic.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define FAKE_MAX_CALLS 8192

typedef enum {
    CALL_KEYBOARD,
    CALL_MOUSE,
    CALL_CONSUMER,
} fake_call_kind;

typedef struct {
    fake_call_kind kind;
    bool accepted;
    uint8_t mod;
    uint8_t keys[6];
    uint8_t buttons;
    int8_t dx, dy, wheel;
    uint16_t usage;
} fake_call;

extern fake_call fake_calls[FAKE_MAX_CALLS];
extern int fake_call_count;
extern bool fake_mounted;

// What the next report of each kind returns. A test flips these to model a
// busy or absent endpoint.
extern bool fake_accept_keyboard;
extern bool fake_accept_mouse;
extern bool fake_accept_consumer;

// Run after the decision is recorded and before the call returns. This is how
// a test lands a state change while a report is "in flight", which is the only
// way to exercise the dirty-flag ordering without real concurrent tasks.
extern void (*fake_hook_keyboard)(void);
extern void (*fake_hook_mouse)(void);
extern void (*fake_hook_consumer)(void);

void fake_reset(void);        // mounted, accepting, no hooks, empty log
void fake_clear_calls(void);  // empty the log, keep the configuration

const fake_call *fake_last(fake_call_kind kind);
int fake_count(fake_call_kind kind);
