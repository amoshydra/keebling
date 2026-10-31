# Driving the host from the phone's own keyboard

The control view can hand the keyboard slot over to the phone: instead of drawing
keys, it focuses a field and translates the phone keyboard's events into HID
reports. This file records what that costs and what was measured, so the same
ground is not covered twice.

## What the phone actually delivers

Measured on Android with Hacker's Keyboard. Other IMEs can differ, so re-measure
with the probe (Settings → Key event probe) before assuming.

| What is pressed | What the browser delivers |
|---|---|
| arrows, Tab, Esc, Enter, Backspace, F1–F12 | `keydown`/`keyup` with a real `code` and `keyCode` |
| Ctrl + a letter | `keydown` with `code` **and** `ctrlKey` — chords survive the IME |
| a plain letter | `keydown` with an **empty `code`** (`keyCode` 229), then `beforeinput`/`input` with the text |
| Shift + a letter | same as above, text already shifted (`data: "A"`) |
| Enter | `keydown Enter` **and** `beforeinput`/`input` `insertLineBreak` |
| Backspace | `keydown Backspace` **and** `beforeinput`/`input` `deleteContentBackward` |

## The four rules

Getting these exact is what stops every keystroke being sent twice.

| Event | Action |
|---|---|
| `keydown` with an empty `code` | ignore — the IME will deliver the text |
| `keydown` with a code, and either a modifier or a usage that produces no text | send the report, then `preventDefault()` |
| `keydown` for a printable usage with no modifier | ignore — its `beforeinput` will type it |
| `beforeinput` `insertText` | type it through the layout table, `preventDefault()` |
| `beforeinput` anything else | ignore — it already arrived as a key |

`preventDefault()` is load-bearing, not defensive: without it Tab moves focus out
of the field and F5 reloads the page.

## Browsers differ, and one cannot be helped

With the keyboard open, measured on the same phone:

| | `innerHeight` | `visualViewport.height` | Result |
|---|---|---|---|
| Chrome | 553 | 554 | the layout shrinks; everything fits above the keyboard |
| Cromite | 765 | 766 | nothing changes; the keyboard overlays the page |

Cromite never tells the page a keyboard exists, so no page-side code can lay out
around it. The app stays usable there because the controls that matter are not at
the very bottom, but the bottom of the layout is covered.

## Layout rules that make it work

- `html` **and** `body` are `overflow: hidden`. A page that can scroll *will* be
  scrolled for you when a field takes focus.
- `body` is sized from `window.visualViewport.height` (`--app-height`, written by
  `common.js`), not `100dvh`. That covers both keyboard styles.
- The viewport meta asks for `interactive-widget=resizes-content`, which helps
  where it is supported.
- The focus target is a 1px, `opacity: 0`, `position: fixed` input at the
  viewport's **top-left corner**. The caret is at the origin, so focusing it can
  never scroll anything into view. `pointer-events: none` keeps the corner
  belonging to the page.
- The tap target that focuses it must be **visible**. This is not negotiable.

## Tried and discarded

Recorded so they are not attempted again.

- **A fallback that watched the viewport height** and revealed a visible field
  when it thought the keyboard had not opened. The heuristic was wrong on the
  device: the keyboard was opening and the code was drawing a field over it. The
  detector was the defect. Removed entirely.
- **Focus retries at 0/60/200ms**, and **a single 60ms delayed focus**. Neither
  behaved differently from a plain synchronous `focus()` on the device.
- **A full-viewport transparent input** instead of a 1px one. No difference.
- **`click` on the keyboard-source switch.** When the keyboard was up, the first
  tap dismissed it, the layout moved under the finger, and no `click` was
  generated — so the switch only worked on the second tap. It now acts on
  `pointerdown`.

## Test lessons

- **Mutations can mask each other.** Removing the focus retries did not fail the
  suite, because the Tab guard was refocusing for an unrelated reason. A test
  that passes for the wrong reason is worse than no test; isolate the mechanism
  before trusting a green run.
- A mutation that restores by string replacement can corrupt an unrelated
  function that shares the same line. Re-read the file after a mutation cycle.
