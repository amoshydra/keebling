# Custom screen image — design note

**Not implemented.** This records the numbers and the reasoning behind the
recommendation, so the work does not start by re-deriving them. The custom
*text* screen is implemented; see the README.

## Constraints, measured

| | |
|---|---|
| Panel | 160 × 80 = 12,800 px |
| RGB565 | 25,600 B |
| 4-bit greyscale | 6,400 B |
| 1-bit | 1,600 B |
| PSRAM | none — not enabled in `sdkconfig` |
| App partition | 1,025,728 B used of 4,194,304 → **3,168,576 B free** |
| Flash unallocated | from 0x410000 to 0x1000000 → **12,517,376 B (11.94 MiB)** |
| Static DRAM | 162,719 of 341,760 B (47.6%), ~179 KB left for heap and stacks |
| Settings blob | 1,023 usable bytes — `SETTINGS_MAX` is 1024 and `read_body()` rejects a body that fills the buffer |
| SPI clock | 40 MHz (vendored driver) → a full-screen flush is ~5.1 ms of wire time |

The last line matters: **redraw cost is not the constraint.** Format, RAM and
flash are.

## Options

| Option | Flash | Extra RAM | Firmware work | User-changeable |
|---|---|---|---|---|
| 1-bit in app `rodata` | 1,600 B | 0 | ~40 lines | no — reflash per image |
| 1-bit + RLE | ~100 B for logos; **no gain** on dithered photos, whose runs are short — it can grow past 1,600 B | 0 | + decoder | only if uploaded; pointless with 12 MB free |
| 4-bit in app `rodata` | 6,400 B | 0 | ~60 lines | no |
| LittleFS + upload | 6,400 B + FS overhead, ≥128 KB partition | ~0 | ~350 lines + a new component | yes |
| Raw partition + upload | 6,400 B + ~32 B header, 16 KB partition | 0 (read row-wise) | ~250–350 lines | yes |

## Recommendation

**4-bit greyscale, 6,400 B, uploaded into a dedicated raw partition, converted
in the browser.**

- Add one line to `partitions.csv`: `screenimg, data, undefined, 0x410000, 0x4000`.
- Find it with `esp_partition_find_first`.
- Expose `POST /screen_image` (token-gated): chunked body → `esp_partition_erase_range` → `esp_partition_write` → CRC32 into a small header.
- Draw by reading 80 B per row and expanding nibbles through a 16-entry RGB565 LUT straight into `s_fb`.
- The BOOT tap cycle includes the mode only when the header and CRC validate — the same skip rule the text screen uses when its setting is empty.
- 16 KB holds the image with room to spare. Use 32 KB if you want to keep the RGB565 door open; the header's format byte makes that an additive change later. A 1-bit image in a 4 KB partition is the minimum-work version of the same pipeline.

**The browser does the conversion.** Canvas → 160 × 80 → 4-bit quantise (Bayer
4×4 dither in JS) → pack 2 px/byte → POST as `application/octet-stream`. The
device then needs no PNG or JPEG decoder at all, which removes the biggest
dependency, the biggest code-size risk and the largest bug surface.

Rough work: ~50 lines display, ~80–120 handler, ~60–80 JS plus a file input,
~20 mode wiring — about 300 lines and one partition line. The upload body is
the only genuinely new mechanism.

**Do not put an image in the settings blob.** 1,600 B does not fit 1,023, and
the blob is rewritten wholesale on every UI save — NVS churn against a budget
shared with the macros.

## If the LittleFS web-UI plan lands

Store `screen.img` as a file there and drop the raw partition. Sizing becomes
the UI plus the image: `wc -c main/web/*` is 92,708 B today, so 256 KB is
comfortable for both. Marginal cost versus the raw partition is ~30 lines of
VFS plumbing instead of `esp_partition_*`, and a preview or `GET` endpoint
becomes trivial.

**If it does not land**, the raw partition is the whole answer: a filesystem
for exactly one fixed-size blob is more code, more flash and more failure modes
(mount, VFS, a component to keep updated). The cost is a second storage
mechanism in the tree; the defence is that this one holds a single fixed-size
record.

Note that a partition-table change **wipes NVS** — USB names, the serial
override and WiFi credentials would need re-entering, and macros too if they
ever move back off the browser. Worth having an export before doing it.

## Uncertain

- littlefs's actual code size is unmeasured here (~15–25 KB by reputation).
- RLE ratios are estimated from run-length reasoning, not measured.
- Appearance on this panel is unverified. It needs `INVON` and does no gamma
  correction, so expect washed-out mid-greys; the browser-side dither should
  mask that.
- `esp_http_server`'s behaviour with a 6,400 B binary body is untested.
