#include "ui_fs.h"

#include <dirent.h>
#include <errno.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_littlefs.h"
#include "esp_log.h"

static const char *TAG = "ui_fs";

#define UI_FS_MOUNT      "/ui"
#define UI_FS_PARTITION  "ui"
#define UI_FS_TMP_SUFFIX ".tmp"

// Longest name in the asset table is "settings.html". The directory scan
// below can also meet a longer name, up to the 255 a dirent holds, so paths
// are sized for that rather than for the table.
#define UI_FS_PATH_MAX   288

static bool s_mounted = false;

static void path_of(char *out, size_t outlen, const char *name) {
    snprintf(out, outlen, UI_FS_MOUNT "/%s", name);
}

static void tmp_path_of(char *out, size_t outlen, const char *name) {
    snprintf(out, outlen, UI_FS_MOUNT "/%s" UI_FS_TMP_SUFFIX, name);
}

// A reset during an upload leaves its temp file behind. It is never served -
// no asset maps to a ".tmp" name - but it would hold space for ever.
static void remove_stale_temps(void) {
    DIR *d = opendir(UI_FS_MOUNT);
    if (!d) return;

    const size_t suffix = strlen(UI_FS_TMP_SUFFIX);
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        const size_t n = strlen(e->d_name);
        if (n <= suffix || strcmp(e->d_name + n - suffix, UI_FS_TMP_SUFFIX) != 0) continue;

        char path[UI_FS_PATH_MAX];
        snprintf(path, sizeof(path), UI_FS_MOUNT "/%s", e->d_name);
        if (unlink(path) == 0) ESP_LOGW(TAG, "removed interrupted upload %s", e->d_name);
    }
    closedir(d);
}

esp_err_t ui_fs_init(void) {
    const esp_vfs_littlefs_conf_t conf = {
        .base_path = UI_FS_MOUNT,
        .partition_label = UI_FS_PARTITION,
        // A freshly flashed partition holds no filesystem, and a corrupt one
        // holds nothing worth keeping. Formatting on the way up is what makes
        // uploads work without a manual format step; the embedded assets mean
        // this is never on the critical path.
        .format_if_mount_failed = true,
    };

    esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "no filesystem on '%s' (%s) - serving the embedded UI",
                 UI_FS_PARTITION, esp_err_to_name(err));
        return err;
    }
    s_mounted = true;

    size_t total = 0, used = 0;
    if (esp_littlefs_info(UI_FS_PARTITION, &total, &used) == ESP_OK) {
        ESP_LOGI(TAG, "ui filesystem mounted, %u of %u bytes used",
                 (unsigned)used, (unsigned)total);
    }

    remove_stale_temps();
    return ESP_OK;
}

bool ui_fs_mounted(void) {
    return s_mounted;
}

size_t ui_fs_size(const char *name) {
    if (!s_mounted) return 0;

    char path[UI_FS_PATH_MAX];
    path_of(path, sizeof(path), name);

    struct stat st;
    if (stat(path, &st) != 0 || st.st_size <= 0) return 0;
    return (size_t)st.st_size;
}

FILE *ui_fs_open(const char *name) {
    if (ui_fs_size(name) == 0) return NULL;

    char path[UI_FS_PATH_MAX];
    path_of(path, sizeof(path), name);
    return fopen(path, "rb");
}

FILE *ui_fs_open_temp(const char *name) {
    if (!s_mounted) return NULL;

    char path[UI_FS_PATH_MAX];
    tmp_path_of(path, sizeof(path), name);
    return fopen(path, "wb");
}

esp_err_t ui_fs_commit(const char *name, FILE *f) {
    char tmp[UI_FS_PATH_MAX];
    tmp_path_of(tmp, sizeof(tmp), name);

    // Close before renaming: a rename that lands while the last block is still
    // in a stdio buffer would publish a truncated file.
    if (fclose(f) != 0) {
        ESP_LOGE(TAG, "%s: close failed", tmp);
        unlink(tmp);
        return ESP_FAIL;
    }

    char path[UI_FS_PATH_MAX];
    path_of(path, sizeof(path), name);
    if (rename(tmp, path) != 0) {
        ESP_LOGE(TAG, "rename %s failed: %d", tmp, errno);
        unlink(tmp);
        return ESP_FAIL;
    }
    return ESP_OK;
}

void ui_fs_discard(const char *name, FILE *f) {
    if (f) fclose(f);

    char tmp[UI_FS_PATH_MAX];
    tmp_path_of(tmp, sizeof(tmp), name);
    unlink(tmp);
}

esp_err_t ui_fs_remove(const char *name) {
    if (!s_mounted) return ESP_OK;   // nothing can have been stored

    char path[UI_FS_PATH_MAX];
    path_of(path, sizeof(path), name);
    if (unlink(path) != 0 && errno != ENOENT) {
        ESP_LOGE(TAG, "unlink %s failed: %d", path, errno);
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t ui_fs_usage(size_t *total, size_t *used) {
    if (!s_mounted) return ESP_ERR_INVALID_STATE;
    return esp_littlefs_info(UI_FS_PARTITION, total, used);
}
