// Stub device for the web UI tests.
//
// Serves the real files from main/web and stands in for the firmware's
// endpoints, so the UI can be exercised without hardware. The API shapes here
// mirror main/web_server.c - if you change one, change the other.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', '..', 'main', 'web');

// The access code the stub accepts. Any 12 Crockford characters would do.
export const CODE = 'ABCDEFGHJKMN';

// The TinyUSB keyboard report descriptor, as the macros expand it. Only the
// decoder test needs it, but it is the real thing.
const DESCRIPTOR_HEX =
  '05 01 09 06 A1 01 85 01 05 07 19 E0 29 E7 15 00 25 01 95 08 75 01 81 02 ' +
  '95 01 75 08 81 03 05 08 19 01 29 05 95 05 75 01 91 02 95 01 75 03 91 03 ' +
  '05 07 19 00 2A FF 00 15 00 26 FF 00 95 06 75 08 81 00 C0';

const TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
};

// The names the device accepts for upload, mirroring s_assets in
// main/web_server.c. Anything else is refused, so no path can be invented.
const UI_FILES = [
  'index.html', 'style.css', 'common.js', 'pad.js',
  'settings.html', 'settings.js', 'macros.html', 'macros.js', 'macro.js',
  'ui.html', 'ui.js',
];

// Mirrors UI_UPLOAD_MAX in main/web_server.c.
const UI_MAX = 64 * 1024;

export function startStub(port = 0) {
  // What the "device" holds. Tests can read and change this.
  const device = {
    settings: {},
    saved: [],          // every /settings body the stub received
    restarts: 0,
    forgets: 0,
    uiFiles: new Map(), // name -> Buffer, the uploaded UI files
    uiResets: 0,        // /ui/reset calls, including reset-all
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const authed = (url.searchParams.get('token') || '').toUpperCase() === CODE;

    const json = (o, status = 200) => {
      // Mirrors the firmware: its JSON endpoints are never cached, so a stale
      // answer cannot read as "nothing happened".
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(o));
    };
    const needAuth = () => { if (!authed) { res.writeHead(403); res.end('forbidden'); return false; } return true; };

    const readBody = (cb) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => cb(body));
    };

    switch (p) {
      case '/auth':
        res.writeHead(authed ? 204 : 403);
        res.end();
        return;

      case '/settings':
        if (req.method === 'GET') { if (!needAuth()) return; return json(device.settings); }
        if (req.method === 'POST') {
          if (!needAuth()) return;
          return readBody((b) => {
            device.saved.push(b);
            try { device.settings = JSON.parse(b); } catch (_) { /* ignore */ }
            json({ ok: true });
          });
        }
        res.writeHead(405); res.end(); return;

      case '/hid':
        if (!needAuth()) return;
        return json({
          product: device.settings.usb_product || 'ESP32 Remote',
          manufacturer: device.settings.usb_manufacturer || 'ESP32',
          serial: '44:1B:F6:ED:88:EC',
          interface: device.settings.usb_interface || 'Keyboard Mouse Media',
          endpoint_size: 16,
          poll_interval_ms: 1,
          report_descriptor_len: DESCRIPTOR_HEX.split(' ').length,
          report_descriptor_hex: DESCRIPTOR_HEX,
        });

      case '/scan':
        if (!needAuth()) return;
        return json({ networks: [
          { ssid: 'HomeNet-5G', rssi: -42, secure: true },
          { ssid: 'HomeNet', rssi: -51, secure: true },
          { ssid: 'Guest', rssi: -73, secure: false },
        ] });

      case '/logs':
        if (!needAuth()) return;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('I (1000) wifi_mgr: joined "HomeNet" as 10.0.0.5\n');
        return;

      case '/restart':
        if (!needAuth()) return;
        device.restarts++;
        res.writeHead(200); res.end('restarting'); return;

      case '/forget':
        if (!needAuth()) return;
        device.forgets++;
        res.writeHead(200); res.end('forgotten'); return;

      case '/save':
        if (!needAuth()) return;
        res.writeHead(200); res.end('saved'); return;

      // Mirrors the /ui/* endpoints in main/web_server.c: the whitelist, the
      // size cap and the refusal statuses.
      case '/ui/files':
        if (!needAuth()) return;
        return json({
          mounted: true,
          max_size: UI_MAX,
          total: 320 * 1024,
          used: [...device.uiFiles.values()].reduce((n, b) => n + b.length, 0),
          files: UI_FILES.map((name) => {
            const stored = device.uiFiles.get(name);
            const size = stored && stored.length ? stored.length : 0;
            return {
              name,
              stored: size > 0,
              size,
              embedded: fs.statSync(path.join(WEB, name)).size,
            };
          }),
        });

      case '/ui/upload': {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        if (!needAuth()) return;

        const name = url.searchParams.get('name') || '';
        if (!UI_FILES.includes(name)) { res.writeHead(400); res.end('unknown file'); return; }

        const len = Number(req.headers['content-length'] || 0);
        if (!len) { res.writeHead(400); res.end('empty body'); return; }
        if (len > UI_MAX) {
          // Read the body before refusing, the same as the firmware: a client
          // that is mid-upload then sees the 413 instead of a dead socket.
          req.on('data', () => {});
          req.on('end', () => { res.writeHead(413); res.end('file too large'); });
          return;
        }

        const chunks = [];
        let got = 0;
        req.on('data', (c) => { chunks.push(c); got += c.length; });
        req.on('end', () => {
          if (got !== len) { res.writeHead(400); res.end('upload interrupted'); return; }
          device.uiFiles.set(name, Buffer.concat(chunks));
          res.writeHead(200); res.end('stored');
        });
        return;
      }

      case '/ui/reset': {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        if (!needAuth()) return;
        if (url.searchParams.has('all')) {
          device.uiFiles.clear();
        } else {
          const name = url.searchParams.get('name') || '';
          if (!UI_FILES.includes(name)) { res.writeHead(400); res.end('unknown file'); return; }
          device.uiFiles.delete(name);
        }
        device.uiResets++;
        res.writeHead(200); res.end('reset');
        return;
      }

      case '/ws':
        // The UI must cope with a socket that will not connect; the tests
        // drive the report builders directly rather than over a socket.
        res.writeHead(400); res.end();
        return;

      default:
        break;
    }

    const file = p === '/' ? 'index.html' : p.slice(1);
    const full = path.join(WEB, file);
    if (!full.startsWith(WEB) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    // The firmware serves a stored file in preference to the embedded one, but
    // only when it is non-empty: an empty or interrupted upload must fall back
    // to the copy in the binary rather than shadow a working page.
    const stored = device.uiFiles.get(file);
    const body = stored && stored.length ? stored : fs.readFileSync(full);
    // Mirrors the firmware: these are never cached, so an upload cannot look
    // like it did nothing.
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, device });
    });
  });
}

// Allow `node stub.mjs` for manual poking.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startStub(8101);
  console.log(`stub on http://127.0.0.1:${port}  (code ${CODE})`);
}
