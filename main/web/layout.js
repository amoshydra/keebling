// Layouts: user-authored pages, imported as JSON and drawn with the same rules
// the editor uses — a page is rows, a row is a line of columns, a key spans.
//
// Kept in this browser, like the deck, and separate from it: an imported
// layout is a page you brought, not a page the app ships.

const KEY = 'esp32remote.layouts';

export const BUILTIN_STRIP = ['abc', 'sym', 'fn', 'kp'];

export function readLayouts() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(validPage) : [];
  } catch (_) {
    return [];
  }
}

export function writeLayouts(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return null;
  } catch (e) {
    return (e && e.name === 'QuotaExceededError') ? 'no room left in this browser' : 'this browser refused to store it';
  }
}

// The same acceptance rule the editor and the schema apply. Anything that
// fails is refused as a whole rather than half-drawn.
// A file from a newer build may carry an action this build cannot run. Refusing
// it is the only honest answer: importing it would draw a key that does nothing.
const ACTIONS = new Set(['key', 'modifier', 'page', 'sequence']);
export const FORMAT_VERSION = 1;

export function validPage(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(p.id)) return false;
  if (!Array.isArray(p.rows) || !p.rows.length) return false;
  const cols = Number(p.columns);
  if (!(cols >= 1 && cols <= 24)) return false;
  for (const r of p.rows) {
    if (!r || !Array.isArray(r.keys)) return false;
    const total = r.keys.reduce((n, it) => n + (it && it.spacer ? Number(it.spacer) : Number(it.w) || 1), 0);
    if (total > cols) return false;      // a row wider than the page cannot be drawn
    for (const it of r.keys) {
      if (!it || it.spacer) continue;
      if (!it.action || !ACTIONS.has(it.action.kind)) return false;
    }
  }
  return true;
}

export function parseLayoutFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return { error: 'that is not JSON' };
  }
  if (!data || data.app !== 'keebling' || data.kind !== 'layout') {
    return { error: 'not a keebling layout file' };
  }

  // Newer than us: a field or an action we would silently drop.
  const version = Number(data.version) || 0;
  if (version > FORMAT_VERSION) {
    return { error: `this file is version ${version}; this build understands ${FORMAT_VERSION} — update Keebling first` };
  }

  // A misspelled field would import as an empty deck, which looks like our bug.
  const allowed = ['app', 'kind', 'version', 'strip', 'pages'];
  const unknown = Object.keys(data).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    return { error: `unknown field${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `“${k}”`).join(', ')}` };
  }
  const pages = Array.isArray(data.pages) ? data.pages : [];
  if (!pages.length) return { error: 'the file has no pages' };
  const bad = pages.find((p) => !validPage(p));
  if (bad) return { error: `page "${bad.name || bad.id}" is not a valid layout` };
  return { pages, strip: Array.isArray(data.strip) ? data.strip : [] };
}

// ---------------------------------------------------------------- drawing
//
// A key is a web component of one thing: a press target with a label. It sends
// nothing here — the slot owns the transport, and layout.js only draws.

const COLOUR = { blue: 'c-blue', amber: 'c-amber', red: 'c-red', green: 'c-green' };

export function renderPage(host, page) {
  host.textContent = '';
  for (const r of page.rows) {
    const row = document.createElement('div');
    row.className = 'lrow';
    row.style.gridTemplateColumns = `repeat(${page.columns}, minmax(0, 1fr))`;
    row.style.gap = `${Number(r.gap) || 0}px`;
    row.style.height = `${Number(r.h) || 44}px`;

    for (const it of r.keys) {
      const el = document.createElement('div');
      if (it && it.spacer) {
        el.className = 'lspacer';
        el.style.gridColumn = `span ${Number(it.spacer) || 1}`;
      } else {
        el.className = 'lkey' + (COLOUR[it.colour] ? ' ' + COLOUR[it.colour] : '');
        el.style.gridColumn = `span ${Number(it.w) || 1}`;
        el.dataset.action = it.action && it.action.kind || 'key';
        if (it.action && it.action.kind === 'key') el.dataset.usage = String(it.action.usage);
        if (it.action && it.action.kind === 'page') el.dataset.to = it.action.to;
        if (it.action && it.action.kind === 'modifier') el.dataset.mod = it.action.code;

        const label = document.createElement('span');
        label.className = 'lb';
        label.textContent = it.label || '·';
        el.appendChild(label);

        if (it.alt) {
          const alt = document.createElement('span');
          alt.className = 'alt';
          alt.textContent = it.alt;
          el.appendChild(alt);
        }
      }
      row.appendChild(el);
    }
    host.appendChild(row);
  }
}
