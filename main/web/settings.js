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

// ---------------------------------------------------------------- web UI files
// The upload page handles individual files; this is the way back when the
// uploaded page that would do the resetting is itself broken.
document.getElementById('uiOpen').addEventListener('click', () => {
  location.href = 'ui.html';
});

document.getElementById('uiResetAll').addEventListener('click', async () => {
  const note = document.getElementById('uiNote');
  if (!confirm('Delete every uploaded UI file and go back to the built-in copies?')) return;
  note.className = 'note';
  note.textContent = 'resetting…';
  try {
    const r = await apiPost('/ui/reset?all=1');
    if (!r.ok) {
      note.className = 'note warn';
      note.textContent = `Reset failed (HTTP ${r.status}).`;
      return;
    }
    note.textContent = 'Uploaded files deleted; the built-in pages are back.';
  } catch (_) {
    note.className = 'note warn';
    note.textContent = 'Reset failed — the device is unreachable.';
  }
});

// ---------------------------------------------------------------- screen image
// The device has no PNG or JPEG decoder, and this feature must not need one, so
// the page does the whole conversion and posts the packed result: scale to
// 160x80, luminance, 4-bit ordered dither, two pixels per byte, then a small
// header with a CRC. The preview shows the same bytes that get sent - a
// washed-out panel is the risk this feature carries, and seeing the dithered
// result beforehand is the only way to catch it without hardware.
const SCREEN_IMAGE_W = 160;
const SCREEN_IMAGE_H = 80;
const SCREEN_IMAGE_PAYLOAD = SCREEN_IMAGE_W * SCREEN_IMAGE_H / 2;   // 6,400
const SCREEN_IMAGE_HEADER = 8;
const SCREEN_IMAGE_FILE = SCREEN_IMAGE_HEADER + SCREEN_IMAGE_PAYLOAD;
const SCREEN_IMAGE_FORMAT = 0x01;

// Bayer 4x4, 0..15. A flat area between two levels turns into a fine pattern of
// both instead of a hard step, which is what makes a 4-bit ramp look smooth.
const BAYER4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];

// IEEE CRC-32, bitwise so it is visibly the same loop the firmware runs. Kept
// here rather than fetched because the point is that the two agree byte for
// byte on a 6,400-byte payload.
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Rec.601 luma, then an ordered dither down to 16 levels. The Bayer cell adds
// less than one level of offset, so the average over a 4x4 tile still tracks
// the input; exactly on a level (black, white, 3*17) nothing moves at all.
function quantiseGrey4(r, g, b, x, y) {
  const luma = (299 * r + 587 * g + 114 * b) / 1000 / 255;
  const cell = (BAYER4[y & 3][x & 3] + 0.5) / 16;
  return Math.floor(luma * 15 + cell);
}

// ImageData at exactly 160x80 -> the file the device stores: header, then 80
// rows of 80 bytes, high nibble is the left pixel.
function packScreenImage(imageData) {
  if (imageData.width !== SCREEN_IMAGE_W || imageData.height !== SCREEN_IMAGE_H) {
    throw new Error(`expected ${SCREEN_IMAGE_W}x${SCREEN_IMAGE_H}, ` +
                    `got ${imageData.width}x${imageData.height}`);
  }

  const px = imageData.data;
  const out = new Uint8Array(SCREEN_IMAGE_FILE);
  out[0] = SCREEN_IMAGE_FORMAT;
  out[1] = 0;
  out[2] = SCREEN_IMAGE_PAYLOAD & 0xFF;
  out[3] = (SCREEN_IMAGE_PAYLOAD >> 8) & 0xFF;

  for (let y = 0; y < SCREEN_IMAGE_H; y++) {
    for (let x = 0; x < SCREEN_IMAGE_W; x += 2) {
      const i = (y * SCREEN_IMAGE_W + x) * 4;
      const hi = quantiseGrey4(px[i], px[i + 1], px[i + 2], x, y);
      const lo = quantiseGrey4(px[i + 4], px[i + 5], px[i + 6], x + 1, y);
      out[SCREEN_IMAGE_HEADER + (y * SCREEN_IMAGE_W + x) / 2] = (hi << 4) | lo;
    }
  }

  const crc = crc32(out.subarray(SCREEN_IMAGE_HEADER));
  out[4] = crc & 0xFF;
  out[5] = (crc >> 8) & 0xFF;
  out[6] = (crc >> 16) & 0xFF;
  out[7] = (crc >>> 24) & 0xFF;
  return out;
}

