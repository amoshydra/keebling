// Macro DSL: a line of literal text plus braced tokens for the keys that are
// not characters.
//
//   {SEARCH}chrome{ENTER}    press the Search media key, type "chrome", Enter
//   {CTRL+ALT+DEL}           a modifier combination
//   {WAIT:500}               pause, in milliseconds
//   {REPEAT:3} ... {/REPEAT} repeat the tokens between them
//   {{  }}                   literal braces
//
// Text is typed through the same US QWERTY path as the Type panel: one
// press/release report pair per character, at the type_speed rate. Braced
// tokens are matched case-insensitively.
//
// This file holds the parser and the report builder and nothing else - no DOM
// and no transport - so both can be exercised directly. The page supplies the
// transport: runMacro() takes a send() function.

// HID usages, not DOM event codes: this page has no physical keyboard, and the
// wire report carries usages. Keyboard/Keypad page 0x07.

import { HID_KEYS, layoutTextMap, token } from './common.js';

export const MACRO_KEYS = {
  ENTER: 0x28, ESC: 0x29, ESCAPE: 0x29,
  BKSP: 0x2A, BACKSPACE: 0x2A, TAB: 0x2B, SPACE: 0x2C,
  F1: 0x3A, F2: 0x3B, F3: 0x3C, F4: 0x3D, F5: 0x3E, F6: 0x3F,
  F7: 0x40, F8: 0x41, F9: 0x42, F10: 0x43, F11: 0x44, F12: 0x45,
  INS: 0x49, INSERT: 0x49,
  HOME: 0x4A, PGUP: 0x4B, PAGEUP: 0x4B,
  DEL: 0x4C, DELETE: 0x4C, END: 0x4D, PGDN: 0x4E, PAGEDOWN: 0x4E,
  RIGHT: 0x4F, LEFT: 0x50, DOWN: 0x51, UP: 0x52,
};

// Modifier bits, as they appear in the keyboard report's first byte. Left-hand
// variants only: nothing here needs to tell left from right.
export const MACRO_MODS = {
  CTRL: 0x01, CONTROL: 0x01,
  SHIFT: 0x02,
  ALT: 0x04, OPT: 0x04, OPTION: 0x04,
  CMD: 0x08, COMMAND: 0x08, META: 0x08, WIN: 0x08, SUPER: 0x08,
};
export const MACRO_SHIFT = 0x02;

// Consumer Control (usage page 0x0C) - the same usages the media panel sends.
export const MACRO_CONSUMERS = {
  PLAY: 0xB0, PAUSE: 0xB1, PLAYPAUSE: 0xCD,
  NEXTTRACK: 0xB5, PREVTRACK: 0xB6, STOP: 0xB7,
  VOLUMEUP: 0xE9, VOLUMEDOWN: 0xEA, MUTE: 0xE2,
  SEARCH: 0x221, CALC: 0x192,
  BROWSERHOME: 0x223, BROWSERBACK: 0x224, BROWSERFORWARD: 0x225,
};

// US QWERTY, character -> [usage, needs shift]. Mirrors TYPE_MAP in pad.js,
// which is keyed by DOM code because the control page also drives physical and
// on-screen keyboards; both suites pin the same characters, so a divergence
// between the two tables fails a test rather than going unnoticed.
// character -> [usage, needsShift], rebuilt from the host layout in common.js so
// a macro types the same characters the keyboard would draw.
export const MACRO_TEXT = {};

export function refreshMacroText() {
  for (const k of Object.keys(MACRO_TEXT)) delete MACRO_TEXT[k];
  for (const [ch, [code, shift]] of Object.entries(layoutTextMap())) {
    const usage = HID_KEYS[code];
    if (usage !== undefined) MACRO_TEXT[ch] = [usage, !!shift];
  }
}
refreshMacroText();

