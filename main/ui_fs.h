// The LittleFS partition holding uploaded UI files.
//
// Every call is safe when the filesystem is absent: reads report "nothing
// stored" and writes fail, so the embedded assets in the firmware stay in
// charge. Names never come from a request: every caller passes a compile-time
// constant - the asset table for the web files, SCREEN_IMAGE_NAME for the
// screen image - so there is nothing here to turn into a path injection.

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

#include "esp_err.h"

// Mounts the "ui" partition, formatting it when it does not hold a filesystem
// yet. Returns an error when there is nothing usable to mount; the caller
// keeps serving the embedded copies.
esp_err_t ui_fs_init(void);

bool ui_fs_mounted(void);

// Bytes stored under `name`, or 0 when it is absent. A zero-length file counts
// as absent: an interrupted or empty upload must not shadow the embedded copy.
size_t ui_fs_size(const char *name);

// Open for reading, or NULL when there is nothing to serve. The caller streams
// and closes it.
FILE *ui_fs_open(const char *name);

// Uploads are written to "<name>.tmp" and renamed over the real name only once
// complete, so a half-finished transfer is never served. Both of these take
// ownership of the stream; a failed commit removes the temp file too.
FILE *ui_fs_open_temp(const char *name);
esp_err_t ui_fs_commit(const char *name, FILE *f);
void ui_fs_discard(const char *name, FILE *f);

// Deletes the stored copy, so the embedded one is served again. Succeeds when
// there was nothing stored.
esp_err_t ui_fs_remove(const char *name);

// Deletes every stored file whose name is not in `keep`. The firmware decides
// which names exist, so a file left behind by an older build is dead weight -
// and on a 320 KB partition, dead weight is what stops the next upload fitting.
// Names still come from the caller's table, never from the directory.
esp_err_t ui_fs_prune(const char *const *keep, size_t count);

// Partition usage, for the upload page. Fails when not mounted.
esp_err_t ui_fs_usage(size_t *total, size_t *used);
