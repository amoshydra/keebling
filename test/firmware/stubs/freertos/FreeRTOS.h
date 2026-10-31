// Host stand-in for the FreeRTOS core header.
//
// Only the handful of types and constants the firmware's semaphore calls need
// are here. The point of these tests is the logic above the RTOS, not the RTOS.
#pragma once

#include <stdint.h>

typedef int BaseType_t;
typedef unsigned int UBaseType_t;
typedef uint32_t TickType_t;

#define pdTRUE   1
#define pdFALSE  0

#define portMAX_DELAY  UINT32_MAX
