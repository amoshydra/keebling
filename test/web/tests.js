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
  name: 'a refused capture is reported, not swallowed',
  fn: async () => {
    // The shape that matters: browsers refuse a lock for about a second after
    // one is released, and that refusal is a *promise rejection*, not an
    // exception - so try/catch never saw it and the click did nothing.
    let calls = 0;
    const orig = pad.requestPointerLock;
    pad.requestPointerLock = () => {
      calls++;
      return Promise.reject(new DOMException('refused', 'NotAllowedError'));
    };
    try {
      __pointer('pointerdown', 11, 'mouse', 60, 60);
      await __sleep(80);

      __assert(calls === 1, `requestPointerLock was called ${calls} times, expected 1`);
      const flash = document.getElementById('flash');
      __assert(flash.classList.contains('show'), 'a refused capture showed nothing');
      __assert(flash.textContent.includes('click again'), `the pad said: ${flash.textContent}`);
    } finally {
      pad.requestPointerLock = orig;
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'one wheel notch is one step, in pixels or lines',
  fn: async () => {
    __resetInput();
    captured = true;
    const cap = __capture();
    try {
      // A pixel-mode notch (Chrome) is a deltaY of about 100. Dividing that by
      // 8 made one detent worth twelve clicks - about 36 lines of scroll.
      window.dispatchEvent(new WheelEvent('wheel',
        { deltaY: 100, deltaMode: 0, cancelable: true }));
      await __sleep(20);

      let wheels = cap.filter((r) => r[0] === 1 && r[4] !== 0)
        .map((r) => (r[4] > 127 ? r[4] - 256 : r[4]));
      __assert(wheels.length === 1 && wheels[0] === -1,
        `one pixel notch produced ${JSON.stringify(wheels)}, expected exactly [-1]`);

      // Line mode (Firefox) reports a deltaY of about 3, so a single notch is
      // just under a whole step. Treating that as pixels makes it worth a
      // fraction of one, and the remainder has to be carried rather than
      // dropped or the wheel crawls instead of scrolling.
      cap.length = 0;
      for (let i = 0; i < 2; i++) {
        window.dispatchEvent(new WheelEvent('wheel',
          { deltaY: 3, deltaMode: 1, cancelable: true }));
      }
      await __sleep(20);

      wheels = cap.filter((r) => r[0] === 1 && r[4] !== 0)
        .map((r) => (r[4] > 127 ? r[4] - 256 : r[4]));
      __assert(wheels.length >= 1 && wheels.every((v) => v < 0),
        `two line-mode notches produced ${JSON.stringify(wheels)}, expected negative scroll`);
    } finally {
      captured = false;
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'a movement larger than the report is split, not clamped',
  fn: async () => {
    captured = true;
    const cap = __capture();
    try {
      pad.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 12, pointerType: 'mouse', movementX: 400, movementY: 0, bubbles: true,
      }));
      await __sleep(20);

      const moves = cap.filter((r) => r[0] === 1);
      const signed = (b) => (b > 127 ? b - 256 : b);
      const total = moves.reduce((n, r) => n + signed(r[1]), 0);
      __assert(moves.length >= 4, `400px went out in ${moves.length} reports`);
      __assert(total === 400,
        `the reports add up to ${total}, not 400 - distance was silently dropped`);
      __assert(moves.every((r) => Math.abs(signed(r[1])) <= 127),
        'a report carried a delta outside the signed 8-bit field');
    } finally {
      captured = false;
    }
  },
});


__webTests.push({
  page: 'control',
  name: 'captured movement is coalesced, not sent per event',
  fn: async () => {
    // The gain is a device setting the settings-page tests also write, so pin it
    // rather than inheriting whatever the last run left behind.
    const savedGain = appSettings.mouse_gain;
    appSettings.mouse_gain = 1;
    captured = true;
    const cap = __capture();
    try {
      // A gaming mouse emits over a thousand of these a second. One WebSocket
      // message each is more than the device can drain.
      for (let i = 0; i < 20; i++) {
        pad.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 13, pointerType: 'mouse', movementX: 3, movementY: -1, bubbles: true,
        }));
      }

      // The first is already due, so it goes out at once; the rest coalesce.
      __assert(cap.length === 1,
        `${cap.length} reports went out during the burst, expected the first to be immediate`);

      await __sleep(80);
      const moves = cap.filter((r) => r[0] === 1);
      const signed = (b) => (b > 127 ? b - 256 : b);
      __assert(moves.length <= 4,
        `20 events produced ${moves.length} reports, expected them to be coalesced`);

      // Coalescing must not lose distance: every pixel of movement has to
      // arrive, just in fewer messages.
      const dx = moves.reduce((n, r) => n + signed(r[1]), 0);
      const dy = moves.reduce((n, r) => n + signed(r[2]), 0);
      __assert(dx === 60, `dx totalled ${dx}, expected 60 - distance was dropped`);
      __assert(dy === -20, `dy totalled ${dy}, expected -20 - distance was dropped`);
    } finally {
      captured = false;
      appSettings.mouse_gain = savedGain;
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
    __assert(v('screenTimeout') === '60', `screenTimeout = ${v('screenTimeout')}`);
    __assert(v('typeSpeed') === '20', `typeSpeed = ${v('typeSpeed')}`);
    __assert(document.getElementById('screenTimeoutVal').textContent === '60 s',
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
  name: 'custom screen text binds, is capped at one screen and keeps its newline',
  fn: async () => {
    const el = document.getElementById('screenText');
    __assert(el, 'no screen text field on the settings page');
    __assert(el.value === '', `field starts with "${el.value}"`);
    __assert(el.maxLength === 260, `maxlength is ${el.maxLength}, not one screen`);

    el.value = 'Bench rig 3\nport 2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // Debounced at 700 ms like every other binding.
    await __sleep(1400);
    __assert(el.value === 'Bench rig 3\nport 2', 'the line break did not survive the form');
    const note = document.getElementById('saveNote').textContent;
    __assert(note.includes('saved'), `status line says "${note}"`);
  },
});

// ---------------------------------------------------------------- backup
__webTests.push({
  page: 'settings',
  name: 'backup collects the device settings and this browser\'s macros',
  fn: async () => {
    localStorage.setItem('esp32remote.macros',
      JSON.stringify([{ name: 'Phone Only', steps: '{ENTER}' }]));

    const b = collectBackup();
    __assert(b.app === 'esp32-remote' && b.version === 1,
      `envelope: ${JSON.stringify({ app: b.app, version: b.version })}`);
    __assert(b.device && b.device.usb_product === 'ESP32 Remote',
      `device part: ${JSON.stringify(b.device)}`);
    __assert(!('macros' in b.device),
      'the device part still carries a legacy macros key');
    __assert(Array.isArray(b.macros) && b.macros.some((m) => m.name === 'Phone Only'),
      `macro part: ${JSON.stringify(b.macros)}`);
  },
});

