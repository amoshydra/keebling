# Custom screen image

**Implemented.** The LCD shows a picture the user picks in the browser, as a
fourth screen in the BOOT tap cycle. This note records what was built, the two
file formats, and the numbers behind the choices. The options table is kept as
the record of why this shape won.

## What was built

- The **browser does the conversion**: canvas → 160 × 80 → quantise with a
  Bayer 4×4 ordered dither → pack → a small header. It posts the result as
  `application/octet-stream`. Two formats: **RGB565 colour** (25,600 payload
  bytes) and **4-bit greyscale** (6,400), picked per upload.
- The device needs **no PNG or JPEG decoder at all**. That was the point of the
  shape: no dependency, no code-size risk, no decoder bug surface.
- Stored as **`screen.img`** in the existing `ui` LittleFS partition, through
  `ui_fs`'s fixed-name plumbing. It is not an entry in the asset table, which is
  the whitelist for *web* files — the image gets its own routes
  (`GET`/`POST /screen/image`, `POST /screen/reset`) and the name is a
  compile-time constant, never anything from a request.
- Draws **one row at a time, straight into the framebuffer**: greyscale reads
  80 bytes a row and expands nibbles through a 16-entry RGB565 LUT; colour reads
  320 bytes a row and swaps each pixel's two little-endian bytes in place, so
  it needs no row buffer of its own. The whole decoded image is never in RAM.
- The **BOOT tap cycle includes the mode only when the file validates** — the
  same skip rule the custom text screen uses when its setting is empty. A tap
  never lands on a blank or garbage screen.
- The settings page (**Screen** section) has the file picker, a **Colour /
  Greyscale** choice (defaulting to colour), the preview — the dithered
  160 × 80 copy, not the original — and the honest notes: the panel does no
  gamma correction, colour is not pre-compensated, and the trade is 25,608
  bytes against 6,408.

## File format

Little-endian. Both formats share the same 8-byte header and differ in the
payload the format byte names:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | format — `0x01` = 4-bit greyscale, `0x02` = RGB565 |
| 1 | 1 | reserved — must be 0 |
| 2 | 2 | payload length — 6,400 for `0x01`, 25,600 for `0x02` |
| 4 | 4 | CRC-32 (IEEE, reflected, init and final `0xFFFFFFFF`) over the payload only |
| 8 | payload | payload |

**`0x01` — 4-bit greyscale, 6,408 bytes.** 80 rows of 80 bytes; the high nibble
is the left pixel and the nibble is a grey level 0..15, drawn as level × 17
through a 16-entry RGB565 table.

**`0x02` — RGB565 colour, 25,608 bytes.** 80 rows of 320 bytes, two
little-endian bytes per pixel, 5 bits red, 6 green, 5 blue. Row-major, so the
pixel at (x, y) starts at payload offset y × 320 + x × 2. The framebuffer holds
the high byte first, so `display_rgb565` swaps each pixel's two bytes in place
as it reads the row; the wire word is then the standard RGB565 word that the
panel's BGR element order is set up for.

The format byte is what makes colour additive: a stored `0x01` file keeps its
meaning and the device keeps drawing it exactly as before, and nothing is
re-encoded. The length field must agree with the format byte and the exact file
size must agree with both — a body that claims `0x02` at the greyscale size is
refused, not guessed at.

The CRC covers the payload alone, so the browser computes it while packing and
the device checks it while reading; the format byte, the length field and the
exact file size together cover the header. A body that fails any of those is
refused, and a refused upload leaves the previous image in place — a truncated
or stale file is detected rather than drawn.

The upload is streamed to `<name>.tmp` and renamed into place only once the
header and CRC check out, so the switch is atomic. The temporary copy means two
images exist for the moment of the switch — about 51 KB for a colour file,
comfortably inside the 320 KB partition.

## Why this shape

| Option | Flash | Extra RAM | Firmware work | User-changeable |
|---|---|---|---|---|
| 1-bit in app `rodata` | 1,600 B | 0 | ~40 lines | no — reflash per image |
| 1-bit + RLE | ~100 B for logos; **no gain** on dithered photos, whose runs are short — it can grow past 1,600 B | 0 | + decoder | only if uploaded; pointless with 12 MB free |
| 4-bit in app `rodata` | 6,400 B | 0 | ~60 lines | no |
| LittleFS + upload | 6,400 B + FS overhead, ≥128 KB partition | ~0 | ~350 lines + a new component | yes |
| Raw partition + upload | 6,400 B + ~32 B header, 16 KB partition | 0 (read row-wise) | ~250–350 lines | yes |

