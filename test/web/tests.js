// In-page tests, injected by run.mjs into the control page and the settings
// page. Everything here runs in the browser against the stub device, so it
// exercises the real code rather than a reimplementation.
//
// Define __webTests with entries of the form { page, name, fn }.
// `page` is "control" or "settings"; run.mjs groups them by navigation.

const __webTests = [];

const __sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const __assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

window.__collectTests = function (page) {
  return __webTests.filter((t) => t.page === page).map((t) => t.name);
};

// Runs one named test and reports the outcome.
window.__runTest = async function (page, name) {
  const t = __webTests.find((x) => x.page === page && x.name === name);
  if (!t) return { name, ok: false, err: 'test not found' };
  try {
    await t.fn();
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, err: (e && e.message) || String(e) };
  }
};

// ---------------------------------------------------------------- helpers
const __bytes = (arr) => arr.join(',');

// Replace the socket with a recorder so we can see exactly what would go on
// the wire. pad.js declares `ws`/`wsReady` at top level, so this reaches them.
function __capture() {
  const cap = [];
  ws = { readyState: 1, send: (b) => cap.push(Array.from(b)) };
  wsReady = true;
  return cap;
}

function __pointer(type, id, pointerType, x, y) {
  pad.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType, clientX: x, clientY: y, bubbles: true,
  }));
}

function __resetInput() {
  pointers.clear();
  buttons = 0;
  mode = null;
  dragHeld = false;
  held.clear();
}

// Same idea as __capture, for the macro page: swap the socket for a recorder.
// The reconnect timer has to be stopped first, or a retry would replace the
// recorder mid-test.
function __macroCapture() {
  clearTimeout(reconnectTimer);
  reconnectTimer = 1;                  // keeps scheduleReconnect() from arming
  const cap = [];
  ws = { readyState: 1, send: (b) => cap.push(Array.from(b)) };
  wsReady = true;
  return cap;
}

// What the page would put on the wire for one macro, without a socket.
async function __playMacro(text) {
  const cap = [];
  const parsed = parseMacro(text);
  const result = await runMacro(parsed.steps, {
    send: (b) => cap.push(Array.from(b)),
    gapMs: 2,
  });
  return { cap, parsed, result };
}

// ---------------------------------------------------------------- control page
__webTests.push({
  page: 'control',
  name: 'authenticated: no code prompt on the bare URL',
  fn: async () => {
    await __sleep(400);
    __assert(!document.getElementById('gate'),
      'gate element exists - the saved code was not restored');
    __assert(localStorage.getItem('esp32remote.token') === window.__CODE,
      'token not stored');
  },
});

__webTests.push({
  page: 'control',
  name: 'keyboard report keeps held keys when typing',
  fn: async () => {
    __resetInput();
    held.add('KeyA');
    const a = __bytes(buildKeyboardReport(null, false));
    __assert(a === '2,0,4,0,0,0,0,0', `A alone sent ${a}`);

    const ab = __bytes(buildKeyboardReport('KeyB', false));
    __assert(ab === '2,0,4,5,0,0,0,0', `A+B sent ${ab} - held key was dropped`);

    const shifted = __bytes(buildKeyboardReport('KeyB', true));
    __assert(shifted === '2,2,4,5,0,0,0,0', `shift+B sent ${shifted}`);
    __resetInput();
  },
});

__webTests.push({
  page: 'control',
  name: 'US QWERTY character map',
  fn: async () => {
    const cases = [
      ['a', 'KeyA', false], ['A', 'KeyA', true],
      ['1', 'Digit1', false], ['!', 'Digit1', true],
      ['"', 'Quote', true], ['|', 'Backslash', true],
      [' ', 'Space', false], ['\n', 'Enter', false], ['\t', 'Tab', false],
    ];
    for (const [ch, code, shift] of cases) {
      const got = TYPE_MAP[ch];
      __assert(got && got[0] === code && got[1] === shift,
        `'${ch}' mapped to ${JSON.stringify(got)}, expected ${code}/${shift}`);
    }
    __assert(!TYPE_MAP['\u00e9'], 'a non-ASCII character was mapped');
  },
});