__webTests.push({
  page: 'settings',
  name: 'a backup restores into both stores',
  fn: async () => {
    const payload = {
      app: 'esp32-remote',
      version: 1,
      device: { usb_product: 'Restored Name', screen_timeout_s: 45 },
      macros: [{ name: 'From File', steps: '{VOLUMEUP}' }],
    };
    const input = document.getElementById('backupFile');
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(payload)], 'backup.json',
      { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await __sleep(400);

    __assert(document.getElementById('usbProduct').value === 'Restored Name',
      `the form shows ${document.getElementById('usbProduct').value}`);
    __assert(document.getElementById('screenTimeout').value === '45',
      `the timeout is ${document.getElementById('screenTimeout').value}`);
    __assert(document.getElementById('screenTimeoutVal').textContent === '45 s',
      'the timeout label was not redrawn');

    const stored = JSON.parse(localStorage.getItem('esp32remote.macros') || '[]');
    __assert(stored.some((m) => m.name === 'From File'), `macros: ${JSON.stringify(stored)}`);

    const note = document.getElementById('backupNote').textContent;
    __assert(note.includes('device settings restored'), `note: ${note}`);
    __assert(/\d+ macros? restored/.test(note), `note: ${note}`);
    __assert(note.includes('Reload the Macros page'), `note: ${note}`);
  },
});

