// What the boot QR carries, and the rule for deciding it.
//
// The payload depends only on where the device can be reached, so it takes the
// addresses and the client count as plain arguments instead of calling the WiFi
// manager and security code itself. That keeps the rule in one place and makes
// it checkable on the host, where the radio is out of reach.
//
// - On a network with an address, or with a client on its own access point: the
//   URL for that address, so scanning opens the UI already authenticated.
// - Otherwise the only way in is the access point itself, so the payload becomes
//   the standard Wi-Fi join string, which a phone camera understands and which
//   saves typing the twelve-character code.
//
// Gating on "a client is connected" alone was wrong: a device associated to a
// network has a perfectly good address even with nobody on its AP.

#pragma once

#include <stdbool.h>
#include <stddef.h>

// True when the device has an address a browser could open. False means the QR
// has to be a join payload, and the labels beside it must say so.
bool qr_payload_is_url(const char *sta_ip, const char *ap_ip, int client_count);

// Build the payload into `out`. Empty strings mean "no address"; the code is
// the device access code and is never NULL.
void qr_payload_build(char *out, size_t len,
                      const char *sta_ip, const char *ap_ip,
                      int client_count, const char *code);
