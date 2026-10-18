#include "usb_hid.h"

#include "tinyusb.h"
#include "class/hid/hid_device.h"
#include "esp_log.h"

static const char *TAG = "usb_hid";

// Report IDs (must match the report descriptor)
#define HID_RID_KEYBOARD  1
#define HID_RID_MOUSE     2
#define HID_RID_CONSUMER  3

// 1 configuration, 1 interface, 0 string, total len, attr, 100mA
#define TUSB_DESC_TOTAL_LEN  (TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN)

// ---- Report descriptor: Keyboard + Mouse + Consumer Control ----
static const uint8_t hid_report_descriptor[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(HID_RID_KEYBOARD)),
    TUD_HID_REPORT_DESC_MOUSE(HID_REPORT_ID(HID_RID_MOUSE)),
    TUD_HID_REPORT_DESC_CONSUMER(HID_REPORT_ID(HID_RID_CONSUMER)),
};

static const char *hid_string_descriptor[5] = {
    (char[]){0x09, 0x04},   // 0: language (English, 0x0409)
    "ESP32",                // 1: manufacturer
    "ESP32 Remote",         // 2: product
    "0001",                 // 3: serial
    "ESP32 Remote HID",     // 4: interface
};

static const uint8_t hid_configuration_descriptor[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    // Interface 0, string idx 4, no boot protocol, report desc len, EP 0x81, 16 bytes, 1 ms poll
    TUD_HID_DESCRIPTOR(0, 4, false, sizeof(hid_report_descriptor), 0x81, 16, 1),
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
}

// ---- Public API ----

void usb_hid_init(void) {
    ESP_LOGI(TAG, "Installing TinyUSB composite HID");

    const tinyusb_config_t tusb_cfg = {
        .device_descriptor        = NULL,   // use default
        .string_descriptor        = hid_string_descriptor,
        .string_descriptor_count  = sizeof(hid_string_descriptor) / sizeof(hid_string_descriptor[0]),
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
