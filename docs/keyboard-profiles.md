# Keyboard profiles

A plan for making the on-screen keyboard fit different jobs. Not implemented.

## The idea

**A profile changes which pages exist and which one you land on — not where the
keys are.** Moving keys around is how you destroy muscle memory; choosing which
pages are present is how you optimise for a task.

Today the keyboard has four fixed pages reached by keys inside the keyboard:
`abc` → `?123` → `Fn` → `Num`. Every key is always there, which is why none of
them is quite right for any particular job.

## What a profile is

```
profile = { name, pages: [pageId, …], landing: pageId }
```

- `pages` — which pages this profile has, in strip order.
- `landing` — the page the keyboard opens on.

Pages come from a fixed catalogue. A profile cannot move a key within a page,
and cannot invent a page — that is what the Deck is for.

## Page catalogue

| id | What it is | Exists today |
|---|---|---|
| `abc` | letters, digits, arrows, command strip, space | yes |
| `sym` | punctuation with shifted legends | yes |
| `fn` | F1–F12, Home/End/PgUp/PgDn | yes |
| `kp` | keypad, real Keypad usages | yes |
| `nav` | a D-pad: big arrows, OK in the middle, Back, Home, Menu | **new** |
| `media` | transport, volume, mute, brightness, browser keys | **new** |

The two new pages are the ones the scenarios below actually need, and both are
straightforward: `nav` is nine large keys, `media` is the existing consumer
table laid out as buttons.

## The scenarios

### General (default)
`abc · sym · fn · kp`, landing on `abc`. What exists today.

### Media
`media · abc · nav`, landing on `media`.

Transport and volume on the first page, because that is the whole job. Letters
stay one tap away for typing a search term, and `nav` for moving around a
player UI. The browser keys (back/forward/home/refresh) live on `media` too —
they are the same kind of thing: single presses that drive an application.

### TV box
`nav · abc · sym`, landing on `nav`.

A D-pad first, because on a TV the arrows and OK *are* the interface. `Back`
and `Home` beside them. The letter page follows for entering a URL or a Wi-Fi
password, which is the only typing a TV needs.

**Open question, needs a device:** what does an Android TV box treat as
"Back"? On a USB keyboard it is usually `Esc`; some boxes map the consumer
`BrowserBack`. The page can carry both, but which one the UI labels "Back"
should follow what actually works.

### Terminal / SSH
`abc · sym · fn`, landing on `abc`, with `sym` second.

Terminals need `| ~ / - _ : $` more than they need a keypad, and `Esc`, `Tab`
and `Ctrl` are on the command strip already. F-keys are third. The `kp` page
is dropped: a terminal does not want one.

The interesting part of this profile is not the pages — it is that a terminal
user types the same dozen strings constantly (`sudo `, `&& `, ` | grep `,
`-la`). Those belong on the **Deck**, not as keyboard keys: the Deck already has
pages, labels, colours and sequences. The profile's job is to get out of the
way.

### Texting / messaging
`abc · sym`, landing on `abc`.

Letters, space, punctuation. No keypad, no F-keys, no nav page — a messaging
keyboard with the furniture removed.

### Custom
Pick the pages, their order, and the landing page. Same data structure as the
presets; the presets are just saved configurations with names.

## What has to change in the code

1. **A page strip replaces the in-keyboard links.** Today pages link to each
   other with hardcoded keys (`p:sym`, `p:fn`, `p:kp`). With profiles those
   targets may not exist. The strip shows only the profile's pages, in order,
   and costs about 40px of height.
2. **`keyPages()` returns the profile's pages**, and `buildKeyboard()` lands on
   `profile.landing` rather than `'abc'`.
3. **Two new pages**: `nav` and `media`.
4. **Storage**: `esp32remote.keyboardProfile` (a preset name) and
   `esp32remote.keyboardPages` (for Custom), next to the existing host layout.
5. **Setup → Keyboard** gains the picker: preset on top, page toggles and order
   underneath when Custom is selected. The existing host-layout selector stays
   where it is; the two are independent — one describes the host, the other
   describes what you are doing with it.

## What this deliberately is not

- **No drag-and-drop key placement.** It looks like the natural next step and
  it is a trap: every task would start by re-arranging, and the arrangement
  would be wrong the moment the task changes. Profiles answer "which keys are
  at hand", which is the real question.
- **No long-press alternates.** Holding a key already repeats it — the host
  auto-repeats a held key — so an alternate on hold would be the same gesture
  meaning two things.
- **No per-app detection.** The page cannot see what the host is running.

## Phases

**P1 — pages.** Add `nav` and `media` to the catalogue; the page strip; presets
in the data model with General as the only option wired up. No UI yet, but the
keyboard already behaves per profile.

**P2 — the picker.** Setup → Keyboard: preset choice, then Custom's page
toggles and ordering. Storage and migration for a browser that has never chosen.

**P3 — refine with use.** The `nav` page's Back key mapping (Esc vs consumer),
whether `media` belongs on the keyboard at all given the Media pane exists, and
whether `kp` survives in Terminal.

## Testing

The suite already pins the shape of the data:

- every key on every page of every layout resolves to a usage or modifier
- every page in a profile exists in the catalogue
- `landing` is always one of the profile's pages
- a profile that omits a page never links to it (the strip is built from the
  profile, so this is a data assertion)

Behaviour worth testing on hardware: a TV box's Back key, and whether a D-pad
built from arrows drives a media player's focus the way a real remote does.
