// A deliberately small assertion set. Each test binary is one translation unit
// with its own counters, so there is nothing to link and nothing to install.
#pragma once

#include <stdio.h>
#include <string.h>

static int t_checks;
static int t_failures;

#define CHECK(cond)                                                     \
    do {                                                                \
        t_checks++;                                                     \
        if (!(cond)) {                                                  \
            t_failures++;                                               \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
        }                                                               \
    } while (0)

#define CHECK_INT(got, want)                                            \
    do {                                                                \
        long long g_ = (long long)(got);                                \
        long long w_ = (long long)(want);                               \
        t_checks++;                                                     \
        if (g_ != w_) {                                                 \
            t_failures++;                                               \
            fprintf(stderr, "FAIL %s:%d: %s == %lld, want %lld\n",      \
                    __FILE__, __LINE__, #got, g_, w_);                  \
        }                                                               \
    } while (0)

#define CHECK_STR(got, want)                                            \
    do {                                                                \
        const char *g_ = (got);                                         \
        const char *w_ = (want);                                        \
        t_checks++;                                                     \
        if (!g_ || !w_ || strcmp(g_, w_) != 0) {                        \
            t_failures++;                                               \
            fprintf(stderr, "FAIL %s:%d: %s == \"%s\", want \"%s\"\n",  \
                    __FILE__, __LINE__, #got, g_ ? g_ : "(null)",       \
                    w_ ? w_ : "(null)");                                \
        }                                                               \
    } while (0)

#define RUN(fn)                                                         \
    do {                                                                \
        fprintf(stderr, "  %s\n", #fn);                                 \
        fn();                                                           \
    } while (0)

#define TEST_END()                                                      \
    do {                                                                \
        if (t_failures) {                                               \
            fprintf(stderr, "%d of %d checks failed\n",                 \
                    t_failures, t_checks);                              \
            return 1;                                                   \
        }                                                               \
        fprintf(stderr, "ok: %d checks\n", t_checks);                   \
        return 0;                                                       \
    } while (0)
