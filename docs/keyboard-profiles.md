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

`landing` is highlighted in the strip but is not required to be first. Letters
stay in the same place from profile to profile; the strip remembers where they
are, and a profile that put `media` first would move the letters under the
thumb that reaches for them.

## Page catalogue

| id | What it is | Keys come from | Exists today |
|---|---|---|---|
| `abc` | letters, digits, arrows, command strip, space | `LAYOUT_ROWS[…].abc` | yes |
| `sym` | punctuation with shifted legends | `LAYOUT_ROWS[…].sym` | yes |
| `fn` | F1–F12, Home/End/PgUp/PgDn | `FN_PAGE` | yes |
| `kp` | keypad, real Keypad usages | `KP_PAGE` | yes |
| `nav` | a D-pad: big arrows, OK in the middle, Back, Home, Menu | new, see below | **new** |
| `media` | transport, volume, brightness, browser keys | media pane + 3 usages | **new** |

The two new pages are the ones the scenarios below actually need, and both are
straightforward: `nav` is eight large keys, `media` is the existing consumer
table laid out as buttons.

## Navigating between pages: the merged strip

The strip of segmented buttons that today reads `Keyboard | Media | Text` at the
head of the Keys slot becomes **the page strip**. It renders the profile's
pages, in order, followed by a pinned **Text**:

```
General    ABC · ?123 · Fn · Num                    Text
Media      ABC · Nav · Media                        Text
Texting    ABC · ?123                               Text
```

- One row, 44px chips, horizontal scroll when a custom profile has more pages
  than fit. It never wraps into a second row: a strip that changes height moves
  the keys under the thumb.
- The current page is the `on` chip — the same chip the Deck uses for its pages
  (`#23364d`, inset `1px #365b83`), because it is the same idea.
- Tapping a chip is a page switch. It does not send anything to the host.
- The strip is drawn from the profile, so a page the profile does not have is
  not drawn, not greyed out, and cannot be navigated to.

### It deletes every in-keyboard page link

Removed from the data:

| Where | Key | Target |
|---|---|---|
| `LAYOUT_ROWS.us.abc`, bottom row | `?123` | `p:sym` |
| `LAYOUT_ROWS.us.sym`, bottom row | `ABC` | `p:abc` |
| `LAYOUT_ROWS.us.sym`, bottom row | `Fn` | `p:fn` |
| `FN_PAGE`, last row | `ABC`, `Num` | `p:abc`, `p:kp` |
| `KP_PAGE`, last row | `ABC`, `Fn` | `p:abc`, `p:fn` |
| `LAYOUT_ROWS.us.abc`, first row | `Fn` | `p:fn` → the `Fn` action below |

Two of those deletions leave a ragged row behind, which is worth fixing in the
same commit rather than leaving for later:

- `FN_PAGE`'s bottom row is `ABC · Num · Home · End · PgUp · PgDn`, which
  already duplicates the row above it. Without the two page keys it is four
  duplicates, and it should be dropped.
- `KP_PAGE`'s bottom row keeps `0` and `.` only, so `0` takes two columns, the
  way the numpad mockup already draws it.

That is the whole bug this decision fixes. A profile may omit `fn`; a profile
may omit `kp`; the moment it does, a hardcoded `p:fn` is a key that goes
somewhere that no longer exists. No page link survives, so no profile can break
one.

The letter page keeps its rows: the bottom row loses `?123` and becomes
`, space . / ⏎`, so the most common page switch stops moving with the layout.

**Fn** stays in the command strip, in the same position, but it is no longer a
page code — it is an `Fn` action. When the profile has an `fn` page it switches
to it, as a second route to the same place for the left thumb, which is why the
key exists at all. When the profile has no `fn` page it opens the Fn sheet over
the current page, so the key is never dead.

**Text** is pinned at the end of the strip. It is not a page: it is the paste
box, it has no keys of its own, and it is not part of `pages`. Pinning it keeps
it out of the ordering the user edits, and keeps "paste a string into the host"
available in every profile, including Texting.

### The alternatives, and why each lost

| option | what it is | why it lost |
|---|---|---|
| One cycle key | a single key that advances to the next page, labelled with its destination | You cannot see where you are going or jump two pages. On a six-page profile a cycle key is five taps to reach the last page, and its label changes every time, so it is the one key you cannot learn by position. |
| Prev/next at the ends of the bottom row | two arrows flanking the bottom row | Occupies the two most valuable key positions on the keyboard for something pressed rarely, and it is still a cycle: a page you cannot see is a page you cannot aim at. It also puts a page switch next to space, where a mis-tap costs a sentence. |
| Horizontal swipe on the keyboard | drag the key area to change page | No affordance, and it collides with the existing gestures: a horizontal drag on a key is already a press that turned into a scroll attempt. Swipe is also the one navigation that cannot be done while holding a modifier with the other thumb. |
| **Merged strip** | the mode strip becomes the page strip | Costs no height over the strip that is already there, shows every page at once, and makes page identity visible at all times. |

