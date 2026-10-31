// The test clock. The implementation lives in fake_clock.c so a test can move
// time forward and drive input_tick()'s watchdog without waiting.
#pragma once

#include <stdint.h>

int64_t esp_timer_get_time(void);
