// Settings page: device settings, touchpad tuning, network, diagnostics.
//
// Mounted and unmounted by router.js: refs are assigned and listeners are
// attached in init(), and destroy() flushes an edit that was still waiting for
// its debounce. The handlers are registered through on() below so the wiring
// can sit next to the function it calls without running before the template is
// mounted.


import { apiFetch, apiPost, appSettings, currentBase, forgetCode, hostLayout, hostLayoutId, isDeviceOrigin, saveSettingsToDevice, setHostLayout, setLocal } from './common.js';
import * as Pages from './pages.js';

export const SettingsView = (() => {

let dot = null;
let statusText = null;
let saveNote = null;

// [id, event, handler, options] attached to the mounted template in init().
const wired = [];
function on(id, type, handler, options) {
  wired.push([id, type, handler, options]);
}

function setStatus(text, cls) {
  if (!statusText || !dot) return;   // an answer that arrived after unmount
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
  // logrange: the useful span is about two and a half decades. A 3200 DPI
  // gaming mouse needs roughly 0.02 and a low-resolution one roughly 1, so a
  // linear slider would put everything useful in the first few percent of the
  // track. The slider carries log10(value) * 100 instead.
  { id: 'mouseGain',    key: 'mouse_gain',    kind: 'logrange', suffix: 'x', dp: 2 },
  { id: 'scrollScale',  key: 'scroll_scale',  kind: 'logrange', suffix: 'x', dp: 2 },
  { id: 'scrollInvert', key: 'scroll_invert', kind: 'bool' },
  { id: 'tapClick',     key: 'tap_click',     kind: 'bool' },
  { id: 'tapMaxMs',     key: 'tap_max_ms',    kind: 'range', suffix: ' ms', dp: 0 },
  { id: 'typeSpeed',    key: 'type_speed',    kind: 'range', suffix: ' chars/s', dp: 0 },
];

function labelFor(b, value) {
  if (b.key === 'screen_timeout_s' && Number(value) === 0) return 'never';
  return Number(value).toFixed(b.dp) + (b.suffix || '');
}

// A logrange control stores log10(value) * 100, so one step is a 2.3% change
// anywhere on the track rather than a different amount at each end.
const isSlider = (b) => b.kind === 'range' || b.kind === 'logrange';
const sliderToValue = (b, raw) =>
  b.kind === 'logrange' ? Math.pow(10, Number(raw) / 100) : Number(raw);
const valueToSlider = (b, v) =>
  b.kind === 'logrange' ? Math.round(Math.log10(Math.max(1e-4, Number(v))) * 100) : v;

function readIntoForm() {
  for (const b of BINDINGS) {
    const el = document.getElementById(b.id);
    const val = appSettings[b.key];
    if (b.kind === 'bool') el.checked = val !== false;
    else el.value = valueToSlider(b, val);
    if (isSlider(b)) {
      const out = document.getElementById(b.id + 'Val');
      if (out) out.textContent = labelFor(b, sliderToValue(b, el.value));
    }
  }
}

function wireForm() {
  for (const b of BINDINGS) {
    const el = document.getElementById(b.id);
    const handler = () => {
      let v;
      if (b.kind === 'bool') v = el.checked;
      else if (isSlider(b)) v = sliderToValue(b, el.value);
      else v = el.value;
      setLocal(b.key, v);
      if (isSlider(b)) {
        const out = document.getElementById(b.id + 'Val');
        if (out) out.textContent = labelFor(b, sliderToValue(b, el.value));
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
  // The view can be unmounted while the request is in flight (the post still
  // has to finish), so keep a local handle and never assume saveNote is live.
  const note = saveNote;
  if (note) note.textContent = 'saving…';
  try {
    const r = await saveSettingsToDevice();
    if (note) note.textContent = r.ok ? 'saved to device' : `save failed (HTTP ${r.status})`;
    return r.ok;
  } catch (_) {
    if (note) note.textContent = 'save failed — device unreachable';
    return false;
  }
}

function scheduleSave() {
  saveNote.textContent = 'saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 700);
}

on('save', 'click', doSave);

on('restart', 'click', async () => {
  if (!confirm('Restart the device?\n\nSettings will be saved first. ' +
               'It will be unreachable for a few seconds.')) return;
  const ok = await doSave();
  if (!ok) { alert('Could not save settings — restarting anyway.'); }
  try { await apiPost('/restart'); } catch (_) {}
  setStatus('restarting…', 'warn');
  setTimeout(() => location.reload(), 6000);
});

on('forgetCode', 'click', () => {
  forgetCode();
  alert('Saved code forgotten. You will be asked for it again.');
});

// ---------------------------------------------------------------- network
// The network section used to say "unknown" for ever: the value was a
// placeholder in the markup and nothing ever filled it. The device is the only
// thing that knows.
let lastNetwork = null;
let pendingForget = '';

function netNote(text, warn) {
  const note = document.getElementById('wifiNote');
  if (!note) return;
  note.textContent = text;
  note.classList.toggle('warn', !!warn);
}

function wifiBadge(text, cls) {
  const b = document.createElement('span');
  b.className = 'wifiBadge ' + cls;
  b.textContent = text;
  return b;
}

function renderNetState(d) {
  const out = document.getElementById('netState');
  if (!out) return;
  if (d.state === 'joined') {
    out.textContent = `Joined “${d.ssid || '(unknown)'}” · ${d.ip || 'no address'}`;
  } else if (d.state === 'connecting') {
    const trying = d.connecting || d.ssid || '';
    out.textContent = trying ? `Connecting to “${trying}”…`
                             : 'Connecting to a saved network…';
  } else {
    const n = Number(d.clients) || 0;
    out.textContent = `Access point · ${d.ap_ip || 'no address'} · ` +
      `${n} client${n === 1 ? '' : 's'} connected`;
  }
}

function renderSavedNetworks(d) {
  const box = document.getElementById('wifiSaved');
  if (!box) return;
  box.textContent = '';
  const nets = Array.isArray(d && d.saved) ? d.saved : [];
  if (!nets.length) {
    const empty = document.createElement('div');
    empty.className = 'wifiempty';
    empty.textContent = 'No saved networks. Scan below and add one.';
    box.appendChild(empty);
    return;
  }

  const joined = d.active || (d.state === 'joined' ? d.ssid : '');
  nets.forEach((n, i) => {
    const row = document.createElement('div');
    row.className = 'wifirow';
    row.dataset.ssid = n.ssid;

    const top = document.createElement('div');
    top.className = 'wifitop';
    const name = document.createElement('span');
    name.className = 'wifiname';
    name.textContent = n.ssid || '(hidden)';
    top.appendChild(name);
    if (n.hidden) top.appendChild(wifiBadge('hidden', 'wifiMuted'));
    if (n.secure) top.appendChild(wifiBadge('🔒', 'wifiMuted'));
    if (n.ssid === joined) top.appendChild(wifiBadge('active', 'wifiActive'));
    if (n.last) top.appendChild(wifiBadge('last good', 'wifiLast'));

    const acts = document.createElement('div');
    acts.className = 'wifiActs';
    const move = (delta, label, glyph) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wifiMove';
      b.dataset.move = delta < 0 ? 'up' : 'down';
      b.textContent = glyph;
      b.setAttribute('aria-label', label);
      b.disabled = delta < 0 ? i === 0 : i === nets.length - 1;
      b.addEventListener('click', () => moveSaved(i, delta));
      return b;
    };
    const use = document.createElement('button');
    use.type = 'button';
    use.dataset.act = 'use';
    use.textContent = 'Use now';
    use.disabled = n.ssid === joined;
    use.addEventListener('click', () => useSaved(n.ssid));

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'danger';
    forget.dataset.act = 'forget';
    forget.textContent = pendingForget === n.ssid ? 'Forget?' : 'Forget';
    forget.addEventListener('click', () => forgetSaved(n.ssid, forget));

    acts.append(move(-1, `Move ${n.ssid} up`, 'Up'),
               move(1, `Move ${n.ssid} down`, 'Down'), use, forget);
    row.append(top, acts);
    box.appendChild(row);
  });
}

async function refreshNetwork() {
  const out = document.getElementById('netState');
  if (!out) return;
  try {
    const r = await apiFetch('/network');
    if (!r.ok) {
      out.textContent = `Could not read the network state (HTTP ${r.status}).`;
      return;
    }
    const d = await r.json();
    lastNetwork = d;
    renderNetState(d);
    renderSavedNetworks(d);
  } catch (_) {
    out.textContent = 'The device is unreachable.';
  }
}

async function moveSaved(index, delta) {
  if (!lastNetwork || !Array.isArray(lastNetwork.saved)) return;
  const to = index + delta;
  if (to < 0 || to >= lastNetwork.saved.length) return;
  const order = lastNetwork.saved.map((n) => n.ssid);
  const tmp = order[index];
  order[index] = order[to];
  order[to] = tmp;

  // Show the new order immediately. The device is the authority, so refresh
  // afterwards and put the old order back if the request was refused.
  const bySsid = new Map(lastNetwork.saved.map((n) => [n.ssid, n]));
  lastNetwork.saved = order.map((ssid) => bySsid.get(ssid));
  renderSavedNetworks(lastNetwork);

  netNote('saving order…');
  try {
    const r = await apiPost('/wifi/order', { order });
    if (!r.ok) {
      netNote(`Could not save the order (HTTP ${r.status}).`, true);
      await refreshNetwork();
      return;
    }
    netNote('Order saved. It is used the next time the device connects.');
  } catch (_) {
    netNote('Could not save the order — the device is unreachable.', true);
  }
  await refreshNetwork();
}

async function useSaved(ssid) {
  netNote(`Connecting to “${ssid}”…`);
  try {
    const r = await apiPost('/wifi/connect', { ssid });
    if (!r.ok) {
      netNote(`Could not start a connection (HTTP ${r.status}).`, true);
      return;
    }
  } catch (_) {
    netNote('Could not start a connection — the device is unreachable.', true);
    return;
  }
  await refreshNetwork();
}

// Two taps in the row, like deleting a page: a phone dialog is easy to miss and
// harder to hit than the button under the thumb.
async function forgetSaved(ssid, button) {
  if (pendingForget !== ssid) {
    pendingForget = ssid;
    renderSavedNetworks(lastNetwork);
    netNote(`Tap Forget again to remove “${ssid}” from this device.`, true);
    return;
  }

  pendingForget = '';
  netNote(`Removing “${ssid}”…`);
  try {
    const r = await apiPost('/wifi/forget', { ssid });
    if (!r.ok) {
      netNote(`Could not forget “${ssid}” (HTTP ${r.status}).`, true);
      await refreshNetwork();
      return;
    }
    netNote(`Removed “${ssid}”.`);
  } catch (_) {
    netNote('Could not forget it — the device is unreachable.', true);
    button.textContent = 'Forget';
    return;
  }
  await refreshNetwork();
}

on('wifiScan', 'click', async () => {
  const list = document.getElementById('wifiList');
  list.textContent = 'scanning…';
  try {
    const r = await apiFetch('/scan');
    if (!r.ok) { list.textContent = `Scan failed (HTTP ${r.status}).`; return; }

    const data = await r.json();
    const nets = (data.networks || []).slice().sort((a, b) => b.rssi - a.rssi);
    list.textContent = '';
    if (!nets.length) { list.textContent = 'No networks found.'; return; }

    for (const n of nets) {
      const el = document.createElement('div');
      el.className = 'item';
      const name = document.createElement('span');
      name.textContent = n.ssid || '(hidden)';
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.textContent = `${n.rssi} dBm${n.secure ? ' 🔒' : ''}` +
        (n.saved ? ' · Saved' : '');
      el.append(name, bar);
      el.addEventListener('click', () => {
        document.getElementById('wifiSsid').value = n.ssid || '';
        document.getElementById('wifiPass').focus();
        const hidden = document.getElementById('wifiHidden');
        if (hidden) hidden.checked = false;
        list.querySelectorAll('.item').forEach((i) => i.classList.remove('selected'));
        el.classList.add('selected');
      });
      list.appendChild(el);
    }
  } catch (_) {
    list.textContent = 'Scan failed.';
  }
});

on('wifiSave', 'click', async () => {
  const ssid = document.getElementById('wifiSsid').value.trim();
  const pass = document.getElementById('wifiPass').value;
  const hidden = document.getElementById('wifiHidden').checked;
  if (!ssid) { netNote('Enter a network name first.', true); return; }

  netNote(`Saving “${ssid}”…`);
  try {
    const r = await apiPost('/wifi/save', { ssid, pass, hidden });
    if (!r.ok) {
      netNote(`Could not add “${ssid}” (HTTP ${r.status}).`, true);
      return;
    }
    netNote(`Added “${ssid}”. A joined network is kept until it is chosen or the device reconnects.`);
    document.getElementById('wifiPass').value = '';
  } catch (_) {
    netNote('Could not add it — the device is unreachable.', true);
    return;
  }
  await refreshNetwork();
});

// ---------------------------------------------------------------- web UI files
// The upload view handles individual files; this button is the sledgehammer
// for when a stored view script has broken the page that would reset it.
on('uiOpen', 'click', () => {
  location.hash = '#/ui';
});

on('uiResetAll', 'click', async () => {
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
// 160x80, quantise with an ordered dither, pack, then a small header with a
// CRC. Two formats share that header - 4-bit greyscale (6,400 payload bytes)
// and RGB565 colour (25,600) - and the format byte says which. The preview
// shows the packed result rather than the original: a washed-out panel is the
// risk this feature carries, and seeing the dithered copy beforehand is the
// only way to catch it without hardware.
const SCREEN_IMAGE_W = 160;
const SCREEN_IMAGE_H = 80;
const SCREEN_IMAGE_HEADER = 8;
const SCREEN_IMAGE_FORMAT_GREY4 = 0x01;
const SCREEN_IMAGE_FORMAT_RGB565 = 0x02;
const SCREEN_IMAGE_PAYLOAD = {
  [SCREEN_IMAGE_FORMAT_GREY4]: SCREEN_IMAGE_W * SCREEN_IMAGE_H / 2,   // 6,400
  [SCREEN_IMAGE_FORMAT_RGB565]: SCREEN_IMAGE_W * SCREEN_IMAGE_H * 2,  // 25,600
};

// Bayer 4x4, 0..15. A flat area between two levels turns into a fine pattern of
// both instead of a hard step, which is what makes a quantised ramp look
// smooth.
const BAYER4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];

// One pixel's offset within its quantisation step, 0..1, averaging 0.5 over a
// 4x4 tile so a dithered region tracks its input rather than shifting it.
function bayerCell(x, y) {
  return (BAYER4[y & 3][x & 3] + 0.5) / 16;
}

// IEEE CRC-32, bitwise so it is visibly the same loop the firmware runs. Kept
// here rather than fetched because the point is that the two agree byte for
// byte on the payload, whichever format it carries.
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
  return Math.floor(luma * 15 + bayerCell(x, y));
}

// The same dither, applied to each channel on its own: 5 bits red, 6 green,
// 5 blue, packed into one RGB565 word. Quantising a photo to those bands
// without the dither bands as badly as 16 grey levels would.
function quantiseRgb565(r, g, b, x, y) {
  const cell = bayerCell(x, y);
  const r5 = Math.floor((r / 255) * 31 + cell);
  const g6 = Math.floor((g / 255) * 63 + cell);
  const b5 = Math.floor((b / 255) * 31 + cell);
  return (r5 << 11) | (g6 << 5) | b5;
}

// ImageData at exactly 160x80 -> the file the device stores: the 8-byte header,
// then the payload in the chosen format. Greyscale is two pixels a byte, high
// nibble first; colour is two little-endian bytes a pixel, row after row.
function packScreenImage(imageData, format = SCREEN_IMAGE_FORMAT_GREY4) {
  if (imageData.width !== SCREEN_IMAGE_W || imageData.height !== SCREEN_IMAGE_H) {
    throw new Error(`expected ${SCREEN_IMAGE_W}x${SCREEN_IMAGE_H}, ` +
                    `got ${imageData.width}x${imageData.height}`);
  }
  const payload = SCREEN_IMAGE_PAYLOAD[format];
  if (!payload) throw new Error(`unknown screen image format 0x${format.toString(16)}`);

  const px = imageData.data;
  const out = new Uint8Array(SCREEN_IMAGE_HEADER + payload);
  out[0] = format;
  out[1] = 0;
  out[2] = payload & 0xFF;
  out[3] = (payload >> 8) & 0xFF;

  if (format === SCREEN_IMAGE_FORMAT_RGB565) {
    let o = SCREEN_IMAGE_HEADER;
    for (let y = 0; y < SCREEN_IMAGE_H; y++) {
      for (let x = 0; x < SCREEN_IMAGE_W; x++) {
        const i = (y * SCREEN_IMAGE_W + x) * 4;
        const v = quantiseRgb565(px[i], px[i + 1], px[i + 2], x, y);
        out[o++] = v & 0xFF;        // little-endian: low byte first
        out[o++] = v >> 8;
      }
    }
  } else {
    for (let y = 0; y < SCREEN_IMAGE_H; y++) {
      for (let x = 0; x < SCREEN_IMAGE_W; x += 2) {
        const i = (y * SCREEN_IMAGE_W + x) * 4;
        const hi = quantiseGrey4(px[i], px[i + 1], px[i + 2], x, y);
        const lo = quantiseGrey4(px[i + 4], px[i + 5], px[i + 6], x + 1, y);
        out[SCREEN_IMAGE_HEADER + (y * SCREEN_IMAGE_W + x) / 2] = (hi << 4) | lo;
      }
    }
  }

  const crc = crc32(out.subarray(SCREEN_IMAGE_HEADER));
  out[4] = crc & 0xFF;
  out[5] = (crc >> 8) & 0xFF;
  out[6] = (crc >> 16) & 0xFF;
  out[7] = (crc >>> 24) & 0xFF;
  return out;
}

// The same checks the firmware makes before it will draw: the format byte
// picks the payload size, and the exact file size, the length field and a CRC
// that matches all have to agree with it. Applied to what comes back from the
// device too, so a truncated or mismatched file is noticed rather than shown.
function screenImageValid(bytes) {
  if (!bytes || bytes.length < SCREEN_IMAGE_HEADER) return false;
  const payload = SCREEN_IMAGE_PAYLOAD[bytes[0]];
  if (!payload || bytes.length !== SCREEN_IMAGE_HEADER + payload) return false;
  if (bytes[1] !== 0) return false;
  if ((bytes[2] | (bytes[3] << 8)) !== payload) return false;
  const want = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) |
                (bytes[7] << 24)) >>> 0;
  return crc32(bytes.subarray(SCREEN_IMAGE_HEADER)) === want;
}

// Expand packed pixels back to 8-bit for the canvas. Greyscale level i is i*17,
// the ramp the firmware's RGB565 table is built from; each colour channel is
// bit-replicated to 8 bits. This is the browser's rendering of the bytes, not
// the panel's rendition of them.
function renderScreenImage(canvas, bytes) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SCREEN_IMAGE_W, SCREEN_IMAGE_H);
  if (bytes[0] === SCREEN_IMAGE_FORMAT_RGB565) {
    for (let i = 0; i < SCREEN_IMAGE_W * SCREEN_IMAGE_H; i++) {
      const o = SCREEN_IMAGE_HEADER + i * 2;
      const v = bytes[o] | (bytes[o + 1] << 8);
      const r5 = (v >> 11) & 0x1F, g6 = (v >> 5) & 0x3F, b5 = v & 0x1F;
      const p = i * 4;
      img.data[p]     = (r5 << 3) | (r5 >> 2);
      img.data[p + 1] = (g6 << 2) | (g6 >> 4);
      img.data[p + 2] = (b5 << 3) | (b5 >> 2);
      img.data[p + 3] = 255;
    }
  } else {
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

let screenImagePreview = null;
let screenImageNote = null;
let screenImageBytes = null;    // the packed file waiting to be sent, or last sent
let screenImageSource = null;   // the scaled 160x80 original, to re-pack on a format change

function setScreenImageNote(text, warn) {
  if (!screenImageNote) return;
  screenImageNote.className = 'note' + (warn ? ' warn' : '');
  screenImageNote.textContent = text;
}

// The picker's own state, not a device setting: it decides how this browser
// packs the picture, and nothing about it reaches the settings blob.
function selectedScreenImageFormat() {
  const el = document.querySelector('input[name="screenImageFormat"]:checked');
  return el && el.value === 'grey' ? SCREEN_IMAGE_FORMAT_GREY4
                                   : SCREEN_IMAGE_FORMAT_RGB565;
}

// Pack whatever was picked, in the selected format, and show it. Re-packing
// from the scaled original rather than from the preview: the preview is already
// quantised, and quantising it again would compound the loss.
function repackScreenImage() {
  if (!screenImageSource) return;
  screenImageBytes = packScreenImage(screenImageSource, selectedScreenImageFormat());
  renderScreenImage(screenImagePreview, screenImageBytes);
  document.getElementById('screenImageSend').disabled = false;

  const colour = screenImageBytes[0] === SCREEN_IMAGE_FORMAT_RGB565;
  setScreenImageNote(`Ready to send ${screenImageBytes.length} bytes of ` +
    (colour ? 'RGB565 colour' : '4-bit greyscale') + ' — the dithered 160×80 ' +
    'copy above is exactly what the device will draw.');
}

function wireScreenImageFormats() {
  for (const el of document.querySelectorAll('input[name="screenImageFormat"]')) {
    el.addEventListener('change', repackScreenImage);
  }
}

// What the device holds, fetched rather than assumed: this is the only view of
// the screen that survives a reload, and it is what the tap cycle will find.
async function loadDeviceScreenImage() {
  try {
    const r = await apiFetch('/screen/image');
    if (!screenImagePreview) return;   // unmounted while the request was in flight
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
    if (!screenImagePreview) return;
    if (!screenImageValid(bytes)) {
      // The device only serves a file it validated, so this should not happen;
      // saying so beats drawing something that may be wrong.
      setScreenImageNote('The device returned an image that does not check out.', true);
      return;
    }
    renderScreenImage(screenImagePreview, bytes);
    document.getElementById('screenImageClear').hidden = false;
    const what = bytes[0] === SCREEN_IMAGE_FORMAT_RGB565
      ? 'RGB565 colour' : '4-bit greyscale';
    setScreenImageNote(`An image is stored on the device (${what}, ` +
      `${bytes.length} bytes); it shows as the fourth BOOT screen.`);
  } catch (_) {
    setScreenImageNote('Could not reach the device to check for an image.', true);
  }
}

on('screenImagePick', 'click', () => {
  document.getElementById('screenImageFile').click();
});

on('screenImageFile', 'change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';          // so the same file can be chosen twice in a row
  if (!file) return;

  try {
    const canvas = await imageFileToCanvas(file);
    if (!screenImagePreview) return;   // unmounted while the image decoded
    screenImageSource = canvas.getContext('2d')
      .getImageData(0, 0, SCREEN_IMAGE_W, SCREEN_IMAGE_H);
  } catch (_) {
    screenImageSource = null;
    screenImageBytes = null;
    document.getElementById('screenImageSend').disabled = true;
    setScreenImageNote('That file could not be read as an image.', true);
    return;
  }

  repackScreenImage();
});

on('screenImageSend', 'click', async () => {
  if (!screenImageBytes) return;
  const send = document.getElementById('screenImageSend');
  if (!send) return;
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
    const clear = document.getElementById('screenImageClear');
    if (clear) clear.hidden = false;
    setScreenImageNote('Stored on the device; it is now the fourth BOOT screen.');
  } catch (_) {
    setScreenImageNote('The upload was cut off — the previous image is still ' +
      'stored. Try again.', true);
  } finally {
    send.disabled = false;        // harmless if the element is detached
  }
});

