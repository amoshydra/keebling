#include "log_buffer.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#define LOG_RING_BYTES 4096

static char s_ring[LOG_RING_BYTES];
static size_t s_len;                 // bytes currently held
static size_t s_head;                // next write position
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static vprintf_like_t s_prev;

// Deliberately lock-free.
//
// vprintf is reached from every task, and on some paths with interrupts
// already masked or the scheduler suspended. Taking a spinlock there is not
// safe, and the failure mode is a hard hang rather than a warning. A single
// writer per call means the worst case here is interleaved text in a debug
// buffer, which is an acceptable price.
static void push(const char *p, size_t n) {
    for (size_t i = 0; i < n; i++) {
        s_ring[s_head] = p[i];
        s_head = (s_head + 1) % LOG_RING_BYTES;
        if (s_len < LOG_RING_BYTES) s_len++;
    }
}

// Must stay cheap: this runs for every log line from any task.
static int capturing_vprintf(const char *fmt, va_list args) {
    va_list copy;
    va_copy(copy, args);
    int ret = s_prev ? s_prev(fmt, args) : 0;

    char tmp[160];
    int n = vsnprintf(tmp, sizeof(tmp), fmt, copy);
    va_end(copy);
    if (n > 0) {
        size_t take = (n < (int)sizeof(tmp)) ? (size_t)n : sizeof(tmp) - 1;
        push(tmp, take);
    }
    return ret;
}

void log_buffer_init(void) {
    s_prev = esp_log_set_vprintf(&capturing_vprintf);
}

void log_buffer_read(char *out, size_t outlen) {
    if (!out || outlen == 0) return;

    portENTER_CRITICAL(&s_mux);
    size_t n = (s_len < outlen - 1) ? s_len : outlen - 1;
    size_t start = (s_head + LOG_RING_BYTES - s_len) % LOG_RING_BYTES;
    for (size_t i = 0; i < n; i++) out[i] = s_ring[(start + i) % LOG_RING_BYTES];
    portEXIT_CRITICAL(&s_mux);

    out[n] = '\0';
}
