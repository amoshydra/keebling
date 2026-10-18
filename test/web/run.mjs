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

// What the macro page finds already stored when it loads. The third one is not
// something the DSL can parse, which is what the page has to flag.
device.settings = {
  macros: [
    { name: 'Open Chrome', steps: '{SEARCH}chrome{ENTER}' },
    { name: 'Screenshot', steps: '{CMD+SHIFT+3}' },
    { name: 'Broken', steps: '{NOPE}' },
  ],
};

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
  const targets = [
    { page: 'control', url: `${base}/?token=${CODE}`, reloadFirst: true, metrics: PHONE },
    { page: 'settings', url: `${base}/settings.html?token=${CODE}`, metrics: DESKTOP },
    { page: 'macros', url: `${base}/macros.html?token=${CODE}`, metrics: PHONE },
    { page: 'control-desktop', url: `${base}/`, metrics: DESKTOP },
  ];

  let settingsSaves = [];

  for (const target of targets) {
    await page.send('Emulation.setDeviceMetricsOverride', target.metrics);
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
    if (target.page === 'settings') settingsSaves = device.saved.slice();
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

  // Likewise for a macro edit: the page's own list is not evidence that the
  // device was told.
  report(payloads.some((p) => Array.isArray(p.macros)
      && p.macros.some((m) => m && m.name === 'Test Macro')),
    'macro edits reached the device',
    'no saved payload carried a macro named "Test Macro"');

  console.log(`\n${passed} passed, ${failures} failed`);
} finally {
  chrome.kill();
  server.close();
}

process.exit(failures ? 1 : 0);
