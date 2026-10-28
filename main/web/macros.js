// Macro page: the stored macros, the editor and the runner.
//
// Macros live in this browser, under localStorage — not on the device. They
// started in the device's settings blob, which capped them at 1023 bytes
// shared with every other setting and would have been wiped by a partition
// change; a browser has megabytes and survives that. The cost is that they are
// per-browser: a second phone does not see them, and clearing site data takes
// them with it. The page says so rather than letting it be discovered.
//
// A list left on the device by an older build is adopted on first load, in
// loadMacros() below.
//
// The view is mounted and unmounted by router.js: refs and listeners belong to
// init(), and destroy() has to stop the socket, the heartbeat and any run.

const MacrosView = (() => {

const STORE_KEY = 'esp32remote.macros';

// Assigned by init(); nothing here reaches the document at load.
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
// The same shape as pad.js, and deliberately its own: the two pages are
// separate documents and this one only needs the report path. The globals keep
// pad.js's names so both pages can be driven the same way from a test.
let ws = null;
let wsReady = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
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

// Same heartbeat as the control page: the device releases everything held when
// it stops hearing from a browser. Both this timer and the pagehide listener
// are owned by init() and stopped by destroy().
function onPageHide() { send(new Uint8Array([0x05])); }

// ---------------------------------------------------------------- model
let macros = [];
let confirmDelete = null;      // index waiting for a second tap on Delete

// Anything unexpected in the stored list is dropped rather than trusted: an
// older build, or a hand-edited localStorage, can have put it there.
function sanitizeMacros(list) {
  const raw = Array.isArray(list) ? list : [];
  const kept = raw
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({ name: String(m.name || ''), steps: String(m.steps || '') }))
    .filter((m) => m.name || m.steps);
  return { kept, dropped: raw.length - kept.length };
}

// undefined means "nothing stored", which is how the migration below tells an
// empty list from an untouched browser.
function readStore() {
  try {
    const s = localStorage.getItem(STORE_KEY);
    return s === null ? undefined : JSON.parse(s);
  } catch (_) {
    // Unreadable is treated as absent. localStorage can throw rather than
    // merely fail (Safari private mode), so this is not hypothetical.
    return undefined;
  }
}

// Returns an error string, or null on success. Quota is the only realistic
// failure and it deserves reporting rather than a silent no-op.
function writeStore(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    return null;
  } catch (e) {
    return (e && e.name === 'QuotaExceededError')
      ? 'this browser has no room left for this site'
      : 'this browser refused to store them (private mode?)';
  }
}

async function loadMacros() {
  const stored = readStore();
  if (stored !== undefined) {
    const s = sanitizeMacros(stored);
    macros = s.kept;
    if (s.dropped) {
      showSaveNote(`${s.dropped} stored entr${s.dropped === 1 ? 'y was' : 'ies were'} not ` +
                   'readable as a macro and have been left out.', true);
    }
    return;
  }

  // Nothing in this browser. Macros used to live in the device's settings blob,
  // so adopt anything there and move it off the device — otherwise a list that
  // was there yesterday would simply look lost.
  const legacy = sanitizeMacros(appSettings.macros).kept;
  macros = legacy;
  if (!legacy.length) return;

  const err = writeStore(legacy);
  if (err) {
    // Leave the device copy in place: it is still the only durable one.
    showSaveNote(`Not saved: ${err}.`, true);
    return;
  }

  const n = `${legacy.length} macro${legacy.length === 1 ? '' : 's'}`;
  delete appSettings.macros;
  try {
    await saveSettingsToDevice();
    showSaveNote(`Moved ${n} from the device into this browser.`);
  } catch (_) {
    // The browser copy is what matters now; the device's is stale but harmless.
    showSaveNote(`Moved ${n} into this browser. The device could not be reached to ` +
                 'remove its old copy.', true);
  }
}

function macroTitle(m, i) {
  return m.name || (m.steps || '').slice(0, 32) || `macro ${i + 1}`;
}

// The macros as a save would store them: what is saved, plus the editor's
// entry while it is open.
function pendingMacros() {
  if (!editorOpen) return macros;
  const next = macros.slice();
  const entry = { name: nameEl.value.trim(), steps: stepsEl.value };
  if (editIndex >= 0) next[editIndex] = entry;
  else next.push(entry);
  return next;
}

function byteLength(o) {
  // The device measures bytes of the request body, and JSON escapes non-ASCII,
  // so length in characters is not the same number.
  return new TextEncoder().encode(JSON.stringify(o)).length;
}

function showSaveNote(text, warn) {
  saveNoteEl.className = 'note' + (warn ? ' warn' : '');
  saveNoteEl.textContent = text || '';
}

function updateMeter() {
  const list = pendingMacros();
  const bytes = byteLength(list);
  meterEl.className = 'note';
  meterEl.textContent =
    `${list.length} macro${list.length === 1 ? '' : 's'} · ${bytes} bytes, stored in this ` +
    'browser. They do not follow you to another device or browser, and clearing this ' +
    "site's data removes them.";
}

// Writes to this browser only. It claims to have saved once the write has
// succeeded and not before: a list that looks stored but is not is worse than
// a refusal.
function store(next) {
  const err = writeStore(next);
  if (err) {
    showSaveNote(`Not saved: ${err}.`, true);
    updateMeter();
    return false;
  }

  macros = next.slice();
  showSaveNote('saved in this browser');
  render();
  return true;
}

// ---------------------------------------------------------------- list
function stepLabel(parsed) {
  const n = parsed.steps.length;
  let s = `${n} step${n === 1 ? '' : 's'}`;
  if (parsed.errors.length) s += ` · ${parsed.errors.length} error${parsed.errors.length === 1 ? '' : 's'}`;
  if (parsed.warnings.length) s += ` · ${parsed.warnings.length} untypable`;
  return s;
}

