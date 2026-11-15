// The published UI's origins, and the match against a request's Origin header.
//
// Deliberately free of ESP-IDF: this is the one rule in the CORS code that can
// be checked on the host, and test/firmware/test_web_origin.c does exactly
// that. web_server.c still owns the headers; this owns the decision.
#pragma once

// Where the UI is also published. Serving it from a trusted HTTPS origin is
// what unlocks the browser's Keyboard Lock API, which is the difference between
// a remote keyboard that can send Esc and one that cannot.
//
// These are compile-time constants, and the CORS code answers with the matching
// literal rather than echoing the request header: esp_http_server stores the
// header value pointer, not a copy, so a value built on a handler's stack is
// dangling by the time the response is written.
#ifndef WEB_APP_ORIGIN
#define WEB_APP_ORIGIN "https://amoshydra.github.io"
#endif
// A second origin for local work: serve site/ from this address and the probe
// can exercise CORS without a Pages deploy. Define it as "" to lock the device
// to the published UI alone.
#ifndef WEB_APP_ORIGIN_DEV
#define WEB_APP_ORIGIN_DEV "http://localhost:8080"
#endif

// The published UI itself, path included. The boot QR hands off to this page
// with the device address and code in the fragment, so a phone that still has
// internet lands in the app already paired. Derived from the origin so a build
// that overrides that origin does not keep pointing the QR at github.io.
#define WEB_APP_URL WEB_APP_ORIGIN "/keebling/app/"

// Returns the matching origin literal, or NULL when `origin` is not one of the
// app origins. The comparison is case-insensitive, as origins are.
//
// The returned pointer is one of the compiled-in literals, never `origin`: the
// caller must be able to hand it to httpd_resp_set_hdr, which keeps the pointer
// rather than copying the bytes. An empty entry (WEB_APP_ORIGIN_DEV "") matches
// nothing, which is how the dev origin gets disabled.
const char *web_app_origin(const char *origin);
