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
