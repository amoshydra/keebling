# Keebling — USB HID bridge controlled from a browser

> A baby keyboard that lives in your USB port.

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

## Website

The landing page and brand sheet live in `site/`.

```bash
python3 -m http.server -d site 8080
```

Then open <http://localhost:8080/>. Pushes to `master` deploy that folder with
GitHub Actions (`.github/workflows/pages.yml`). The site is relative, so it also
works from `https://amoshydra.github.io/keebling/` once the repository is renamed
to `keebling`.

## Hardware

| | |
|---|---|
| Board | LILYGO T-Dongle-S3 (ESP32-S3, 16 MB flash, no PSRAM) |
| Display | ST7735 160×80 landscape, SPI |
| Connector | USB Type-A male — needs a USB-A→USB-C adapter for a USB-C-only host |
| Button | BOOT (GPIO0) — see *Button gestures* |

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
cd keebling
idf.py set-target esp32s3          # first time only
pnpm install                       # first time only: esbuild, html-minifier
pnpm build                         # bundles and minifies the UI into main/web/dist
idf.py build
idf.py -p /dev/ttyACM0 flash
```

The firmware embeds `main/web/dist`, never `main/web` itself, so **`pnpm build`
comes before `idf.py build`**. The build fails with that instruction if you
forget.

`esp_tinyusb` and `joltwallet/littlefs` are fetched from the ESP Component
Registry on the first build.

If `flash` fails to connect: hold **BOOT**, start the flash, release BOOT once
"Connecting…" appears.

### Working on the UI without flashing

The UI is embedded in the firmware, so changing `main/web` normally costs a
BOOT-replug-power-cycle round trip. For UI work there is a dev server:

```
node tools/dev-server.mjs --device 192.168.1.50
```

It serves `main/web/dist` from disk and proxies every other request — the REST
endpoints and the WebSocket — to the device. Run `pnpm build` once, or
`pnpm watch` in another terminal, so the bundle on disk matches what you are
editing. The browser sees one origin, so
there is no CORS to arrange and the saved access code still works. Open
`http://localhost:8080/?token=<code>`, edit a file, reload the page.

Only firmware changes need a flash; the UI does not.

## Use

The device prefers to **join your own network** (STA), so the phone or laptop
you drive it from never has to leave its own WiFi. If nothing is configured, or
the network can't be reached, it runs its own access point instead.

1. Power-cycle the board.
2. **Scan the QR on the LCD** with your phone — it carries the 12-character
   device code, and your phone will offer to copy it. The QR stays up for 20
   seconds, then the status screen takes over (power-cycle to see it again).
3. **Join the device.** Either:
   - **its own AP** — network `keebling`, password is the code, then browse
     to `http://192.168.4.1`; or
   - **your own network** — open **📶 Network**, scan, pick your SSID, enter the
     password, and save. The device restarts and joins it; the LCD then shows
     `STA: <ssid>` and its address.
4. Open the device's address and paste the code when prompted.
5. Tap the pad to capture the pointer. Your mouse and keyboard now drive the
   host — physical keys are forwarded only while the pad is captured.
   **Esc** releases both.

The code is remembered in `localStorage`, so step 4 is a one-time thing per
browser. You can also skip it entirely with
`http://<address>/?token=YOURCODE`.

### The four tabs

| Tab | What it is |
|---|---|
| **Remote** | the touchpad, full height, with `L` `M` `R` floating at the thumb |
| **Keys** | the same pad with a keyboard slot open: on-screen keyboard, media keys, or typed text |
| **Deck** | a grid of buttons you press — sequences, chords, pages of them |
| **Setup** | everything you configure, one section at a time |

**Release** sits in the status bar on every tab. It clears every held key and
button on the host, and it is deliberately not next to a button you press in a
hurry.

### Keys

**Keys** is the same pad with a slot open underneath it, and the slot holds one
of three things: the on-screen keyboard, the media keys, or a text box that is
typed into the host.

The on-screen keyboard has three pages — letters, symbols, and function keys
with the arrows — at ten keys a row. **Every key shows the character the host
will receive**, with what Shift would make of it above; when Shift is latched
the two swap, so the key in front of you is always the one that will be typed.
There is a `?` key that sends Shift and `/` together, because otherwise the
most common symbol costs two taps. Esc, Tab, Ctrl, Alt, Cmd and Fn sit on the
letter page: a chord should not need a page change first.

Below the keys, a small badge shows **CAPS LOCK** and **NUM LOCK** as the host
reports them, read from the USB LED output report. With no host attached there
is nothing to report and the badge stays hidden rather than claiming everything
is off.

