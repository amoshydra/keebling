# The firmware embeds the built UI, so a missing build is a confusing link
# failure rather than a clear one. Say what to run instead.
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/web/dist/app.js")
    message(FATAL_ERROR
        "The web UI has not been built. Run `pnpm install && pnpm build` first.")
endif()

idf_component_register(
    SRCS
        "main.c"
        "usb_hid.c"
        "web_server.c"
        "display.c"
        "input_state.c"
        "security.c"
        "settings.c"
        "wifi_manager.c"
        "log_buffer.c"
        "ui_fs.c"
        "screen_image.c"
        "qr_payload.c"
        "bsp/esp_lcd_st7735.c"
        "qr/qrcodegen.c"
    INCLUDE_DIRS "."
    # The built UI, not the sources: run `pnpm build` first. main/web/dist holds
    # one bundled script, the stylesheet, the shell, the editor and the repair
    # page.
    EMBED_FILES
        "web/dist/index.html"
        "web/dist/style.css"
        "web/dist/app.js"
        "web/dist/editor.html"
        "web/dist/recover.html"
        "web/dist/manifest.webmanifest"
        "web/dist/icon-192.png"
        "web/dist/icon-512.png"
        "web/dist/icon-180.png"
)
