// In-page tests, injected by run.mjs into the control page and the settings
// page. Everything here runs in the browser against the stub device, so it
// exercises the real code rather than a reimplementation.
//
// Define __webTests with entries of the form { page, name, fn }.
// `page` is "control" or "settings"; run.mjs groups them by navigation.

const __webTests = [];

const __sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const __assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

// The gate is part of the shell and stays hidden once a code is accepted.
const __gateHidden = () => {
  const gate = document.getElementById('gate');
  return !gate || gate.classList.contains('hidden');
};

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
// the wire. The view object exposes the same state the page uses.
function __capture() {
  const cap = [];
  PadView.ws = { readyState: 1, send: (b) => cap.push(Array.from(b)) };
  PadView.wsReady = true;
  return cap;
}

function __pointer(type, id, pointerType, x, y) {
  PadView.pad.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType, clientX: x, clientY: y, bubbles: true,
  }));
}

function __resetInput() {
  PadView.pointers.clear();
  PadView.buttons = 0;
  PadView.mode = null;
  PadView.dragHeld = false;
  PadView.held.clear();
}

// Same idea as __capture, for the macro page: swap the socket for a recorder.
// The reconnect timer has to be stopped first, or a retry would replace the
// recorder mid-test.
function __macroCapture() {
  clearTimeout(MacrosView.reconnectTimer);
  MacrosView.reconnectTimer = 1;       // keeps scheduleReconnect() from arming
  const cap = [];
  MacrosView.ws = { readyState: 1, send: (b) => cap.push(Array.from(b)) };
  MacrosView.wsReady = true;
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
    __assert(__gateHidden(), 'the gate is showing - the saved code was not restored');
    __assert(localStorage.getItem('esp32remote.token') === window.__CODE,
      'token not stored');
  },
});

__webTests.push({
  page: 'control',
  name: 'the captured state is wired to the socket the pad opens',
  fn: async () => {
    // The state test below calls the handlers directly; this proves the socket
    // the view actually opened is using those same handlers.
    const ws = PadView.ws;
    __assert(ws, 'the pad never opened a socket');
    __assert(ws.onopen === PadView.onSocketOpen,
      'the socket open handler is not the one the view updates from');
    __assert(ws.onclose === PadView.onSocketClose,
      'the socket close handler is not the one the view updates from');
  },
});

__webTests.push({
  page: 'control',
  name: 'gesture help opens on the first visit and is remembered',
  fn: async () => {
    const help = document.getElementById('help');
    __assert(help && !help.hidden, 'the gesture help was not shown on the first visit');
    __assert(document.getElementById('hint'), 'the fallback hint is missing');

    // Thumb-reachable: the close button has to sit in the bottom half of the
    // sheet, not off the top of a tall phone.
    const sheet = help.querySelector('.help-sheet').getBoundingClientRect();
    const close = document.getElementById('helpClose').getBoundingClientRect();
    __assert(close.top >= sheet.top && close.top > window.innerHeight / 2,
      `the close button is at ${Math.round(close.top)}px on a ${window.innerHeight}px screen`);

    document.getElementById('helpClose').click();
    __assert(help.hidden, 'the help did not close');
    await __sleep(20);
    __assert(getComputedStyle(help).display === 'none', 'the sheet still covers the pad');
    __assert(localStorage.getItem('esp32remote.helpSeen') === '1',
      'dismissing the help was not remembered');
  },
});

__webTests.push({
  page: 'control',
  name: 'gesture help reopens from the pad and closes on a backdrop tap',
  fn: async () => {
    const help = document.getElementById('help');
    document.getElementById('helpOpen').click();
    __assert(!help.hidden, 'the help did not reopen from the ? button');

    // The sheet itself keeps the tap (reading should not dismiss it); the
    // backdrop around it is the dismiss target.
    help.querySelector('.help-sheet').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    __assert(!help.hidden, 'a tap on the sheet dismissed the instructions');

    help.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    __assert(help.hidden, 'tapping the backdrop did not dismiss the help');
  },
});

__webTests.push({
  page: 'control',
  name: 'keyboard report keeps held keys when typing',
  fn: async () => {
    __resetInput();
    PadView.held.add('KeyA');
    const a = __bytes(PadView.buildKeyboardReport(null, false));
    __assert(a === '2,0,4,0,0,0,0,0', `A alone sent ${a}`);

    const ab = __bytes(PadView.buildKeyboardReport('KeyB', false));
    __assert(ab === '2,0,4,5,0,0,0,0', `A+B sent ${ab} - held key was dropped`);

    const shifted = __bytes(PadView.buildKeyboardReport('KeyB', true));
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
      const got = PadView.TYPE_MAP[ch];
      __assert(got && got[0] === code && got[1] === shift,
        `'${ch}' mapped to ${JSON.stringify(got)}, expected ${code}/${shift}`);
    }
    __assert(!PadView.TYPE_MAP['\u00e9'], 'a non-ASCII character was mapped');
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
    const orig = PadView.pad.requestPointerLock;
    PadView.pad.requestPointerLock = () => { locks++; };
    try {
      __pointer('pointerdown', 1, 'touch', 100, 100);
      await __sleep(20);
      __pointer('pointerup', 1, 'touch', 100, 100);
      __assert(locks === 0, `a touch requested pointer lock ${locks} times`);
    } finally {
      PadView.pad.requestPointerLock = orig;
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'mouse does request pointer lock',
  fn: async () => {
    let locks = 0;
    const orig = PadView.pad.requestPointerLock;
    PadView.pad.requestPointerLock = () => { locks++; };
    try {
      __pointer('pointerdown', 9, 'mouse', 100, 100);
      __assert(locks === 1, `mouse requested pointer lock ${locks} times, expected 1`);
    } finally {
      PadView.pad.requestPointerLock = orig;
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
    const orig = PadView.pad.requestPointerLock;
    PadView.pad.requestPointerLock = () => {
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
      PadView.pad.requestPointerLock = orig;
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'one wheel notch is one step, in pixels or lines',
  fn: async () => {
    __resetInput();
    PadView.captured = true;
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
      PadView.captured = false;
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'a movement larger than the report is split, not clamped',
  fn: async () => {
    PadView.captured = true;
    const cap = __capture();
    try {
      PadView.pad.dispatchEvent(new PointerEvent('pointermove', {
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
      PadView.captured = false;
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
    PadView.captured = true;
    const cap = __capture();
    try {
      // A gaming mouse emits over a thousand of these a second. One WebSocket
      // message each is more than the device can drain.
      for (let i = 0; i < 20; i++) {
        PadView.pad.dispatchEvent(new PointerEvent('pointermove', {
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
      PadView.captured = false;
      appSettings.mouse_gain = savedGain;
    }
  },
});


__webTests.push({
  page: 'control',
  name: 'a dropped link degrades the captured pad and reconnecting clears it',
  fn: async () => {
    __resetInput();
    __capture();

    Object.defineProperty(document, 'pointerLockElement', {
      value: PadView.pad, configurable: true,
    });
    try {
      document.dispatchEvent(new Event('pointerlockchange'));
      await __sleep(20);

      const pad = PadView.pad;
      const lost = document.getElementById('linkLost');
      __assert(pad.classList.contains('captured'),
        'pointer lock did not put the pad into its captured state');
      __assert(!pad.classList.contains('link-down'),
        'the captured pad is degraded while the link is up');
      __assert(getComputedStyle(lost).display === 'none',
        'the lost-link message is visible while connected');

      // Block the retry so the test is not racing a real socket.
      clearTimeout(PadView.reconnectTimer);
      PadView.reconnectTimer = 1;
      PadView.onSocketClose();
      await __sleep(20);

      __assert(pad.classList.contains('link-down'),
        'a dropped socket left the captured pad looking healthy');
      __assert(getComputedStyle(lost).display !== 'none',
        'the captured pad did not show the lost-link message');
      const esc = document.getElementById('escHint').textContent;
      __assert(/lost/i.test(esc), `the capture hint still says: ${esc}`);

      PadView.onSocketOpen();
      await __sleep(20);

      __assert(!pad.classList.contains('link-down'),
        'the pad stayed degraded after the link came back');
      __assert(getComputedStyle(lost).display === 'none',
        'the lost-link message stayed on screen after reconnecting');
      __assert(/Esc releases it/.test(document.getElementById('escHint').textContent),
        'the capture hint did not return to its normal wording');
    } finally {
      delete document.pointerLockElement;
      document.dispatchEvent(new Event('pointerlockchange'));
      clearTimeout(PadView.reconnectTimer);
      PadView.reconnectTimer = null;
      PadView.wsReady = false;
      PadView.captured = false;
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'captured input pulses a subtle indicator and then fades',
  fn: async () => {
    __resetInput();
    __capture();
    const pulse = document.getElementById('inputPulse');
    PadView.captured = true;
    try {
      window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      await __sleep(10);
      __assert(pulse.classList.contains('tick'),
        'a click while captured did not acknowledge the input');

      window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
      await __sleep(400);
      __assert(!pulse.classList.contains('tick'),
        'the input indicator stayed lit after input stopped');
    } finally {
      PadView.captured = false;
      PadView.buttons = 0;
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'host keys are forwarded only while the pad is captured',
  fn: async () => {
    const help = document.getElementById('help');
    if (help && !help.hidden) document.getElementById('helpClose').click();

    __resetInput();
    const cap = __capture();
    PadView.captured = false;
    try {
      // Not captured: a key typed at the page must stay in the browser. The
      // old handler sent it anyway, so a stray keystroke landed on the host
      // with nothing on screen saying it would.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));
      await __sleep(10);
      __assert(cap.length === 0,
        `an uncaptured key sent ${cap.length} reports to the host`);
      __assert(PadView.held.size === 0, 'an uncaptured key was left held');

      // Captured: the same key goes out, and the capture hint says what is
      // being captured - otherwise "captured" only ever meant the mouse.
      PadView.captured = true;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
      await __sleep(10);
      const presses = cap.filter((r) => r[0] === 2 && r[2] === 4);
      __assert(presses.length === 1,
        `a captured key sent ${presses.length} press reports, expected 1`);

      const hint = document.getElementById('escHint');
      __assert(getComputedStyle(hint).display !== 'none',
        'the capture hint is not visible while captured');
      __assert(/keyboard/i.test(hint.textContent),
        `the capture hint does not mention the keyboard: "${hint.textContent}"`);
    } finally {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));
      PadView.captured = false;
      __resetInput();
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'a latched modifier looks different from a pressed key',
  fn: async () => {
    __resetInput();
    PadView.latched.clear();
    __capture();

    const alt = document.querySelector('.k[data-code="AltLeft"]');
    // A plain held key is the state a latch must not be confused with.
    const plain = document.querySelector('.k[data-code="KeyA"]');
    __assert(alt && plain, 'the virtual keyboard is missing Alt or A');

    const tap = (el, id) => {
      el.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: id, pointerType: 'touch', clientX: 5, clientY: 5, bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: id, pointerType: 'touch', clientX: 5, clientY: 5, bubbles: true }));
    };
    tap(alt, 40);
    await __sleep(20);
    // Press A and leave it down: the active class is the pressed state being
    // compared against.
    plain.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 41, pointerType: 'touch', clientX: 5, clientY: 5, bubbles: true }));
    await __sleep(20);

    const latchedStyle = getComputedStyle(alt);
    const plainStyle = getComputedStyle(plain);
    __assert(alt.classList.contains('latched'), 'Alt did not latch');
    __assert(latchedStyle.backgroundColor !== plainStyle.backgroundColor,
      `latched and pressed share the background ${latchedStyle.backgroundColor}`);
    __assert(latchedStyle.outlineStyle !== 'none',
      'a latched key has no outline');

    plain.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 41, pointerType: 'touch', clientX: 5, clientY: 5, bubbles: true }));
    PadView.latched.clear();
    PadView.held.clear();
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
    __assert(PadView.held.has('KeyW'), 'key not held after pointerdown');

    // A long press must not release it by itself.
    await __sleep(120);
    __assert(PadView.held.has('KeyW'), 'key released by itself during a hold');

    key.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 10, bubbles: true,
    }));
    await __sleep(20);
    __assert(!PadView.held.has('KeyW'), 'key still held after pointerup');

    const pressed = cap.find((r) => r[0] === 2 && r[2] === PadView.KEY.KeyW);
    __assert(pressed, 'no keyboard report containing KeyW');
  },
});

__webTests.push({
  page: 'control',
  name: 'a latched modifier forms a chord with one finger',
  fn: async () => {
    __resetInput();
    PadView.latched.clear();
    const cap = __capture();

    const key = (c) => document.querySelector(`.k[data-code="${c}"]`);
    const alt = key('AltLeft'), tab = key('Tab');
    __assert(alt && tab, 'Alt or Tab missing from the virtual keyboard');
    const tap = (el, id, up) => el.dispatchEvent(new PointerEvent(up ? 'pointerup' : 'pointerdown', {
      pointerId: id, pointerType: 'touch', clientX: 5, clientY: 5, bubbles: true,
    }));

    // One tap latches Alt and reports it held.
    tap(alt, 20);
    tap(alt, 20, true);
    await __sleep(20);
    __assert(PadView.latched.has('AltLeft'), 'Alt did not latch');
    __assert(alt.classList.contains('latched'), 'Alt is latched but not shown as such');

    // The next key carries it: one finger, no chord.
    tap(tab, 21);
    await __sleep(20);
    const press = cap.filter((r) => r[0] === 2).pop();
    __assert(press && press[1] === 0x04,
      `modifier byte ${press && press[1]}, expected 0x04 (Alt)`);
    __assert(press[2] === 0x2B, `keycode ${press && press[2]}, expected 0x2B (Tab)`);

    // A chord is one shot: releasing the key releases the latch with it, so the
    // host never sees a modifier left held.
    tap(tab, 21, true);
    await __sleep(20);
    const up = cap.filter((r) => r[0] === 2).pop();
    __assert(up[1] === 0 && up[2] === 0,
      `final report mod ${up[1]} key ${up[2]}, expected everything released`);
    __assert(!PadView.latched.size, 'the latch survived the chord');
    __assert(!alt.classList.contains('latched'), 'Alt still looks latched');
  },
});

__webTests.push({
  page: 'control',
  name: 'tapping a latched modifier again cancels it',
  fn: async () => {
    __resetInput();
    PadView.latched.clear();
    const cap = __capture();
    const alt = document.querySelector('.k[data-code="AltLeft"]');
    const tap = (id) => {
      alt.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: id, pointerType: 'touch', clientX: 5, clientY: 5, bubbles: true }));
      alt.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: id, pointerType: 'touch', clientX: 5, clientY: 5, bubbles: true }));
    };

    tap(30);
    await __sleep(20);
    __assert(PadView.latched.has('AltLeft'), 'first tap did not latch');

    tap(31);
    await __sleep(20);
    __assert(!PadView.latched.has('AltLeft'), 'second tap did not cancel');
    const last = cap.filter((r) => r[0] === 2).pop();
    __assert(last[1] === 0, `modifier byte ${last[1]} after cancelling, expected 0`);
  },
});

