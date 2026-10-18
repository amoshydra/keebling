// Settings page: device settings, touchpad tuning, network, diagnostics.

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const saveNote = document.getElementById('saveNote');

function setStatus(text, cls) {
  statusText.textContent = text;
  dot.className = 'dot ' + cls;
}

// ---------------------------------------------------------------- bindings
// Each control reads from appSettings on load and writes back on change, so
// there is one source of truth and no hidden form state.
const BINDINGS = [
  { id: 'usbProduct',      key: 'usb_product',      kind: 'text' },
  { id: 'usbManufacturer', key: 'usb_manufacturer', kind: 'text' },
  { id: 'usbInterface',    key: 'usb_interface',    kind: 'text' },
  { id: 'screenText',      key: 'screen_text',      kind: 'text' },
  { id: 'screenTimeout',   key: 'screen_timeout_s', kind: 'range', suffix: ' s', dp: 0 },
  { id: 'mouseGain',    key: 'mouse_gain',    kind: 'range', suffix: 'x', dp: 1 },
  { id: 'scrollScale',  key: 'scroll_scale',  kind: 'range', suffix: 'x', dp: 1 },
  { id: 'scrollInvert', key: 'scroll_invert', kind: 'bool' },
  { id: 'tapClick',     key: 'tap_click',     kind: 'bool' },
  { id: 'tapMaxMs',     key: 'tap_max_ms',    kind: 'range', suffix: ' ms', dp: 0 },
  { id: 'typeSpeed',    key: 'type_speed',    kind: 'range', suffix: ' chars/s', dp: 0 },
];

function labelFor(b, value) {
  if (b.key === 'screen_timeout_s' && Number(value) === 0) return 'never';
  return Number(value).toFixed(b.dp) + (b.suffix || '');
}

function readIntoForm() {
  for (const b of BINDINGS) {
    const el = document.getElementById(b.id);
    const val = appSettings[b.key];
    if (b.kind === 'bool') el.checked = val !== false;
    else el.value = val;
    if (b.kind === 'range') {
      const out = document.getElementById(b.id + 'Val');
      if (out) out.textContent = labelFor(b, el.value);
    }
  }
}

function wireForm() {
  for (const b of BINDINGS) {
    const el = document.getElementById(b.id);
    const handler = () => {
      let v;
      if (b.kind === 'bool') v = el.checked;
      else if (b.kind === 'range') v = Number(el.value);
      else v = el.value;
      setLocal(b.key, v);
      if (b.kind === 'range') {
        const out = document.getElementById(b.id + 'Val');
        if (out) out.textContent = labelFor(b, el.value);
      }
      scheduleSave();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }
}

// ---------------------------------------------------------------- save
// Fields update the local model as you type; the device is told separately.
// Originally that meant a Save button you could forget before restarting, so
// saving is now automatic and debounced, and "Restart device" saves first.
let saveTimer = null;

async function doSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveNote.textContent = 'saving…';
  try {
    const r = await saveSettingsToDevice();
    saveNote.textContent = r.ok ? 'saved to device' : `save failed (HTTP ${r.status})`;
    return r.ok;
  } catch (_) {
    saveNote.textContent = 'save failed — device unreachable';
    return false;
  }
}

function scheduleSave() {
  saveNote.textContent = 'saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 700);
}

document.getElementById('save').addEventListener('click', doSave);

document.getElementById('restart').addEventListener('click', async () => {
  if (!confirm('Restart the device?\n\nSettings will be saved first. ' +
               'It will be unreachable for a few seconds.')) return;
  const ok = await doSave();
  if (!ok) { alert('Could not save settings — restarting anyway.'); }
  try { await apiPost('/restart'); } catch (_) {}
  setStatus('restarting…', 'warn');
  setTimeout(() => location.reload(), 6000);
});

document.getElementById('forgetCode').addEventListener('click', () => {
  forgetCode();
  alert('Saved code forgotten. You will be asked for it again.');
});

// ---------------------------------------------------------------- network
document.getElementById('wifiScan').addEventListener('click', async () => {
  const list = document.getElementById('wifiList');
  list.textContent = 'scanning…';
  try {
    const r = await apiFetch('/scan');
    if (!r.ok) { list.textContent = `Scan failed (HTTP ${r.status}).`; return; }

    const data = await r.json();
    const nets = (data.networks || []).slice().sort((a, b) => b.rssi - a.rssi);
    list.innerHTML = '';
    if (!nets.length) { list.textContent = 'No networks found.'; return; }

    for (const n of nets) {
      const el = document.createElement('div');
      el.className = 'item';
      const name = document.createElement('span');
      name.textContent = n.ssid || '(hidden)';
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.textContent = `${n.rssi} dBm${n.secure ? ' 🔒' : ''}`;
      el.append(name, bar);
      el.addEventListener('click', () => {
        document.getElementById('wifiSsid').value = n.ssid || '';
        document.getElementById('wifiPass').focus();
        list.querySelectorAll('.item').forEach((i) => i.classList.remove('selected'));
        el.classList.add('selected');
      });
      list.appendChild(el);
    }
  } catch (_) {
    list.textContent = 'Scan failed.';
  }
});