The other three all keep the strip *and* add something, which is the case
against them: the strip already exists, and it is already one tap from
anywhere.

### What it costs

- `#kbModes` disappears as a concept. `Media` and `Text` stop being panes you
  switch to and become, respectively, a page a profile may include and a
  pinned action.
- `#kbSource` (Built-in / Your keyboard) is a second segmented strip at 40px
  directly under the first. Two of them is one more than the keyboard can
  afford, so **the source switch moves into Setup → Keyboard**, next to the
  profile picker. It is a choice about the phone, made once, not a page.
- A profile that omits `fn` and `kp` looks emptier than the keyboard does
  today. That is the point, and it is why the landing page matters.

## Page definitions

Both new pages are pure data: an array of rows in the same
`[code, label, alt, extra]` shape `pad.js` already renders, with a `kind` that
decides which sender a press uses.

### `nav`

Eight keys and a lot of air. Cells are 108px tall in a three-column grid, with
the four corners empty and OK in the middle.

| Key | Label | Sender | Usage | In the tables today |
|---|---|---|---|---|
| up | `↑` | keyboard, held | ArrowUp `0x52` | `HID_KEYS` |
| left | `←` | keyboard, held | ArrowLeft `0x50` | `HID_KEYS` |
| centre | `OK` | keyboard, tap | Enter `0x28` | `HID_KEYS` |
| right | `→` | keyboard, held | ArrowRight `0x4F` | `HID_KEYS` |
| down | `↓` | keyboard, held | ArrowDown `0x51` | `HID_KEYS` |
| Back | `Back` | keyboard, tap | Escape `0x29` | `HID_KEYS` |
| Home | `Home` | consumer, tap | AC Home `0x0223` | `MEDIA_KEYS` |
| Menu | `Menu` | keyboard, tap | Application `0x65` | **no — one line to add** |

The arrows go through the normal `held` path, not the consumer path, so
holding one auto-repeats on the host the way a held arrow should. The consumer
keys stay momentary press/release, as in the media pane.

`Menu` needs `Menu: 0x65` in `common.js`'s `HID_KEYS`. That is a table entry,
not a firmware change — the device forwards whatever usage the page sends. It
is called out here rather than quietly shipped because the rule for
everything else on these two pages is "a usage the keyboard already sends",
and this is the single exception.

### `media`

Five rows, two or three keys per row, 72px tall. The play key is the only one
with the accent background: it is the one you press without looking.

| Key | Label | Sender | Usage | In the tables today |
|---|---|---|---|---|
| ⏮ | prev | consumer | Scan Previous Track `0x00B6` | `MEDIA_KEYS` |
| ⏯ | play | consumer | Play/Pause `0x00CD` | `MEDIA_KEYS` |
| ⏭ | next | consumer | Scan Next Track `0x00B5` | `MEDIA_KEYS` |
| ⏹ | stop | consumer | Stop `0x00B7` | `MEDIA_KEYS` |
| 🔉 | vol − | consumer | Volume Decrement `0x00EA` | `MEDIA_KEYS` |
| 🔊 | vol + | consumer | Volume Increment `0x00E9` | `MEDIA_KEYS` |
| 🔇 | mute | consumer | Mute `0x00E2` | `MEDIA_KEYS` |
| ☀ | dim | consumer | Brightness Decrement `0x0070` | **no — add to `MEDIA_KEYS`** |
| ☀ | bright | consumer | Brightness Increment `0x006F` | **no — add to `MEDIA_KEYS`** |
| ◀ | back | consumer | AC Back `0x0224` | `MEDIA_KEYS` |
| ▶ | forward | consumer | AC Forward `0x0225` | `MEDIA_KEYS` |
| 🌐 | home | consumer | AC Home `0x0223` | `MEDIA_KEYS` |
| ⟳ | refresh | consumer | AC Refresh `0x0227` | **no — add to `MEDIA_KEYS`** |
| 🔍 | search | consumer | AC Search `0x0221` | `MEDIA_KEYS` |

The three additions are rows in `MEDIA_KEYS`, so the existing pane gets them
too; nothing else changes.

## Profile presets

