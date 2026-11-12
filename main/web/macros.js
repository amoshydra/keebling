// Pages: the stored pages, the editor and the runner.
//
// A page is rows of items; an item is a key or a spacer; a key spans columns.
// The same page can be opened here, in the Keys slot, or in the editor, and it
// is drawn by one renderer — layout.js — so a key looks like itself everywhere.
//
// Pages live in this browser, under localStorage. The old deck, its page list
// and imported layouts are converted into pages by pages.js at boot; this view
// only ever reads and writes `pages`.
//
// The view is mounted and unmounted by router.js: refs and listeners belong to
// init(), and destroy() has to stop the socket, the heartbeat and any run.

import { HID_KEYS, appSettings, saveSettingsToDevice, token, wsUrl } from './common.js';
import { COLOURS, CONSUMER_CHOICES, KEY_CHOICES, keyName } from './deck.js';
import {
  describeMacroStep, macroText, parseMacro, refreshMacroText, runMacro, stepsFromBlocks,
} from './macro.js';
import { renderPage } from './layout.js';
import * as Pages from './pages.js';

export const MacrosView = (() => {

let dot = null;
let statusText = null;
let listEl = null;
let meterEl = null;
let saveNoteEl = null;
let editorEl = null;
let editorTitleEl = null;
let nameEl = null;
let stepsEl = null;
let previewEl = null;
let saveEl = null;
let chipsEl = null;
let runbar = null;
let runNameEl = null;
let runCountEl = null;
let runStepEl = null;
let runFill = null;
let runStopEl = null;
let importTextEl = null;
let importNoteEl = null;
let importFileEl = null;
let editorFrame = null;
let heartbeatTimer = null;
let mountGen = 0;              // invalidates an init that is still awaiting

function setStatus(text, cls) {
  statusText.textContent = text;
  dot.className = 'dot ' + cls;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- transport
// The same shape as pad.js, and deliberately its own: the two views only need
// the report path. The globals keep pad.js's names so both can be driven the
// same way from a test.
let ws = null;
let wsReady = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

function connect() {
  ws = new WebSocket(wsUrl(`/ws?token=${encodeURIComponent(token)}`));
  ws.onopen = () => {
    wsReady = true;
    reconnectAttempts = 0;
    setStatus('connected', 'on');
  };
  ws.onclose = () => {
    wsReady = false;
    setStatus('disconnected', 'off');
    scheduleReconnect();
  };
  ws.onerror = () => { wsReady = false; };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts >= 5) {
    setStatus('disconnected - reload this page', 'off');
  }
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
}

function send(bytes) {
  if (wsReady && ws && ws.readyState === 1) ws.send(bytes);
}

function onPageHide() {
  releaseAllKeys();
  send(new Uint8Array([0x05]));
}

// ---------------------------------------------------------------- model
let pages = [];
let activeId = '';
let pendingPageDelete = null;  // page id waiting for a second tap

const activePage = () => Pages.pageById(pages, activeId) || pages[0] || null;

function saveError(err) {
  showSaveNote(`Not saved: ${err}.`, true);
}

// The old device list is the only place a browser that has never been visited
// by this build can still have macros. Adopt it once, then take it off the
// device so there is one copy.
async function adoptDeviceMacros() {
  const legacy = Array.isArray(appSettings.macros) ? appSettings.macros : [];
  if (!legacy.length) return false;
  const converted = Pages.pagesFromLegacyMacros(legacy);
  if (!converted.pages.length) return false;
  const err = Pages.writePages(converted.pages);
  if (err) { saveError(err); return false; }

  delete appSettings.macros;
  try {
    await saveSettingsToDevice();
    showSaveNote(`Moved ${legacy.length} button${legacy.length === 1 ? '' : 's'} ` +
                 'from the device into this browser.');
  } catch (_) {
    showSaveNote(`Moved ${legacy.length} button${legacy.length === 1 ? '' : 's'} into this browser. ` +
                 'The device could not be reached to remove its old copy.', true);
  }
  pages = converted.pages;
  activeId = converted.pages[0].id;
  Pages.writeActive(activeId);
  return true;
}

async function loadPages() {
  pages = Pages.readPages();
  // The migration could not see the device's old list (it runs before settings
  // load), so a browser whose pages are all empty still adopts it here.
  const allEmpty = pages.every((p) => !p.rows.some((r) => r.keys.length));
  if ((!pages.length || allEmpty) && Array.isArray(appSettings.macros)
      && appSettings.macros.length && await adoptDeviceMacros()) return;
  if (!pages.length) {
    const page = Pages.newPage('Main', new Set(), new Set());
    pages = [page];
    Pages.writePages(pages);
  }
  activeId = Pages.readActive();
  if (!Pages.pageById(pages, activeId)) {
    activeId = pages[0].id;
    Pages.writeActive(activeId);
  }
}

// The pages as a save would store them: what is saved, plus the editor's entry
// while it is open. Only the meter needs this.
function pendingPages() {
  return pages;
}

function byteLength(o) {
  return new TextEncoder().encode(JSON.stringify(o)).length;
}

function showSaveNote(text, warn) {
  if (!saveNoteEl) return;
  saveNoteEl.className = 'note' + (warn ? ' warn' : '');
  saveNoteEl.textContent = text || '';
}

function updateMeter() {
  if (!meterEl) return;
  const n = pages.reduce((sum, p) => sum + p.rows.reduce((s, r) => s + r.keys.filter((it) => !it.spacer).length, 0), 0);
  meterEl.className = 'note';
  meterEl.textContent = `${n} key${n === 1 ? '' : 's'} · ${byteLength(pendingPages())} bytes`;
}

// Writes to this browser only. It claims to have saved once the write has
// succeeded and not before: a list that looks stored but is not is worse than
// a refusal.
function store(next) {
  const err = Pages.writePages(next);
  if (err) { saveError(err); updateMeter(); return false; }
  pages = next.slice();
  showSaveNote('saved in this browser');
  render();
  return true;
}

// ---------------------------------------------------------------- list
function actionOf(it) {
  return (it && it.action) || { kind: 'key', page: 7, usage: 0 };
}

function sourceOf(it) {
  const a = actionOf(it);
  if (a.kind === 'key') return `${keyName(a)} · held`;
  if (a.kind === 'modifier') {
    const hit = MODIFIERS.find(([code]) => code === a.code);
    return `modifier · ${hit ? hit[1] : a.code}`;
  }
  if (a.kind === 'page') {
    const to = Pages.pageById(pages, a.to);
    return `→ ${to ? to.name : a.to}`;
  }
  const blocks = Array.isArray(a.blocks) ? a.blocks : [];
  const text = macroText(blocks) || a.text || '(empty)';
  return it && it.hold ? `hold · ${text}` : text;
}

function parseSequence(it) {
  const a = actionOf(it);
  if (Array.isArray(a.blocks) && a.blocks.length) return { steps: a.blocks, errors: [], warnings: [] };
  if (a.text) return parseMacro(a.text);
  return { steps: [], errors: [], warnings: [] };
}

function actionButton(text, fn, cls) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

function tileTitle(it, index) {
  return it.label || sourceOf(it) || `button ${index + 1}`;
}

// ---------------------------------------------------------------- page strip
function nextPageName() {
  const taken = new Set(pages.map((p) => p.name.toLowerCase()));
  for (let n = 2; ; n++) {
    const name = `Page ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

function addPage() {
  const name = nextPageName();
  const page = Pages.newPage(name, new Set(pages.map((p) => p.id)), new Set(pages.map((p) => p.name.toLowerCase())));
  const next = pages.concat(page);
  if (!store(next)) return;
  activeId = page.id;
  Pages.writeActive(activeId);
  pendingPageDelete = null;
  render();
}

function renderPages() {
  const strip = document.getElementById('deckPages');
  if (!strip) return;
  strip.textContent = '';
  for (const p of pages) {
    const b = el('button', 'page' + (p.id === activeId ? ' on' : ''), p.name);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', p.id === activeId ? 'true' : 'false');
    b.addEventListener('click', () => {
      activeId = p.id;
          pendingPageDelete = null;
      Pages.writeActive(activeId);
      render();
    });
    strip.appendChild(b);
  }
  renderPageTools();
  const add = el('button', 'page add', '+');
  add.type = 'button';
  add.title = 'Add a page';
  add.setAttribute('aria-label', 'Add a page');
  add.addEventListener('click', addPage);
  strip.appendChild(add);
}

function renderPageTools() {
  const tools = document.getElementById('deckPageTools');
  if (!tools) return;
  tools.hidden = !editMode;
  if (!editMode) { tools.textContent = ''; return; }
  tools.textContent = '';
  const p = activePage();
  if (!p) return;

  const input = el('input');
  input.type = 'text';
  input.value = p.name;
  input.maxLength = 24;
  input.setAttribute('aria-label', 'Page name');
  input.spellcheck = false;

  const apply = () => renamePage(p.id, input.value);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

  const rename = actionButton('Rename', apply);
  const del = actionButton(pendingPageDelete === p.id ? 'Delete page?' : 'Delete page',
                           () => deletePage(p.id), 'danger');
  del.disabled = pages.length < 2;
  del.title = del.disabled ? 'A deck needs at least one page'
    : 'Delete this page and the keys on it';

  tools.append(input, rename, del);
}

function renamePage(id, raw) {
  const p = Pages.pageById(pages, id);
  if (!p) return;
  const next = String(raw || '').trim().slice(0, 24);
  if (!next || next === p.name) return;
  if (pages.some((x) => x.id !== id && x.name.toLowerCase() === next.toLowerCase())) {
    showSaveNote('Not renamed: there is already a page with that name.', true);
    return;
  }
  p.name = next;
  store(pages);
}

// Deleting a page that a key jumps to would leave that key doing nothing on the
// device, discovered in the dark. Refuse, and name the keys.
function deletePage(id) {
  const p = Pages.pageById(pages, id);
  if (!p) return;
  if (pages.length < 2) { showSaveNote('A deck needs at least one page.', true); return; }

  // Refuse before asking for confirmation: a second tap cannot fix a jump that
  // would point at nothing, so there is nothing to confirm.
  const used = Pages.referrers(pages, id);
  if (used.length) {
    pendingPageDelete = null;
    showSaveNote(`“${p.name}” cannot be deleted: ${used.length} key${used.length === 1 ? '' : 's'} ` +
      `jump${used.length === 1 ? 's' : ''} here — ${used.slice(0, 3).join(', ')}` +
      `${used.length > 3 ? ` and ${used.length - 3} more` : ''}. Point those keys somewhere else first.`, true);
    render();
    return;
  }

  if (pendingPageDelete !== id) {
    pendingPageDelete = id;
    showSaveNote(`Tap Delete page again to remove “${p.name}” and everything on it.`, true);
    render();
    return;
  }

  const at = pages.findIndex((x) => x.id === id);
  const fallback = pages[at === 0 ? 1 : 0];
  const next = pages.filter((x) => x.id !== id);
  pendingPageDelete = null;
  if (!store(next)) return;
  activeId = fallback.id;
  Pages.writeActive(activeId);
  render();
}

// ---------------------------------------------------------------- a key tile
// The whole tile is the target, so a thumb does not have to find a small "run".
// Editing is a mode rather than a long press, because a long press cannot be
// discovered and cannot be done with a keyboard.
const heldCodes = new Set();
let heldConsumer = 0;
const latched = new Set();

const MODIFIERS = [
  ['ControlLeft', 'Ctrl'], ['ShiftLeft', 'Shift'], ['AltLeft', 'Alt'], ['MetaLeft', 'Cmd'],
  ['ControlRight', 'Right Ctrl'], ['ShiftRight', 'Right Shift'], ['AltRight', 'Right Alt'], ['MetaRight', 'Right Cmd'],
];
const MOD_BIT = {
  ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08,
  ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80,
};

function modMask() {
  let m = 0;
  for (const code of latched) m |= MOD_BIT[code] || 0;
  return m;
}

function sendHeldKeys() {
  const report = new Uint8Array(8);
  report[0] = 0x02;
  report[1] = modMask();
  [...heldCodes].slice(0, 6).forEach((usage, i) => { report[2 + i] = usage; });
  send(report);
}

function sendHeldConsumer() {
  send(new Uint8Array([0x03, heldConsumer & 0xFF, (heldConsumer >> 8) & 0xFF]));
}

function connectRefused() {
  runBarRefused('Not connected', 'Reload this page; the deck needs the socket.');
}

function pressKey(action) {
  if (!wsReady) { connectRefused(); return false; }
  const usage = Number(action.usage) || HID_KEYS[action.code];
  if (action.page === 12 || action.kind === 'consumer') {
    heldConsumer = usage;
    sendHeldConsumer();
  } else {
    if (!usage) return false;
    heldCodes.add(usage);
    sendHeldKeys();
  }
  return true;
}

function releaseKey(action) {
  const usage = Number(action.usage) || HID_KEYS[action.code];
  if (action.page === 12 || action.kind === 'consumer') {
    if (heldConsumer !== usage) return;
    heldConsumer = 0;
    sendHeldConsumer();
  } else {
    if (!heldCodes.delete(usage)) return;
    sendHeldKeys();
  }
}

function toggleModifier(code, cell) {
  if (!wsReady) { connectRefused(); return; }
  if (latched.has(code)) latched.delete(code);
  else latched.add(code);
  cell.classList.toggle('latched', latched.has(code));
  sendHeldKeys();
}

function releaseAllKeys() {
  if (!heldCodes.size && !heldConsumer && !latched.size) return;
  heldCodes.clear();
  heldConsumer = 0;
  latched.clear();
  sendHeldKeys();
  sendHeldConsumer();
}

function decorateTile(tile, it, info) {
  const a = actionOf(it);
  tile.classList.add('macro');
  if (info.row !== undefined) {
    tile.dataset.row = String(info.row);
    tile.dataset.key = String(info.key);
    tile.dataset.id = `${activeId}:${info.row}:${info.key}`;
  }
  if (editMode) tile.classList.add('editing');

  const title = tileTitle(it, info.key || 0);
  const run = el('button', 'run', a.kind === 'key' ? 'Hold' : 'Run');
  run.type = 'button';
  run.title = editMode ? `Edit ${title}` : (a.kind === 'key' ? `Hold ${title}` : `Run ${title}`);
  run.disabled = running && !editMode && a.kind === 'sequence';

  if (a.kind === 'key' && !editMode) {
    tile.classList.add('hold', 'keybutton');
    const down = (e) => {
      e.preventDefault();
      try { run.setPointerCapture(e.pointerId); } catch (_) {}
      pressKey(a);
    };
    const up = () => releaseKey(a);
    run.addEventListener('pointerdown', down);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) run.addEventListener(t, up);
  } else if (a.kind === 'modifier' && !editMode) {
    tile.classList.add('hold');
    run.addEventListener('click', () => toggleModifier(a.code, tile));
  } else if (a.kind === 'page' && !editMode) {
    run.addEventListener('click', () => {
      if (Pages.pageById(pages, a.to)) {
        activeId = a.to;
        Pages.writeActive(activeId);
        render();
      } else if (['abc', 'sym', 'fn', 'kp', 'media'].includes(a.to)) {
        location.hash = '#/keys';
        setTimeout(() => window.dispatchEvent(new CustomEvent('keebling:page', { detail: a.to })), 80);
      } else {
        runBarRefused(title, `Not run: there is no page “${a.to}”.`);
      }
    });
  } else if (a.kind === 'sequence' && it.hold && !editMode) {
    tile.classList.add('hold');
    const start = (e) => { e.preventDefault(); if (!running) runSequenceAt(info); };
    const stop = () => { if (running) onRunStop(); };
    run.addEventListener('pointerdown', start);
    for (const t of ['pointerup', 'pointerleave', 'pointercancel']) run.addEventListener(t, stop);
  } else if (!editMode) {
    run.addEventListener('click', () => {
      if (a.kind === 'sequence') runSequenceAt(info);
    });
  }

  tile.appendChild(run);
  tile.appendChild(el('span', 'name', title));
  tile.appendChild(el('span', 'src', sourceOf(it)));

  if (a.kind === 'sequence') {
    const parsed = parseSequence(it);
    if (parsed.errors.length) {
      tile.appendChild(el('div', 'bad', parsed.errors.map((e) => `${e.token}: ${e.message}`).join(' · ')));
    }
  }

  if (editMode) {
    const acts = el('div', 'acts');
    acts.appendChild(actionButton('Edit', () => openEditor(info)));
    tile.appendChild(acts);
    tile.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.acts')) return;
      openEditor(info);
    });
  }
}

function render() {
  if (!pages.length) return;
  if (!Pages.pageById(pages, activeId)) activeId = pages[0].id;
  renderPages();
  if (!listEl) return;
  const p = activePage();
  listEl.textContent = '';
  listEl.className = 'pagegrid' + (editMode ? ' editing' : '');
  if (!p) return;
  const count = p.rows.reduce((s, r) => s + r.keys.length, 0);
  if (!count) {
    // An empty page needs no blank rows: the note is the whole page.
    listEl.appendChild(el('p', 'note', editMode
      ? 'Nothing on this page yet.'
      : 'Nothing on this page yet — tap New key to add one.'));
  } else {
    renderPage(listEl, p, { decorate: decorateTile });
  }
  const editBtn = document.getElementById('deckEdit');
  if (editBtn) {
    editBtn.textContent = editMode ? 'Done' : 'Edit';
    editBtn.classList.toggle('on', editMode);
  }
  updateMeter();
}


// ---------------------------------------------------------------- editor
let editMode = false;
let editorOpen = false;
let editAt = null;             // { row, key } on the active page, or null
let editColour = '';
let editHold = false;
let editKind = 'script';       // script | key | modifier | page
let editKey = null;            // { kind, code|usage } when editKind is 'key'
let editModifier = 'ShiftLeft';
let editTarget = '';
let pendingKeyDelete = false;

function itemAt(info) {
  const p = activePage();
  if (!p || !info) return null;
  const row = p.rows[info.row];
  return row ? row.keys[info.key] || null : null;
}

function openEditor(info) {
  editorOpen = true;
  editAt = info || null;
  const it = editAt ? itemAt(editAt) : null;
  const a = actionOf(it);

  nameEl.value = it ? (it.label || '') : '';
  editColour = it && COLOURS.includes(it.colour) ? it.colour : '';
  editHold = !!(it && it.hold);
  editKind = !it ? 'script' : a.kind === 'key' ? 'key'
    : a.kind === 'modifier' ? 'modifier'
    : a.kind === 'page' ? 'page' : 'script';
  editKey = a.kind === 'key'
    ? (a.page === 12
        ? { kind: 'consumer', usage: Number(a.usage) || 0x00CD }
        : { kind: 'key', code: a.code || codeForUsage(a.usage) || 'ArrowUp' })
    : { kind: 'key', code: 'ArrowUp' };
  editModifier = a.kind === 'modifier' ? a.code : 'ShiftLeft';
  editTarget = a.kind === 'page' ? a.to
    : ((activePage() && pages.find((p) => p.id !== activePage().id)) || activePage() || {}).id || '';
  const holdBox = document.getElementById('editHold');
  if (holdBox) holdBox.checked = editHold;

  paintColourSwatches();
  paintTargets();
  stepsEl.value = a.kind === 'sequence'
    ? (macroText(a.blocks || []) || a.text || '')
    : '';
  paintKind();
  editorTitleEl.textContent = (editAt ? 'Edit key' : 'New key') +
    (activePage() ? ` on “${activePage().name}”` : '');
  pendingKeyDelete = false;
  const del = document.getElementById('editDelete');
  if (del) { del.hidden = !editAt; del.textContent = 'Delete key'; }
  editorEl.classList.add('show');
  showSaveNote('');
  updatePreview();
  editorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function codeForUsage(usage) {
  return Object.keys(HID_KEYS).find((c) => HID_KEYS[c] === Number(usage)) || '';
}

// Builds the key picker once, then keeps the two views of it in step.
function buildKeyChoices() {
  const pick = document.getElementById('editKey');
  if (!pick || pick.dataset.built) return;
  pick.dataset.built = '1';

  const keys = document.createElement('optgroup');
  keys.label = 'Keys';
  for (const [code, label] of KEY_CHOICES) {
    const o = document.createElement('option');
    o.value = 'key:' + code;
    o.textContent = label;
    keys.appendChild(o);
  }

  const media = document.createElement('optgroup');
  media.label = 'Media & browser';
  for (const [usage, label] of CONSUMER_CHOICES) {
    const o = document.createElement('option');
    o.value = 'consumer:' + usage;
    o.textContent = label;
    media.appendChild(o);
  }

  pick.append(keys, media);
  pick.addEventListener('change', () => {
    const [kind, value] = pick.value.split(':');
    editKey = kind === 'consumer' ? { kind, usage: Number(value) } : { kind, code: value };
  });
}

function paintTargets() {
  const pick = document.getElementById('editPageTarget');
  if (!pick) return;
  pick.textContent = '';
  for (const p of pages) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    if (p.id === editTarget) o.selected = true;
    pick.appendChild(o);
  }
  pick.onchange = () => { editTarget = pick.value; };
}

function paintKind() {
  buildKeyChoices();
  const seg = document.getElementById('editKind');
  if (seg) {
    for (const b of seg.querySelectorAll('button[data-kind]')) {
      b.classList.toggle('on', b.dataset.kind === editKind);
    }
  }
  const isKey = editKind === 'key';
  const isScript = editKind === 'script';
  const isMod = editKind === 'modifier';
  const isPage = editKind === 'page';
  const show = (id, yes) => { const e = document.getElementById(id); if (e) e.hidden = !yes; };
  show('editKeyField', isKey);
  show('editStepsField', isScript);
  show('editInsert', isScript);
  show('editHoldField', isScript);
  show('editModifierField', isMod);
  show('editPageField', isPage);

  const pick = document.getElementById('editKey');
  if (pick && editKey) {
    pick.value = editKey.kind === 'consumer'
      ? `consumer:${editKey.usage}`
      : `key:${editKey.code}`;
  }
  const mod = document.getElementById('editModifier');
  if (mod) mod.value = editModifier;
  paintTargets();
}

function paintColourSwatches() {
  const row = document.getElementById('editColours');
  if (!row) return;
  for (const b of row.querySelectorAll('button[data-colour]')) {
    b.classList.toggle('on', b.dataset.colour === editColour);
  }
}

function closeEditor() {
  editorOpen = false;
  editAt = null;
  pendingKeyDelete = false;
  editorEl.classList.remove('show');
  updateMeter();
}

// Deleting a key from its own editor, rather than from a cramped tile. Two
// taps, because the button is under the same thumb as Save.
function deleteFromEditor() {
  const del = document.getElementById('editDelete');
  if (!del || !editAt) return;
  if (!pendingKeyDelete) {
    pendingKeyDelete = true;
    del.textContent = 'Delete key?';
    return;
  }
  const p = activePage();
  const row = p && p.rows[editAt.row];
  if (row) row.keys.splice(editAt.key, 1);
  pendingKeyDelete = false;
  if (store(pages)) closeEditor();
}

async function saveEditor() {
  let action = null;
  let parsed = { steps: [], errors: [] };

  if (editKind === 'key') {
    if (!editKey) { showSaveNote('Not saved: no key chosen.', true); return; }
    action = editKey.kind === 'consumer'
      ? { kind: 'key', page: 12, usage: Number(editKey.usage) }
      : { kind: 'key', page: 7, usage: HID_KEYS[editKey.code] || 0, code: editKey.code };
    if (!action.usage) { showSaveNote('Not saved: that key has no HID usage.', true); return; }
  } else if (editKind === 'modifier') {
    action = { kind: 'modifier', code: editModifier };
  } else if (editKind === 'page') {
    if (!editTarget) { showSaveNote('Not saved: no page chosen.', true); return; }
    if (activePage() && editTarget === activePage().id) {
      showSaveNote('Not saved: a jump needs a page other than this one.', true);
      return;
    }
    action = { kind: 'page', to: editTarget };
  } else {
    if (!stepsEl.value.trim()) { showSaveNote('Not saved: the macro has no steps.', true); return; }
    parsed = parseMacro(stepsEl.value);
    if (parsed.errors.length) {
      showSaveNote(`Not saved: ${parsed.errors[0].token} — ${parsed.errors[0].message}.`, true);
      return;
    }
    action = { kind: 'sequence', blocks: parsed.steps };
  }

  const p = activePage();
  if (!p) return;
  const entry = {
    label: nameEl.value.trim(),
    alt: '',
    w: editAt ? (itemAt(editAt) && itemAt(editAt).w) || 1 : 1,
    colour: editColour,
    // A held key is held by definition; the flag only means something to a
    // script, and a stale one would show a HOLD tag on the wrong button.
    hold: editKind === 'sequence' ? editHold : false,
    action,
  };

  if (editAt) {
    const row = p.rows[editAt.row];
    if (row) row.keys[editAt.key] = entry;
  } else {
    const used = (row) => row.keys.reduce((n, it) => n + (it.spacer ? Number(it.spacer) : Number(it.w) || 1), 0);
    let row = p.rows[p.rows.length - 1];
    if (!row || used(row) + 1 > p.columns) {
      row = { h: 50, gap: 4, align: 'stretch', keys: [] };
      p.rows.push(row);
    }
    row.keys.push(entry);
  }

  if (store(pages)) closeEditor();
}

// Live parse of what is in the box, so a bad token is named before the run
// rather than during it.
function updatePreview() {
  previewEl.textContent = '';
  if (editKind === 'key') {
    const label = editKey.kind === 'consumer'
      ? keyName({ kind: 'key', page: 12, usage: editKey.usage })
      : keyName({ kind: 'key', page: 7, code: editKey.code });
    previewEl.appendChild(el('div', 'plan',
      `${label}: sent the moment it is pressed and cleared on release, so the host repeats it.`));
    updateMeter();
    return;
  }
  if (editKind === 'modifier') {
    previewEl.appendChild(el('div', 'plan',
      'Tapping it latches this modifier for the next key, so a capital needs one finger.'));
    updateMeter();
    return;
  }
  if (editKind === 'page') {
    const to = Pages.pageById(pages, editTarget);
    previewEl.appendChild(el('div', 'plan', `Jumps to “${to ? to.name : 'a missing page'}”.`));
    updateMeter();
    return;
  }

  const parsed = parseMacro(stepsEl.value);
  for (const e of parsed.errors) {
    previewEl.appendChild(el('div', 'err', `${e.token} (character ${e.index + 1}): ${e.message}`));
  }
  for (const w of parsed.warnings) {
    previewEl.appendChild(el('div', 'warn', `“${w.ch}”: ${w.message} — it will be skipped`));
  }
  if (parsed.errors.length) {
    previewEl.appendChild(el('div', 'err', 'This macro will not run until the tokens above are fixed.'));
  }
  const lines = parsed.steps.map((s, i) => `${i + 1}. ${describeMacroStep(s)}`);
  if (lines.length) previewEl.appendChild(el('div', 'plan', lines.join('\n')));
  updateMeter();
}

// Tokens on a chip row: typing braces on a phone keyboard is its own small
// ordeal.
const CHIPS = [
  ['ENTER', '{ENTER}'], ['TAB', '{TAB}'], ['ESC', '{ESC}'], ['BKSP', '{BKSP}'],
  ['DEL', '{DEL}'], ['SPACE', '{SPACE}'], ['←', '{LEFT}'], ['→', '{RIGHT}'],
  ['↑', '{UP}'], ['↓', '{DOWN}'], ['HOME', '{HOME}'], ['END', '{END}'],
  ['PGUP', '{PGUP}'], ['PGDN', '{PGDN}'],
  ['CTRL+C', '{CTRL+C}'], ['CMD+SPACE', '{CMD+SPACE}'], ['CTRL+ALT+DEL', '{CTRL+ALT+DEL}'],
  ['PLAYPAUSE', '{PLAYPAUSE}'], ['NEXTTRACK', '{NEXTTRACK}'], ['PREVTRACK', '{PREVTRACK}'],
  ['VOLUMEUP', '{VOLUMEUP}'], ['VOLUMEDOWN', '{VOLUMEDOWN}'], ['MUTE', '{MUTE}'],
  ['SEARCH', '{SEARCH}'], ['CALC', '{CALC}'], ['BROWSERHOME', '{BROWSERHOME}'],
  ['BROWSERBACK', '{BROWSERBACK}'], ['BROWSERFORWARD', '{BROWSERFORWARD}'],
  ['WAIT:500', '{WAIT:500}'],
  ['REPEAT:3', '{REPEAT:3}'], ['/REPEAT', '{/REPEAT}'],
  ['{', '{{'], ['}', '}}'],
];

function buildChips() {
  for (const [label, token] of CHIPS) {
    chipsEl.appendChild(actionButton(label, () => insertToken(token)));
  }
}

function insertToken(token) {
  const at = stepsEl.selectionStart == null ? stepsEl.value.length : stepsEl.selectionStart;
  const end = stepsEl.selectionEnd == null ? at : stepsEl.selectionEnd;
  stepsEl.value = stepsEl.value.slice(0, at) + token + stepsEl.value.slice(end);
  stepsEl.selectionStart = stepsEl.selectionEnd = at + token.length;
  updatePreview();
}

// ---------------------------------------------------------------- run
let running = false;
let runAbort = false;
let runGen = 0;                // invalidates a run when the view is left
let runIndex = 0;
let runTotal = 1;
let runCharFrac = 0;

function paintRunBar() {
  const frac = Math.min(1, (runIndex + runCharFrac) / (runTotal || 1));
  runFill.style.width = Math.round(frac * 100) + '%';
}

function showRunBar() {
  runbar.classList.add('show');
}

function runBarRefused(title, message) {
  showRunBar();
  runbar.classList.add('error');
  runNameEl.textContent = title;
  runCountEl.textContent = '';
  runStepEl.textContent = message;
  runFill.style.width = '0%';
  runStopEl.textContent = 'Hide';
  runStopEl.classList.remove('danger');
}

async function runSequenceAt(info) {
  if (running) return;
  const gen = runGen;
  const it = itemAt(info);
  if (!it) return;
  const title = tileTitle(it, info.key);
  const parsed = parseSequence(it);

  // An unrecognised token is never skipped: the run is refused and the token
  // is named.
  if (parsed.errors.length) {
    const e = parsed.errors[0];
    runBarRefused(title, `Not run: ${e.token} — ${e.message}` +
      (parsed.errors.length > 1 ? ` (${parsed.errors.length} problems in this macro)` : ''));
    return;
  }
  if (!parsed.steps.length) {
    runBarRefused(title, 'Not run: this macro has no steps.');
    return;
  }
  if (!wsReady) {
    runBarRefused(title, 'Not run: not connected to the device. Reload this page.');
    return;
  }

  running = true;
  runAbort = false;
  runIndex = 0;
  runCharFrac = 0;
  runTotal = parsed.steps.length;

  runbar.classList.remove('error');
  showRunBar();
  runStopEl.textContent = 'Stop';
  runStopEl.classList.add('danger');
  runNameEl.textContent = title;
  runCountEl.textContent = `0 / ${runTotal} steps`;
  runStepEl.textContent = describeMacroStep(parsed.steps[0]);
  paintRunBar();
  // Disable the other Run buttons without replacing the tile that is being
  // held: a re-render would detach the element the release listener is on.
  if (listEl) for (const b of listEl.querySelectorAll('.run')) b.disabled = true;

  const cps = Number(appSettings.type_speed) || 20;
  const result = await runMacro(parsed.steps, {
    send,
    gapMs: Math.max(5, Math.round(500 / cps)),
    stopped: () => runAbort || gen !== runGen,
    onStep: (i, step) => {
      runIndex = i;
      runCharFrac = 0;
      runStepEl.textContent = describeMacroStep(step);
      runCountEl.textContent = `${i} / ${runTotal} steps`;
      paintRunBar();
    },
    onChar: (typed, total) => {
      runCharFrac = total ? typed / total : 0;
      paintRunBar();
    },
  });

  if (gen !== runGen) return;

  running = false;
  runStopEl.textContent = 'Hide';
  runStopEl.classList.remove('danger');
  runCountEl.textContent = `${result.ran} / ${runTotal} steps`;

  if (result.stopped) {
    runbar.classList.add('error');
    runStepEl.textContent = 'stopped';
    paintRunBar();
  } else {
    runFill.style.width = '100%';
    runStepEl.textContent = `done — ${result.chars} character${result.chars === 1 ? '' : 's'} typed`;
  }
  if (result.skipped.length) {
    runStepEl.textContent += ` · no key for: ${result.skipped.join(' ')} (skipped)`;
  }
  if (!wsReady) runStepEl.textContent += ' · connection lost during the run';
  if (listEl) for (const b of listEl.querySelectorAll('.run')) b.disabled = false;
}

function onRunStop() {
  if (running) runAbort = true;
  else runbar.classList.remove('show', 'error');
}

// ---------------------------------------------------------------- import
// Six states, each said in the note rather than only in the appearance of the
// button: idle (the placeholder is the instruction), empty, unreadable,
// refused, nothing new, imported.
function setImportNote(text, warn) {
  if (!importNoteEl) return;
  importNoteEl.className = 'note' + (warn ? ' warn' : '');
  importNoteEl.textContent = text || '';
}

function importPages(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    setImportNote('Nothing to import — paste a page file or choose one from this device.', true);
    return false;
  }
  const parsed = Pages.parsePageFile(raw);
  if (parsed.error) {
    setImportNote(`Not imported: ${parsed.error}. Nothing changed.`, true);
    return false;
  }

  const merged = Pages.mergePages(pages, parsed.pages);
  const err = Pages.writePages(merged.pages);
  if (err) {
    setImportNote(`Not saved: ${err}. Nothing changed.`, true);
    return false;
  }

  pages = merged.pages;
  if (parsed.strip && parsed.strip.length) Pages.applyStrip(parsed.strip, merged.remap);
  if (merged.added.length) {
    activeId = merged.added[0].id;
    Pages.writeActive(activeId);
  }
  const names = merged.added.map((p) => p.name);
  const suffix = merged.remap.size ? ' Existing ids were kept; the imported pages were renamed.' : '';
  setImportNote(`Imported ${merged.added.length} page${merged.added.length === 1 ? '' : 's'}: ` +
    `${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}.${suffix}`);
  render();
  return true;
}

function wireImport() {
  const go = document.getElementById('importGo');
  if (go) {
    go.addEventListener('click', () => {
      const ok = importPages(importTextEl ? importTextEl.value : '');
      if (ok && importTextEl) importTextEl.value = '';
    });
  }
  const pick = document.getElementById('importPick');
  if (pick && importFileEl) {
    pick.addEventListener('click', () => importFileEl.click());
  }
  if (importFileEl) {
    importFileEl.addEventListener('change', async () => {
      const file = importFileEl.files && importFileEl.files[0];
      importFileEl.value = '';
      if (!file) return;
      try {
        importPages(await file.text());
      } catch (_) {
        setImportNote('That file could not be read.', true);
      }
    });
  }
}

// The editor is the same document GitHub Pages serves, bundled from
// site/editor. It runs in an iframe so its styles cannot leak into the app, and
// posts the JSON it exports to this view rather than asking for a download.
function wireEditor() {
  if (editorFrame && !editorFrame.dataset.ready) {
    editorFrame.dataset.ready = '1';
    editorFrame.src = 'editor.html';
  }
}

function onEditorMessage(e) {
  if (!e.data || e.data.type !== 'keebling:import') return;
  importPages(e.data.json);
}

// ---------------------------------------------------------------- wiring
async function init() {
  const gen = ++mountGen;
  dot = document.getElementById('dot');
  statusText = document.getElementById('statusText');
  listEl = document.getElementById('macroList');
  meterEl = document.getElementById('blobMeter');
  saveNoteEl = document.getElementById('saveNote');
  editorEl = document.getElementById('editor');
  editorTitleEl = document.getElementById('editorTitle');
  nameEl = document.getElementById('editName');
  stepsEl = document.getElementById('editSteps');
  previewEl = document.getElementById('parsePreview');
  saveEl = document.getElementById('editSave');
  chipsEl = document.getElementById('chips');
  runbar = document.getElementById('runbar');
  runNameEl = document.getElementById('runName');
  runCountEl = document.getElementById('runCount');
  runStepEl = document.getElementById('runStep');
  runFill = document.getElementById('runFill');
  runStopEl = document.getElementById('runStop');
  importTextEl = document.getElementById('importText');
  importNoteEl = document.getElementById('importNote');
  importFileEl = document.getElementById('importFile');
  editorFrame = document.getElementById('editorFrame');

  if (typeof refreshMacroText === 'function') refreshMacroText();
  pages = [];
  activeId = '';
  pendingPageDelete = null;
  editMode = false;
  editorOpen = false;
  editAt = null;
  running = false;
  runAbort = false;
  runGen++;
  runIndex = 0;
  runTotal = 1;
  runCharFrac = 0;
  heldCodes.clear();
  heldConsumer = 0;
  latched.clear();

  buildChips();
  document.getElementById('macroAdd').addEventListener('click', () => openEditor(null));
  const holdBox = document.getElementById('editHold');
  if (holdBox) holdBox.addEventListener('change', () => { editHold = holdBox.checked; });
  const kindRow = document.getElementById('editKind');
  if (kindRow) {
    kindRow.addEventListener('click', (e) => {
      const b = e.target.closest ? e.target.closest('button[data-kind]') : null;
      if (!b) return;
      editKind = b.dataset.kind;
      paintKind();
      updatePreview();
    });
  }
  const colourRow = document.getElementById('editColours');
  if (colourRow) {
    colourRow.addEventListener('click', (e) => {
      const b = e.target.closest ? e.target.closest('button[data-colour]') : null;
      if (!b) return;
      editColour = b.dataset.colour;
      paintColourSwatches();
    });
  }
  document.getElementById('deckEdit').addEventListener('click', () => {
    editMode = !editMode;
      pendingPageDelete = null;
    render();
  });
  saveEl.addEventListener('click', saveEditor);
  document.getElementById('editCancel').addEventListener('click', closeEditor);
  document.getElementById('editDelete').addEventListener('click', deleteFromEditor);
  stepsEl.addEventListener('input', updatePreview);
  nameEl.addEventListener('input', updateMeter);
  runStopEl.addEventListener('click', onRunStop);

  const mod = document.getElementById('editModifier');
  if (mod) {
    mod.textContent = '';
    for (const [code, label] of MODIFIERS) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = label;
      mod.appendChild(o);
    }
    mod.addEventListener('change', () => { editModifier = mod.value; });
  }

  wireImport();
  wireEditor();
  window.addEventListener('message', onEditorMessage);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onPageHide);
  heartbeatTimer = setInterval(() => send(new Uint8Array([0x04])), 1000);

  setStatus('loading settings…', 'warn');
  await loadPages();
  if (gen !== mountGen) return;
  render();
  connect();
}

function destroy() {
  mountGen++;
  runAbort = true;
  runGen++;
  running = false;

  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  heldCodes.clear();
  heldConsumer = 0;
  latched.clear();
  send(new Uint8Array([0x05]));

  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  wsReady = false;
  reconnectAttempts = 0;

  window.removeEventListener('message', onEditorMessage);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('beforeunload', onPageHide);
  pages = [];
  pendingPageDelete = null;
  editorFrame = null;
}

// The tests drive the real pages from the browser console, so the socket state
// stays reachable through the view object.
return {
  init,
  destroy,
  get ws() { return ws; },
  set ws(v) { ws = v; },
  get wsReady() { return wsReady; },
  set wsReady(v) { wsReady = v; },
  get reconnectTimer() { return reconnectTimer; },
  set reconnectTimer(v) { reconnectTimer = v; },
};

})();
