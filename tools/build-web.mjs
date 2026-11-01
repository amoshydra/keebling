// Builds the web UI the firmware ships.
//
//   pnpm build
//
// Sources stay in main/web and remain readable: the device only ever sees the
// output in main/web/dist, which is one bundled, minified JavaScript file, one
// minified stylesheet, one minified document and one repair page.
//
// The same run also writes web.zip. That is the unit the device accepts at
// /ui/upload: a whole UI at once, not a file at a time, so an upload cannot
// leave the device running half of two versions.

import { build } from 'esbuild';
import { minify } from 'html-minifier-terser';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'main', 'web');
const OUT = path.join(SRC, 'dist');

const WATCH = process.argv.includes('--watch');

// Everything the device can serve from its filesystem. recover.html is built
// but not listed: it repairs a broken upload, so it must come from the binary.
const PAGES = ['index.html', 'recover.html'];
const ASSETS = ['app.js', 'style.css', ...PAGES];

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function buildOnce() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const js = await build({
    entryPoints: [path.join(SRC, 'app.js')],
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['es2020'],
    legalComments: 'none',
    write: false,
  });

  const css = await build({
    entryPoints: [path.join(SRC, 'style.css')],
    minify: true,
    loader: { '.css': 'css' },
    write: false,
  });

  const out = new Map();
  out.set('app.js', js.outputFiles[0].contents);
  out.set('style.css', css.outputFiles[0].contents);

  for (const page of PAGES) {
    const html = await fs.readFile(path.join(SRC, page), 'utf8');
    out.set(page, Buffer.from(await minify(html, {
      collapseWhitespace: true,
      conservativeCollapse: true,
      removeComments: true,
      removeRedundantAttributes: true,
      useShortDoctype: true,
      minifyCSS: true,
      minifyJS: true,
      // The shell has no <pre>; keep it that way rather than break one later.
      ignoreCustomFragments: [],
    })));
  }

  let total = 0;
  for (const [name, body] of out) {
    await fs.writeFile(path.join(OUT, name), body);
    total += body.length;
  }

  const zip = await buildZip([...out].map(([name, body]) => ({ name, body })));
  await fs.writeFile(path.join(OUT, 'web.zip'), zip);

  const digest = createHash('sha256').update(zip).digest('hex').slice(0, 12);
  console.log(`web ui  ${ASSETS.length} files  ${kb(total)}  ->  main/web/dist/`);
  for (const [name, body] of [...out].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`        ${name.padEnd(13)} ${kb(body.length).padStart(9)}`);
  }
  console.log(`web.zip ${kb(zip.length)}  sha256:${digest}`);
}

// ---------------------------------------------------------------- zip
//
// Stored, not deflated, on purpose: the bundle is already minified, so the
// archive's job is to make a whole UI arrive as one object. Storing it means
// the device needs a header parser, not an inflate implementation.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A fixed timestamp keeps the archive reproducible, so two builds of the same
// sources produce the same sha256 and an unchanged upload can be skipped.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;   // 1980-01-01, the earliest a zip can express

async function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, body } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // method: store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length

    locals.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);              // version made by
    dir.writeUInt16LE(20, 6);              // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);              // method: store
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(body.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);              // extra
    dir.writeUInt16LE(0, 32);              // comment
    dir.writeUInt16LE(0, 34);              // disk
    dir.writeUInt16LE(0, 36);              // internal attrs
    dir.writeUInt32LE(0o644 << 16, 38);    // external attrs
    dir.writeUInt32LE(offset, 42);

    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------- run

await buildOnce();

if (WATCH) {
  console.log('watching main/web …');
  let timer = null;
  const { watch } = await import('node:fs');
  watch(SRC, { recursive: true }, (_event, file) => {
    if (!file || file.startsWith('dist')) return;
    clearTimeout(timer);
    timer = setTimeout(() => buildOnce().catch((e) => console.error(e.message)), 120);
  });
}
