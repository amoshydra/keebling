// Host tests for main/screen_image.c.
//
// The format is a contract with the browser: an 8-byte header, a length that
// must name the payload the format byte calls for, and a CRC over that payload.
// A wrong length or CRC must be refused before anything is drawn. The CRCs
// below were computed once with zlib.crc32 over the same byte pattern.
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "screen_image.h"
#include "test_util.h"

// zlib.crc32(bytes((i * 7 + 3) & 0xff for i in range(n))) for each payload.
#define CRC_GREY4   0xE77795A5u   // 6,400 bytes
#define CRC_RGB565  0x3C3F505Cu   // 25,600 bytes

static uint8_t s_grey[SCREEN_IMAGE_PAYLOAD_GREY4];
static uint8_t s_colour[SCREEN_IMAGE_PAYLOAD_RGB565];

static void fill_pattern(uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) p[i] = (uint8_t)(i * 7 + 3);
}

// Build a complete file (header + payload, optionally a byte past the end) in
// a temporary stream. tmpfile() gives the check a real FILE* without involving
// LittleFS, which is not reachable on the host anyway.
static FILE *make_file(uint8_t format, uint8_t reserved, uint16_t length,
                       uint32_t crc, const uint8_t *payload, size_t payload_len,
                       int trailing) {
    FILE *f = tmpfile();
    if (!f) return NULL;

    const uint8_t header[SCREEN_IMAGE_HEADER] = {
        format,
        reserved,
        (uint8_t)(length & 0xFF),
        (uint8_t)(length >> 8),
        (uint8_t)(crc & 0xFF),
        (uint8_t)((crc >> 8) & 0xFF),
        (uint8_t)((crc >> 16) & 0xFF),
        (uint8_t)((crc >> 24) & 0xFF),
    };

    fwrite(header, 1, sizeof(header), f);
    if (payload_len) fwrite(payload, 1, payload_len, f);
    if (trailing) fputc(0x00, f);
    rewind(f);
    return f;
}

// The happy paths pin the format byte and the CRC against an implementation
// the firmware does not share.
static void test_grey_file_accepted(void) {
    fill_pattern(s_grey, sizeof(s_grey));

    FILE *f = make_file(SCREEN_IMAGE_FORMAT_GREY4, 0,
                        (uint16_t)sizeof(s_grey), CRC_GREY4,
                        s_grey, sizeof(s_grey), 0);
    CHECK(f != NULL);
    if (!f) return;

    CHECK_INT(screen_image_check(f), SCREEN_IMAGE_FORMAT_GREY4);
    // Positioned at the first payload byte for the draw path.
    CHECK_INT(ftell(f), SCREEN_IMAGE_HEADER);
    fclose(f);
}

static void test_rgb565_file_accepted(void) {
    fill_pattern(s_colour, sizeof(s_colour));

    FILE *f = make_file(SCREEN_IMAGE_FORMAT_RGB565, 0,
                        (uint16_t)sizeof(s_colour), CRC_RGB565,
                        s_colour, sizeof(s_colour), 0);
    CHECK(f != NULL);
    if (!f) return;

    CHECK_INT(screen_image_check(f), SCREEN_IMAGE_FORMAT_RGB565);
    CHECK_INT(ftell(f), SCREEN_IMAGE_HEADER);
    fclose(f);
}

// The length field is what makes the second format additive. A colour file
// claiming the greyscale size, or the reverse, is not this image in another
// format - it is a header that disagrees with itself, and drawing it would use
// the wrong stride. The body matches the named format in each case, so the
// length field is the only thing rejecting it.
static void test_wrong_length_for_format_rejected(void) {
    fill_pattern(s_grey, sizeof(s_grey));
    fill_pattern(s_colour, sizeof(s_colour));

    FILE *colour_at_grey_size = make_file(
        SCREEN_IMAGE_FORMAT_RGB565, 0, (uint16_t)sizeof(s_grey), CRC_RGB565,
        s_colour, sizeof(s_colour), 0);
    CHECK(colour_at_grey_size != NULL);
    if (colour_at_grey_size) {
        CHECK_INT(screen_image_check(colour_at_grey_size), SCREEN_IMAGE_FORMAT_NONE);
        fclose(colour_at_grey_size);
    }

    FILE *grey_at_colour_size = make_file(
        SCREEN_IMAGE_FORMAT_GREY4, 0, (uint16_t)sizeof(s_colour), CRC_GREY4,
        s_grey, sizeof(s_grey), 0);
    CHECK(grey_at_colour_size != NULL);
    if (grey_at_colour_size) {
        CHECK_INT(screen_image_check(grey_at_colour_size), SCREEN_IMAGE_FORMAT_NONE);
        fclose(grey_at_colour_size);
    }
}

