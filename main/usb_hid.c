#include "usb_hid.h"
#include "input_state.h"
#include "settings.h"

#include "tinyusb.h"
#include "class/hid/hid_device.h"
#include "esp_log.h"
#include "esp_mac.h"

static const char *TAG = "usb_hid";

// Report IDs (must match the report descriptor)
#define HID_RID_KEYBOARD  1
#define HID_RID_MOUSE     2
#define HID_RID_CONSUMER  3

// HID interface parameters. Named constants so the diagnostics endpoint can
// report exactly what goes into the configuration descriptor.
#define HID_EP_IN        0x81
#define HID_EP_SIZE      16
#define HID_POLL_MS      1

// 1 configuration, 1 interface, 0 string, total len, attr, 100mA
#define TUSB_DESC_TOTAL_LEN  (TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN)

// ---- Report descriptor: Keyboard + Mouse + Consumer Control ----
static const uint8_t hid_report_descriptor[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(HID_RID_KEYBOARD)),
    TUD_HID_REPORT_DESC_MOUSE(HID_REPORT_ID(HID_RID_MOUSE)),
    TUD_HID_REPORT_DESC_CONSUMER(HID_REPORT_ID(HID_RID_CONSUMER)),
};

// String descriptors. Index 2 is the USB product name - the "HID name" the
// host displays - and it is filled in at init from the settings blob.
//
// These must be mutable at the pointer level (the array itself is not const),
// because esp_tinyusb copies the pointer array during driver install; there is
// no public setter to change one afterwards.
static const char s_lang[2] = {0x09, 0x04};   // English (0x0409)
static char s_product[SETTINGS_HID_NAME_MAX + 1] = "ESP32 Remote";
static char s_manufacturer[SETTINGS_HID_NAME_MAX + 1] = "ESP32";
// Interface label. Most single-interface keyboards omit this (index 0) because
// the class code already says what it is; devices with several HID interfaces
// name each one so the host can tell them apart. Ours is one interface
// carrying three collections, so it is named after the set.
static char s_interface[SETTINGS_HID_NAME_MAX + 1] = "Keyboard Mouse Media";
// Serial number. Derived from the chip's MAC so each unit is unique - the
// example's hardcoded "0001" would make two dongles indistinguishable, and
// hosts key per-device permissions and rules on this string. Overridable.
static char s_serial[SETTINGS_HID_NAME_MAX + 1];
static const char *s_strings[5] = {
    s_lang,           // 0: language
    s_manufacturer,   // 1: manufacturer (runtime)
    s_product,        // 2: product (runtime) - the name the host displays
    s_serial,         // 3: serial (runtime)
    s_interface,      // 4: interface (runtime)
};

static const uint8_t hid_configuration_descriptor[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    // Interface 0, string idx 4, no boot protocol, report desc len, EP, size, poll
    TUD_HID_DESCRIPTOR(0, 4, false, sizeof(hid_report_descriptor),
                       HID_EP_IN, HID_EP_SIZE, HID_POLL_MS),
};

// ---- TinyUSB callbacks (all four are REQUIRED) ----

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance) {
    (void)instance;
    return hid_report_descriptor;
}

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id,
                               hid_report_type_t report_type, uint8_t *buffer,
                               uint16_t reqlen) {
    (void)instance; (void)report_id; (void)report_type; (void)buffer; (void)reqlen;
    return 0;
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id,
                           hid_report_type_t report_type, uint8_t const *buffer,
                           uint16_t bufsize) {
    (void)instance; (void)report_id; (void)report_type; (void)buffer; (void)bufsize;
}

void tud_hid_report_complete_cb(uint8_t instance, uint8_t const *report, uint16_t len) {
    (void)instance; (void)report; (void)len;
    // A report has just gone out, so the endpoint is free: this is the moment to
    // retry anything an earlier send could not deliver.
    input_hid_flush();
}

// ---- Public API ----