// The same checks the firmware makes before it will draw: exact size, format
// byte, length field and a CRC that matches. Applied to what comes back from
// the device too, so a truncated file is noticed rather than shown.
function screenImageValid(bytes) {
  if (!bytes || bytes.length !== SCREEN_IMAGE_FILE) return false;
  if (bytes[0] !== SCREEN_IMAGE_FORMAT || bytes[1] !== 0) return false;
  if ((bytes[2] | (bytes[3] << 8)) !== SCREEN_IMAGE_PAYLOAD) return false;
  const want = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) |
                (bytes[7] << 24)) >>> 0;
  return crc32(bytes.subarray(SCREEN_IMAGE_HEADER)) === want;
}

// Expand packed nibbles back to pixels. Level i is i*17, which is the ramp the
// firmware's RGB565 table is built from, so this is what the panel will show
// (modulo the panel's own colour response, which is the part only hardware can
// settle).
function renderScreenImage(canvas, bytes) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SCREEN_IMAGE_W, SCREEN_IMAGE_H);
  for (let y = 0; y < SCREEN_IMAGE_H; y++) {
    for (let x = 0; x < SCREEN_IMAGE_W; x += 2) {
      const b = bytes[SCREEN_IMAGE_HEADER + (y * SCREEN_IMAGE_W + x) / 2];
      const hi = b >> 4, lo = b & 0x0F;
      for (let dx = 0; dx < 2; dx++) {
        const v = (dx ? lo : hi) * 17;
        const i = (y * SCREEN_IMAGE_W + x + dx) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Scale whatever was picked to the panel, filling it and cropping the excess:
// the panel is 4:2 and a portrait photo would otherwise be squashed.
async function imageFileToCanvas(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = SCREEN_IMAGE_W;
  canvas.height = SCREEN_IMAGE_H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SCREEN_IMAGE_W, SCREEN_IMAGE_H);

  const scale = Math.max(SCREEN_IMAGE_W / bitmap.width, SCREEN_IMAGE_H / bitmap.height);
  const w = bitmap.width * scale, h = bitmap.height * scale;
  ctx.drawImage(bitmap, (SCREEN_IMAGE_W - w) / 2, (SCREEN_IMAGE_H - h) / 2, w, h);
  bitmap.close();
  return canvas;
}

const screenImagePreview = document.getElementById('screenImagePreview');
const screenImageNote = document.getElementById('screenImageNote');
let screenImageBytes = null;    // the packed file waiting to be sent, or last sent

function setScreenImageNote(text, warn) {
  screenImageNote.className = 'note' + (warn ? ' warn' : '');
  screenImageNote.textContent = text;
}

// What the device holds, fetched rather than assumed: this is the only view of
// the screen that survives a reload, and it is what the tap cycle will find.
async function loadDeviceScreenImage() {
  try {
    const r = await apiFetch('/screen/image');
    if (r.status === 404) {
      document.getElementById('screenImageClear').hidden = true;
      setScreenImageNote('No image on the device, so this screen stays out of ' +
        'the BOOT cycle.');
      return;
    }
    if (!r.ok) {
      setScreenImageNote(`Could not read the stored image (HTTP ${r.status}).`, true);
      return;
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!screenImageValid(bytes)) {
      // The device only serves a file it validated, so this should not happen;
      // saying so beats drawing something that may be wrong.
      setScreenImageNote('The device returned an image that does not check out.', true);
      return;
    }
    renderScreenImage(screenImagePreview, bytes);
    document.getElementById('screenImageClear').hidden = false;
    setScreenImageNote('An image is stored on the device; it shows as the ' +
      'fourth BOOT screen.');
  } catch (_) {
    setScreenImageNote('Could not reach the device to check for an image.', true);
  }
}

document.getElementById('screenImagePick').addEventListener('click', () => {
  document.getElementById('screenImageFile').click();
});

document.getElementById('screenImageFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';          // so the same file can be chosen twice in a row
  if (!file) return;

  const send = document.getElementById('screenImageSend');
  try {
    const canvas = await imageFileToCanvas(file);
    const data = canvas.getContext('2d')
      .getImageData(0, 0, SCREEN_IMAGE_W, SCREEN_IMAGE_H);
    screenImageBytes = packScreenImage(data);
  } catch (_) {
    screenImageBytes = null;
    send.disabled = true;
    setScreenImageNote('That file could not be read as an image.', true);
    return;
  }

  renderScreenImage(screenImagePreview, screenImageBytes);
  send.disabled = false;
  setScreenImageNote(`Ready to send ${SCREEN_IMAGE_FILE} bytes — the dithered ` +
    '160×80 copy above is exactly what the device will draw.');
});

document.getElementById('screenImageSend').addEventListener('click', async () => {
  if (!screenImageBytes) return;
  const send = document.getElementById('screenImageSend');
  send.disabled = true;
  setScreenImageNote('sending…');
  try {
    const r = await apiFetch('/screen/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: screenImageBytes,
    });
    if (!r.ok) {
      let why = '';
      try { why = (await r.text()).trim(); } catch (_) { /* body may be gone */ }
      setScreenImageNote(`The device refused the image (HTTP ${r.status})` +
        (why ? `: ${why}` : '') + '. Nothing changed.', true);
      return;
    }
    document.getElementById('screenImageClear').hidden = false;
    setScreenImageNote('Stored on the device; it is now the fourth BOOT screen.');
  } catch (_) {
    setScreenImageNote('The upload was cut off — the previous image is still ' +
      'stored. Try again.', true);
  } finally {
    send.disabled = false;
  }
});

