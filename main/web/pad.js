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


import { HID_KEYS, apiFetch, appSettings, hostLayout, layoutTextMap, token } from './common.js';

export const PadView = (() => {

// ---------------------------------------------------------------- HID maps
// Keyboard/Keypad usage page 0x07
// The DOM-code to HID-usage table lives in common.js: the macro DSL needs the
// same mapping, and two copies of it would drift.
const KEY = HID_KEYS;

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
let escHintEl = null;
let pulseEl = null;
let lostSubEl = null;
let kbd = null;
let kbBuiltEl = null;
let kbCaptureEl = null;
let captureField = null;
let mediaEl = null;
let mediaPanel = null;
let typePanel = null;
let typeTextEl = null;
let typeNote = null;
let heartbeatTimer = null;
let helpEl = null;
let helpCloseBtn = null;
let helpOpenBtn = null;

const LOST_SUB = 'Input is not reaching the host — reconnecting…';
const HELP_KEY = 'esp32remote.helpSeen';

// ---------------------------------------------------------------- transport
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = onSocketOpen;
  ws.onclose = onSocketClose;
  ws.onerror = () => {
    wsReady = false;
    refreshCaptureUi();
  };
}

// The handlers are named because the tests drive them directly: a real socket
// drop cannot be staged headlessly, and the state transition is the thing that
// has to be proven.
function onSocketOpen() {
  wsReady = true;
  reconnectAttempts = 0;
  if (lostSubEl) lostSubEl.textContent = LOST_SUB;
  setStatus('connected', 'on');
  refreshCaptureUi();
  sendKeyboard();               // resync held state
}

function onSocketClose() {
  wsReady = false;
  // The socket cannot carry a release, but the local state must not claim
  // keys are held either - a reconnect sends a fresh report from nothing.
  releaseAll();
  setStatus('disconnected', 'off');
  refreshCaptureUi();
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts >= 5) {
    // Retrying forever against an address that no longer answers is how a
    // moved DHCP lease hides itself.
    setStatus('disconnected - reload this page', 'off');
    if (lostSubEl) lostSubEl.textContent = 'Input is not reaching the host — reload this page.';
  }
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
}

function setStatus(text, cls) {
  statusText.textContent = text;
  dot.className = 'dot ' + cls;
}

// The captured view is the product of two states: pointer lock and a live
// socket. Keeping them in one place means a reconnect, a capture or an Escape
// all land on the same answer.
function refreshCaptureUi() {
  if (!pad) return;
  pad.classList.toggle('captured', captured);
  pad.classList.toggle('link-down', captured && !wsReady);
  if (escHintEl) {
    escHintEl.textContent = wsReady
      ? 'Mouse captured — Esc releases it'
      : 'Link lost — Esc releases the mouse';
  }
}

// Input acknowledgement. Called from the senders rather than send(), because
// the heartbeat would otherwise keep the dot lit while nothing is happening.
let pulseTimer = null;

function markInput() {
  if (!captured || !pulseEl) return;
  pulseEl.classList.add('tick');
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => {
    pulseTimer = null;
    pulseEl.classList.remove('tick');
  }, 220);
}

function send(bytes) {
  if (wsReady && ws && ws.readyState === 1) ws.send(bytes);
}

// ---------------------------------------------------------------- senders
function clamp8(v) { return Math.max(-127, Math.min(127, Math.round(v))); }

function sendPointerAt(x, y) {
  lastAbs[0] = x;
  lastAbs[1] = y;
  send(new Uint8Array([0x06,
                       x & 0xFF, (x >> 8) & 0xFF,
                       y & 0xFF, (y >> 8) & 0xFF,
                       buttons & 0xFF]));
  markInput();
}

