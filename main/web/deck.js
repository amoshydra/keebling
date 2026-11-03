// The key and colour catalogue shared by the Pages tab and the Keys slot.
//
// A page stores a key as an HID descriptor (page + usage) and may also keep the
// DOM code it was chosen by. This file only names them; the store is pages.js.

import { HID_KEYS } from './common.js';

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

// Keys in a page carry an HID descriptor (page + usage) and may also carry the
// DOM code they were picked by. Both shapes are read here, so a label never
// depends on which one stored it.
export function keyName(k) {
  if (!k) return '';
  const consumer = k.page === 12 || k.kind === 'consumer';
  if (consumer) {
    const hit = CONSUMER_CHOICES.find(([usage]) => usage === Number(k.usage));
    return hit ? hit[1] : `0x${Number(k.usage).toString(16)}`;
  }
  if (k.code) {
    const byCode = KEY_CHOICES.find(([code]) => code === k.code);
    if (byCode) return byCode[1];
  }
  if (k.usage !== undefined) {
    const code = Object.keys(HID_KEYS).find((c) => HID_KEYS[c] === Number(k.usage));
    const byUsage = code && KEY_CHOICES.find(([c]) => c === code);
    if (byUsage) return byUsage[1];
  }
  return k.code || `0x${Number(k.usage).toString(16)}`;
}
