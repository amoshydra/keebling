# Pages: the merge, and where it stopped

Written for whoever picks this up next — including me after a context reset.

## State at the time of writing

| | |
|---|---|
| Branch | `main`, clean, pushed |
| Last commit | `b45a5aa` — one page store, converted from the old ones |
| Tests | `node test/web/run.mjs` → 150 passed |
| Firmware | `idf.py build` green; device flashed from this commit |
| Device | dongle on the LAN, reachable at `10.0.20.209` (via `wg0-mullvad`), code `1z310KG7qzq1` |

Do not trust the IP. Check with:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://10.0.20.209/
# if the dongle fell back to AP mode it is at 192.168.4.1 and not reachable from the host
```

## What exists

| Path | What it is |
|---|---|
| `main/web/pages.js` | **The one store.** `readPages`, `writePages`, `migrate`, `dropLegacy`, `parsePageFile` |
| `main/web/layout.js` | Draws an imported layout in the Keys slot; owns validation |
| `main/web/deck.js` | The deck's shape (colour, key catalogue, sanitiser) |
| `main/web/macro.js` | The brace DSL: `parseMacro`, `macroText`, `runMacro` |
| `main/web/macros.js` | **The Deck view** — 969 lines, still reads `esp32remote.macros` |
| `main/web/pad.js` | Remote + Keys; builds the strip, owns the transport |
| `site/editor/index.html` | The layout editor (self-contained), published on Pages |
| `site/editor/deck.schema.json` | The format, as a schema |

## Decisions already taken

- A page is **rows → items**; an item is a **key** or a **spacer**; a key spans columns. Row height in px; the page scales as a whole, floor 50%, then scrolls.
- Four actions: **hold a key**, **modifier (latches)**, **script** (blocks: tap/text/wait/repeat), **page jump**.
- The strip is an ordered list; built-ins `abc sym fn kp media` can be reordered, never removed; a user page may be first.
- **The tab is renamed Deck → Pages.**
- **No migration preservation**: the old keys get deleted once the Deck reads `pages`. Until then the migration is additive — that is deliberate, see Traps.
- Columns cannot drop below the widest row; a page cannot be deleted while a key jumps to it; duplicate ids and names get suffixed.
- The editor is **embedded under Pages** and also hosted on Pages from the same source.
- Keyboard source (IME) mode is unchanged for now.

## The plan, in order

### 1. `macros.js` reads `pages`
Render the active page through `renderPage` from `layout.js`; keep each tile's name, source line, colour, delete, and the HOLD tag; keep press-to-run, press-to-hold, and the run bar. **No storage change yet.**

Acceptance: the deck tests pass unchanged; a deck page still runs a script and holds a key.

### 2. Delete the old stores
Call `dropLegacy()` from `migrate()` once step 1 is the only reader.

Acceptance: a browser with only `esp32remote.macros` boots, shows the converted deck, and afterwards has no `macros`/`deckPages`/`layouts` key.

### 3. The strip reads `pages` alone
`pad.js buildStrip()` stops calling `deckSnapshot()` and `readLayouts()`; `deck:` and `layout:` chips become `page:<id>`. The import writes `pages` instead of `layouts`.

Acceptance: one chip per page, user pages marked, empty pages shown as ghosts rather than hidden.

### 4. The editor under Pages
Same source as `site/editor`, bundled into the app; import lives here with the six states (empty, placeholder, invalid, refused, done), plus `+ New page`.

### 5. Small rules
44px tap targets in the strip; `env(safe-area-inset-*)`; scale floor; blocked page delete; columns floor (partly done in the editor).

## Traps already paid for

- **Deleting the old keys before the Deck reads `pages` cost 7 test failures.** The migration is additive on purpose. Do not flip it early.
- `macros.js` needs `{ steps: [], errors: [] }` for a key control — an object without `errors` throws in `saveEditor`.
- Sections in Setup must keep the base route they arrived by (`/setup` vs `/settings`), or the router remounts and the form resets.
- The device UI's accent is amber `#f2a93b`; the editor's is blue `#6ea8fe`. Do not cross them.
- A build that slices CSS without its closing `</style>` renders a blank page. Look at the render, not the file.
- `hidden` is overridden by `display: flex` — ghost chips and the layout pane both needed an explicit `[hidden]` rule.

## How to check

```bash
pnpm build && node test/web/run.mjs      # 150 now
bash test/firmware/run.sh
. ~/esp/esp-idf/export.sh && idf.py build
idf.py -p /dev/ttyACM0 flash             # needs the port writable (0666)
```

The dongle stays in download mode after a flash: it needs a power cycle to boot.
