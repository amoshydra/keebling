// Router: one shell, one mounted view at a time.
//
// Each view's markup lives in a <template> in index.html. Templates are inert,
// so their IDs do not exist until the content is cloned into <main>. That is
// what lets the four views keep their own `dot`, `statusText` and friends
// without prefixing anything: only one set exists in the document at a time.
//
// The hash is the route. Changing it is a history entry, so Refresh,
// Back and Forward all land on the view the URL names. An unknown hash mounts
// the control view rather than leaving an empty screen.
//
// init()/destroy() are the whole lifecycle contract: destroy() runs before the
// outgoing view's DOM is replaced, so it can release held keys and close its
// socket while they still exist.


import { PadView } from './pad.js';
import { MacrosView } from './macros.js';
import { SettingsView } from './settings.js';
import { appSettings, loadSettings, requireAuth } from './common.js';

// The UI-files page is a repair tool, not the pad. It is a separate file so the
// app stays under the device's per-file upload limit, and it is loaded when its
// route is opened.
const loadUiView = () => import('./ui.js').then((m) => m.UiView);

export const Router = (() => {
  const main = document.getElementById('view');

  const control = () => (typeof PadView === 'undefined' ? null : PadView);
  const ROUTES = {
    '/':       { view: control, template: 'view-control', name: 'control' },
    // Keys is the same surface with the keyboard slot open. Two modes of one
    // view rather than two copies of the pad.
    '/keys':   { view: control, template: 'view-control', name: 'control' },
    '/deck':   { view: () => (typeof MacrosView === 'undefined' ? null : MacrosView),
                 template: 'view-macros',   name: 'macros' },
    '/setup':  { view: () => (typeof SettingsView === 'undefined' ? null : SettingsView),
                 template: 'view-settings', name: 'settings' },
    // Kept so old links, bookmarks and the back stack still land somewhere.
    '/macros': { view: () => (typeof MacrosView === 'undefined' ? null : MacrosView),
                 template: 'view-macros',   name: 'macros' },
    '/settings': { view: () => (typeof SettingsView === 'undefined' ? null : SettingsView),
                   template: 'view-settings', name: 'settings' },
    '/ui':     { view: loadUiView, template: 'view-ui', name: 'ui' },
  };

  // Which tab a route belongs to. Several routes can share one tab.
  const TAB_FOR = {
    '/': 'remote', '/keys': 'keys',
    '/deck': 'deck', '/macros': 'deck',
    '/setup': 'setup', '/settings': 'setup', '/ui': 'setup',
  };

  // A route may carry a section: "/setup/network" is the Setup view showing one
  // of its pages. Only the views that own sections accept one, so a stray
  // "/keys/anything" is still an unknown route.
  const NESTED = new Set(['/setup', '/settings']);

  function splitPath(path) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return { base: '/', sub: '' };
    return { base: '/' + parts[0], sub: parts.slice(1).join('/') };
  }

  let current = null;      // the base route currently mounted
  let currentView = null;  // its resolved view object
  let started = false;

  function pathFromHash() {
    let path = location.hash.replace(/^#/, '');
    if (!path) return '/';
    if (path[0] !== '/') path = '/' + path;

    const { base, sub } = splitPath(path);
    // Unknown hashes fall back to the control view. The hash is left alone so
    // the address bar shows what was asked for, and Back still works.
    if (!Object.prototype.hasOwnProperty.call(ROUTES, base)) return '/';
    if (sub && !NESTED.has(base)) return '/';
    return sub ? `${base}/${sub}` : base;
  }

  function markActive(path) {
    const tab = TAB_FOR[path];
    for (const link of document.querySelectorAll('.tabbar a')) {
      link.classList.toggle('active', link.dataset.tab === tab);
      if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  function unmount() {
    if (!current) return;
    if (currentView && typeof currentView.destroy === 'function') {
      currentView.destroy();       // release keys, sockets, window listeners
    }
    main.replaceChildren();
    delete main.dataset.view;
    current = null;
    currentView = null;
  }

  async function mount(path, preloaded) {
    unmount();

    const route = ROUTES[path];
    const template = document.getElementById(route.template);
    if (!template) return;

    main.dataset.view = route.name;
    main.appendChild(template.content.cloneNode(true));
    current = path;
    markActive(path);

    const view = preloaded || await route.view();
    currentView = view;
    if (!view) {
      // A stored copy of one view script can be broken without taking the
      // shell with it. Say so here rather than leaving a blank screen.
      const p = document.createElement('p');
      p.className = 'wrap note';
      p.textContent = `This view's script did not load (${path}). Use the UI files page to reset it.`;
      main.appendChild(p);
      return;
    }
    view.init();
  }

  async function route() {
    const path = pathFromHash();
    const { base, sub } = splitPath(path);

    // Moving between sections of the same view is not a remount: the settings
    // form is a live document with a debounce, and tearing it down would throw
    // away what was typed and re-fetch everything from the device.
    const route = ROUTES[base];
    const view = current === base ? currentView : (route ? await route.view() : null);
    if (current === base && view && typeof view.show === 'function') {
      markActive(base);
      view.show(sub);
      return;
    }
    await mount(base, view);
  }

  async function start() {
    if (started) return;
    started = true;

    // The pad's gesture tuning, the settings form and a legacy macro list all
    // read appSettings, so load it once before the first view mounts.
    await loadSettings();
    await route();
    window.addEventListener('hashchange', () => { route(); });
  }

  // The access gate runs once, on the shell. A view never prompts for a code.
  requireAuth(start);

  return {
    route,
    mount,
    get current() { return current; },
    pathFromHash,
  };
})();