// The controllable clock behind esp_timer_get_time(). Tests assign to
// test_now_us to place the firmware at a chosen instant rather than sleeping.
#pragma once

#include <stdint.h>

extern int64_t test_now_us;

static inline void test_clock_advance(int64_t us) {
    test_now_us += us;
}
