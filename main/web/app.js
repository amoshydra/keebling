// ESP32 Remote — browser input surface.
//
// Sends a tiny binary protocol over WebSocket to the ESP32-S3, which
// re-emits everything as USB HID reports to the host.
//
//   0x01 mouse     [dx][dy][buttons][wheel]
//   0x02 keyboard  [mod][kc0..kc5]      (full snapshot of held keys)
//   0x03 consumer  [usage_lo][usage_hi]
//   0x04 ping      (heartbeat)
//   0x05 release   (release everything)

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
const held = new Set();     // event.code strings currently down
let buttons = 0;            // mouse button bitmask
let gain = 1.0;
let ws = null;
let wsReady = false;
let reconnectTimer = null;
let captured = false;

const pad = document.getElementById('pad');
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const modeEl = document.getElementById('mode');

// ---------------------------------------------------------------- transport
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    wsReady = true;
    setStatus('connected', 'on');
    sendKeyboard();          // resync held state
  };
  ws.onclose = () => { wsReady = false; setStatus('disconnected', 'off'); scheduleReconnect(); };
  ws.onerror = () => { wsReady = false; };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
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
  send(new Uint8Array([0x01, clamp8(dx) & 0xFF, clamp8(dy) & 0xFF, buttons & 0xFF,
                       clamp8(wheel) & 0xFF]));
}

function sendKeyboard() {
  let mod = 0;
  const keys = [];
  for (const code of held) {
    if (MOD[code]) mod |= MOD[code];
    else if (KEY[code]) keys.push(KEY[code]);
  }
  const uniq = [...new Set(keys)].slice(0, 6);      // HID requires distinct codes
  const buf = new Uint8Array(8);
  buf[0] = 0x02; buf[1] = mod;
  for (let i = 0; i < uniq.length; i++) buf[2 + i] = uniq[i];
  send(buf);
}

function releaseAll() {
  held.clear();
  buttons = 0;
  document.querySelectorAll('.k.active').forEach(el => el.classList.remove('active'));
  send(new Uint8Array([0x05]));
}

// ---------------------------------------------------------------- pointer
// Clicking the pad grabs the pointer. While captured, raw mouse deltas drive
// the remote cursor and mouse buttons are forwarded. Esc exits.
pad.addEventListener('click', () => {
  if (!captured && pad.requestPointerLock) {
    pad.requestPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  captured = (document.pointerLockElement === pad);
  pad.classList.toggle('captured', captured);
  modeEl.textContent = captured ? 'captured — Esc to release' : 'tap pad to capture';
  if (!captured) { buttons = 0; sendMouse(0, 0, 0); }   // don't leave buttons stuck
});

// Fallback for browsers/devices without pointer lock: drag to move.
let dragging = false, lastX = 0, lastY = 0;

pad.addEventListener('pointerdown', (e) => {
  if (captured) return;
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  pad.setPointerCapture(e.pointerId);
});
pad.addEventListener('pointermove', (e) => {
  if (captured) {
    sendMouse(e.movementX * gain, e.movementY * gain, 0);
  } else if (dragging) {
    sendMouse((e.clientX - lastX) * gain, (e.clientY - lastY) * gain, 0);
    lastX = e.clientX; lastY = e.clientY;
  }
});
pad.addEventListener('pointerup', () => { dragging = false; });
pad.addEventListener('pointercancel', () => { dragging = false; });

// Physical mouse buttons are forwarded only while captured.
window.addEventListener('mousedown', (e) => {
  if (!captured) return;
  if (e.button === 0) buttons |= 1;
  if (e.button === 2) buttons |= 2;
  if (e.button === 1) buttons |= 4;
  sendMouse(0, 0, 0);
});
window.addEventListener('mouseup', (e) => {
  if (!captured) return;
  if (e.button === 0) buttons &= ~1;
  if (e.button === 2) buttons &= ~2;
  if (e.button === 1) buttons &= ~4;
  sendMouse(0, 0, 0);
});
window.addEventListener('wheel', (e) => {
  if (!captured) return;
  e.preventDefault();
  sendMouse(0, 0, -e.deltaY / 8);
}, { passive: false });
window.addEventListener('contextmenu', (e) => { if (captured) e.preventDefault(); });

// On-screen buttons (needed on touch, where there is no right button).
function bindButton(id, bit) {
  const el = document.getElementById(id);
  const down = (e) => { e.preventDefault(); buttons |= bit; sendMouse(0, 0, 0); };
  const up   = (e) => { e.preventDefault(); buttons &= ~bit; sendMouse(0, 0, 0); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
}
bindButton('bLeft', 1);
bindButton('bRight', 2);
bindButton('bMid', 4);

// ---------------------------------------------------------------- keyboard
// Physical keyboard (desktop controller).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && captured) return;      // let the browser exit capture
  if (e.target.tagName === 'INPUT') return;
  e.preventDefault();
  if (e.repeat || held.has(e.code)) return;        // HID reports are snapshots
  held.add(e.code);
  sendKeyboard();
});
window.addEventListener('keyup', (e) => {
  if (e.target.tagName === 'INPUT') return;
  e.preventDefault();
  held.delete(e.code);
  sendKeyboard();
});

