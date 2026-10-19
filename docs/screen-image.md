# Custom screen image

**Implemented.** The LCD shows a picture the user picks in the browser, as a
fourth screen in the BOOT tap cycle. This note records what was built, the file
format, and the numbers behind the choices. The options table is kept as the
record of why this shape won.

## What was built

- The **browser does the conversion**: canvas → 160 × 80 → luminance → 4-bit
  quantise with a Bayer 4×4 ordered dither → two pixels per byte → a small
  header. It posts the result as `application/octet-stream`.
- The device needs **no PNG or JPEG decoder at all**. That was the point of the
  shape: no dependency, no code-size risk, no decoder bug surface.
- Stored as **`screen.img`** in the existing `ui` LittleFS partition, through
  `ui_fs`'s fixed-name plumbing. It is not an entry in the asset table, which is
  the whitelist for *web* files — the image gets its own routes
  (`GET`/`POST /screen/image`, `POST /screen/reset`) and the name is a
  compile-time constant, never anything from a request.
- Draws by reading **80 bytes per row** and expanding nibbles through a
  **16-entry RGB565 LUT** straight into the framebuffer. The whole decoded image
  is never in RAM.
- The **BOOT tap cycle includes the mode only when the file validates** — the
  same skip rule the custom text screen uses when its setting is empty. A tap
  never lands on a blank or garbage screen.
- The settings page (**Screen** section) has the file picker, the preview — the
  dithered 160 × 80 copy, not the original — and the two honest notes: the panel
  does no gamma correction, and a colour photo is converted, not reproduced.

## File format

Little-endian, 6,408 bytes:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | format — `0x01` = 4-bit greyscale, 160 × 80, high nibble is the left pixel |
| 1 | 1 | reserved — must be 0 |
| 2 | 2 | payload length — must be 6,400 |
| 4 | 4 | CRC-32 (IEEE, reflected, init and final `0xFFFFFFFF`) over the payload only |
| 8 | 6,400 | payload — 80 rows of 80 bytes |

The CRC covers the payload alone, so the browser computes it while packing and
the device checks it while reading; the format byte, the length field and the
exact file size together cover the header. A body that fails any of those is
refused, and a refused upload leaves the previous image in place — a truncated
or stale file is detected rather than drawn.

The upload is streamed to `<name>.tmp` and renamed into place only once the
header and CRC check out, so the switch is atomic.

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

**Not in the settings blob.** 6,400 B does not fit 1,023, and the blob is
rewritten wholesale on every UI save — NVS churn against a budget shared with
everything else.

## Constraints, measured

| | |
|---|---|
| Panel | 160 × 80 = 12,800 px |
| RGB565 | 25,600 B |
| 4-bit greyscale | 6,400 B |
| 1-bit | 1,600 B |
| PSRAM | none — not enabled in `sdkconfig` |
| App partition | 1,096,688 B used of 4,194,304 → **3,097,616 B free** |
| Flash unallocated | from 0x460000 to 0x1000000 → **12,189,696 B (11.63 MiB)** |
| Static DRAM (DIRAM) | 162,783 of 341,760 B (47.6%), 178,977 B left for heap and stacks |
| Settings blob | 1,023 usable bytes — `SETTINGS_MAX` is 1024 and `read_body()` rejects a body that fills the buffer |
| SPI clock | 40 MHz (vendored driver) → a full-screen flush is ~5.1 ms of wire time |
| Web UI files | 120,728 B across `main/web/*`, embedded in the app; the `ui` partition serves replacements |

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

- **Appearance on the panel is unverified.** It needs `INVON` and does no gamma
  correction, so mid-greys are expected to look flat; the browser-side dither
  should mask that, but only hardware can settle it. The preview shows the
  dithered levels, not what the panel's colour response will do to them.
- The tests cover the conversion, the header and CRC, and the device-side
  contract as far as a page can: a refused body never becomes an image. The BOOT
  cycle's skip rule itself is firmware code and is only exercised on hardware.
- `esp_http_server`'s behaviour with a 6,400 B binary body is exercised by the
  test stub, not by the device; the first real upload is the real test.
