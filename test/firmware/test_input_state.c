// Host tests for main/input_state.c.
//
// The module is the one that decides what the host has actually received, so
// these tests drive its public surface against a recording USB fake and a
// clock they control. Nothing here needs a task, a USB stack or TinyUSB.
#include <stdint.h>
#include <string.h>

#include "input_state.h"
#include "fake_clock.h"
#include "fake_usb_hid.h"
#include "test_util.h"

// Put the module back in a clean, connected, idle state and empty the log. The
// module has no reset call (it should not need one on the device), so release
// everything and drain any movement a previous test left behind.
static void reset_state(void) {
    fake_reset();
    input_release_all();
    for (int i = 0; i < 400; i++) input_hid_flush();

    fake_reset();
    test_now_us = 1000000;
}

// The endpoint refusing a report used to be an error nobody looked at: the
// caller discarded the false return and the press never arrived. Nothing may be
// dropped, so the next flush has to carry the same state again.
static void test_refused_report_is_retried(void) {
    const uint8_t keys[6] = {0x04};   // 'a'

    fake_accept_keyboard = false;
    input_keyboard(0, keys);

    const fake_call *first = fake_last(CALL_KEYBOARD);
    CHECK(first != NULL);
    CHECK(!first->accepted);
    CHECK_INT(first->keys[0], 0x04);

    fake_accept_keyboard = true;
    input_hid_flush();

    const fake_call *second = fake_last(CALL_KEYBOARD);
    CHECK(second != NULL);
    CHECK(second->accepted);
    CHECK_INT(fake_count(CALL_KEYBOARD), 2);
    CHECK_INT(second->keys[0], 0x04);
}

// Landing a change during a send. The competing flush is refused, exactly the
// situation the dirty flag exists for: if the outer flush cleared the flag
// after its own send succeeded, the newer state would be swallowed.
static int hook_depth;
static void queue_second_key_during_send(void) {
    if (hook_depth) return;
    hook_depth = 1;

    const uint8_t keys[6] = {0x05};   // 'b'
    fake_accept_keyboard = false;     // the competing flush cannot get through
    input_keyboard(0, keys);

    hook_depth = 0;
}

static void test_change_during_send_is_not_swallowed(void) {
    const uint8_t first[6] = {0x04};

    fake_accept_keyboard = true;
    fake_hook_keyboard = queue_second_key_during_send;
    input_keyboard(0, first);         // send accepted; hook queues 'b' mid-flight
    fake_hook_keyboard = NULL;

    fake_accept_keyboard = true;
    input_hid_flush();

    const fake_call *last = fake_last(CALL_KEYBOARD);
    CHECK(last != NULL);
    CHECK(last->accepted);
    CHECK_INT(last->keys[0], 0x05);
}

// Three hundred pixels queued, one report accepted. Only the 127 pixels that
// left are done: the other 173 were not lost, they were waiting. Draining the
// whole accumulator on success was a real bug.
static void test_movement_is_removed_only_as_sent(void) {
    fake_accept_mouse = false;
    input_mouse(0, 100, 0, 0);
    input_mouse(0, 100, 0, 0);

    fake_clear_calls();
    fake_accept_mouse = true;
    input_mouse(0, 100, 0, 0);        // 300 pending, one report carries 127

    const fake_call *first = fake_last(CALL_MOUSE);
    CHECK(first != NULL);
    CHECK(first->accepted);
    CHECK_INT(first->dx, 127);
    CHECK_INT(fake_count(CALL_MOUSE), 1);

    input_hid_flush();                // still ~173 pending
    const fake_call *second = fake_last(CALL_MOUSE);
    CHECK(second != NULL);
    CHECK_INT(fake_count(CALL_MOUSE), 2);
    CHECK_INT(second->dx, 127);

    input_hid_flush();                // the final 46
    const fake_call *third = fake_last(CALL_MOUSE);
    CHECK(third != NULL);
    CHECK_INT(fake_count(CALL_MOUSE), 3);
    CHECK_INT(third->dx, 46);

    int total = 0;
    for (int i = 0; i < fake_call_count; i++) {
        if (fake_calls[i].kind == CALL_MOUSE) total += fake_calls[i].dx;
    }
    CHECK_INT(total, 300);

    input_hid_flush();                // nothing left
    CHECK_INT(fake_count(CALL_MOUSE), 3);
}

// A burst beyond the signed report field must saturate. Letting a 16-bit
// accumulator wrap turns a fast flick into a movement in the opposite
// direction, which is worse than clipping it.
static void test_accumulator_saturates_positive(void) {
    fake_accept_mouse = false;
    for (int i = 0; i < 400; i++) input_mouse(0, 127, 0, 0);

    fake_clear_calls();
    fake_accept_mouse = true;
    for (int i = 0; i < 400; i++) input_hid_flush();

    int32_t total = 0;
    bool negative = false;
    for (int i = 0; i < fake_call_count; i++) {
        if (fake_calls[i].kind != CALL_MOUSE || !fake_calls[i].accepted) continue;
        total += fake_calls[i].dx;
        if (fake_calls[i].dx < 0) negative = true;
    }

    CHECK_INT(total, 32000);
    CHECK(!negative);
}

