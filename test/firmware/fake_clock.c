#include "fake_clock.h"

#include "esp_timer.h"

int64_t test_now_us = 1000000;

int64_t esp_timer_get_time(void) {
    return test_now_us;
}
