// Shared by the shell and all four views: the access gate, authenticated
// requests, and the device settings blob.

// ---------------------------------------------------------------- device
// Which dongle this page is driving. The device's own UI is served by it, so
// the origin is the device; the published UI is served by someone else and has
// to be told. A base is always an origin - the API paths are absolute - so a
// saved value that is not one is ignored rather than used to build a URL.
export const DEVICE_KEY = 'esp32remote.device';
export let deviceBase = '';

function normalizeBase(base) {
  let v = String(base || '').trim();
  // A space is not a hostname. URL would read "not a url" as the host "not"
  // with a path, which is a device at an address nobody typed.
  if (!v || /\s/.test(v)) return '';
  // A bare address is what the LCD shows, so it is what gets typed.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'http://' + v;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : '';
  } catch (_) { return ''; }
}

export function setDeviceBase(base) {
  const next = normalizeBase(base);
  deviceBase = next;
  try {
    // The origin itself needs no key: it is the fallback, and storing it would
    // survive a move to another address for no benefit.
    if (next && next !== location.origin) localStorage.setItem(DEVICE_KEY, next);
    else localStorage.removeItem(DEVICE_KEY);
  } catch (_) {}
  return deviceBase;
}

export function currentBase() {
  return deviceBase || location.origin;
}

export function deviceUrl(path) {
  return currentBase() + path;
}

// ws:// for http://, wss:// for https:// - the device has no TLS yet, but a
// published page on HTTPS still needs the mirror of whatever base it was given.
export function wsUrl(path) {
  return currentBase().replace(/^http/, 'ws') + path;
}

// Restored before anything can ask for a URL, which is why this runs at load
// rather than inside the gate.
try {
  const saved = normalizeBase(localStorage.getItem(DEVICE_KEY) || '');
  if (saved) deviceBase = saved;
} catch (_) {}

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

