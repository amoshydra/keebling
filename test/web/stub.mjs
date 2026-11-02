// Stub device for the web UI tests.
//
// Serves the real files from main/web and stands in for the firmware's
// endpoints, so the UI can be exercised without hardware. The API shapes here
// mirror main/web_server.c - if you change one, change the other.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The built UI, which is what the firmware ships and therefore what the tests
// must exercise. Run `pnpm build` first.
const WEB = path.join(HERE, '..', '..', 'main', 'web', 'dist');

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
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

// The built-in files, which are also what the firmware embeds.
const UI_FILES = ['index.html', 'style.css', 'app.js'];

// Mirrors safe_file_name() in main/web_server.c: one or two segments, each a
// plain name, so ".." cannot be spelled; two names reserved.
function safeName(name) {
  if (!name || name.length >= 128) return false;
  const parts = name.split('/');
  if (parts.length > 2) return false;
  for (const part of parts) {
    if (!part || part.length >= 64) return false;
    if (part.startsWith('.')) return false;
    if (!/^[A-Za-z0-9._-]+$/.test(part)) return false;
  }
  const base = parts[parts.length - 1];
  if (base === 'recover.html') return false;
  if (base.endsWith('.tmp')) return false;
  return true;
}

// Mirrors UI_ARCHIVE_MAX in main/web_server.c: the cap on a whole archive.
const UI_MAX = 192 * 1024;
const UI_ENTRY_MAX = 96 * 1024;

// Reads a stored zip, mirroring ui_upload_handler: local headers only, names
// matched against the whitelist, sizes checked, deflate refused.
function readStoredZip(buf) {
  const err = (status, why) => Object.assign(new Error(why), { status });
  const out = [];
  let at = 0;
  for (;;) {
    if (at + 4 > buf.length) throw err(400, 'body ended early');
    const sig = buf.readUInt32LE(at);
    if (sig === 0x02014b50 || sig === 0x06054b50) return out;   // central directory
    if (sig !== 0x04034b50) throw err(400, 'not a stored zip');
    if (at + 30 > buf.length) throw err(400, 'body ended early');

    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    if (method !== 0) throw err(400, 'archive must be stored, not deflated');
    if (!size) throw err(400, 'empty entry');
    if (size > UI_ENTRY_MAX) throw err(400, 'entry too large');
    if (!nameLen || nameLen >= 32) throw err(400, 'bad entry name');

    const nameAt = at + 30;
    const name = buf.toString('utf8', nameAt, nameAt + nameLen);
    if (!safeName(name)) throw err(400, 'bad file name');
    if (out.some((e) => e.name === name)) throw err(400, 'duplicate entry');

    const bodyAt = nameAt + nameLen + extraLen;
    if (bodyAt + size > buf.length) throw err(408, 'upload interrupted');
    out.push({ name, body: buf.subarray(bodyAt, bodyAt + size) });
    at = bodyAt + size;
  }
}

// Mirrors the screen image formats in main/screen_image.h: an 8-byte header
// (format, reserved, payload length, CRC-32) and a packed payload - 6,400 bytes
// of 4-bit greyscale, or 25,600 bytes of little-endian RGB565.
const SCREEN_IMAGE = {
  0x01: { header: 8, payload: 6400, file: 6408 },
  0x02: { header: 8, payload: 25600, file: 25608 },
};
const SCREEN_IMAGE_FILES = Object.values(SCREEN_IMAGE).map((f) => f.file);

// The same rule the firmware applies before it will draw: the format byte picks
// the payload size, and the file size, the length field and the CRC all have to
// agree with it. A 0x02 header in a 6,408-byte body fails here exactly as it
// would there - the disagreement is refused rather than guessed at.
function screenImageOk(b) {
  if (b.length < 8) return false;
  const f = SCREEN_IMAGE[b[0]];
  if (!f || b.length !== f.file) return false;
  if (b[1] !== 0) return false;
  if (b.readUInt16LE(2) !== f.payload) return false;
  return zlib.crc32(b.subarray(f.header)) === b.readUInt32LE(4);
}