document.getElementById('wifiSave').addEventListener('click', async () => {
  const ssid = document.getElementById('wifiSsid').value.trim();
  const pass = document.getElementById('wifiPass').value;
  if (!ssid) { alert('Enter a network name first.'); return; }
  if (!confirm(`Save "${ssid}" and restart?\n\nThe device will try to join it. ` +
               'If that fails its own access point comes back.')) return;
  try {
    await apiPost('/save', { ssid, pass });
  } catch (_) { /* the device reboots as it answers */ }
  setStatus('restarting…', 'warn');
  setTimeout(() => location.reload(), 8000);
});

document.getElementById('wifiForget').addEventListener('click', async () => {
  if (!confirm('Forget the saved network?\n\nThe device restarts in access-point ' +
               'mode, so you will need to join "esp-remote" to reach it again.')) return;
  try { await apiPost('/forget'); } catch (_) {}
  setStatus('restarting…', 'warn');
  setTimeout(() => location.reload(), 8000);
});

// ---------------------------------------------------------------- logs
document.getElementById('logsLoad').addEventListener('click', async () => {
  const panel = document.getElementById('logs');
  const pre = document.getElementById('logText');
  panel.classList.toggle('show');
  if (!panel.classList.contains('show')) return;
  pre.textContent = 'loading…';
  try {
    const r = await apiFetch('/logs');
    pre.textContent = r.ok ? await r.text() : `Failed (HTTP ${r.status}).`;
  } catch (_) {
    pre.textContent = 'Failed to load logs.';
  }
});

// ---------------------------------------------------------------- HID descriptor
// Enough of the HID report descriptor grammar to make the descriptor readable:
// item prefix, then the global/local state that main items inherit.
const USAGE_PAGE_NAMES = {
  0x01: 'Generic Desktop', 0x02: 'Simulation', 0x07: 'Keyboard/Keypad',
  0x08: 'LED', 0x09: 'Button', 0x0A: 'Ordinal', 0x0B: 'Telephony',
  0x0C: 'Consumer', 0x0D: 'Digitizer', 0x0F: 'PID',
  0xFF00: 'Vendor-defined',
};
const GD_USAGES = {
  0x01: 'Pointer', 0x02: 'Mouse', 0x04: 'Joystick', 0x05: 'Game Pad',
  0x06: 'Keyboard', 0x07: 'Keypad',
  0x30: 'X', 0x31: 'Y', 0x32: 'Z', 0x38: 'Wheel',
  0x80: 'System Control', 0x81: 'System Power Down',
  0x82: 'System Sleep', 0x83: 'System Wake Up',
};
// Named for the usages the device actually declares, so the viewer reads
// clearly rather than showing bare hex.
const CONSUMER_USAGES = {
  0x01: 'Consumer Control',
  0xB0: 'Play', 0xB1: 'Pause', 0xB5: 'Scan Next', 0xB6: 'Scan Previous',
  0xB7: 'Stop', 0xCD: 'Play/Pause',
  0xE2: 'Mute', 0xE9: 'Volume Up', 0xEA: 'Volume Down',
  0x192: 'Calculator', 0x221: 'Search',
  0x223: 'Home', 0x224: 'Back', 0x225: 'Forward',
  0x238: 'AC Pan',            // horizontal scroll, in the mouse report
};
const LED_USAGES = { 1: 'Num Lock', 2: 'Caps Lock', 3: 'Scroll Lock', 4: 'Compose', 5: 'Kana' };

function usageName(page, usage) {
  if (page === 0x01) return GD_USAGES[usage] || `0x${usage.toString(16)}`;
  if (page === 0x07) return `Key 0x${usage.toString(16)}`;
  if (page === 0x08) return LED_USAGES[usage] || `LED ${usage}`;
  if (page === 0x09) return `Button ${usage}`;
  if (page === 0x0C) return CONSUMER_USAGES[usage] || `0x${usage.toString(16)}`;
  return `0x${usage.toString(16)}`;
}

