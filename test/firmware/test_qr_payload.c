// Host tests for main/qr_payload.c.
//
// The rule is "where can the device be reached", not "is anyone on its access
// point". A device joined to a network has an address even with no AP clients,
// and gating on the client count sent the phone to a join payload it did not
// need.
#include <stdbool.h>
#include <stdio.h>

#include "qr_payload.h"
#include "test_util.h"

#define CODE  "ABCDEFGHJKLM"
#define STA   "192.168.1.42"
#define AP    "192.168.4.1"

static char s_buf[128];

static const char *build(const char *sta, const char *ap, int clients) {
    s_buf[0] = '\0';
    qr_payload_build(s_buf, sizeof(s_buf), sta, ap, clients, CODE);
    return s_buf;
}

static void test_address_wins_over_client_count(void) {
    // On a network: the station address is reachable with nobody on the AP.
    CHECK_STR(build(STA, AP, 0), "http://" STA "/?token=" CODE);
    CHECK_STR(build(STA, AP, 1), "http://" STA "/?token=" CODE);
    CHECK_STR(build(STA, "", 0), "http://" STA "/?token=" CODE);
}

static void test_access_point_with_client_is_a_url(void) {
    CHECK_STR(build("", AP, 1), "http://" AP "/?token=" CODE);
}

static void test_join_payload_when_nothing_is_reachable(void) {
    CHECK_STR(build("", AP, 0), "WIFI:T:WPA;S:esp-remote;P:" CODE ";;");

    // No client, or no address to point one at: there is no URL to open.
    CHECK_STR(build("", "", 1), "WIFI:T:WPA;S:esp-remote;P:" CODE ";;");
    CHECK_STR(build("", "", 0), "WIFI:T:WPA;S:esp-remote;P:" CODE ";;");
}

static void test_url_predicate_matches_payload(void) {
    CHECK(qr_payload_is_url(STA, AP, 0));
    CHECK(qr_payload_is_url(STA, "", 0));
    CHECK(qr_payload_is_url("", AP, 1));
    CHECK(!qr_payload_is_url("", AP, 0));
    CHECK(!qr_payload_is_url("", "", 1));
    CHECK(!qr_payload_is_url("", "", 0));
}

static void test_short_buffer_stays_terminated(void) {
    char small[8];
    qr_payload_build(small, sizeof(small), STA, AP, 0, CODE);
    CHECK_INT(small[sizeof(small) - 1], '\0');
}

int main(void) {
    RUN(test_address_wins_over_client_count);
    RUN(test_access_point_with_client_is_a_url);
    RUN(test_join_payload_when_nothing_is_reachable);
    RUN(test_url_predicate_matches_payload);
    RUN(test_short_buffer_stays_terminated);

    TEST_END();
}