The LittleFS row is what was built, once the web UI plan landed and the `ui`
partition already existed: the image is one more file on a filesystem that is
already mounted, served and recovered over WiFi. Against the raw partition that
is a marginal ~30 lines of VFS plumbing instead of `esp_partition_*`, and a
`GET` for the settings page's preview comes almost free. The raw partition
remains the answer if the filesystem ever goes away: a filesystem for one
fixed-size blob is more code, more flash and more failure modes.

**Colour arrived later, and only because of that row.** The original plan put
the image in a 16 KB raw partition, where 25,600 bytes did not fit — that is
why the first version was greyscale only. The format byte was in the header
from the start precisely so a second format could be additive. On the 320 KB
LittleFS partition the colour file is 25,608 bytes against hundreds of KB of
room, so the 4× file size is not a constraint worth protecting; it is a trade
the user gets to make per image.

**Not in the settings blob.** 6,400 B does not fit 1,023, and the blob is
rewritten wholesale on every UI save — NVS churn against a budget shared with
everything else. 25,600 would be worse.

## Constraints, measured

| | |
|---|---|
| Panel | 160 × 80 = 12,800 px |
| RGB565 | 25,600 B |
| 4-bit greyscale | 6,400 B |
| 1-bit | 1,600 B |
| PSRAM | none — not enabled in `sdkconfig` |
| App partition | 1,096,528 B used of 4,194,304 → **3,097,776 B free** |
| Flash unallocated | from 0x460000 to 0x1000000 → **12,189,696 B (11.63 MiB)** |
| Static DRAM (DIRAM) | 162,783 of 341,760 B (47.6%), 178,977 B left for heap and stacks |
| Settings blob | 1,023 usable bytes — `SETTINGS_MAX` is 1024 and `read_body()` rejects a body that fills the buffer |
| SPI clock | 40 MHz (vendored driver) → a full-screen flush is ~5.1 ms of wire time |
| Web UI files | 124,864 B across `main/web/*`, embedded in the app; the `ui` partition serves replacements |
| `ui` partition | 320 KB LittleFS; a colour image is 25,608 B of it |

The SPI clock line is the one that matters: **redraw cost is not the
constraint.** Format, RAM and flash are — and all three had room to spare.

## Correction: a partition-table change does not wipe NVS

An earlier version of this note claimed that adding a partition wipes NVS, and
that USB names, the serial override, WiFi credentials and macros would need
re-entering. **That is wrong**, and it was disproved on hardware when the `ui`
partition was added: appending a partition *after* the app leaves `nvs` at
0x9000 untouched, and `idf.py flash` writes only the bootloader, the partition
table and the app — none of which overlap it. There is nothing here that needs
an export first.

## Uncertain

- **Appearance on the panel is unverified, for either format.** It needs
  `INVON` and does no gamma correction, so mid-greys are expected to look flat;
  RGB565 on an uncalibrated TN panel is expected to look muted and to shift
  with the viewing angle. No gamma pre-compensation is attempted — the panel's
  response is unknown and guessing would make it worse, not better. The preview
  shows the browser's rendering of the bytes, not what the panel's colour
  response will do to them; only hardware can settle this.
- The **byte and colour order are not guesses**: the panel config follows
  LILYGO's factory example (BGR element order, LVGL buffers byte-swapped before
  `draw_bitmap`, and that screen shows the factory logo correctly), so a wire
  word of `0xF800` is red and the little-endian payload maps straight through.
  That example settles the mapping, not the appearance.
- The tests cover the conversion in both formats, the header and CRC, the
  size/format agreement, and the device-side contract as far as a page can: a
  refused body never becomes an image. The BOOT cycle's skip rule itself is
  firmware code and is only exercised on hardware.
- `esp_http_server`'s behaviour with a 25,600-byte binary body is exercised by
  the test stub, not by the device; the first real colour upload is the real
  test. The receive loop reads 512 bytes at a time, so it is about 50 calls
  instead of 13 — the same shape, more of it.
