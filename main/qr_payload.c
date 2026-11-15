#include "qr_payload.h"

#include <stdio.h>

#include "web_server.h"   // AP_SSID_PREFIX, WEB_APP_URL

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
                      const char *ap_ssid,
                      const char *sta_ip, const char *ap_ip,
                      int client_count, const char *code) {
    // On a real network the phone keeps its internet, so the useful hand-off is
    // the published app: it reads the fragment, stores this device, and boots
    // straight into it. The host goes in bare - the app prepends http:// itself
    // - which keeps seven characters out of a code that has to stay scannable.
    if (have_ip(sta_ip)) {
        snprintf(out, len, "%s#h=%s&t=%s", WEB_APP_URL, sta_ip, code);
        return;
    }
    // Only the access point is reachable. The phone is on that network, so it
    // has no internet and the published app cannot load (barring a cached
    // copy); the device's own UI is served from this address, so point there
    // and keep the code in the query the device UI already reads.
    if (client_count > 0 && have_ip(ap_ip)) {
        snprintf(out, len, "http://%s/?token=%s", ap_ip, code);
        return;
    }

    // The join payload names the access point exactly as it is advertised, so
    // several dongles in the room do not make the phone guess.
    snprintf(out, len, "WIFI:T:WPA;S:%s;P:%s;;",
             (ap_ssid && ap_ssid[0]) ? ap_ssid : AP_SSID_PREFIX, code);
}
