// Shared between the control page and the settings page: the access gate,
// authenticated requests, and the device settings blob.

// ---------------------------------------------------------------- access code
const TOKEN_KEY = 'esp32remote.token';
const TOKEN_LEN = 12;
let token = '';

function normalizeToken(t) {
  return String(t || '').replace(/[-\s]/g, '').toUpperCase();
}

// localStorage access can throw rather than merely fail (Safari private
// browsing rejects writes), so every access goes through these.
function storeToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }
function clearStoredToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} }

function loadStoredToken() {
  try {
    const saved = normalizeToken(localStorage.getItem(TOKEN_KEY));
    if (saved.length !== TOKEN_LEN) return false;
    token = saved;
    return true;
  } catch (_) { return false; }
}

// ?token=... wins (an explicit hand-off, e.g. from the QR later on), otherwise
// fall back to whatever was saved last time.
function loadToken() {
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

async function verifyToken(t) {
  try {
    const r = await fetch(`/auth?token=${encodeURIComponent(t)}`, { cache: 'no-store' });
    return r.ok;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------- requests
function apiUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

async function apiFetch(path, opts) {
  return fetch(apiUrl(path), Object.assign({ cache: 'no-store' }, opts || {}));
}

async function apiPost(path, body) {
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
const SETTINGS_DEFAULTS = {
  usb_product: 'ESP32 Remote',      // USB string 2 - the name the host shows
  usb_manufacturer: 'ESP32',        // USB string 1
  usb_interface: 'Keyboard Mouse Media',  // USB string 4 - cosmetic label
  screen_timeout_s: 10,             // blank the display after this idle time
  type_speed: 20,
  mouse_gain: 1.0,
  scroll_scale: 1.0,
  scroll_invert: false,
  tap_click: true,
  tap_max_ms: 220,
};

let appSettings = Object.assign({}, SETTINGS_DEFAULTS);

async function loadSettings() {
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
function localOverrides() {
  try { return JSON.parse(localStorage.getItem('esp32remote.settings') || '{}'); }
  catch (_) { return {}; }
}

function setLocal(setting, value) {
  appSettings[setting] = value;
  const o = localOverrides();
  o[setting] = value;
  try { localStorage.setItem('esp32remote.settings', JSON.stringify(o)); } catch (_) {}
}

async function saveSettingsToDevice() {
  // Only send the keys the device model knows about plus its own; send the lot.
  return apiPost('/settings', appSettings);
}

// ---------------------------------------------------------------- access gate
function buildGate() {
  const gate = document.createElement('div');
  gate.id = 'gate';
  gate.innerHTML = `
    <div class="gate-box">
      <h1>ESP32 Remote</h1>
      <p>Enter the 12-character code shown on the device's LCD &mdash; or scan its QR.</p>
      <input id="tokenInput" type="text" inputmode="latin" autocomplete="off"
             autocapitalize="characters" spellcheck="false" maxlength="20"
             placeholder="XXXXXXXXXXXX">
      <button id="tokenGo" class="primary">Connect</button>
      <p class="err" id="gateErr"></p>
    </div>`;
  document.body.appendChild(gate);
  return gate;
}

function showGate(msg) {
  const gate = document.getElementById('gate') || buildGate();
  gate.classList.remove('hidden');
  document.getElementById('gateErr').textContent = msg || '';
  document.getElementById('tokenInput').focus();
}

function hideGate() {
  const gate = document.getElementById('gate');
  if (gate) gate.classList.add('hidden');
}

// Runs onReady() once a valid code is available, prompting for it if needed.
async function requireAuth(onReady) {
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

  const gate = document.getElementById('gate') || buildGate();
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
function forgetCode() {
  clearStoredToken();
  token = '';
}
