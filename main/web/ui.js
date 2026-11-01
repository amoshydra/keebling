// UI files page: what the device is serving, and one way to replace it.
//
// The unit of change is a whole archive. The UI is a bundle - index.html,
// style.css, app.js, or whatever a user's own bundler emits - and a file at a
// time could leave the shell loading a script from a different build.
//
// Before anything is sent, the archive is read here and compared with what the
// device holds, so the consequences are visible while they can still be called
// off: what is added, what is replaced, what disappears. The device publishes
// all of it at once or none of it, so that review is the only chance.
//
// The view is mounted and unmounted by router.js: refs belong to init().

import { apiFetch, apiPost, apiUrl } from './common.js';

export const UiView = (() => {

// Mirrors safe_file_name() in main/web_server.c. Checked here so a bad archive
// is explained before it is sent, not after the device refuses it.
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_FILES = 24;

let dot = null;
let statusText = null;
let fileList = null;
let fsNote = null;
let uiNote = null;
let picker = null;
let reviewEl = null;
let reviewTitleEl = null;
let reviewSummaryEl = null;
let reviewBodyEl = null;
let reviewGoEl = null;
let reviewCancelEl = null;
let progressEl = null;
let progressNoteEl = null;

let uiFiles = [];      // [{ name, stored, size, embedded }]
let maxSize = 0;       // cap on the whole archive, as the device reports it
let loaded = false;    // the tests wait on this
let loadGen = 0;       // invalidates a listing that is still in flight
let pending = null;    // the archive under review

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

// ---------------------------------------------------------------- archive
//
// Only what is needed to judge an archive: the names, and that it is one the
// device would accept. Sizes come from the listing the device already has.

function readZipNames(buffer) {
  const dv = new DataView(buffer);
  const names = [];
  let at = 0;

  for (;;) {
    if (at + 4 > buffer.byteLength) throw new Error('that is not a zip file');
    const sig = dv.getUint32(at, true);
    if (sig === 0x02014b50 || sig === 0x06054b50) return names;   // central directory
    if (sig !== 0x04034b50) throw new Error('that is not a zip file');
    if (at + 30 > buffer.byteLength) throw new Error('the archive is truncated');

    const method = dv.getUint16(at + 8, true);
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extraLen = dv.getUint16(at + 28, true);
    if (method !== 0) throw new Error('the archive must be stored, not compressed');
    if (at + 30 + nameLen + extraLen + size > buffer.byteLength) {
      throw new Error('the archive is truncated');
    }

    names.push(new TextDecoder().decode(new Uint8Array(buffer, at + 30, nameLen)));
    at += 30 + nameLen + extraLen + size;
  }
}

function nameProblem(name) {
  const parts = String(name).split('/');
  if (parts.length > 2) return 'only one folder deep is supported';
  for (const part of parts) {
    if (!part) return 'an empty path segment';
    if (part.length >= 64) return 'a segment is too long';
    if (part[0] === '.') return 'a hidden name, or "."';
    if (!SEGMENT.test(part)) return 'characters outside letters, digits, dot, dash, underscore';
  }
  const base = parts[parts.length - 1];
  if (base === 'recover.html') return 'recover.html belongs to the firmware';
  if (base.endsWith('.tmp')) return '.tmp is reserved';
  return null;
}

async function planFor(file) {
  const names = readZipNames(await file.arrayBuffer());

  if (!names.length) throw new Error('the archive has no files');
  if (names.length > MAX_FILES) throw new Error(`the archive has ${names.length} files; the device takes ${MAX_FILES}`);

  for (const name of names) {
    const why = nameProblem(name);
    if (why) throw new Error(`"${name}": ${why}`);
  }
  // Without a shell there is nothing to load, so this is not a warning.
  if (!names.includes('index.html')) {
    throw new Error('the archive has no index.html — without the shell there is no UI');
  }

  const listing = await (await apiFetch('/ui/files')).json();
  const stored = (listing.files || []).filter((f) => f.stored).map((f) => f.name);
  const incoming = new Set(names);

  return {
    file,
    names,
    added: names.filter((n) => !stored.includes(n)),
    replaced: names.filter((n) => stored.includes(n)),
    // Anything stored that the archive does not carry: the archive is the
    // whole UI, so these go.
    removed: stored.filter((n) => !incoming.has(n)),
  };
}

// ---------------------------------------------------------------- review

function group(kind, title, note) {
  const box = document.createElement('div');
  box.className = `review-group ${kind}`;

  const head = document.createElement('div');
  head.className = 'review-head';
  head.textContent = title;
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = note;
  head.appendChild(n);

  box.appendChild(head);
  return box;
}

function list(names, noteFor) {
  const ul = document.createElement('ul');
  ul.className = 'review-list';
  for (const name of names) {
    const li = document.createElement('li');
    li.textContent = name;
    const note = noteFor && noteFor(name);
    if (note) {
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = note;
      li.appendChild(size);
    }
    ul.appendChild(li);
  }
  return ul;
}

function renderReview(plan) {
  reviewBodyEl.innerHTML = '';

  const sizeOf = (name) => {
    const f = uiFiles.find((x) => x.name === name);
    return f && f.stored ? fmtSize(f.size) : '';
  };

  if (plan.added.length) {
    const g = group('add', 'Added', `${plan.added.length}`);
    g.appendChild(list(plan.added));
    reviewBodyEl.appendChild(g);
  }

  if (plan.replaced.length) {
    const g = group('replace', 'Replaced', `${plan.replaced.length}`);
    g.appendChild(list(plan.replaced, sizeOf));
    reviewBodyEl.appendChild(g);
  }

  if (plan.removed.length) {
    const g = group('remove', 'Removed', `${plan.removed.length}`);
    g.appendChild(list(plan.removed, sizeOf));
    reviewBodyEl.appendChild(g);
  }

  // Always shown, never different: the recovery page is what repairs a bad
  // upload, so it cannot be part of one.
  const locked = group('locked', 'Locked', 'firmware');
  const ul = document.createElement('ul');
  ul.className = 'review-list';
  const li = document.createElement('li');
  li.className = 'locked';
  li.textContent = 'recover.html';
  const tag = document.createElement('span');
  tag.className = 'size';
  tag.textContent = 'cannot be replaced';
  li.appendChild(tag);
  ul.appendChild(li);
  locked.appendChild(ul);
  reviewBodyEl.appendChild(locked);

  const total = plan.added.length + plan.replaced.length;
  reviewTitleEl.textContent = `${plan.file.name} — ${fmtSize(plan.file.size)}`;
  reviewSummaryEl.textContent =
    `${total} file${total === 1 ? '' : 's'} uploaded, ` +
    `${plan.removed.length} removed. The device swaps the whole UI at once; ` +
    'if the transfer fails, nothing changes.';

  reviewEl.hidden = false;
  progressEl.hidden = true;
  progressEl.value = 0;
  setNote(progressNoteEl, '');
  reviewGoEl.disabled = false;
  reviewGoEl.textContent = 'Upload';
}

function closeReview() {
  pending = null;
  if (reviewEl) reviewEl.hidden = true;
  if (progressEl) progressEl.hidden = true;
  setNote(progressNoteEl, '');
  if (picker) picker.value = '';
}

// ---------------------------------------------------------------- listing

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

// ---------------------------------------------------------------- uploading

// Asked for, not sent: the archive is read and compared with the device first.
async function uploadArchive(file) {
  if (!file) return false;

  if (!file.size) {
    setNote(uiNote, 'That file is empty, so there is nothing to upload. ' +
      'The UI on the device is unchanged.', true);
    closeReview();
    return false;
  }
  if (maxSize && file.size > maxSize) {
    setNote(uiNote, `${file.name} is ${fmtSize(file.size)}, over the ` +
      `${fmtSize(maxSize)} the device takes for a whole archive. Nothing was uploaded.`, true);
    closeReview();
    return false;
  }

  setNote(uiNote, '');
  try {
    pending = await planFor(file);
  } catch (e) {
    setNote(uiNote, `${e.message}. Nothing was uploaded.`, true);
    closeReview();
    return false;
  }

  renderReview(pending);
  return true;
}

// XHR rather than fetch: only XHR reports how much of the body has left the
// browser, which is the difference between a progress bar and a spinner.
function send() {
  if (!pending) return;
  const file = pending.file;

  reviewGoEl.disabled = true;
  reviewGoEl.textContent = 'Uploading…';
  reviewCancelEl.disabled = true;
  progressEl.hidden = false;
  progressEl.value = 0;
  setNote(progressNoteEl, `sending ${fmtSize(file.size)}…`);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', apiUrl('/ui/upload'));
  xhr.setRequestHeader('Content-Type', 'application/zip');

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    progressEl.value = pct;
    setNote(progressNoteEl, `sending ${fmtSize(e.loaded)} of ${fmtSize(e.total)} (${pct}%)`);
  });

  xhr.addEventListener('load', async () => {
    reviewGoEl.disabled = false;
    reviewGoEl.textContent = 'Upload';
    reviewCancelEl.disabled = false;

    if (xhr.status === 200) {
      progressEl.value = 100;
      // The panel closes: what is left to do is reload, and a panel still
      // sitting there invites a second upload of an archive already stored.
      setNote(uiNote, (xhr.responseText || 'Uploaded') +
        '. Reload the page to run the new UI — this one is still in memory.');
      closeReview();
      await loadFiles();
      return;
    }

    // The device publishes a whole archive or none of it, so this is a
    // statement of fact, not a hope.
    setNote(progressNoteEl, `Refused (HTTP ${xhr.status}): ` +
      `${(xhr.responseText || '').trim() || 'no reason given'}. Nothing changed on the device.`, true);
  });

  // A dropped connection lands here, or in `abort`. Either way the device kept
  // the previous UI: it renames only once the whole archive has arrived.
  xhr.addEventListener('error', () => {
    reviewGoEl.disabled = false;
    reviewGoEl.textContent = 'Retry';
    reviewCancelEl.disabled = false;
    const done = progressEl.value;
    setNote(progressNoteEl, `The connection dropped after ${done}%. ` +
      'Nothing changed on the device — the previous UI is still serving. Try again.', true);
  });

  xhr.addEventListener('abort', () => {
    reviewGoEl.disabled = false;
    reviewGoEl.textContent = 'Upload';
    reviewCancelEl.disabled = false;
    setNote(progressNoteEl, 'Cancelled. Nothing changed on the device.', true);
  });

  xhr.send(file);
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
  reviewEl = document.getElementById('uiReview');
  reviewTitleEl = document.getElementById('uiReviewTitle');
  reviewSummaryEl = document.getElementById('uiReviewSummary');
  reviewBodyEl = document.getElementById('uiReviewBody');
  reviewGoEl = document.getElementById('uiReviewGo');
  reviewCancelEl = document.getElementById('uiReviewCancel');
  progressEl = document.getElementById('uiProgress');
  progressNoteEl = document.getElementById('uiProgressNote');

  uiFiles = [];
  maxSize = 0;
  loaded = false;
  pending = null;

  const upload = document.getElementById('uiArchiveUpload');
  picker = document.createElement('input');
  picker.type = 'file';
  picker.id = 'uiArchivePicker';
  picker.accept = 'application/zip,.zip';
  picker.hidden = true;
  document.body.appendChild(picker);
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    if (file) uploadArchive(file);
  });
  upload.addEventListener('click', () => picker.click());

  reviewGoEl.addEventListener('click', send);
  reviewCancelEl.addEventListener('click', () => {
    closeReview();
    setNote(uiNote, '');
  });

  document.getElementById('uiArchiveReset').addEventListener('click', resetArchive);
  document.getElementById('uiRefresh').addEventListener('click', loadFiles);
  await loadFiles();
}

function destroy() {
  loadGen++;
  uiFiles = [];
  maxSize = 0;
  loaded = false;
  pending = null;
  picker = null;
  dot = null;
  statusText = null;
  fileList = null;
  fsNote = null;
  uiNote = null;
  reviewEl = null;
  reviewTitleEl = null;
  reviewSummaryEl = null;
  reviewBodyEl = null;
  reviewGoEl = null;
  reviewCancelEl = null;
  progressEl = null;
  progressNoteEl = null;
}

return {
  init,
  destroy,
  uploadArchive,
  resetArchive,
  send,
  get loaded() { return loaded; },
  get maxSize() { return maxSize; },
  get pending() { return pending; },
};

})();
