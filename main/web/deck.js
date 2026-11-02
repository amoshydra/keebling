// The deck's stored shape, in one place.
//
// A deck button is a name, a colour, a page, and either a script or a held key.
// Two surfaces read this: the Deck tab, which edits and runs it full screen,
// and the Keys strip, which shows a page in the slot under the pad. They have
// different layouts and different feedback, but they must not have different
// data - a page edited in one has to be the same page in the other.
//
// Nothing here touches the DOM.

import { HID_KEYS } from './common.js';

export const STORE_KEY = 'esp32remote.macros';
export const PAGES_KEY = 'esp32remote.deckPages';
export const PAGE_KEY = 'esp32remote.deckPage';
export const DEFAULT_PAGE = 'Main';

export const COLOURS = ['', 'blue', 'amber', 'red', 'green'];

// The keys a button can hold. Keyboard codes resolve through HID_KEYS, so a
// code here is the same string the on-screen keyboard uses.
export const KEY_CHOICES = [
  ['ArrowUp', '↑ Up'], ['ArrowDown', '↓ Down'], ['ArrowLeft', '← Left'], ['ArrowRight', '→ Right'],
  ['Enter', '⏎ Enter'], ['Escape', 'Esc'], ['Tab', 'Tab'], ['Space', 'Space'],
  ['Backspace', 'Backspace'], ['Delete', 'Delete'], ['Home', 'Home'], ['End', 'End'],
  ['PageUp', 'Page Up'], ['PageDown', 'Page Down'],
];

// Consumer Control usages. The DSL's {SEARCH}-style names would only confuse
// here, where the choice is a key, not a token.
export const CONSUMER_CHOICES = [
  [0x00CD, 'Play / pause'], [0x00B5, 'Next track'], [0x00B6, 'Previous track'],
  [0x00B7, 'Stop'], [0x00E9, 'Volume up'], [0x00EA, 'Volume down'], [0x00E2, 'Mute'],
  [0x0223, 'Browser home'], [0x0224, 'Browser back'], [0x0225, 'Browser forward'],
];

export function sanitizeKey(k) {
  if (!k || typeof k !== 'object') return null;
  if (k.kind === 'key' && typeof k.code === 'string' && HID_KEYS[k.code]) {
    return { kind: 'key', code: k.code };
  }
  if (k.kind === 'consumer') {
    const usage = Number(k.usage);
    if (Number.isFinite(usage) && usage > 0 && usage <= 0xFFFF) {
      return { kind: 'consumer', usage: usage | 0 };
    }
  }
  return null;
}

export function keyName(k) {
  if (!k) return '';
  if (k.kind === 'key') {
    const hit = KEY_CHOICES.find(([code]) => code === k.code);
    return hit ? hit[1] : k.code;
  }
  const hit = CONSUMER_CHOICES.find(([usage]) => usage === k.usage);
  return hit ? hit[1] : `0x${Number(k.usage).toString(16)}`;
}

// Anything unexpected in the stored list is dropped rather than trusted: an
// older build, or a hand-edited localStorage, can have put it there.
export function sanitizeButtons(list) {
  const raw = Array.isArray(list) ? list : [];
  const kept = raw
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      name: String(m.name || ''),
      steps: String(m.steps || ''),
      colour: COLOURS.includes(m.colour) ? m.colour : '',
      page: String(m.page || DEFAULT_PAGE),
      hold: !!m.hold,
      key: sanitizeKey(m.key),
    }))
    .filter((m) => m.name || m.steps || m.key);
  return { kept, dropped: raw.length - kept.length };
}

// undefined means "nothing stored", which is how the Deck view tells an empty
// list from an untouched browser.
export function readStore() {
  try {
    const s = localStorage.getItem(STORE_KEY);
    return s === null ? undefined : JSON.parse(s);
  } catch (_) {
    // Unreadable is treated as absent. localStorage can throw rather than
    // merely fail (Safari private mode), so this is not hypothetical.
    return undefined;
  }
}

export function writeStore(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    return null;
  } catch (e) {
    return (e && e.name === 'QuotaExceededError')
      ? 'this browser has no room left for this site'
      : 'this browser refused to store them (private mode?)';
  }
}

export function readPages() {
  try {
    const raw = JSON.parse(localStorage.getItem(PAGES_KEY) || '[]');
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  } catch (_) { /* an unreadable list falls back to the one page */ }
  return [];
}

export function writePages(pages, active) {
  try { localStorage.setItem(PAGES_KEY, JSON.stringify(pages)); } catch (_) {}
  if (active) {
    try { localStorage.setItem(PAGE_KEY, active); } catch (_) {}
  }
}

// What a surface needs to draw a deck: the pages in order and the buttons on
// them. Pages that only exist because a button names them are included, so a
// restored list never hides its own contents.
export function deckSnapshot() {
  const { kept } = sanitizeButtons(readStore() || []);
  const pages = readPages();
  for (const b of kept) {
    if (!pages.includes(b.page)) pages.push(b.page);
  }
  if (!pages.length) pages.push(DEFAULT_PAGE);
  return { pages, buttons: kept };
}

export function buttonsOnPage(snapshot, page) {
  return snapshot.buttons.filter((b) => b.page === page);
}