// Virtual keyboard (touch controller).
const ROWS = [
  [['Escape','Esc','mod'],['F1'],['F2'],['F3'],['F4'],['F5'],['F6'],['F7'],['F8'],['F9'],['F10'],['F11'],['F12']],
  [['Backquote','`'],['Digit1','1'],['Digit2','2'],['Digit3','3'],['Digit4','4'],['Digit5','5'],['Digit6','6'],
   ['Digit7','7'],['Digit8','8'],['Digit9','9'],['Digit0','0'],['Minus','-'],['Equal','='],['Backspace','Bksp','w2']],
  [['Tab','Tab','mod'],['KeyQ','Q'],['KeyW','W'],['KeyE','E'],['KeyR','R'],['KeyT','T'],['KeyY','Y'],['KeyU','U'],
   ['KeyI','I'],['KeyO','O'],['KeyP','P'],['BracketLeft','['],['BracketRight',']'],['Backslash','\\']],
  [['CapsLock','Caps','mod w2'],['KeyA','A'],['KeyS','S'],['KeyD','D'],['KeyF','F'],['KeyG','G'],['KeyH','H'],
   ['KeyJ','J'],['KeyK','K'],['KeyL','L'],['Semicolon',';'],['Quote',"'"],['Enter','Enter','w2']],
  [['ShiftLeft','Shift','mod w2'],['KeyZ','Z'],['KeyX','X'],['KeyC','C'],['KeyV','V'],['KeyB','B'],['KeyN','N'],
   ['KeyM','M'],['Comma',','],['Period','.'],['Slash','/'],['ShiftRight','Shift','mod w2']],
  [['ControlLeft','Ctrl','mod'],['MetaLeft','Cmd','mod'],['AltLeft','Alt','mod'],['Space','Space','space'],
   ['AltRight','Alt','mod'],['MetaRight','Cmd','mod'],['ArrowLeft','←','arrow'],['ArrowUp','↑','arrow'],
   ['ArrowDown','↓','arrow'],['ArrowRight','→','arrow']],
];

const kbd = document.getElementById('kbd');
for (const row of ROWS) {
  const rowEl = document.createElement('div');
  rowEl.className = 'row';
  for (const [code, label, extra] of row) {
    const k = document.createElement('div');
    k.className = 'k ' + (extra || '');
    k.dataset.code = code;
    k.textContent = label;
    const press = (e) => { e.preventDefault(); k.classList.add('active'); held.add(code); sendKeyboard(); };
    const rel   = (e) => { e.preventDefault(); k.classList.remove('active'); held.delete(code); sendKeyboard(); };
    k.addEventListener('pointerdown', press);
    k.addEventListener('pointerup', rel);
    k.addEventListener('pointerleave', rel);
    k.addEventListener('pointercancel', rel);
    rowEl.appendChild(k);
  }
  kbd.appendChild(rowEl);
}

document.getElementById('bKbd').addEventListener('click', () => kbd.classList.toggle('show'));
document.getElementById('bRelease').addEventListener('click', releaseAll);

// Reboot into USB download mode so the board can be reflashed without the
// BOOT button. Recovering from an accidental press is just a power cycle.
document.getElementById('bBoot').addEventListener('click', async () => {
  if (!confirm('Reboot the ESP into USB download mode?\n\n' +
               'It will stop working as a keyboard/mouse until you unplug ' +
               'and plug it back in.')) return;
  releaseAll();
  try { await fetch('/bootloader', { method: 'POST' }); } catch (_) {}
});

// ---------------------------------------------------------------- misc
const gainEl = document.getElementById('gain');
gainEl.addEventListener('input', () => {
  gain = parseFloat(gainEl.value);
  document.getElementById('gainVal').textContent = gain.toFixed(1) + '×';
});

// Heartbeat: the firmware releases everything if these stop while keys are held.
setInterval(() => send(new Uint8Array([0x04])), 1000);

// Never leave a key stuck when the page goes away.
window.addEventListener('pagehide', releaseAll);
window.addEventListener('beforeunload', releaseAll);

connect();
