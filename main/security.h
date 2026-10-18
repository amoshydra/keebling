#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Length of the device access code, in characters.
//
// 12 characters of Crockford Base32 (5 bits each) = 60 bits of entropy.
// Also used verbatim as the SoftAP password, so it must stay within the
// WPA2-PSK window of 8..63 characters.
#define SECURITY_CODE_LEN 12

// Load the device code from NVS, or generate and persist one on first boot.
// Requires NVS to be initialised first.
void security_init(void);

// The device access code. Never NULL after security_init().
const char *security_code(void);

// True if the supplied token matches the device code.
// Comparison is case-insensitive and ignores '-' and ' ' so a code read off
// the screen can be typed with the grouping the display shows.
bool security_check_token(const char *token);

// --- Per-source throttle ---------------------------------------------------
//
// Deliberately keyed on the source address rather than global. A global
// lockout would be a trivial denial of service: anyone able to reach the
// device could spend ten bad guesses and lock out the legitimate user.
//
// This is defence in depth only. The real protection is that 60 bits of
// entropy makes guessing infeasible even with unlimited attempts, so the
// throttle can be made quite gentle.

// True while this source address is throttled.
bool security_ip_locked(uint32_t ip);

// Record an auth outcome for a source address.
void security_note_ip_result(uint32_t ip, bool ok);