// Any of these can lose the input: the keyup then goes somewhere else and the
// host is left holding a key nothing can lift.
__webTests.push({
  page: 'control',
  name: 'losing window focus releases everything held',
  fn: async () => {
    __resetInput();
    PadView.latched.clear();
    const cap = __capture();
    PadView.held.add('KeyW');
    PadView.buttons = 1;

    window.dispatchEvent(new Event('blur'));
    await __sleep(20);

    __assert(!PadView.held.size, `still holding ${[...PadView.held].join(',')}`);
    __assert(PadView.buttons === 0, `button mask is ${PadView.buttons}`);
    __assert(cap.some((r) => r[0] === 0x05), 'no release-all report was sent');
  },
});

__webTests.push({
  page: 'control',
  name: 'hiding the page releases everything held',
  fn: async () => {
    __resetInput();
    PadView.latched.clear();
    const cap = __capture();
    PadView.held.add('KeyA');
    PadView.latched.add('ShiftLeft');
    PadView.held.add('ShiftLeft');

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await __sleep(20);
    } finally {
      delete document.hidden;
    }

    __assert(!PadView.held.size, `still holding ${[...PadView.held].join(',')}`);
    __assert(!PadView.latched.size, 'a latch survived the page being hidden');
    __assert(cap.some((r) => r[0] === 0x05), 'no release-all report was sent');
  },
});

