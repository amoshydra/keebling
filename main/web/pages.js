// Pages: the one store behind the Keys strip, the Pages tab and the editor.
//
// A page is rows of items; an item is a key or a spacer; a key spans columns.
// A deck button is a one-column key in a row of four — the old deck and the new
// layouts are the same shape once they are here.
//
// The old stores are read once and removed. Nothing keeps two forms alive: a
// half-migrated browser is how you get a page that exists in one place and not
// the other.

import { HID_KEYS } from './common.js';
import { parseLayoutFile, validPage } from './layout.js';
import { macroText, parseMacro, stepsFromBlocks } from './macro.js';

const KEY = 'esp32remote.pages';
const ACTIVE_KEY = 'esp32remote.pagesActive';

// Read once, then deleted. Order matters: layouts are already pages, the deck
// needs converting.
const LEGACY = [
  'esp32remote.macros',
  'esp32remote.deckPages',
  'esp32remote.deckPage',
  'esp32remote.layouts',
];

export const DEFAULT_COLUMNS = 4;
export const DEFAULT_ROW_H = 50;

const slug = (name, taken) => {
  const base = String(name || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
};

function uniqueName(want, taken) {
  const base = String(want || 'Page').slice(0, 24) || 'Page';
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`.slice(0, 24);
    if (!taken.has(name.toLowerCase())) return name;
  }
}

function hasStore() {
  try { return localStorage.getItem(KEY) !== null; } catch (_) { return false; }
}

function loadRaw() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    return Array.isArray(raw) ? raw : null;
  } catch (_) {
    return null;
  }
}

export function readPages() {
  const list = loadRaw();
  return Array.isArray(list) ? list.filter(validPage) : [];
}

export function writePages(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return null;
  } catch (e) {
    return (e && e.name === 'QuotaExceededError') ? 'no room left in this browser' : 'this browser refused to store it';
  }
}

export function readActive() {
  try { return localStorage.getItem(ACTIVE_KEY) || ''; } catch (_) { return ''; }
}

export function writeActive(id) {
  try { localStorage.setItem(ACTIVE_KEY, String(id || '')); } catch (_) { /* the first page is a fine fallback */ }
}

export function pageById(list, id) {
  return (Array.isArray(list) ? list : []).find((p) => p.id === id) || null;
}

// A new, empty page. One empty row keeps it valid and gives the editor a line
// to drop a key on.
export function newPage(name, takenIds, takenNames) {
  const ids = takenIds instanceof Set ? takenIds : new Set();
  const names = takenNames instanceof Set ? takenNames : new Set();
  const id = slug(name, ids);
  return {
    id,
    name: uniqueName(name, names),
    columns: DEFAULT_COLUMNS,
    rows: [{ h: DEFAULT_ROW_H, gap: 4, align: 'stretch', keys: [] }],
  };
}

// Every key that jumps to this page, as "page · key", so a refusal can name
// what would be broken rather than saying no.
export function referrers(list, id) {
  const out = [];
  for (const pg of Array.isArray(list) ? list : []) {
    for (const row of pg.rows || []) {
      for (const it of row.keys || []) {
        if (it && !it.spacer && it.action && it.action.kind === 'page' && it.action.to === id) {
          out.push(`${pg.name} · ${it.label || 'untitled'}`);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- old stores
// A deck button becomes a key: its label, its colour, and whatever it sends.
function actionFromButton(b) {
  if (b && b.key) {
    if (b.key.kind === 'consumer') {
      return { kind: 'key', page: 12, usage: Number(b.key.usage) || 0, code: b.key.code || '' };
    }
    const code = String(b.key.code || '');
    return { kind: 'key', page: 7, usage: HID_KEYS[code] || 0, code };
  }
  const blocks = stepsFromBlocks(Array.isArray(b && b.blocks) ? b.blocks : null);
  if (blocks.length) return { kind: 'sequence', blocks };
  const text = String((b && b.steps) || '');
  const parsed = parseMacro(text);
  return { kind: 'sequence', blocks: parsed.steps, text };
}

function keyFromButton(b) {
  return {
    label: String((b && b.name) || '').slice(0, 24),
    alt: '',
    w: 1,
    colour: (b && b.colour) || '',
    hold: !!(b && b.hold),
    action: actionFromButton(b),
  };
}

function pageFromButtons(name, buttons, takenIds, takenNames) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += DEFAULT_COLUMNS) {
    rows.push({
      h: DEFAULT_ROW_H,
      gap: 4,
      align: 'stretch',
      keys: buttons.slice(i, i + DEFAULT_COLUMNS).map(keyFromButton),
    });
  }
  if (!rows.length) rows.push({ h: DEFAULT_ROW_H, gap: 4, align: 'stretch', keys: [] });
  const id = slug(name, takenIds);
  return {
    id,
    name: uniqueName(name || 'Page', takenNames),
    columns: DEFAULT_COLUMNS,
    rows,
  };
}

// The device used to hold a macro list. A browser that has not been visited
// since gets that list as a page, and the device copy is removed by the caller
// after the write succeeds.
export function pagesFromLegacyMacros(buttons) {
  const list = Array.isArray(buttons) ? buttons : [];
  if (!list.length) return { pages: [], page: null };
  const ids = new Set();
  const names = new Set();
  const page = pageFromButtons('Main', list, ids, names);
  return { pages: [page], page };
}

// Old layout files predate the store. They are pages already; this only fills
// in what a newer key shape expects.
function normalizeAction(a) {
  if (!a || typeof a !== 'object') return { kind: 'key', page: 7, usage: 0 };
  if (a.kind === 'key') {
    if (a.code && (a.usage === undefined || a.usage === null)) {
      const usage = HID_KEYS[a.code];
      return { kind: 'key', page: usage ? 7 : Number(a.page) || 7, usage: usage || 0, code: a.code };
    }
    return { kind: 'key', page: Number(a.page) || 7, usage: Number(a.usage) || 0, code: a.code || '' };
  }
  if (a.kind === 'sequence' && Array.isArray(a.blocks)) {
    return { kind: 'sequence', blocks: stepsFromBlocks(a.blocks), text: a.text };
  }
  return a;
}

function normalizePage(p, takenIds, takenNames) {
  const id = slug(p.id || p.name, takenIds);
  const rows = (p.rows || []).map((r) => ({
    h: Number(r && r.h) || DEFAULT_ROW_H,
    gap: Number(r && r.gap) || 0,
    align: (r && r.align) || 'stretch',
    keys: (r && Array.isArray(r.keys) ? r.keys : []).map((it) => {
      if (!it || it.spacer) return { spacer: Math.max(1, Number(it && it.spacer) || 1) };
      return { ...it, w: Math.max(1, Number(it.w) || 1), action: normalizeAction(it.action) };
    }),
  }));
  if (!rows.length) rows.push({ h: DEFAULT_ROW_H, gap: 4, align: 'stretch', keys: [] });
  return { ...p, id, name: uniqueName(p.name || id, takenNames), columns: Math.max(1, Math.min(24, Number(p.columns) || DEFAULT_COLUMNS)), rows };
}

// One pass, at boot. Converts every old store into pages and then removes it.
export function migrate() {
  // A browser that ran the additive migration has pages already; its old keys
  // are converted copies, so removing them is the last step of the same move.
  if (hasStore()) {
    const current = readPages();
    if (!current.length) {
      const page = newPage('Main', new Set(), new Set());
      writePages([page]);
      writeActive(page.id);
      dropLegacy();
      return [page];
    }
    dropLegacy();
    return current;
  }

  const pages = [];
  const ids = new Set();
  const names = new Set();

  // 1. layouts are already pages
  let layouts = [];
  try { layouts = JSON.parse(localStorage.getItem('esp32remote.layouts') || '[]'); } catch (_) {}
  for (const p of Array.isArray(layouts) ? layouts : []) {
    if (!p || !Array.isArray(p.rows)) continue;
    const page = normalizePage(p, ids, names);
    ids.add(page.id);
    names.add(page.name.toLowerCase());
    pages.push(page);
  }

  // 2. deck pages, converted a row at a time
  let macros = [];
  let pageNames = [];
  try { macros = JSON.parse(localStorage.getItem('esp32remote.macros') || '[]'); } catch (_) {}
  try { pageNames = JSON.parse(localStorage.getItem('esp32remote.deckPages') || '[]'); } catch (_) {}

  const buttons = Array.isArray(macros) ? macros : [];
  const namesInOrder = [...new Set([
    ...(Array.isArray(pageNames) ? pageNames : []),
    ...buttons.map((b) => b && (b.page || 'Main')).filter(Boolean),
  ])];

  for (const name of namesInOrder) {
    const here = buttons.filter((b) => b && (b.page || 'Main') === name);
    if (!here.length) continue;
    const page = pageFromButtons(name, here, ids, names);
    ids.add(page.id);
    names.add(page.name.toLowerCase());
    pages.push(page);
  }

  if (!pages.length) {
    const page = newPage('Main', ids, names);
    pages.push(page);
  }

  writePages(pages);
  if (!readActive() || !pageById(pages, readActive())) writeActive(pages[0].id);
  dropLegacy();
  return pages;
}

export function dropLegacy() {
  for (const k of LEGACY) {
    try { localStorage.removeItem(k); } catch (_) { /* nothing to do */ }
  }
}

// ---------------------------------------------------------------- import
// Importing is additive, but never silently: an id or a name that already
// exists is suffixed, and a jump inside the incoming file is rewritten to the
// suffixed id so the imported pages still point at each other.
export function mergePages(existing, incoming) {
  const current = Array.isArray(existing) ? existing.slice() : [];
  const ids = new Set(current.map((p) => p.id));
  const names = new Set(current.map((p) => String(p.name).toLowerCase()));
  const remap = new Map();
  const added = [];

  for (const p of Array.isArray(incoming) ? incoming : []) {
    if (!p || !Array.isArray(p.rows)) continue;
    const id = slug(p.id || p.name, ids);
    if (id !== p.id) remap.set(p.id, id);
    ids.add(id);
    const name = uniqueName(p.name || id, names);
    names.add(name.toLowerCase());
    added.push({
      ...p,
      id,
      name,
      columns: Math.max(1, Math.min(24, Number(p.columns) || DEFAULT_COLUMNS)),
      rows: p.rows.map((r) => ({
        ...r,
        keys: (r.keys || []).map((it) => {
          if (!it || it.spacer) return it;
          return { ...it, action: normalizeAction(it.action) };
        }),
      })),
    });
  }

  // A page that jumped to a renamed-away id follows it.
  for (const p of added) {
    for (const row of p.rows) {
      for (const it of row.keys || []) {
        if (it && !it.spacer && it.action && it.action.kind === 'page' && remap.has(it.action.to)) {
          it.action = { ...it.action, to: remap.get(it.action.to) };
        }
      }
    }
  }

  return { pages: current.concat(added), added, remap };
}

export function parsePageFile(text) {
  return parseLayoutFile(text);
}

export { validPage };

// ---------------------------------------------------------------- strip
// One ordered list for the Keys strip: the shipped pages, then user pages. A
// file may place a user page first; the built-ins can be reordered, never
// removed. The order is its own small key because it is a preference, not part
// of any page.
export const STRIP_KEY = 'esp32remote.strip';
export const BUILTINS = [['abc', 'ABC'], ['sym', '?123'], ['fn', 'Fn'], ['kp', 'Num'], ['media', 'Media']];

export function readStrip() {
  try {
    const raw = JSON.parse(localStorage.getItem(STRIP_KEY) || 'null');
    if (Array.isArray(raw) && raw.length) return raw;
  } catch (_) { /* fall through to the shipped order */ }
  return BUILTINS.map(([id]) => id);
}

export function writeStrip(order) {
  try { localStorage.setItem(STRIP_KEY, JSON.stringify(order)); } catch (_) {}
}

// Importing a file's strip is additive: the file's order leads, anything it
// does not mention keeps its place behind it, and every page stays reachable.
export function applyStrip(incoming, remap) {
  const map = remap instanceof Map ? remap : new Map();
  const seen = new Set();
  const out = [];
  const add = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of Array.isArray(incoming) ? incoming : []) {
    if (typeof id !== 'string') continue;
    add(id.startsWith('page:') ? `page:${map.get(id.slice(5)) || id.slice(5)}` : id);
  }
  for (const id of readStrip()) add(id);
  for (const [id] of BUILTINS) add(id);
  for (const p of readPages()) add(`page:${p.id}`);
  writeStrip(out);
  return out;
}
