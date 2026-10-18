# ESP32 Remote — USB HID bridge controlled from a browser

Plug the ESP32-S3 dongle into a host machine. It enumerates as a **USB keyboard +
mouse + media keys**. A browser connects to the ESP's WiFi access point and becomes
the input surface — whatever you do in the browser is replayed into the host as real
USB HID input.

```
  Browser ──── WebSocket over WiFi ────► ESP32-S3 ──── USB OTG ────► Host
 (phone/laptop)      (SoftAP)             (bridge)    (TinyUSB)    (Mac/Linux/…)
```

The point of the hardware: **zero software on the target machine.** It works at the
login screen, in recovery mode, in a BIOS, on a machine whose own keyboard is broken.

## Hardware

| | |
|---|---|
| Board | LILYGO T-Dongle-S3 (ESP32-S3, 16 MB flash, no PSRAM) |
| Display | ST7735 160×80 landscape, SPI |
| Connector | USB Type-A male — needs a USB-A→USB-C adapter for a USB-C-only host |
| Panic button | BOOT (GPIO0) — hold to release every held key/button |

### T-Dongle-S3 hardware notes

These cost us real debugging time; they are not obvious from the ST7735 datasheet:

- **The LCD backlight (GPIO38) is active LOW**, and it is PWM'd via LEDC.
- The panel runs **landscape 160×80**, needing `swap_xy`, `mirror(false, true)` and `gap(1, 26)`.
- It needs **`INVON`**, not `INVOFF`, plus panel-specific power/gamma tables.
- Pins: `MOSI=3 CLK=5 CS=4 DC=2 RST=1 BL=38`.

Because of the above, `main/bsp/esp_lcd_st7735.c` is **LILYGO's own driver**, vendored
from their official repo rather than reimplemented from the datasheet.


## Build

```bash
. ~/esp/esp-idf/export.sh          # ESP-IDF v5.3.2
cd esp32-remote
idf.py set-target esp32s3          # first time only
idf.py build
idf.py -p /dev/ttyACM0 flash
```

`esp_tinyusb` is fetched from the ESP Component Registry on the first build.

If `flash` fails to connect: hold **BOOT**, start the flash, release BOOT once
"Connecting…" appears.

## Use

1. Flash, unplug, plug back in **without** holding BOOT.
2. Join WiFi **`esp-remote`** (password `esp32remote`).
3. Open **http://192.168.4.1**.
4. Click/tap the pad to capture the pointer. Your mouse now drives the host.
   **Esc** releases.

## Safety model

A USB HID device that gets stuck holding a modifier is genuinely unpleasant, so
there are three independent release paths:

1. **Heartbeat watchdog.** The browser pings every second. If the pings stop for
   5 s *while something is held down*, the firmware releases everything.
2. **Disconnect release.** When the WiFi client disconnects, everything is released.
3. **Physical panic button.** Hold BOOT (GPIO0) at any time.

Mouse movement never arms the watchdog — only keys, modifiers and mouse buttons do,
so an idle-but-connected session is never interrupted.

## Wire protocol

Browser → ESP, binary WebSocket frames:

| Byte 0 | Payload | Meaning |
|---|---|---|
| `0x01` | `dx, dy, buttons, wheel` (int8 ×4) | mouse report |
| `0x02` | `mod, kc0..kc5` (uint8 ×7) | full keyboard snapshot |
| `0x03` | `usage_lo, usage_hi` | consumer/media control |
| `0x04` | — | heartbeat |
| `0x05` | — | release everything |

`0x02` sends the **complete set of currently-held keys**, not a delta. USB HID reports
are snapshots of current state, so this maps 1:1 onto the hardware with no queue.

## Layout

```
main/
  main.c          app entry, BOOT panic button, watchdog task
  usb_hid.c/.h    TinyUSB composite HID (keyboard + mouse + consumer)
  input_state.c/.h held-state tracking, mutex, release/watchdog logic
  web_server.c/.h SoftAP + HTTP + WebSocket, embedded assets
  display.c/.h    ST7735 driver, 80×160 framebuffer, 5×7 font (non-fatal)
  web/            index.html + app.js (embedded into the binary)
partitions.csv    4 MB app partition
sdkconfig.defaults
```

## Reflashing

Normally: **hold BOOT → plug in → `idf.py flash`**. Reset over the ESP32-S3's
USB-JTAG-Serial peripheral always lands the chip in download mode, so a plain
power cycle is what actually boots the app afterwards.

To avoid the BOOT-button dance entirely, the running firmware exposes a
**`POST /bootloader`** endpoint (and a *Bootloader* button in the web UI) which
sets `RTC_CNTL_FORCE_DOWNLOAD_BOOT` and resets. The flag lives in an RTC
register, so it survives a soft reset but not a power cycle — unplugging is
always a safe escape.

## Reference

| Task | Command |
|---|---|
| Build | `idf.py build` |
| Flash (download mode) | `idf.py -p /dev/ttyACM0 flash` |
| Reboot to download mode | `curl -X POST http://192.168.4.1/bootloader` |
| Recover from bad firmware | unplug → hold BOOT → replug → flash |

## Notes / limitations

- **macOS pointer acceleration** applies to any relative HID mouse. The gain slider
  compensates; for exact 1:1 you'd need a helper app posting `CGEvent`s.
- **No serial console over USB** while TinyUSB owns the port. `ESP_LOGI` output goes
  to UART0 on GPIO43/44 (the QWIIC connector) and needs an external USB-UART adapter.
  During development, route logging over WiFi instead.
- **Media keys**: the consumer-control report descriptor is present but Linux did not
  create an input device for it. Keyboard and mouse work. Under investigation.
- **BLE HID is not implemented** (USB only). The S3 supports both, but WiFi + BLE
  share one 2.4 GHz radio, so expect added jitter if you add it.
- The dongle draws up to ~800 mA with WiFi + backlight.
