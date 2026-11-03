// A page is rows of items, an item is a key or a spacer, and a key spans
// columns. This file owns that shape: what a valid page is, how a file becomes
// pages, and the one renderer both the Pages tab and the Keys slot draw with.
//
// It does not own storage. The store is pages.js, and the transport is the
// view that draws the page: a key is a picture with data on it, never a socket.

export const FORMAT_VERSION = 1;
export const ACTIONS = new Set(['key', 'modifier', 'page', 'sequence']);
export const BUILTIN_STRIP = ['abc', 'sym', 'fn', 'kp', 'media'];

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
      if (it.action.kind === 'page' && typeof it.action.to !== 'string') return false;
    }
  }
  return true;
}

// A file from a newer build may carry an action this build cannot run. Refusing
// it is the only honest answer: importing it would draw a key that does nothing.
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
// The renderer draws rows at their stated height and columns at their span.
// Interaction is data, not listeners: the caller owns the transport and reads
// data-action / data-usage / data-to / data-mod. Options:
//
//   className   added to the host
//   decorate(el, item, info)  fills a key instead of the default label/alt
//   fit         scale the page down to its container, to a floor of 50%
//
// The Pages tab uses decorate for the tile chrome (name, source, edit actions);
// the Keys slot uses the default, which is the key as it will look on glass.

const COLOUR = { grey: 'c-grey', blue: 'c-blue', amber: 'c-amber', red: 'c-red', green: 'c-green' };

export function renderPage(host, page, opts = {}) {
  host.textContent = '';
  if (opts.className) host.classList.add(opts.className);
  host.classList.add('pagegrid');

  page.rows.forEach((r, ri) => {
    const row = document.createElement('div');
    row.className = 'lrow';
    row.dataset.row = String(ri);
    row.style.gridTemplateColumns = `repeat(${page.columns}, minmax(0, 1fr))`;
    row.style.gap = `${Number(r.gap) || 0}px`;
    row.style.height = `${Number(r.h) || 44}px`;

    r.keys.forEach((it, ki) => {
      const el = document.createElement('div');
      if (it && it.spacer) {
        el.className = 'lspacer';
        el.style.gridColumn = `span ${Math.max(1, Math.min(page.columns, Number(it.spacer) || 1))}`;
      } else {
        el.className = 'lkey' + (COLOUR[it.colour] ? ' ' + COLOUR[it.colour] : '');
        el.style.gridColumn = `span ${Math.max(1, Math.min(page.columns, Number(it.w) || 1))}`;
        const a = it.action || { kind: 'key' };
        el._pageAction = a;
        el.dataset.action = a.kind;
        el.dataset.index = String(ki);
        if (a.kind === 'key') {
          el.dataset.page = String(a.page || 7);
          el.dataset.usage = String(a.usage !== undefined ? a.usage : '');
          if (a.code) el.dataset.code = a.code;
        }
        if (a.kind === 'page') el.dataset.to = a.to || '';
        if (a.kind === 'modifier') el.dataset.mod = a.code || '';
        if (a.kind === 'sequence') el.dataset.sequence = '1';

        if (typeof opts.decorate === 'function') {
          opts.decorate(el, it, { row: ri, key: ki });
        } else {
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
      }
      row.appendChild(el);
    });
    host.appendChild(row);
  });

  if (opts.fit) fitPage(host, page);
}

// A page keeps its proportions when it does not fit: it shrinks as a whole to
// half size, and below that the slot scrolls. Scaling only the width would make
// a tall page's keys shorter than they are tall, which is not the page any more.
export function fitPage(host, page) {
  host.style.transform = '';
  host.style.width = '';
  const natural = page.rows.reduce((n, r) => n + (Number(r.h) || 44), 0)
    + page.rows.reduce((n, r) => n + (Number(r.gap) || 0), 0);
  const avail = Math.max(120, Math.round((window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.48));
  if (!natural || natural <= avail) return;
  const scale = Math.max(0.5, avail / natural);
  if (scale >= 1) return;
  host.style.transformOrigin = 'top left';
  host.style.transform = `scale(${scale.toFixed(3)})`;
  host.style.width = `${(100 / scale).toFixed(2)}%`;
}
