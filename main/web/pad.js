// Control page: WebSocket transport, touchpad gestures, virtual keyboard and
// text typing.
//
// Gesture model (touch): the finger count decides what a drag does, and a
// short gesture with little movement is a tap:
//
//   1 finger  drag -> move cursor      tap -> left click
//   2 fingers drag -> scroll           tap -> right click
//   3 fingers drag -> hold + drag      tap -> middle click
//
// A mouse (desktop, or a laptop trackpad, which both report pointerType
// "mouse") cannot express multi-touch, so it uses pointer lock instead: click
// the pad to capture, move freely, Escape to release.
//
// The view is mounted and unmounted by router.js. Every element is looked up
// and every listener is attached in init(), because the pad is a fresh clone
// each time; destroy() has to put back what init() took out.

const PadView = (() => {

// ---------------------------------------------------------------- HID maps
// Keyboard/Keypad usage page 0x07
const KEY = {
  KeyA:0x04,KeyB:0x05,KeyC:0x06,KeyD:0x07,KeyE:0x08,KeyF:0x09,KeyG:0x0A,KeyH:0x0B,
  KeyI:0x0C,KeyJ:0x0D,KeyK:0x0E,KeyL:0x0F,KeyM:0x10,KeyN:0x11,KeyO:0x12,KeyP:0x13,
  KeyQ:0x14,KeyR:0x15,KeyS:0x16,KeyT:0x17,KeyU:0x18,KeyV:0x19,KeyW:0x1A,KeyX:0x1B,
  KeyY:0x1C,KeyZ:0x1D,
  Digit1:0x1E,Digit2:0x1F,Digit3:0x20,Digit4:0x21,Digit5:0x22,Digit6:0x23,Digit7:0x24,
  Digit8:0x25,Digit9:0x26,Digit0:0x27,
  Enter:0x28,Escape:0x29,Backspace:0x2A,Tab:0x2B,Space:0x2C,Minus:0x2D,Equal:0x2E,
  BracketLeft:0x2F,BracketRight:0x30,Backslash:0x31,Semicolon:0x33,Quote:0x34,
  Backquote:0x35,Comma:0x36,Period:0x37,Slash:0x38,CapsLock:0x39,
  F1:0x3A,F2:0x3B,F3:0x3C,F4:0x3D,F5:0x3E,F6:0x3F,F7:0x40,F8:0x41,F9:0x42,
  F10:0x43,F11:0x44,F12:0x45,
  Insert:0x49,Home:0x4A,PageUp:0x4B,Delete:0x4C,End:0x4D,PageDown:0x4E,
  ArrowRight:0x4F,ArrowLeft:0x50,ArrowDown:0x51,ArrowUp:0x52,
};

const MOD = {
  ControlLeft:0x01, ShiftLeft:0x02,   AltLeft:0x04,   MetaLeft:0x08,
  ControlRight:0x10,ShiftRight:0x20,  AltRight:0x40,  MetaRight:0x80,
};

// ---------------------------------------------------------------- state
const held = new Set();        // event.code strings currently down
let buttons = 0;               // mouse button bitmask
let ws = null;
let wsReady = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

// Assigned by init(); null while the view is not mounted.
let pad = null;
let dot = null;
let statusText = null;
let flashEl = null;
let kbd = null;
let mediaEl = null;
let mediaPanel = null;
let typePanel = null;
let typeTextEl = null;
let typeNote = null;
let heartbeatTimer = null;

// ---------------------------------------------------------------- transport
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    wsReady = true;
    reconnectAttempts = 0;
    setStatus('connected', 'on');
    sendKeyboard();               // resync held state
  };
  ws.onclose = () => {
    wsReady = false;
    // The socket cannot carry a release, but the local state must not claim
    // keys are held either - a reconnect sends a fresh report from nothing.
    releaseAll();
    setStatus('disconnected', 'off');
    scheduleReconnect();
  };
  ws.onerror = () => { wsReady = false; };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts >= 5) {
    // Retrying forever against an address that no longer answers is how a
    // moved DHCP lease hides itself.
    setStatus('disconnected - reload this page', 'off');
  }
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
}

function setStatus(text, cls) {
  statusText.textContent = text;
  dot.className = 'dot ' + cls;
}

function send(bytes) {
  if (wsReady && ws && ws.readyState === 1) ws.send(bytes);
}

// ---------------------------------------------------------------- senders
function clamp8(v) { return Math.max(-127, Math.min(127, Math.round(v))); }