static void test_corrupt_payload_rejected(void) {
    fill_pattern(s_grey, sizeof(s_grey));
    s_grey[1234] ^= 0x5A;   // header still describes the original bytes

    FILE *f = make_file(SCREEN_IMAGE_FORMAT_GREY4, 0,
                        (uint16_t)sizeof(s_grey), CRC_GREY4,
                        s_grey, sizeof(s_grey), 0);
    CHECK(f != NULL);
    if (!f) return;

    CHECK_INT(screen_image_check(f), SCREEN_IMAGE_FORMAT_NONE);
    fclose(f);
}

static void test_truncated_file_rejected(void) {
    fill_pattern(s_grey, sizeof(s_grey));

    FILE *f = make_file(SCREEN_IMAGE_FORMAT_GREY4, 0,
                        (uint16_t)sizeof(s_grey), CRC_GREY4,
                        s_grey, sizeof(s_grey) - 1, 0);
    CHECK(f != NULL);
    if (!f) return;

    CHECK_INT(screen_image_check(f), SCREEN_IMAGE_FORMAT_NONE);
    fclose(f);
}

static void test_reserved_byte_must_be_zero(void) {
    fill_pattern(s_grey, sizeof(s_grey));

    FILE *f = make_file(SCREEN_IMAGE_FORMAT_GREY4, 1,
                        (uint16_t)sizeof(s_grey), CRC_GREY4,
                        s_grey, sizeof(s_grey), 0);
    CHECK(f != NULL);
    if (!f) return;

    CHECK_INT(screen_image_check(f), SCREEN_IMAGE_FORMAT_NONE);
    fclose(f);
}

static void test_unknown_format_rejected(void) {
    fill_pattern(s_grey, sizeof(s_grey));

    FILE *f = make_file(0x03, 0, (uint16_t)sizeof(s_grey), CRC_GREY4,
                        s_grey, sizeof(s_grey), 0);
    CHECK(f != NULL);
    if (!f) return;

    CHECK_INT(screen_image_check(f), SCREEN_IMAGE_FORMAT_NONE);
    fclose(f);
}

static void test_trailing_byte_rejected(void) {
    fill_pattern(s_grey, sizeof(s_grey));

    FILE *f = make_file(SCREEN_IMAGE_FORMAT_GREY4, 0,
                        (uint16_t)sizeof(s_grey), CRC_GREY4,
                        s_grey, sizeof(s_grey), 1);
    CHECK(f != NULL);
    if (!f) return;

    CHECK_INT(screen_image_check(f), SCREEN_IMAGE_FORMAT_NONE);
    fclose(f);
}

// --- the streaming check used while an upload is being written --------------

static size_t build_image(uint8_t *out, uint8_t format, uint16_t length,
                          uint32_t crc, const uint8_t *payload, size_t payload_len) {
    out[0] = format;
    out[1] = 0;
    out[2] = (uint8_t)(length & 0xFF);
    out[3] = (uint8_t)(length >> 8);
    out[4] = (uint8_t)(crc & 0xFF);
    out[5] = (uint8_t)((crc >> 8) & 0xFF);
    out[6] = (uint8_t)((crc >> 16) & 0xFF);
    out[7] = (uint8_t)((crc >> 24) & 0xFF);
    memcpy(out + SCREEN_IMAGE_HEADER, payload, payload_len);
    return SCREEN_IMAGE_HEADER + payload_len;
}

static void feed_chunks(screen_image_upload_t *u, const uint8_t *data,
                        size_t len, size_t chunk) {
    for (size_t off = 0; off < len; off += chunk) {
        const size_t n = (len - off < chunk) ? len - off : chunk;
        screen_image_upload_feed(u, data + off, n);
    }
}

