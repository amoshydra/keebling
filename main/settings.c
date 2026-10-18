#include "settings.h"

#include "esp_log.h"
#include "cJSON.h"
#include "nvs.h"

#include <stdio.h>
#include <string.h>

static const char *TAG = "settings";

static const char *NVS_NAMESPACE = "esp32remote";
static const char *NVS_KEY       = "settings";

static char s_json[SETTINGS_MAX] = "{}";

void settings_init(void) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        ESP_LOGI(TAG, "no stored settings");
        return;
    }

    size_t n = sizeof(s_json);
    if (nvs_get_str(h, NVS_KEY, s_json, &n) != ESP_OK) {
        snprintf(s_json, sizeof(s_json), "{}");
    }
    nvs_close(h);

    ESP_LOGI(TAG, "%zu bytes of settings", strlen(s_json));
}

const char *settings_json(void) {
    return s_json;
}

esp_err_t settings_set_json(const char *json) {
    if (!json) return ESP_ERR_INVALID_ARG;
    if (strlen(json) >= sizeof(s_json)) return ESP_ERR_INVALID_SIZE;

    // Parse first: storing malformed JSON would only surface much later, when
    // something tried to read a key out of it.
    cJSON *doc = cJSON_Parse(json);
    if (!doc) return ESP_ERR_INVALID_ARG;
    cJSON_Delete(doc);

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;

    err = nvs_set_str(h, NVS_KEY, json);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);

    if (err == ESP_OK) {
        snprintf(s_json, sizeof(s_json), "%s", json);
        ESP_LOGI(TAG, "settings saved (%zu bytes)", strlen(json));
    } else {
        ESP_LOGE(TAG, "save failed: %s", esp_err_to_name(err));
    }
    return err;
}

bool settings_get_str(const char *key, char *out, size_t outlen) {
    if (!key || !out || outlen == 0) return false;
    out[0] = '\0';

    cJSON *doc = cJSON_Parse(s_json);
    if (!doc) return false;

    const cJSON *v = cJSON_GetObjectItem(doc, key);
    bool ok = cJSON_IsString(v) && v->valuestring && v->valuestring[0];
    if (ok) snprintf(out, outlen, "%s", v->valuestring);

    cJSON_Delete(doc);
    return ok;
}

int settings_get_int(const char *key, int def) {
    cJSON *doc = cJSON_Parse(s_json);
    if (!doc) return def;

    const cJSON *v = cJSON_GetObjectItem(doc, key);
    int out = def;
    if (cJSON_IsNumber(v)) out = v->valueint;

    cJSON_Delete(doc);
    return out;
}

