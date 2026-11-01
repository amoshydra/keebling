// UI files page: what the device is serving, and one way to replace it.
//
// The unit of change is a whole archive. The UI is a bundle - index.html,
// style.css, app.js - and a file-at-a-time upload could leave the shell loading
// a script from a different build. The archive is written and renamed in one
// pass on the device, so an upload either lands completely or not at all.
//
// The listing, the size cap and the whitelist all come from the device, so this
// page cannot offer an upload the endpoint would refuse for a reason other than
// size.
//
// The view is mounted and unmounted by router.js: refs belong to init().

import { apiFetch, apiPost } from './common.js';

export const UiView = (() => {

let dot = null;
let statusText = null;
let fileList = null;
let fsNote = null;
let uiNote = null;
let picker = null;

let uiFiles = [];      // [{ name, stored, size, embedded }]
let maxSize = 0;       // cap on the whole archive, as the device reports it
let loaded = false;    // the tests wait on this
let loadGen = 0;       // invalidates a listing that is still in flight

function setStatus(text, cls) {
  statusText.textContent = text;
  dot.className = 'dot ' + cls;
}

function setNote(el, text, warn) {
  if (!el) return;
  el.className = 'note' + (warn ? ' warn' : '');
  el.textContent = text || '';
}

function fmtSize(n) {
  n = Number(n) || 0;
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

async function loadFiles() {
  if (!fileList) return;        // a listing that arrived after unmount
  const gen = ++loadGen;
  fileList.textContent = 'loading…';
  try {
    const r = await apiFetch('/ui/files');
    if (gen !== loadGen) return;   // unmounted, or a newer listing won
    if (!r.ok) {
      fileList.textContent = `Could not list the files (HTTP ${r.status}).`;
      setStatus('list failed', 'off');
      return;
    }
    const d = await r.json();
    if (gen !== loadGen) return;
    uiFiles = Array.isArray(d.files) ? d.files : [];
    maxSize = Number(d.max_size) || 0;
    render(d);
    setStatus(d.mounted ? 'filesystem ready' : 'no filesystem', d.mounted ? 'on' : 'warn');
  } catch (_) {
    if (gen !== loadGen) return;
    fileList.textContent = 'Could not reach the device.';
    setStatus('offline', 'off');
  } finally {
    if (gen === loadGen) loaded = true;
  }
}

function render(d) {
  fileList.innerHTML = '';

  if (!d.mounted) {
    setNote(fsNote, 'The device has no usable filesystem right now, so uploads ' +
      'are disabled and the built-in copies are being served. A restart retries ' +
      'the mount.', true);
  } else if (d.total) {
    setNote(fsNote, `${fmtSize(d.used)} used of ${fmtSize(d.total)} on the device; ` +
      `an archive may be up to ${fmtSize(maxSize)}.`);
  } else {
    setNote(fsNote, `An archive may be up to ${fmtSize(maxSize)}.`);
  }

  for (const f of uiFiles) {
    const row = document.createElement('div');
    row.className = 'file';
    row.dataset.file = f.name;

    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = f.name;
    const state = document.createElement('div');
    state.className = 'state' + (f.stored ? ' stored' : '');
    state.textContent = f.stored
      ? `uploaded · ${fmtSize(f.size)}`
      : `built-in · ${fmtSize(f.embedded)}`;
    head.append(name, state);
    row.append(head);
    fileList.appendChild(row);
  }
}

async function uploadArchive(file) {
  if (!file) return false;

  // An empty file would be refused by the device, and it is never what someone
  // means to upload.
  if (!file.size) {
    setNote(uiNote, 'That file is empty, so there is nothing to upload. ' +
      'The UI on the device is unchanged.', true);
    return false;
  }
  // The device enforces this too; refusing here keeps a needless transfer off
  // the WiFi link and gives the reason immediately.
  if (maxSize && file.size > maxSize) {
    setNote(uiNote, `${file.name} is ${fmtSize(file.size)}, over the ` +
      `${fmtSize(maxSize)} the device takes for a whole archive. Nothing was uploaded.`, true);
    return false;
  }

  setNote(uiNote, `uploading ${file.name} (${fmtSize(file.size)})…`);
  try {
    const r = await apiFetch('/ui/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    });
    if (!r.ok) {
      let why = '';
      try { why = (await r.text()).trim(); } catch (_) { /* body may be gone */ }
      setNote(uiNote, `The archive was refused (HTTP ${r.status})` +
        (why ? `: ${why}` : '') + '. The UI on the device is unchanged.', true);
      return false;
    }
    let said = '';
    try { said = (await r.text()).trim(); } catch (_) { /* the answer is a courtesy */ }
    setNote(uiNote, (said || 'Uploaded') +
      '. Reload the page to run the new UI — this one is still in memory.');
    await loadFiles();
    return true;
  } catch (_) {
    setNote(uiNote, 'The upload was cut off. The previous UI is still being ' +
      'served; try again.', true);
    return false;
  }
}

async function resetArchive() {
  if (!confirm('Delete every uploaded file and go back to the built-in UI?')) return false;
  setNote(uiNote, 'resetting to the built-in UI…');
  try {
    const r = await apiPost('/ui/reset?all=1');
    if (!r.ok) {
      setNote(uiNote, `Resetting failed (HTTP ${r.status}).`, true);
      return false;
    }
    setNote(uiNote, 'The built-in UI is being served again. Reload the page.');
    await loadFiles();
    return true;
  } catch (_) {
    setNote(uiNote, 'Resetting failed — the device is unreachable.', true);
    return false;
  }
}

// ---------------------------------------------------------------- lifecycle
async function init() {
  dot = document.getElementById('dot');
  statusText = document.getElementById('statusText');
  fileList = document.getElementById('fileList');
  fsNote = document.getElementById('fsNote');
  uiNote = document.getElementById('uiNote');

  uiFiles = [];
  maxSize = 0;
  loaded = false;

  const upload = document.getElementById('uiArchiveUpload');
  picker = document.createElement('input');
  picker.type = 'file';
  picker.id = 'uiArchivePicker';
  picker.accept = 'application/zip,.zip';
  picker.hidden = true;
  document.body.appendChild(picker);
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    picker.value = '';          // so the same archive can be chosen twice
    if (file) uploadArchive(file);
  });
  upload.addEventListener('click', () => picker.click());

  document.getElementById('uiArchiveReset').addEventListener('click', resetArchive);
  document.getElementById('uiRefresh').addEventListener('click', loadFiles);
  await loadFiles();
}

function destroy() {
  loadGen++;
  uiFiles = [];
  maxSize = 0;
  loaded = false;
  picker = null;
  dot = null;
  statusText = null;
  fileList = null;
  fsNote = null;
  uiNote = null;
}

return {
  init,
  destroy,
  uploadArchive,
  resetArchive,
  get loaded() { return loaded; },
  get maxSize() { return maxSize; },
};

})();