// ---------------------------------------------------------------- parsing
// One token. Returns a step, or { error } - never a skipped token: a macro
// that types part of what its author wrote is worse than one that refuses to
// run and says which token it did not understand.
export function parseMacroToken(raw, index) {
  const token = '{' + raw + '}';
  const body = raw.trim();
  if (!body) return { error: 'empty token', token, index };

  const upper = body.toUpperCase();

  // {/REPEAT} closes a block. Written this way rather than {END} because END
  // is also a key - {END}, {CTRL+END} must keep working.
  if (upper === '/REPEAT') return { kind: 'repeatEnd', index, token };

  if (upper.startsWith('REPEAT')) {
    const m = /^REPEAT\s*:\s*(\d+)$/.exec(upper);
    if (!m) return { error: 'a repeat is written {REPEAT:3}', token, index };
    const n = Number(m[1]);
    if (n < 1) return { error: '{REPEAT:1} is the smallest repeat', token, index };
    if (n > 100) return { error: 'the longest repeat is {REPEAT:100}', token, index };
    return { kind: 'repeatStart', count: n, index, token };
  }

  if (upper.startsWith('WAIT')) {
    // Matched with an anchored pattern rather than split on ":" so a stray
    // colon in another token gets "not a key", not a confusing delay error.
    const m = /^WAIT\s*:\s*(\d+)$/.exec(upper);
    if (!m) return { error: 'a delay is written {WAIT:500}, in milliseconds', token, index };
    const ms = Number(m[1]);
    if (ms > 60000) return { error: 'the longest delay is {WAIT:60000}', token, index };
    return { kind: 'wait', ms, index, token };
  }

  // Modifier combination: every part but the last is a modifier, the last is
  // the key that goes down under them.
  const parts = upper.split('+');
  let mod = 0;
  for (const part of parts.slice(0, -1)) {
    const name = part.trim();
    if (!name) {
      return { error: 'a combination starts with a modifier, as in {CTRL+C}', token, index };
    }
    const bit = MACRO_MODS[name];
    if (!bit) {
      return { error: `"${name.toLowerCase()}" is not a modifier ` +
                      '(CTRL, SHIFT, ALT, CMD)', token, index };
    }
    mod |= bit;
  }

  const last = parts[parts.length - 1].trim();
  if (!last) return { error: 'a combination ends with a key, as in {CTRL+C}', token, index };

  const key = MACRO_KEYS[last];
  if (key) return { kind: 'key', usage: key, mod, index, token };

  const media = MACRO_CONSUMERS[last];
  if (media && !mod) return { kind: 'consumer', usage: media, index, token };
  if (media) {
    return { error: `${last.toLowerCase()} is a media key and takes no modifiers`,
             token, index };
  }

  // A single character stands for its key. Its own shift is not sent: the
  // point of {CTRL+C} is Ctrl+C, so write {CTRL+SHIFT+C} for Ctrl+Shift+C.
  if ([...last].length === 1 && MACRO_TEXT[last]) {
    return { kind: 'key', usage: MACRO_TEXT[last][0], mod, index, token };
  }

  return { error: `not a key, media key or delay: "${body}"`, token, index };
}

