#include "fake_usb_hid.h"

#include <string.h>

#include "usb_hid.h"

fake_call fake_calls[FAKE_MAX_CALLS];
int fake_call_count;
bool fake_mounted = true;

bool fake_accept_keyboard = true;
bool fake_accept_mouse = true;
bool fake_accept_consumer = true;

void (*fake_hook_keyboard)(void);
void (*fake_hook_mouse)(void);
void (*fake_hook_consumer)(void);

static fake_call *record(fake_call_kind kind) {
    if (fake_call_count >= FAKE_MAX_CALLS) return NULL;
    fake_call *c = &fake_calls[fake_call_count++];
    memset(c, 0, sizeof(*c));
    c->kind = kind;
    return c;
}

void fake_reset(void) {
    fake_mounted = true;
    fake_accept_keyboard = true;
    fake_accept_mouse = true;
    fake_accept_consumer = true;
    fake_hook_keyboard = NULL;
    fake_hook_mouse = NULL;
    fake_hook_consumer = NULL;
    fake_clear_calls();
}

void fake_clear_calls(void) {
    fake_call_count = 0;
}

const fake_call *fake_last(fake_call_kind kind) {
    for (int i = fake_call_count - 1; i >= 0; i--) {
        if (fake_calls[i].kind == kind) return &fake_calls[i];
    }
    return NULL;
}

int fake_count(fake_call_kind kind) {
    int n = 0;
    for (int i = 0; i < fake_call_count; i++) {
        if (fake_calls[i].kind == kind) n++;
    }
    return n;
}

// --- the usb_hid surface input_state.c calls ---------------------------------

bool usb_hid_mounted(void) {
    return fake_mounted;
}

bool usb_hid_keyboard_report(uint8_t mod, const uint8_t keys[6]) {
    fake_call *c = record(CALL_KEYBOARD);
    const bool accepted = fake_accept_keyboard;
    if (c) {
        c->accepted = accepted;
        c->mod = mod;
        memcpy(c->keys, keys, 6);
    }
    if (fake_hook_keyboard) fake_hook_keyboard();
    return accepted;
}

bool usb_hid_mouse_report(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel) {
    fake_call *c = record(CALL_MOUSE);
    const bool accepted = fake_accept_mouse;
    if (c) {
        c->accepted = accepted;
        c->buttons = buttons;
        c->dx = dx;
        c->dy = dy;
        c->wheel = wheel;
    }
    if (fake_hook_mouse) fake_hook_mouse();
    return accepted;
}

bool usb_hid_consumer_report(uint16_t usage) {
    fake_call *c = record(CALL_CONSUMER);
    const bool accepted = fake_accept_consumer;
    if (c) {
        c->accepted = accepted;
        c->usage = usage;
    }
    if (fake_hook_consumer) fake_hook_consumer();
    return accepted;
}