__webTests.push({
  page: 'control',
  name: 'one-finger tap sends a left click',
  fn: async () => {
    __resetInput();
    const cap = __capture();
    __pointer('pointerdown', 1, 'touch', 100, 100);
    await __sleep(30);
    __pointer('pointerup', 1, 'touch', 100, 100);
    await __sleep(60);
    __assert(__bytes(cap[0]) === '1,0,0,1,0', `press sent ${__bytes(cap[0] || [])}`);
    const release = cap.find((r) => r[0] === 1 && r[3] === 0);
    __assert(release, 'no release report');
  },
});

__webTests.push({
  page: 'control',
  name: 'two-finger tap sends a right click',
  fn: async () => {
    __resetInput();
    const cap = __capture();
    __pointer('pointerdown', 1, 'touch', 100, 100);
    __pointer('pointerdown', 2, 'touch', 140, 100);
    await __sleep(30);
    __pointer('pointerup', 1, 'touch', 100, 100);
    __pointer('pointerup', 2, 'touch', 140, 100);
    await __sleep(60);
    __assert(__bytes(cap[0]) === '1,0,0,2,0', `press sent ${__bytes(cap[0] || [])}`);
  },
});

__webTests.push({
  page: 'control',
  name: 'one-finger drag moves the cursor',
  fn: async () => {
    __resetInput();
    const cap = __capture();
    __pointer('pointerdown', 1, 'touch', 100, 100);
    for (let i = 1; i <= 5; i++) {
      __pointer('pointermove', 1, 'touch', 100 + i * 12, 100 + i * 6);
      await __sleep(5);
    }
    __pointer('pointerup', 1, 'touch', 160, 130);
    await __sleep(20);
    const moves = cap.filter((r) => r[0] === 1 && (r[1] || r[2]));
    __assert(moves.length >= 3, `only ${moves.length} move reports`);
  },
});

__webTests.push({
  page: 'control',
  name: 'two-finger drag scrolls, natural direction',
  fn: async () => {
    const run = async (dy) => {
      __resetInput();
      const cap = __capture();
      __pointer('pointerdown', 1, 'touch', 100, 100);
      __pointer('pointerdown', 2, 'touch', 140, 100);
      let y = 100;
      for (let i = 0; i < 10; i++) {
        y += dy;
        __pointer('pointermove', 1, 'touch', 100, y);
        __pointer('pointermove', 2, 'touch', 140, y);
        await __sleep(4);
      }
      __pointer('pointerup', 1, 'touch', 100, y);
      __pointer('pointerup', 2, 'touch', 140, y);
      await __sleep(20);
      return cap.filter((r) => r[0] === 1 && r[4]).map((r) => (r[4] > 127 ? r[4] - 256 : r[4]));
    };

    const down = await run(+8);
    __assert(down.length && down.every((v) => v > 0),
      `swiping down scrolled ${JSON.stringify(down)} - expected positive (up)`);

    const up = await run(-8);
    __assert(up.length && up.every((v) => v < 0),
      `swiping up scrolled ${JSON.stringify(up)} - expected negative (down)`);
  },
});

__webTests.push({
  page: 'control',
  name: 'three-finger drag presses, moves, releases',
  fn: async () => {
    __resetInput();
    const cap = __capture();
    __pointer('pointerdown', 1, 'touch', 100, 100);
    __pointer('pointerdown', 2, 'touch', 140, 100);
    __pointer('pointerdown', 3, 'touch', 120, 140);
    for (let i = 1; i <= 4; i++) {
      __pointer('pointermove', 1, 'touch', 100 + i * 10, 100 + i * 5);
      __pointer('pointermove', 2, 'touch', 140 + i * 10, 100 + i * 5);
      __pointer('pointermove', 3, 'touch', 120 + i * 10, 140 + i * 5);
      await __sleep(5);
    }
    __pointer('pointerup', 1, 'touch', 140, 120);
    __pointer('pointerup', 2, 'touch', 180, 120);
    __pointer('pointerup', 3, 'touch', 160, 160);
    await __sleep(20);

    __assert(__bytes(cap[0]) === '1,0,0,1,0', `did not press first: ${__bytes(cap[0] || [])}`);
    const dragged = cap.filter((r) => r[0] === 1 && r[3] === 1 && (r[1] || r[2]));
    __assert(dragged.length >= 3, `only ${dragged.length} drag reports with the button held`);
    const last = cap[cap.length - 1];
    __assert(__bytes(last) === '1,0,0,0,0', `did not release: ${__bytes(last)}`);
  },
});