// An optional base lets the gate check a device before it becomes the current
// one, which is what the server list needs.
export async function verifyToken(t, base) {
  const origin = base ? normalizeBase(base) : currentBase();
  if (!origin) return false;
  try {
    const r = await fetch(`${origin}/auth?token=${encodeURIComponent(t)}`, { cache: 'no-store' });
    return r.ok;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------- requests
export function apiUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${deviceUrl(path)}${sep}token=${encodeURIComponent(token)}`;
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
  usb_product: 'Keebling',           // USB string 2 - the name the host shows
  usb_manufacturer: 'amoshydra',     // USB string 1
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

// Runs onReady() once this page knows which device it is driving and holds a
// valid code for it. Who served the page changes the question: the dongle's own
// UI has exactly one device, while the published UI has none until one is
// picked.
export async function requireAuth(onReady) {
  if (await isDeviceOrigin()) {
    await requireCode(onReady);
    return;
  }

  // The published UI is the one that can end up on the dongle's access point
  // with no internet, so it is the one that needs a cached shell.
  //
  // The build id is part of the URL so a deploy is noticed immediately. Without
  // it, GitHub Pages' ten-minute cache would keep the old worker script - and
  // therefore the old shell - current long after the push.
  if ('serviceWorker' in navigator) {
    const published = document.querySelector('meta[name="keebling-published"]');
    const build = published && published.dataset ? published.dataset.build : '';
    const query = build ? `?v=${encodeURIComponent(build)}` : '';
    navigator.serviceWorker.register(`sw.js${query}`).catch(() => {});
  }
  await requireHub(onReady);
}

// The device's own UI: one code, one device, exactly as it always was.
async function requireCode(onReady) {
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
  const hub = document.getElementById('hub');
  const codeBox = document.getElementById('gateCode');
  if (hub) hub.hidden = true;
  if (codeBox) codeBox.hidden = false;
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
    enterDevice(currentBase(), t, onReady);
  };

  document.getElementById('tokenGo').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
}

// Commit a choice and let the shell boot. Both gates end here, so "which device
// is this session for" has exactly one answer.
function enterDevice(base, code, onReady) {
  setDeviceBase(base);
  token = normalizeToken(code);
  storeToken(token);
  setupDeviceChip();
  hideGate();
  onReady();
}

// ---------------------------------------------------------------- device list
// Devices the published UI has been told about, in this browser. They are not
// discovered: a static page cannot enumerate a LAN, and sweeping addresses is
// the fingerprinting the Local Network Access permission exists to prevent.
export const DEVICES_KEY = 'esp32remote.devices';

export function loadDevices() {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICES_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map((d) => {
      if (!d || typeof d !== 'object' || !Array.isArray(d.hosts)) return null;
      const hosts = d.hosts.map(normalizeBase).filter(Boolean);
      if (!hosts.length) return null;
      return {
        id: String(d.id || hosts[0]),
        name: String(d.name || ''),
        hosts: [...new Set(hosts)],
        token: normalizeToken(d.token || ''),
      };
    }).filter(Boolean);
  } catch (_) { return []; }
}

export function saveDevices(devices) {
  try { localStorage.setItem(DEVICES_KEY, JSON.stringify(devices)); } catch (_) {}
}

// An id survives the address changing, which is the point of having one.
function newDeviceId() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch (_) {}
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Is a device at this address, and is the code right? The 403 is only readable
// because the firmware puts Access-Control-Allow-Origin on its error responses;
// without that, "wrong code" and "unreachable" are the same TypeError.
export async function checkDevice(base, code) {
  const origin = normalizeBase(base);
  if (!origin) return { state: 'bad-address' };

  const t = normalizeToken(code);
  if (t.length !== TOKEN_LEN) return { state: 'bad-code' };

  try {
    const r = await fetch(`${origin}/auth?token=${encodeURIComponent(t)}`,
                          { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (r.ok) return { state: 'ok', base: origin };
    if (r.status === 403) return { state: 'rejected', base: origin };
    return { state: 'unexpected', base: origin, status: r.status };
  } catch (e) {
    return { state: e && e.name === 'TimeoutError' ? 'timeout' : 'unreachable', base: origin };
  }
}

// The Pages deployment injects this marker into the shell; the firmware's copy
// has none. It costs no request, leaves no 404 in the console, and cannot be
// confused by a host that answers 200 for every path.
export async function isDeviceOrigin() {
  return !document.querySelector('meta[name="keebling-published"]');
}

// Leaving a running app for another device: reload rather than rebind. A reload
// rebuilds the socket, the listeners and the settings in one step, and it is
// the only path that cannot leave half a session talking to the old dongle.
export function switchDevice(base, code) {
  setDeviceBase(base);
  token = normalizeToken(code);
  storeToken(token);
  location.reload();
}

// The published UI: pick a device, then boot on it.
async function requireHub(onReady) {
  const gate = document.getElementById('gate');
  const hub = document.getElementById('hub');
  if (!gate || !hub) { onReady(); return; }   // no shell markup: nothing to ask with

  gate.classList.remove('hidden');
  hub.hidden = false;
  const codeBox = document.getElementById('gateCode');
  if (codeBox) codeBox.hidden = true;

  // A saved device that still answers boots straight through. The list is for
  // the first visit, and for when an address has moved.
  const devices = loadDevices();
  const savedHost = currentBase();
  const saved = devices.find((d) => d.hosts.includes(savedHost));
  const savedCode = (saved && saved.token) || token;
  if (saved && savedCode && await verifyToken(savedCode, savedHost)) {
    enterDevice(savedHost, savedCode, onReady);
    return;
  }

  mountDevices(hub, {
    onPick: (dev, base) => enterDevice(base, dev.token, onReady),
  });
}

// ---------------------------------------------------------------- device list
// One renderer for the boot gate and the Devices view. They show the same list
// in the same state, and the gate is only seen when something is wrong - which
// is exactly when two drifting copies would hurt most.
export function mountDevices(host, opts) {
  const tpl = document.getElementById('devices-ui');
  if (!tpl || !host) return null;
  host.replaceChildren(tpl.content.cloneNode(true));

  const q = (role) => host.querySelector(`[data-role="${role}"]`);
  const listEl = q('list');
  const errEl = q('err');
  const devices = loadDevices();
  const status = new Map();
  const pick = (opts && opts.onPick) || ((dev, base) => switchDevice(base, dev.token));
  let editingId = null;

  const LABEL = { on: 'online', off: 'offline', warn: 'no code', checking: 'checking' };
  const DOT = { on: 'on', off: 'off', warn: 'warn' };

  // The chip names the active device, so it follows a rename here.
  const save = () => { saveDevices(devices); setupDeviceChip(); };

  const act = (text, onClick, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };

  const render = () => {
    listEl.replaceChildren();
    if (!devices.length) {
      const p = document.createElement('p');
      p.className = 'hub-empty';
      p.textContent = 'No devices yet. Add one below.';
      listEl.append(p);
      return;
    }

    for (const dev of devices) {
      const row = document.createElement('li');
      row.className = 'hub-row';

      if (editingId === dev.id) {
        // Editing in place rather than behind a modal: the address is the thing
        // that moved, and seeing the old one next to the field is the point.
        row.classList.add('hub-editing');

        const name = document.createElement('input');
        name.type = 'text';
        name.className = 'hub-input';
        name.placeholder = 'Name';
        name.value = dev.name;

        const addr = document.createElement('input');
        addr.type = 'text';
        addr.className = 'hub-input';
        addr.placeholder = 'Address';
        addr.spellcheck = false;
        addr.value = dev.hosts[0];

        const fields = document.createElement('div');
        fields.className = 'hub-editrow';
        fields.append(name, addr);

        const actions = document.createElement('div');
        actions.className = 'hub-editrow';
        actions.append(
          act('Save', () => commitEdit(dev, name, addr), 'primary'),
          act('Cancel', () => { editingId = null; render(); }, 'hub-act'));

        row.append(fields, actions);
        listEl.append(row);
        continue;
      }

      const state = status.get(dev.id) || 'checking';
      const chooseBtn = document.createElement('button');
      chooseBtn.type = 'button';
      chooseBtn.className = 'hub-pick';
      const dot = document.createElement('span');
      dot.className = 'dot ' + (DOT[state] || 'off');
      const name = document.createElement('span');
      name.className = 'hub-name';
      name.textContent = dev.name || dev.hosts[0];
      const label = document.createElement('span');
      label.className = 'hub-state';
      label.textContent = LABEL[state] || state;
      chooseBtn.append(dot, name, label);
      chooseBtn.addEventListener('click', () => choose(dev));

      const edit = act('✎', () => { editingId = dev.id; render(); }, 'hub-act');
      edit.setAttribute('aria-label', `Edit ${dev.name || dev.hosts[0]}`);

      const del = act('×', () => {
        devices.splice(devices.indexOf(dev), 1);
        save();
        render();
      }, 'hub-del');
      del.setAttribute('aria-label', `Remove ${dev.name || dev.hosts[0]}`);

      row.append(chooseBtn, edit, del);
      listEl.append(row);
    }
  };

  // Asynchronous answers must not redraw over a field being edited.
  const draw = () => { if (editingId === null) render(); };

  const commitEdit = (dev, nameEl, addrEl) => {
    const addr = normalizeBase(addrEl.value);
    if (!addr) { errEl.textContent = 'That address does not look like one.'; return; }
    dev.name = nameEl.value.trim();
    // The edited address replaces the list: the user is correcting a move, not
    // asking to keep probing the address that stopped answering.
    dev.hosts = [addr];
    save();
    editingId = null;
    errEl.textContent = '';
    render();
    probeOne(dev);
  };

  const choose = async (dev) => {
    errEl.textContent = '';
    if (!dev.token) {
      errEl.textContent = 'That device has no saved code. Add it again below.';
      return;
    }
    for (const host of dev.hosts) {
      status.set(dev.id, 'checking');
      draw();
      const r = await checkDevice(host, dev.token);
      if (r.state === 'ok') {
        // Remember the address that worked, so the next visit tries it first.
        dev.hosts = [host, ...dev.hosts.filter((h) => h !== host)];
        save();
        pick(dev, host);
        return;
      }
      if (r.state === 'rejected') {
        status.set(dev.id, 'warn');
        draw();
        errEl.textContent = 'Code rejected. Check the LCD on that device.';
        return;
      }
    }
    status.set(dev.id, 'off');
    draw();
    errEl.textContent = 'No answer — is that device on this network?';
  };

  const add = async () => {
    const name = q('name').value.trim();
    const addr = q('addr').value.trim();
    const code = normalizeToken(q('code').value);
    errEl.textContent = '';

    if (code.length !== TOKEN_LEN) {
      errEl.textContent = `The code is ${TOKEN_LEN} characters.`;
      return;
    }
    if (!normalizeBase(addr)) {
      errEl.textContent = 'That address does not look like one.';
      return;
    }

    const go = q('go');
    go.disabled = true;
    errEl.textContent = 'checking...';
    const r = await checkDevice(addr, code);
    go.disabled = false;

    if (r.state === 'ok') {
      let dev = devices.find((d) => d.hosts.includes(r.base));
      if (dev) {
        dev.token = code;
        if (name) dev.name = name;
      } else {
        dev = { id: newDeviceId(), name, hosts: [r.base], token: code };
        devices.push(dev);
      }
      save();
      pick(dev, r.base);
      return;
    }
    if (r.state === 'rejected') {
      errEl.textContent = 'Code rejected. Check the LCD on that device.';
      return;
    }
    if (r.state === 'bad-code') {
      errEl.textContent = `The code is ${TOKEN_LEN} characters.`;
      return;
    }
    errEl.textContent = r.state === 'timeout'
      ? 'No answer — is that device on this network?'
      : 'Could not reach that address.';
  };

  const probeOne = async (dev) => {
    if (!dev.token) { status.set(dev.id, 'warn'); draw(); return; }
    for (const host of dev.hosts) {
      const r = await checkDevice(host, dev.token);
      if (r.state === 'ok') { status.set(dev.id, 'on'); draw(); return; }
      if (r.state === 'rejected') { status.set(dev.id, 'warn'); draw(); return; }
    }
    status.set(dev.id, 'off');
    draw();
  };

  const probeAll = async () => {
    await Promise.all(devices.map(probeOne));
    draw();
  };

  render();
  q('go').addEventListener('click', add);
  for (const role of ['name', 'addr', 'code']) {
    const el = q(role);
    if (el) el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
    });
  }
  probeAll();

  return { devices, render, probe: probeAll };
}

// The published shell says which dongle it is typing into, and the chip is the
// way back to the list. The device's own UI has one device and hides it.
function setupDeviceChip() {
  const chip = document.getElementById('deviceChip');
  if (!chip) return;
  // The firmware's copy has one device and no chip.
  if (!document.querySelector('meta[name="keebling-published"]')) return;

  const base = currentBase();
  const dev = loadDevices().find((d) => d.hosts.includes(base));
  chip.textContent = (dev && dev.name) || base.replace(/^https?:\/\//, '');
  chip.title = base;
  chip.hidden = false;

  // Wire once: this is called again whenever the list changes, so a rename is
  // visible on the chip without a reload.
  if (!chip.dataset.wired) {
    chip.dataset.wired = '1';
    chip.addEventListener('click', () => { location.hash = '#/devices'; });
  }
}

// ---------------------------------------------------------------- misc
// Recover the stored code so the settings page's "Forget code" behaves.
export function forgetCode() {
  clearStoredToken();
  token = '';
  // On the published UI the code belongs to a device record, so clearing only
  // the session copy would leave the hub listing a code that no longer works.
  if (deviceBase) {
    const devices = loadDevices();
    let changed = false;
    for (const d of devices) {
      if (d.hosts.includes(deviceBase) && d.token) {
        d.token = '';
        changed = true;
      }
    }
    if (changed) saveDevices(devices);
  }
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
      [['Comma',',','<'],['Period','.','>'],
       ['Space','space',null,'space'],['Enter','⏎',null,'wide']],
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
      [['Comma',',','<'],['Period','.','>'],
       ['Space','space',null,'space'],['Enter','⏎',null,'wide']],
    ],
  },
};

// The letter page is the same physical board for both: a UK keyboard is a US
// keyboard with different punctuation, so only the symbol page differs.
//
// Five rows, like the board in front of you. Digits and arrows used to sit on
// this page because a page switch meant hunting for a key that only existed on
// the page you were leaving; the strip under the pad made switching free, so
// the typing surface is a keyboard again rather than everything at once.
LAYOUT_ROWS.us.abc = [
  [['Escape','Esc'],['Tab','Tab'],['ControlLeft','Ctrl',null,'mod'],
   ['AltLeft','Alt',null,'mod'],['MetaLeft','Cmd',null,'mod']],
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
  [['Comma',','],['Space','space',null,'space'],
   ['Period','.'],['Slash','/','?'],['Enter','⏎',null,'wide']],
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