function sendMouse(dx, dy, wheel) {
  send(new Uint8Array([0x01,
                       clamp8(dx) & 0xFF, clamp8(dy) & 0xFF,
                       buttons & 0xFF, clamp8(wheel) & 0xFF]));
}

// A report carries signed 8-bit deltas, so anything larger has to go as several
// reports. Clamping instead silently drops distance and the remote cursor lags
// the physical one - which is exactly what a fast flick looks like.
function sendMove(dx, dy) {
  let x = Math.round(dx);
  let y = Math.round(dy);
  // Bounded to a short burst: 8 reports is already 1000px of movement in one
  // event, and an unbounded loop here would be a stall rather than a fix.
  for (let n = 0; (x || y) && n < 8; n++) {
    const sx = Math.max(-127, Math.min(127, x));
    const sy = Math.max(-127, Math.min(127, y));
    sendMouse(sx, sy, 0);
    x -= sx;
    y -= sy;
  }
}

function buildKeyboardReport(extraCode, extraShift) {
  let mod = 0;
  const keys = [];
  for (const code of held) {
    if (MOD[code]) mod |= MOD[code];
    else if (KEY[code]) keys.push(KEY[code]);
  }
  if (extraShift) mod |= MOD.ShiftLeft;
  if (extraCode && KEY[extraCode]) keys.push(KEY[extraCode]);

  const uniq = [...new Set(keys)].slice(0, 6);      // HID requires distinct codes
  const buf = new Uint8Array(8);
  buf[0] = 0x02;
  buf[1] = mod;
  for (let i = 0; i < uniq.length; i++) buf[2 + i] = uniq[i];
  return buf;
}

function sendKeyboard() { send(buildKeyboardReport(null, false)); }

// Press/release one key without disturbing anything else held.
function sendKeyboardExtra(code, shift) { send(buildKeyboardReport(code, shift)); }

function releaseAll() {
  held.clear();
  latched.clear();
  buttons = 0;
  document.querySelectorAll('.k.active').forEach((el) => el.classList.remove('active'));
  send(new Uint8Array([0x05]));
}

let flashTimer = null;

function flash(text) {
  flashEl.textContent = text;
  flashEl.classList.add('show');
  // Cancel the previous timer. Without this a stale one clears a newer message
  // early, and the message that gets cut short is the one that mattered.
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flashEl.classList.remove('show'), 450);
}

// ---------------------------------------------------------------- touchpad
const TAP_SLOP = 14;           // px of movement still counted as a tap

const pointers = new Map();    // pointerId -> {x, y}
let mode = null;               // 'move' | 'scroll' | 'drag' | null
let maxFingers = 0;
let moved = 0;
let startedAt = 0;
let dragHeld = false;          // 3-finger drag: button 1 is down
let scrollAccum = 0;
let lastCentre = null;

function centre() {
  let x = 0, y = 0;
  for (const p of pointers.values()) { x += p.x; y += p.y; }
  const n = pointers.size || 1;
  return { x: x / n, y: y / n };
}

function updateMode() {
  const n = pointers.size;
  mode = n === 1 ? 'move' : n === 2 ? 'scroll' : n >= 3 ? 'drag' : null;
}

function endDrag() {
  if (!dragHeld) return;
  dragHeld = false;
  buttons &= ~1;
  sendMouse(0, 0, 0);
}

function click(bit, label) {
  buttons |= bit;
  sendMouse(0, 0, 0);
  flash(label);
  // A separate report for the release: HID reports are state snapshots, so a
  // click is press-report then release-report.
  setTimeout(() => { buttons &= ~bit; sendMouse(0, 0, 0); }, 25);
}

function onTouchPointerDown(e) {
  if (e.pointerType === 'mouse') return;     // mouse uses pointer lock instead

  // Only real pointers can be captured; synthetic ones (and some browsers
  // mid-gesture) throw here, and losing the capture is not fatal.
  try { pad.setPointerCapture(e.pointerId); } catch (_) {}

  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    startedAt = Date.now();
    moved = 0;
    maxFingers = 1;
    scrollAccum = 0;
  }
  maxFingers = Math.max(maxFingers, pointers.size);
  lastCentre = centre();
  updateMode();

  if (mode === 'drag' && !dragHeld) {
    dragHeld = true;
    buttons |= 1;
    sendMouse(0, 0, 0);                      // button down, then drag
    flash('drag');
  }
}

