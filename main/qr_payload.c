#include "qr_payload.h"

#include <stdio.h>

#include "web_server.h"   // AP_SSID

// An address counts only when it is actually set. The WiFi manager reports ""
// while it has none, and a caller could in principle pass NULL.
static bool have_ip(const char *ip) {
    return ip && ip[0];
}

bool qr_payload_is_url(const char *sta_ip, const char *ap_ip, int client_count) {
    if (have_ip(sta_ip)) return true;
    return client_count > 0 && have_ip(ap_ip);
}

void qr_payload_build(char *out, size_t len,
                      const char *sta_ip, const char *ap_ip,
                      int client_count, const char *code) {
    if (have_ip(sta_ip)) {
        snprintf(out, len, "http://%s/?token=%s", sta_ip, code);
        return;
    }
    if (client_count > 0 && have_ip(ap_ip)) {
        snprintf(out, len, "http://%s/?token=%s", ap_ip, code);
        return;
    }

    snprintf(out, len, "WIFI:T:WPA;S:%s;P:%s;;", AP_SSID, code);
}
