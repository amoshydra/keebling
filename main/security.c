#include "security.h"

#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "bootloader_random.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include <ctype.h>
#include <string.h>

static const char *TAG = "security";

static const char *NVS_NAMESPACE = "esp32remote";
static const char *NVS_KEY_CODE  = "code";

// Crockford Base32: digits + A-Z with I, L, O and U removed.
// Exactly 32 symbols => 5 bits each => 12 chars = 60 bits.
// Chosen because it has no visually ambiguous pairs (no 0/O, no 1/I/L).
static const char B32[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Per-source throttle. Small fixed table; entries are recycled round-robin,
// which is fine because this is a speed bump, not a security boundary.
#define LOCK_SLOTS       8
#define LOCK_THRESHOLD   8      // consecutive misses before throttling
#define LOCK_MS          30000

typedef struct {
    uint32_t ip;         // 0 == free slot
    int      fails;
    int64_t  until_ms;
} lock_slot_t;

static char s_code[SECURITY_CODE_LEN + 1];
static SemaphoreHandle_t s_lock;
static lock_slot_t s_slots[LOCK_SLOTS];
static unsigned s_next_slot;

static inline int64_t now_ms(void) {
    return esp_timer_get_time() / 1000;
}

// Compare without an early exit, so timing does not leak how much matched.
static bool consteq(const char *a, const char *b, size_t n) {
    unsigned char diff = 0;
    for (size_t i = 0; i < n; i++) {
        diff |= (unsigned char)a[i] ^ (unsigned char)b[i];
    }
    return diff == 0;
}

// Uppercase and drop separators so "k7m2-9qxf-3bhv" matches "K7M29QXF3BHV".
static size_t normalise(const char *in, char *out, size_t outlen) {
    size_t n = 0;
    for (const char *p = in; *p && n < outlen; p++) {
        if (*p == '-' || *p == ' ') continue;
        out[n++] = (char)toupper((unsigned char)*p);
    }
    if (n < outlen) out[n] = '\0';
    return n;
}

static void generate_code(char *out) {
    // esp_random() only produces true random numbers while the RF subsystem is
    // running. We generate the code *before* WiFi starts, so the raw output
    // would be seeded but not continuously re-entropicised. ESP-IDF provides
    // bootloader_random_enable() for exactly this case ("true random numbers
    // ... without initialized RF subsystem"): it mixes SAR ADC noise into the
    // HWRNG. It must be turned off again before WiFi/ADC/I2S are initialised.
    bootloader_random_enable();

    for (int i = 0; i < SECURITY_CODE_LEN; i++) {
        // Each esp_random() call is uniform over 32 bits, so % 32 is uniform
        // over the 32-symbol alphabet with no modulo bias.
        out[i] = B32[esp_random() % 32];
    }
    out[SECURITY_CODE_LEN] = '\0';

    bootloader_random_disable();
}

void security_init(void) {
    s_lock = xSemaphoreCreateMutex();

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        // Cannot persist: generate a volatile code so the device still works.
        generate_code(s_code);
        ESP_LOGE(TAG, "nvs_open failed (%s) - using a NON-PERSISTENT code", esp_err_to_name(err));
        return;
    }

    size_t len = sizeof(s_code);
    err = nvs_get_str(h, NVS_KEY_CODE, s_code, &len);
    if (err == ESP_OK && strlen(s_code) == SECURITY_CODE_LEN) {
        ESP_LOGI(TAG, "Loaded existing device code");
        nvs_close(h);
        return;
    }

    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGW(TAG, "nvs_get_str: %s - regenerating", esp_err_to_name(err));
    }

    generate_code(s_code);
    err = nvs_set_str(h, NVS_KEY_CODE, s_code);
    if (err == ESP_OK) err = nvs_commit(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "failed to persist device code: %s", esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "Generated a new device code");
    }
    nvs_close(h);
}

const char *security_code(void) {
    return s_code;
}

bool security_check_token(const char *token) {
    if (!token) return false;

    char norm[SECURITY_CODE_LEN + 1];
    size_t n = normalise(token, norm, sizeof(norm));
    if (n != SECURITY_CODE_LEN) return false;

    return consteq(norm, s_code, SECURITY_CODE_LEN);
}

bool security_ip_locked(uint32_t ip) {
    if (!s_lock || ip == 0) return false;

    bool locked = false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int i = 0; i < LOCK_SLOTS; i++) {
        if (s_slots[i].ip == ip && now_ms() < s_slots[i].until_ms) {
            locked = true;
            break;
        }
    }
    xSemaphoreGive(s_lock);
    return locked;
}

void security_note_ip_result(uint32_t ip, bool ok) {
    if (!s_lock || ip == 0) return;

    xSemaphoreTake(s_lock, portMAX_DELAY);

    int slot = -1;
    for (int i = 0; i < LOCK_SLOTS; i++) {
        if (s_slots[i].ip == ip) { slot = i; break; }
        if (slot < 0 && s_slots[i].ip == 0) slot = i;
    }
    if (slot < 0) {
        slot = (int)(s_next_slot++ % LOCK_SLOTS);   // recycle
        s_slots[slot].ip = ip;
        s_slots[slot].fails = 0;
        s_slots[slot].until_ms = 0;
    }

    if (ok) {
        s_slots[slot].fails = 0;
        s_slots[slot].until_ms = 0;
    } else if (++s_slots[slot].fails >= LOCK_THRESHOLD) {
        s_slots[slot].fails = 0;
        s_slots[slot].until_ms = now_ms() + LOCK_MS;
        ESP_LOGW(TAG, "Throttling a source after %d bad tokens (%d s)",
                 LOCK_THRESHOLD, LOCK_MS / 1000);
    }

    xSemaphoreGive(s_lock);
}