__webTests.push({
  page: 'control',
  name: 'touch never requests pointer lock',
  fn: async () => {
    __resetInput();
    let locks = 0;
    const orig = pad.requestPointerLock;
    pad.requestPointerLock = () => { locks++; };
    try {
      __pointer('pointerdown', 1, 'touch', 100, 100);
      await __sleep(20);
      __pointer('pointerup', 1, 'touch', 100, 100);
      __assert(locks === 0, `a touch requested pointer lock ${locks} times`);
    } finally {
      pad.requestPointerLock = orig;
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'mouse does request pointer lock',
  fn: async () => {
    let locks = 0;
    const orig = pad.requestPointerLock;
    pad.requestPointerLock = () => { locks++; };
    try {
      __pointer('pointerdown', 9, 'mouse', 100, 100);
      __assert(locks === 1, `mouse requested pointer lock ${locks} times, expected 1`);
    } finally {
      pad.requestPointerLock = orig;
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'virtual key stays held until released',
  fn: async () => {
    __resetInput();
    const cap = __capture();
    const key = document.querySelector('.k[data-code="KeyW"]');
    __assert(key, 'no KeyW in the virtual keyboard');

    key.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 10, bubbles: true,
    }));
    await __sleep(30);
    __assert(held.has('KeyW'), 'key not held after pointerdown');

    // A long press must not release it by itself.
    await __sleep(120);
    __assert(held.has('KeyW'), 'key released by itself during a hold');

    key.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 10, bubbles: true,
    }));
    await __sleep(20);
    __assert(!held.has('KeyW'), 'key still held after pointerup');

    const pressed = cap.find((r) => r[0] === 2 && r[2] === KEY.KeyW);
    __assert(pressed, 'no keyboard report containing KeyW');
  },
});

__webTests.push({
  page: 'control',
  name: 'media key sends a consumer report',
  fn: async () => {
    __resetInput();
    const cap = __capture();
    const el = document.querySelector('#media .m');
    __assert(el, 'media panel is empty');

    el.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 4, pointerType: 'touch', clientX: 10, clientY: 10, bubbles: true,
    }));
    await __sleep(20);
    el.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 4, pointerType: 'touch', clientX: 10, clientY: 10, bubbles: true,
    }));
    await __sleep(20);

    const press = cap.find((r) => r[0] === 3 && (r[1] || r[2]));
    __assert(press, 'no consumer report was sent');
    const release = cap.find((r) => r[0] === 3 && !r[1] && !r[2]);
    __assert(release, 'no consumer release report was sent');
  },
});

// ---------------------------------------------------------------- settings page
__webTests.push({
  page: 'settings',
  name: 'settings form binds to device values',
  fn: async () => {
    await __sleep(300);
    __assert(!document.getElementById('gate'), 'settings page asked for the code');
    const v = (id) => { const e = document.getElementById(id); return e && (e.type === 'checkbox' ? e.checked : e.value); };
    __assert(v('usbProduct') === 'ESP32 Remote', `usbProduct = ${v('usbProduct')}`);
    __assert(v('screenTimeout') === '10', `screenTimeout = ${v('screenTimeout')}`);
    __assert(v('typeSpeed') === '20', `typeSpeed = ${v('typeSpeed')}`);
    __assert(document.getElementById('screenTimeoutVal').textContent === '10 s',
      'range label not rendered');
  },
});

