# Pages: one store, one renderer

## State at the time of writing

| | |
|---|---|
| Branch | `main`, pushed |
| Tests | `node test/web/run.mjs` → 157 passed |
| Firmware | `idf.py build` green |
| UI bundle | `app.js` 102 KB, `editor.html` 42 KB, `web.zip` 189 KB (caps: 224 KB archive / 160 KB file) |
| Device | running the previous image at `http://192.168.4.1/` (AP mode) |
| Flash | **not done** — the dongle is booted, so it exposes HID (303a:4008) and no `/dev/ttyACM*`. It needs BOOT-held download mode to flash. |

The firmware builds from this tree. Until it is flashed, the device still runs
the previous image (embedded app 95,244 bytes, 96 KiB per-file upload cap), which
is too small to accept the new UI over WiFi. Flash it when the port is
available:

```bash
ls -l /dev/ttyACM0                    # must be writable (0666)
. ~/esp/esp-idf/export.sh
idf.py -p /dev/ttyACM0 flash
# then power-cycle: the dongle stays in download mode after a flash
```

## What the merge did

### One store

`main/web/pages.js` owns `esp32remote.pages`:

```js
{
  id: 'tv', name: 'TV', columns: 4,
  rows: [{ h: 50, gap: 4, align: 'stretch', keys: [
    { label: 'Up', w: 1, colour: 'blue',
      action: { kind: 'key', page: 7, usage: 0x52, code: 'ArrowUp' } },
    { spacer: 1 },
  ] }],
}
```

Actions are `key` (held), `modifier` (latches), `sequence` (blocks of steps),
and `page` (jump). A sequence is stored in the runner's own flat step shape;
the editor's block tree is converted by `stepsFromBlocks()` in `macro.js`.

`migrate()` runs once at boot. It converts `esp32remote.macros`,
`esp32remote.deckPages`, `esp32remote.deckPage` and `esp32remote.layouts`, then
deletes all four. A browser that already has `pages` from the earlier additive
step keeps them and only loses the old keys — the conversion already happened.

The browser still adopts a macro list left in the device's settings blob, after
settings load, because the boot migration runs before the device is reachable.

### One renderer

`main/web/layout.js` exports `renderPage(host, page, opts)` and the page
validator/parser. The Pages tab and the Keys slot both call it; `opts.decorate`
adds the Pages tab's tile chrome, `opts.fit` shrinks a tall page as a whole to a
50% floor before the slot scrolls.

### The Pages tab

`main/web/macros.js` is now the Pages view. It keeps the existing IDs and the
tile classes (`.macro`, `.name`, `.src`, `.run`, `.acts`) so the tests still
drive the real UI, but the grid is the page's rows and spans, not a flat
three-column list.

- page strip with every page, `+`, rename and two-tap delete;
- delete is refused while a key jumps to the page, and the refusal names it;
- editor for all four action kinds;
- run bar, hold-to-run, held keys and latching modifiers;
- import from the box or a file, with states for empty, unreadable, refused,
  imported, and imported-with-suffixed-ids;
- the editor embedded in an iframe from `editor.html`, built from
  `site/editor/index.html` — the same file GitHub Pages serves.

### The Keys strip

`main/web/pad.js` reads `pages` only. Chips are `page:<id>`; an empty page is a
ghost chip rather than hidden. The old `kbDeck` pane is gone: all user pages are
drawn by the same renderer in `#kbLayout`. Keys, modifiers, scripts and page
jumps have one handler.

### Backup

`settings.js` exports `pages` and `strip`. Restoring accepts `pages`; a backup
from before the merge (`macros`) is converted into one page. Incoming pages are
validated before anything is written.

## Limits raised for this bundle

- `main/web_server.c`: archive 224 KiB, one file 160 KiB, entry count 10.
- `test/web/stub.mjs` mirrors both numbers.
- `editor.html` is embedded in the firmware and listed as a served asset.

## Traps already paid for

- Deleting the old keys before the reader switched to `pages` cost 7 test
  failures. The order is convert → rewrite the reader → delete; all three have
  landed.
- A tile re-render while a script is held detaches the pointerup listener. The
  run start disables buttons in place instead of calling `render()`.
- `data-page` is the chip's identity. A second dataset flag called `page`
  overwrites it; the flag is `data-user`.
- An empty page needs one empty row to be a valid page.
- `hidden` loses to `display: flex`; ghost chips and the page pane each have an
  explicit `[hidden]` rule.
- The device UI's accent is amber `#f2a93b`; the editor's is blue `#6ea8fe`.
- Sections in Setup must keep the base route they arrived by (`/setup` vs
  `/settings`) or the router remounts and resets the form.

## How to check

```bash
pnpm build && node test/web/run.mjs      # 157 now
bash test/firmware/run.sh
. ~/esp/esp-idf/export.sh && idf.py build
idf.py -p /dev/ttyACM0 flash             # needs the port writable
```

The device stays in download mode after a flash: power-cycle it to boot.