**Built-in / Your keyboard** at the top of the slot switches to the phone's own
keyboard: the page focuses a hidden field and translates what the IME sends —
printable characters arrive as text, while arrows, Tab, Esc, Enter, Backspace,
F-keys and Ctrl chords arrive as real keys. What the page can and cannot get
from a phone keyboard is measured, not guessed: see
`docs/phone-keyboard.md`.

### Deck

**Deck** is a grid of buttons. Tapping one runs it; **Edit** switches the deck
into edit mode, where a tile opens the editor and shows its own Edit and Delete
actions. **Stop** in the run bar interrupts a sequence between characters and
releases everything.

A button is text typed into the host, with braced tokens for the keys that are
not characters — `{SEARCH}chrome{ENTER}` presses the Search media key, types
`chrome` and presses Enter.

Each button can carry one of five colours, and the deck can hold several
**pages** (the chip strip above the grid). A button marked **Run while held**
starts on press and stops on release: put `{REPEAT:n}` in it and it loops for
as long as your finger stays down, which is what a volume or scroll button
wants.

| Token | Meaning |
|---|---|
| `{ENTER}` `{TAB}` `{ESC}` `{BKSP}` `{DEL}` `{INS}` `{UP}` `{DOWN}` `{LEFT}` `{RIGHT}` `{HOME}` `{END}` `{PGUP}` `{PGDN}` `{SPACE}` `{F1}`…`{F12}` | a key press and release |
| `{CTRL+C}` `{CMD+SPACE}` `{CTRL+ALT+DEL}` | modifier combination — CTRL, SHIFT, ALT, CMD, then a key or a single character |
| `{PLAYPAUSE}` `{PLAY}` `{PAUSE}` `{NEXTTRACK}` `{PREVTRACK}` `{STOP}` `{VOLUMEUP}` `{VOLUMEDOWN}` `{MUTE}` `{SEARCH}` `{CALC}` `{BROWSERHOME}` `{BROWSERBACK}` `{BROWSERFORWARD}` | a Consumer Control usage, sent as a press/release pair |
| `{WAIT:500}` | pause for that many milliseconds (up to 60000) |
| `{REPEAT:3}` … `{/REPEAT}` | repeat the tokens between them; nests up to eight deep, counts 1–100, and the expansion is capped at 2000 steps |
| `{{` `}}` | a literal brace |

Anything outside braces is typed through the same US QWERTY mapping as the
Type panel, at the `type_speed` rate. Tokens are matched case-insensitively; an
unrecognised one is an error, not a skip — the page names it and refuses to run
the macro rather than typing part of it.

The deck is stored **in the browser**, under `localStorage`, not on the device.
They were in the settings blob once — capped at 1023 bytes shared with every
other setting, and wiped by a partition change — and moving them out trades
that for a browser's megabytes. What it costs is that they are per-browser: a
second phone does not see them, and clearing this site's data takes them. The
page says so rather than letting it be discovered.

A list left on the device by an older build is adopted on first load and then
removed from the device, so a list that was there yesterday does not look lost.
If the browser refuses the write — private mode, or a full origin — the page
says so instead of showing a list that was never stored.

### Updating the web UI

The pages are built into the firmware, but the device also carries a 320 KB
LittleFS partition that is served in preference to them. Setup →
**Web UI files** lists every file, says whether the device is serving the
built-in copy or one that was uploaded, and offers **Upload…** and **Reset to
built-in** per file. Changes are live on the next page load — no restart and no
reflash, which matters because flashing this board means BOOT, replug and a
power cycle.

The unit of upload is the whole UI, not a file: `pnpm build` writes
`main/web/dist/web.zip` and the device unpacks it in one pass. That matters
because the UI is a bundle — an `index.html` from one build loading an `app.js`
from another is the failure that leaves a blank page with no way back. Every
entry is written to `<name>.tmp` and renamed only after the whole archive has
arrived, so an interrupted upload leaves the previous UI serving, and a
zero-length file is never served: the built-in copy is the floor.

An upload is not limited to the firmware's own file names: any flat name
(`[A-Za-z0-9._-]`, no directories) is stored and served, with a content type
taken from its extension, so a UI built by any bundler can be uploaded as long
as it emits flat files. Two names are reserved: `recover.html`, which must come
from the firmware, and the `.tmp` suffix the writer owns.

An upload replaces the built-in copy until it is reset, so a bad *build* can
break the UI — but not permanently: `/recover.html` is served by the firmware
itself and deletes the stored copies. Uploads are token-gated, names are
matched against the asset table rather than used to build a path, and the
archive is capped at 192 KB with 96 KB per entry.

