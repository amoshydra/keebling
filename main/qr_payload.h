// What the boot QR carries, and the rule for deciding it.
//
// The payload depends only on where the device can be reached, so it takes the
// addresses and the client count as plain arguments instead of calling the WiFi
// manager and security code itself. That keeps the rule in one place and makes
// it checkable on the host, where the radio is out of reach.
//
// - On a real network (a station address): the published app with a pairing
//   fragment, "https://amoshydra.github.io/keebling/app/#h=<host>&t=<code>".
//   The phone keeps its internet on that network, so the hosted page loads and
//   reads the fragment itself; the host is bare because the page supplies the
//   scheme, which saves seven characters in the QR.
// - Reachable only through its own access point (a client is on it): the
//   device's URL, "http://<ap_ip>/?token=<code>". The phone is on that network,
//   where the hosted app has no internet, but the device UI works there (and
//   may already be cached).
// - Otherwise the only way in is the access point itself, so the payload
//   becomes the standard Wi-Fi join string, naming the access point's runtime
//   SSID (it carries a per-device suffix), which a phone camera understands and
//   which saves typing the twelve-character code.
//
// Gating on "a client is connected" alone was wrong: a device associated to a
// network has a perfectly good address even with nobody on its AP.

#pragma once

#include <stdbool.h>
#include <stddef.h>

// The largest payload qr_payload_build() can write, NUL included. The station
// form is the longest: 44 bytes of published-app URL through "#h=", a
// 15-character IPv4 address, then "&t=" and the 12-character code - 74
// characters. Anything past 78 pushes the QR beyond version 4, which no longer
// fits the panel at 2px modules, so 96 is slack rather than a target.
#define QR_PAYLOAD_MAX 96

// True when the device has an address a browser could open. False means the QR
// has to be a join payload, and the labels beside it must say so.
bool qr_payload_is_url(const char *sta_ip, const char *ap_ip, int client_count);

// Build the payload into `out`. Empty strings mean "no address"; the code is
// the device access code and is never NULL.
void qr_payload_build(char *out, size_t len,
                      const char *ap_ssid,
                      const char *sta_ip, const char *ap_ip,
                      int client_count, const char *code);
