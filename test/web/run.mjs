// Web UI test runner. No npm dependencies: it drives a Chromium over the
// DevTools protocol using Node's built-in WebSocket and fetch.
//
//   node test/web/run.mjs            # all tests
//   node test/web/run.mjs --verbose  # print passing test names too
//
// Set CHROME=/path/to/chrome to use a specific browser. Otherwise it picks the
// newest Playwright Chromium already on disk (put there by other tooling).

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { startStub, CODE } from './stub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------- browser
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;

  const roots = [
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'puppeteer'),
  ];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const bin = path.join(root, entry, 'chrome-linux64', 'chrome');
      const alt = path.join(root, entry, 'chrome-linux', 'chrome');
      if (existsSync(bin)) found.push(bin);
      else if (existsSync(alt)) found.push(alt);
    }
  }
  // Newest build number wins.
  found.sort((a, b) => {
    const n = (s) => Number((s.match(/(\d+)/g) || []).pop() || 0);
    return n(b) - n(a);
  });
  if (!found.length) {
    throw new Error('no Chromium found. Install one, or set CHROME=/path/to/chrome');
  }
  return found[0];
}

// ---------------------------------------------------------------- CDP
class Session {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'evaluate failed');
    }
    return r.result?.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) {
      try {
        if (await this.evaluate('document.readyState === "complete"')) return;
      } catch (_) { /* mid-navigation */ }
      await delay(50);
    }
    throw new Error(`navigation to ${url} did not complete`);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await delay(150);
  }
  throw new Error('Chrome never opened its devtools port');
}

// ---------------------------------------------------------------- main
const { server, port: stubPort, device } = await startStub(0);
const base = `http://127.0.0.1:${stubPort}`;

// The device starts with no settings. Macros used to be seeded here; they live
// in the browser now, so the macro page is seeded through localStorage instead
// (see the targets below) and the migration pass gives the device a legacy list
// on purpose.

const debugPort = 9333;
const chrome = spawn(findChrome(), [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--user-data-dir=' + path.join(os.tmpdir(), `webui-test-${process.pid}`),
  'about:blank',
], { stdio: 'ignore' });

let failures = 0;
let passed = 0;

