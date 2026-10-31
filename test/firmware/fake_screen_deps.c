// The draw path in screen_image.c needs the panel and the UI filesystem, which
// are out of reach on the host. These tests cover the format checks instead;
// neither symbol is called by them.
#include <stdio.h>

#include "display.h"
#include "ui_fs.h"

bool display_grey4(FILE *f) {
    (void)f;
    return false;
}

bool display_rgb565(FILE *f) {
    (void)f;
    return false;
}

FILE *ui_fs_open(const char *name) {
    (void)name;
    return NULL;
}