### Custom screen image

Setup → **Screen** → **Choose image…** puts a picture on the LCD as a
fourth BOOT screen. The preview shows the dithered 160×80 copy the device will
actually draw, not the original file.

The browser does the whole conversion: scale to 160×80 (filled and centre
cropped), luminance, 4-bit quantise with a Bayer 4×4 ordered dither, two pixels
per byte, plus an 8-byte header (format, length, CRC-32). The device has no PNG
or JPEG decoder and needs none — it validates the header and CRC, then expands
nibbles through a 16-entry RGB565 LUT straight into the framebuffer, 80 bytes
per row, so the image is never held in RAM.

It is stored as `screen.img` on the same LittleFS partition as the uploaded web
files, but it is not a web file: it has its own endpoints and a fixed name in
the firmware. The BOOT cycle only offers the screen while a valid image is
stored, and an upload the device refuses leaves the previous image in place.

Two things to expect, because the panel will not tell you otherwise: it does no
gamma correction, so mid-greys look flat; and the copy is 4-bit greyscale, so a
colour photo is converted rather than reproduced.

### Button gestures

The single BOOT button carries four things, separated by how long it is held
so the destructive action needs the longest press and cannot be triggered by
fumbling:

| Gesture | Action |
|---|---|
| tap (<600 ms) | wake the screen, or cycle the display mode if already awake |
| hold 3 s | release every held key and button (the panic) |
| hold 10 s | forget the saved network and restart in AP mode |

A release between 600 ms and 3 s deliberately does nothing.

The display sleeps after the configured idle time (60 s by default, settable
in settings, 0 disables). Sleeping blanks the pixels as well as the backlight —
the panel keeps its memory and the case is transparent, so darkening the
backlight alone would still leave the text readable in ambient light. Waking
does not change the mode.

A tap cycles the pairing QR, the status screen, and — when there is something
for them to show — a user text screen and a custom image. The text screen is 26
columns by 10 lines of the 5x7 font: lines wrap at a space where one fits, `\n`
starts a new line, and anything past the tenth line is dropped with the last
line ending in `...`. It is drawn from the `screen_text` setting every time the
screen is drawn, so a wake-up cannot show a stale copy. The image screen is
drawn from `screen.img` on the device's filesystem and is skipped unless the
file's header and CRC validate. Neither screen carries the device code —
another tap brings the QR back — and a device with no text or no valid image
never shows those screens.

### Network states

| State | SoftAP | STA |
|---|---|---|
| Nothing configured | on | — |
| Provisioned and reachable | **off** | joined |
| Unreachable for 20 s | **on** (recovery) | retrying |

Provisioned devices start **STA-only** — never switching modes afterwards.
`esp_wifi_set_mode()` restarts the whole WiFi stack, which drops every
connection and can cost the DHCP lease, so turning the SoftAP off "once the
link is healthy" is not safe. The SoftAP is only ever brought *up*.

**If you get locked out:** hold **BOOT for 10 seconds** while powered. That
wipes the saved network and restarts in AP mode. It can't be a power-on
gesture, because holding BOOT during power-on triggers the ROM's download
mode instead.

### Choosing a network

Storing credentials puts the WiFi password in flash, unencrypted. Use a
**dedicated SSID** whose password you don't mind storing — not the one that
protects your laptop and NAS. NVS encryption is possible but needs an eFuse key
burn, which is permanent, so it's a deliberate separate decision.

### What the QR carries

It changes with state, because what is useful changes.

**The device has no usable address** — that is, access-point only with nobody on
it — so the only way in is to join the network. The standard Wi-Fi join payload:

```
WIFI:T:WPA;S:keebling;P:<code>;;
```

A phone camera understands that, so joining the access point no longer means
typing a twelve-character password.

**The device has an address** — associated to a network, or with a client on its
own access point — so the URL for that address, with the code already in it:

```
http://<address>/?token=<code>
```

so scanning it opens the page authenticated.

The earlier design encoded only the bare code, and argued against a URL because
the address is the part that moves. That is why the URL appears only once the
device actually has one: it is read at draw time, so it cannot be stale, and the
join payload covers the case where there is nothing to point at.

The cost is module size. 40 characters needs QR **version 3** rather than
version 1, which on an 80px panel means **2px modules (0.27mm)** instead of 3px
(0.41mm). Two pixels is harder for a camera at a glancing angle, so the access
code is also printed as text beside the QR — the QR is the convenience, not the
only way in.

`qrcodegen` is vendored under `main/qr/` (Nayuki, MIT) and `boostEcl` is
enabled, so a small payload gets upgraded to a higher EC level for free.

