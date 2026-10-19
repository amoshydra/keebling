#include "screen_image.h"

#include "display.h"
#include "ui_fs.h"

#include "esp_log.h"

#include <string.h>

static const char *TAG = "screen_image";

// The images are for this panel. A mismatch would not fail at run time - it
// would draw a wrong stride and look like a garbled picture - so it is a build
// error.
_Static_assert(SCREEN_IMAGE_PAYLOAD_GREY4 == (size_t)LCD_W * LCD_H / 2,
               "greyscale image geometry does not match the panel");
_Static_assert(SCREEN_IMAGE_PAYLOAD_RGB565 == (size_t)LCD_W * LCD_H * 2,
               "RGB565 image geometry does not match the panel");

// Payload bytes the format byte calls for, or 0 for a format this build does
// not draw. Everything downstream - the length field, the upload's expected
// size, the draw path - hangs off this one answer, so the two formats cannot be
// confused for one another.
static size_t payload_for_format(uint8_t format) {
    switch (format) {
    case SCREEN_IMAGE_FORMAT_GREY4:  return SCREEN_IMAGE_PAYLOAD_GREY4;
    case SCREEN_IMAGE_FORMAT_RGB565: return SCREEN_IMAGE_PAYLOAD_RGB565;
    default:                         return 0;
    }
}

// IEEE CRC-32, bitwise so there is no table to keep in step with the browser's
// copy of the same loop. It runs once per upload and once per draw, over at
// most 25,600 payload bytes, so the cost is real but never on a hot path.
static uint32_t crc32_update(uint32_t crc, const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) {
        crc ^= p[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)-(int32_t)(crc & 1));
        }
    }
    return crc;
}

// Parse the 8-byte header. Returns the format byte, or 0 when any field is not
// what that format says - including a length field that disagrees with it. Sets
// *payload_out to the size the format byte calls for.
static uint8_t header_ok(const uint8_t *h, uint32_t *crc_out, size_t *payload_out) {
    const size_t payload = payload_for_format(h[0]);
    if (payload == 0) return 0;
    if (h[1] != 0) return 0;

    const size_t len = (size_t)h[2] | ((size_t)h[3] << 8);
    if (len != payload) return 0;

    *crc_out = (uint32_t)h[4] | ((uint32_t)h[5] << 8) |
               ((uint32_t)h[6] << 16) | ((uint32_t)h[7] << 24);
    *payload_out = payload;
    return h[0];
}

uint8_t screen_image_check(FILE *f) {
    uint8_t header[SCREEN_IMAGE_HEADER];
    if (fread(header, 1, sizeof(header), f) != sizeof(header)) return 0;

    uint32_t want;
    size_t payload;
    const uint8_t format = header_ok(header, &want, &payload);
    if (format == 0) return 0;

    uint32_t crc = 0xFFFFFFFF;
    uint8_t buf[128];
    size_t got = 0;
    while (got < payload) {
        const size_t n = fread(buf, 1, sizeof(buf), f);
        if (n == 0) return 0;
        crc = crc32_update(crc, buf, n);
        got += n;
    }
    if ((crc ^ 0xFFFFFFFF) != want) return 0;

    // Nothing may follow the payload. A longer file is a different format (or
    // a stale one), not this image with a tail.
    if (fgetc(f) != EOF) return 0;

    if (fseek(f, SCREEN_IMAGE_HEADER, SEEK_SET) != 0) return 0;
    return format;
}

bool screen_image_available(void) {
    FILE *f = ui_fs_open(SCREEN_IMAGE_NAME);
    if (!f) return false;

    const bool ok = screen_image_check(f) != SCREEN_IMAGE_FORMAT_NONE;
    fclose(f);
    return ok;
}

bool screen_image_draw(void) {
    FILE *f = ui_fs_open(SCREEN_IMAGE_NAME);
    if (!f) return false;

    // Validate before the framebuffer is touched: a stale or half-written file
    // must leave the previous screen up rather than draw garbage. The format
    // byte decides which reader gets it, so a file cannot be drawn as the
    // format it is not.
    const uint8_t format = screen_image_check(f);
    const bool ok = (format == SCREEN_IMAGE_FORMAT_GREY4 && display_grey4(f)) ||
                    (format == SCREEN_IMAGE_FORMAT_RGB565 && display_rgb565(f));
    fclose(f);
    return ok;
}

void screen_image_upload_begin(screen_image_upload_t *u) {
    memset(u, 0, sizeof(*u));
    u->crc = 0xFFFFFFFF;
}

void screen_image_upload_feed(screen_image_upload_t *u, const uint8_t *data, size_t len) {
    if (u->bad || !data) return;

    if (u->header_len < SCREEN_IMAGE_HEADER) {
        const size_t want = SCREEN_IMAGE_HEADER - u->header_len;
        const size_t take = len < want ? len : want;
        memcpy(u->header + u->header_len, data, take);
        u->header_len += take;
        u->total += take;
        data += take;
        len -= take;

        if (u->header_len == SCREEN_IMAGE_HEADER) {
            u->format = header_ok(u->header, &u->want_crc, &u->expect_payload);
            if (u->format == SCREEN_IMAGE_FORMAT_NONE) {
                ESP_LOGW(TAG, "upload refused: unknown format or length field");
                u->bad = true;
                return;
            }
        }
    }

    if (len == 0) return;
    if (u->payload_len + len > u->expect_payload) {
        ESP_LOGW(TAG, "upload refused: more than %u payload bytes",
                 (unsigned)u->expect_payload);
        u->bad = true;
        return;
    }

    u->crc = crc32_update(u->crc, data, len);
    u->payload_len += len;
    u->total += len;
}

bool screen_image_upload_ok(const screen_image_upload_t *u) {
    return !u->bad &&
           u->format != SCREEN_IMAGE_FORMAT_NONE &&
           u->total == SCREEN_IMAGE_HEADER + u->expect_payload &&
           u->header_len == SCREEN_IMAGE_HEADER &&
           u->payload_len == u->expect_payload &&
           (u->crc ^ 0xFFFFFFFF) == u->want_crc;
}