__webTests.push({
  page: 'settings',
  name: 'edits save to the device automatically',
  fn: async () => {
    document.getElementById('typeSpeed').value = '35';
    document.getElementById('typeSpeed').dispatchEvent(new Event('input', { bubbles: true }));
    // Debounced at 700 ms.
    await __sleep(1400);
    const note = document.getElementById('saveNote').textContent;
    __assert(note.includes('saved'), `status line says "${note}"`);
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen timeout of 0 reads as never',
  fn: async () => {
    document.getElementById('screenTimeout').value = '0';
    document.getElementById('screenTimeout').dispatchEvent(new Event('input', { bubbles: true }));
    __assert(document.getElementById('screenTimeoutVal').textContent === 'never',
      `label is "${document.getElementById('screenTimeoutVal').textContent}"`);
    await __sleep(900);
  },
});

// ---------------------------------------------------------------- macro DSL
__webTests.push({
  page: 'settings',
  name: 'HID descriptor decodes into a readable tree',
  fn: async () => {
    document.getElementById('hidLoad').click();
    await __sleep(600);
    const lines = document.getElementById('hidDecoded').textContent.split('\n');
    __assert(lines.length >= 8, `only ${lines.length} decoded lines`);
    __assert(lines[0].includes('Generic Desktop'), `first line: ${lines[0]}`);
    __assert(lines.some((l) => l.includes('Report ID (1)')), 'no report ID decoded');
    __assert(lines.some((l) => l.includes('224..231')), 'modifier usage range missing');
    __assert(lines.some((l) => l.includes('End Collection')), 'collection not closed');
    const summary = document.getElementById('hidSummary').textContent;
    __assert(summary.includes('serial'), `summary missing serial: ${summary}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: the worked example parses to media key, text, Enter',
  fn: async () => {
    const p = parseMacro('{SEARCH}chrome{ENTER}');
    __assert(!p.errors.length, `errors: ${JSON.stringify(p.errors)}`);
    __assert(p.steps.length === 3, `steps: ${JSON.stringify(p.steps)}`);
    const [a, b, c] = p.steps;
    __assert(a.kind === 'consumer' && a.usage === 0x221, `first step: ${JSON.stringify(a)}`);
    __assert(b.kind === 'text' && b.text === 'chrome', `second step: ${JSON.stringify(b)}`);
    __assert(c.kind === 'key' && c.usage === 0x28 && c.mod === 0, `third step: ${JSON.stringify(c)}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: named keys, case insensitive',
  fn: async () => {
    const named = {
      ENTER: 0x28, TAB: 0x2B, ESC: 0x29, ESCAPE: 0x29, BKSP: 0x2A, DEL: 0x4C,
      UP: 0x52, DOWN: 0x51, LEFT: 0x50, RIGHT: 0x4F,
      HOME: 0x4A, END: 0x4D, PGUP: 0x4B, PGDN: 0x4E, SPACE: 0x2C,
    };
    for (const [name, usage] of Object.entries(named)) {
      const p = parseMacro(`{${name}}`);
      __assert(!p.errors.length, `{${name}}: ${JSON.stringify(p.errors)}`);
      __assert(p.steps.length === 1 && p.steps[0].kind === 'key' && p.steps[0].usage === usage,
        `{${name}} parsed to ${JSON.stringify(p.steps)}`);
    }
    const lower = parseMacro('{enter}');
    __assert(lower.steps[0] && lower.steps[0].usage === 0x28, 'tokens should not be case sensitive');
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: media and browser tokens carry consumer usages',
  fn: async () => {
    const media = {
      PLAYPAUSE: 0xCD, NEXTTRACK: 0xB5, PREVTRACK: 0xB6, STOP: 0xB7,
      VOLUMEUP: 0xE9, VOLUMEDOWN: 0xEA, MUTE: 0xE2, SEARCH: 0x221, CALC: 0x192,
      BROWSERHOME: 0x223, BROWSERBACK: 0x224, BROWSERFORWARD: 0x225,
    };
    for (const [name, usage] of Object.entries(media)) {
      const p = parseMacro(`{${name}}`);
      __assert(!p.errors.length, `{${name}}: ${JSON.stringify(p.errors)}`);
      __assert(p.steps.length === 1 && p.steps[0].kind === 'consumer' && p.steps[0].usage === usage,
        `{${name}} parsed to ${JSON.stringify(p.steps)}`);
    }
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: modifier combinations',
  fn: async () => {
    const cases = [
      ['{CTRL+C}', 0x01, 0x06],
      ['{CMD+SPACE}', 0x08, 0x2C],
      ['{CTRL+ALT+DEL}', 0x05, 0x4C],
      ['{SHIFT+TAB}', 0x02, 0x2B],
    ];
    for (const [text, mod, usage] of cases) {
      const p = parseMacro(text);
      __assert(!p.errors.length, `${text}: ${JSON.stringify(p.errors)}`);
      const s = p.steps[0];
      __assert(s && s.kind === 'key' && s.mod === mod && s.usage === usage,
        `${text} parsed to ${JSON.stringify(s)}, expected mod ${mod} usage ${usage}`);
    }
    // A character carries its own key, not its own shift: {CTRL+C} is Ctrl+C,
    // and {CTRL+SHIFT+C} is written out when that is what is wanted.
    const shifted = parseMacro('{CTRL+SHIFT+C}');
    __assert(shifted.steps[0].mod === 0x03, `{CTRL+SHIFT+C} mod ${shifted.steps[0].mod}`);
    const typed = parseMacro('C');
    __assert(typed.steps[0].kind === 'text' && typed.steps[0].text === 'C', 'plain C should be text');
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: {{ and }} are literal braces',
  fn: async () => {
    const p = parseMacro('{{ENTER}}');
    __assert(!p.errors.length, `errors: ${JSON.stringify(p.errors)}`);
    __assert(p.steps.length === 1 && p.steps[0].kind === 'text' && p.steps[0].text === '{ENTER}',
      `{{ENTER}} parsed to ${JSON.stringify(p.steps)}`);

    const q = parseMacro('a}}b');
    __assert(q.steps[0].text === 'a}b', `a}}b parsed to ${JSON.stringify(q.steps[0])}`);

    const mixed = parseMacro('{SPACE}{{');
    __assert(mixed.steps.length === 2
      && mixed.steps[0].kind === 'key' && mixed.steps[0].usage === 0x2C
      && mixed.steps[1].kind === 'text' && mixed.steps[1].text === '{',
      `{SPACE}{{ parsed to ${JSON.stringify(mixed.steps)}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: an unrecognised token is an error, never skipped',
  fn: async () => {
    const cases = [
      ['{FROBNICATE}', 'FROBNICATE'],
      ['typing {NOPE} here', 'NOPE'],
      ['{CTRL+NOPE}', 'NOPE'],
      ['{FOO+BAR}', 'FOO'],
    ];
    for (const [text, expected] of cases) {
      const p = parseMacro(text);
      __assert(p.errors.length, `${text} produced no error`);
      __assert(!p.errors.some((e) => !e.token || !e.message),
        `${text} errors carry no token or message: ${JSON.stringify(p.errors)}`);
      const named = p.errors.map((e) => e.token.toUpperCase()).join(' ');
      __assert(named.includes(expected), `${text} did not name ${expected}: ${named}`);
    }
    const p = parseMacro('abc{FROBNICATE}def');
    __assert(p.errors[0].token === '{FROBNICATE}', `token was ${p.errors[0].token}`);
    __assert(p.errors[0].index === 3, `index was ${p.errors[0].index}`);
    // The text either side still parses, so the editor can show the plan.
    __assert(p.steps.length === 2 && p.steps[0].text === 'abc' && p.steps[1].text === 'def',
      `steps: ${JSON.stringify(p.steps)}`);

    const open = parseMacro('{ENTER');
    __assert(open.errors.length === 1 && /closing/.test(open.errors[0].message),
      `unterminated token gave ${JSON.stringify(open.errors)}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: delays',
  fn: async () => {
    const p = parseMacro('{WAIT:500}');
    __assert(p.steps.length === 1 && p.steps[0].kind === 'wait' && p.steps[0].ms === 500,
      `{WAIT:500} parsed to ${JSON.stringify(p.steps)}`);
    for (const bad of ['{WAIT}', '{WAIT:}', '{WAIT:abc}', '{WAIT:-5}', '{WAIT:60001}']) {
      const q = parseMacro(bad);
      __assert(q.errors.length === 1 && q.steps.length === 0, `${bad} parsed to ${JSON.stringify(q)}`);
    }
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: literal text uses the US QWERTY map',
  fn: async () => {
    // The same characters the control page pins, in HID usages: the two maps
    // are separate tables and this is what keeps them honest.
    const cases = [
      ['a', 0x04, 0], ['A', 0x04, 0x02], ['5', 0x22, 0], ['!', 0x1E, 0x02],
      ['"', 0x34, 0x02], ['|', 0x31, 0x02], [' ', 0x2C, 0], ['\n', 0x28, 0], ['\t', 0x2B, 0],
    ];
    for (const [ch, usage, mod] of cases) {
      const entry = MACRO_TEXT[ch];
      __assert(entry && entry[0] === usage && entry[1] === !!mod,
        `'${ch}' mapped to ${JSON.stringify(entry)}, expected ${usage}/${mod}`);
    }
    __assert(!MACRO_TEXT['\u00e9'], 'a non-ASCII character was mapped');

    const p = parseMacro('caf\u00e9');
    __assert(!p.errors.length, 'a non-ASCII character should warn, not error');
    __assert(p.warnings.length === 1 && p.warnings[0].ch === '\u00e9',
      `warnings: ${JSON.stringify(p.warnings)}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: a run sends the reports the parser describes',
  fn: async () => {
    const { cap, result } = await __playMacro('{SEARCH}ab{ENTER}');
    __assert(!result.stopped && result.ran === 3, `run reported ${JSON.stringify(result)}`);
    __assert(result.chars === 2, `chars: ${result.chars}`);

    __assert(__bytes(cap[0]) === '3,33,2', `Search press: ${__bytes(cap[0])}`);
    __assert(__bytes(cap[1]) === '3,0,0', `Search release: ${__bytes(cap[1])}`);
    __assert(__bytes(cap[2]) === '2,0,4,0,0,0,0,0', `'a' press: ${__bytes(cap[2])}`);
    __assert(__bytes(cap[3]) === '2,0,0,0,0,0,0,0', `'a' release: ${__bytes(cap[3])}`);
    __assert(__bytes(cap[4]) === '2,0,5,0,0,0,0,0', `'b' press: ${__bytes(cap[4])}`);
    const enter = cap.find((r) => r[0] === 2 && r[2] === 0x28);
    __assert(enter, 'no Enter report');
    __assert(__bytes(cap[cap.length - 1]) === '2,0,0,0,0,0,0,0',
      `the last report should be a release: ${__bytes(cap[cap.length - 1])}`);

    const shift = await __playMacro('A');
    __assert(__bytes(shift.cap[0]) === '2,2,4,0,0,0,0,0', `Shift+A press: ${__bytes(shift.cap[0])}`);

    const combo = await __playMacro('{CTRL+ALT+DEL}');
    __assert(__bytes(combo.cap[0]) === '2,5,76,0,0,0,0,0', `Ctrl+Alt+Del press: ${__bytes(combo.cap[0])}`);

    const wait = await __playMacro('{WAIT:120}');
    __assert(wait.result.ran === 1, 'the delay step did not run');
    __assert(wait.cap.length === 0, 'a delay sent a report');
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: a stop lands between characters and releases',
  fn: async () => {
    const cap = [];
    const typed = () => cap.filter((r) => r[0] === 2 && r[2] !== 0).length;
    const result = await runMacro(parseMacro('abcde').steps, {
      send: (b) => cap.push(Array.from(b)),
      gapMs: 2,
      stopped: () => typed() >= 2,
    });
    __assert(result.stopped, `run was not stopped: ${JSON.stringify(result)}`);
    __assert(result.chars === 2, `${result.chars} characters ran, expected 2`);
    __assert(typed() === 2, `sent ${typed()} key presses`);
    // Keys and media keys both get released on the way out, so a stop cannot
    // leave something held down.
    const tail = cap.slice(-2).map(__bytes).join(' | ');
    __assert(tail === '2,0,0,0,0,0,0,0 | 3,0,0',
      `stopping left something held: ${tail}`);

    // A long delay is interruptible too, rather than running to its end.
    const started = Date.now();
    const waited = await runMacro(parseMacro('{WAIT:5000}{ENTER}').steps, {
      send: () => {},
      gapMs: 2,
      stopped: () => Date.now() - started > 60,
    });
    __assert(waited.stopped && Date.now() - started < 1000,
      `the delay was not interruptible (${Date.now() - started} ms)`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: characters with no key are reported, not hidden',
  fn: async () => {
    const { result } = await __playMacro('caf\u00e9!');
    __assert(result.chars === 4, `typed ${result.chars} characters, expected 4`);
    __assert(result.skipped.length === 1 && result.skipped[0] === '\u00e9',
      `skipped: ${JSON.stringify(result.skipped)}`);
  },
});

// ---------------------------------------------------------------- macro page
__webTests.push({
  page: 'macros',
  name: 'macro page lists the stored macros',
  fn: async () => {
    await __sleep(400);
    __assert(!document.getElementById('gate'), 'the macro page asked for the code');

    const cards = [...document.querySelectorAll('.macro')];
    __assert(cards.length === 3, `listed ${cards.length} macros, expected the 3 stored`);
    const names = cards.map((c) => c.querySelector('.name').textContent).join('|');
    __assert(names === 'Open Chrome|Screenshot|Broken', `names: ${names}`);
    __assert(cards[0].querySelector('.src').textContent === '{SEARCH}chrome{ENTER}',
      `source: ${cards[0].querySelector('.src').textContent}`);
    __assert(cards[2].querySelector('.bad'), 'the macro with an unknown token was not flagged');
    __assert(cards[0].querySelector('.run').textContent.includes('Run'), 'no Run button');

    const meter = document.getElementById('blobMeter').textContent;
    __assert(/\/ 1023 bytes/.test(meter), `the size meter says: ${meter}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'macro page runs a stored macro and shows progress',
  fn: async () => {
    const cap = __macroCapture();
    document.querySelector('.macro .run').click();
    await __sleep(1500);

    __assert(document.getElementById('runbar').classList.contains('show'),
      'the progress bar is hidden while and after a run');
    const keys = cap.filter((r) => r[0] === 2 && r[2] !== 0).map((r) => r[2]);
    __assert(keys.length >= 7, `only ${keys.length} key presses for {SEARCH}chrome{ENTER}`);
    __assert(cap.some((r) => r[0] === 3 && r[1] === 0x21 && r[2] === 0x02), 'no Search report');
    __assert(cap.some((r) => r[0] === 2 && r[2] === 0x28), 'no Enter report');
    const fill = document.getElementById('runFill').style.width;
    __assert(fill === '100%', `progress ended at ${fill}`);
    const note = document.getElementById('runStep').textContent;
    __assert(note.includes('done'), `the progress line says: ${note}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'macro page refuses to run an unrecognised token',
  fn: async () => {
    const cap = __macroCapture();
    const cards = [...document.querySelectorAll('.macro')];
    const broken = cards.find((c) => c.querySelector('.bad'));
    broken.querySelector('.run').click();
    await __sleep(200);

    __assert(!cap.length, `${cap.length} reports were sent for a macro that cannot parse`);
    const note = document.getElementById('runStep').textContent;
    __assert(note.includes('{NOPE}'), `the progress line says: ${note}`);
    __assert(document.getElementById('runbar').classList.contains('error'), 'not shown as an error');
  },
});

__webTests.push({
  page: 'macros',
  name: 'macro page adds a macro and saves it',
  fn: async () => {
    document.getElementById('macroAdd').click();
    __assert(document.getElementById('editor').classList.contains('show'), 'the editor did not open');

    // The token chips are how the braces get typed on a phone keyboard.
    const chip = (label) => [...document.querySelectorAll('#chips button')]
      .find((b) => b.textContent === label);
    __assert(chip('ENTER'), 'no ENTER chip');
    chip('ENTER').click();
    chip('WAIT:500').click();
    __assert(document.getElementById('editSteps').value === '{ENTER}{WAIT:500}',
      `chips inserted ${JSON.stringify(document.getElementById('editSteps').value)}`);

    document.getElementById('editName').value = 'Test Macro';
    const steps = document.getElementById('editSteps');
    steps.value = '{VOLUMEUP}x{{y}}';
    steps.dispatchEvent(new Event('input', { bubbles: true }));
    await __sleep(50);

    const preview = document.getElementById('parsePreview').textContent;
    __assert(preview.includes('{VOLUMEUP} (media key)'), `preview: ${preview}`);
    __assert(preview.includes('x{y}'), `preview did not show the escaped text: ${preview}`);

    document.getElementById('editSave').click();
    await __sleep(500);
    __assert(!document.getElementById('editor').classList.contains('show'), 'the editor stayed open');
    const names = [...document.querySelectorAll('.macro .name')].map((e) => e.textContent);
    __assert(names.includes('Test Macro'), `list: ${names.join('|')}`);
    __assert(document.getElementById('saveNote').textContent.includes('saved'),
      `note: ${document.getElementById('saveNote').textContent}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'macro page refuses a set that is over the settings limit',
  fn: async () => {
    const before = document.querySelectorAll('.macro').length;
    document.getElementById('macroAdd').click();
    const steps = document.getElementById('editSteps');
    steps.value = 'a'.repeat(1200);
    steps.dispatchEvent(new Event('input', { bubbles: true }));
    await __sleep(50);

    const meter = document.getElementById('blobMeter').textContent;
    __assert(meter.includes('over') && /\d+ \/ 1023 bytes/.test(meter), `meter: ${meter}`);

    document.getElementById('editSave').click();
    await __sleep(200);
    const note = document.getElementById('saveNote').textContent;
    __assert(note.includes('over'), `note: ${note}`);
    __assert(document.querySelectorAll('.macro').length === before,
      'a rejected macro reached the list');

    document.getElementById('editCancel').click();
    await __sleep(20);
    __assert(!document.getElementById('blobMeter').textContent.includes('over'),
      'the meter stayed over after cancelling');
  },
});

__webTests.push({
  page: 'macros',
  name: 'macro page deletes on a second tap',
  fn: async () => {
    const find = (name) => [...document.querySelectorAll('.macro')]
      .find((c) => c.querySelector('.name').textContent === name);
    const tap = (card, label) => {
      const b = [...card.querySelectorAll('.acts button')].find((x) => x.textContent === label);
      __assert(b, `no ${label} button on the card`);
      b.click();
    };

    const before = document.querySelectorAll('.macro').length;
    tap(find('Test Macro'), 'Delete');
    await __sleep(30);
    __assert(document.querySelectorAll('.macro').length === before,
      'the first tap deleted the macro');
    __assert(find('Test Macro'), 'the macro vanished before the confirmation');

    tap(find('Test Macro'), 'Delete?');
    await __sleep(500);
    __assert(!find('Test Macro'), 'the second tap did not delete the macro');
    __assert(document.getElementById('saveNote').textContent.includes('saved'),
      `note: ${document.getElementById('saveNote').textContent}`);
  },
});

// ---------------------------------------------------------------- control page, wide
// The same page at a desktop width: the two-row phone layout must not follow
// it there.
__webTests.push({
  page: 'control-desktop',
  name: 'desktop keeps the controls on one row and panels independent',
  fn: async () => {
    __assert(window.innerWidth > 620, `viewport is ${window.innerWidth}px, expected a desktop one`);
    const bar = document.getElementById('controls');
    const mids = [...bar.children].map((el) => {
      const r = el.getBoundingClientRect();
      return Math.round((r.top + r.bottom) / 2);
    });
    const geom = [...bar.children]
      .map((el) => `${el.id}:${Math.round(el.getBoundingClientRect().top)}+${Math.round(el.getBoundingClientRect().height)}`)
      .join(' ');
    __assert(new Set(mids).size === 1, `the controls wrapped onto ${new Set(mids).size} rows: ${geom}`);
    __assert(bar.getBoundingClientRect().height <= 60,
      `the controls bar is ${Math.round(bar.getBoundingClientRect().height)}px tall`);

    document.getElementById('bKbd').click();
    __assert(document.getElementById('kbd').classList.contains('show'), 'the keyboard did not open');
    document.getElementById('bMedia').click();
    __assert(document.getElementById('kbd').classList.contains('show'),
      'opening a panel closed the keyboard on a desktop');
    __assert(document.getElementById('mediaPanel').classList.contains('show'), 'the media panel did not open');
  },
});

// ---------------------------------------------------------------- control page, phone
__webTests.push({
  page: 'control',
  name: 'phone: the controls fit two rows, thumbs at the bottom',
  fn: async () => {
    __assert(window.innerWidth <= 620, `viewport is ${window.innerWidth}px, expected a phone one`);
    const bar = document.getElementById('controls');
    const rect = bar.getBoundingClientRect();
    __assert(rect.height <= 130, `the controls bar is ${Math.round(rect.height)}px tall`);
    __assert(bar.scrollWidth <= bar.clientWidth + 1,
      `the controls overflow sideways (${bar.scrollWidth} > ${bar.clientWidth})`);

    const top = document.getElementById('bKbd').getBoundingClientRect().top;
    for (const id of ['bLeft', 'bRight', 'bMid', 'bRelease']) {
      const b = document.getElementById(id).getBoundingClientRect();
      __assert(b.top > top, `${id} is not below the panel toggles`);
      __assert(b.height >= 42, `${id} is only ${Math.round(b.height)}px tall`);
      __assert(b.bottom > window.innerHeight - 20, `${id} is not at the bottom of the screen`);
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'phone: one panel at a time',
  fn: async () => {
    const kbd = document.getElementById('kbd');
    const media = document.getElementById('mediaPanel');

    document.getElementById('bKbd').click();
    __assert(kbd.classList.contains('show'), 'the keyboard did not open');

    document.getElementById('bMedia').click();
    __assert(media.classList.contains('show'), 'the media panel did not open');
    __assert(!kbd.classList.contains('show'), 'the keyboard stayed open behind the media panel');

    document.getElementById('bKbd').click();
    __assert(kbd.classList.contains('show') && !media.classList.contains('show'),
      'the media panel stayed open behind the keyboard');

    // Leave the page as the other tests expect it.
    document.getElementById('bKbd').click();
    __assert(!kbd.classList.contains('show'), 'the keyboard did not close');
  },
});