## Security model

The web UI can type arbitrary text into the host, so it is treated as a
privileged console — equivalent to a root shell on the machine the dongle is
plugged into. Four independent defences:

**1. Per-device random code.** Generated from the hardware RNG on first boot,
stored in NVS, and shown on the LCD. 12 characters of Crockford Base32 = 60
bits. It is deliberately *not* derived from the MAC address: the MAC is
broadcast in every beacon, so a MAC-derived secret would be public.

The same code is the SoftAP password and the API token, so there is exactly one
secret to manage. Nothing derived from it appears in the SSID.

**2. Token on every privileged endpoint.** `/auth`, `/ws` and `/bootloader`
all require `?token=`. Static assets (`/`, `/*.js`) are public — they contain
no secrets, and the page has to load before you can supply the code. The token
is scrubbed from the URL bar after load so it does not linger in history.

**3. Origin validation.** Any page you visit can attempt
`new WebSocket('ws://192.168.1.50/ws')` against a LAN address. Requests whose
`Origin` is not one of our own hostnames are rejected, which blocks
cross-site WebSocket hijacking.

**4. Host header validation.** Defeats DNS rebinding, where an attacker points
`evil.com` at our IP and then talks to `ws://evil.com/ws`. The `Host` header
still says `evil.com`, so it fails.

**Per-source throttling** (8 misses → 30s) is defence in depth only. It is keyed
on the client address rather than globally, so nobody can lock you out of your
own device by spamming bad tokens. The real protection is the 60 bits.

### Not covered

- **No transport encryption.** Plain HTTP/WS. On the SoftAP this is protected by
  WPA2, and the token is the WiFi password anyway. Once you enable STA mode on a
  shared network this becomes the weakest link — that is what Phase 3 HTTPS is for.
- **Physical access wins.** Anyone who can read the LCD, or pull the flash, has
  the code. That is the intended boundary.
- **NVS is unencrypted**, so a stored WiFi password is readable by anyone who
  takes the dongle apart.

## Safety model

A USB HID device that gets stuck holding a modifier is genuinely unpleasant, so
there are three independent release paths:

1. **Heartbeat watchdog.** The browser pings every second. If the pings stop for
   5 s *while something is held down*, the firmware releases everything.
2. **Disconnect release.** When the WiFi client disconnects, everything is released.
3. **Physical panic button.** Hold BOOT (GPIO0) for 3 seconds.

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

Connect to `ws://<host>/ws?token=<code>`. The WebSocket handshake is rejected
unless the `Host` and `Origin` headers match one of the device's own names and
the token matches.

`0x02` sends the **complete set of currently-held keys**, not a delta. USB HID reports
are snapshots of current state, so this maps 1:1 onto the hardware with no queue.

### Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /`, `/index.html`, `/style.css`, `/app.js` | none | the web UI — the stored bundle when one was uploaded, the embedded one otherwise |
| `GET /auth?token=` | token | validate a code (204 or 403) |
| `GET /ws?token=` | token | control channel |
| `POST /bootloader?token=` | token | reboot into USB download mode |
| `GET /ui/files?token=` | token | each UI file: stored on the device or still embedded |
| `POST /ui/upload?token=` | token | store a whole UI (stored zip, 192 KB, 96 KB per entry, 24 entries, flat names) |
| `POST /ui/reset?token=&name=` (or `&all=1`) | token | delete stored copies, restoring the embedded ones |
| `GET /screen/image?token=` | token | the stored screen image, header and CRC included (404 when there is none) |
| `POST /screen/image?token=` | token | store the packed screen image (raw body, exactly 6,408 bytes) |
| `POST /screen/reset?token=` | token | delete the screen image, taking that BOOT screen out of the cycle |

## Layout