__webTests.push({
  page: 'control',
  name: 'losing pointer lock releases everything held',
  fn: async () => {
    __resetInput();
    PadView.latched.clear();
    PadView.captured = true;
    const cap = __capture();
    PadView.held.add('KeyD');

    Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
    try {
      document.dispatchEvent(new Event('pointerlockchange'));
      await __sleep(20);
    } finally {
      delete document.pointerLockElement;
      PadView.captured = false;
    }

    __assert(!PadView.held.size, `still holding ${[...PadView.held].join(',')}`);
    __assert(cap.some((r) => r[0] === 0x05),
      'no release-all report was sent when capture ended');
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
    __assert(__gateHidden(), 'the settings view asked for the code');
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
  name: 'settings is a list of sections, one open at a time',
  fn: async () => {
    await __sleep(200);
    const list = document.getElementById('setupList');
    const rows = [...list.querySelectorAll('.setuprow')];
    __assert(rows.length >= 8, `${rows.length} rows in the setup list`);
    __assert(!list.hidden, 'the list is hidden on arrival');
    const open = () => [...document.querySelectorAll('#view section[data-page]')]
      .filter((sec) => !sec.hidden);
    __assert(open().length === 0, 'sections are showing behind the list');

    rows[0].click();
    __assert(list.hidden, 'the list stayed visible after opening a section');
    const shown = open();
    // A page can own more than one section (Diagnostics owns the probe), so the
    // contract is per page rather than per section.
    __assert(shown.every((sec) => sec.dataset.page === rows[0].dataset.page),
      `opened ${shown.map((sec) => sec.dataset.page).join(',')}, expected ${rows[0].dataset.page}`);

    // Every row has to open something, or the list has a dead entry.
    for (const row of rows) {
      row.click();
      const opened = open();
      __assert(opened.length > 0, `${row.dataset.page} opened nothing`);
      __assert(opened.every((sec) => sec.dataset.page === row.dataset.page),
        `${row.dataset.page} opened ${opened.map((sec) => sec.dataset.page).join(',')}`);
    }

    document.getElementById('setupBack').click();
    __assert(!list.hidden, 'back did not return to the list');
    __assert(open().length === 0, 'the section stayed open behind the list');
  },
});

__webTests.push({
  page: 'settings',
  name: 'the key probe records modifiers, codes and the usage it would send',
  fn: async () => {
    const field = document.getElementById('probeField');
    const log = document.getElementById('probeLog');
    __assert(field && log, 'the probe is not in the settings view');

    field.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true, bubbles: true,
    }));
    const after = log.textContent;
    __assert(/down/.test(after), `nothing was recorded: ${after}`);
    __assert(/code="KeyC"/.test(after), `the code was not recorded: ${after}`);
    __assert(/kc=67/.test(after), `keyCode was not recorded: ${after}`);
    __assert(/ctrl/.test(after), `the modifier was not recorded: ${after}`);
    // 0x06 is KeyC on the Keyboard/Keypad page: the probe has to say what our
    // translator would actually send, or it cannot answer the question it
    // exists for.
    __assert(/0x06/i.test(after), `no HID usage was resolved: ${after}`);

    field.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText', data: 'c', bubbles: true,
    }));
    __assert(/insertText/.test(log.textContent), 'the input event was not recorded');

    document.getElementById('probeClear').click();
    __assert(log.textContent === '', `clear left text behind: ${log.textContent}`);
    __assert(/0 keydown/.test(document.getElementById('probeStats').textContent),
      'clear did not reset the counters');
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

    const b = SettingsView.collectBackup();
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
    const vector = SettingsView.crc32(new TextEncoder().encode('123456789'));
    __assert(vector === 0xCBF43926,
      `SettingsView.crc32('123456789') = 0x${vector.toString(16)}, expected 0xcbf43926`);

    const img = __greyImage(0);
    img.data[0] = img.data[1] = img.data[2] = 255;            // (0,0) white
    img.data[640] = img.data[641] = img.data[642] = 255;      // (0,1) white
    const bytes = SettingsView.packScreenImage(img);

    __assert(bytes.length === 6408, `the file is ${bytes.length} bytes, expected 6408`);
    __assert(bytes.length - 8 === 6400, `the payload is ${bytes.length - 8} bytes`);
    __assert(bytes[0] === 0x01, `format byte is 0x${bytes[0].toString(16)}`);
    __assert(bytes[1] === 0, `reserved byte is ${bytes[1]}`);
    __assert((bytes[2] | (bytes[3] << 8)) === 6400, 'the length field is not 6400');
    const want = SettingsView.crc32(bytes.subarray(8));
    const got = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
    __assert(got === want,
      `header CRC 0x${got.toString(16)} != payload CRC 0x${want.toString(16)}`);
    __assert(SettingsView.screenImageValid(bytes), 'the packed file does not validate');

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
    const tail = SettingsView.packScreenImage(img);
    __assert(tail[8 + 6399] === 0xF0,
      `the bottom-right pair packed to 0x${tail[8 + 6399].toString(16)}, expected 0xf0`);

    // Black and white are the ends of the ramp, and every payload byte moves
    // with the input rather than being left as it was.
    const black = SettingsView.packScreenImage(__greyImage(0));
    const white = SettingsView.packScreenImage(__greyImage(255));
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
    const payload = SettingsView.packScreenImage(__greyImage(128)).subarray(8);

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
    const higher = SettingsView.packScreenImage(__greyImage(140)).subarray(8);
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
      for (const b of SettingsView.packScreenImage(__greyImage(v)).subarray(8)) {
        __assert((b >> 4) === level && (b & 0x0F) === level,
          `grey ${v} packed to 0x${b.toString(16)}, expected level ${level} both halves`);
      }
    }

    // The dither tracks a ramp: the mean level over the image is the mean of
    // the input (15 * 0.5 = 7.5), which a threshold that ignored the input
    // would not manage.
    const ramp = SettingsView.packScreenImage(__greyImage((x) => Math.round(x * 255 / 159))).subarray(8);
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
    SettingsView.renderScreenImage(canvas, SettingsView.packScreenImage(img));
    const px = canvas.getContext('2d').getImageData(0, 0, 160, 80).data;
    // Level 15 comes back as 255 and level 0 as 0: the preview uses the same
    // 17*i ramp the firmware's RGB565 table is built from.
    __assert(px[0] === 255 && px[1] === 255 && px[2] === 255,
      `(0,0) previews as ${px[0]},${px[1]},${px[2]}, expected white`);
    __assert(px[8] === 0 && px[9] === 0 && px[10] === 0,
      `(2,0) previews as ${px[8]},${px[9]},${px[10]}, expected black`);

    // A dithered grey must come back as the two levels, not one flat block.
    SettingsView.renderScreenImage(canvas, SettingsView.packScreenImage(__greyImage(128)));
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
    const bytes = SettingsView.packScreenImage(img, 0x02);

    __assert(bytes.length === 25608, `the file is ${bytes.length} bytes, expected 25608`);
    __assert(bytes[0] === 0x02, `format byte is 0x${bytes[0].toString(16)}`);
    __assert(bytes[1] === 0, `reserved byte is ${bytes[1]}`);
    __assert((bytes[2] | (bytes[3] << 8)) === 25600, 'the length field is not 25600');
    const want = SettingsView.crc32(bytes.subarray(8));
    const got = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
    __assert(got === want,
      `header CRC 0x${got.toString(16)} != payload CRC 0x${want.toString(16)}`);
    __assert(SettingsView.screenImageValid(bytes), 'the packed file does not validate');

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
    const packed = SettingsView.packScreenImage(img, 0x02).subarray(8);
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
    const crc = SettingsView.crc32(bytes.subarray(8));
    bytes[4] = crc & 0xFF; bytes[5] = (crc >> 8) & 0xFF;
    bytes[6] = (crc >> 16) & 0xFF; bytes[7] = (crc >>> 24) & 0xFF;
    __assert(SettingsView.screenImageValid(bytes), 'the hand-built colour file does not validate');

    const canvas = document.getElementById('screenImagePreview');
    SettingsView.renderScreenImage(canvas, bytes);
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
    const payload = SettingsView.packScreenImage(__colourImage([128, 128, 128]), 0x02).subarray(8);
    const counts = { r: new Map(), g: new Map(), b: new Map() };
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const o = (y * 160 + x) * 2;
        const v = payload[o] | (payload[o + 1] << 8);
        const r = v >> 11, g = (v >> 5) & 0x3F, b = v & 0x1F;
        __assert(r === (SettingsView.BAYER4[y][x] >= 7 ? 16 : 15), `red at (${x},${y}) is ${r}`);
        __assert(g === (SettingsView.BAYER4[y][x] >= 6 ? 32 : 31), `green at (${x},${y}) is ${g}`);
        __assert(b === (SettingsView.BAYER4[y][x] >= 7 ? 16 : 15), `blue at (${x},${y}) is ${b}`);
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
    const blue = SettingsView.packScreenImage(__colourImage([0, 0, 128]), 0x02).subarray(8);
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
    const bytes = SettingsView.packScreenImage(img);              // the default format
    const explicit = SettingsView.packScreenImage(img, 0x01);
    __assert(__sameBytes(bytes, explicit), 'the default format is no longer 0x01');
    __assert(bytes.length === 6408, `the file is ${bytes.length} bytes, expected 6408`);
    __assert(bytes[0] === 0x01 && bytes[1] === 0, 'the header is no longer greyscale');
    __assert((bytes[2] | (bytes[3] << 8)) === 6400, 'the length field is not 6400');
    __assert(SettingsView.screenImageValid(bytes), 'a greyscale file no longer validates');

    // The same picture in colour is a different file, not the greyscale payload
    // wearing a different format byte.
    const colour = SettingsView.packScreenImage(img, 0x02);
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
    const good = SettingsView.packScreenImage(__greyImage(200));
    const colour = SettingsView.packScreenImage(__colourImage([10, 200, 30]), 0x02);
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
    const shortCrc = SettingsView.crc32(colourAtGreySize.subarray(8));
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

    for (let i = 0; i < 100 && !SettingsView.screenImageBytes; i++) await __sleep(50);
    __assert(SettingsView.screenImageBytes, 'the picked file never became a packed image');
    __assert(!document.getElementById('screenImageSend').disabled,
      'Send stayed disabled after a file was picked');
    __assert(SettingsView.screenImageBytes.length === 25608,
      `the colour file is ${SettingsView.screenImageBytes.length} bytes, expected 25608`);
    __assert(SettingsView.screenImageBytes[0] === 0x02,
      `the default format is 0x${SettingsView.screenImageBytes[0].toString(16)}, expected colour`);

    // The preview is the promise the page makes, so it must be the bytes that
    // get sent. A colour preview cannot be repacked - it has already been
    // expanded to 8 bits - so the packed file is decoded independently and
    // compared to the canvas pixel for pixel.
    const preview = document.getElementById('screenImagePreview');
    const shown = preview.getContext('2d').getImageData(0, 0, 160, 80).data;
    let mismatch = -1;
    for (let i = 0; i < 160 * 80 && mismatch < 0; i++) {
      const v = SettingsView.screenImageBytes[8 + i * 2] | (SettingsView.screenImageBytes[9 + i * 2] << 8);
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
    __assert(__sameBytes(stored, SettingsView.screenImageBytes),
      'the device holds different bytes from the ones the page sent');
    __assert(SettingsView.screenImageValid(stored), 'the device holds an image that does not validate');

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
    __assert(SettingsView.screenImageBytes && SettingsView.screenImageBytes[0] === 0x02,
      'the colour image is no longer loaded');

    const grey = document.querySelector('input[name="screenImageFormat"][value="grey"]');
    __assert(grey, 'there is no greyscale choice in the picker');
    grey.checked = true;
    grey.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && (!SettingsView.screenImageBytes || SettingsView.screenImageBytes[0] !== 0x01); i++) {
      await __sleep(50);
    }
    __assert(SettingsView.screenImageBytes[0] === 0x01,
      `switching re-packed as 0x${SettingsView.screenImageBytes[0].toString(16)}, expected greyscale`);
    __assert(SettingsView.screenImageBytes.length === 6408,
      `the greyscale file is ${SettingsView.screenImageBytes.length} bytes, expected 6408`);

    // The greyscale preview is exactly the 17*i ramp the firmware expands, so
    // repacking the canvas is an independent route back to the same bytes.
    const preview = document.getElementById('screenImagePreview');
    const shown = preview.getContext('2d').getImageData(0, 0, 160, 80);
    __assert(__sameBytes(SettingsView.packScreenImage(shown), SettingsView.screenImageBytes),
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
    __assert(__sameBytes(stored, SettingsView.screenImageBytes),
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
  name: 'DSL: a repeat block expands in place, and nests',
  fn: async () => {
    const flat = (text) => parseMacro(text).steps
      .filter((st) => st.kind === 'key')
      .map((st) => st.usage);

    // {REPEAT:3}A{/REPEAT} is three presses of A, in order.
    const three = flat('{REPEAT:3}{LEFT}{/REPEAT}');
    __assert(three.length === 3 && three.every((u) => u === 0x50),
      `repeat produced ${JSON.stringify(three)}`);

    // 2 x (2 x DOWN, UP) = DOWN DOWN UP DOWN DOWN UP.
    const nested = flat('{REPEAT:2}{REPEAT:2}{DOWN}{/REPEAT}{UP}{/REPEAT}');
    __assert(nested.join(',') === [0x51, 0x51, 0x52, 0x51, 0x51, 0x52].join(','),
      `nested repeat produced ${nested.map((u) => u.toString(16)).join(',')}`);

    // {END} is the End key, not a block terminator.
    const endKey = parseMacro('{END}');
    __assert(!endKey.errors.length && endKey.steps[0].usage === 0x4D,
      `{END} stopped being the End key: ${JSON.stringify(endKey.errors)}`);
  },
});