export function startStub(port = 0) {
  // What the "device" holds. Tests can read and change this.
  const device = {
    // The host's lock keys, for the Keys view's badge.
    ledsKnown: true, num: false, caps: false, scroll: false,
    settings: {},
    saved: [],          // every /settings body the stub received
    restarts: 0,
    forgets: 0,
    uiFiles: new Map(), // name -> Buffer, the uploaded UI files
    uiResets: 0,        // /ui/reset calls, including reset-all
    screenImage: null,  // Buffer, the stored screen.img (null = nothing)
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

      case '/state':
        if (!needAuth()) return;
        if (req.method === 'POST') {
          // Test-only: the real device answers from the USB LED report.
          return readBody((b) => {
            let next = {};
            try { next = JSON.parse(b); } catch (_) { /* ignore */ }
            for (const k of ['known', 'num', 'caps', 'scroll']) {
              if (next[k] !== undefined) {
                device[k === 'known' ? 'ledsKnown' : k] = next[k];
              }
            }
            json({ ok: true });
          });
        }
        return json({
          known: device.ledsKnown !== false,
          num: !!device.num,
          caps: !!device.caps,
          scroll: !!device.scroll,
        });

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
      case '/network':
        if (!needAuth()) return;
        return json({
          state: 'joined',
          ssid: 'home-wifi',
          ip: '192.168.1.42',
          ap_ip: '',
          clients: 0,
        });

      case '/ui/files':
        if (!needAuth()) return;
        return json({
          mounted: true,
          max_size: UI_MAX,
          total: 320 * 1024,
          used: [...device.uiFiles.values()].reduce((n, b) => n + b.length, 0),
          files: [
            ...[...device.uiFiles].map(([name, body]) => ({
              name,
              stored: body.length > 0,
              size: body.length,
              embedded: UI_FILES.includes(name) ? fs.statSync(path.join(WEB, name)).size : 0,
            })),
            ...UI_FILES
              .filter((name) => !device.uiFiles.has(name))
              .map((name) => ({
                name,
                stored: false,
                size: 0,
                embedded: fs.statSync(path.join(WEB, name)).size,
              })),
          ],
        });

      case '/ui/upload': {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        if (!needAuth()) return;

        const len = Number(req.headers['content-length'] || 0);
        if (!len) { res.writeHead(400); res.end('empty body'); return; }
        if (len > UI_MAX) {
          // Read the body before refusing, the same as the firmware: a client
          // that is mid-upload then sees the 413 instead of a dead socket.
          req.on('data', () => {});
          req.on('end', () => { res.writeHead(413); res.end('archive too large'); });
          return;
        }

        const chunks = [];
        let got = 0;
        req.on('data', (c) => { chunks.push(c); got += c.length; });
        req.on('end', () => {
          if (got !== len) { res.writeHead(408); res.end('upload interrupted'); return; }
          let entries;
          try {
            entries = readStoredZip(Buffer.concat(chunks));
          } catch (e) {
            res.writeHead(e.status || 400); res.end(e.message);
            return;
          }
          if (!entries.length) { res.writeHead(400); res.end('no files'); return; }
          // All or nothing: the firmware renames only once every entry is in,
          // then drops whatever the archive did not carry.
          for (const [name] of device.uiFiles) {
            if (!entries.some((e) => e.name === name)) device.uiFiles.delete(name);
          }
          for (const e of entries) device.uiFiles.set(e.name, Buffer.from(e.body));
          res.writeHead(200); res.end(`${entries.length} files stored`);
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
          if (!safeName(name)) { res.writeHead(400); res.end('unknown file'); return; }
          device.uiFiles.delete(name);
        }
        device.uiResets++;
        res.writeHead(200); res.end('reset');
        return;
      }

      case '/screen/image': {
        if (!needAuth()) return;

        if (req.method === 'GET') {
          if (!device.screenImage) { res.writeHead(404); res.end('no image'); return; }
          // The firmware sends the whole file, header included, so the page can
          // check the format and the CRC for itself.
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          res.end(device.screenImage);
          return;
        }
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

        const len = Number(req.headers['content-length'] || 0);
        if (!SCREEN_IMAGE_FILES.includes(len)) {
          // Read the body before refusing, the same as the firmware: a client
          // that is mid-upload then sees the 400 instead of a dead socket.
          req.on('data', () => {});
          req.on('end', () => { res.writeHead(400); res.end('expected 6408 or 25608 bytes'); });
          return;
        }

        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          if (body.length !== len || !screenImageOk(body)) {
            // Nothing is stored, so a tap can never land on a garbage screen.
            res.writeHead(400); res.end('invalid image'); return;
          }
          device.screenImage = body;
          res.writeHead(200); res.end('stored');
        });
        return;
      }

      case '/screen/reset':
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        if (!needAuth()) return;
        device.screenImage = null;
        res.writeHead(200); res.end('reset');
        return;

      case '/ws':
        // The UI must cope with a socket that will not connect; the tests
        // drive the report builders directly rather than over a socket.
        res.writeHead(400); res.end();
        return;

      default:
        break;
    }

    const file = p === '/' ? 'index.html' : p.slice(1);
    const builtIn = path.join(WEB, file);
    const hasBuiltIn = builtIn.startsWith(WEB) && fs.existsSync(builtIn) &&
      fs.statSync(builtIn).isFile();

    // A stored file wins, and is not limited to the built-in names: the device
    // serves any flat name in its partition, which is what lets a user's own
    // bundler ship whatever it emits.
    const stored = device.uiFiles.get(file);
    const body = stored && stored.length ? stored : (hasBuiltIn ? fs.readFileSync(builtIn) : null);
    if (!body) { res.writeHead(404); res.end('not found'); return; }

    // Mirrors the firmware: these are never cached, so an upload cannot look
    // like it did nothing.
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
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