__webTests.push({
  page: 'settings',
  name: 'a file that is not a backup changes nothing',
  fn: async () => {
    const before = document.getElementById('usbProduct').value;
    const input = document.getElementById('backupFile');
    const dt = new DataTransfer();
    dt.items.add(new File(['{"app":"something-else","version":9}'], 'other.json',
      { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await __sleep(200);

    __assert(document.getElementById('usbProduct').value === before,
      'a foreign file was applied');
    const note = document.getElementById('backupNote').textContent;
    __assert(note.includes('Nothing was changed'), `note: ${note}`);
  },
});

__webTests.push({
  page: 'settings',
  name: 'a corrupt backup file is refused, not half-applied',
  fn: async () => {
    const before = document.getElementById('usbProduct').value;
    const input = document.getElementById('backupFile');
    const dt = new DataTransfer();
    dt.items.add(new File(['{not json at all'], 'broken.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await __sleep(200);

    __assert(document.getElementById('usbProduct').value === before,
      'a corrupt file changed the form');
    const note = document.getElementById('backupNote').textContent;
    __assert(note.includes('not readable as JSON'), `note: ${note}`);
  },
});


__webTests.push({
  page: 'settings',
  name: 'saving drops keys that no longer exist in the model',
  fn: async () => {
    // An older build left these in the blob, and the device stores it verbatim -
    // so every save used to carry them along for ever.
    appSettings.macros = [{ name: 'stale', steps: '{ENTER}' }];
    appSettings.hid_name = 'old name';

    const r = await saveSettingsToDevice();
    __assert(r && r.ok, 'the save did not succeed');

    __assert(!('macros' in appSettings), 'macros survived the save in memory');
    __assert(!('hid_name' in appSettings), 'hid_name survived the save in memory');
  },
});

// ---------------------------------------------------------------- HID descriptor
__webTests.push({
  page: 'settings',
  name: 'pointer gain reaches a high-DPI mouse',
  fn: async () => {
    const el = document.getElementById('mouseGain');

    // The slider carries log10(value) * 100, so the useful range for a gaming
    // mouse is a normal part of the track rather than the first few percent.
    const setGain = async (v) => {
      el.value = String(Math.round(Math.log10(v) * 100));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await __sleep(30);
    };

    await setGain(0.02);
    __assert(Math.abs(Number(appSettings.mouse_gain) - 0.02) < 0.002,
      `a slider position for 0.02 stored ${appSettings.mouse_gain}`);
    __assert(document.getElementById('mouseGainVal').textContent === '0.02x',
      `label reads ${document.getElementById('mouseGainVal').textContent}`);

    // And it survives the round trip through the device, which is where a
    // linear range would have silently clamped it.
    await setGain(0.05);
    await __sleep(1300);
    __assert(Math.abs(Number(appSettings.mouse_gain) - 0.05) < 0.005,
      `after saving, the gain is ${appSettings.mouse_gain}`);
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

// ---------------------------------------------------------------- web UI files
__webTests.push({
  page: 'settings',
  name: 'reset UI to built-in restores the embedded files',
  fn: async () => {
    __assert(document.getElementById('uiOpen'), 'no link to the UI files page');

    // The runner stores a stylesheet before this pass, so the reset has
    // something to undo.
    const before = await (await fetch('/style.css')).text();
    __assert(before.includes('uploaded before the settings pass'),
      'the runner did not store a stylesheet');

    window.confirm = () => true;   // the reset asks first
    document.getElementById('uiResetAll').click();
    await __sleep(400);

    const note = document.getElementById('uiNote').textContent;
    __assert(note.includes('built-in pages are back'), `note: ${note}`);
    const after = await (await fetch('/style.css')).text();
    __assert(after.includes('--accent'), 'the built-in stylesheet did not come back');
    __assert(!after.includes('uploaded before the settings pass'),
      'the uploaded copy is still being served');
  },
});

// ---------------------------------------------------------------- screen image
// The conversion is pure logic and it is where a silent error would produce a
// plausible-looking wrong image, so it is asserted directly: canvas -> nibbles,
// byte for byte, and the dither's own pattern rather than a threshold's.
const __greyImage = (fill) => {
  const d = new Uint8ClampedArray(160 * 80 * 4);
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 160; x++) {
      const v = typeof fill === 'function' ? fill(x, y) : fill;
      const i = (y * 160 + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  return new ImageData(d, 160, 80);
};
const __colourImage = (fill) => {
  const d = new Uint8ClampedArray(160 * 80 * 4);
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 160; x++) {
      const [r, g, b] = typeof fill === 'function' ? fill(x, y) : fill;
      const i = (y * 160 + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  return new ImageData(d, 160, 80);
};
const __sameBytes = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

__webTests.push({
  page: 'settings',
  name: 'screen image: canvas packs to 6,400 payload bytes with a header CRC',
  fn: async () => {
    // The standard CRC-32 vector, so an implementation that is wrong in the
    // same way as the firmware's cannot agree with itself and pass.
    const vector = crc32(new TextEncoder().encode('123456789'));
    __assert(vector === 0xCBF43926,
      `crc32('123456789') = 0x${vector.toString(16)}, expected 0xcbf43926`);

    const img = __greyImage(0);
    img.data[0] = img.data[1] = img.data[2] = 255;            // (0,0) white
    img.data[640] = img.data[641] = img.data[642] = 255;      // (0,1) white
    const bytes = packScreenImage(img);

    __assert(bytes.length === 6408, `the file is ${bytes.length} bytes, expected 6408`);
    __assert(bytes.length - 8 === 6400, `the payload is ${bytes.length - 8} bytes`);
    __assert(bytes[0] === 0x01, `format byte is 0x${bytes[0].toString(16)}`);
    __assert(bytes[1] === 0, `reserved byte is ${bytes[1]}`);
    __assert((bytes[2] | (bytes[3] << 8)) === 6400, 'the length field is not 6400');
    const want = crc32(bytes.subarray(8));
    const got = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
    __assert(got === want,
      `header CRC 0x${got.toString(16)} != payload CRC 0x${want.toString(16)}`);
    __assert(screenImageValid(bytes), 'the packed file does not validate');

    // Packing: high nibble is the left pixel, 80 bytes per row.
    __assert(bytes[8] === 0xF0, `row 0 byte 0 is 0x${bytes[8].toString(16)}, expected 0xf0`);
    __assert(bytes[8 + 80] === 0xF0,
      `row 1 byte 0 is 0x${bytes[8 + 80].toString(16)}, expected 0xf0`);
    __assert(bytes[8 + 79] === 0x00,
      `row 0 byte 79 is 0x${bytes[8 + 79].toString(16)}, expected 0`);
    __assert(bytes[8 + 6399] === 0x00,
      `the last byte is 0x${bytes[8 + 6399].toString(16)}, expected 0`);

    // ...and the bottom-right pair lands on exactly the last byte.
    const last = (79 * 160 + 158) * 4;
    img.data[last] = img.data[last + 1] = img.data[last + 2] = 255;   // (158,79)
    const tail = packScreenImage(img);
    __assert(tail[8 + 6399] === 0xF0,
      `the bottom-right pair packed to 0x${tail[8 + 6399].toString(16)}, expected 0xf0`);

    // Black and white are the ends of the ramp, and every payload byte moves
    // with the input rather than being left as it was.
    const black = packScreenImage(__greyImage(0));
    const white = packScreenImage(__greyImage(255));
    for (let i = 8; i < 6408; i++) {
      __assert(black[i] === 0x00, `black byte ${i} is 0x${black[i].toString(16)}`);
      __assert(white[i] === 0xFF, `white byte ${i} is 0x${white[i].toString(16)}`);
    }
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: a flat grey is dithered, not thresholded',
  fn: async () => {
    const payload = packScreenImage(__greyImage(128)).subarray(8);

    // 128/255 * 15 = 7.53, so a plain threshold gives level 8 everywhere. The
    // ordered dither must give both 7 and 8, arranged as the Bayer matrix
    // says: for this value every cell below 8 rounds down, which is a
    // checkerboard rather than a flat block.
    let sevens = 0, eights = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const b = payload[y * 80 + (x >> 1)];
        const nib = (x & 1) ? (b & 0x0F) : (b >> 4);
        const expected = ((x + y) % 2 === 0) ? 7 : 8;
        __assert(nib === expected,
          `(${x},${y}) is level ${nib}, expected ${expected}`);
        if (nib === 7) sevens++; else eights++;
      }
    }
    __assert(sevens === 8 && eights === 8,
      `a 4x4 tile has ${sevens} dark and ${eights} light cells, expected 8 each`);

    // A different input moves the boundary: at 140 (8.24 levels) only the four
    // highest Bayer cells round up.
    const higher = packScreenImage(__greyImage(140)).subarray(8);
    let nines = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const b = higher[y * 80 + (x >> 1)];
        if (((x & 1) ? (b & 0x0F) : (b >> 4)) === 9) nines++;
      }
    }
    __assert(nines === 4, `${nines} cells rounded up at 140, expected 4`);

    // Exactly on a level nothing moves: black, white and 3*17 stay put.
    for (const [v, level] of [[0, 0], [255, 15], [51, 3]]) {
      for (const b of packScreenImage(__greyImage(v)).subarray(8)) {
        __assert((b >> 4) === level && (b & 0x0F) === level,
          `grey ${v} packed to 0x${b.toString(16)}, expected level ${level} both halves`);
      }
    }

    // The dither tracks a ramp: the mean level over the image is the mean of
    // the input (15 * 0.5 = 7.5), which a threshold that ignored the input
    // would not manage.
    const ramp = packScreenImage(__greyImage((x) => Math.round(x * 255 / 159))).subarray(8);
    let sum = 0, n = 0;
    for (const b of ramp) { sum += (b >> 4) + (b & 0x0F); n += 2; }
    const mean = sum / n;
    __assert(Math.abs(mean - 7.5) < 0.15,
      `the ramp's mean level is ${mean.toFixed(3)}, expected ~7.5`);
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: the preview shows the dithered copy',
  fn: async () => {
    const canvas = document.getElementById('screenImagePreview');
    __assert(canvas && canvas.width === 160 && canvas.height === 80,
      'the preview canvas is not 160x80');

    const img = __greyImage(0);
    img.data[0] = img.data[1] = img.data[2] = 255;            // (0,0) white
    renderScreenImage(canvas, packScreenImage(img));
    const px = canvas.getContext('2d').getImageData(0, 0, 160, 80).data;
    // Level 15 comes back as 255 and level 0 as 0: the preview uses the same
    // 17*i ramp the firmware's RGB565 table is built from.
    __assert(px[0] === 255 && px[1] === 255 && px[2] === 255,
      `(0,0) previews as ${px[0]},${px[1]},${px[2]}, expected white`);
    __assert(px[8] === 0 && px[9] === 0 && px[10] === 0,
      `(2,0) previews as ${px[8]},${px[9]},${px[10]}, expected black`);

    // A dithered grey must come back as the two levels, not one flat block.
    renderScreenImage(canvas, packScreenImage(__greyImage(128)));
    const mid = canvas.getContext('2d').getImageData(0, 0, 160, 80).data;
    const seen = new Set();
    for (let i = 0; i < 4 * 4 * 4; i += 4) seen.add(mid[i]);
    __assert(seen.size === 2 && seen.has(7 * 17) && seen.has(8 * 17),
      `a flat grey previewed as levels ${[...seen].join(', ')}`);
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: colour packs to 25,600 bytes of little-endian RGB565',
  fn: async () => {
    const img = __colourImage([0, 0, 0]);
    const bytes = packScreenImage(img, 0x02);

    __assert(bytes.length === 25608, `the file is ${bytes.length} bytes, expected 25608`);
    __assert(bytes[0] === 0x02, `format byte is 0x${bytes[0].toString(16)}`);
    __assert(bytes[1] === 0, `reserved byte is ${bytes[1]}`);
    __assert((bytes[2] | (bytes[3] << 8)) === 25600, 'the length field is not 25600');
    const want = crc32(bytes.subarray(8));
    const got = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
    __assert(got === want,
      `header CRC 0x${got.toString(16)} != payload CRC 0x${want.toString(16)}`);
    __assert(screenImageValid(bytes), 'the packed file does not validate');

    // Pixel order, byte order and row stride. The payload is little-endian, so
    // the low byte of the RGB565 word comes first; 320 bytes a row means the
    // first pixel of row 1 is not the second pixel of row 0. Exact channel
    // values (0 and full) survive the dither untouched.
    const set = (x, y, [r, g, b]) => {
      const i = (y * 160 + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
    };
    set(0, 0, [255, 0, 0]);        // 0xF800 -> 00 F8
    set(1, 0, [0, 255, 0]);        // 0x07E0 -> E0 07
    set(2, 0, [0, 0, 255]);        // 0x001F -> 1F 00
    set(159, 0, [255, 255, 255]);  // 0xFFFF -> FF FF, the last pixel of row 0
    set(0, 1, [255, 0, 255]);      // 0xF81F -> 1F F8, the first pixel of row 1
    set(159, 79, [255, 255, 0]);   // 0xFFE0 -> E0 FF, the last pixel of the file
    const packed = packScreenImage(img, 0x02).subarray(8);
    const px = (x, y) => {
      const o = (y * 160 + x) * 2;
      return [packed[o], packed[o + 1]];
    };
    __assert(px(0, 0)[0] === 0x00 && px(0, 0)[1] === 0xF8,
      `(0,0) packed as ${px(0, 0)}`);
    __assert(px(1, 0)[0] === 0xE0 && px(1, 0)[1] === 0x07,
      `(1,0) packed as ${px(1, 0)}`);
    __assert(px(2, 0)[0] === 0x1F && px(2, 0)[1] === 0x00,
      `(2,0) packed as ${px(2, 0)}`);
    __assert(px(159, 0)[0] === 0xFF && px(159, 0)[1] === 0xFF,
      `(159,0) packed as ${px(159, 0)}`);
    __assert(px(0, 1)[0] === 0x1F && px(0, 1)[1] === 0xF8,
      `(0,1) packed as ${px(0, 1)}`);
    __assert(px(159, 79)[0] === 0xE0 && px(159, 79)[1] === 0xFF,
      `the last pixel packed as ${px(159, 79)}`);
    __assert(packed.length === 25600, `the payload is ${packed.length} bytes`);
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: the colour preview renders the packed 5-6-5 levels',
  fn: async () => {
    // A hand-built file, so the preview is checked against known RGB565 words
    // rather than against whatever the converter happened to produce. The CRC
    // is the page's own crc32 over the payload, the check the device runs
    // before it will draw the file.
    const bytes = new Uint8Array(25608);
    bytes[0] = 0x02;
    bytes[2] = 25600 & 0xFF;
    bytes[3] = 25600 >> 8;
    const words = [0xF800, 0x07E0, 0x001F, 0x8410];   // red, green, blue, mid grey
    for (let i = 0; i < words.length; i++) {
      bytes[8 + i * 2] = words[i] & 0xFF;
      bytes[9 + i * 2] = words[i] >> 8;
    }
    const crc = crc32(bytes.subarray(8));
    bytes[4] = crc & 0xFF; bytes[5] = (crc >> 8) & 0xFF;
    bytes[6] = (crc >> 16) & 0xFF; bytes[7] = (crc >>> 24) & 0xFF;
    __assert(screenImageValid(bytes), 'the hand-built colour file does not validate');

    const canvas = document.getElementById('screenImagePreview');
    renderScreenImage(canvas, bytes);
    const px = canvas.getContext('2d').getImageData(0, 0, 160, 80).data;
    const at = (i) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
    __assert(at(0).join() === '255,0,0', `0xF800 previewed as ${at(0)}`);
    __assert(at(1).join() === '0,255,0', `0x07E0 previewed as ${at(1)}`);
    __assert(at(2).join() === '0,0,255', `0x001F previewed as ${at(2)}`);
    // 5 bits -> 8 by bit replication, 6 -> 8: 0x8410 is r=16, g=32, b=16 and
    // must come back as 132, 130, 132.
    __assert(at(3).join() === '132,130,132', `0x8410 previewed as ${at(3)}`);
    __assert(at(4).join() === '0,0,0', `an unused pixel previewed as ${at(4)}`);
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: colour dithers each channel, not thresholds it',
  fn: async () => {
    // 128/255 is 15.56 of red's 31 levels and 31.62 of green's 63, so a plain
    // threshold gives 16/32/16 everywhere. Each channel has to cross its own
    // boundary in its own cells of the Bayer tile.
    const payload = packScreenImage(__colourImage([128, 128, 128]), 0x02).subarray(8);
    const counts = { r: new Map(), g: new Map(), b: new Map() };
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const o = (y * 160 + x) * 2;
        const v = payload[o] | (payload[o + 1] << 8);
        const r = v >> 11, g = (v >> 5) & 0x3F, b = v & 0x1F;
        __assert(r === (BAYER4[y][x] >= 7 ? 16 : 15), `red at (${x},${y}) is ${r}`);
        __assert(g === (BAYER4[y][x] >= 6 ? 32 : 31), `green at (${x},${y}) is ${g}`);
        __assert(b === (BAYER4[y][x] >= 7 ? 16 : 15), `blue at (${x},${y}) is ${b}`);
        for (const [k, n] of [['r', r], ['g', g], ['b', b]]) {
          counts[k].set(n, (counts[k].get(n) || 0) + 1);
        }
      }
    }
    // Red and blue cross in the same cells; green, with twice the levels,
    // crosses one cell earlier. All three split, which a threshold would not.
    __assert(counts.r.get(16) === 9 && counts.r.get(15) === 7,
      `red tile: ${JSON.stringify([...counts.r])}`);
    __assert(counts.g.get(32) === 10 && counts.g.get(31) === 6,
      `green tile: ${JSON.stringify([...counts.g])}`);
    __assert(counts.b.get(16) === 9 && counts.b.get(15) === 7,
      `blue tile: ${JSON.stringify([...counts.b])}`);

    // A channel exactly on a level does not move while a neighbour dithers:
    // pure blue's red and green stay 0 in every cell.
    const blue = packScreenImage(__colourImage([0, 0, 128]), 0x02).subarray(8);
    for (let i = 0; i < 4 * 4; i++) {
      const v = blue[i * 2] | (blue[i * 2 + 1] << 8);
      __assert((v >> 11) === 0 && ((v >> 5) & 0x3F) === 0,
        `pixel ${i} of a pure-blue field has red ${v >> 11}, green ${(v >> 5) & 0x3F}`);
    }
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: greyscale still packs to format 0x01, byte for byte',
  fn: async () => {
    // The format byte exists to make colour additive, so the greyscale path
    // must be unchanged by it: the files already on devices depend on that.
    const img = __greyImage((x, y) => (x * 7 + y * 13) % 256);
    const bytes = packScreenImage(img);              // the default format
    const explicit = packScreenImage(img, 0x01);
    __assert(__sameBytes(bytes, explicit), 'the default format is no longer 0x01');
    __assert(bytes.length === 6408, `the file is ${bytes.length} bytes, expected 6408`);
    __assert(bytes[0] === 0x01 && bytes[1] === 0, 'the header is no longer greyscale');
    __assert((bytes[2] | (bytes[3] << 8)) === 6400, 'the length field is not 6400');
    __assert(screenImageValid(bytes), 'a greyscale file no longer validates');

    // The same picture in colour is a different file, not the greyscale payload
    // wearing a different format byte.
    const colour = packScreenImage(img, 0x02);
    __assert(colour.length === 25608 && colour[0] === 0x02,
      `the colour file is ${colour.length} bytes, format 0x${colour[0].toString(16)}`);
    __assert(!__sameBytes(colour.subarray(8, 6408), bytes.subarray(8)),
      'colour packing produced the greyscale payload');
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: no valid image means the mode is out of the cycle',
  fn: async () => {
    await __sleep(300);   // the page checks the device on load

    // This is the question the firmware's tap cycle asks before it stops on
    // the mode, and the stub answers it the same way: nothing stored, so
    // there is no screen to land on.
    const r = await fetch(`/screen/image?token=${window.__CODE}`);
    __assert(r.status === 404, `a device with no image answered HTTP ${r.status}`);
    const note = document.getElementById('screenImageNote').textContent;
    __assert(note.includes('BOOT cycle'), `the page says: ${note}`);
    __assert(document.getElementById('screenImageClear').hidden,
      'the page offers to remove an image that is not there');
    __assert(document.getElementById('screenImageSend').disabled,
      'Send is enabled before a file has been picked');

    // The two things the panel cannot tell anyone for itself.
    const hint = document.getElementById('screenImageHint').textContent;
    __assert(/greyscale/.test(hint), `the note does not mention greyscale: ${hint}`);
    __assert(/colour/.test(hint), `the note does not mention colour: ${hint}`);
    __assert(/gamma/.test(hint), `the note does not mention gamma: ${hint}`);

    // Bodies the firmware would refuse, none of which may become an image:
    // a corrupted payload, an unknown format, a truncated body, a wrong size,
    // and both ways the size and the format byte can disagree. That last rule
    // is what keeps the two formats apart - the format byte picks the payload
    // size, so a body cannot be drawn as the format it is not.
    const good = packScreenImage(__greyImage(200));
    const colour = packScreenImage(__colourImage([10, 200, 30]), 0x02);
    const corrupt = Uint8Array.from(good);
    corrupt[8 + 10] ^= 0xFF;
    const unknown = Uint8Array.from(good);
    unknown[0] = 0x03;
    // A body that claims 0x02 at the greyscale size, with a CRC over the bytes
    // it actually carries and a length field that agrees with the format:
    // everything except the file size is self-consistent, so only the
    // size/format agreement can refuse it.
    const colourAtGreySize = new Uint8Array(6408);
    colourAtGreySize.set(colour.subarray(0, 6408));
    const shortCrc = crc32(colourAtGreySize.subarray(8));
    colourAtGreySize[4] = shortCrc & 0xFF;
    colourAtGreySize[5] = (shortCrc >> 8) & 0xFF;
    colourAtGreySize[6] = (shortCrc >> 16) & 0xFF;
    colourAtGreySize[7] = (shortCrc >>> 24) & 0xFF;
    // ...and the other way round: 0x01 at the colour size, header and CRC
    // untouched from a valid greyscale file.
    const greyAtColourSize = new Uint8Array(colour.length);
    greyAtColourSize.set(good);              // 6,400-byte format, 25,608-byte body
    const cases = [
      ['corrupted', corrupt],
      ['unknown format', unknown],
      ['truncated', good.slice(0, 100)],
      ['wrong size', new Uint8Array(10)],
      ['colour format at the greyscale size', colourAtGreySize],
      ['greyscale format at the colour size', greyAtColourSize],
    ];
    for (const [name, body] of cases) {
      const bad = await fetch(`/screen/image?token=${window.__CODE}`,
        { method: 'POST', body });
      __assert(bad.status === 400, `a ${name} image answered HTTP ${bad.status}`);
      const after = await fetch(`/screen/image?token=${window.__CODE}`);
      __assert(after.status === 404,
        `after a refused ${name} upload the device answered HTTP ${after.status}`);
    }

    // The control: a well-formed colour body is accepted, so the refusals
    // above are about the disagreement, not about colour as such.
    const ok = await fetch(`/screen/image?token=${window.__CODE}`,
      { method: 'POST', body: colour });
    __assert(ok.status === 200, `a valid colour image answered HTTP ${ok.status}`);
    const readBack = new Uint8Array(
      await (await fetch(`/screen/image?token=${window.__CODE}`)).arrayBuffer());
    __assert(__sameBytes(readBack, colour), 'the stored colour image is not what was sent');
    const reset = await fetch(`/screen/reset?token=${window.__CODE}`, { method: 'POST' });
    __assert(reset.status === 200, `removing the colour image answered HTTP ${reset.status}`);

    const noToken = await fetch('/screen/image', { method: 'POST', body: good });
    __assert(noToken.status === 403,
      `an upload without a code answered HTTP ${noToken.status}`);
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: sending stores exactly what the preview shows',
  fn: async () => {
    // A picture with structure, so the whole path is exercised: the page
    // scales it, dithers it and posts the packed result. The picker defaults
    // to colour, so this is the RGB565 path end to end.
    const src = document.createElement('canvas');
    src.width = 320; src.height = 160;
    const sctx = src.getContext('2d');
    sctx.fillStyle = '#c33';
    sctx.fillRect(0, 0, 320, 160);
    sctx.fillStyle = '#3c3';
    sctx.fillRect(0, 0, 160, 80);
    sctx.fillStyle = '#33c';
    sctx.fillRect(160, 80, 160, 80);
    const blob = await new Promise((r) => src.toBlob(r, 'image/png'));
    __assert(blob, 'could not build a PNG to pick');

    const picker = document.getElementById('screenImageFile');
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'test.png', { type: 'image/png' }));
    picker.files = dt.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));

    for (let i = 0; i < 100 && !screenImageBytes; i++) await __sleep(50);
    __assert(screenImageBytes, 'the picked file never became a packed image');
    __assert(!document.getElementById('screenImageSend').disabled,
      'Send stayed disabled after a file was picked');
    __assert(screenImageBytes.length === 25608,
      `the colour file is ${screenImageBytes.length} bytes, expected 25608`);
    __assert(screenImageBytes[0] === 0x02,
      `the default format is 0x${screenImageBytes[0].toString(16)}, expected colour`);

    // The preview is the promise the page makes, so it must be the bytes that
    // get sent. A colour preview cannot be repacked - it has already been
    // expanded to 8 bits - so the packed file is decoded independently and
    // compared to the canvas pixel for pixel.
    const preview = document.getElementById('screenImagePreview');
    const shown = preview.getContext('2d').getImageData(0, 0, 160, 80).data;
    let mismatch = -1;
    for (let i = 0; i < 160 * 80 && mismatch < 0; i++) {
      const v = screenImageBytes[8 + i * 2] | (screenImageBytes[9 + i * 2] << 8);
      const r5 = (v >> 11) & 0x1F, g6 = (v >> 5) & 0x3F, b5 = v & 0x1F;
      const p = i * 4;
      if (shown[p] !== ((r5 << 3) | (r5 >> 2)) ||
          shown[p + 1] !== ((g6 << 2) | (g6 >> 4)) ||
          shown[p + 2] !== ((b5 << 3) | (b5 >> 2))) mismatch = i;
    }
    __assert(mismatch < 0,
      `preview pixel ${mismatch} is not the 5-6-5 pixel the file carries`);

    document.getElementById('screenImageSend').click();
    for (let i = 0; i < 100 &&
         !document.getElementById('screenImageNote').textContent.includes('Stored'); i++) {
      await __sleep(50);
    }
    const note = document.getElementById('screenImageNote').textContent;
    __assert(note.includes('Stored on the device'), `the page says: ${note}`);
    __assert(!document.getElementById('screenImageClear').hidden,
      'there is still no way to remove the image that was just stored');

    // Server side: the device holds byte for byte what the page sent, and it
    // passes the same rule the firmware applies before drawing.
    const r = await fetch(`/screen/image?token=${window.__CODE}`);
    __assert(r.status === 200, `the device answered HTTP ${r.status}`);
    const stored = new Uint8Array(await r.arrayBuffer());
    __assert(stored.length === 25608, `the device holds ${stored.length} bytes`);
    __assert(__sameBytes(stored, screenImageBytes),
      'the device holds different bytes from the ones the page sent');
    __assert(screenImageValid(stored), 'the device holds an image that does not validate');

    // A stored image must survive a refused upload: the mode is still offered
    // and the old picture is what it draws.
    const broken = Uint8Array.from(stored);
    broken[8 + 3] ^= 0xFF;
    const refused = await fetch(`/screen/image?token=${window.__CODE}`,
      { method: 'POST', body: broken });
    __assert(refused.status === 400, `a corrupted upload answered HTTP ${refused.status}`);
    const after = new Uint8Array(
      await (await fetch(`/screen/image?token=${window.__CODE}`)).arrayBuffer());
    __assert(__sameBytes(after, stored), 'a refused upload replaced the stored image');
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: switching to greyscale re-packs the same picture as 0x01',
  fn: async () => {
    // The send test left a colour image stored and its scaled source loaded.
    __assert(screenImageBytes && screenImageBytes[0] === 0x02,
      'the colour image is no longer loaded');

    const grey = document.querySelector('input[name="screenImageFormat"][value="grey"]');
    __assert(grey, 'there is no greyscale choice in the picker');
    grey.checked = true;
    grey.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && (!screenImageBytes || screenImageBytes[0] !== 0x01); i++) {
      await __sleep(50);
    }
    __assert(screenImageBytes[0] === 0x01,
      `switching re-packed as 0x${screenImageBytes[0].toString(16)}, expected greyscale`);
    __assert(screenImageBytes.length === 6408,
      `the greyscale file is ${screenImageBytes.length} bytes, expected 6408`);

    // The greyscale preview is exactly the 17*i ramp the firmware expands, so
    // repacking the canvas is an independent route back to the same bytes.
    const preview = document.getElementById('screenImagePreview');
    const shown = preview.getContext('2d').getImageData(0, 0, 160, 80);
    __assert(__sameBytes(packScreenImage(shown), screenImageBytes),
      'the greyscale preview and the bytes to send disagree');

    document.getElementById('screenImageSend').click();
    for (let i = 0; i < 100 &&
         !document.getElementById('screenImageNote').textContent.includes('Stored'); i++) {
      await __sleep(50);
    }
    const stored = new Uint8Array(
      await (await fetch(`/screen/image?token=${window.__CODE}`)).arrayBuffer());
    __assert(stored.length === 6408 && stored[0] === 0x01,
      `the device holds ${stored.length} bytes, format 0x${stored[0].toString(16)}`);
    __assert(__sameBytes(stored, screenImageBytes),
      'the device holds different bytes from the ones the page sent');

    // Leave the choice where the page found it: the next test is about removing
    // the stored image, not about which format is selected.
    const colour = document.querySelector('input[name="screenImageFormat"][value="colour"]');
    colour.checked = true;
    colour.dispatchEvent(new Event('change', { bubbles: true }));
  },
});

__webTests.push({
  page: 'settings',
  name: 'screen image: removing it takes the screen back out of the cycle',
  fn: async () => {
    const before = await fetch(`/screen/image?token=${window.__CODE}`);
    __assert(before.status === 200, 'the send test did not leave an image stored');

    window.confirm = () => true;   // the removal asks first
    document.getElementById('screenImageClear').click();
    for (let i = 0; i < 100 &&
         !document.getElementById('screenImageNote').textContent.includes('Removed'); i++) {
      await __sleep(50);
    }
    const note = document.getElementById('screenImageNote').textContent;
    __assert(note.includes('Removed'), `the page says: ${note}`);
    __assert(note.includes('BOOT cycle'), `the page says: ${note}`);

    const after = await fetch(`/screen/image?token=${window.__CODE}`);
    __assert(after.status === 404,
      `after removing it the device answered HTTP ${after.status}`);
    __assert(document.getElementById('screenImageClear').hidden,
      'the page still offers to remove an image that is gone');
    __assert(document.getElementById('screenImageSend').disabled,
      'Send is enabled with nothing picked after a removal');
  },
});

// ---------------------------------------------------------------- macro DSL
// Driven directly rather than through the page, so a failure names the token
// rather than a DOM element.
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
    __assert(/3 macros/.test(meter) && meter.includes('browser'),
      `the size line says: ${meter}`);
    __assert(!meter.includes('1023'),
      `the size line still quotes the device's old cap: ${meter}`);
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
    await __sleep(200);
    __assert(!document.getElementById('editor').classList.contains('show'), 'the editor stayed open');
    const names = [...document.querySelectorAll('.macro .name')].map((e) => e.textContent);
    __assert(names.includes('Test Macro'), `list: ${names.join('|')}`);
    __assert(document.getElementById('saveNote').textContent.includes('saved in this browser'),
      `note: ${document.getElementById('saveNote').textContent}`);

    // The list on screen is not evidence that anything was stored.
    const stored = JSON.parse(localStorage.getItem('esp32remote.macros') || 'null');
    __assert(Array.isArray(stored) && stored.some((m) => m.name === 'Test Macro'),
      `stored in the browser: ${JSON.stringify(stored)}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'a set far past the old device limit still saves',
  fn: async () => {
    const before = document.querySelectorAll('.macro').length;
    document.getElementById('macroAdd').click();
    document.getElementById('editName').value = 'Big One';
    const steps = document.getElementById('editSteps');
    steps.value = 'a'.repeat(1200);
    steps.dispatchEvent(new Event('input', { bubbles: true }));
    await __sleep(50);

    // Nothing should be complaining about a budget any more: macros are not in
    // the device's 1023-byte settings blob.
    const meter = document.getElementById('blobMeter').textContent;
    __assert(!meter.includes('over'), `the size line says: ${meter}`);

    document.getElementById('editSave').click();
    await __sleep(200);
    __assert(document.querySelectorAll('.macro').length === before + 1,
      'the large macro did not reach the list');
    const stored = JSON.parse(localStorage.getItem('esp32remote.macros') || '[]');
    __assert(stored.some((m) => m.name === 'Big One' && m.steps.length === 1200),
      'the large macro was not stored');
  },
});

__webTests.push({
  page: 'macros',
  name: 'a browser that refuses storage is told, not silently ignored',
  fn: async () => {
    // Private mode, or a full origin. The page must not claim to have saved.
    const real = localStorage.setItem;
    localStorage.setItem = () => {
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      throw e;
    };
    let stubbed = false;
    try { localStorage.setItem('probe', 'x'); } catch (_) { stubbed = true; }
    __assert(stubbed, 'could not stub localStorage.setItem, so this test proves nothing');

    try {
      document.getElementById('macroAdd').click();
      document.getElementById('editName').value = 'Doomed';
      const steps = document.getElementById('editSteps');
      steps.value = '{ENTER}';
      steps.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('editSave').click();
      await __sleep(50);

      const note = document.getElementById('saveNote').textContent;
      __assert(note.startsWith('Not saved'), `note: ${note}`);
      __assert(note.includes('no room'), `note: ${note}`);
      __assert(document.getElementById('editor').classList.contains('show'),
        'the editor closed on a save that failed');
      const names = [...document.querySelectorAll('.macro .name')].map((e) => e.textContent);
      __assert(!names.includes('Doomed'), 'a macro that was never stored reached the list');
    } finally {
      localStorage.setItem = real;
      document.getElementById('editCancel').click();
      await __sleep(20);
    }
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

// ---------------------------------------------------------------- macro migration
// Macros used to live in the device's settings blob. An untouched browser plus
// a device still holding a list should adopt it — and the runner checks the
// other half, that the list was then taken off the device.
__webTests.push({
  page: 'macros-migrate',
  name: 'a list left on the device is adopted into the browser',
  fn: async () => {
    await __sleep(400);
    __assert(!document.getElementById('gate'), 'the macro page asked for the code');

    const names = [...document.querySelectorAll('.macro .name')].map((e) => e.textContent);
    __assert(names.includes('Left Behind'), `list: ${names.join('|')}`);

    const stored = JSON.parse(localStorage.getItem('esp32remote.macros') || 'null');
    __assert(Array.isArray(stored) && stored.some((m) => m.name === 'Left Behind'),
      `not written to the browser: ${JSON.stringify(stored)}`);

    const note = document.getElementById('saveNote').textContent;
    __assert(note.includes('Moved'), `note: ${note}`);
  },
});

// ---------------------------------------------------------------- UI files page
// The page drives the real endpoint contract against the stub, which mirrors
// the firmware's fallback: a stored file is served when it is non-empty, the
// embedded copy otherwise.
async function __waitForUiFiles() {
  for (let i = 0; i < 100 && !loaded; i++) await __sleep(50);
  __assert(loaded, 'the file list never loaded');
}

const __row = (name) => document.querySelector(`.file[data-file="${name}"]`);
const __state = (name) => {
  const r = __row(name);
  return r ? r.querySelector('.state').textContent : '(no row)';
};
const __waitState = async (name, prefix) => {
  for (let i = 0; i < 100 && !__state(name).startsWith(prefix); i++) await __sleep(50);
  __assert(__state(name).startsWith(prefix),
    `${name} is "${__state(name)}", expected "${prefix}..."`);
};
const __pick = (name, file) => {
  const picker = __row(name).querySelector('.picker');
  const dt = new DataTransfer();
  dt.items.add(file);
  picker.files = dt.files;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
};

let __embeddedCss = '';   // captured before the upload test replaces it

__webTests.push({
  page: 'ui',
  name: 'lists every UI file and says where it is served from',
  fn: async () => {
    await __waitForUiFiles();
    __assert(!document.getElementById('gate'), 'the page asked for the code');

    const rows = [...document.querySelectorAll('#fileList .file')];
    const names = rows.map((r) => r.dataset.file);
    __assert(rows.length === 11, `listed ${rows.length} files: ${names.join('|')}`);
    __assert(names.includes('index.html') && names.includes('ui.js'),
      `missing files: ${names.join('|')}`);
    __assert(names.filter((n) => n === 'index.html').length === 1,
      'index.html was listed twice');
    for (const r of rows) {
      __assert(r.querySelector('.state').textContent.startsWith('built-in'),
        `${r.dataset.file} starts as "${r.querySelector('.state').textContent}"`);
    }
    __assert(document.getElementById('statusText').textContent.includes('filesystem'),
      `status: ${document.getElementById('statusText').textContent}`);
    __assert(document.getElementById('fsNote').textContent.includes('per file'),
      `size note: ${document.getElementById('fsNote').textContent}`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'uploading a file makes the device serve it',
  fn: async () => {
    await __waitForUiFiles();
    __embeddedCss = await (await fetch('/style.css')).text();
    __assert(__embeddedCss.includes('--accent'), 'the embedded stylesheet did not come back');

    const body = '/* uploaded by the test */\nbody { background: #123456; }\n';
    __pick('style.css', new File([body], 'style.css', { type: 'text/css' }));
    await __waitState('style.css', 'uploaded');

    const served = await (await fetch('/style.css')).text();
    __assert(served === body, `the device served "${served.slice(0, 60)}"`);
    const note = document.getElementById('uiNote').textContent;
    __assert(note.includes('replaces the built-in copy'), `note: ${note}`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'resetting a file brings the built-in copy back',
  fn: async () => {
    await __waitForUiFiles();
    __assert(__state('style.css').startsWith('uploaded'), 'the upload test did not leave a file stored');
    window.confirm = () => true;   // the reset asks first

    __row('style.css').querySelector('.reset').click();
    await __waitState('style.css', 'built-in');

    const served = await (await fetch('/style.css')).text();
    __assert(served === __embeddedCss, 'the built-in stylesheet did not come back');
    const note = document.getElementById('uiNote').textContent;
    __assert(note.includes('back to the built-in copy'), `note: ${note}`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'a name that is not a UI file is refused',
  fn: async () => {
    const cases = ['../style.css', 'evil.txt', 'index.html/../style.css',
                   'style.css.tmp', 'screen.img'];
    for (const name of cases) {
      const q = `name=${encodeURIComponent(name)}&token=${window.__CODE}`;
      const up = await fetch(`/ui/upload?${q}`, { method: 'POST', body: 'x' });
      __assert(up.status === 400, `upload of ${name} answered HTTP ${up.status}`);
      const reset = await fetch(`/ui/reset?${q}`, { method: 'POST' });
      __assert(reset.status === 400, `reset of ${name} answered HTTP ${reset.status}`);
    }
    const served = await (await fetch('/style.css')).text();
    __assert(served === __embeddedCss, 'a refused upload changed what is served');
  },
});

__webTests.push({
  page: 'ui',
  name: 'an empty file is refused, not stored as an empty page',
  fn: async () => {
    const r = await fetch(`/ui/upload?name=index.html&token=${window.__CODE}`,
      { method: 'POST', body: '' });
    __assert(r.status === 400, `the endpoint answered HTTP ${r.status}`);
    __assert(__state('index.html').startsWith('built-in'),
      `index.html became "${__state('index.html')}"`);

    await __waitForUiFiles();
    __pick('index.html', new File([], 'index.html', { type: 'text/html' }));
    await __sleep(300);
    const note = document.getElementById('uiNote').textContent;
    __assert(note.includes('empty'), `note: ${note}`);
    __assert(__state('index.html').startsWith('built-in'),
      `index.html became "${__state('index.html')}"`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'an over-size file is refused, and the page refuses it first',
  fn: async () => {
    await __waitForUiFiles();
    const big = new Uint8Array(maxSize + 1);

    const r = await fetch(`/ui/upload?name=macros.js&token=${window.__CODE}`,
      { method: 'POST', body: big });
    __assert(r.status === 413, `the endpoint answered HTTP ${r.status}`);
    __assert(__state('macros.js').startsWith('built-in'),
      `macros.js became "${__state('macros.js')}"`);

    // The page checks the size before the file leaves the browser.
    __pick('macros.js', new File([big], 'macros.js'));
    await __sleep(300);
    const note = document.getElementById('uiNote').textContent;
    __assert(note.includes('Nothing was uploaded'), `note: ${note}`);
    __assert(__state('macros.js').startsWith('built-in'),
      `macros.js became "${__state('macros.js')}"`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'the file endpoints need the access code',
  fn: async () => {
    const list = await fetch('/ui/files');
    __assert(list.status === 403, `the listing answered HTTP ${list.status}`);
    const up = await fetch('/ui/upload?name=style.css', { method: 'POST', body: 'x' });
    __assert(up.status === 403, `an upload without a code answered HTTP ${up.status}`);
    const reset = await fetch('/ui/reset?all=1', { method: 'POST' });
    __assert(reset.status === 403, `a reset without a code answered HTTP ${reset.status}`);
  },
});

// ---------------------------------------------------------------- broken index.html
// The point of the page: when an uploaded index.html breaks, ui.html is still
// served from the firmware and can put the built-in copy back. The runner
// stores the broken file before this pass.
__webTests.push({
  page: 'ui-broken',
  name: 'ui.html works while index.html is broken, and can reset it',
  fn: async () => {
    await __waitForUiFiles();

    const broken = await (await fetch('/index.html')).text();
    __assert(broken.includes('broken'), 'the runner did not store a broken index.html');
    __assert(__state('index.html').startsWith('uploaded'),
      `index.html is "${__state('index.html')}"`);

    window.confirm = () => true;
    __row('index.html').querySelector('.reset').click();
    await __waitState('index.html', 'built-in');

    const served = await (await fetch('/index.html')).text();
    __assert(served.includes('<title>ESP32 Remote</title>'),
      'the built-in index.html did not come back');
    __assert(!served.includes('broken'), 'the broken copy is still being served');
  },
});

// The same page at a desktop width: the two-row phone layout must not follow
// it there.
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
