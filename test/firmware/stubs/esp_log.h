// ESP-IDF logging, compiled down to an opt-in stderr printer.
//
// The macros still reference their arguments so the sources keep the same
// warnings they would have on the device (an unused variable in a log call is
// a real finding). Set FIRMWARE_TEST_LOG=1 to see the lines during a run.
#pragma once

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

static inline void test_log(const char *level, const char *tag,
                            const char *fmt, ...) {
    static int enabled = -1;
    if (enabled < 0) enabled = getenv("FIRMWARE_TEST_LOG") != NULL;
    if (!enabled) return;

    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "[%s] %s: ", level, tag);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}

#define ESP_LOGE(tag, fmt, ...) test_log("E", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGW(tag, fmt, ...) test_log("W", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...) test_log("I", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGD(tag, fmt, ...) test_log("D", tag, fmt, ##__VA_ARGS__)