// The product and manufacturer strings are byte-copied string descriptors:
// only ASCII survives, and the driver caps them at MAX_DESC_BUF_SIZE-1
// characters. Substitute anything else here rather than let it be mangled.
static void load_string_setting(const char *key,
                                char *dest, size_t destlen, const char *what) {
    char buf[SETTINGS_HID_NAME_MAX + 1];
    if (!settings_get_str(key, buf, sizeof(buf))) return;

    for (char *p = buf; *p; p++) {
        if ((unsigned char)*p < 0x20 || (unsigned char)*p > 0x7E) *p = '?';
    }
    snprintf(dest, destlen, "%s", buf);
    ESP_LOGI(TAG, "USB %s: \"%s\"", what, dest);
}

void usb_hid_init(void) {
    // Serial first: the MAC-derived form uses the same notation the chip's ROM
    // download mode reports, so the two agree.
    uint8_t mac[6];
    esp_efuse_mac_get_default(mac);
    snprintf(s_serial, sizeof(s_serial), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    char override[SETTINGS_HID_NAME_MAX + 1];
    if (settings_get_str("usb_serial", override, sizeof(override))) {
        for (char *p = override; *p; p++) {
            if ((unsigned char)*p < 0x20 || (unsigned char)*p > 0x7E) *p = '?';
        }
        snprintf(s_serial, sizeof(s_serial), "%s", override);
    }
    ESP_LOGI(TAG, "USB serial: %s", s_serial);

    load_string_setting("usb_manufacturer", s_manufacturer,
                        sizeof(s_manufacturer), "manufacturer");
    load_string_setting("usb_product", s_product, sizeof(s_product), "product name");
    load_string_setting("usb_interface", s_interface,
                        sizeof(s_interface), "interface label");

    ESP_LOGI(TAG, "Installing TinyUSB composite HID");

    const tinyusb_config_t tusb_cfg = {
        .device_descriptor        = NULL,   // use default
        .string_descriptor        = s_strings,
        .string_descriptor_count  = sizeof(s_strings) / sizeof(s_strings[0]),
        .external_phy             = false,
#if (TUD_OPT_HIGH_SPEED)
        .fs_configuration_descriptor = hid_configuration_descriptor,
        .hs_configuration_descriptor = hid_configuration_descriptor,
        .qualifier_descriptor        = NULL,
#else
        .configuration_descriptor = hid_configuration_descriptor,
#endif
    };

    ESP_ERROR_CHECK(tinyusb_driver_install(&tusb_cfg));
    ESP_LOGI(TAG, "TinyUSB installed");
}

bool usb_hid_mounted(void) {
    return tud_mounted();
}

bool usb_hid_ready(void) {
    return tud_hid_ready();
}

bool usb_hid_keyboard_report(uint8_t mod, const uint8_t keys[6]) {
    if (!tud_mounted()) return false;
    return tud_hid_keyboard_report(HID_RID_KEYBOARD, mod, keys);
}

bool usb_hid_mouse_report(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel) {
    if (!tud_mounted()) return false;
    // (report_id, buttons, x, y, vertical, horizontal)
    return tud_hid_mouse_report(HID_RID_MOUSE, buttons, dx, dy, wheel, 0);
}

bool usb_hid_consumer_report(uint16_t usage) {
    if (!tud_mounted()) return false;
    // No dedicated helper exists in TinyUSB; use the generic report API.
    uint8_t report[2] = { (uint8_t)(usage & 0xFF), (uint8_t)(usage >> 8) };
    return tud_hid_report(HID_RID_CONSUMER, report, sizeof(report));
}

// ---- Diagnostics ----

const uint8_t *usb_hid_report_descriptor(size_t *len) {
    if (len) *len = sizeof(hid_report_descriptor);
    return hid_report_descriptor;
}

int usb_hid_endpoint_size(void) { return HID_EP_SIZE; }
int usb_hid_poll_interval_ms(void) { return HID_POLL_MS; }
const char *usb_hid_product_name(void) { return s_product; }

// String descriptors by index, for the diagnostics endpoint. Index 3 (serial)
// is derived from the eFuse MAC at init, so units stay distinguishable.
const char *usb_hid_string(int index) {
    if (index < 0 || index >= (int)(sizeof(s_strings) / sizeof(s_strings[0]))) return "";
    if (index == 0) return "";             // language ID is not a C string
    return s_strings[index];
}
