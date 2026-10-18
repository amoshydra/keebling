// Macro page: the stored macros, the editor and the runner.
//
// Macros live in the device settings blob under "macros" — that is the only
// storage the web UI has, and the firmware stores the blob verbatim without
// reading this key, so none of this is a firmware change. The blob is capped:
// main/settings.h sets SETTINGS_MAX 1024 and main/web_server.c drops a body of
// 1024 bytes or more, so the page refuses to save while what it would send is
// over that and says by how much. A macro is a line of text, so that budget
// goes a long way: the worked example is about 20 bytes plus its name.

// The device takes a settings body of at most SETTINGS_MAX - 1 bytes.
const BLOB_MAX = 1023;

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const listEl = document.getElementById('macroList');
const meterEl = document.getElementById('blobMeter');
const saveNoteEl = document.getElementById('saveNote');
const editorEl = document.getElementById('editor');
const editorTitleEl = document.getElementById('editorTitle');
const nameEl = document.getElementById('editName');
const stepsEl = document.getElementById('editSteps');
const previewEl = document.getElementById('parsePreview');
const saveEl = document.getElementById('editSave');
const chipsEl = document.getElementById('chips');
const runbar = document.getElementById('runbar');
const runNameEl = document.getElementById('runName');
const runCountEl = document.getElementById('runCount');
const runStepEl = document.getElementById('runStep');
const runFill = document.getElementById('runFill');
const runStopEl = document.getElementById('runStop');

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
// it stops hearing from a browser.
setInterval(() => send(new Uint8Array([0x04])), 1000);
window.addEventListener('pagehide', () => send(new Uint8Array([0x05])));
window.addEventListener('beforeunload', () => send(new Uint8Array([0x05])));

// ---------------------------------------------------------------- model
// The blob is written by the settings page too, so anything unexpected in it
// is dropped here rather than trusted.
let macros = [];
let confirmDelete = null;      // index waiting for a second tap on Delete

function loadMacros() {
  const raw = appSettings.macros;
  const list = Array.isArray(raw) ? raw : [];
  macros = list
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({ name: String(m.name || ''), steps: String(m.steps || '') }))
    .filter((m) => m.name || m.steps);

  if (raw !== undefined && macros.length !== list.length) {
    showSaveNote('Some stored entries were not readable as macros and have been left out. ' +
             'Saving will drop them.', true);
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
  const bytes = byteLength(Object.assign({}, appSettings, { macros: pendingMacros() }));
  const over = bytes > BLOB_MAX;
  meterEl.className = 'note' + (over ? ' warn' : '');
  meterEl.textContent = over
    ? `Settings blob ${bytes} / ${BLOB_MAX} bytes — ${bytes - BLOB_MAX} over. Shorten a ` +
      'macro or a name; the device would reject this save.'
    : `Settings blob ${bytes} / ${BLOB_MAX} bytes. Macros share the device's settings ` +
      'budget with the settings page.';
}

// Store the whole blob, like the settings page does: the device only knows one.
// Anything that fails leaves the list showing what the device holds rather than
// what the failed save hoped to hold.
async function store(next) {
  const bytes = byteLength(Object.assign({}, appSettings, { macros: next }));
  if (bytes > BLOB_MAX) {
    showSaveNote(`Not saved: ${bytes} bytes is over the device's ${BLOB_MAX}-byte limit ` +
                 `by ${bytes - BLOB_MAX}. Shorten a macro.`, true);
    updateMeter();
    return false;
  }

  const previous = appSettings.macros;
  appSettings.macros = next;
  try {
    const r = await saveSettingsToDevice();
    if (!r.ok) {
      appSettings.macros = previous;
      showSaveNote(`Not saved: the device answered HTTP ${r.status}.`, true);
      return false;
    }
  } catch (_) {
    appSettings.macros = previous;
    showSaveNote('Not saved: the device is unreachable.', true);
    return false;
  }

  macros = next.slice();
  showSaveNote('saved to device');
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

for (const [label, token] of CHIPS) {
  chipsEl.appendChild(actionButton(label, () => insertToken(token)));
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
    stopped: () => runAbort,
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
document.getElementById('macroAdd').addEventListener('click', () => openEditor(-1));
saveEl.addEventListener('click', saveEditor);
document.getElementById('editCancel').addEventListener('click', closeEditor);
stepsEl.addEventListener('input', updatePreview);
nameEl.addEventListener('input', updateMeter);

runStopEl.addEventListener('click', () => {
  if (running) runAbort = true;          // the runner notices at the next step
  else runbar.classList.remove('show', 'error');
});

// ---------------------------------------------------------------- start
requireAuth(async () => {
  setStatus('loading settings…', 'warn');
  await loadSettings();
  loadMacros();
  render();
  connect();
});
