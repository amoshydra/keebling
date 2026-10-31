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

const Router = (() => {
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
    '/ui':     { view: () => (typeof UiView === 'undefined' ? null : UiView),
                 template: 'view-ui',       name: 'ui' },
  };

  // Which tab a route belongs to. Several routes can share one tab.
  const TAB_FOR = {
    '/': 'remote', '/keys': 'keys',
    '/deck': 'deck', '/macros': 'deck',
    '/setup': 'setup', '/settings': 'setup', '/ui': 'setup',
  };

  let current = null;      // the route path currently mounted
  let started = false;

  function pathFromHash() {
    let path = location.hash.replace(/^#/, '');
    if (!path) return '/';
    if (path[0] !== '/') path = '/' + path;
    // Unknown hashes fall back to the control view. The hash is left alone so
    // the address bar shows what was asked for, and Back still works.
    return Object.prototype.hasOwnProperty.call(ROUTES, path) ? path : '/';
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
    const view = ROUTES[current].view();
    if (view) view.destroy();      // release keys, sockets, window listeners
    main.replaceChildren();
    delete main.dataset.view;
    current = null;
  }

  function mount(path) {
    unmount();

    const route = ROUTES[path];
    const template = document.getElementById(route.template);
    if (!template) return;

    main.dataset.view = route.name;
    main.appendChild(template.content.cloneNode(true));
    current = path;
    markActive(path);

    const view = route.view();
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

  function route() {
    mount(pathFromHash());
  }

  async function start() {
    if (started) return;
    started = true;

    // The pad's gesture tuning, the settings form and a legacy macro list all
    // read appSettings, so load it once before the first view mounts.
    await loadSettings();
    route();
    window.addEventListener('hashchange', route);
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