static void test_upload_valid_file_accepted(void) {
    static uint8_t file[SCREEN_IMAGE_FILE_GREY4];

    fill_pattern(s_grey, sizeof(s_grey));
    const size_t len = build_image(file, SCREEN_IMAGE_FORMAT_GREY4,
                                   (uint16_t)sizeof(s_grey), CRC_GREY4,
                                   s_grey, sizeof(s_grey));

    screen_image_upload_t u;
    screen_image_upload_begin(&u);
    // Small chunks also exercise a header split across reads.
    feed_chunks(&u, file, len, 3);

    CHECK_INT(u.format, SCREEN_IMAGE_FORMAT_GREY4);
    CHECK_INT(u.payload_len, sizeof(s_grey));
    CHECK(screen_image_upload_ok(&u));
}

static void test_upload_corrupt_payload_rejected(void) {
    static uint8_t file[SCREEN_IMAGE_FILE_GREY4];

    fill_pattern(s_grey, sizeof(s_grey));
    size_t len = build_image(file, SCREEN_IMAGE_FORMAT_GREY4,
                             (uint16_t)sizeof(s_grey), CRC_GREY4,
                             s_grey, sizeof(s_grey));
    file[len - 1] ^= 0x01;

    screen_image_upload_t u;
    screen_image_upload_begin(&u);
    feed_chunks(&u, file, len, 97);

    CHECK(!screen_image_upload_ok(&u));
}

static void test_upload_wrong_length_rejected(void) {
    static uint8_t file[SCREEN_IMAGE_FILE_RGB565];

    fill_pattern(s_colour, sizeof(s_colour));
    // The body is a complete colour payload with a matching CRC; only the
    // length field says greyscale.
    const size_t len = build_image(file, SCREEN_IMAGE_FORMAT_RGB565,
                                   (uint16_t)sizeof(s_grey), CRC_RGB565,
                                   s_colour, sizeof(s_colour));

    screen_image_upload_t u;
    screen_image_upload_begin(&u);
    feed_chunks(&u, file, len, 64);

    CHECK(u.bad);
    CHECK(!screen_image_upload_ok(&u));
}

static void test_upload_truncated_rejected(void) {
    static uint8_t file[SCREEN_IMAGE_FILE_GREY4];

    fill_pattern(s_grey, sizeof(s_grey));
    const size_t len = build_image(file, SCREEN_IMAGE_FORMAT_GREY4,
                                   (uint16_t)sizeof(s_grey), CRC_GREY4,
                                   s_grey, sizeof(s_grey));

    screen_image_upload_t u;
    screen_image_upload_begin(&u);
    feed_chunks(&u, file, len - 1, 100);

    CHECK(!screen_image_upload_ok(&u));
}

static void test_upload_extra_payload_rejected(void) {
    static uint8_t file[SCREEN_IMAGE_FILE_GREY4 + 1];

    fill_pattern(s_grey, sizeof(s_grey));
    const size_t len = build_image(file, SCREEN_IMAGE_FORMAT_GREY4,
                                   (uint16_t)sizeof(s_grey), CRC_GREY4,
                                   s_grey, sizeof(s_grey));
    file[len] = 0xAA;

    screen_image_upload_t u;
    screen_image_upload_begin(&u);
    feed_chunks(&u, file, len + 1, 100);

    CHECK(u.bad);
    CHECK(!screen_image_upload_ok(&u));
}

int main(void) {
    RUN(test_grey_file_accepted);
    RUN(test_rgb565_file_accepted);
    RUN(test_wrong_length_for_format_rejected);
    RUN(test_corrupt_payload_rejected);
    RUN(test_truncated_file_rejected);
    RUN(test_reserved_byte_must_be_zero);
    RUN(test_unknown_format_rejected);
    RUN(test_trailing_byte_rejected);

    RUN(test_upload_valid_file_accepted);
    RUN(test_upload_corrupt_payload_rejected);
    RUN(test_upload_wrong_length_rejected);
    RUN(test_upload_truncated_rejected);
    RUN(test_upload_extra_payload_rejected);

    TEST_END();
}