on('screenImageClear', 'click', async () => {
  if (!confirm('Remove the stored image and take this screen out of the BOOT cycle?')) return;
  setScreenImageNote('removing…');
  try {
    const r = await apiPost('/screen/reset');
    if (!r.ok) {
      setScreenImageNote(`Removing it failed (HTTP ${r.status}).`, true);
      return;
    }
    screenImageBytes = null;
    screenImageSource = null;
    if (!screenImagePreview) return;   // unmounted while the request was in flight
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
on('logsLoad', 'click', async () => {
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

// ---------------------------------------------------------------- key probe
// Deliberately dumb: it records what the browser delivers, not what we hope it
// delivers. The answer differs by IME and by Android version, so this is worth
// measuring on the actual phone rather than reasoning about.
//
// What each line means:
//   key="c" code="KeyC" kc=67 ctrl loc=0   what the event claims
//   →0x06                                  the HID usage our KEY map would
//                                          send for that code, or absent when
//                                          nothing maps
const PROBE_MAX_LINES = 50;
const PROBE_EVENTS = ['keydown', 'keyup', 'beforeinput', 'input',
                      'compositionstart', 'compositionend'];

let probeField = null;
let probeLog = null;
let probeStatsEl = null;
let probeSeen = 0;
let probeTally = { down: 0, up: 0, input: 0 };
let probeStart = 0;

const probeQuote = (v) => JSON.stringify(String(v));

// Short labels, because the whole line has to survive a 390px phone. The
// colour carries the type, so the word does not have to be long.
// Namespaced class names: a bare `k` is the virtual-keyboard key elsewhere in
// this stylesheet, and it cost an afternoon to find that out.
const PROBE_LABELS = {
  keydown: ['down', 'probe-key'],
  keyup: ['up', 'probe-key'],
  beforeinput: ['before', 'probe-input'],
  input: ['input', 'probe-input'],
  compositionstart: ['comp', 'probe-comp'],
  compositionend: ['comp-end', 'probe-comp'],
};

// The usage the pad's translator would emit for a DOM code, if any. PadView is
// a classic script loaded by the shell, so it exists here even though the
// control view is not mounted.
function probeUsage(code) {
  if (typeof PadView === 'undefined' || !PadView.KEY) return '';
  const usage = PadView.KEY[code];
  if (usage === undefined) return '';
  return '  →0x' + usage.toString(16).toUpperCase().padStart(2, '0');
}

function probeStats() {
  if (!probeStatsEl) return;
  const vv = window.visualViewport;
  const inset = vv ? Math.max(0, Math.round(window.innerHeight - vv.height)) : 0;
  probeStatsEl.textContent =
    `${probeSeen} events · ${probeTally.down} keydown, ${probeTally.input} input` +
    ` · keyboard inset ≈ ${inset}px (window ${window.innerHeight}` +
    `, visual ${vv ? Math.round(vv.height) : '—'})`;
}

// Two columns rather than one line: the timestamp and the event type stay put
// and the detail wraps underneath itself instead of running off the edge.
function probeAdd(kind, detail) {
  if (!probeLog) return;
  const [label, cls] = PROBE_LABELS[kind] || [kind, 'x'];
  const line = document.createElement('div');
  line.className = 'probe-line';

  const head = document.createElement('span');
  head.className = 'h ' + cls;
  head.textContent = `${label} +${Math.round(performance.now() - probeStart)}ms`;

  const body = document.createElement('span');
  body.className = 'd';
  body.textContent = detail;

  line.append(head, body);
  // Newest first: on a phone, scrolling a growing log is worse than reading
  // the last line at the top.
  probeLog.prepend(line);
  while (probeLog.childElementCount > PROBE_MAX_LINES) {
    probeLog.lastElementChild.remove();
  }
  probeSeen++;
  probeStats();
}

function probeRecord(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');

  let detail;
  if (e.type === 'keydown' || e.type === 'keyup') {
    detail = `key=${probeQuote(e.key)} code=${probeQuote(e.code)} kc=${e.keyCode}` +
      ` loc=${e.location}` +
      (mods.length ? ' ' + mods.join('+') : '') +
      (e.repeat ? ' repeat' : '') +
      (e.isComposing ? ' composing' : '') +
      probeUsage(e.code);
    if (e.type === 'keydown') probeTally.down++;
    else probeTally.up++;
  } else {
    detail = (e.inputType ? `type=${e.inputType} ` : '') +
      (e.data === null || e.data === undefined
        ? 'data=none'
        : `data=${probeQuote(e.data)}`) +
      (e.isComposing ? ' composing' : '');
    if (e.type === 'input') probeTally.input++;
  }
  probeAdd(e.type, detail);
}

function probeViewport() {
  probeStats();
}

function probeClear() {
  if (probeLog) probeLog.textContent = '';
  if (probeField) probeField.value = '';
  probeSeen = 0;
  probeTally = { down: 0, up: 0, input: 0 };
  probeStart = performance.now();
  probeStats();
}

function probeSelectAll() {
  if (!probeLog) return;
  const range = document.createRange();
  range.selectNodeContents(probeLog);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function probeAttach() {
  probeField = document.getElementById('probeField');
  probeLog = document.getElementById('probeLog');
  probeStatsEl = document.getElementById('probeStats');
  if (!probeField || !probeLog) return;

  // Capture phase: record the event as the browser delivered it, before
  // anything else in the page can stop it.
  for (const type of PROBE_EVENTS) {
    probeField.addEventListener(type, probeRecord, true);
  }
  // The keyboard opening is the one thing that tells us how much room a docked
  // strip would have, so the inset is measured, not guessed.
  window.visualViewport?.addEventListener('resize', probeViewport);
  window.visualViewport?.addEventListener('scroll', probeViewport);
  probeClear();
}

function probeDetach() {
  if (probeField) {
    for (const type of PROBE_EVENTS) {
      probeField.removeEventListener(type, probeRecord, true);
    }
  }
  window.visualViewport?.removeEventListener('resize', probeViewport);
  window.visualViewport?.removeEventListener('scroll', probeViewport);
  probeField = null;
  probeLog = null;
  probeStatsEl = null;
}

on('probeClear', 'click', probeClear);
on('probeSelect', 'click', probeSelectAll);

// ---------------------------------------------------------------- backup
// Two stores, one file. Settings live on the device; pages live in this
// browser. A backup that covered only one of them would be a trap - the whole
// point of exporting pages is that they do not travel on their own.
const BACKUP_VERSION = 1;

function setBackupNote(text, warn) {
  const el = document.getElementById('backupNote');
  if (!el) return;
  el.className = 'note' + (warn ? ' warn' : '');
  el.textContent = text || '';
}

function collectBackup() {
  const device = Object.assign({}, appSettings);
  delete device.macros;        // a legacy device key; pages are browser-side now

  return {
    app: 'keebling',
    version: BACKUP_VERSION,
    exported: new Date().toISOString(),
    device,
    pages: Pages.readPages(),
    strip: Pages.readStrip(),
  };
}

function backupSummary(b) {
  const n = Object.keys(b.device || {}).length;
  const m = (b.pages || []).length;
  return `${n} device setting${n === 1 ? '' : 's'} and ${m} page${m === 1 ? '' : 's'}`;
}

on('backupSave', 'click', () => {
  const b = collectBackup();
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `keebling-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setBackupNote(`Downloaded ${backupSummary(b)}.`);
});

on('backupLoad', 'click', () => {
  document.getElementById('backupFile').click();
});

on('backupFile', 'change', async (e) => {
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
  if (!b || (b.app !== 'keebling' && b.app !== 'esp32-remote') || b.version !== BACKUP_VERSION) {
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

  let pagePart = 'no pages in the file';
  let restored = 0;
  if (Array.isArray(b.pages) && b.pages.length && !b.pages.every(Pages.validPage)) {
    pagePart = 'the file has a page this build cannot read, so no pages were restored';
  } else if (Array.isArray(b.pages) && b.pages.length) {
    restored = b.pages.length;
    const err = Pages.writePages(b.pages);
    if (err) pagePart = `the pages could not be stored (${err})`;
    else {
      Pages.writeActive(b.pages[0].id);
      if (Array.isArray(b.strip) && b.strip.length) Pages.writeStrip(b.strip);
      pagePart = `${restored} page${restored === 1 ? '' : 's'} restored`;
    }
  } else if (Array.isArray(b.macros) && b.macros.length) {
    // A backup from before the merge carried a flat macro list. It becomes one
    // page, so an old file still restores rather than being refused.
    const converted = Pages.pagesFromLegacyMacros(b.macros);
    const err = Pages.writePages(converted.pages);
    if (err) pagePart = `the pages could not be stored (${err})`;
    else {
      restored = b.macros.length;
      Pages.writeActive(converted.pages[0].id);
      pagePart = `${b.macros.length} macro${b.macros.length === 1 ? '' : 's'} restored as a page`;
    }
  }

  if (!saveNote) return;         // unmounted while the file was being restored
  readIntoForm();
  const failed = !devicePart.startsWith('device settings restored');
  const reloadHint = (devicePart.startsWith('device settings restored') && restored)
    ? ' Reload the Pages page to see them.' : '';
  setBackupNote(`${devicePart}; ${pagePart}.${reloadHint}`, failed);
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

on('hidLoad', 'click', async () => {
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

// ---------------------------------------------------------------- setup index
// The settings page is nine screens in a column. Showing one at a time makes it
// a menu, and the list can carry the current value of each - which is the
// question people actually open settings to answer.
const SETUP_ROWS = [
  { page: 'typing',  group: 'Everyday',    label: 'Typing',
    value: () => hostLayout().name },
  { page: 'pointer', group: 'Everyday',    label: 'Pointer & scroll',
    // mouse_gain is already a multiplier, not a percentage.
    value: () => `${(Number(appSettings.mouse_gain) || 1).toFixed(2)}×` },
  { page: 'screen',  group: 'Everyday',    label: 'Screen',
    value: () => (Number(appSettings.screen_timeout_s) ? `${appSettings.screen_timeout_s}s` : 'always on') },
  { page: 'device',  group: 'Device',      label: 'USB identity',
    value: () => appSettings.usb_product || 'Keebling' },
  { page: 'network', group: 'Device',      label: 'Network',
    value: () => '' },
  { page: 'backup',  group: 'Maintenance', label: 'Backup & restore' },
  { page: 'ui',      group: 'Maintenance', label: 'Web UI files',
    value: () => '' },
  { page: 'hid',     group: 'Maintenance', label: 'HID descriptor' },
  { page: 'diagnostics', group: 'Maintenance', label: 'Diagnostics' },
];

let setupPage = '';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function setupSections() {
  const wrap = document.querySelector('#view .wrap-setup');
  return wrap ? [...wrap.querySelectorAll('section[data-page]')] : [];
}

// The section is part of the URL, so Back leaves a section before it leaves
// Setup, and a link can point at one directly.
function pageFromHash() {
  const m = /^#\/(?:setup|settings)\/([a-z0-9-]+)/.exec(location.hash);
  return m ? m[1] : '';
}

// Keep whichever of the two Setup paths the user arrived by. Switching to the
// canonical one would be a different route to the router, which remounts the
// whole view and throws the form away - for a section change that only needs
// to swap which part is visible.
function setupBase() {
  const m = /^#(\/(?:setup|settings))/.exec(location.hash);
  return m ? m[1] : '/setup';
}

function goToPage(page) {
  const base = setupBase();
  const want = page ? `#${base}/${page}` : `#${base}`;
  if (location.hash === want) {
    showSetupPage(page);
    return;
  }
  location.hash = want;      // the router hears it and calls show()
}

function showSetupPage(page) {
  setupPage = page && SETUP_ROWS.some((r) => r.page === page) ? page : '';
  if (setupPage === 'network') refreshNetwork();
  for (const section of setupSections()) {
    // With no page chosen every section is hidden and the list stands alone.
    section.hidden = setupPage ? section.dataset.page !== setupPage : true;
  }
  const list = document.getElementById('setupList');
  if (list) list.hidden = !!setupPage;
  const back = document.getElementById('setupBack');
  if (back) back.hidden = !setupPage;
  // Network changes apply immediately; a "Save now" bar would imply they do
  // not, and it covers the form on a short screen.
  const savebar = document.querySelector('.wrap-setup .savebar');
  if (savebar) savebar.hidden = setupPage === 'network';
  window.scrollTo(0, 0);
}

function renderSetupList() {
  const list = document.getElementById('setupList');
  if (!list) return;
  list.textContent = '';
  let group = '';
  for (const row of SETUP_ROWS) {
    if (row.group !== group) {
      group = row.group;
      list.appendChild(h('p', 'grp', group));
    }
    const b = h('button', 'setuprow');
    b.type = 'button';
    b.dataset.page = row.page;
    b.appendChild(h('span', 'lb', row.label));
    const value = typeof row.value === 'function' ? row.value() : '';
    if (value) b.appendChild(h('span', 'vl', value));
    b.appendChild(h('span', 'ch', '\u203A'));
    b.addEventListener('click', () => goToPage(row.page));
    list.appendChild(b);
  }
}

// ---------------------------------------------------------------- lifecycle
// The router calls init() after mounting the settings template and destroy()
// before replacing it.
async function init() {
  dot = document.getElementById('dot');
  statusText = document.getElementById('statusText');
  saveNote = document.getElementById('saveNote');
  screenImagePreview = document.getElementById('screenImagePreview');
  screenImageNote = document.getElementById('screenImageNote');

  for (const [id, type, handler, options] of wired) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(type, handler, options);
  }
  wireScreenImageFormats();
  wireForm();
  readIntoForm();
  const layoutSel = document.getElementById('hostLayout');
  if (layoutSel) {
    layoutSel.value = hostLayoutId();
    layoutSel.addEventListener('change', () => {
      setHostLayout(layoutSel.value);
      showSaveNote('Layout saved. It applies to Keys and Deck the next time you open them.');
    });
  }
  renderSetupList();
  showSetupPage(pageFromHash());

  // The published UI can be pointed at any dongle on the network; the device's
  // own copy has exactly one and must not offer to change it.
  const activeBlock = document.getElementById('activeDeviceBlock');
  if (activeBlock && !(await isDeviceOrigin())) {
    const baseEl = document.getElementById('activeDeviceBase');
    if (baseEl) baseEl.textContent = currentBase();
    activeBlock.hidden = false;
    // The list is a view, not a reset: it can also edit an address, which is
    // the recovery when DHCP has moved the dongle.
    document.getElementById('changeDevice').addEventListener('click', () => {
      location.hash = '#/devices';
    });
  }
  const setupBack = document.getElementById('setupBack');
  if (setupBack) setupBack.addEventListener('click', () => goToPage(''));
  probeAttach();
  screenImageBytes = null;
  screenImageSource = null;

  setStatus('loading settings…', 'warn');
  await loadDeviceScreenImage();
  if (!saveNote) return;          // unmounted while the device was answering
  saveNote.textContent = '';

  // Best-effort: the device's own view of the network.
  setStatus('connected', 'on');
  refreshNetwork();
}

function destroy() {
  // An edit made just before leaving is still inside the debounce window.
  // Flush it rather than cancelling it: the device may already be about to
  // restart, and the next visit should not show a value that was never sent.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    doSave();
  }

  probeDetach();
  screenImageBytes = null;
  screenImageSource = null;
  dot = null;
  statusText = null;
  saveNote = null;
  screenImagePreview = null;
  screenImageNote = null;
}

return {
  init,
  destroy,
  // Called by the router when only the section changed, not the view.
  show(page) { showSetupPage(page || ''); },
  packScreenImage,
  screenImageValid,
  renderScreenImage,
  crc32,
  collectBackup,
  BAYER4,
  get screenImageBytes() { return screenImageBytes; },
};

})();