const COLLECTION_KINDS = {
  0: 'Physical', 1: 'Application', 2: 'Logical', 3: 'Report',
  4: 'Named Array', 5: 'Usage Switch', 6: 'Usage Modifier',
};

function decodeReportDescriptor(bytes) {
  const out = [];
  let depth = 0;
  const pad = () => '  '.repeat(depth);

  const glob = { usagePage: 0, reportSize: 0, reportCount: 0, reportId: 0 };
  let usages = [];
  let usageMin = null, usageMax = null;

  const flushLocals = () => { usages = []; usageMin = usageMax = null; };

  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    const tag = b >> 4;
    const type = (b >> 2) & 3;              // 0 main, 1 global, 2 local
    const size = [0, 1, 2, 4][b & 3];

    let val = 0;
    for (let k = 0; k < size; k++) val |= bytes[i + k] << (8 * k);
    const signed = size && (bytes[i + size - 1] & 0x80)
      ? val - Math.pow(2, 8 * size) : val;
    i += size;

    if (type === 0) {
      if (tag === 0xA) {                     // Collection
        const kind = COLLECTION_KINDS[val] || val;
        const named = usages.map((u) => usageName(glob.usagePage, u)).join(', ');
        out.push(`${pad()}Collection (${kind})${named ? '  → ' + named : ''}`);
        depth++;
        flushLocals();
      } else if (tag === 0xC) {              // End Collection
        depth = Math.max(0, depth - 1);
        out.push(`${pad()}End Collection`);
        flushLocals();
      } else if (tag === 0x8 || tag === 0x9 || tag === 0xB) {
        const kind = { 0x8: 'Input', 0x9: 'Output', 0xB: 'Feature' }[tag];
        const f = [];
        f.push(val & 0x01 ? 'Const' : 'Data');
        f.push(val & 0x02 ? 'Var' : 'Array');
        f.push(val & 0x04 ? 'Rel' : 'Abs');
        if (val & 0x100) f.push('Null');
        const src = (usageMin !== null)
          ? `usage ${usageMin}..${usageMax}`
          : (usages.length ? usages.map((u) => usageName(glob.usagePage, u)).join(', ')
                           : 'no usage');
        out.push(`${pad()}${kind} (${f.join(',')})  ${src}  `
          + `· ${glob.reportCount} × ${glob.reportSize} bit`
          + (glob.reportId ? ` · report ${glob.reportId}` : ''));
        flushLocals();
      }
    } else if (type === 1) {                 // Global
      switch (tag) {
        case 0x0:
          glob.usagePage = val;
          out.push(`${pad()}Usage Page (${USAGE_PAGE_NAMES[val] || '0x' + val.toString(16)})`);
          break;
        case 0x7: glob.reportSize = val; break;
        case 0x8: glob.reportId = val; out.push(`${pad()}Report ID (${val})`); break;
        case 0x9: glob.reportCount = val; break;
        default: break;                      // logical/physical ranges, units
      }
    } else if (type === 2) {                 // Local
      switch (tag) {
        case 0x0: usages.push(val); break;
        case 0x1: usageMin = val; break;
        case 0x2: usageMax = val; break;
        default: break;                      // designators, string indices
      }
    }
  }
  return out;
}

document.getElementById('hidLoad').addEventListener('click', async () => {
  const sum = document.getElementById('hidSummary');
  const dec = document.getElementById('hidDecoded');
  const raw = document.getElementById('hidRaw');
  sum.textContent = 'loading…';
  dec.textContent = '';
  raw.textContent = '';
  try {
    const r = await apiFetch('/hid');
    if (!r.ok) { sum.textContent = `Failed (HTTP ${r.status}).`; return; }

    const d = await r.json();
    // These come from the device, so they are the effective values - not what
    // the form currently says.
    sum.innerHTML = `<b>${d.product}</b> by ${d.manufacturer} · serial <code>${d.serial}</code><br>`
      + `interface “${d.interface}” · endpoint 0x81, ${d.endpoint_size}-byte reports, `
      + `polled every ${d.poll_interval_ms} ms · report descriptor ${d.report_descriptor_len} bytes`;
    raw.textContent = d.report_descriptor_hex;

    const bytes = d.report_descriptor_hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
    dec.textContent = decodeReportDescriptor(bytes).join('\n');
  } catch (_) {
    sum.textContent = 'Failed to load.';
  }
});

// ---------------------------------------------------------------- start
requireAuth(async () => {
  setStatus('loading settings…', 'warn');
  await loadSettings();
  wireForm();
  readIntoForm();
  saveNote.textContent = '';

  // Best-effort: the device's own view of the network, from its logs.
  setStatus('connected', 'on');
});