function sendMouse(dx, dy, wheel) {
  // In absolute mode a click is not a movement: it is a press at wherever the
  // pointer already is. Wheel and drag deltas still go as relative reports,
  // since the host has no absolute equivalent for them.

  if (pointerMode === 'abs' && !dx && !dy && !wheel) {
    sendPointerAt(lastAbs[0], lastAbs[1]);
    return;
  }
  send(new Uint8Array([0x01,
                       clamp8(dx) & 0xFF, clamp8(dy) & 0xFF,
                       buttons & 0xFF, clamp8(wheel) & 0xFF]));
  markInput();
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

function sendKeyboard() {
  send(buildKeyboardReport(null, false));
  markInput();
}

// Press/release one key without disturbing anything else held.
function sendKeyboardExtra(code, shift) {
  send(buildKeyboardReport(code, shift));
  markInput();
}

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

  // Absolute mode is a different interaction, not a variant of the gestures:
  // the finger is a position on the host's screen, and the only thing a drag
  // does is keep that position current.
  if (pointerMode === 'abs') {
    try { pad.setPointerCapture(e.pointerId); } catch (_) {}
    const [x, y] = absoluteFor(e.clientX, e.clientY);
    buttons |= 1;
    sendPointerAt(x, y);
    return;
  }

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

  if (pointerMode === 'abs') {
    const [x, y] = absoluteFor(e.clientX, e.clientY);
    sendPointerAt(x, y);
    return;
  }

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

  if (pointerMode === 'abs') {
    buttons &= ~1;
    sendPointerAt(lastAbs[0], lastAbs[1]);
    return;
  }

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
  if (pointerMode === 'abs') {
    const [x, y] = absoluteFor(e.clientX, e.clientY);
    buttons |= 1;
    sendPointerAt(x, y);
    return;
  }

  // Absolute mode is a map, not a trackpad: the position comes from where the
  // pointer is, so there is nothing for pointer lock to add. Pressing goes
  // where the pointer already is.

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
  refreshCaptureUi();
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

// A captured mouse has no absolute position to report - pointer lock only ever
// gives movement - so in absolute mode the movement is accumulated into one.
// The pointer then behaves like a trackpad mapped onto the screen, which is
// also the only way to exercise the host's absolute handling from a desktop.
// Hovering generates a position per pointer event; one per animation frame's
// worth is plenty, so the same interval the delta path uses coalesces them.
let absPending = null;      // {x, y} in client coordinates
let absTimer = null;

function queueAbsAt(clientX, clientY) {
  absPending = { x: clientX, y: clientY };
  const wait = MOVE_INTERVAL_MS - (performance.now() - lastMoveAt);
  if (wait <= 0) { flushAbs(); return; }
  if (absTimer === null) {
    absTimer = setTimeout(() => { absTimer = null; flushAbs(); }, wait);
  }
}

function flushAbs() {
  if (!absPending) return;
  const [x, y] = absoluteFor(absPending.x, absPending.y);
  absPending = null;
  lastMoveAt = performance.now();
  sendPointerAt(x, y);
}

function onMousePointerMove(e) {
  if (e.pointerType !== 'mouse') return;

  // Absolute: follow the pointer across the pad, no lock and no accumulation.
  // This is what a graphics tablet does - the position is reported while the
  // pointer is merely hovering, and a click presses there.
  if (pointerMode === 'abs') {
    queueAbsAt(e.clientX, e.clientY);
    return;
  }

  if (!captured) return;
  const gain = Number(appSettings.mouse_gain) || 1;
  queueMove(e.movementX * gain, e.movementY * gain);
}

function onMouseDown(e) {
  if (!captured) return;
  e.preventDefault();     // no middle-click autoscroll while driving a remote
  flushMove();            // so a click is not overtaken by movement queued before it
  if (pointerMode === 'abs') flushAbs();
  if (e.button === 0) buttons |= 1;
  if (e.button === 2) buttons |= 2;
  if (e.button === 1) buttons |= 4;
  sendMouse(0, 0, 0);
}

function onMouseUp(e) {
  if (pointerMode === 'abs') {
    if (e.button === 0) buttons &= ~1;
    if (e.button === 2) buttons &= ~2;
    if (e.button === 1) buttons &= ~4;
    sendPointerAt(lastAbs[0], lastAbs[1]);
    return;
  }
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
  // stopPropagation: the buttons sit on the pad, and a press must not also
  // start a gesture underneath it.
  const down = (e) => {
    e.preventDefault();
    e.stopPropagation();
    buttons |= bit;
    sendMouse(0, 0, 0);
  };
  const up = (e) => {
    e.preventDefault();
    e.stopPropagation();
    buttons &= ~bit;
    sendMouse(0, 0, 0);
  };
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

// The Keys destination holds three panes and shows one: the on-screen
// keyboard, the media keys, or the text box. They used to be sibling pages
// reached from a row of buttons; the strip inside the slot replaces that.
const PANES = ['built', 'media', 'text'];
let kbPane = 'built';
let kbPagesEl = null;
let kbToolSourceEl = null;
let kbToolTextEl = null;
let litPage = null;          // what the strip marked last, so it only scrolls on change

function setPane(name) {
  kbPane = PANES.includes(name) ? name : 'built';
  if (typePanel) typePanel.classList.toggle('show', kbPane === 'text');
  if (mediaPanel) mediaPanel.classList.toggle('show', kbPane === 'media');
  const built = kbPane === 'built';
  if (kbBuiltEl) kbBuiltEl.hidden = !built || kbSource === 'system';
  if (kbCaptureEl) kbCaptureEl.hidden = !built || kbSource !== 'system';
  refreshStrip();
}

// Which page the slot is showing, as the strip names it. Anything that is not
// a keyboard page or the media keys is null: the text box and the phone's
// keyboard replace the slot, so no page is current while they are up.
function currentPage() {
  if (kbPane === 'media') return 'media';
  if (kbPane !== 'built' || kbSource !== 'built') return null;
  return keyPage;
}

function refreshStrip() {
  if (kbToolSourceEl) {
    const on = kbSource === 'system';
    kbToolSourceEl.classList.toggle('on', on);
    kbToolSourceEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (kbToolTextEl) {
    const on = kbPane === 'text';
    kbToolTextEl.classList.toggle('on', on);
    kbToolTextEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (!kbPagesEl) return;

  const now = currentPage();
  for (const btn of kbPagesEl.querySelectorAll('button[data-page]')) {
    const on = btn.dataset.page === now;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }

  // Bring the live page back into view when it changed from somewhere else -
  // a profile, the Deck, or a page key on a future page - not on every repaint,
  // which would fight a finger that is scrolling the strip.
  if (now && now !== litPage) {
    const btn = kbPagesEl.querySelector(`button[data-page="${now}"]`);
    if (btn && btn.scrollIntoView) btn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
  litPage = now;
  refreshStripEdges();
}

// A fade belongs only at an end that has something past it.
function refreshStripEdges() {
  if (!kbPagesEl) return;
  const el = kbPagesEl;
  const right = el.scrollWidth - el.clientWidth - el.scrollLeft;
  el.classList.toggle('more-left', el.scrollLeft > 1);
  el.classList.toggle('more-right', right > 1);
}

// A page is a place you type: picking one always lands on the built-in
// keyboard, because the phone's keyboard has no pages to show.
function openPage(page) {
  if (page === 'media') {
    setPane('media');
    return;
  }
  if (kbSource !== 'built') setKeyboardSource('built');
  keyPage = page;
  buildKeyboard();
  setPane('built');
}

function togglePanel(el) {
  el.classList.toggle('show', !el.classList.contains('show'));
  // Opening the slot in system mode should raise the keyboard, not make the
  // user tap a second time. Still inside the click, so the IME will open.
  if (el.classList.contains('show') && el.id === 'kbd' &&
      kbSource === 'system' && kbPane === 'built') {
    focusCapture();
  }
  // The gesture hint is for a pad with room to move in; with the keyboard up
  // the pad is a strip and the hint is just in the way.
  if (pad && kbd) pad.classList.toggle('slot-open', kbd.classList.contains('show'));
  setPane(kbPane);
}

// ---------------------------------------------------------------- system keyboard
// A phone keyboard cannot be captured directly, and the split is measured, not
// assumed (Android + Hacker's Keyboard):
//
//   printable characters  keydown with an empty code (keyCode 229), then
//                         beforeinput carrying the text
//   everything else       a real keydown/keyup with a code we can map
//   Ctrl/Alt/Meta + key   a real keydown carrying the modifier flag
//
// So text comes from beforeinput and keys come from keydown, and the two must
// never both fire for the same press or everything types twice.
const KB_SOURCE_KEY = 'esp32remote.keyboardSource';

// Usages that never produce text, so the IME will not deliver them as input.
// A plain letter is deliberately absent: on a desktop with a real keyboard it
// arrives as both a keydown and an insertText, and the text path wins.
const NO_TEXT_USAGE = new Set([
  0x28, 0x29, 0x2A, 0x2B, 0x39,                    // Enter Esc Backspace Tab Caps
  0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F,              // F1-F6
  0x40, 0x41, 0x42, 0x43, 0x44, 0x45,              // F7-F12
  0x46, 0x47, 0x48,                                // PrtSc ScrollLock Pause
  0x49, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E,              // Ins Home PgUp Del End PgDn
  0x4F, 0x50, 0x51, 0x52,                          // arrows
]);

let kbSource = 'built';
let captureComposing = false;

// 'rel' moves by deltas, 'abs' maps the pad to a position on the host's screen.
// Absolute reports carry the whole position, so nothing here needs a backlog.
const POINTER_MODE_KEY = 'esp32remote.pointerMode';
let pointerMode = 'rel';
let padModeEl = null;
// The last absolute position, so a click can press where the pointer already is.
let lastAbs = [16384, 16384];

function storedPointerMode() {
  try {
    return localStorage.getItem(POINTER_MODE_KEY) === 'abs' ? 'abs' : 'rel';
  } catch (_) {
    return 'rel';
  }
}

function setPointerMode(mode) {
  pointerMode = mode === 'abs' ? 'abs' : 'rel';
  if (pad) pad.classList.toggle('pointer-abs', pointerMode === 'abs');

  try { localStorage.setItem(POINTER_MODE_KEY, pointerMode); } catch (_) {}
  if (padModeEl) {
    padModeEl.textContent = pointerMode === 'abs' ? 'Absolute' : 'Relative';
    padModeEl.classList.toggle('on', pointerMode === 'abs');
    padModeEl.title = pointerMode === 'abs'
      ? 'Absolute: the pad is a map of the host screen'
      : 'Relative: the pad moves the pointer by how far you drag';
  }
}

// Where in the 0..32767 space a touch landed. Exposed for the tests.
function absoluteFor(clientX, clientY) {
  if (!pad) return [0, 0];
  const r = pad.getBoundingClientRect();
  // In absolute mode the pointer buttons are docked along the bottom edge, and
  // that strip is not part of the map: the buttons would otherwise be dead
  // zones in the middle of the screen.
  const bar = pointerMode === 'abs' ? document.getElementById('mouseButtons') : null;
  const usable = Math.max(1, r.height - (bar ? bar.offsetHeight : 0));
  const fx = r.width ? (clientX - r.left) / r.width : 0;
  const fy = (clientY - r.top) / usable;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  return [Math.round(clamp01(fx) * 32767), Math.round(clamp01(fy) * 32767)];
}

// The host's lock keys. Polled rather than pushed: the page already speaks
// HTTP, and this is a badge, not a control path.
let ledsEl = null;
let ledTimer = null;

async function pollLeds() {
  if (!ledsEl || !kbd || !kbd.classList.contains('show')) return;
  try {
    const res = await apiFetch('/state');
    if (!res.ok) return;
    const st = await res.json();
    const on = [];
    // known=false means the host has never sent an LED byte; saying "nothing is
    // lit" then would be a guess, so say nothing at all.
    if (st.known) {

      if (st.caps) on.push('CAPS');
      if (st.num) on.push('NUM');
      if (st.scroll) on.push('SCROLL');
    }
    ledsEl.textContent = on.length ? on.join(' · ') + ' LOCK' : '';
    ledsEl.hidden = !on.length;
  } catch (_) {
    // Unreachable device: the status dot already says so.
  }
}
// When the last Tab was seen. Hacker's Keyboard moves focus for its own Tab
// key, and an IME can do that even though the keydown was cancelled - so the
// caret is put back, but only right after a Tab, so a deliberate tap survives.
let tabGuardAt = 0;

const KEY_LABELS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Escape: 'Esc', Enter: '⏎', Backspace: '⌫', Tab: 'Tab', Delete: 'Del',
};

function storedKeyboardSource() {
  try {
    return localStorage.getItem(KB_SOURCE_KEY) === 'system' ? 'system' : 'built';
  } catch (_) {
    return 'built';
  }
}

function setKeyboardSource(src) {
  const next = src === 'system' ? 'system' : 'built';
  if (next !== kbSource) releaseAll();      // a switch must not strand a held key
  kbSource = next;
  try { localStorage.setItem(KB_SOURCE_KEY, next); } catch (_) {}
  if (next !== 'system' && captureField) captureField.blur();
  setPane(kbPane);
  // Arriving at the phone's keyboard is a tap, so the IME may be raised here;
  // the field has to be focused inside the gesture.
  if (next === 'system' && kbPane === 'built') focusCapture();
}

function captureMods(e) {
  let m = 0;
  if (e.ctrlKey) m |= 0x01;
  if (e.shiftKey) m |= 0x02;
  if (e.altKey) m |= 0x04;
  if (e.metaKey) m |= 0x08;
  return m;
}

// A chord is self-contained: the modifiers from the event, one key, then a
// report with nothing held. The IME does not keep Ctrl down between keys.
function sendCaptureReport(usage, mods) {
  const buf = new Uint8Array(8);
  buf[0] = 0x02;
  buf[1] = mods;
  if (usage) buf[2] = usage;
  send(buf);
  markInput();
}

function captureActive() {
  return kbSource === 'system' && captureField && document.activeElement === captureField;
}

function onCaptureKeyDown(e) {
  if (!captureActive()) return;
  // An empty code is Android's "the IME consumed this" (keyCode 229); the text
  // arrives as beforeinput, and sending anything here types it twice.
  if (!e.code || e.isComposing) return;
  const usage = KEY[e.code];
  if (!usage) return;                       // a modifier, a media key, or unmapped
  const mods = captureMods(e);
  // No modifiers and no text to produce? Then beforeinput will type it.
  if (!mods && !NO_TEXT_USAGE.has(usage)) return;
  if (usage === 0x2B) tabGuardAt = performance.now();
  e.preventDefault();                       // Tab must not move focus, F5 must not reload
  if (e.repeat) return;                     // the host repeats a held key by itself
  sendCaptureReport(usage, mods);
  flash(describeKey(e, mods));
}

// A short confirmation of what went out, because nothing echoes in this mode.
function describeKey(e, mods) {
  const modsText = [
    mods & 0x01 ? 'Ctrl' : '',
    mods & 0x02 ? 'Shift' : '',
    mods & 0x04 ? 'Alt' : '',
    mods & 0x08 ? 'Cmd' : '',
  ].filter(Boolean).join('+');
  const name = KEY_LABELS[e.key] ||
    (e.key && e.key.length === 1 ? e.key.toUpperCase() : String(e.key || '?'));
  return modsText ? `${modsText}+${name}` : name;
}

function onCaptureKeyUp(e) {
  if (!captureActive()) return;
  if (!e.code || e.isComposing) return;
  const usage = KEY[e.code];
  if (!usage) return;
  if (!captureMods(e) && !NO_TEXT_USAGE.has(usage)) return;
  e.preventDefault();
  // Release everything this chord pressed. The modifier was never held by us
  // between keys, so there is nothing else to leave behind.
  sendCaptureReport(0, 0);
}

function typeCapturedText(text) {
  for (const ch of text) {
    const entry = TYPE_MAP[ch];
    if (!entry) continue;
    sendKeyboardExtra(entry[0], entry[1]);   // press
    sendKeyboardExtra(null, false);          // release
  }
}

function onCaptureBeforeInput(e) {
  // Enter and Backspace arrive here too - insertLineBreak and
  // deleteContentBackward - after already arriving as keydowns. Honouring both
  // would send every one of them twice.
  if (e.inputType !== 'insertText' || !e.data) return;
  e.preventDefault();                       // keep the field empty
  typeCapturedText(e.data);
}

let lastPointerDownAt = 0;

// Focusing inside the tap is what raises the phone's keyboard: Android only
// does it for a focus that happens as part of a gesture.
//
// Tried and discarded: an immediate call plus 0/60/200ms retries, and a single
// 60ms delayed call with a cancel token. Neither behaved differently on the
// device, so this stays the simple version rather than carrying machinery that
// buys nothing.
function focusCapture() {
  if (!captureField || kbSource !== 'system') return;
  try { captureField.focus(); } catch (_) {}
}

function onCaptureBlur() {
  // Leaving the field takes the keyboard away, so nothing should stay held.
  releaseAll();
}

function onCaptureFocusOut() {
  if (kbSource !== 'system') return;
  if (performance.now() - tabGuardAt > 300) return;
  // A tap after the Tab is deliberate: pulling the caret back would undo the
  // user's choice. A tap before it says nothing.
  if (lastPointerDownAt > tabGuardAt) return;
  // Deferred so the browser finishes moving focus first; if the caret landed
  // somewhere else, take it back.
  setTimeout(() => {
    if (kbSource !== 'system' || !captureField) return;
    if (document.activeElement === captureField) return;
    try { captureField.focus(); } catch (_) {}
  }, 0);
}

function onAnyPointerDown() {
  // Only feeds the Tab guard: a tap after a Tab is deliberate.
  lastPointerDownAt = performance.now();
}

// ---------------------------------------------------------------- physical keyboard
// The help sheet is modal: nothing typed while it is open should reach the
// host, and Escape dismisses it rather than going to the device.
function helpVisible() {
  return !!helpEl && !helpEl.hidden;
}

function onKeyDown(e) {
  if (helpVisible()) {
    if (e.key === 'Escape') { e.preventDefault(); closeHelp(); }
    return;
  }
  if (e.key === 'Escape' && captured) return;    // let the browser exit capture
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  e.preventDefault();
  if (e.repeat || held.has(e.code)) return;      // HID reports are snapshots
  held.add(e.code);
  sendKeyboard();
}

function onKeyUp(e) {
  if (helpVisible()) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  e.preventDefault();
  held.delete(e.code);
  sendKeyboard();
}

// ---------------------------------------------------------------- virtual keyboard
// The on-screen keyboard is the host's keyboard, drawn small: the label on a
// key is the character the host will receive, and the small legend above it is
// what Shift would make of it. A key is one of:
//
//   ['KeyQ', 'q', 'Q']                     label, and its shifted twin
//   ['ShiftLeft', '⇧', null, 'wide']       a named key, wider than the rest
//   ['Slash', '?', null, 'wide', true]     always sent with Shift
//
// Ten keys a row on the letter page: at 390px that is a 36px key, which is the
// same density a phone keyboard uses. The old full-width rows gave 26px.
// The letter and symbol pages come from the host layout (common.js); only the
// function page is the same whatever the host is set to.
const FN_PAGE = [
  [['F1'],['F2'],['F3'],['F4'],['F5'],['F6']],
  [['F7'],['F8'],['F9'],['F10'],['F11'],['F12']],
  [['Home','Home'],['End','End'],['PageUp','PgUp'],['PageDown','PgDn'],
   ['Insert','Ins'],['Delete','Del']],
];

// A real keypad, with Keypad usages rather than the number row. The host reads
// them differently - games and spreadsheets distinguish them, and with Num Lock
// off KP7 is Home - which is the whole point of having one.
const KP_PAGE = [
  [['NumLock','NumLk'],['NumpadDivide','/'],['NumpadMultiply','*'],
   ['NumpadSubtract','−']],
  [['Numpad7','7'],['Numpad8','8'],['Numpad9','9'],['NumpadAdd','+']],
  [['Numpad4','4'],['Numpad5','5'],['Numpad6','6'],['NumpadEnter','⏎']],
  [['Numpad1','1'],['Numpad2','2'],['Numpad3','3'],['Backspace','DEL']],
  [['Numpad0','0'],['NumpadDecimal','.'],['Tab','Tab'],['Enter','⏎']],
];

function keyPages() {
  const layout = hostLayout();
  return { abc: layout.abc, sym: layout.sym, fn: FN_PAGE, kp: KP_PAGE };
}

// Modifiers tapped on the virtual keyboard latch instead of being held. A held
// modifier needs a second finger, which is why Alt+Tab and Ctrl+C were
// effectively unreachable on a phone. Tap Alt, then Tab, and the host sees
// Alt+Tab; the latch releases with the key that used it.
const latched = new Set();
let keyPage = 'abc';

function shiftIsDown() {
  return latched.has('ShiftLeft') || latched.has('ShiftRight') ||
         held.has('ShiftLeft') || held.has('ShiftRight');
}

// Swap the big label and the small legend, so the character the host will
// receive is the one in front of you - which is the answer to "how do I type a
// question mark" without anyone having to explain Shift+/.
function applyShiftLegends() {
  const swapped = shiftIsDown();
  for (const k of document.querySelectorAll('#kbBuilt .k[data-alt]')) {
    const big = k.querySelector('.p');
    const small = k.querySelector('.a');
    if (!big || !small) continue;
    big.textContent = swapped ? k.dataset.alt : k.dataset.label;
    small.textContent = swapped ? k.dataset.label : k.dataset.alt;
    k.classList.toggle('shifted', swapped);
  }
}

// The layout may have changed since this script loaded; both the typing table
// and the picture are rebuilt from it.
function applyHostLayout() {
  // A layout change starts from the letter page: staying on the symbols page
  // after the symbols have moved would be disorienting.
  keyPage = 'abc';
  refreshTypeMap();
  buildKeyboard();
}

function buildKeyboard() {
  // The keys go into their own container so the slot can swap them for the
  // capture field without rebuilding anything on every switch.
  const built = document.getElementById('kbBuilt');
  built.textContent = '';
  // Rebuilt per page.
  for (const row of keyPages()[keyPage]) addKeyboardRow(built, row);
  applyShiftLegends();
}

function addKeyboardRow(kbd, row) {
  const rowEl = document.createElement('div');
  rowEl.className = 'krow';
  for (const [code, label, alt, extra] of row) {
    const k = document.createElement('div');
    k.className = 'k ' + (extra || '');
    k.dataset.code = code;

    if (alt) {
      k.dataset.label = label;
      k.dataset.alt = alt;
      const big = document.createElement('span');
      big.className = 'p';
      big.textContent = label;
      const small = document.createElement('span');
      small.className = 'a';
      small.textContent = alt;
      k.append(big, small);
    } else {
      // A row entry without a label falls back to its code, so a key can never
      // render blank: the function row was twelve empty buttons for want of one.
      k.textContent = label || code;
    }

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
        applyShiftLegends();
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
      applyShiftLegends();
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
  markInput();
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
const TYPE_MAP = {};

// Rebuilt from the layout, so the Type panel cannot type a character the
// keyboard would not draw.
function refreshTypeMap() {
  for (const k of Object.keys(TYPE_MAP)) delete TYPE_MAP[k];
  Object.assign(TYPE_MAP, layoutTextMap());
}
refreshTypeMap();

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

// ---------------------------------------------------------------- gesture help
// A three-finger drag has no visible affordance, and the hint is the only place
// it was ever mentioned. The sheet is shown once per browser, then kept
// available behind the ? button; dismissing it never leaves anything over the
// pad.
// The in-memory flag covers a browser that refuses localStorage writes: the
// sheet is dismissed for this session even if it cannot be remembered longer.
let helpSeenNow = false;

function helpAlreadySeen() {
  if (helpSeenNow) return true;
  try { return localStorage.getItem(HELP_KEY) === '1'; } catch (_) { return false; }
}

function rememberHelpSeen() {
  helpSeenNow = true;
  try { localStorage.setItem(HELP_KEY, '1'); } catch (_) {}
}

function openHelp() {
  if (!helpEl) return;
  // The sheet swallows keyup while it is open, so anything already held would
  // be stranded on the host. Let it go before taking over the screen.
  releaseAll();
  helpEl.hidden = false;
}

function closeHelp() {
  if (!helpEl || helpEl.hidden) return;
  helpEl.hidden = true;
  rememberHelpSeen();
}

// The ? sits inside the pad so it is in reach of a thumb, but the pad's gesture
// handlers are underneath: without stopping these a tap on help would also be
// read as a click on the host.
function swallowPointer(e) { e.stopPropagation(); }

function onHelpBackdrop(e) {
  // Only the backdrop dismisses. A tap on the sheet while reading should not
  // throw the instructions away.
  if (e.target === helpEl) closeHelp();
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
  escHintEl = document.getElementById('escHint');
  pulseEl = document.getElementById('inputPulse');
  lostSubEl = document.getElementById('linkLostSub');
  helpEl = document.getElementById('help');
  helpCloseBtn = document.getElementById('helpClose');
  helpOpenBtn = document.getElementById('helpOpen');
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
  wsReady = false;
  typing = false;
  typeAbort = false;
  resetGestureState();
  if (lostSubEl) lostSubEl.textContent = LOST_SUB;
  refreshCaptureUi();

  keyPage = 'abc';
  litPage = null;
  applyHostLayout();
  buildMedia();
  kbPagesEl = document.getElementById('kbPages');
  kbToolSourceEl = document.getElementById('kbToolSource');
  kbToolTextEl = document.getElementById('kbToolText');
  ledsEl = document.getElementById('kbLeds');
  if (ledsEl) { ledsEl.hidden = true; ledsEl.textContent = ''; }
  clearInterval(ledTimer);
  ledTimer = setInterval(pollLeds, 2000);
  kbd = document.getElementById('kbd');
  setPane('built');
  // The Keys tab is this same view with the keyboard slot open, so arriving
  // there does not need a second copy of the pad.
  if (/^#\/keys/.test(location.hash)) {
    // Through togglePanel, so everything that follows from the slot being open
    // happens here too - the pane state and the pad's own flag.
    if (!kbd.classList.contains('show')) togglePanel(kbd);
    setPane('built');
  }
  kbd.addEventListener('contextmenu', preventContextMenu);

  kbBuiltEl = document.getElementById('kbBuilt');
  kbCaptureEl = document.getElementById('kbCapture');
  captureField = document.getElementById('kbCaptureField');
  captureComposing = false;
  setKeyboardSource(storedKeyboardSource());
  // Android can swallow the click when the keyboard dismisses and the layout
  // moves under the finger, and this tool is exactly the one that raises the
  // IME - so it acts on pointerdown. The click that follows would toggle it
  // straight back, hence the guard; a keyboard activation has no pointerdown
  // and still gets through.
  const bindTool = (btn, action) => {
    if (!btn) return;
    let fromPointer = false;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      fromPointer = true;
      action();
      setTimeout(() => { fromPointer = false; }, 500);
    });
    btn.addEventListener('click', () => {
      if (fromPointer) return;
      action();
    });
  };

  bindTool(kbToolSourceEl, () => {
    setKeyboardSource(kbSource === 'system' ? 'built' : 'system');
  });
  bindTool(kbToolTextEl, () => {
    setPane(kbPane === 'text' ? 'built' : 'text');
  });
  if (kbPagesEl) {
    kbPagesEl.addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('button[data-page]') : null;
      if (btn) openPage(btn.dataset.page);
    });
    kbPagesEl.addEventListener('scroll', refreshStripEdges, { passive: true });
    // A wheel has only one axis on a mouse, and it is the wrong one. Redirect
    // it sideways, but only while the strip can still move that way: at an end
    // the page keeps the scroll, which is what a reader expects.
    kbPagesEl.addEventListener('wheel', (e) => {
      const el = e.currentTarget;
      if (el.scrollWidth <= el.clientWidth) return;

      // A trackpad already reports the axis it means; a mouse wheel does not.
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!raw) return;
      const delta = e.deltaMode === 1 ? raw * 16 : e.deltaMode === 2 ? raw * el.clientWidth : raw;

      const before = el.scrollLeft;
      el.scrollLeft = before + delta;
      if (el.scrollLeft !== before) e.preventDefault();
    }, { passive: false });
    // A rotation or a resize changes how much of the row fits.
    window.addEventListener('resize', refreshStripEdges);
  }
  const captureOpen = document.getElementById('kbCaptureOpen');
  if (captureOpen) {
    captureOpen.addEventListener('pointerdown', focusCapture);
    captureOpen.addEventListener('click', focusCapture);
  }
  document.addEventListener('pointerdown', onAnyPointerDown, true);
  // On the document, in the capture phase: which element the IME aims a key at
  // is not something the page controls, and captureActive() is what keeps this
  // scoped to the field.
  document.addEventListener('keydown', onCaptureKeyDown, true);
  document.addEventListener('keyup', onCaptureKeyUp, true);
  if (captureField) {
    captureField.addEventListener('beforeinput', onCaptureBeforeInput);
    captureField.addEventListener('blur', onCaptureBlur);
    captureField.addEventListener('focusout', onCaptureFocusOut);
    captureField.addEventListener('compositionstart', () => { captureComposing = true; });
    captureField.addEventListener('compositionend', (e) => {
      captureComposing = false;
      if (e.data) typeCapturedText(e.data);
    });
    // Safety net for an IME that ignores preventDefault. Never during
    // composition: clearing the field mid-composition breaks the IME's buffer.
    captureField.addEventListener('input', () => {
      if (!captureComposing && captureField.value) captureField.value = '';
    });
  }

  pad.addEventListener('pointerdown', onTouchPointerDown);
  pad.addEventListener('pointermove', onTouchPointerMove);
  pad.addEventListener('pointerup', onPointerEnd);
  pad.addEventListener('pointercancel', onPointerEnd);
  pad.addEventListener('pointerdown', onMousePointerDown);
  pad.addEventListener('pointermove', onMousePointerMove);

  bindButton('bLeft', 1);
  bindButton('bRight', 2);
  bindButton('bMid', 4);

  // Release lives in the shell's status bar, which outlives this view, so it is
  // assigned rather than added: a listener per mount would stack up.
  const releaseBtn = document.getElementById('bRelease');
  if (releaseBtn) releaseBtn.onclick = releaseAll;
  document.getElementById('typeClear').addEventListener('click', onTypeClear);
  document.getElementById('typeStop').addEventListener('click', onTypeStop);
  document.getElementById('typeGo').addEventListener('click', onTypeGo);

  padModeEl = document.getElementById('padMode');
  if (padModeEl) {
    setPointerMode(storedPointerMode());
    padModeEl.addEventListener('pointerdown', swallowPointer);
    padModeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      setPointerMode(pointerMode === 'abs' ? 'rel' : 'abs');
      flash(pointerMode === 'abs' ? 'absolute' : 'relative');
    });
  }

  helpOpenBtn.addEventListener('pointerdown', swallowPointer);
  helpOpenBtn.addEventListener('pointermove', swallowPointer);
  helpOpenBtn.addEventListener('pointerup', swallowPointer);
  helpOpenBtn.addEventListener('pointercancel', swallowPointer);
  helpOpenBtn.addEventListener('click', openHelp);
  helpCloseBtn.addEventListener('click', closeHelp);
  helpEl.addEventListener('click', onHelpBackdrop);
  if (!helpAlreadySeen()) openHelp();

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
  clearTimeout(pulseTimer);
  pulseTimer = null;
  clearTimeout(absTimer);
  absTimer = null;
  clearInterval(ledTimer);
  ledTimer = null;
  ledsEl = null;

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
  document.removeEventListener('keydown', onCaptureKeyDown, true);
  document.removeEventListener('keyup', onCaptureKeyUp, true);
  document.removeEventListener('pointerdown', onAnyPointerDown, true);
  window.removeEventListener('pagehide', releaseAll);
  window.removeEventListener('beforeunload', releaseAll);

  held.clear();
  latched.clear();
  buttons = 0;
  pointers.clear();
  pad = null;
  padModeEl = null;
  dot = null;
  statusText = null;
  flashEl = null;
  escHintEl = null;
  pulseEl = null;
  lostSubEl = null;
  helpEl = null;
  helpCloseBtn = null;
  helpOpenBtn = null;
  kbd = null;
  kbPagesEl = null;
  kbToolSourceEl = null;
  kbToolTextEl = null;
  litPage = null;
  kbBuiltEl = null;
  kbCaptureEl = null;
  captureField = null;
  captureComposing = false;
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
  set wsReady(v) { wsReady = v; refreshCaptureUi(); },
  get reconnectTimer() { return reconnectTimer; },
  set reconnectTimer(v) { reconnectTimer = v; },
  get buttons() { return buttons; },
  set buttons(v) { buttons = v; },
  get mode() { return mode; },
  set mode(v) { mode = v; },
  get dragHeld() { return dragHeld; },
  set dragHeld(v) { dragHeld = v; },
  get captured() { return captured; },
  set captured(v) { captured = v; refreshCaptureUi(); },
  onSocketOpen,
  onSocketClose,
  openHelp,
  closeHelp,
  buildKeyboardReport,
  releaseAll,
  setKeyboardSource,
  setPointerMode,
  keyPages,
  absoluteFor,
  get pointerMode() { return pointerMode; },
  applyHostLayout,
  focusCapture,
  pollLeds,
  get keyboardSource() { return kbSource; },
  get captureField() { return captureField; },
  NO_TEXT_USAGE,
  KEY,
  MOD,
  TYPE_MAP,
};

})();