try {
  const wsUrl = await waitForDevtools(debugPort);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  const browser = {
    id: 1,
    send(method, params) {
      const id = this.id++;
      return new Promise((resolve, reject) => {
        const onMsg = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id !== id) return;
          ws.removeEventListener('message', onMsg);
          if (m.error) reject(new Error(m.error.message));
          else resolve(m.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Session(ws, sessionId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  const testSource = readFileSync(path.join(HERE, 'tests.js'), 'utf8');

  // The control page is a phone page first, so it is measured at phone size;
  // the wide pass over it is what keeps the desktop layout honest.
  const PHONE = { width: 360, height: 780, deviceScaleFactor: 2, mobile: true };
  const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };

  // `page` is the group of tests, which is not always the document being
  // navigated to: the wide pass runs the control page's URL again.
  //
  // Macros live in localStorage now, so the macro page is seeded before it
  // loads - seeding after load would only prove the page can be re-rendered.
  const MACROS_STORED = JSON.stringify([
    { name: 'Open Chrome', steps: '{SEARCH}chrome{ENTER}' },
    { name: 'Screenshot', steps: '{CMD+SHIFT+4}' },
    { name: 'Broken', steps: '{NOPE}x' },
  ]);

  const targets = [
    { page: 'control', url: `${base}/?token=${CODE}`, reloadFirst: true, metrics: PHONE },
    // A stored stylesheet before the settings pass, so its reset-all button has
    // something to undo.
    { page: 'settings', url: `${base}/settings.html?token=${CODE}`, metrics: DESKTOP,
      storedUiFiles: { 'style.css': '/* uploaded before the settings pass */' } },
    { page: 'macros', url: `${base}/macros.html?token=${CODE}`, metrics: PHONE,
      seedStorage: { 'esp32remote.macros': MACROS_STORED } },
    // Before the migration pass: that one clears localStorage, which takes the
    // stored access code with it, and this pass relies on the code being there.
    { page: 'control-desktop', url: `${base}/`, metrics: DESKTOP },
    // An untouched browser and a device still holding a list from the old
    // build: the page should adopt it and take it off the device.
    { page: 'macros-migrate', url: `${base}/macros.html?token=${CODE}`, metrics: PHONE,
      clearStorage: true,
      legacyMacros: [{ name: 'Left Behind', steps: '{ENTER}' }] },
    // The upload page, with nothing stored: every file is the built-in one.
    { page: 'ui', url: `${base}/ui.html?token=${CODE}`, metrics: PHONE },
    // ...and the recovery story: index.html has been replaced by a broken
    // upload, so the upload page has to still work and be able to reset it.
    { page: 'ui-broken', url: `${base}/ui.html?token=${CODE}`, metrics: PHONE,
      storedUiFiles: { 'index.html': '<html><body>broken' } },
  ];

  let settingsSaves = [];
  let uiResetsAtSettings = 0;   // /ui/reset calls when the settings pass ended
  let migrationMark = 0;        // device.saved length when the migration pass began

  for (const target of targets) {
    await page.send('Emulation.setDeviceMetricsOverride', target.metrics);

    // localStorage is per-origin and survives navigation, so it is seeded by
    // visiting any page on the origin first.
    if (target.seedStorage || target.clearStorage) {
      await page.goto(base + '/');
      if (target.clearStorage) await page.evaluate('localStorage.clear();');
      for (const [k, v] of Object.entries(target.seedStorage || {})) {
        await page.evaluate(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
      }
    }
    if (target.legacyMacros) {
      device.settings = { usb_product: 'Legacy Product', macros: target.legacyMacros };
      migrationMark = device.saved.length;
    }
    for (const [name, body] of Object.entries(target.storedUiFiles || {})) {
      device.uiFiles.set(name, Buffer.from(body));
    }

    await page.goto(target.url);
    if (target.reloadFirst) {
      // The token is now in localStorage and scrubbed from the URL, so this
      // reload lands on the bare URL - which is exactly the regression we want
      // to catch.
      await page.goto(base + '/');
    }

    await page.evaluate(`window.__CODE = ${JSON.stringify(CODE)};`);
    await page.evaluate(testSource);
    await page.evaluate(`window.__page = ${JSON.stringify(target.page)};`);

    const names = await page.evaluate(`window.__collectTests(${JSON.stringify(target.page)})`);
    if (!names.length) throw new Error(`no tests registered for ${target.page}`);

    console.log(`\n${target.page}`);
    for (const name of names) {
      const r = await page.evaluate(
        `window.__runTest(${JSON.stringify(target.page)}, ${JSON.stringify(name)})`);
      if (r.ok) {
        passed++;
        if (VERBOSE) console.log(`  ok    ${name}`);
      } else {
        failures++;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${r.err}`);
      }
    }

    // What the settings page itself saved, before later pages add their own.
    if (target.page === 'settings') {
      settingsSaves = device.saved.slice();
      uiResetsAtSettings = device.uiResets;
    }
  }

  // The stubbed device records what it was sent, which is how we check the
  // save actually reached it rather than only updating the form.
  const report = (ok, name, detail) => {
    if (ok) {
      passed++;
      if (VERBOSE) console.log(`  ok    ${name}`);
    } else {
      failures++;
      console.log(`\n  FAIL  ${name}`);
      console.log(`        ${detail}`);
    }
  };

  const parse = (s) => { try { return JSON.parse(s); } catch (_) { return {}; } };
  const payloads = device.saved.map(parse);

  const lastSettings = settingsSaves.map(parse).pop() || {};
  report(Number(lastSettings.type_speed) === 35, 'settings reached the device',
    `last settings-page payload: ${JSON.stringify(lastSettings)}`);

  // The line break is the part a JSON round trip can eat: the field is stored
  // as a plain string and the firmware breaks rows on it.
  report(lastSettings.screen_text === 'Bench rig 3\nport 2',
    'screen text reached the device with its line break',
    `last payload carried ${JSON.stringify(lastSettings.screen_text)}`);

  // The restore's device half: the form showing a new value is not evidence the
  // device was told, and this is the payload the restore produced.
  report(lastSettings.usb_product === 'Restored Name',
    'the restored settings reached the device',
    `last payload carried usb_product ${JSON.stringify(lastSettings.usb_product)}`);

  // Macros live in the browser now, so this check runs the other way round:
  // the page must never have put them on the device...
  const withMacros = payloads.find((p) => Array.isArray(p.macros) && p.macros.length);
  report(!withMacros, 'macros were not written to the device',
    `a saved payload carried macros: ${JSON.stringify(withMacros)}`);

  // ...and the one-time migration must have taken the legacy list off it, while
  // leaving the rest of the settings alone.
  const afterMigration = device.saved.slice(migrationMark).map(parse);
  report(afterMigration.some((p) => !('macros' in p) && p.usb_product === 'Legacy Product'),
    'the migrated macro list was taken off the device',
    `payloads after the migration pass: ${JSON.stringify(afterMigration)}`);

  // The settings page's reset-all button has to have reached the device, not
  // just updated its own note.
  report(uiResetsAtSettings > 0, 'the settings page reset reached the device',
    'the stub saw no /ui/reset call during the settings pass');

  // The fallback rule itself, straight at the stub: a stored file wins, and an
  // empty one counts as absent so it cannot shadow a working page. This is the
  // contract ui_fs_open() implements on the device; the page tests above only
  // exercise the happy path.
  const embeddedCss = readFileSync(path.join(HERE, '..', '..', 'main', 'web', 'style.css'), 'utf8');

  device.uiFiles.set('style.css', Buffer.alloc(0));
  const emptyServed = await (await fetch(`${base}/style.css`)).text();
  report(emptyServed === embeddedCss,
    'a zero-length stored file falls back to the embedded copy',
    `served ${emptyServed.length} bytes; the embedded copy is ${embeddedCss.length}`);
  const emptyList = await (await fetch(`${base}/ui/files?token=${CODE}`)).json();
  const emptyEntry = emptyList.files.find((f) => f.name === 'style.css');
  report(emptyEntry.stored === false,
    'a zero-length file is reported as not stored',
    `the listing says ${JSON.stringify(emptyEntry)}`);

  device.uiFiles.set('style.css', Buffer.from('/* stored by the runner */'));
  const storedServed = await (await fetch(`${base}/style.css`)).text();
  report(storedServed === '/* stored by the runner */',
    'a stored file is served in preference to the embedded copy',
    `served "${storedServed.slice(0, 40)}"`);
  device.uiFiles.delete('style.css');

  console.log(`\n${passed} passed, ${failures} failed`);
} finally {
  chrome.kill();
  server.close();
}

process.exit(failures ? 1 : 0);