| Preset | Pages, in strip order | Landing |
|---|---|---|
| General | `abc · sym · fn · kp` | `abc` |
| Media | `abc · nav · media` | `media` |
| TV | `nav · abc · sym` | `nav` |
| Terminal | `abc · sym · fn` | `abc` |
| Texting | `abc · sym` | `abc` |
| Custom | the stored list | the stored page |

Every preset also gets the pinned `Text` action; it is not part of `pages`.

`General` is exactly today's four pages, so choosing it is "the keyboard I had
before profiles existed". That is deliberate: it is also what a browser with no
stored choice gets.

## The scenarios

### General (default)
`abc · sym · fn · kp`, landing on `abc`. What exists today, plus the strip.

### Media
`abc · nav · media`, landing on `media`.

Transport and volume on the landing page, because that is the whole job.
Letters stay one tap away for typing a search term, and `nav` for moving around
a player UI. The browser keys live on `media` too — they are the same kind of
thing: single presses that drive an application.

### TV box
`nav · abc · sym`, landing on `nav`.

A D-pad first, because on a TV the arrows and OK *are* the interface. `Back`,
`Home` and `Menu` beside them. The letter page follows for entering a URL or a
Wi-Fi password, which is the only typing a TV needs.

**Open question, needs a device:** what does an Android TV box treat as
"Back"? On a USB keyboard it is usually `Esc`; some boxes map the consumer
`AC Back`. The page carries `Esc`, and the consumer usage is one row away in
`MEDIA_KEYS` if it turns out to be the one that works.

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
keyboard with the furniture removed. Two pages, two chips.

## The Custom picker

Setup → Keyboard gains a section above the host-layout selector:

1. **Preset** — six chips, wrapping to two rows: General, Media, TV, Terminal,
   Texting, Custom.
2. **Pages** — only when Custom is selected. Six rows, one per catalogue page,
   each with a toggle, a 44px ↑ and a 44px ↓. A page that is off keeps its
   position, so turning it back on puts it where it was rather than at the end.
3. **Starts on** — one row, value shown, opening a list of the enabled pages.

The host layout selector stays where it is. The two are independent: one
describes the host's key positions, the other describes what you are doing
with it.

### What is stored

| localStorage key | Value | Read by |
|---|---|---|
| `esp32remote.keyboardProfile` | `general` \| `media` \| `tv` \| `terminal` \| `texting` \| `custom` | the keyboard |
| `esp32remote.keyboardPages` | JSON array of page ids, in strip order, at most 6 | Custom only |
| `esp32remote.keyboardLanding` | one page id | Custom only |

All three live in the browser, next to `esp32remote.hostLayout` and
`esp32remote.keyboardSource`. They are per-browser UI preferences, not device
settings: the firmware never sees them, and the settings blob stays as it is.

### First run, and bad data

- **No `esp32remote.keyboardProfile`** → `general`. Nothing is written on read,
  so clearing storage returns the keyboard to General rather than to whatever
  was last shown.
- **Unknown preset name** (a value from a future build, or a typo) → `general`.
- **`custom` with an empty, unparseable or unknown-only `pages`** → `general`.
  Ids that are not in the catalogue are dropped; if nothing survives, so does
  the profile.
- **Duplicates** are removed, keeping first position.
- **`landing` not in `pages`** → the first page of `pages`.
- **`pages` longer than 6** → truncated at 6. The catalogue has exactly six.

Every read is wrapped the way the rest of the UI wraps `localStorage` (Safari in
private browsing throws on write), and the keyboard falls back to General in
memory when a write fails, so the strip still matches what is on screen.

## What has to change in the code

1. **A profile table and a resolver.** `PROFILES` maps a preset name to
   `{ name, pages, landing }`. One function reads storage and returns a
   validated profile; everything else asks it.
2. **`keyPages()` returns the profile's pages** — and only those. `buildKeyboard()`
   renders `keyPages()[keyPage]`, and `keyPage` is initialised from
   `profile.landing` rather than the string `'abc'`.
3. **A strip builder.** Renders chips from `profile.pages` plus the pinned Text
   action, marks the current one, and sets `keyPage` on tap. It replaces
   `#kbModes` in `index.html` and `setPane()` in `pad.js`.
4. **Page links leave the data** — the five keys in the table above.
5. **Two new pages** as row arrays plus their rendered layout: `nav` needs a
   grid rather than `.krow` rows, and `media` needs the consumer sender per
   key. Both are new renderers, not new key handling.
6. **Storage** for the three keys, with the fallbacks above.
7. **Setup → Keyboard** gains the picker; `#kbSource` moves into it.

## Keys and deck are the same thing

