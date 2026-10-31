# Web UI tests

Drives the real UI against a stub device in a headless Chromium. **No npm
packages** — it uses Node's built-in `WebSocket` and `fetch` to speak the
DevTools protocol, and reuses whatever Chromium is already on disk.

```bash
node test/web/run.mjs              # run everything
node test/web/run.mjs --verbose    # also list passing tests
CHROME=/path/to/chrome node test/web/run.mjs
node test/web/stub.mjs             # just the stub, on :8101, for poking by hand
```

Exit code is non-zero if anything fails.

## Why this exists

Every serious bug in the web UI so far has been a **regression**: the saved
access code not being read back, pointer lock capturing on touch, scroll
direction flipping. Each was found by hand, fixed, and then lost again in a
refactor — because the checks existed as throwaway scripts rather than as
something re-run on every change.

If you change anything under `main/web/`, run this first.

## Layout

| File | Purpose |
|---|---|
| `stub.mjs` | serves `main/web/` and stands in for the firmware's endpoints |
| `tests.js` | the assertions, injected into the page and run there |
| `run.mjs` | launches Chromium, navigates, runs the tests, reports |

The tests run **in the page**, against the real `pad.js` / `common.js` /
`settings.js` / `macros.js`, with only the socket and the HTTP endpoints faked.
So a test failure means the shipped code is wrong, not a reimplementation of it.

Pages are visited at the size they are used at: the control and macro views at a
phone viewport, the settings view and a second control pass at a desktop one.
Every target is a hash on the single shell (`#/`, `#/settings`, `#/macros`,
`#/ui`). The test groups are named `control`, `settings`, `macros`,
`control-desktop`, `macros-migrate`, `ui`, `ui-broken`, `navigation`,
`refresh` and `gate`. The phone-layout assertions live in the `control` group at
the phone viewport.

## What is covered

**Control page**
- the saved code is restored on the bare URL, so no prompt appears
- keyboard reports keep pre-existing held keys when typing over them
- the US QWERTY character map, and that non-ASCII is refused
- one-finger tap → left click; two-finger tap → right click
- one-finger drag moves; three-finger drag presses, drags and releases
- two-finger scroll is *natural* (swipe up scrolls down)
- touch never requests pointer lock; a mouse does
- a virtual key stays held for the duration of a long press
- a media key emits a consumer report and a release
- the first visit shows the gesture help, dismissing it remembers that in
  localStorage and leaves nothing over the pad, and the ? button reopens it
- a latched modifier's colour and outline differ from a held key's pressed
  state
- at phone width the controls are two rows with the pointer buttons along the
  bottom edge, and only one panel opens at a time; at desktop width the row
  does not wrap, panels stay independent, and hover rules exist inside a
  pointer-fine media query
- a captured pad degrades visibly when the socket closes and returns to its
  normal captured look when the socket reopens; input while captured pulses a
  low-key indicator that fades when input stops

**Settings page**
- the form binds to the device's stored values
- edits save to the device automatically, debounced
- a screen timeout of 0 reads as "never"
- the custom screen text is capped at one screen, keeps its line break, and
  reaches the device
- the custom screen image: greyscale packs to exactly 6,400 payload bytes and
  colour to 25,600, each with the header and CRC the device checks; the colour
  payload is little-endian RGB565 and the row stride is asserted; a flat grey
  and a flat colour are dithered into the Bayer pattern rather than
  thresholded, per channel for colour; the preview shows the same bytes that
  get sent, in both formats
- the screen image is out of the BOOT cycle while no valid image is stored: a
  corrupted, truncated, unknown-format, wrong-size or format/size-disagreeing
  body is refused and never becomes an image, and a refused upload leaves a
  stored one in place
- the HID report descriptor decodes into a readable tree
- the last save actually reached the device (checked server-side, not in the form)

**Macro page**
- the DSL: the worked example, named keys, media usages, modifier
  combinations, `{{`/`}}`, delays, and the US QWERTY character map
- an unrecognised token is an error naming the token, and the page refuses to
  run it rather than skipping it
- a run puts the reports the parser describes on the wire (checked byte for
  byte), including report pairs and the consumer release
- a stop lands between characters, releases keys and media, and interrupts a
  long delay
- characters with no key are reported as skipped
- the page lists what the device holds, runs a macro with visible progress,
  adds one (chips insert tokens), refuses a set over the 1023-byte settings
  limit, and deletes on a second tap
- the added macro actually reached the device (checked server-side)

**UI files page**
- the page lists every UI file and says whether it is the built-in copy or an
  upload, with `index.html` listed once
- an upload is served in its place, and resetting brings the built-in copy back
  (both checked by fetching the file, not by reading the page)
- a name outside the whitelist — `../style.css`, `evil.txt`, `style.css.tmp` —
  is refused with 400 by upload and reset alike, and changes nothing
- an over-size file is refused with 413 by the endpoint, and the page refuses
  it before sending anything; an empty file is refused at both layers too
- the `/ui/*` endpoints answer 403 without the access code
- the settings page's reset-all reaches the device and restores the embedded
  file (checked server-side)
- with a broken `pad.js` stored, the shell and the upload view still load and
  can reset it (a broken `index.html` is the shell and is not recoverable from
  the UI, which is why the page says to keep a copy)

The runner also checks the fallback rule itself, straight at the stub: a stored
file is served in preference to the embedded one, and a **zero-length** stored
file counts as absent, so an empty or interrupted upload cannot shadow a
working page.

**Access gate**
- with no saved code the shell's gate appears; entering a code unlocks the view
  the hash already names, hides the gate and saves the code

**Navigation**
- each hash mounts its own view and no other (only one set of the colliding
  IDs exists at a time)
- Back and Forward land on the view the hash names, and an unknown hash falls
  back to the control view
- a reload keeps the hash and lands on that view, with the saved access code
  (the URL no longer has `?token=`)
- leaving the pad sends a release report, clears held keys and closes its
  socket; no reconnect fires after a wait longer than the retry interval
- leaving the macros view closes its socket and stops its heartbeat, with no
  reconnect afterwards
- a window listener from the pad is gone after unmounting, and remounting
  attaches exactly one (a duplicate would send two release reports)

## Keeping it honest

The suite is only worth anything if it fails when something breaks. To check
that, temporarily reintroduce a bug and confirm the matching test fails:

```bash
# e.g. gate loadToken() on the URL again
sed -i 's/^  loadToken();/  if (location.search) loadToken();/' main/web/common.js
node test/web/run.mjs      # expect: FAIL authenticated: no code prompt...
git checkout main/web/common.js
```

## Adding a test

Append to `tests.js`:

```js
__webTests.push({
  page: 'control',                 // or 'settings'
  name: 'what it should do',
  fn: async () => {
    __assert(condition, 'what went wrong');
  },
});
```

Helpers available in scope: `__capture()` swaps the pad's socket for a recorder
and returns the report array, `__pointer(type, id, pointerType, x, y)`
dispatches a synthetic pointer event, `__resetInput()` clears the gesture
state, and `__sleep(ms)` waits. For the macro view, `__macroCapture()` does the
same swap there and `__playMacro(text)` returns `{ cap, parsed, result }` for
one macro without a page or a socket at all. The view internals the tests drive
for real (`PadView`, `SettingsView`, `MacrosView`, `UiView`) are the same
objects the router calls `init()`/`destroy()` on.