// Parse a macro into steps, plus everything about it the user needs told.
//   steps:    [{kind: 'text'|'key'|'consumer'|'wait', ...}]
//   errors:   [{index, token, message}] - the macro must not run
//   warnings: [{index, ch, message}] - characters with no US QWERTY key, which
//             a run skips and reports
export function parseMacro(text) {
  const src = String(text == null ? '' : text);
  const steps = [];
  const errors = [];
  const warnings = [];

  let buf = '';
  let bufAt = 0;
  const flush = () => {
    if (!buf) return;
    steps.push({ kind: 'text', text: buf, index: bufAt, token: buf });
    buf = '';
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === '{') {
      if (src[i + 1] === '{') {          // "{{" is a literal brace
        if (!buf) bufAt = i;
        buf += '{';
        i += 2;
        continue;
      }
      const end = src.indexOf('}', i + 1);
      if (end === -1) {
        errors.push({ index: i, token: src.slice(i),
                      message: 'unterminated token: no closing "}"' });
        break;
      }
      const raw = src.slice(i + 1, end);
      flush();
      const step = parseMacroToken(raw, i);
      if (step.error) errors.push({ index: i, token: step.token, message: step.error });
      else steps.push(step);
      i = end + 1;
      continue;
    }

    if (ch === '}' && src[i + 1] === '}') {   // "}}" is a literal brace
      if (!buf) bufAt = i;
      buf += '}';
      i += 2;
      continue;
    }

    if (!buf) bufAt = i;
    buf += ch;
    i++;
  }
  flush();

  // Fold repeat blocks into a flat list. The runner stays a plain loop, which
  // matters because it has to honour Stop at every boundary; duplicating here
  // also means a nested block is expanded before its parent copies it.
  const flat = [];
  const open = [];
  for (const step of steps) {
    if (step.kind === 'repeatStart') {
      if (open.length >= 8) {
        errors.push({ index: step.index, token: step.token,
                      message: 'repeats nest at most eight deep' });
        continue;
      }
      open.push({ step, at: flat.length });
      continue;
    }
    if (step.kind === 'repeatEnd') {
      const block = open.pop();
      if (!block) {
        errors.push({ index: step.index, token: step.token,
                      message: '{/REPEAT} without a {REPEAT:n}' });
        continue;
      }
      const body = flat.slice(block.at);
      for (let n = 1; n < block.step.count; n++) flat.push(...body);
      continue;
    }
    flat.push(step);
  }
  for (const { step } of open) {
    errors.push({ index: step.index, token: step.token,
                  message: '{REPEAT:n} has no {/REPEAT}' });
  }

  // A repeat can multiply into something no one meant to send.
  const MAX_STEPS = 2000;
  if (flat.length > MAX_STEPS) {
    errors.push({ index: 0, token: flat[MAX_STEPS].token || '',
                  message: `the expanded macro is over ${MAX_STEPS} steps` });
    flat.length = MAX_STEPS;
  }

  const out = { steps: flat, errors, warnings };

  for (const step of flat) {
    if (step.kind !== 'text') continue;
    for (const c of new Set([...step.text])) {
      // \r is a Windows line ending, dropped silently - the same call the Type
      // panel makes.
      if (c === '\r' || MACRO_TEXT[c]) continue;
      warnings.push({ index: step.index, ch: c, message: `no US QWERTY key for "${c}"` });
    }
  }

  return out;
}

// The editor stores a script as a block tree (text / tap / delay / repeat);
// the runner wants the flat steps parseMacro() produces. Both shapes are stored
// by older builds, so this accepts either and returns the runner's shape.
//
// A tap carries HID descriptors rather than DOM codes, because the editor draws
// keys from that table: [{ page, usage, code }], with modifiers first.
const MOD_BIT = { 0xE0: 0x01, 0xE1: 0x02, 0xE2: 0x04, 0xE3: 0x08,
                  0xE4: 0x10, 0xE5: 0x20, 0xE6: 0x40, 0xE7: 0x80 };

export function stepsFromBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return [];
  if (blocks.every((b) => b && typeof b.kind === 'string')) return blocks.slice();

  const out = [];
  const walk = (list) => {
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      if (b.action === 'text') {
        if (b.text) out.push({ kind: 'text', text: String(b.text) });
      } else if (b.action === 'delay') {
        out.push({ kind: 'wait', ms: Number(b.ms) || 0 });
      } else if (b.action === 'repeat') {
        out.push({ kind: 'repeatStart', count: Number(b.count) || 1 });
        walk(b.blocks || []);
        out.push({ kind: 'repeatEnd' });
      } else if (b.action === 'tap' && Array.isArray(b.keys) && b.keys.length) {
        const keys = b.keys;
        const last = keys[keys.length - 1];
        let mod = 0;
        for (const k of keys.slice(0, -1)) mod |= MOD_BIT[k && k.usage] || 0;
        const token = (last && last.code) || (last ? `0x${Number(last.usage).toString(16)}` : '?');
        if (last && last.page === 12) out.push({ kind: 'consumer', usage: last.usage, token });
        else out.push({ kind: 'key', usage: last && last.usage, mod, token });
      }
    }
  };
  walk(blocks);
  return out;
}

// Label for the progress line and the editor's preview.
export function describeMacroStep(step) {
  if (!step) return '';
  if (step.kind === 'text') return `type \u201c${step.text}\u201d`;
  if (step.kind === 'wait') return `wait ${step.ms} ms`;
  if (step.kind === 'consumer') return `${step.token} (media key)`;
  return step.token;
}

