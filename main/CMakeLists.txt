idf_component_register(
    SRCS
        "main.c"
        "usb_hid.c"
        "web_server.c"
        "display.c"
        "input_state.c"
        "security.c"
        "wifi_manager.c"
        "log_buffer.c"
        "bsp/esp_lcd_st7735.c"
        "qr/qrcodegen.c"
    INCLUDE_DIRS "."
    EMBED_FILES
        "web/index.html"
        "web/app.js"
)
