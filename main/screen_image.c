#include "screen_image.h"

#include "display.h"
#include "ui_fs.h"

#include "esp_log.h"

#include <string.h>

static const char *TAG = "screen_image";

// The image is for this panel. A mismatch would not fail at run time - it would
// draw a wrong stride and look like a garbled picture - so it is a build error.
_Static_assert(SCREEN_IMAGE_PAYLOAD == (size_t)LCD_W * LCD_H / 2,
               "screen image geometry does not match the panel");

// IEEE CRC-32, bitwise so there is no table to keep in step with the browser's
// copy of the same loop. 6,400 bytes is a few microseconds either way.
static uint32_t crc32_update(uint32_t crc, const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) {
        crc ^= p[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)-(int32_t)(crc & 1));
        }
    }
    return crc;
}

// Parse the 8-byte header. Fails when any field is not what this format says.
static bool header_ok(const uint8_t *h, uint32_t *crc_out) {
    if (h[0] != SCREEN_IMAGE_FORMAT) return false;
    if (h[1] != 0) return false;

    const size_t len = (size_t)h[2] | ((size_t)h[3] << 8);
    if (len != SCREEN_IMAGE_PAYLOAD) return false;

    *crc_out = (uint32_t)h[4] | ((uint32_t)h[5] << 8) |
               ((uint32_t)h[6] << 16) | ((uint32_t)h[7] << 24);
    return true;
}

bool screen_image_check(FILE *f) {
    uint8_t header[SCREEN_IMAGE_HEADER];
    if (fread(header, 1, sizeof(header), f) != sizeof(header)) return false;

    uint32_t want;
    if (!header_ok(header, &want)) return false;

    uint32_t crc = 0xFFFFFFFF;
    uint8_t buf[128];
    size_t got = 0;
    while (got < SCREEN_IMAGE_PAYLOAD) {
        const size_t n = fread(buf, 1, sizeof(buf), f);
        if (n == 0) return false;
        crc = crc32_update(crc, buf, n);
        got += n;
    }
    if ((crc ^ 0xFFFFFFFF) != want) return false;

    // Nothing may follow the payload. A longer file is a different format (or
    // a stale one), not this image with a tail.
    if (fgetc(f) != EOF) return false;

    return fseek(f, SCREEN_IMAGE_HEADER, SEEK_SET) == 0;
}

bool screen_image_available(void) {
    FILE *f = ui_fs_open(SCREEN_IMAGE_NAME);
    if (!f) return false;

    const bool ok = screen_image_check(f);
    fclose(f);
    return ok;
}

bool screen_image_draw(void) {
    FILE *f = ui_fs_open(SCREEN_IMAGE_NAME);
    if (!f) return false;

    // Validate before the framebuffer is touched: a stale or half-written file
    // must leave the previous screen up rather than draw garbage.
    const bool ok = screen_image_check(f) && display_grey4(f);
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
            if (!header_ok(u->header, &u->want_crc)) {
                ESP_LOGW(TAG, "upload refused: bad format or length field");
                u->bad = true;
                return;
            }
        }
    }

    if (len == 0) return;
    if (u->payload_len + len > SCREEN_IMAGE_PAYLOAD) {
        ESP_LOGW(TAG, "upload refused: more than %u payload bytes",
                 (unsigned)SCREEN_IMAGE_PAYLOAD);
        u->bad = true;
        return;
    }

    u->crc = crc32_update(u->crc, data, len);
    u->payload_len += len;
    u->total += len;
}

bool screen_image_upload_ok(const screen_image_upload_t *u) {
    return !u->bad &&
           u->total == SCREEN_IMAGE_FILE_BYTES &&
           u->header_len == SCREEN_IMAGE_HEADER &&
           u->payload_len == SCREEN_IMAGE_PAYLOAD &&
           (u->crc ^ 0xFFFFFFFF) == u->want_crc;
}
