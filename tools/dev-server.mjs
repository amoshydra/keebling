#!/usr/bin/env node
// Development server for the web UI.
//
// The UI normally comes off the device, which means a BOOT-replug-power-cycle
// round trip for every CSS tweak. This serves `main/web/dist`, the built UI, and proxies
// everything else - the REST endpoints and the WebSocket - to a running device,
// so the page still looks same-origin to the browser: no CORS, no token
// changes, no mixed-origin localStorage.
//
//   node tools/dev-server.mjs --device 192.168.1.50
//   node tools/dev-server.mjs --device keebling.local --port 8080
//
// Then open http://localhost:8080/?token=<code>. Edit a file, reload the page.
// Only the firmware needs a flash; the UI does not.

import http from 'node:http';
import net from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The built output, so what is reviewed is exactly what the device would ship.
// Run `pnpm build` (or `pnpm watch`) first.
const ROOT = path.resolve(HERE, '..', 'main', 'web', 'dist');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[name.toUpperCase()] || fallback;
}

const device = arg('device', '');
if (!device) {
  console.error('usage: node tools/dev-server.mjs --device <ip-or-host> [--port 8080]');
  process.exit(1);
}
const port = Number(arg('port', '8080'));
// 127.0.0.1 by default: this proxies an authenticated device, and binding it
// to the whole network is a decision to make on purpose.
const bind = arg('host', '127.0.0.1');
// `--device 192.168.1.50` or `--device 192.168.1.50:8080`; port 80 is the
// device's normal one, the others are for pointing at a test stub.
const [host, devicePort] = (() => {
  const clean = device.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const m = /^([^:]+):(\d+)$/.exec(clean);
  return m ? [m[1], Number(m[2])] : [clean, 80];
})();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// The device refuses a request whose Host or Origin is not its own - that is
// its DNS-rebinding defence, and it is correct. A proxy therefore has to look
// like the device to the device: both headers are rewritten to the device
// address, which is what a browser talking to it directly would send.
function deviceHeaders(req, extra = {}) {
  const out = { ...req.headers, ...extra };
  out.host = devicePort === 80 ? host : `${host}:${devicePort}`;
  if (out.origin) out.origin = `http://${out.host}`;
  return out;
}

// Serve a file from main/web/dist if it exists, otherwise let the device answer.
function localFile(pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return null;            // no escaping the root
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
// Keep-alive sockets keep their Nagle setting too.
upstreamAgent.on('free', (sock) => sock.setNoDelay(true));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // The device serves uploaded UI files from its filesystem; those are not on
  // disk here, so they have to come from the device. Everything else in
  // the built UI wins.
  const file = req.method === 'GET' ? localFile(url.pathname) : null;
  if (file) {
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      // Never cache: the point of this server is that a reload shows the edit.
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
    return;
  }

  const upstream = http.request({
    host,
    port: devicePort,
    method: req.method,
    path: req.url,
    headers: deviceHeaders(req),
    agent: upstreamAgent,
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`device unreachable at ${host}: ${e.message}\n`);
  });
  req.pipe(upstream);
});

// The WebSocket is a plain TCP stream after the upgrade, so pipe bytes both
// ways rather than trying to understand it.
server.on('upgrade', (req, socket, head) => {
  // Pointer reports are 6-13 bytes. With Nagle on, those sit in the buffer
  // waiting for company, and the cursor arrives in clumps - the proxy feels
  // slower than the device even though the round trip is 3ms. Both legs off.
  socket.setNoDelay(true);
  const up = net.connect(devicePort, host, () => {
    up.setNoDelay(true);
    const headers = Object.entries(deviceHeaders(req))
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(port, bind, () => {
  console.log(`serving ${ROOT}`);
  console.log(`proxying everything else to http://${host}:${devicePort}`);
  console.log(`listening on ${bind}:${port}`);
  console.log(`open http://localhost:${port}/?token=<device code>`);
});