document.getElementById('screenImageClear').addEventListener('click', async () => {
  if (!confirm('Remove the stored image and take this screen out of the BOOT cycle?')) return;
  setScreenImageNote('removing…');
  try {
    const r = await apiPost('/screen/reset');
    if (!r.ok) {
      setScreenImageNote(`Removing it failed (HTTP ${r.status}).`, true);
      return;
    }
    screenImageBytes = null;
    document.getElementById('screenImageSend').disabled = true;
    document.getElementById('screenImageClear').hidden = true;
    screenImagePreview.getContext('2d')
      .clearRect(0, 0, SCREEN_IMAGE_W, SCREEN_IMAGE_H);
    setScreenImageNote('Removed; this screen stays out of the BOOT cycle.');
  } catch (_) {
    setScreenImageNote('Removing it failed — the device is unreachable.', true);
  }
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

// ---------------------------------------------------------------- backup
// Two stores, one file. Settings live on the device; macros live in this
// browser. A backup that covered only one of them would be a trap - the whole
// point of exporting macros is that they do not travel on their own.
const BACKUP_VERSION = 1;
const MACRO_STORE_KEY = 'esp32remote.macros';

function setBackupNote(text, warn) {
  const el = document.getElementById('backupNote');
  el.className = 'note' + (warn ? ' warn' : '');
  el.textContent = text || '';
}

function readStoredMacros() {
  try {
    const raw = JSON.parse(localStorage.getItem(MACRO_STORE_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    // An unreadable store exports without macros rather than failing outright.
    return [];
  }
}

function collectBackup() {
  const device = Object.assign({}, appSettings);
  delete device.macros;        // a legacy device key; macros are browser-side now

  return {
    app: 'esp32-remote',
    version: BACKUP_VERSION,
    exported: new Date().toISOString(),
    device,
    macros: readStoredMacros(),
  };
}

function backupSummary(b) {
  const n = Object.keys(b.device || {}).length;
  const m = (b.macros || []).length;
  return `${n} device setting${n === 1 ? '' : 's'} and ${m} macro${m === 1 ? '' : 's'}`;
}

document.getElementById('backupSave').addEventListener('click', () => {
  const b = collectBackup();
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `esp32-remote-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setBackupNote(`Downloaded ${backupSummary(b)}.`);
});

document.getElementById('backupLoad').addEventListener('click', () => {
  document.getElementById('backupFile').click();
});

document.getElementById('backupFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';         // so the same file can be chosen twice in a row
  if (!file) return;

  let b;
  try {
    b = JSON.parse(await file.text());
  } catch (_) {
    setBackupNote('That file is not readable as JSON.', true);
    return;
  }
  if (!b || b.app !== 'esp32-remote' || b.version !== BACKUP_VERSION) {
    setBackupNote('Not a backup from this project, or from a version this page does ' +
                  'not understand. Nothing was changed.', true);
    return;
  }

  // The device first. If it refuses, the browser's macros are left alone and the
  // message says which half did not apply rather than implying both did.
  let devicePart = 'no device settings in the file';
  if (b.device && typeof b.device === 'object') {
    const incoming = Object.assign({}, b.device);
    delete incoming.macros;
    Object.assign(appSettings, incoming);
    try {
      const r = await saveSettingsToDevice();
      devicePart = r.ok ? 'device settings restored'
                        : `the device refused the settings (HTTP ${r.status})`;
    } catch (_) {
      devicePart = 'the device could not be reached, so its settings were not restored';
    }
  }

  let macroPart = 'no macros in the file';
  const macros = Array.isArray(b.macros) ? b.macros : [];
  if (macros.length) {
    try {
      localStorage.setItem(MACRO_STORE_KEY, JSON.stringify(macros));
      macroPart = `${macros.length} macro${macros.length === 1 ? '' : 's'} restored`;
    } catch (_) {
      macroPart = 'the macros could not be stored (private mode?)';
    }
  }

  readIntoForm();
  const failed = !devicePart.startsWith('device settings restored');
  const reloadHint = (devicePart.startsWith('device settings restored') && macros.length)
    ? ' Reload the Macros page to see them.' : '';
  setBackupNote(`${devicePart}; ${macroPart}.${reloadHint}`, failed);
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
  await loadDeviceScreenImage();
  saveNote.textContent = '';

  // Best-effort: the device's own view of the network, from its logs.
  setStatus('connected', 'on');
});
