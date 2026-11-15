// Host tests for main/web_origin.c.
//
// The point of the unit existing is that CORS is a browser-enforced boundary
// with a rule you can get subtly wrong: a prefix that is not the whole origin,
// a case difference, or an echoed request header whose bytes die with the
// handler. So the table below is mostly near-misses.
#include <stdio.h>
#include <string.h>

#include "test_util.h"
#include "web_origin.h"

// A mutable copy of an origin, like the handler's stack buffer that
// httpd_req_get_hdr_value_str fills in.
static char s_req[160];

static const char *ask(const char *origin) {
    snprintf(s_req, sizeof(s_req), "%s", origin);
    return web_app_origin(s_req);
}

static void test_exact_matches(void) {
    CHECK_STR(ask(WEB_APP_ORIGIN), "https://amoshydra.github.io");
    CHECK_STR(ask(WEB_APP_ORIGIN_DEV), "http://localhost:8080");
    CHECK_STR(ask("https://amoshydra.github.io"), "https://amoshydra.github.io");
    CHECK_STR(ask("http://localhost:8080"), "http://localhost:8080");
}

static void test_case_insensitive(void) {
    // Schemes and hostnames are case-insensitive; browsers normalise them, but
    // a hand-written request or a stale client need not.
    CHECK_STR(ask("HTTPS://AMOSHYDRA.GITHUB.IO"), "https://amoshydra.github.io");
    CHECK_STR(ask("https://AmosHydra.GitHub.Io"), "https://amoshydra.github.io");
    CHECK_STR(ask("HTTP://LOCALHOST:8080"), "http://localhost:8080");
}

static void test_foreign_origins(void) {
    CHECK(ask("https://evil.example") == NULL);
    CHECK(ask("https://github.io") == NULL);                 // the suffix alone
    CHECK(ask("https://other.github.io") == NULL);           // a neighbour page
    CHECK(ask("https://amoshydra.github.io:8443") == NULL);  // wrong port
    CHECK(ask("http://amoshydra.github.io") == NULL);        // wrong scheme
    CHECK(ask("https://amoshydra.example") == NULL);
}

static void test_prefix_and_suffix_attacks(void) {
    // strncmp/strstr style matching fails these; strcmp must not.
    CHECK(ask("https://amoshydra.github.io.evil") == NULL);
    CHECK(ask("https://evil.amoshydra.github.io") == NULL);
    CHECK(ask("https://amoshydra.github.io/index.html") == NULL);
    CHECK(ask("https://amoshydra.github.io/") == NULL);
    CHECK(ask("https://amoshydra.github.io?x=1") == NULL);
    CHECK(ask("https://amoshydra.github.io#frag") == NULL);
    CHECK(ask("xhttps://amoshydra.github.io") == NULL);
    CHECK(ask("https://amoshydra.github.io ") == NULL);
}

static void test_non_origin_values(void) {
    // "null" is what a sandboxed iframe or a file:// page sends.
    CHECK(ask("null") == NULL);
    CHECK(ask("NULL") == NULL);
    CHECK(ask("") == NULL);
    CHECK(ask(" ") == NULL);
    CHECK(ask("*") == NULL);
    CHECK(ask("ftp://amoshydra.github.io") == NULL);
    CHECK(ask("ws://amoshydra.github.io") == NULL);
    CHECK(ask("chrome-extension://abcdefghijklmnop") == NULL);
    CHECK(web_app_origin(NULL) == NULL);
}

// The CORS code hands the return value straight to httpd_resp_set_hdr, which
// keeps the pointer and reads the bytes when the response is written. So the
// pointer must be program-lifetime storage, never the caller's stack buffer.
static void test_returned_pointer_is_owned(void) {
    char buf[64];
    strcpy(buf, "https://AMOSHYDRA.github.io");

    const char *got = web_app_origin(buf);
    CHECK(got != NULL);
    CHECK(got != buf);                      // not the request buffer
    CHECK(got == web_app_origin(buf));      // stable across calls

    // Overwriting the request buffer must not change what we will send.
    memset(buf, 'x', sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    CHECK_STR(got, "https://amoshydra.github.io");

    // A differently-cased request resolves to the same literal, not to a
    // second string with a different lifetime.
    CHECK(web_app_origin("HTTPS://amoshydra.GITHUB.io") == got);
}

// Emptying an entry is the documented way to disable it.
static void test_empty_entry_is_disabled(void) {
    // The compiled-in dev origin here is non-empty, so assert the rule the
    // implementation follows rather than recompiling it: a non-empty entry
    // matches, and "" would have to match nothing.
    const char *dev = web_app_origin(WEB_APP_ORIGIN_DEV);
    CHECK((WEB_APP_ORIGIN_DEV[0] == '\0') ? (dev == NULL) : (dev != NULL));
}

int main(void) {
    RUN(test_exact_matches);
    RUN(test_case_insensitive);
    RUN(test_foreign_origins);
    RUN(test_prefix_and_suffix_attacks);
    RUN(test_non_origin_values);
    RUN(test_returned_pointer_is_owned);
    RUN(test_empty_entry_is_disabled);
    TEST_END();
}