// ---------------------------------------------------------------- running
// Report builders. Mirrored from pad.js without its held-key state: a macro
// runs on its own page, so every report starts from nothing held.
export function macroKeyReport(mod, usage) {
  return new Uint8Array([0x02, mod & 0xFF, usage & 0xFF, 0, 0, 0, 0, 0]);
}
export function macroConsumerReport(usage) {
  return new Uint8Array([0x03, usage & 0xFF, (usage >> 8) & 0xFF]);
}

// Sleeps in slices, so a Stop during a long {WAIT:...} lands promptly instead
// of after the whole delay.
export async function macroSleep(ms, stopped) {
  const slice = 25;
  for (let left = ms; left > 0; left -= slice) {
    if (stopped && stopped()) return;
    await new Promise((r) => setTimeout(r, Math.min(slice, left)));
  }
}

// Play a parsed macro through send(). Callers parse first and refuse to run
// while errors are present.
//
// opts: send(bytes), gapMs (press-to-release, and between characters),
//       stopped(), onStep(i, step), onChar(typed, total)
// Returns { steps, ran, chars, skipped, stopped }.
export async function runMacro(steps, opts) {
  const send = opts.send;
  const gap = Math.max(2, Math.round(Number(opts.gapMs) || 40));
  const stopped = opts.stopped || (() => false);
  const out = { steps: steps.length, ran: 0, chars: 0, skipped: [], stopped: false };

  // Called on the way out of an interrupted run: a stop can land between a
  // press and its release, and nothing else would clear it.
  const release = () => {
    send(macroKeyReport(0, 0));
    send(macroConsumerReport(0));
  };

  outer:
  for (let i = 0; i < steps.length; i++) {
    if (stopped()) { out.stopped = true; break; }
    const step = steps[i];
    if (opts.onStep) opts.onStep(i, step, out);

    if (step.kind === 'text') {
      let chars = 0;
      for (const ch of step.text) {
        // The stop check sits before each press, never between a press and its
        // release.
        if (stopped()) { out.stopped = true; break outer; }
        if (ch === '\r') continue;
        const entry = MACRO_TEXT[ch];
        if (!entry) {
          if (!out.skipped.includes(ch)) out.skipped.push(ch);
          continue;
        }
        send(macroKeyReport(entry[1] ? MACRO_SHIFT : 0, entry[0]));
        await macroSleep(gap, null);
        send(macroKeyReport(0, 0));
        await macroSleep(gap, null);
        out.chars++;
        chars++;
        if (opts.onChar) opts.onChar(chars, step.text.length);
      }
    } else if (step.kind === 'key') {
      send(macroKeyReport(step.mod, step.usage));
      await macroSleep(Math.max(gap * 2, 30), null);
      send(macroKeyReport(0, 0));
      await macroSleep(gap, null);
    } else if (step.kind === 'consumer') {
      // Press/release pair, like the media panel: a held media key is unusual.
      send(macroConsumerReport(step.usage));
      await macroSleep(Math.max(gap * 2, 30), null);
      send(macroConsumerReport(0));
      await macroSleep(gap, null);
    } else if (step.kind === 'wait') {
      await macroSleep(step.ms, stopped);
      if (stopped()) { out.stopped = true; break; }
    }

    out.ran = i + 1;
  }

  if (out.stopped) release();
  return out;
}

// The brace text is an input, not the stored form: a deck button keeps the
// block tree and prints itself back into the editor. Kept here so the app and
// the editor print the same way.
export function macroText(steps) {
  let out = '';
  for (const step of steps || []) {
    if (step.kind === 'text') out += String(step.text || '').replace(/\{/g, '{{');
    else if (step.kind === 'wait') out += `{WAIT:${step.ms}}`;
    else if (step.kind === 'consumer') out += `{${step.token}}`;
    else if (step.kind === 'repeatStart') out += `{REPEAT:${step.count}}`;
    else if (step.kind === 'repeatEnd') out += '{/REPEAT}';
    else if (step.kind === 'key') {
      if (step.mod) out += `{${modName(step.mod)}+${step.token}}`;
      else out += `{${step.token}}`;
    }
  }
  return out;

  function modName(mod) {
    const names = [];
    if (mod & 0x01) names.push('CTRL');
    if (mod & 0x02) names.push('SHIFT');
    if (mod & 0x04) names.push('ALT');
    if (mod & 0x08) names.push('CMD');
    return names.join('+');
  }
}
