// The custom screen image: a 160x80 4-bit greyscale bitmap stored as
// "screen.img" on the UI filesystem.
//
// The device has no PNG or JPEG decoder, and this feature must not need one:
// the browser scales the picture, quantises it with an ordered dither and posts
// the packed result. All the firmware does is check the header and the CRC,
// then expand nibbles through a 16-entry RGB565 LUT straight into the
// framebuffer - one 80-byte row at a time, so the image is never held in RAM.
//
// The file is little-endian, 6,408 bytes:
//
//   offset  size  field
//   0       1     format     0x01 = 4-bit greyscale, 160x80, high nibble is
//                             the left pixel
//   1       1     reserved   must be 0
//   2       2     length     payload length in bytes, must be 6,400
//   4       4     crc32      IEEE CRC-32 (reflected, init and final
//                             0xFFFFFFFF) over the payload bytes only
//   8       6400  payload    80 rows of 80 bytes
//
// The CRC is over the payload alone, so the browser can compute it while
// packing and the device can check it while reading; the format byte, the
// length and the exact file size together cover the header.
//
// The name is a compile-time constant here and never comes from a request:
// ui_fs turns a name into a path, so a request-derived one would be a path
// injection.

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define SCREEN_IMAGE_NAME       "screen.img"
#define SCREEN_IMAGE_W          160
#define SCREEN_IMAGE_H          80
#define SCREEN_IMAGE_FORMAT     0x01
#define SCREEN_IMAGE_HEADER     8
#define SCREEN_IMAGE_PAYLOAD    (SCREEN_IMAGE_W * SCREEN_IMAGE_H / 2)   // 6,400
#define SCREEN_IMAGE_FILE_BYTES (SCREEN_IMAGE_HEADER + SCREEN_IMAGE_PAYLOAD)

// True when a stored image exists and passes the header and CRC checks. Read
// from the filesystem every time rather than cached, so a file that was
// replaced or interrupted cannot be reported from a stale answer. This is the
// question the BOOT tap cycle asks before it stops on the image mode.
bool screen_image_available(void);

// Draw the stored image. False when it does not validate, so the caller falls
// back to another mode rather than leaving a blank or half-written screen.
bool screen_image_draw(void);

// Validate an open file and leave it positioned at the first payload byte.
// Exported for the endpoint that serves the file back to the browser, so the
// page gets a file the device has already agreed is drawable.
bool screen_image_check(FILE *f);

// Incremental check of an upload while it is streamed to the filesystem, so a
// body is never committed unless it would draw. Feed every byte the request
// produced, in order; the header arrives first.
typedef struct {
    uint8_t  header[SCREEN_IMAGE_HEADER];
    size_t   header_len;    // header bytes seen so far
    uint32_t want_crc;      // CRC the header carries, once it has arrived
    uint32_t crc;           // CRC of the payload bytes seen so far
    size_t   payload_len;
    size_t   total;
    bool     bad;           // a check already failed: no point continuing
} screen_image_upload_t;

void screen_image_upload_begin(screen_image_upload_t *u);
void screen_image_upload_feed(screen_image_upload_t *u, const uint8_t *data, size_t len);

// True when the whole file arrived and the header, the length and the CRC all
// check out.
bool screen_image_upload_ok(const screen_image_upload_t *u);