function onTouchPointerMove(e) {
  if (e.pointerType === 'mouse') return;

  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;
  if (!lastCentre) { lastCentre = centre(); return; }

  const c = centre();
  const dx = c.x - lastCentre.x;
  const dy = c.y - lastCentre.y;
  lastCentre = c;

  const dist = Math.hypot(dx, dy);
  moved += dist;

  const gain = Number(appSettings.mouse_gain) || 1;

  if (mode === 'move' || mode === 'drag') {
    // Do not start moving until the gesture is clearly a drag, so a tap does
    // not nudge the cursor before the click lands.
    if (moved < TAP_SLOP && !dragHeld) return;
    sendMove(dx * gain, dy * gain);
  } else if (mode === 'scroll') {
    // Natural scrolling: the content follows the finger. Fingers moving up
    // (dy < 0) scroll down the page, which is a negative wheel in HID terms -
    // the same convention as the mouse wheel handler above.
    const scale = Number(appSettings.scroll_scale) || 1;
    const dir = appSettings.scroll_invert ? -1 : 1;
    // 0.02, not 0.15: a full-height swipe on a phone is about 500px, and at
    // 0.15 that was 75 wheel notches - roughly 225 lines for one gesture. At
    // 0.02 the same swipe is 10 notches, and the Scroll speed slider scales it
    // from there.
    scrollAccum += dy * 0.02 * scale * dir;
    const whole = Math.trunc(scrollAccum);
    if (whole !== 0) {
      scrollAccum -= whole;
      sendMouse(0, 0, whole);
    }
  }
}

function finishGesture() {
  const duration = Date.now() - startedAt;
  const isTap = duration < (Number(appSettings.tap_max_ms) || 220) && moved < TAP_SLOP;

  if (dragHeld) {
    endDrag();
  } else if (isTap && appSettings.tap_click !== false) {
    if (maxFingers === 1) click(1, 'left click');
    else if (maxFingers === 2) click(2, 'right click');
    else if (maxFingers >= 3) click(4, 'middle click');
  }

  mode = null;
  maxFingers = 0;
  lastCentre = null;
  scrollAccum = 0;
}

function onPointerEnd(e) {
  if (e.pointerType === 'mouse') return;
  pointers.delete(e.pointerId);

  if (pointers.size === 0) {
    finishGesture();
    return;
  }
  // Still fingers down: the gesture continues, but it can no longer be a tap
  // of the original finger count.
  lastCentre = centre();
  updateMode();
  if (mode !== 'drag') endDrag();
}

// ---------------------------------------------------------------- wake lock
// The page must stay *visible* for pointermove to be delivered at all. While it
// is hidden the browser stops delivering them - the same lifecycle that suspends
// requestAnimationFrame - so the movement accumulates in the OS and arrives as
// one burst when the page comes back. That reads as "nothing happens, then the
// cursor flies", and a phone screen turning off is enough to cause it. Holding a
// wake lock is what stops the screen sleeping while captured.
//
// Declared here, above the visibility handler that reads it: a `let` further
// down would be in its temporal dead zone if the page changed visibility during
// load, which a phone browser opening a background tab does.
let captured = false;

let wakeLock = null;

async function holdWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) {
    // Refused or unsupported. Not fatal, but the page may go hidden - which is
    // exactly what the counter below is for.
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  try { wakeLock.release(); } catch (_) {}
  wakeLock = null;
}

function onVisibilityChange() {
  if (document.hidden) {
    // keyup will not arrive while the page is hidden, so anything held is
    // stranded; release it here rather than let the host keep it down.
    releaseAll();
    return;
  }
  // The browser drops the lock when the page is hidden, so re-take it.
  if (captured) holdWakeLock();
}

// Losing window focus is the same problem: the keyup for a physically held key
// goes to whatever took focus, and the host would never hear it.
function onWindowBlur() {
  releaseAll();
}

// ---------------------------------------------------------------- mouse capture
// Pointer lock is the only way a desktop mouse can drive the remote cursor
// without being bounded by the window edge.
// (`captured` is declared above, next to the wake lock that also uses it.)

// A refusal is not an exception: requestPointerLock returns a promise that
// rejects, and browsers refuse for about a second after a lock is released. So
// the click that follows an Escape usually fails, and swallowing that left a
// click which did nothing - which reads as "capture is broken".
function captureRefused() {
  flash('click again to capture');
}