```
main/
  main.c          app entry, BOOT panic button, watchdog task
  usb_hid.c/.h    TinyUSB composite HID (keyboard + mouse + consumer)
  input_state.c/.h held-state tracking, mutex, release/watchdog logic
  web_server.c/.h SoftAP + HTTP + WebSocket, embedded assets, upload endpoints
  ui_fs.c/.h      LittleFS mount and file plumbing for the uploaded UI
  screen_image.c/.h the custom screen image: file format, validation, storage
  display.c/.h    ST7735 driver, 80×160 framebuffer, 5×7 font (non-fatal)
  web/            the UI sources. These are ES modules and are NOT what the
                  device serves: `tools/build-web.mjs` bundles them with
                  esbuild into web/dist (index.html, style.css, app.js and the
                  repair page), which is what gets embedded. index.html is the
                  one shell: the top bar, the auth gate and a <template> per
                  view; router.js mounts one template into <main> from the
                  hash and calls the view's init()/destroy(). The tabs map to
                  #/ (Remote), #/keys, #/deck and #/setup; #/macros,
                  #/settings and #/ui are kept as aliases so old links still
                  land somewhere. pad.js is Remote and Keys, macros.js +
                  macro.js are Deck, settings.js is Setup and ui.js is the UI
                  files page.
partitions.csv    4 MB app partition, then a 320 KB LittleFS partition for
                  uploaded UI files and the screen image — appended so nvs and
                  the app do not move
sdkconfig.defaults
test/web/         browser-driven UI tests, no npm dependencies
docs/             design notes
  screen-image.md  the custom screen image: what was built, the file format,
                   and the measured numbers
  phone-keyboard.md what a phone keyboard actually delivers, the rules that
                   turn it into HID reports, and what was tried and discarded
```

## Reflashing

**The supported path is BOOT + replug:**

**hold BOOT → plug in → `idf.py flash` → then power-cycle.**

The power cycle is not optional: resetting over the ESP32-S3's USB-Serial-JTAG
peripheral always lands the chip in download mode, so a clean power-up is what
actually boots the app again.

### About the `/bootloader` button

There is a `POST /bootloader` endpoint and a *Bootloader* button in the web UI.
Do not rely on it. What it does is reachable, but not useful with esptool:

- It sets `RTC_CNTL_FORCE_DOWNLOAD_BOOT` and triggers `RTC_CNTL_SW_SYS_RST`.
  `esp_restart()` cannot be used here: it configures RTC WDT stage0 as
  RESET_SYSTEM with a 1 s timeout and calls `wdt_hal_set_flashboot_en(true)`.
  That bit exists to keep the watchdog running even when software disables it,
  and nothing feeds it in download mode — so the chip enters download mode and
  is bounced back into the app about a second later.
- The mode it reaches is the ROM's **USB-OTG DFU** path (`303a:0009`, DFU
  interface class `0xFE/0x01/0x01`) — **not** the USB-Serial-JTAG download mode
  (`303a:1001`) that esptool speaks. Flashing from there needs `dfu-util`, i.e.
  `idf.py dfu` + `idf.py dfu-flash`, plus a udev rule for permissions.

Recovery from it is a plain power cycle.

## Reference

| Task | Command |
|---|---|
| Build the UI | `pnpm build` (or `pnpm watch`) |
| Build | `idf.py build` |
| Flash (download mode) | `idf.py -p /dev/ttyACM0 flash` |
| Enter download mode | unplug → hold BOOT → replug |
| Boot the app | unplug → replug (no BOOT) |
| Force a new device code | `esptool erase_region 0x9000 0x6000` |

## Notes / limitations

- **The LCD is the trust boundary.** It shows the device code on the QR and
  status screens (the custom text screen does not), so anyone who can read the
  screen can control the host. The QR is the legible copy, and it stays up
  until you tap BOOT. Line 6 shows the last reset
  reason (`power-on`, `software`, `wdt`, `brownout`) as a debugging aid since
  there is no usable serial console.
- **macOS pointer acceleration** applies to any relative HID mouse. The gain slider
  compensates; for exact 1:1 you'd need a helper app posting `CGEvent`s.
- **No serial console over USB** while TinyUSB owns the port. `ESP_LOGI` output goes
  to UART0 on GPIO43/44 (the QWIIC connector) and needs an external USB-UART adapter.
  During development, route logging over WiFi instead.
- **Media keys** work, but note where they land: Linux folds the Consumer
  Control collection into the *keyboard* input device rather than creating a
  third one, so `event<N>` for the keyboard carries `PLAYPAUSE`, `MUTE`,
  `VOLUMEUP` and so on. Looking for a separate "Consumer Control" device is a
  dead end. Transport and volume keys are handled by desktops by default;
  anything else (`Calculator` for instance) arrives as a keycode but needs an
  action bound to it in your desktop environment.
- **A browser that hides its keyboard from the page cannot be laid out
  around.** With the phone's own keyboard up, Chrome shrinks the page to fit
  (reported 553/554 in the measurements); Cromite reports no change at all
  (765/766), so its keyboard simply covers the bottom of the slot. The mode
  works in both, but only Chrome lays it out correctly.
- **BLE HID is not implemented** (USB only). The S3 supports both, but WiFi + BLE
  share one 2.4 GHz radio, so expect added jitter if you add it.
- The dongle draws up to ~800 mA with WiFi + backlight.