static void test_accumulator_saturates_negative(void) {
    fake_accept_mouse = false;
    for (int i = 0; i < 400; i++) input_mouse(0, -127, 0, 0);

    fake_clear_calls();
    fake_accept_mouse = true;
    for (int i = 0; i < 400; i++) input_hid_flush();

    int32_t total = 0;
    bool positive = false;
    for (int i = 0; i < fake_call_count; i++) {
        if (fake_calls[i].kind != CALL_MOUSE || !fake_calls[i].accepted) continue;
        total += fake_calls[i].dx;
        if (fake_calls[i].dx > 0) positive = true;
    }

    CHECK_INT(total, -32000);
    CHECK(!positive);
}

// Nothing is listening. Queued movement must be dropped rather than replayed
// onto a cursor that moved on while the cable was out.
static void test_unmounted_discards_outstanding_work(void) {
    const uint8_t keys[6] = {0x04};

    fake_mounted = false;
    input_keyboard(0, keys);
    input_mouse(0, 50, 50, 0);

    fake_mounted = true;
    fake_clear_calls();
    input_hid_flush();

    CHECK_INT(fake_call_count, 0);
}

// Release-all is the panic path. Every category has to be cleared, and the
// zeroed reports have to actually go out.
static void test_release_all_clears_every_category(void) {
    const uint8_t keys[6] = {0x04};

    input_keyboard(0x02, keys);       // shift + 'a'
    input_mouse(0x01, 0, 0, 0);       // left button
    input_consumer(0xE9);
    CHECK(input_is_active());

    fake_clear_calls();
    input_release_all();

    const fake_call *kbd = fake_last(CALL_KEYBOARD);
    const fake_call *btn = fake_last(CALL_MOUSE);
    const fake_call *cons = fake_last(CALL_CONSUMER);

    CHECK(kbd != NULL && kbd->accepted);
    CHECK(btn != NULL && btn->accepted);
    CHECK(cons != NULL && cons->accepted);

    if (kbd) {
        CHECK_INT(kbd->mod, 0);
        for (int i = 0; i < 6; i++) CHECK_INT(kbd->keys[i], 0);
    }
    if (btn) CHECK_INT(btn->buttons, 0);
    if (cons) CHECK_INT(cons->usage, 0);

    CHECK(!input_is_active());
}

// A lost heartbeat while a key is held must release it, once. Repeated ticks
// must not keep firing, and an idle device must not fire at all.
static void test_watchdog_fires_once_while_held(void) {
    const uint8_t keys[6] = {0x04};

    test_now_us = 1000000;
    input_heartbeat();
    input_keyboard(0, keys);
    fake_clear_calls();

    test_clock_advance(4 * 1000 * 1000);   // inside the five-second window
    input_tick();
    CHECK_INT(fake_call_count, 0);
    CHECK(input_is_active());

    input_heartbeat();                     // heartbeat extends the deadline
    test_clock_advance(4 * 1000 * 1000);
    input_tick();
    CHECK_INT(fake_call_count, 0);
    CHECK(input_is_active());

    test_clock_advance(2 * 1000 * 1000);   // now past it
    input_tick();

    const fake_call *kbd = fake_last(CALL_KEYBOARD);
    CHECK(kbd != NULL && kbd->accepted);
    if (kbd) {
        CHECK_INT(kbd->mod, 0);
        for (int i = 0; i < 6; i++) CHECK_INT(kbd->keys[i], 0);
    }
    CHECK(!input_is_active());

    const int after_release = fake_call_count;
    input_tick();
    CHECK_INT(fake_call_count, after_release);
}

static void test_watchdog_ignores_idle_input(void) {
    test_now_us = 1000000;
    input_heartbeat();                     // armed, but nothing is held

    test_clock_advance(6 * 1000 * 1000);
    fake_clear_calls();
    input_tick();

    CHECK_INT(fake_call_count, 0);
}

int main(void) {
    input_state_init();

    RUN(test_refused_report_is_retried);
    reset_state();

    RUN(test_change_during_send_is_not_swallowed);
    reset_state();

    RUN(test_movement_is_removed_only_as_sent);
    reset_state();

    RUN(test_accumulator_saturates_positive);
    reset_state();

    RUN(test_accumulator_saturates_negative);
    reset_state();

    RUN(test_unmounted_discards_outstanding_work);
    reset_state();

    RUN(test_release_all_clears_every_category);
    reset_state();

    RUN(test_watchdog_fires_once_while_held);
    reset_state();

    RUN(test_watchdog_ignores_idle_input);

    TEST_END();
}