__webTests.push({
  page: 'macros',
  name: 'DSL: broken repeat blocks are reported, not silently dropped',
  fn: async () => {
    const unclosed = parseMacro('{REPEAT:2}{LEFT}');
    __assert(unclosed.errors.some((e) => /no \{\/REPEAT\}/.test(e.message)),
      `unclosed: ${JSON.stringify(unclosed.errors)}`);

    const stray = parseMacro('{LEFT}{/REPEAT}');
    __assert(stray.errors.some((e) => /without a \{REPEAT/.test(e.message)),
      `stray: ${JSON.stringify(stray.errors)}`);

    const big = parseMacro('{REPEAT:101}{LEFT}{/REPEAT}');
    __assert(big.errors.some((e) => /longest repeat/.test(e.message)),
      `over-long: ${JSON.stringify(big.errors)}`);

    const zero = parseMacro('{REPEAT:0}{LEFT}{/REPEAT}');
    __assert(zero.errors.some((e) => /smallest repeat/.test(e.message)),
      `zero: ${JSON.stringify(zero.errors)}`);

    // A repeat multiplies: 100 x 100 is 10,000 presses. That has to be refused
    // rather than sent at the host.
    const huge = parseMacro('{REPEAT:100}{REPEAT:100}{LEFT}{/REPEAT}{/REPEAT}');
    __assert(huge.errors.some((e) => /over 2000 steps/.test(e.message)),
      `huge: ${JSON.stringify(huge.errors)}`);
    __assert(huge.steps.length === 2000,
      `the expansion was not capped: ${huge.steps.length} steps`);
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
    __assert(__gateHidden(), 'the macro view asked for the code');

    const cards = [...document.querySelectorAll('.macro')];
    __assert(cards.length === 3, `listed ${cards.length} macros, expected the 3 stored`);
    const names = cards.map((c) => c.querySelector('.name').textContent).join('|');
    __assert(names === 'Open Chrome|Screenshot|Broken', `names: ${names}`);
    __assert(cards[0].querySelector('.src').textContent === '{SEARCH}chrome{ENTER}',
      `source: ${cards[0].querySelector('.src').textContent}`);
    __assert(cards[2].querySelector('.bad'), 'the macro with an unknown token was not flagged');
    __assert(cards[0].querySelector('.run').textContent.includes('Run'), 'no Run button');

    const meter = document.getElementById('blobMeter').textContent;
    __assert(/3 buttons/.test(meter) && /bytes/.test(meter),
      `the size line says: ${meter}`);
    // The count is the only job this line has: where macros are stored is
    // stated above the list, and repeating it here was pure noise.
    __assert(!/stored in this browser/.test(meter),
      `the size line repeats the storage note: ${meter}`);
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
  name: 'a new button lands on the active page',
  fn: async () => {
    const strip = document.getElementById('deckPages');
    __assert(strip, 'there is no page strip');
    const pages = () => [...strip.querySelectorAll('.page:not(.add)')];
    const before = pages().length;
    __assert(before >= 1, 'the deck has no pages');

    strip.querySelector('.page.add').click();
    await __sleep(60);
    __assert(pages().length === before + 1, 'the page was not added');
    __assert(pages()[pages().length - 1].classList.contains('on'),
      'the new page did not become active');
    __assert(document.querySelectorAll('.macro').length === 0,
      'the new page is not empty');

    document.getElementById('macroAdd').click();
    document.getElementById('editName').value = 'On page two';
    document.getElementById('editSteps').value = '{ENTER}';
    document.getElementById('editSave').click();
    await __sleep(400);

    const names = [...document.querySelectorAll('.macro .name')].map((n) => n.textContent);
    __assert(names.includes('On page two'),
      `the button did not land on the new page: ${names.join(', ')}`);
    const stored = JSON.parse(localStorage.getItem('esp32remote.macros') || '[]');
    const made = stored.find((m) => m.name === 'On page two');
    __assert(made && made.page === pages()[pages().length - 1].textContent,
      `stored page: ${made && made.page}`);

    // Leave the deck on its first page: the tests after this one count tiles.
    pages()[0].click();
    await __sleep(60);
  },
});

__webTests.push({
  page: 'macros',
  name: 'a page can be renamed, and deleting one keeps its buttons',
  fn: async () => {
    const chips = () => [...document.querySelectorAll('#deckPages .page:not(.add)')]
      .map((c) => c.textContent);

    // Work on a page of its own so the fixtures on the first page survive.
    document.querySelector('#deckPages .page.add').click();
    await __sleep(60);
    document.getElementById('deckEdit').click();

    const tools = document.getElementById('deckPageTools');
    __assert(!tools.hidden, 'the page tools are hidden in edit mode');
    const press = (label) => tools.querySelectorAll('button').forEach((b) => {
      if (b.textContent === label) b.click();
    });

    tools.querySelector('input').value = 'Renamed page';
    press('Rename');
    await __sleep(400);
    __assert(chips().includes('Renamed page'), `pages: ${chips().join(', ')}`);

    // A button created here belongs to the renamed page.
    document.getElementById('macroAdd').click();
    document.getElementById('editName').value = 'Moves with the page';
    document.getElementById('editSteps').value = '{ENTER}';
    document.getElementById('editSave').click();
    await __sleep(400);
    let stored = JSON.parse(localStorage.getItem('esp32remote.macros') || '[]');
    const made = stored.find((m) => m.name === 'Moves with the page');
    __assert(made && made.page === 'Renamed page', `stored page: ${made && made.page}`);

    // Deleting the page must move its button somewhere, not delete it.
    const before = stored.length;
    press('Delete page');
    await __sleep(400);
    stored = JSON.parse(localStorage.getItem('esp32remote.macros') || '[]');
    __assert(!chips().includes('Renamed page'), 'the page is still in the strip');
    __assert(stored.length === before, 'deleting a page deleted its buttons');
    __assert(stored.some((m) => m.name === 'Moves with the page'),
      'the button did not survive the page delete');

    document.getElementById('deckEdit').click();
    chips().length;                       // leave the deck where the next test expects it
    document.querySelector('#deckPages .page:not(.add)').click();
    await __sleep(60);
  },
});

__webTests.push({
  page: 'macros',
  name: 'a deck button keeps its colour',
  fn: async () => {
    document.getElementById('deckEdit').click();
    const tile = [...document.querySelectorAll('.macro')]
      .find((c) => c.querySelector('.name').textContent === 'Open Chrome');
    tile.click();                       // in edit mode the tile opens the editor
    await __sleep(50);

    document.querySelector('#editColours [data-colour="blue"]').click();
    document.getElementById('editSave').click();
    await __sleep(400);

    const stored = JSON.parse(localStorage.getItem('esp32remote.macros') || '[]');
    const saved = stored.find((m) => m.name === 'Open Chrome');
    __assert(saved && saved.colour === 'blue', `stored: ${JSON.stringify(saved)}`);
    __assert(document.querySelector('.macro.c-blue'),
      'the tile did not take the colour');
    document.getElementById('deckEdit').click();
  },
});

__webTests.push({
  page: 'macros',
  name: 'a hold button starts on press and stops on release',
  fn: async () => {
    const original = localStorage.getItem('esp32remote.macros');
    const list = JSON.parse(original || '[]');
    list.push({ name: 'Hold volume', steps: '{REPEAT:40}{VOLUMEUP}{WAIT:60}{/REPEAT}', hold: true, page: 'Main' });
    localStorage.setItem('esp32remote.macros', JSON.stringify(list));

    // Remount so the view reads the store again.
    location.hash = '#/settings';
    await __waitView('settings');
    location.hash = '#/macros';
    await __waitView('macros');
    await __sleep(300);

    const tile = [...document.querySelectorAll('.macro')]
      .find((c) => c.querySelector('.name').textContent === 'Hold volume');
    __assert(tile, 'the hold button is not on the deck');
    __assert(tile.classList.contains('hold'), 'the tile is not marked as a hold button');
    __assert(tile.querySelector('.run').textContent === 'Run',
      'the hold button kept its run label');

    const cap = __macroCapture();
    const run = tile.querySelector('.run');
    run.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await __sleep(250);
    const during = cap.length;
    run.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await __sleep(400);
    const settled = cap.length;
    await __sleep(300);

    __assert(during > 0, 'pressing did not start the macro');
    __assert(cap.length === settled,
      'it was still sending after release');

    localStorage.setItem('esp32remote.macros', original);
    location.hash = '#/settings';
    await __waitView('settings');
    location.hash = '#/macros';
    await __waitView('macros');
    await __sleep(300);
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

    // The per-tile actions only exist in edit mode, so the test has to enter it
    // the way a person does.
    document.getElementById('deckEdit').click();
    __assert(document.getElementById('macroList').classList.contains('editing'),
      'the Edit button did not switch the deck into edit mode');

    const before = document.querySelectorAll('.macro').length;
    tap(find('Test Macro'), 'Delete');
    await __sleep(30);
    __assert(document.querySelectorAll('.macro').length === before,
      'the first tap deleted the macro');
    __assert(find('Test Macro'), 'the macro vanished before the confirmation');

    tap(find('Test Macro'), 'Delete?');
    await __sleep(500);
    __assert(!find('Test Macro'), 'the second tap did not delete the macro');
    document.getElementById('deckEdit').click();     // leave edit mode again
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
    __assert(__gateHidden(), 'the macro view asked for the code');

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
  for (let i = 0; i < 100 && !UiView.loaded; i++) await __sleep(50);
  __assert(UiView.loaded, 'the file list never loaded');
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
const __pickArchive = (file) => {
  const picker = document.getElementById('uiArchivePicker');
  const dt = new DataTransfer();
  dt.items.add(file);
  picker.files = dt.files;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
};

// A stored zip, the only kind the device accepts. The CRC is left at zero:
// neither the device nor the stub checks it, and the point of the test is the
// envelope, not the checksum.
function __zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const dirs = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const body = typeof f.body === 'string' ? enc.encode(f.body) : f.body;
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, 0, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, body.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);

    const dir = new Uint8Array(46 + name.length);
    const d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint32(20, body.length, true);
    d.setUint32(24, body.length, true);
    d.setUint16(28, name.length, true);
    d.setUint32(42, offset, true);
    dir.set(name, 46);

    parts.push(local, body);
    dirs.push(dir);
    offset += local.length + body.length;
  }
  const central = dirs.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, central, true);
  e.setUint32(16, offset, true);
  return new File([...parts, ...dirs, end], 'web.zip', { type: 'application/zip' });
}

let __embeddedCss = '';   // captured before the upload test replaces it

__webTests.push({
  page: 'ui',
  name: 'lists the bundle and says where each file is served from',
  fn: async () => {
    await __waitForUiFiles();
    __assert(__gateHidden(), 'the upload view asked for the code');

    const rows = [...document.querySelectorAll('#fileList .file')];
    const names = rows.map((r) => r.dataset.file);
    __assert(rows.length === 3, `listed ${rows.length} files: ${names.join('|')}`);
    __assert(names.includes('index.html') && names.includes('app.js')
      && names.includes('style.css'), `missing files: ${names.join('|')}`);
    __assert(!names.includes('pad.js') && !names.includes('router.js'),
      `the pre-bundle sources are still listed: ${names.join('|')}`);
    __assert(names.filter((n) => n === 'index.html').length === 1,
      'index.html was listed twice');
    for (const r of rows) {
      __assert(r.querySelector('.state').textContent.startsWith('built-in'),
        `${r.dataset.file} starts as "${r.querySelector('.state').textContent}"`);
    }
    __assert(document.getElementById('statusText').textContent.includes('filesystem'),
      `status: ${document.getElementById('statusText').textContent}`);
    __assert(document.getElementById('fsNote').textContent.includes('archive'),
      `size note: ${document.getElementById('fsNote').textContent}`);
    __assert(!document.querySelector('#fileList .upload'),
      'the listing still offers a per-file upload');
  },
});

__webTests.push({
  page: 'ui',
  name: 'uploading an archive replaces the whole UI',
  fn: async () => {
    await __waitForUiFiles();
    __embeddedCss = await (await fetch('/style.css')).text();
    __assert(__embeddedCss.includes('--accent'), 'the embedded stylesheet did not come back');

    const css = 'body{background:#123456}';
    const js = 'window.__fromArchive = true;';
    __pickArchive(__zip([
      { name: 'style.css', body: css },
      { name: 'app.js', body: js },
    ]));
    await __waitState('style.css', 'uploaded');
    await __waitState('app.js', 'uploaded');

    __assert((await (await fetch('/style.css')).text()) === css, 'style.css was not replaced');
    __assert((await (await fetch('/app.js')).text()) === js, 'app.js was not replaced');
    // The archive did not carry one of the three, so that one keeps its
    // built-in copy rather than being emptied.
    __assert(__state('index.html').startsWith('built-in'),
      `index.html became "${__state('index.html')}"`);
    const note = document.getElementById('uiNote').textContent;
    __assert(note.includes('Reload'), `note: ${note}`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'resetting brings the built-in UI back',
  fn: async () => {
    await __waitForUiFiles();
    __assert(__state('style.css').startsWith('uploaded'), 'the upload test did not leave files stored');
    window.confirm = () => true;   // the reset asks first

    document.getElementById('uiArchiveReset').click();
    await __waitState('style.css', 'built-in');
    await __waitState('app.js', 'built-in');

    __assert((await (await fetch('/style.css')).text()) === __embeddedCss,
      'the built-in stylesheet did not come back');
    const note = document.getElementById('uiNote').textContent;
    __assert(note.includes('built-in UI'), `note: ${note}`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'an archive naming a file that is not part of the UI is refused whole',
  fn: async () => {
    const before = await (await fetch('/style.css')).text();
    // A flat name is fine now, whoever emitted it - that is the point. What is
    // refused is anything that could be a path, the recovery page, hidden
    // files and the temp suffix the writer owns.
    for (const bad of ['../evil.js', 'a/b.js', 'recover.html', '.hidden', 'x.tmp']) {
      const zip = __zip([
        { name: 'style.css', body: 'body{color:red}' },
        { name: bad, body: 'x' },
      ]);
      const r = await fetch(`/ui/upload?token=${window.__CODE}`,
        { method: 'POST', body: zip, duplex: 'half' });
      __assert(r.status === 400, `an archive with ${bad} answered HTTP ${r.status}`);
    }
    // Nothing was published, not even the entry that was fine.
    __assert((await (await fetch('/style.css')).text()) === before,
      'a refused archive changed what is served');
    __assert(__state('style.css').startsWith('built-in'),
      `style.css became "${__state('style.css')}"`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'a file the firmware never heard of is served like any other',
  fn: async () => {
    // The point of dropping the asset-table whitelist: a user's own build can
    // ship as many files as it likes.
    __pickArchive(__zip([
      { name: 'chunk-4f2a.js', body: 'export const x = 1;' },
      { name: 'logo.svg', body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
    ]));
    await __waitState('chunk-4f2a.js', 'uploaded');

    const js = await fetch('/chunk-4f2a.js');
    __assert(js.status === 200, `the chunk answered HTTP ${js.status}`);
    __assert(js.headers.get('content-type').includes('javascript'),
      `the chunk was served as ${js.headers.get('content-type')}`);
    __assert((await js.text()) === 'export const x = 1;', 'the chunk came back changed');

    const svg = await fetch('/logo.svg');
    __assert(svg.status === 200, `the svg answered HTTP ${svg.status}`);
    __assert(svg.headers.get('content-type').includes('svg'),
      `the svg was served as ${svg.headers.get('content-type')}`);

    // The archive is the whole UI, so the files it did not carry are gone.
    __assert(!document.querySelector('.file[data-file="style.css"] .state')
      || __state('style.css').startsWith('built-in'),
      `style.css survived the archive: ${__state('style.css')}`);

    window.confirm = () => true;
    document.getElementById('uiArchiveReset').click();
    await __sleep(400);
    const gone = await fetch('/chunk-4f2a.js');
    __assert(gone.status === 404, `the chunk survived the reset: HTTP ${gone.status}`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'an empty upload is refused, not stored as an empty page',
  fn: async () => {
    const r = await fetch(`/ui/upload?token=${window.__CODE}`, { method: 'POST', body: '' });
    __assert(r.status === 400, `the endpoint answered HTTP ${r.status}`);

    await __waitForUiFiles();
    __pickArchive(new File([], 'web.zip', { type: 'application/zip' }));
    await __sleep(300);
    const note = document.getElementById('uiNote').textContent;
    __assert(note.includes('empty'), `note: ${note}`);
    __assert(__state('index.html').startsWith('built-in'),
      `index.html became "${__state('index.html')}"`);
  },
});

__webTests.push({
  page: 'ui',
  name: 'an over-size archive is refused, and the page refuses it first',
  fn: async () => {
    await __waitForUiFiles();
    const big = new Uint8Array(UiView.maxSize + 1);

    const r = await fetch(`/ui/upload?token=${window.__CODE}`,
      { method: 'POST', body: big, duplex: 'half' });
    __assert(r.status === 413, `the endpoint answered HTTP ${r.status}`);
    __assert(__state('app.js').startsWith('built-in'),
      `app.js became "${__state('app.js')}"`);

    // The page checks the size before the file leaves the browser.
    __pickArchive(new File([big], 'web.zip', { type: 'application/zip' }));
    await __sleep(300);
    const note = document.getElementById('uiNote').textContent;
    __assert(note.includes('Nothing was uploaded'), `note: ${note}`);
    __assert(__state('app.js').startsWith('built-in'),
      `app.js became "${__state('app.js')}"`);
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

// The same page at a desktop width: the two-row phone layout must not follow
// it there.
// ---------------------------------------------------------------- recovery page
__webTests.push({
  page: 'recover',
  name: 'the recovery page loads and repairs a broken uploaded shell',
  fn: async () => {
    // The shell is garbage, which is the one failure the UI cannot fix from
    // inside - every other page needs it.
    const broken = await fetch('/').then((r) => r.text());
    __assert(broken.includes('broken upload'),
      'the stub did not serve the broken shell, so this test proves nothing');

    __assert(document.getElementById('reset'),
      'the recovery page did not load with the shell broken');
    __assert(!document.getElementById('gate'),
      'the recovery page should not depend on the shell gate');

    // It loads no style.css, so it needs its own box-sizing reset; without one
    // the full-width input pushes the page wider than the screen.
    const d = document.documentElement;
    __assert(d.scrollWidth <= d.clientWidth,
      `the page overflows horizontally: ${d.scrollWidth} > ${d.clientWidth}`);

    document.getElementById('code').value = window.__CODE;
    document.getElementById('reset').click();
    await __sleep(600);

    const note = document.getElementById('note').textContent;
    __assert(note.includes('Reset'), `the page said: ${note}`);

    // And it actually repaired it: the real shell serves again.
    const fixed = await fetch('/').then((r) => r.text());
    __assert(fixed.includes('id="view"'),
      `the shell is still broken after reset: ${fixed.slice(0, 60)}`);
  },
});

// ---------------------------------------------------------------- control page, wide
// The same page at a desktop width: the two-row phone layout must not follow
// it there.

__webTests.push({
  page: 'control-desktop',
  name: 'desktop: the tabs stay on one row',
  fn: async () => {
    const tabs = [...document.querySelectorAll('.tabbar a')];
    __assert(tabs.length === 4, `${tabs.length} tabs`);
    const tops = new Set(tabs.map((a) => Math.round(a.getBoundingClientRect().top)));
    __assert(tops.size === 1, 'the tabs wrapped onto more than one row');
  },
});

__webTests.push({
  page: 'control-desktop',
  name: 'hover feedback exists for fine pointers, not coarse ones',
  fn: async () => {
    // :hover cannot be triggered synthetically, so the contract is checked
    // where it is defined: inside the media query a mouse matches. Keeping it
    // there is what stops a touch tap leaving a button stuck highlighted.
    const found = [];
    const walk = (rules, fine) => {
      for (const r of rules) {
        const media = r.media ? (r.conditionText || r.media.mediaText || '') : '';
        const inFine = fine || (/hover:\s*hover/.test(media) && /pointer:\s*fine/.test(media));
        if (r.selectorText && inFine && r.selectorText.includes(':hover')) {
          found.push(r.selectorText);
        }
        if (r.cssRules) walk(r.cssRules, inFine);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules, false); } catch (_) { /* cross-origin, not ours */ }
    }

    __assert(found.some((s) => s.includes('button')),
      `no button hover rule inside the pointer-fine query: ${found.join(' | ')}`);
    __assert(found.some((s) => s.includes('.k')),
      'the virtual keys have no hover state');
  },
});

// ---------------------------------------------------------------- control page, phone

__webTests.push({
  page: 'control',
  name: 'phone: four destinations, as tabs with a real target',
  fn: async () => {
    const bar = document.querySelector('.tabbar');
    __assert(bar, 'there is no tab bar');
    const tabs = [...bar.querySelectorAll('a')];
    __assert(tabs.length === 4, `${tabs.length} tabs, expected 4`);
    __assert(bar.scrollWidth <= bar.clientWidth + 1,
      `the tab bar scrolls sideways (${bar.scrollWidth} > ${bar.clientWidth})`);
    for (const a of tabs) {
      const r = a.getBoundingClientRect();
      __assert(r.left >= -0.5 && r.right <= window.innerWidth + 0.5,
        `${a.textContent} is clipped (${Math.round(r.left)}..${Math.round(r.right)} of ${window.innerWidth})`);
      __assert(r.height >= 44, `${a.textContent} is only ${Math.round(r.height)}px tall`);
    }
    __assert(bar.getBoundingClientRect().bottom <= window.innerHeight + 1,
      'the tab bar is below the fold');
  },
});

// Legibility is a requirement, not a preference: these three carry the whole
// teaching of the page, and the pad had them at 2.4:1 and 3.3:1.
const __lum = (rgb) => {
  const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const __contrast = (a, b) => {
  const l1 = __lum(a), l2 = __lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

__webTests.push({
  page: 'control',
  name: 'the hints are readable against the pad',
  fn: async () => {
    const padBg = getComputedStyle(document.getElementById('pad')).backgroundColor;

    const hint = getComputedStyle(document.getElementById('hint')).color;
    __assert(__contrast(hint, padBg) >= 4.5,
      `#hint is ${__contrast(hint, padBg).toFixed(2)}:1 on the pad`);

    const esc = getComputedStyle(document.getElementById('escHint')).color;
    __assert(__contrast(esc, padBg) >= 4.5,
      `#escHint is ${__contrast(esc, padBg).toFixed(2)}:1 on the pad`);

    // Every primary button in the app shares this pair.
    const btn = getComputedStyle(document.getElementById('helpClose'));
    __assert(__contrast(btn.color, btn.backgroundColor) >= 4.5,
      `a primary button is ${__contrast(btn.color, btn.backgroundColor).toFixed(2)}:1`);
  },
});

__webTests.push({
  page: 'control',
  name: 'the keyboard is not clipped by its own slot',
  fn: async () => {
    const slot = document.getElementById('kbd');
    slot.classList.add('show');
    // A stale dvh cap used to cut the bottom row in half at the tab bar.
    __assert(slot.scrollHeight <= slot.clientHeight + 1,
      `the keyboard overflows its slot (${slot.scrollHeight} > ${slot.clientHeight})`);
    const last = document.querySelector('#kbBuilt .krow:last-child .k');
    const box = last.getBoundingClientRect();
    __assert(box.bottom <= slot.getBoundingClientRect().bottom + 1,
      'the bottom key row is outside the slot');
    slot.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'the pointer buttons float on the pad and are big enough',
  fn: async () => {
    const pad = document.getElementById('pad').getBoundingClientRect();
    for (const id of ['bLeft', 'bMid', 'bRight']) {
      const b = document.getElementById(id).getBoundingClientRect();
      __assert(b.width >= 44 && b.height >= 44,
        `${id} is ${Math.round(b.width)}x${Math.round(b.height)}`);
      __assert(b.top >= pad.top && b.bottom <= pad.bottom + 1, `${id} is not on the pad`);
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'the Keys destination shows one pane at a time',
  fn: async () => {
    const slot = document.getElementById('kbd');
    slot.classList.add('show');
    const type = document.getElementById('type');
    const media = document.getElementById('mediaPanel');
    const page = (name) => document.querySelector(`#kbPages [data-page="${name}"]`).click();
    const tool = (id) => document.getElementById(id).click();

    page('media');
    __assert(media.classList.contains('show'), 'the media page did not open');
    __assert(!type.classList.contains('show'), 'the text pane stayed open');

    tool('kbToolText');
    __assert(type.classList.contains('show'), 'the text tool did not open the paste box');
    __assert(!media.classList.contains('show'), 'the media page stayed open');

    page('abc');
    __assert(!type.classList.contains('show') && !media.classList.contains('show'),
      'the keyboard page did not come back');
    slot.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'the host\'s Caps Lock shows up on the keyboard',
  fn: async () => {
    const slot = document.getElementById('kbd');
    slot.classList.add('show');
    const badge = document.getElementById('kbLeds');

    // The host has told us nothing yet: the badge must stay silent rather than
    // claim every LED is off. Saying "all off" when the state is unknown is the
    // same kind of lie as the fallback that guessed at the keyboard.
    __assert(badge.hidden, 'the badge is showing before the host said anything');
    await apiPost('/state', { known: false, caps: true });
    await PadView.pollLeds();
    __assert(badge.hidden, 'the badge guessed a lock state the host never sent');
    await apiPost('/state', { known: true });

    // The stub stands in for the host: POST /state is its way of saying what
    // the USB LED report contained.
    await apiPost('/state', { caps: true });
    await PadView.pollLeds();
    __assert(!badge.hidden && /CAPS/.test(badge.textContent),
      `badge says: "${badge.textContent}"`);

    await apiPost('/state', { caps: false });
    await PadView.pollLeds();
    __assert(badge.hidden, 'the badge stayed lit after Caps Lock went off');

    slot.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'absolute mode hovers and clicks without capturing',
  fn: async () => {
    // Pointer lock exists to turn movement into deltas. In absolute mode the
    // position comes from where the pointer is, so locking it would be the
    // wrong model - and would hide the cursor the user needs to see.
    PadView.setPointerMode('abs');
    const pad = document.getElementById('pad');
    const r = pad.getBoundingClientRect();
    const at = (x, y) => ({ clientX: r.left + x, clientY: r.top + y });
    const cap = __capture();

    pad.dispatchEvent(new PointerEvent('pointermove', {
      pointerType: 'mouse', bubbles: true, ...at(20, 20),
    }));
    await __sleep(40);
    const hover = cap.filter((m) => m[0] === 0x06).pop();
    __assert(hover, 'hovering sent no position');
    __assert(PadView.captured === false, 'absolute mode captured the pointer');

    pad.dispatchEvent(new PointerEvent('pointerdown', {
      pointerType: 'mouse', bubbles: true, ...at(20, 20),
    }));
    const press = cap.filter((m) => m[0] === 0x06).pop();
    __assert(press[5] === 1, `no button press: buttons=${press[5]}`);
    __assert(PadView.captured === false, 'the press captured the pointer');

    window.dispatchEvent(new PointerEvent('mouseup', { bubbles: true, button: 0 }));
    const up = cap.filter((m) => m[0] === 0x06).pop();
    __assert(up[5] === 0, `the release did not clear the button: ${up[5]}`);

    PadView.setPointerMode('rel');
  },
});

__webTests.push({
  page: 'control',
  name: 'absolute mode maps the pad onto the host screen',
  fn: async () => {
    const pad = document.getElementById('pad');
    const r = pad.getBoundingClientRect();

    const corner = PadView.absoluteFor(r.left, r.top);
    __assert(corner[0] === 0 && corner[1] === 0, `top-left is ${corner}`);
    const far = PadView.absoluteFor(r.right, r.bottom);
    __assert(far[0] === 32767 && far[1] === 32767, `bottom-right is ${far}`);

    const mid = PadView.absoluteFor(r.left + r.width / 2, r.top + r.height / 2);
    __assert(Math.abs(mid[0] - 16384) <= 1 && Math.abs(mid[1] - 16384) <= 1,
      `centre is ${mid}`);

    // Outside the pad clamps instead of wrapping round.
    const outside = PadView.absoluteFor(r.left - 500, r.bottom + 500);
    __assert(outside[0] === 0 && outside[1] === 32767, `clamped is ${outside}`);
  },
});

__webTests.push({
  page: 'control',
  name: 'a touch in absolute mode is a position, not a drag',
  fn: async () => {
    const pad = document.getElementById('pad');
    const r = pad.getBoundingClientRect();
    const at = (dx, dy) => ({ clientX: r.left + dx, clientY: r.top + dy });

    PadView.setPointerMode('abs');
    const cap = __capture();
    const ev = (type, p) => pad.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'touch', bubbles: true, ...at(p[0], p[1]),
    }));

    ev('pointerdown', [10, 20]);
    const press = cap.filter((m) => m[0] === 0x06).pop();
    __assert(press, 'no pointer report was sent');
    __assert(press.length === 6, `pointer report is ${press.length} bytes`);
    __assert(press[5] === 1, `the press did not set button 1: ${press[5]}`);
    const x = press[1] | (press[2] << 8);
    const y = press[3] | (press[4] << 8);
    __assert(x === Math.round((10 / r.width) * 32767),
      `x is ${x}, expected ${Math.round((10 / r.width) * 32767)}`);

    // Dragging updates the position; there is no delta report at all.
    const before = cap.length;
    ev('pointermove', [r.width / 2, r.height / 2]);
    const moved = cap.slice(before).filter((m) => m[0] === 0x06).pop();
    __assert(moved, 'a drag sent no position');
    __assert(!cap.slice(before).some((m) => m[0] === 0x01),
      'a drag in absolute mode sent a relative mouse report');

    ev('pointerup', [r.width / 2, r.height / 2]);
    const up = cap.filter((m) => m[0] === 0x06).pop();
    __assert(up[5] === 0, `the release did not clear the button: ${up[5]}`);

    // The floating L/R/M buttons are clicks, and in absolute mode a click is a
    // press where the pointer already is - not a relative report.
    const capBtn = __capture();
    const btn = document.getElementById('bLeft');
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    __assert(capBtn.some((m) => m[0] === 0x06 && m[5] === 1),
      'the L button did not press in absolute mode');
    __assert(!capBtn.some((m) => m[0] === 0x01),
      'the L button sent a relative report while in absolute mode');
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

    // Back in relative mode a drag is a delta again. It takes a real move:
    // relative mode deliberately waits out the tap slop so a tap does not
    // nudge the cursor before its click lands.
    PadView.setPointerMode('rel');
    const cap2 = __capture();
    ev('pointerdown', [10, 20]);
    ev('pointermove', [60, 60]);
    __assert(cap2.some((m) => m[0] === 0x01),
      'relative mode stopped sending mouse reports');
    __assert(!cap2.some((m) => m[0] === 0x06),
      'relative mode is still sending absolute reports');
    ev('pointerup', [60, 60]);
  },
});

__webTests.push({
  page: 'control',
  name: 'the host layout decides what a key types',
  fn: async () => {
    const before = { ...PadView.TYPE_MAP };
    // US: @ is Shift+2, " is Shift+'
    __assert(before['@'][0] === 'Digit2' && before['@'][1] === true,
      `US @ is ${JSON.stringify(before['@'])}`);
    __assert(before['#'][0] === 'Digit3', `US # is ${JSON.stringify(before['#'])}`);

    setHostLayout('uk');
    PadView.applyHostLayout();
    const uk = PadView.TYPE_MAP;
    // UK swaps them, and # moves to its own key.
    __assert(uk['"'][0] === 'Digit2' && uk['"'][1] === true,
      `UK " is ${JSON.stringify(uk['"'])}`);
    __assert(uk['@'][0] === 'Quote' && uk['@'][1] === true,
      `UK @ is ${JSON.stringify(uk['@'])}`);
    __assert(uk['#'][0] === 'NonUSHash' && uk['#'][1] === false,
      `UK # is ${JSON.stringify(uk['#'])}`);

    // The picture follows the map: the key labelled # sends NonUSHash.
    const slot = document.getElementById('kbd');
    slot.classList.add('show');
    document.querySelector('#kbPages [data-page="sym"]').click();
    const hashKey = [...document.querySelectorAll('#kbBuilt .k')]
      .find((k) => k.dataset.code === 'NonUSHash');
    __assert(hashKey && hashKey.querySelector('.p').textContent === '#',
      'the UK symbols page has no # key');
    slot.classList.remove('show');

    setHostLayout('us');
    PadView.applyHostLayout();
    __assert(PadView.TYPE_MAP['@'][0] === 'Digit2', 'did not switch back to US');
  },
});

__webTests.push({
  page: 'control',
  name: 'Shift relabels the keys it changes',
  fn: async () => {
    const slot = document.getElementById('kbd');
    slot.classList.add('show');
    const q = () => document.querySelector('#kbBuilt .k[data-code="KeyQ"]');
    const shift = () => document.querySelector('#kbBuilt .k[data-code="ShiftLeft"]');

    __assert(q().querySelector('.p').textContent === 'q', 'q does not start lowercase');
    shift().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    __assert(q().querySelector('.p').textContent === 'Q',
      'Shift did not bring the shifted character to the front');
    __assert(q().classList.contains('shifted'), 'the shifted class is missing');

    shift().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    __assert(q().querySelector('.p').textContent === 'q', 'the label did not revert');
    slot.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'every key the keyboard draws has a HID usage',
  fn: async () => {
    // A key with no usage is a key that does nothing, and nothing else notices:
    // the UK "#" shipped dead for want of one entry in HID_KEYS.
    const missing = [];
    for (const layoutId of Object.keys(LAYOUT_ROWS)) {
      const saved = hostLayoutId();
      setHostLayout(layoutId);
      for (const [pageName, rows] of Object.entries(PadView.keyPages())) {
        for (const row of rows) {
          for (const [code] of row) {
            if (String(code).startsWith('p:')) continue;
            // A modifier is a report bit, not a usage - it is the one kind of
            // key that legitimately has no entry in HID_KEYS.
            if (HID_KEYS[code] === undefined && PadView.MOD[code] === undefined) {
              missing.push(`${layoutId}/${pageName}: ${code}`);
            }
          }
        }
      }
      setHostLayout(saved);
    }
    __assert(!missing.length, `keys with no usage: ${missing.join(', ')}`);
  },
});

__webTests.push({
  page: 'control',
  name: 'the keypad sends keypad usages, not the number row',
  fn: async () => {
    // KP7 and Digit7 are different keys to the host, and with Num Lock off KP7
    // is Home. A numpad built from the number row would be a lie.
    const slot = document.getElementById('kbd');
    slot.classList.add('show');
    document.querySelector('#kbPages [data-page="kp"]').click();

    const cap = __capture();
    const seven = document.querySelector('#kbBuilt .k[data-code="Numpad7"]');
    __assert(seven, 'no keypad 7 on the keypad page');
    seven.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    seven.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const press = cap.find((r) => r[0] === 2 && r[2] !== 0);
    __assert(press && press[2] === 0x5F,
      `keypad 7 sent 0x${press && press[2].toString(16)}, expected 0x5f (KP7)`);

    document.querySelector('#kbPages [data-page="abc"]').click();
    slot.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'the letter page is five rows, and the rest are pages',
  fn: async () => {
    // A phone keyboard is four rows because that is what a thumb can read.
    // Digits and arrows used to sit here; the strip made switching free, so
    // the typing surface is a keyboard again.
    const slot = document.getElementById('kbd');
    slot.classList.add('show');
    document.querySelector('#kbPages [data-page="abc"]').click();

    const rows = document.querySelectorAll('#kbBuilt .krow');
    __assert(rows.length === 5, `the letter page has ${rows.length} rows`);
    for (const code of ['Digit1', 'ArrowLeft']) {
      __assert(!document.querySelector(`#kbBuilt .k[data-code="${code}"]`),
        `${code} is still crammed onto the letter page`);
    }

    document.querySelector('#kbPages [data-page="sym"]').click();
    for (const code of ['Digit1', 'Digit0']) {
      __assert(document.querySelector(`#kbBuilt .k[data-code="${code}"]`),
        `${code} is not on the ?123 page`);
    }
    slot.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'the strip scrolls with a wheel, and only while it can',
  fn: async () => {
    // A hidden slot has no width, so the strip has to be open for this.
    const slot = document.getElementById('kbd');
    const wasOpen = slot.classList.contains('show');
    slot.classList.add('show');

    const el = document.getElementById('kbPages');
    const made = [];
    // Six more labels is more than the row can hold at phone width, which is
    // the only way to exercise overflow before profiles can add pages.
    for (let i = 0; i < 6; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbpage';
      b.dataset.page = 'zz' + i;
      b.textContent = 'Extra';
      el.appendChild(b);
      made.push(b);
    }
    try {
      __assert(getComputedStyle(el).overflowX === 'auto',
        `overflow-x is ${getComputedStyle(el).overflowX}`);
      __assert(el.scrollWidth > el.clientWidth,
        `the strip did not overflow: ${el.scrollWidth} <= ${el.clientWidth} ` +
        `(viewport ${innerWidth}, strip ${document.getElementById('kbStrip').clientWidth})`);

      const ev = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      await __sleep(40);
      __assert(el.scrollLeft > 0, 'a wheel event did not scroll the strip sideways');
      __assert(ev.defaultPrevented, 'the wheel was not taken, so the page scrolled instead');

      // At the far end the strip stops taking the wheel, so the page keeps it.
      el.scrollLeft = el.scrollWidth;
      await __sleep(40);
      const end = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      el.dispatchEvent(end);
      __assert(!end.defaultPrevented, 'the wheel is still swallowed at the end of the strip');
    } finally {
      for (const b of made) b.remove();
      el.scrollLeft = 0;
      el.dispatchEvent(new Event('scroll'));
      if (!wasOpen) slot.classList.remove('show');
    }
  },
});

__webTests.push({
  page: 'control',
  name: 'slash types slash, and Shift makes it a question mark',
  fn: async () => {
    const slot = document.getElementById('kbd');
    slot.classList.add('show');
    document.querySelector('#kbPages [data-page="abc"]').click();
    const slash = () => document.querySelector('#kbBuilt .k[data-code="Slash"]');
    const shift = () => document.querySelector('#kbBuilt .k[data-code="ShiftLeft"]');

    // One key, like the real board: by default it is a slash.
    __assert(slash().querySelector('.p').textContent === '/',
      `the key shows "${slash().querySelector('.p').textContent}"`);
    const cap = __capture();
    slash().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    slash().dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const plain = cap.find((r) => r[0] === 2 && r[2] !== 0);
    __assert(plain && plain[1] === 0x00 && plain[2] === 0x38,
      `"/" sent mod=${plain && plain[1]} key=0x${plain && plain[2].toString(16)}`);

    // Latching Shift relabels it, and then it types the question mark.
    shift().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    __assert(slash().querySelector('.p').textContent === '?',
      'Shift did not bring the question mark to the front');
    const cap2 = __capture();
    slash().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    slash().dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const shifted = cap2.find((r) => r[0] === 2 && r[2] !== 0);
    __assert(shifted && shifted[1] === 0x02 && shifted[2] === 0x38,
      `"?" sent mod=${shifted && shifted[1]} key=0x${shifted && shifted[2].toString(16)}`);

    slot.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'every virtual key is labelled, on every page',
  fn: async () => {
    // The panel is built at init and only toggled, so this does not need to
    // open it - which matters, because a failed assertion must not leave the
    // keyboard covering the next test's page.
    const blank = () => [...document.querySelectorAll('#kbBuilt .k')]
      .filter((k) => !k.textContent.trim())
      .map((k) => k.dataset.code);

    document.querySelector('#kbPages [data-page="abc"]').click();
    __assert(document.querySelectorAll('#kbBuilt .k').length >= 30,
      'the letter page is missing most of its keys');
    __assert(!blank().length, `unlabelled on the letter page: ${blank().join(', ')}`);

    for (const page of ['sym', 'fn', 'kp', 'abc']) {
      document.querySelector(`#kbPages [data-page="${page}"]`).click();
      __assert(!blank().length, `unlabelled on ${page}: ${blank().join(', ')}`);
    }
  },
});


__webTests.push({
  page: 'control',
  name: 'the keyboard slot can hand over to the phone keyboard',
  fn: async () => {
    const built = document.getElementById('kbBuilt');
    const capture = document.getElementById('kbCapture');
    __assert(built && capture, 'the keyboard slot has no two halves');

    // Normalise: a previous run of this test leaves the choice persisted.
    const tool = document.getElementById('kbToolSource');
    PadView.setKeyboardSource('built');
    __assert(!built.hidden && capture.hidden, 'the slot did not start on the built-in keyboard');

    tool.click();
    __assert(built.hidden && !capture.hidden, 'the tool did not swap the slot');
    __assert(tool.classList.contains('on'), 'the tool does not mark the phone keyboard as live');
    __assert(tool.getAttribute('aria-pressed') === 'true', 'the tool does not report its state');
    __assert(localStorage.getItem('esp32remote.keyboardSource') === 'system',
      'the choice was not remembered for next time');

    // While the phone's keyboard is up, no page is current: the slot is not
    // showing one.
    __assert(!document.querySelector('#kbPages .kbpage.on'),
      'a page is still marked while the phone keyboard is live');

    tool.click();
    __assert(!built.hidden && capture.hidden, 'switching back did not restore the built-in keys');
  },
});

__webTests.push({
  page: 'control',
  name: 'a phone keystroke reaches the host exactly once',
  fn: async () => {
    const field = PadView.captureField;
    PadView.setKeyboardSource('system', false);
    // The translator listens on the document and only acts while the field owns
    // the caret, so the panel has to be open for focus to be possible.
    const panel = document.getElementById('kbd');
    if (!panel.classList.contains('show')) panel.classList.add('show');
    field.focus();
    __assert(document.activeElement === field, 'the capture field did not take focus');

    // Pinned at the origin, out of sight. Anything visible down here would be
    // what the browser scrolls into view when the keyboard opens.
    const cs = getComputedStyle(field);
    const box = field.getBoundingClientRect();
    __assert(cs.position === 'fixed', `the capture field is ${cs.position}`);
    __assert(box.top === 0 && box.left === 0, `the capture field sits at ${box.top},${box.left}`);
    __assert(Number(cs.opacity) === 0, 'the capture field is visible');

    const sent = __capture();

    // Printable characters: Android reports the press with no code at all
    // (keyCode 229) and then delivers the text.
    field.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Unidentified', code: '', keyCode: 229, bubbles: true, cancelable: true,
    }));
    __assert(sent.length === 0, `the IME-consumed keydown sent ${sent.length} reports`);

    // The same trap on a desktop, where a plain letter has a real code and an
    // input event: the key must be skipped or the text path doubles it.
    field.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', code: 'KeyA', keyCode: 65, bubbles: true, cancelable: true,
    }));
    __assert(sent.length === 0, 'a plain letter keydown was sent, so its text would double');

    // ...and the text must produce one press and one release.
    field.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText', data: 'a', bubbles: true, cancelable: true,
    }));
    __assert(sent.length === 2, `one character produced ${sent.length} reports`);
    __assert(sent[0][2] === 0x04, `the press report is ${sent[0]}`);
    __assert(sent[1][1] === 0 && sent[1][2] === 0, `the release report is ${sent[1]}`);

    PadView.setKeyboardSource('built');
    panel.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'keys are not sent twice, and chords keep their modifier',
  fn: async () => {
    const field = PadView.captureField;
    PadView.setKeyboardSource('system', false);
    const panel = document.getElementById('kbd');
    if (!panel.classList.contains('show')) panel.classList.add('show');
    field.focus();
    __assert(document.activeElement === field, 'the capture field did not take focus');
    const sent = __capture();
    const key = (type, init) => field.dispatchEvent(
      new KeyboardEvent(type, Object.assign({ bubbles: true, cancelable: true }, init)));

    const tab = new KeyboardEvent('keydown', {
      key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true,
    });
    field.dispatchEvent(tab);
    __assert(tab.defaultPrevented, 'Tab was not cancelled, so it would move focus');
    __assert(sent.length === 1 && sent[0][2] === 0x2B, `Tab sent ${JSON.stringify(sent)}`);

    // An IME can move focus itself for its own Tab key even though the keydown
    // was cancelled. The caret has to come back, or the next key goes to a
    // button instead of the host.
    document.getElementById('kbToolText').focus();
    __assert(document.activeElement !== field, 'the field kept focus, so this proves nothing');
    await __sleep(30);
    __assert(document.activeElement === field,
      'Tab moved the caret away and it was not put back');

    // Enter arrives as a keydown and again as insertLineBreak. Sending both is
    // the double-typing bug this test exists to prevent.
    sent.length = 0;
    key('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 });
    const afterKey = sent.length;
    field.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertLineBreak', bubbles: true, cancelable: true,
    }));
    __assert(sent.length === afterKey, 'the line break was sent a second time');

    key('keyup', { key: 'Enter', code: 'Enter', keyCode: 13 });
    __assert(sent[sent.length - 1][1] === 0 && sent[sent.length - 1][2] === 0,
      'Enter was never released');

    // Ctrl+C arrives as a real key with the flag, which is the whole reason a
    // system keyboard can drive this device.
    sent.length = 0;
    key('keydown', { key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true });
    __assert(sent.length === 1, `one chord produced ${sent.length} reports`);
    __assert(sent[0][1] === 0x01 && sent[0][2] === 0x06,
      `Ctrl+C sent ${JSON.stringify(sent[0])}`);
    // Nothing echoes in this mode, so the flash is the only confirmation that
    // a key reached the host - and it has to name the chord, not just the key.
    __assert(document.getElementById('flash').textContent === 'Ctrl+C',
      `the confirmation says: ${document.getElementById('flash').textContent}`);

    // Leaving the field must not strand a held key on the host.
    PadView.held.add('KeyA');
    sent.length = 0;
    field.dispatchEvent(new FocusEvent('blur'));
    __assert(sent.length > 0, 'blur sent nothing');
    __assert(sent.every((r) => r.slice(1).every((v) => v === 0)),
      `blur left something held: ${JSON.stringify(sent)}`);

    PadView.setKeyboardSource('built');
    panel.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'the type button focuses the hidden field',
  fn: async () => {
    PadView.setKeyboardSource('system');
    const panel = document.getElementById('kbd');
    if (!panel.classList.contains('show')) panel.classList.add('show');

    const field = PadView.captureField;
    field.blur();
    __assert(document.activeElement !== field, 'the field was still focused');

    document.getElementById('kbCaptureOpen').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }));
    __assert(document.activeElement === field, 'the button did not focus the field');

    PadView.setKeyboardSource('built');
    panel.classList.remove('show');
  },
});

__webTests.push({
  page: 'control',
  name: 'the switch acts on a tap, not only on a click',
  fn: async () => {
    // Android can swallow the click when the keyboard dismisses and the layout
    // moves under the finger, so the tool has to act on pointerdown.
    const tool = document.getElementById('kbToolSource');
    PadView.setKeyboardSource('built');
    tool.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    __assert(PadView.keyboardSource === 'system', 'a tap did not switch the source');
    tool.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    __assert(PadView.keyboardSource === 'built', 'a tap did not switch back');
  },
});

__webTests.push({
  page: 'control',
  name: 'the page asks the browser to shrink for the keyboard',
  fn: async () => {
    // Without this the IME overlays the page and the bottom of the layout is
    // simply hidden behind it.
    const meta = document.querySelector('meta[name="viewport"]');
    __assert(meta && /interactive-widget=resizes-content/.test(meta.content),
      `viewport meta is: ${meta && meta.content}`);
  },
});


// ---------------------------------------------------------------- navigation
// The four views are templates in one shell; changing the hash mounts one and
// unmounts the other. These tests drive the router exactly as a user does.
const __VIEW_MARKERS = {
  control: 'pad', settings: 'usbProduct', macros: 'macroList', ui: 'fileList',
};

const __viewName = () => document.getElementById('view').dataset.view;

async function __waitView(name) {
  for (let i = 0; i < 100 && __viewName() !== name; i++) await __sleep(50);
  __assert(__viewName() === name, `view is "${__viewName()}", expected "${name}"`);
}

async function __goView(name, hash) {
  location.hash = hash;
  await __waitView(name);
  __assertOnlyMounted(name);
}

function __assertOnlyMounted(name) {
  for (const [view, id] of Object.entries(__VIEW_MARKERS)) {
    const present = !!document.getElementById(id);
    __assert(present === (view === name),
      `${id} is ${present ? 'mounted' : 'missing'} while ${name} is the view`);
  }
  __assert(document.querySelectorAll('#view > *').length > 0,
    `nothing is mounted for ${name}`);
}

__webTests.push({
  page: 'navigation',
  name: 'each hash mounts its view and only its view',
  fn: async () => {
    await __waitView('control');
    __assertOnlyMounted('control');

    await __goView('settings', '#/settings');
    __assert(document.getElementById('usbProduct'), 'the settings form is missing');

    await __goView('macros', '#/macros');
    __assert(document.querySelector('#macroList'), 'the macro list is missing');

    await __goView('ui', '#/ui');
    __assert(document.querySelector('#fileList'), 'the file list is missing');

    await __goView('control', '#/');
    __assert(document.getElementById('hint'), 'the hint is missing from the control view');
  },
});

__webTests.push({
  page: 'navigation',
  name: 'back and forward land on the view the hash names',
  fn: async () => {
    await __goView('settings', '#/settings');
    await __goView('macros', '#/macros');

    history.back();
    await __waitView('settings');
    __assertOnlyMounted('settings');

    history.back();
    await __waitView('control');
    __assertOnlyMounted('control');

    history.forward();
    await __waitView('settings');
    __assertOnlyMounted('settings');

    await __goView('control', '#/');
  },
});

__webTests.push({
  page: 'navigation',
  name: 'an unknown hash falls back to the control view',
  fn: async () => {
    await __goView('settings', '#/settings');
    location.hash = '#/not-a-view';
    await __waitView('control');
    __assertOnlyMounted('control');
    await __goView('control', '#/');
  },
});

__webTests.push({
  page: 'navigation',
  name: 'leaving the pad releases held state and closes its socket',
  fn: async () => {
    await __goView('control', '#/');

    // The recorder stands in for the device, so the reports are visible.
    const cap = __capture();
    PadView.held.add('KeyA');
    PadView.buttons = 1;

    location.hash = '#/settings';
    await __waitView('settings');

    __assert(cap.some((r) => r[0] === 5),
      'leaving the pad did not send a release report');
    __assert(PadView.held.size === 0, 'held keys survived the unmount');
    __assert(PadView.ws === null, 'the pad socket was not closed');
    __assert(PadView.reconnectTimer === null, 'the pad left a reconnect timer armed');

    // Longer than the 1.5 s retry: a stray onclose handler would reconnect.
    await __sleep(1800);
    __assert(PadView.ws === null, 'the pad opened a socket after it was unmounted');
  },
});

__webTests.push({
  page: 'navigation',
  name: 'leaving the macros view closes its socket and stops the heartbeat',
  fn: async () => {
    location.hash = '#/macros';
    await __waitView('macros');
    for (let i = 0; i < 40 && !MacrosView.ws; i++) await __sleep(50);
    __assert(MacrosView.ws, 'the macros view never opened a socket');

    location.hash = '#/ui';
    await __waitView('ui');
    __assert(MacrosView.ws === null, 'the macros socket was not closed');
    __assert(MacrosView.reconnectTimer === null,
      'the macros view left a reconnect timer armed');

    // Its pagehide listener belongs to the mounted view too.
    const cap = [];
    MacrosView.ws = { readyState: 1, send: (b) => cap.push(Array.from(b)) };
    MacrosView.wsReady = true;
    window.dispatchEvent(new Event('pagehide'));
    __assert(cap.length === 0,
      `the macros pagehide listener sent ${cap.length} reports after unmounting`);
    MacrosView.ws = null;
    MacrosView.wsReady = false;

    await __sleep(1800);
    __assert(MacrosView.ws === null, 'the macros view reopened a socket after unmount');
  },
});

__webTests.push({
  page: 'navigation',
  name: 'window listeners belong to the mounted view only',
  fn: async () => {
    await __goView('control', '#/');
    // This browser had its storage cleared earlier, so the first-visit help is
    // open. It is modal on purpose; dismiss it before typing.
    const help = document.getElementById('help');
    if (help && !help.hidden) document.getElementById('helpClose').click();

    // Leave the pad, then give its module a recorder and press a key. If its
    // window listener survived the unmount, this produces a report.
    location.hash = '#/settings';
    await __waitView('settings');
    const afterLeave = [];
    PadView.ws = { readyState: 1, send: (b) => afterLeave.push(Array.from(b)) };
    PadView.wsReady = true;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    __assert(afterLeave.length === 0,
      `the pad listener sent ${afterLeave.length} reports after unmounting`);
    PadView.ws = null;
    PadView.wsReady = false;

    // Back on the pad, the listener must be attached once: a duplicate would
    // send both a press and two release reports. Physical keys only leave the
    // page while captured, so take the pointer first.
    await __goView('control', '#/');
    const cap = __capture();
    PadView.captured = true;
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));
    } finally {
      PadView.captured = false;
    }
    const presses = cap.filter((r) => r[0] === 2 && r[2] === 4).length;
    const releases = cap.filter((r) => r[0] === 2 && r[2] === 0).length;
    __assert(presses === 1, `${presses} key press reports after remounting, expected 1`);
    __assert(releases === 1, `${releases} key release reports after remounting, expected 1`);
  },
});

// The runner reloaded this page after the access code had been saved and
// scrubbed from the URL; the hash survived, so the same view must come back.
__webTests.push({
  page: 'refresh',
  name: 'a reload lands on the view named in the hash',
  fn: async () => {
    await __waitView('macros');
    __assertOnlyMounted('macros');
    __assert(document.getElementById('macroAdd'), 'the macro view did not initialise');
    __assert(location.hash === '#/macros', `the hash is "${location.hash}"`);
  },
});

// ---------------------------------------------------------------- access gate
// One gate in the shell, not one per view. A fresh browser has no saved code,
// so entering it must unlock the view the hash already names.
__webTests.push({
  page: 'gate',
  name: 'the shell gate unlocks the view in the hash and saves the code',
  fn: async () => {
    await __sleep(300);
    const gate = document.getElementById('gate');
    __assert(gate && !gate.classList.contains('hidden'),
      'the gate is hidden with no saved code');
    __assert(location.hash === '#/settings', `hash: ${location.hash}`);

    document.getElementById('tokenInput').value = window.__CODE;
    document.getElementById('tokenGo').click();
    await __waitView('settings');

    __assert(__gateHidden(), 'the gate stayed up after a valid code');
    __assert(localStorage.getItem('esp32remote.token') === window.__CODE,
      'the accepted code was not saved');
    __assertOnlyMounted('settings');
  },
});