function requestCapture() {
  if (!pad.requestPointerLock) return;

  // Deliberately NOT asking for unadjustedMovement. That option requests raw
  // device counts, which is the opposite of what a high-DPI mouse needs: a
  // 3200 DPI gaming mouse produces tens to hundreds of counts per event, and
  // with the OS pointer-speed curve bypassed the remote cursor crosses the
  // screen dozens of times a second. Scaling that is the gain control's job,
  // and it now reaches low enough to.
  let p;
  try { p = pad.requestPointerLock(); } catch (_) { captureRefused(); return; }
  if (p && typeof p.then === 'function') p.then(undefined, captureRefused);
}

function onMousePointerDown(e) {
  if (e.pointerType !== 'mouse' || captured) return;
  // Locked on *mouse* pointerdown only. Doing this from the click event caught
  // taps as well, so every touch grabbed pointer lock and the pad appeared to
  // freeze (mouse moves are filtered to pointerType === 'mouse').
  //
  // The capturing click is deliberately not forwarded to the host: it would
  // land on whatever the host cursor happens to be over, which is a good way to
  // press a button you did not mean to.
  requestCapture();
}

function onPointerLockChange() {
  captured = document.pointerLockElement === pad;
  pad.classList.toggle('captured', captured);
  if (captured) {
    holdWakeLock();
  } else {
    // Capture is gone: Esc, a tab switch, anything. Whatever was held was held
    // in order to drive the remote, so let it go rather than leave the host with
    // a key down and no way to lift it.
    releaseWakeLock();
    releaseAll();
  }
}

// Movement is coalesced to a maximum rate rather than sent per event: a gaming
// mouse emits over a thousand events a second, and the device cannot drain a
// WebSocket message each.
//
// Deliberately NOT requestAnimationFrame. That stops entirely in a hidden page,
// and the page is hidden exactly when you are watching the host's screen instead
// of the phone's - so the movement accumulates and then arrives in a lump, which
// reads as lag followed by the cursor continuing in the old direction.
// setTimeout keeps running when hidden, and performance.now() lets a flush that
// is already due go out immediately rather than waiting for the next tick.
const MOVE_INTERVAL_MS = 8;      // ~120/s, above any display's refresh rate
let pendingX = 0, pendingY = 0, lastMoveAt = 0, moveTimer = null;

function flushMove() {
  if (moveTimer !== null) { clearTimeout(moveTimer); moveTimer = null; }
  if (!pendingX && !pendingY) return;
  const x = pendingX, y = pendingY;
  pendingX = 0;
  pendingY = 0;
  lastMoveAt = performance.now();
  sendMove(x, y);
}

function queueMove(dx, dy) {
  pendingX += dx;
  pendingY += dy;
  const wait = MOVE_INTERVAL_MS - (performance.now() - lastMoveAt);
  if (wait <= 0) { flushMove(); return; }
  if (moveTimer === null) moveTimer = setTimeout(flushMove, wait);
}

function onMousePointerMove(e) {
  if (!captured || e.pointerType !== 'mouse') return;
  const gain = Number(appSettings.mouse_gain) || 1;
  queueMove(e.movementX * gain, e.movementY * gain);
}

function onMouseDown(e) {
  if (!captured) return;
  e.preventDefault();     // no middle-click autoscroll while driving a remote
  flushMove();            // so a click is not overtaken by movement queued before it
  if (e.button === 0) buttons |= 1;
  if (e.button === 2) buttons |= 2;
  if (e.button === 1) buttons |= 4;
  sendMouse(0, 0, 0);
}

function onMouseUp(e) {
  if (!captured) return;
  flushMove();
  if (e.button === 0) buttons &= ~1;
  if (e.button === 2) buttons &= ~2;
  if (e.button === 1) buttons &= ~4;
  sendMouse(0, 0, 0);
}

// Wheel accumulation, mirroring the touch scroll path above. deltaMode is the
// part that matters: Firefox reports lines, where a full notch is a deltaY of
// about 3, and treating that as pixels and dividing by 8 rounds it to zero -
// the wheel would do nothing at all while captured.
let wheelAccum = 0;

