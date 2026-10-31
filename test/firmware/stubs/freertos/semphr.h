// Semaphores are no-ops on the host: the tests are single threaded, and the
// firmware only uses the mutex to serialise tasks that do not exist here.
#pragma once

#include "freertos/FreeRTOS.h"

typedef void *SemaphoreHandle_t;

static inline SemaphoreHandle_t xSemaphoreCreateMutex(void) {
    static int dummy;
    return &dummy;
}

static inline BaseType_t xSemaphoreTake(SemaphoreHandle_t s, TickType_t wait) {
    (void)s;
    (void)wait;
    return pdTRUE;
}

static inline BaseType_t xSemaphoreGive(SemaphoreHandle_t s) {
    (void)s;
    return pdTRUE;
}
