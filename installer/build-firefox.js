#!/usr/bin/env node
// Packs the extension for Firefox into dist/<version>/dsx-<version>-firefox-unsigned.zip.
//
//   node installer/build-firefox.js
//
// The package is the extension folder with one change: the "key" of the manifest is left out, because
// it only pins the extension ID in Chromium and Firefox warns about it. Release Firefox only installs
// an extension that Mozilla has signed, so this file is what you hand to the signing service
// (see "Firefox" in the README). The signed file is then named dsx-<version>-firefox.xpi.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const DOS_TIME = 0;
// 1 January 1980, the earliest date a zip can hold, so the same files always give the same package.
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Every file under `dir`, as { name, data } with forward slashes, in a fixed order.
function listFiles(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  return entries.flatMap((entry) => {
    const name = prefix + entry.name;
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, `${name}/`) : [{ name, data: fs.readFileSync(full) }];
  });
}

// A zip file with no extras: local headers, the data, then the central directory.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // The name is UTF-8.
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// The manifest as Firefox gets it.
function firefoxManifest(text) {
  const manifest = JSON.parse(text);
  delete manifest.key;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function buildPackage({ outDir } = {}) {
  const manifestText = fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8');
  const { version } = JSON.parse(manifestText);
  const files = listFiles(EXTENSION_DIR).map((file) => (
    file.name === 'manifest.json' ? { name: file.name, data: Buffer.from(firefoxManifest(manifestText)) } : file
  ));
  const target = path.join(outDir || path.join(ROOT, 'dist', version), `dsx-${version}-firefox-unsigned.zip`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, zip(files));
  return { path: target, version, files: files.map((file) => file.name) };
}

if (require.main === module) {
  const built = buildPackage();
  console.log(`Built ${path.relative(ROOT, built.path)} (${built.files.length} files, ${(fs.statSync(built.path).size / 1024).toFixed(0)} KB)`);
} else {
  module.exports = { buildPackage, firefoxManifest, zip, crc32 };
}