function actionButton(text, fn, cls) {
  const b = el('button', cls, text);
  b.addEventListener('click', fn);
  return b;
}

function macroCard(m, i) {
  const parsed = parseMacro(m.steps);

  const card = el('div', 'macro');
  const head = el('div', 'head');
  head.appendChild(el('span', 'name', macroTitle(m, i)));
  head.appendChild(el('span', 'meta', stepLabel(parsed)));

  // Deleting is two taps rather than a confirm() dialog: one of them lands
  // under a thumb on a phone, and the list is small enough to keep this in
  // place.
  const acts = el('div', 'acts');
  if (confirmDelete === i) {
    acts.append(
      actionButton('Cancel', () => { confirmDelete = null; render(); }),
      actionButton('Delete?', () => deleteMacro(i), 'danger'),
    );
  } else {
    acts.append(
      actionButton('Edit', () => openEditor(i)),
      actionButton('Delete', () => { confirmDelete = i; render(); }),
    );
  }
  head.appendChild(acts);
  card.appendChild(head);

  card.appendChild(el('div', 'src', m.steps || '(empty)'));
  if (parsed.errors.length) {
    card.appendChild(el('div', 'bad',
      parsed.errors.map((e) => `${e.token}: ${e.message}`).join(' · ')));
  }

  const run = el('button', 'run primary', running ? 'Running…' : '\u25B6 Run');
  run.disabled = running;
  run.addEventListener('click', () => runMacroAt(i));
  card.appendChild(run);
  return card;
}

function render() {
  listEl.textContent = '';
  if (!macros.length) {
    listEl.appendChild(el('p', 'note', 'No macros stored yet.'));
  } else {
    macros.forEach((m, i) => listEl.appendChild(macroCard(m, i)));
  }
  updateMeter();
}

// ---------------------------------------------------------------- editor
let editorOpen = false;
let editIndex = -1;

function openEditor(index) {
  editorOpen = true;
  editIndex = index;
  const m = index >= 0 ? macros[index] : { name: '', steps: '' };
  nameEl.value = m.name;
  stepsEl.value = m.steps;
  editorTitleEl.textContent = index >= 0 ? 'Edit macro' : 'New macro';
  editorEl.classList.add('show');
  showSaveNote('');
  updatePreview();
  editorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeEditor() {
  editorOpen = false;
  editIndex = -1;
  editorEl.classList.remove('show');
  updateMeter();
}

async function saveEditor() {
  if (!stepsEl.value.trim()) {
    showSaveNote('Not saved: the macro has no steps.', true);
    return;
  }
  const next = macros.slice();
  const entry = { name: nameEl.value.trim(), steps: stepsEl.value };
  if (editIndex >= 0) next[editIndex] = entry;
  else next.push(entry);

  if (await store(next)) closeEditor();
}

// Live parse of what is in the box, so a bad token is named before the run
// rather than during it.
function updatePreview() {
  const parsed = parseMacro(stepsEl.value);
  previewEl.textContent = '';

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

async function deleteMacro(index) {
  confirmDelete = null;
  await store(macros.filter((_, i) => i !== index));
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
  ['WAIT:500', '{WAIT:500}'], ['{', '{{'], ['}', '}}'],
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

// The run bar is fixed to the bottom of the screen: progress has to be visible
// while a macro plays, and the way to interrupt it has to be reachable without
// looking.
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

async function runMacroAt(index) {
  if (running) return;
  const gen = runGen;
  const m = macros[index];
  const title = macroTitle(m, index);
  const parsed = parseMacro(m.steps);

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
  runStopEl.classList.add('danger');       // the button interrupts, and reads as such
  runNameEl.textContent = title;
  runCountEl.textContent = `0 / ${runTotal} steps`;
  runStepEl.textContent = describeMacroStep(parsed.steps[0]);
  paintRunBar();
  render();                      // disables every Run button

  // Two reports per character (press, release), so the gap sets half the rate
  // — the same arithmetic as the Type panel.
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

  // The view was unmounted while the run was in flight; the detached DOM is
  // no longer ours to paint, and the socket has already been closed.
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
  render();
}

// ---------------------------------------------------------------- wiring
function onRunStop() {
  if (running) runAbort = true;          // the runner notices at the next step
  else runbar.classList.remove('show', 'error');
}

// ---------------------------------------------------------------- lifecycle
// The router calls init() after mounting the macros template and destroy()
// before replacing it.
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

  macros = [];
  confirmDelete = null;
  editorOpen = false;
  editIndex = -1;
  running = false;
  runAbort = false;
  runGen++;
  runIndex = 0;
  runTotal = 1;
  runCharFrac = 0;

  buildChips();
  document.getElementById('macroAdd').addEventListener('click', () => openEditor(-1));
  saveEl.addEventListener('click', saveEditor);
  document.getElementById('editCancel').addEventListener('click', closeEditor);
  stepsEl.addEventListener('input', updatePreview);
  nameEl.addEventListener('input', updateMeter);
  runStopEl.addEventListener('click', onRunStop);

  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onPageHide);
  heartbeatTimer = setInterval(() => send(new Uint8Array([0x04])), 1000);

  setStatus('loading settings…', 'warn');
  await loadMacros();        // may migrate a list left on the device
  if (gen !== mountGen) return;   // unmounted while the list was loading
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

  // Release anything the device may still be holding before the socket goes.
  send(new Uint8Array([0x05]));

  if (ws) {
    // As in pad.js: a deliberate close must not arm a reconnect after the view
    // has been replaced.
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  wsReady = false;
  reconnectAttempts = 0;

  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('beforeunload', onPageHide);
  macros = [];
  confirmDelete = null;
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
