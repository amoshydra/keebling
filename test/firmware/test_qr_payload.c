// Host tests for main/qr_payload.c.
//
// Three states, three payloads. A station address means the phone keeps its
// internet, so the QR hands off to the published app; only the access point
// means the device's own UI; neither means the Wi-Fi join string. Gating on
// "is anyone on the access point" alone was wrong: a joined device has an
// address even with no AP clients.
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "qr_payload.h"
#include "test_util.h"

#define CODE  "ABCDEFGHJKLM"
#define STA   "192.168.1.42"
#define AP    "192.168.4.1"
#define SSID  "keebling-3F2A1B"
#define APP   "https://amoshydra.github.io/keebling/app/"

// Version 4 at EC level L holds 78 bytes. Staying under that is what keeps the
// hosted-app QR at 2px modules on the 80px panel.
#define QR_V4_L_BYTES 78

static char s_buf[QR_PAYLOAD_MAX];

static const char *build(const char *sta, const char *ap, int clients) {
    s_buf[0] = '\0';
    qr_payload_build(s_buf, sizeof(s_buf), SSID, sta, ap, clients, CODE);
    return s_buf;
}

static void test_station_hands_off_to_the_published_app(void) {
    // The address wins over the client count: the phone is on a network with
    // internet, so the hosted app loads and pairs itself from the fragment.
    CHECK_STR(build(STA, AP, 0), APP "#h=" STA "&t=" CODE);
    CHECK_STR(build(STA, AP, 1), APP "#h=" STA "&t=" CODE);
    CHECK_STR(build(STA, "", 0), APP "#h=" STA "&t=" CODE);

    // The fragment carries a bare host: no scheme, exactly "#h=<host>&t=<code>".
    CHECK(strstr(build(STA, AP, 0), "#h=http") == NULL);

    // The code is Crockford Base32 - no character that needs escaping.
    CHECK(strstr(build(STA, AP, 0), "&t=" CODE) != NULL);

    // Long enough to need version 4 (past version 3's 53 bytes), short enough
    // to stay at 2px modules.
    CHECK(strlen(build(STA, AP, 0)) > 53);
    CHECK(strlen(build(STA, AP, 0)) <= QR_V4_L_BYTES);
}

static void test_access_point_with_client_is_the_device_url(void) {
    // The phone has no internet here: the hosted app cannot load, but the
    // device's own UI is served from this very address.
    CHECK_STR(build("", AP, 1), "http://" AP "/?token=" CODE);
}

static void test_join_payload_when_nothing_is_reachable(void) {
    // The join payload names the runtime SSID, which carries the MAC suffix.
    CHECK_STR(build("", AP, 0), "WIFI:T:WPA;S:" SSID ";P:" CODE ";;");

    // No client, or no address to point one at: there is no URL to open.
    CHECK_STR(build("", "", 1), "WIFI:T:WPA;S:" SSID ";P:" CODE ";;");
    CHECK_STR(build("", "", 0), "WIFI:T:WPA;S:" SSID ";P:" CODE ";;");
}

static void test_url_predicate_matches_payload(void) {
    CHECK(qr_payload_is_url(STA, AP, 0));
    CHECK(qr_payload_is_url(STA, "", 0));
    CHECK(qr_payload_is_url("", AP, 1));
    CHECK(!qr_payload_is_url("", AP, 0));
    CHECK(!qr_payload_is_url("", "", 1));
    CHECK(!qr_payload_is_url("", "", 0));
}

static void test_longest_address_fits_without_truncation(void) {
    // A dotted quad is at most 15 characters. That is the longest host the QR
    // has to carry today, and the whole payload must fit the caller's buffer.
    const char *longest = "255.255.255.255";
    const char *p = build(longest, AP, 0);
    CHECK_STR(p, APP "#h=255.255.255.255&t=" CODE);
    CHECK(strlen(p) <= QR_V4_L_BYTES);
    CHECK(strlen(p) < QR_PAYLOAD_MAX);
}

static void test_short_buffer_stays_terminated(void) {
    char small[8];
    qr_payload_build(small, sizeof(small), SSID, STA, AP, 0, CODE);
    CHECK_INT(small[sizeof(small) - 1], '\0');
    // Truncated, not dropped: the prefix that did fit is still there.
    CHECK_STR(small, "https:/");
}

int main(void) {
    RUN(test_station_hands_off_to_the_published_app);
    RUN(test_access_point_with_client_is_the_device_url);
    RUN(test_join_payload_when_nothing_is_reachable);
    RUN(test_url_predicate_matches_payload);
    RUN(test_longest_address_fits_without_truncation);
    RUN(test_short_buffer_stays_terminated);

    TEST_END();
}