There is no principled difference between a keyboard key and a deck button.
Both are things you press that send HID. A key is "hold this while my finger is
down"; a deck button is "send this sequence". That is a difference in **action**,
not in kind — and the TV case makes it obvious: one page wants arrows (held, so
the host repeats them), `OK`, `Back`, and "Launch Netflix" together.

**A page holds controls. A control says what it sends, how it looks, and how
wide it is.**

| field | meaning |
|---|---|
| `action` | `key` (held while pressed), `chord` (one press with modifiers), `script` (a sequence with timing), `page` (jump) |
| `label`, `colour` | what it shows |
| `span` | how many columns it occupies |
| `look` | `keycap` (a keyboard key) or `tile` (a labelled button) |

The built-in keyboard becomes **default pages in that model**. The Deck becomes
**your pages in the same model**. One renderer, one press handler, one editor.

A page is also either *shown in the Keys slot* (compact, under the pad) or
*full screen* (the Deck tab). That is a property of the page, not of what it
holds, so a TV page of arrows plus two macro buttons can live in the slot while
a page of twelve macros lives full screen.

### Getting there without a rewrite

1. **Give a deck control a `key` action** — hold a usage while pressed. The
   keyboard side of that already exists; this is the missing half.
2. **Let a deck page appear in the keyboard strip**, so a profile can mean
   "these shipped pages, plus my TV page".
3. Only if that proves itself, fold the built-in keyboard into the same model.

That delivers the mixed page in a couple of hundred lines, and tests the model
against real use before committing to a refactor.

### HTML layouts

The same control model, written as markup and wired by the app's own script:

```html
<button data-action="key"    data-key="ArrowUp">↑</button>
<button data-action="script" data-steps="{SEARCH}netflix{ENTER}" data-colour="red">Netflix</button>
<button data-action="page"   data-page="media">Media</button>
```

No JavaScript from the user, so no new attack surface beyond the UI-file upload
that already exists; editable on a phone, because it is text; and it slots into
the existing UI files page.

## What this deliberately is not

- **No drag-and-drop key placement.** It looks like the natural next step and
  it is a trap: every task would start by re-arranging, and the arrangement
  would be wrong the moment the task changes. Profiles answer "which keys are
  at hand", which is the real question.
- **No long-press alternates.** Holding a key already repeats it — the host
  auto-repeats a held key — so an alternate on hold would be the same gesture
  meaning two things, decided by a timer the user cannot see. Every key does
  exactly one thing, which is why a key's label is always true.
- **No per-app detection.** The page cannot see what the host is running.
- **No automatic profile switching on device or network.** A profile is chosen,
  not inferred; a keyboard that changes shape because you walked into another
  room is worse than one you have to change yourself.

## Phases

**P1 — the strip, General only. One afternoon.**
Data plus deletion, no new UI and no new pages:

- `PROFILES` with `general` only, and a `profile()` resolver that ignores
  storage entirely and returns it.
- `keyPages()` filters to `profile.pages`; `buildKeyboard()` starts on
  `profile.landing`.
- The strip renders `profile.pages` plus pinned Text; `#kbModes` comes out
  and `setPane` is reduced to the keyboard/text switch the strip now drives.
- Delete the five page keys.

Done when: the General profile is the old keyboard with `?123` moved into the
strip, every page is one tap from every other, and no page contains a `p:`
key any more. That is verifiable by hand in a minute and by the test suite.

**P2 — the two new pages.**
`nav` and `media` as data, with their renderers and the three missing usages.
Still no picker: General does not include them, so they are reached from a
temporary `?profile=media` in the URL, which is also how the presets get
reviewed on a real phone.

**P3 — presets and the picker.**
Storage, the preset resolver's fallbacks, Setup → Keyboard, and moving
`#kbSource` in beside it.

**P4 — hardware.**
The TV profile on a real box: which key it accepts as Back, whether a D-pad
built from arrows moves focus in a media player the way a real remote does, and
whether brightness and refresh reach anything at all on the target OSes.

## Testing

The suite already pins the shape of the data:

- every key on every page of every layout resolves to a usage or modifier
- every page in a profile exists in the catalogue
- `landing` is always one of the profile's pages
- a profile that omits a page never links to it (the strip is built from the
  profile, so this is a data assertion)
- **new:** no page contains a `p:` key. The strip is the only page switch, and
  that is checkable without a browser.
- **new:** the strip has exactly `profile.pages.length + 1` chips (the pinned
  Text), with the current page `on`.
- **new:** every bad-storage case in "First run, and bad data" resolves to a
  valid profile rather than throwing.

Behaviour worth testing on hardware: a TV box's Back key, and whether a D-pad
built from arrows drives a media player's focus the way a real remote does.
