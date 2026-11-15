#include "web_origin.h"

#include <stddef.h>
#include <string.h>

// The published UI is a fixed origin, so the answer can be a literal. It has to
// be: httpd_resp_set_hdr stores the value pointer rather than copying it.
static const char *const APP_ORIGINS[] = { WEB_APP_ORIGIN, WEB_APP_ORIGIN_DEV };

const char *web_app_origin(const char *origin) {
    if (!origin) return NULL;
    for (size_t i = 0; i < sizeof(APP_ORIGINS) / sizeof(APP_ORIGINS[0]); i++) {
        if (APP_ORIGINS[i][0] && strcasecmp(origin, APP_ORIGINS[i]) == 0) {
            return APP_ORIGINS[i];
        }
    }
    return NULL;
}