function onWheel(e) {
  if (!captured) return;
  e.preventDefault();

  // 100, not 8. A pixel-mode notch is a deltaY of about 100, so dividing by 8
  // made one detent worth twelve wheel clicks - roughly 36 lines of scroll. The
  // line-mode scale is chosen so a Firefox notch (deltaY ~3) is also worth
  // about one, and the remainder is carried rather than dropped.
  const perUnit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 320 : 1;
  wheelAccum += -e.deltaY * perUnit / 100;

  const whole = Math.trunc(wheelAccum);
  if (whole !== 0) {
    wheelAccum -= whole;
    sendMouse(0, 0, whole);
  }
}

function onContextMenu(e) { if (captured) e.preventDefault(); }

// A drag that starts on the pad takes the pointer with it and the capture is
// gone. Nothing here is draggable, so refusing all of them costs nothing.
function onDragStart(e) { e.preventDefault(); }

// ---------------------------------------------------------------- on-screen buttons
function bindButton(id, bit) {
  const el = document.getElementById(id);
  const down = (e) => { e.preventDefault(); buttons |= bit; sendMouse(0, 0, 0); };
  const up = (e) => { e.preventDefault(); buttons &= ~bit; sendMouse(0, 0, 0); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
}

// ---------------------------------------------------------------- panels
// The keyboard and the panels share the space under the pad. On a phone that
// space is the whole screen: two of them open at once, plus the controls,
// leaves no pad at all, so only one opens at a time there. A desktop has room
// and keeps its several-panels-open-at-once behaviour.
//
// The query has to match the phone breakpoint in index.html's stylesheet.
const PHONE_QUERY = '(max-width: 620px)';

function togglePanel(el) {
  const show = !el.classList.contains('show');
  if (show && window.matchMedia(PHONE_QUERY).matches) {
    for (const other of document.querySelectorAll('#kbd.show, .panel.show')) {
      if (other !== el) other.classList.remove('show');
    }
  }
  el.classList.toggle('show', show);
}

// ---------------------------------------------------------------- physical keyboard
function onKeyDown(e) {
  if (e.key === 'Escape' && captured) return;    // let the browser exit capture
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  e.preventDefault();
  if (e.repeat || held.has(e.code)) return;      // HID reports are snapshots
  held.add(e.code);
  sendKeyboard();
}

function onKeyUp(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  e.preventDefault();
  held.delete(e.code);
  sendKeyboard();
}

// ---------------------------------------------------------------- virtual keyboard
const KBD_ROWS = [
  [['Escape','Esc','mod'],['F1'],['F2'],['F3'],['F4'],['F5'],['F6'],['F7'],['F8'],
   ['F9'],['F10'],['F11'],['F12']],
  [['Backquote','`'],['Digit1','1'],['Digit2','2'],['Digit3','3'],['Digit4','4'],
   ['Digit5','5'],['Digit6','6'],['Digit7','7'],['Digit8','8'],['Digit9','9'],
   ['Digit0','0'],['Minus','-'],['Equal','='],['Backspace','Bksp','w2']],
  [['Tab','Tab','mod'],['KeyQ','Q'],['KeyW','W'],['KeyE','E'],['KeyR','R'],['KeyT','T'],
   ['KeyY','Y'],['KeyU','U'],['KeyI','I'],['KeyO','O'],['KeyP','P'],
   ['BracketLeft','['],['BracketRight',']'],['Backslash','\\']],
  [['CapsLock','Caps','mod w2'],['KeyA','A'],['KeyS','S'],['KeyD','D'],['KeyF','F'],
   ['KeyG','G'],['KeyH','H'],['KeyJ','J'],['KeyK','K'],['KeyL','L'],
   ['Semicolon',';'],['Quote',"'"],['Enter','Enter','w2']],
  [['ShiftLeft','Shift','mod w2'],['KeyZ','Z'],['KeyX','X'],['KeyC','C'],['KeyV','V'],
   ['KeyB','B'],['KeyN','N'],['KeyM','M'],['Comma',','],['Period','.'],
   ['Slash','/'],['ShiftRight','Shift','mod w2']],
  [['ControlLeft','Ctrl','mod'],['MetaLeft','Cmd','mod'],['AltLeft','Alt','mod'],
   ['Space','Space','space'],['AltRight','Alt','mod'],['MetaRight','Cmd','mod'],
   ['ArrowLeft','←','arrow'],['ArrowUp','↑','arrow'],['ArrowDown','↓','arrow'],
   ['ArrowRight','→','arrow']],
];

// Modifiers tapped on the virtual keyboard latch instead of being held. A held
// modifier needs a second finger, which is why Alt+Tab and Ctrl+C were
// effectively unreachable on a phone. Tap Alt, then Tab, and the host sees
// Alt+Tab; the latch releases with the key that used it.
const latched = new Set();

function buildKeyboard() {
  const kbd = document.getElementById('kbd');
  for (const row of KBD_ROWS) addKeyboardRow(kbd, row);
}

function addKeyboardRow(kbd, row) {
  const rowEl = document.createElement('div');
  rowEl.className = 'krow';
  for (const [code, label, extra] of row) {
    const k = document.createElement('div');
    k.className = 'k ' + (extra || '');
    k.dataset.code = code;
    k.textContent = label;

    const press = (e) => {
      e.preventDefault();
      // Take the pointer explicitly: without this a stray finger movement can
      // hand the gesture to the scroller, which cancels the pointer and
      // releases the key mid-hold.
      try { k.setPointerCapture(e.pointerId); } catch (_) {}

      if (MOD[code]) {
        // Second tap cancels. The modifier stays in `held` so every report
        // carries it until a real key uses it.
        if (latched.delete(code)) {
          held.delete(code);
          k.classList.remove('active', 'latched');
        } else {
          latched.add(code);
          held.add(code);
          k.classList.add('active', 'latched');
        }
        sendKeyboard();
        return;
      }

      k.classList.add('active');
      held.add(code);
      sendKeyboard();
    };

    const rel = (e) => {
      e.preventDefault();
      if (MOD[code]) return;      // latched modifiers are released with their key

      k.classList.remove('active');
      held.delete(code);

      // A chord is one shot: the latches go up together with the key that used
      // them, in the same report, so the host never sees a stray modifier held.
      if (latched.size) {
        for (const m of latched) {
          held.delete(m);
          document.querySelectorAll(`.k[data-code="${m}"]`)
            .forEach((el) => el.classList.remove('active', 'latched'));
        }
        latched.clear();
      }
      sendKeyboard();
    };

    k.addEventListener('pointerdown', press);
    k.addEventListener('pointerup', rel);
    k.addEventListener('pointerleave', rel);
    k.addEventListener('pointercancel', rel);
    rowEl.appendChild(k);
  }
  kbd.appendChild(rowEl);
}

// Long-press on a touch screen is a right-click; the menu it opens would
// cancel the pointer stream and drop a held key.
function preventContextMenu(e) { e.preventDefault(); }

// ---------------------------------------------------------------- media keys
// Consumer Control (usage page 0x0C). Sent as a press/release pair like any
// other key: holding a media key down is unusual, so each one is momentary.
const MEDIA_KEYS = [
  ['⏮', 0x00B6, 'prev'],
  ['⏯', 0x00CD, 'play'],
  ['⏭', 0x00B5, 'next'],
  ['⏹', 0x00B7, 'stop'],
  ['🔉', 0x00EA, 'vol −'],
  ['🔇', 0x00E2, 'mute'],
  ['🔊', 0x00E9, 'vol +'],
  ['🌐', 0x0223, 'home'],
  ['◀', 0x0224, 'back'],
  ['▶', 0x0225, 'fwd'],
  ['🔍', 0x0221, 'search'],
  ['🧮', 0x0192, 'calc'],
];

function sendConsumer(usage) {
  send(new Uint8Array([0x03, usage & 0xFF, (usage >> 8) & 0xFF]));
}

function buildMedia() {
  mediaEl = document.getElementById('media');
  mediaPanel = document.getElementById('mediaPanel');

  for (const [glyph, usage, label] of MEDIA_KEYS) {
    const el = document.createElement('div');
    el.className = 'm';
    el.innerHTML = `${glyph}<small>${label}</small>`;

    const press = (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      el.classList.add('active');
      sendConsumer(usage);
      flash(label);
    };
    const rel = (e) => {
      e.preventDefault();
      el.classList.remove('active');
      sendConsumer(0);
    };

    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', rel);
    el.addEventListener('pointerleave', rel);
    el.addEventListener('pointercancel', rel);
    mediaEl.appendChild(el);
  }

  mediaPanel.addEventListener('contextmenu', preventContextMenu);
}

// ---------------------------------------------------------------- type text
// USB HID has no "type this string" notion - it only carries physical key
// positions, which the host maps through its own layout. US QWERTY assumed.
const TYPE_MAP = (() => {
  const m = {};
  const add = (ch, code, shift) => { m[ch] = [code, !!shift]; };

  add(' ', 'Space'); add('\n', 'Enter'); add('\t', 'Tab');
  add('-', 'Minus'); add('=', 'Equal');
  add('[', 'BracketLeft'); add(']', 'BracketRight'); add('\\', 'Backslash');
  add(';', 'Semicolon'); add("'", 'Quote'); add('`', 'Backquote');
  add(',', 'Comma'); add('.', 'Period'); add('/', 'Slash');

  add('_', 'Minus', 1); add('+', 'Equal', 1);
  add('{', 'BracketLeft', 1); add('}', 'BracketRight', 1); add('|', 'Backslash', 1);
  add(':', 'Semicolon', 1); add('"', 'Quote', 1); add('~', 'Backquote', 1);
  add('<', 'Comma', 1); add('>', 'Period', 1); add('?', 'Slash', 1);

  add('!', 'Digit1', 1); add('@', 'Digit2', 1); add('#', 'Digit3', 1);
  add('$', 'Digit4', 1); add('%', 'Digit5', 1); add('^', 'Digit6', 1);
  add('&', 'Digit7', 1); add('*', 'Digit8', 1); add('(', 'Digit9', 1);
  add(')', 'Digit0', 1);

  for (let i = 0; i <= 9; i++) add(String(i), 'Digit' + i);
  for (let i = 0; i < 26; i++) {
    const up = String.fromCharCode(65 + i);
    add(up.toLowerCase(), 'Key' + up, 0);
    add(up, 'Key' + up, 1);
  }
  return m;
})();

let typing = false;
let typeAbort = false;
let typeRun = 0;               // destroys an in-flight typing run on unmount

function onTypeClear() {
  typeTextEl.value = '';
  typeNote.className = 'note';
  typeNote.textContent = '';
}

function onTypeStop() {
  if (typing) typeAbort = true;      // the loop notices at the next character
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function onTypeGo() {
  if (typing) return;
  const text = typeTextEl.value;
  if (!text) return;

  const cps = Number(appSettings.type_speed) || 20;
  // Two reports per character (press, release), so the gap sets half the rate.
  const gap = Math.max(5, Math.round(500 / cps));
  const skipped = [...new Set([...text].filter((c) => !TYPE_MAP[c] && c !== '\r'))];

  const run = ++typeRun;
  typing = true;
  typeAbort = false;
  const total = text.length;
  let done = 0;

  typeNote.className = 'note';
  for (const ch of text) {
    if (typeAbort || run !== typeRun) break;
    if (ch === '\r') { done++; continue; }   // Windows line endings
    const entry = TYPE_MAP[ch];
    if (!entry) { done++; continue; }        // no US-QWERTY key for this one

    sendKeyboardExtra(entry[0], entry[1]);   // press
    await sleepMs(gap);
    if (typeAbort || run !== typeRun) break;
    sendKeyboardExtra(null, false);          // release, held keys untouched
    await sleepMs(gap);

    done++;
    if (done % 10 === 0 || done === total) {
      typeNote.textContent = `typing ${done} / ${total}...`;
    }
  }

  // A newer run (or an unmount) owns the state now; leave it alone.
  if (run !== typeRun) return;
  typing = false;
  typeAbort = false;

  if (skipped.length) {
    typeNote.className = 'note warn';
    typeNote.textContent = `Done ${done} / ${total}. No US-QWERTY key for: `
      + skipped.join(' ') + ' (skipped)';
  } else {
    typeNote.className = 'note';
    typeNote.textContent = `Done ${done} / ${total}.`;
  }
}

// ---------------------------------------------------------------- lifecycle
// The router calls init() after mounting the control template and destroy()
// before replacing it. Everything attached to window or document is removed
// here, or the next mount would double it up.
function init() {
  pad = document.getElementById('pad');
  dot = document.getElementById('dot');
  statusText = document.getElementById('statusText');
  flashEl = document.getElementById('flash');
  typePanel = document.getElementById('type');
  typeTextEl = document.getElementById('typeText');
  typeNote = document.getElementById('typeNote');

  held.clear();
  latched.clear();
  buttons = 0;
  pointers.clear();
  mode = null;
  dragHeld = false;
  captured = false;
  typing = false;
  typeAbort = false;
  resetGestureState();

  buildKeyboard();
  buildMedia();
  kbd = document.getElementById('kbd');
  kbd.addEventListener('contextmenu', preventContextMenu);

  pad.addEventListener('pointerdown', onTouchPointerDown);
  pad.addEventListener('pointermove', onTouchPointerMove);
  pad.addEventListener('pointerup', onPointerEnd);
  pad.addEventListener('pointercancel', onPointerEnd);
  pad.addEventListener('pointerdown', onMousePointerDown);
  pad.addEventListener('pointermove', onMousePointerMove);

  bindButton('bLeft', 1);
  bindButton('bRight', 2);
  bindButton('bMid', 4);

  document.getElementById('bKbd').addEventListener('click', () => togglePanel(kbd));
  document.getElementById('bRelease').addEventListener('click', releaseAll);
  document.getElementById('bMedia').addEventListener('click', () => togglePanel(mediaPanel));
  document.getElementById('bType').addEventListener('click', () => togglePanel(typePanel));
  document.getElementById('typeClear').addEventListener('click', onTypeClear);
  document.getElementById('typeStop').addEventListener('click', onTypeStop);
  document.getElementById('typeGo').addEventListener('click', onTypeGo);

  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', captureRefused);

  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('dragstart', onDragStart);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pagehide', releaseAll);
  window.addEventListener('beforeunload', releaseAll);

  heartbeatTimer = setInterval(() => send(new Uint8Array([0x04])), 1000);
  connect();
}

// Gesture state is reset even if a previous destroy() was skipped (a reload
// while the view was mounted, for instance).
function resetGestureState() {
  maxFingers = 0;
  moved = 0;
  startedAt = 0;
  scrollAccum = 0;
  lastCentre = null;
  pendingX = 0;
  pendingY = 0;
  wheelAccum = 0;
}

function destroy() {
  if (!pad) return;

  // Deliberately release before closing the socket: changing a setting must
  // never leave a key down on the host.
  releaseAll();

  typeAbort = true;             // stops an in-flight Type run at its next step
  typeRun++;
  typing = false;
  clearTimeout(flashTimer);
  flashTimer = null;

  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearTimeout(moveTimer);
  moveTimer = null;
  resetGestureState();

  if (document.pointerLockElement === pad) {
    try { document.exitPointerLock(); } catch (_) {}
  }
  captured = false;
  releaseWakeLock();

  if (ws) {
    // Drop the handlers first: closing on purpose must not schedule a retry
    // after the view is gone.
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  wsReady = false;
  reconnectAttempts = 0;

  pad.removeEventListener('pointerdown', onTouchPointerDown);
  pad.removeEventListener('pointermove', onTouchPointerMove);
  pad.removeEventListener('pointerup', onPointerEnd);
  pad.removeEventListener('pointercancel', onPointerEnd);
  pad.removeEventListener('pointerdown', onMousePointerDown);
  pad.removeEventListener('pointermove', onMousePointerMove);

  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.removeEventListener('pointerlockchange', onPointerLockChange);
  document.removeEventListener('pointerlockerror', captureRefused);

  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('mousedown', onMouseDown);
  window.removeEventListener('mouseup', onMouseUp);
  window.removeEventListener('wheel', onWheel);
  window.removeEventListener('contextmenu', onContextMenu);
  window.removeEventListener('dragstart', onDragStart);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('pagehide', releaseAll);
  window.removeEventListener('beforeunload', releaseAll);

  held.clear();
  latched.clear();
  buttons = 0;
  pointers.clear();
  pad = null;
  dot = null;
  statusText = null;
  flashEl = null;
  kbd = null;
  mediaEl = null;
  mediaPanel = null;
  typePanel = null;
  typeTextEl = null;
  typeNote = null;
}

// The tests drive the real functions in the page, so the internals they reach
// for stay on the view object rather than being copied out.
return {
  init,
  destroy,
  get pad() { return pad; },
  get held() { return held; },
  get latched() { return latched; },
  get pointers() { return pointers; },
  get ws() { return ws; },
  set ws(v) { ws = v; },
  get wsReady() { return wsReady; },
  set wsReady(v) { wsReady = v; },
  get reconnectTimer() { return reconnectTimer; },
  set reconnectTimer(v) { reconnectTimer = v; },
  get buttons() { return buttons; },
  set buttons(v) { buttons = v; },
  get mode() { return mode; },
  set mode(v) { mode = v; },
  get dragHeld() { return dragHeld; },
  set dragHeld(v) { dragHeld = v; },
  get captured() { return captured; },
  set captured(v) { captured = v; },
  buildKeyboardReport,
  releaseAll,
  KEY,
  TYPE_MAP,
};

})();
