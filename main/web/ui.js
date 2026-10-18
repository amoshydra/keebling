// UI files page: which files the device is serving from its filesystem and
// which are still the built-in copies, with upload and reset.
//
// The listing, the size cap and the whitelist all come from the device, so
// this page cannot offer an upload the endpoint would refuse for a reason
// other than size.

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const fileList = document.getElementById('fileList');
const fsNote = document.getElementById('fsNote');
const uiNote = document.getElementById('uiNote');

let uiFiles = [];      // [{ name, stored, size, embedded }]
let maxSize = 0;       // per-file cap the device reported
let loaded = false;    // the tests wait on this

function setStatus(text, cls) {
  statusText.textContent = text;
  dot.className = 'dot ' + cls;
}

function setNote(el, text, warn) {
  el.className = 'note' + (warn ? ' warn' : '');
  el.textContent = text || '';
}

function fmtSize(n) {
  n = Number(n) || 0;
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

async function loadFiles() {
  fileList.textContent = 'loading…';
  try {
    const r = await apiFetch('/ui/files');
    if (!r.ok) {
      fileList.textContent = `Could not list the files (HTTP ${r.status}).`;
      setStatus('list failed', 'off');
      return;
    }
    const d = await r.json();
    uiFiles = Array.isArray(d.files) ? d.files : [];
    maxSize = Number(d.max_size) || 0;
    render(d);
    setStatus(d.mounted ? 'filesystem ready' : 'no filesystem', d.mounted ? 'on' : 'warn');
  } catch (_) {
    fileList.textContent = 'Could not reach the device.';
    setStatus('offline', 'off');
  } finally {
    loaded = true;
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
      `up to ${fmtSize(maxSize)} per file.`);
  } else {
    setNote(fsNote, `Up to ${fmtSize(maxSize)} per file.`);
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

    const acts = document.createElement('div');
    acts.className = 'acts';

    const picker = document.createElement('input');
    picker.type = 'file';
    picker.className = 'picker';
    picker.hidden = true;
    picker.addEventListener('change', () => {
      const file = picker.files && picker.files[0];
      picker.value = '';        // so the same file can be chosen twice in a row
      if (file) uploadFile(f.name, file);
    });

    const upload = document.createElement('button');
    upload.className = 'upload';
    upload.textContent = 'Upload…';
    upload.disabled = !d.mounted;
    upload.addEventListener('click', () => picker.click());

    const reset = document.createElement('button');
    reset.className = 'reset';
    reset.textContent = 'Reset to built-in';
    reset.hidden = !f.stored;
    reset.addEventListener('click', () => resetFile(f.name));

    acts.append(upload, reset, picker);
    row.append(head, acts);
    fileList.appendChild(row);
  }
}

async function uploadFile(name, file) {
  // An empty file would be refused by the device (a zero-length file counts as
  // absent), and it is never what someone means to upload.
  if (!file.size) {
    setNote(uiNote, `${name} is empty, so there is nothing to upload. ` +
      'The built-in copy is still being served.', true);
    return false;
  }
  // The device enforces this too; refusing here keeps a needless transfer off
  // the WiFi link and gives the reason immediately.
  if (maxSize && file.size > maxSize) {
    setNote(uiNote, `${name} is ${fmtSize(file.size)}, over the ${fmtSize(maxSize)} ` +
      'the device stores per file. Nothing was uploaded.', true);
    return false;
  }

  setNote(uiNote, `uploading ${name} (${fmtSize(file.size)})…`);
  try {
    const r = await apiFetch(`/ui/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!r.ok) {
      let why = '';
      try { why = (await r.text()).trim(); } catch (_) { /* body may be gone */ }
      setNote(uiNote, `${name} was refused (HTTP ${r.status})` +
        (why ? `: ${why}` : '') + '. Nothing changed.', true);
      return false;
    }
    setNote(uiNote, `${name} uploaded. It replaces the built-in copy until it is reset.`);
    await loadFiles();
    return true;
  } catch (_) {
    setNote(uiNote, `The upload of ${name} was cut off. The previous copy is ` +
      'still being served; try again.', true);
    return false;
  }
}

async function resetFile(name) {
  if (!confirm(`Delete the uploaded ${name} and go back to the built-in copy?`)) return false;
  setNote(uiNote, `resetting ${name}…`);
  try {
    const r = await apiPost(`/ui/reset?name=${encodeURIComponent(name)}`);
    if (!r.ok) {
      setNote(uiNote, `Resetting ${name} failed (HTTP ${r.status}).`, true);
      return false;
    }
    setNote(uiNote, `${name} is back to the built-in copy.`);
    await loadFiles();
    return true;
  } catch (_) {
    setNote(uiNote, `Resetting ${name} failed — the device is unreachable.`, true);
    return false;
  }
}

document.getElementById('uiRefresh').addEventListener('click', loadFiles);

// ---------------------------------------------------------------- start
requireAuth(async () => {
  await loadFiles();
});
