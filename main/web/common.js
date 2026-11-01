// Shared by the shell and all four views: the access gate, authenticated
// requests, and the device settings blob.

// ---------------------------------------------------------------- access code
export const TOKEN_KEY = 'esp32remote.token';
export const TOKEN_LEN = 12;
export let token = '';

export function normalizeToken(t) {
  return String(t || '').replace(/[-\s]/g, '').toUpperCase();
}

// localStorage access can throw rather than merely fail (Safari private
// browsing rejects writes), so every access goes through these.
export function storeToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }
export function clearStoredToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} }

export function loadStoredToken() {
  try {
    const saved = normalizeToken(localStorage.getItem(TOKEN_KEY));
    if (saved.length !== TOKEN_LEN) return false;
    token = saved;
    return true;
  } catch (_) { return false; }
}

// ?token=... wins (an explicit hand-off, e.g. from the QR later on), otherwise
// fall back to whatever was saved last time.
export function loadToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    token = normalizeToken(fromUrl);
    storeToken(token);
    url.searchParams.delete('token');
    history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
    return token.length === TOKEN_LEN;
  }
  return loadStoredToken();
}

export async function verifyToken(t) {
  try {
    const r = await fetch(`/auth?token=${encodeURIComponent(t)}`, { cache: 'no-store' });
    return r.ok;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------- requests
export function apiUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

export async function apiFetch(path, opts) {
  return fetch(apiUrl(path), Object.assign({ cache: 'no-store' }, opts || {}));
}

export async function apiPost(path, body) {
  const opts = { method: 'POST', cache: 'no-store' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  return apiFetch(path, opts);
}

// ---------------------------------------------------------------- settings
// The device stores one JSON blob. The firmware only reads the USB name keys; every
// other key is the UI's business, so adding one is not a firmware change.
export const SETTINGS_DEFAULTS = {
  usb_product: 'ESP32 Remote',      // USB string 2 - the name the host shows
  usb_manufacturer: 'ESP32',        // USB string 1
  usb_interface: 'Keyboard Mouse Media',  // USB string 4 - cosmetic label
  screen_text: '',                  // the third BOOT screen, drawn as 10x26
  screen_timeout_s: 60,             // blank the display after this idle time
  type_speed: 20,
  mouse_gain: 1.0,
  scroll_scale: 1.0,
  scroll_invert: false,
  tap_click: true,
  tap_max_ms: 220,
};

export let appSettings = Object.assign({}, SETTINGS_DEFAULTS);

export async function loadSettings() {
  try {
    const r = await apiFetch('/settings');
    if (r.ok) {
      const device = await r.json();
      // Layer: defaults < device < any local overrides
      appSettings = Object.assign({}, SETTINGS_DEFAULTS, device, localOverrides());
    }
  } catch (_) { /* keep defaults */ }
  return appSettings;
}

// Values the UI can change without a round trip (kept so a device that is
// briefly unreachable does not lose them).
export function localOverrides() {
  try { return JSON.parse(localStorage.getItem('esp32remote.settings') || '{}'); }
  catch (_) { return {}; }
}

export function setLocal(setting, value) {
  appSettings[setting] = value;
  const o = localOverrides();
  o[setting] = value;
  try { localStorage.setItem('esp32remote.settings', JSON.stringify(o)); } catch (_) {}
}

// Keys that older builds wrote and nothing reads any more. `macros` moved into
// the browser's localStorage; the device stores the blob verbatim and cannot
// clean it up itself, so a device that still has it would round-trip it through
// every save for ever.
//
// `hid_name` is also dead: it was the original key for the product name before
// the manufacturer string existed, and usb_hid.c no longer reads it.
export const DEAD_SETTINGS = ['macros', 'hid_name'];

export async function saveSettingsToDevice() {
  // Send the lot, minus the keys that are no longer part of the model.
  const outgoing = Object.assign({}, appSettings);
  for (const k of DEAD_SETTINGS) delete outgoing[k];

  // Drop them from the in-memory settings too, so they do not reappear in a
  // backup, and so a later save cannot resurrect what this one removed.
  for (const k of DEAD_SETTINGS) delete appSettings[k];

  return apiPost('/settings', outgoing);
}

// ---------------------------------------------------------------- access gate
// The gate's markup is part of the shell (index.html) and starts hidden, so it
// never flashes on a page that already has a valid code.
export function showGate(msg) {
  const gate = document.getElementById('gate');
  if (!gate) return;
  gate.classList.remove('hidden');
  document.getElementById('gateErr').textContent = msg || '';
  document.getElementById('tokenInput').focus();
}

export function hideGate() {
  const gate = document.getElementById('gate');
  if (gate) gate.classList.add('hidden');
}

// Runs onReady() once a valid code is available, prompting for it if needed.
export async function requireAuth(onReady) {
  // URL parameter wins (an explicit hand-off), otherwise the saved code.
  // Reading localStorage unconditionally matters: this was once gated on the
  // URL having a token, which meant the saved code was written and never read.
  loadToken();

  if (token && await verifyToken(token)) {
    hideGate();
    onReady();
    return;
  }
  if (token) {
    // Saved code no longer matches the device.
    clearStoredToken();
    token = '';
  }

  const gate = document.getElementById('gate');
  if (!gate) return;              // no shell markup, nothing to prompt with
  gate.classList.remove('hidden');
  const input = document.getElementById('tokenInput');
  const err = document.getElementById('gateErr');

  const submit = async () => {
    const t = normalizeToken(input.value);
    if (t.length !== TOKEN_LEN) {
      err.textContent = `The code is ${TOKEN_LEN} characters.`;
      return;
    }
    err.textContent = 'checking...';
    if (!await verifyToken(t)) {
      err.textContent = 'Code rejected. Check the LCD and try again.';
      input.select();
      return;
    }
    token = t;
    storeToken(token);
    hideGate();
    onReady();
  };

  document.getElementById('tokenGo').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
}

// ---------------------------------------------------------------- misc
// Recover the stored code so the settings page's "Forget code" behaves.
export function forgetCode() {
  clearStoredToken();
  token = '';
}


// ---------------------------------------------------------------- host layouts
// The on-screen keyboard is a picture of the *host's* layout, not ours: a key
// sends a position, and the host decides what character that position is. So a
// layout is not cosmetic - it is what makes the labels true, and what the Type
// panel and the macro DSL type through.
//
// A layout is the two pages the keyboard draws, in the same row shape pad.js
// renders: [code, label, shiftedLabel, width]. The character map
// used for typing is DERIVED from those rows, so the picture and the typing
// path cannot disagree.
export const LAYOUT_KEY = 'esp32remote.hostLayout';

export const LAYOUT_ROWS = {
  us: {
    name: 'US QWERTY',
    sym: [
      [['Digit1','1','!'],['Digit2','2','@'],['Digit3','3','#'],['Digit4','4','$'],
       ['Digit5','5','%'],['Digit6','6','^'],['Digit7','7','&'],['Digit8','8','*'],
       ['Digit9','9','('],['Digit0','0',')']],
      [['Minus','-','_'],['Equal','=','+'],['BracketLeft','[','{'],
       ['BracketRight',']','}'],['Backslash','\\','|'],['Semicolon',';',':'],
       ['Quote',"'",'"'],['Backquote','`','~'],['Slash','/','?']],
      [['p:abc','ABC',null,'wide'],['Comma',',','<'],['Period','.','>'],
       ['Space','space',null,'space'],['p:fn','Fn',null,'wide'],['Enter','⏎',null,'wide']],
    ],
  },
  uk: {
    name: 'UK QWERTY',
    sym: [
      // UK moves " to 2, puts #~ where \| was on a US board, and moves \| to
      // the key left of Z on a real ISO board. The letter rows are unchanged.
      [['Digit1','1','!'],['Digit2','2','"'],['Digit3','3','£'],['Digit4','4','$'],
       ['Digit5','5','%'],['Digit6','6','^'],['Digit7','7','&'],['Digit8','8','*'],
       ['Digit9','9','('],['Digit0','0',')']],
      [['Minus','-','_'],['Equal','=','+'],['BracketLeft','[','{'],
       ['BracketRight',']','}'],['Semicolon',';',':'],['Quote',"'",'@'],
       ['Backquote','`','¬'],['NonUSHash','#','~'],['Slash','/','?']],
      [['p:abc','ABC',null,'wide'],['Comma',',','<'],['Period','.','>'],
       ['Space','space',null,'space'],['p:fn','Fn',null,'wide'],['Enter','⏎',null,'wide']],
    ],
  },
};

// The letter page is the same physical board for both: a UK keyboard is a US
// keyboard with different punctuation, so only the symbol page differs.
// A remote is used for short interactions while looking at the host: a URL, a
// path, a port number, a chord, an arrow key. So the two rows a phone keyboard
// hides - digits and arrows - are on the letter page, because a page switch is
// the most expensive thing this keyboard can ask for.
LAYOUT_ROWS.us.abc = [
  [['Escape','Esc'],['Tab','Tab'],['ControlLeft','Ctrl',null,'mod'],
   ['AltLeft','Alt',null,'mod'],['MetaLeft','Cmd',null,'mod'],
   ['p:fn','Fn',null,'mod']],
  [['Digit1','1','!'],['Digit2','2','@'],['Digit3','3','#'],['Digit4','4','$'],
   ['Digit5','5','%'],['Digit6','6','^'],['Digit7','7','&'],['Digit8','8','*'],
   ['Digit9','9','('],['Digit0','0',')']],
  [['KeyQ','q','Q'],['KeyW','w','W'],['KeyE','e','E'],['KeyR','r','R'],['KeyT','t','T'],
   ['KeyY','y','Y'],['KeyU','u','U'],['KeyI','i','I'],['KeyO','o','O'],['KeyP','p','P']],
  [['KeyA','a','A'],['KeyS','s','S'],['KeyD','d','D'],['KeyF','f','F'],['KeyG','g','G'],
   ['KeyH','h','H'],['KeyJ','j','J'],['KeyK','k','K'],['KeyL','l','L']],
  [['ShiftLeft','⇧',null,'wide'],['KeyZ','z','Z'],['KeyX','x','X'],['KeyC','c','C'],
   ['KeyV','v','V'],['KeyB','b','B'],['KeyN','n','N'],['KeyM','m','M'],
   ['Backspace','DEL',null,'wide']],
  // One key, like the real board: slash, with the question mark as its shifted
  // legend. A dedicated "?" key here read as a slash key and could only ever
  // produce a question mark.
  [['p:sym','?123',null,'wide'],['Comma',','],['Space','space',null,'space'],
   ['Period','.'],['Slash','/','?'],['Enter','⏎',null,'wide']],
  [['ArrowLeft','←'],['ArrowUp','↑'],['ArrowDown','↓'],['ArrowRight','→']],
];
LAYOUT_ROWS.uk.abc = LAYOUT_ROWS.us.abc;

export function hostLayoutId() {
  try {
    const id = localStorage.getItem(LAYOUT_KEY);
    return LAYOUT_ROWS[id] ? id : 'us';
  } catch (_) {
    return 'us';
  }
}

export function hostLayout() {
  return LAYOUT_ROWS[hostLayoutId()];
}

export function setHostLayout(id) {
  try { localStorage.setItem(LAYOUT_KEY, LAYOUT_ROWS[id] ? id : 'us'); } catch (_) {}
}

// character -> [DOM code, needsShift], derived from the rows above. Anything the
// keyboard cannot draw cannot be typed either, which is the invariant worth
// having: the picture and the typing path are the same data.
export function layoutTextMap() {
  const map = {};
  const add = (ch, code, shift) => {
    if (typeof ch !== 'string' || [...ch].length !== 1) return;
    map[ch] = [code, !!shift];
  };
  const layout = hostLayout();
  for (const page of [layout.abc, layout.sym]) {
    for (const row of page) {
      for (const [code, label, alt] of row) {
        if (String(code).startsWith('p:')) continue;
        if (label) add(label, code, false);
        if (alt) add(alt, code, true);
      }
    }
  }
  // Whitespace is drawn as a word rather than a character.
  map[' '] = ['Space', false];
  map['\n'] = ['Enter', false];
  map['\t'] = ['Tab', false];
  return map;
}

// ---------------------------------------------------------------- viewport
// The on-screen keyboard can either resize the page or lay itself over it, and
// which one you get depends on the browser and on the `interactive-widget`
// hint. Sizing the app from the visual viewport covers both cases: if the
// keyboard overlays, this shrinks the layout to the part still visible, and if
// it resizes, the two agree and nothing moves.
export function syncAppHeight() {
  const vv = window.visualViewport;
  const h = Math.round(vv ? vv.height : window.innerHeight);
  document.documentElement.style.setProperty('--app-height', h + 'px');
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncAppHeight);
  window.visualViewport.addEventListener('scroll', syncAppHeight);
}
window.addEventListener('orientationchange', syncAppHeight);
syncAppHeight();

// ---------------------------------------------------------------- HID tables
export const HID_KEYS = {
  KeyA:0x04,KeyB:0x05,KeyC:0x06,KeyD:0x07,KeyE:0x08,KeyF:0x09,KeyG:0x0A,KeyH:0x0B,
  KeyI:0x0C,KeyJ:0x0D,KeyK:0x0E,KeyL:0x0F,KeyM:0x10,KeyN:0x11,KeyO:0x12,KeyP:0x13,
  KeyQ:0x14,KeyR:0x15,KeyS:0x16,KeyT:0x17,KeyU:0x18,KeyV:0x19,KeyW:0x1A,KeyX:0x1B,
  KeyY:0x1C,KeyZ:0x1D,
  Digit1:0x1E,Digit2:0x1F,Digit3:0x20,Digit4:0x21,Digit5:0x22,Digit6:0x23,Digit7:0x24,
  Digit8:0x25,Digit9:0x26,Digit0:0x27,
  Enter:0x28,Escape:0x29,Backspace:0x2A,Tab:0x2B,Space:0x2C,Minus:0x2D,Equal:0x2E,
  BracketLeft:0x2F,BracketRight:0x30,Backslash:0x31,Semicolon:0x33,Quote:0x34,
  // ISO keys the UK layout needs.
  NonUSHash:0x32,IntlBackslash:0x64,
  // Keypad: distinct usages from the number row, and Num Lock changes what
  // the host does with them.
  NumLock:0x53,NumpadDivide:0x54,NumpadMultiply:0x55,NumpadSubtract:0x56,
  NumpadAdd:0x57,NumpadEnter:0x58,
  Numpad1:0x59,Numpad2:0x5A,Numpad3:0x5B,Numpad4:0x5C,Numpad5:0x5D,
  Numpad6:0x5E,Numpad7:0x5F,Numpad8:0x60,Numpad9:0x61,Numpad0:0x62,
  NumpadDecimal:0x63,
  Backquote:0x35,Comma:0x36,Period:0x37,Slash:0x38,CapsLock:0x39,
  F1:0x3A,F2:0x3B,F3:0x3C,F4:0x3D,F5:0x3E,F6:0x3F,F7:0x40,F8:0x41,F9:0x42,
  F10:0x43,F11:0x44,F12:0x45,
  Insert:0x49,Home:0x4A,PageUp:0x4B,Delete:0x4C,End:0x4D,PageDown:0x4E,
  ArrowRight:0x4F,ArrowLeft:0x50,ArrowDown:0x51,ArrowUp:0x52,
};
