// Pages: the one store behind the Keys strip, the Pages tab and the editor.
//
// A page is rows of items; an item is a key or a spacer; a key spans columns.
// A deck button is a one-column key in a row of four — the old deck and the new
// layouts are the same shape once they are here.
//
// The old stores are read once and then removed. Nothing keeps two forms alive:
// a half-migrated browser is how you get a page that exists in one place and
// not the other.

const KEY = 'esp32remote.pages';

// Read once, then deleted. Order matters: layouts are already pages, the deck
// needs converting.
const LEGACY = [
  'esp32remote.macros',
  'esp32remote.deckPages',
  'esp32remote.deckPage',
  'esp32remote.layouts',
];

const DEFAULT_COLUMNS = 4;
const DEFAULT_ROW_H = 50;

const slug = (name, taken) => {
  const base = String(name || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
};

function loadRaw() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    return Array.isArray(raw) && raw.length ? raw : null;
  } catch (_) {
    return null;
  }
}

export function readPages() {
  return loadRaw() || [];
}

export function writePages(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return null;
  } catch (e) {
    return (e && e.name === 'QuotaExceededError') ? 'no room left in this browser' : 'this browser refused to store it';
  }
}

// A deck button becomes a key: its label, its colour, and whatever it sends.
function keyFromButton(b) {
  const action = b.key
    ? { kind: b.key.kind === 'consumer' ? 'key' : 'key', page: b.key.kind === 'consumer' ? 12 : 7,
        usage: b.key.kind === 'consumer' ? b.key.usage : legacyUsage(b.key.code) }
    : { kind: 'sequence', blocks: Array.isArray(b.blocks) ? b.blocks : [] };
  return {
    label: String(b.name || '').slice(0, 24),
    alt: '',
    w: 1,
    colour: b.colour || '',
    action,
  };
}

// The macro DSL names DOM codes; a consumer usage is stored numerically. This
// is only for converting a held key that was written before codes were kept.
function legacyUsage(code) {
  return code || 0;
}

function pageFromDeck(name, buttons, taken) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += DEFAULT_COLUMNS) {
    rows.push({
      h: DEFAULT_ROW_H,
      gap: 4,
      align: 'stretch',
      keys: buttons.slice(i, i + DEFAULT_COLUMNS).map(keyFromButton),
    });
  }
  return {
    id: slug(name, taken),
    name: String(name || 'Page').slice(0, 24),
    columns: DEFAULT_COLUMNS,
    rows,
  };
}

// One pass, at boot. Returns the pages it settled on.
export function migrate() {
  if (loadRaw()) return readPages();

  const pages = [];
  const taken = new Set();

  // 1. layouts are already pages
  let layouts = [];
  try { layouts = JSON.parse(localStorage.getItem('esp32remote.layouts') || '[]'); } catch (_) {}
  for (const p of Array.isArray(layouts) ? layouts : []) {
    if (!p || !Array.isArray(p.rows)) continue;
    const id = slug(p.id || p.name, taken);
    taken.add(id);
    pages.push({ ...p, id, name: String(p.name || id).slice(0, 24) });
  }

  // 2. deck pages, converted a row at a time
  let macros = [];
  let names = [];
  try { macros = JSON.parse(localStorage.getItem('esp32remote.macros') || '[]'); } catch (_) {}
  try { names = JSON.parse(localStorage.getItem('esp32remote.deckPages') || '[]'); } catch (_) {}

  const list = Array.isArray(macros) ? macros : [];
  const pageNames = [...new Set([
    ...(Array.isArray(names) ? names : []),
    ...list.map((b) => b && b.page).filter(Boolean),
  ])];

  for (const name of pageNames) {
    const buttons = list.filter((b) => b && (b.page || 'Main') === name);
    if (!buttons.length) continue;
    const page = pageFromDeck(name, buttons, taken);
    if (pages.some((p) => p.id === page.id)) page.id = slug(`${page.id}-2`, taken);
    taken.add(page.id);
    pages.push(page);
  }

  if (pages.length) writePages(pages);
  // NOT yet: dropping the old keys now would empty the Deck tab, which still
  // reads them. The cleanup lands with the rewrite of that view.
  return pages;
}

export function dropLegacy() {
  for (const k of LEGACY) {
    try { localStorage.removeItem(k); } catch (_) { /* nothing to do */ }
  }
}

// Import: the same acceptance rule the schema and the editor apply.
export function parsePageFile(text) {
  let data;
  try { data = JSON.parse(text); } catch (_) { return { error: 'that is not JSON' }; }
  if (!data || data.app !== 'keebling' || data.kind !== 'layout') {
    return { error: 'not a keebling layout file' };
  }
  const v = Number(data.version) || 0;
  if (v > 1) return { error: `this file is version ${v}; this build understands 1 — update Keebling first` };
  const allowed = ['app', 'kind', 'version', 'strip', 'pages'];
  const unknown = Object.keys(data).filter((k) => !allowed.includes(k));
  if (unknown.length) return { error: `unknown field${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `“${k}”`).join(', ')}` };

  const pages = Array.isArray(data.pages) ? data.pages : [];
  if (!pages.length) return { error: 'the file has no pages' };
  return { pages, strip: Array.isArray(data.strip) ? data.strip : [] };
}
