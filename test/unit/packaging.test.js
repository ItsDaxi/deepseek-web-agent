'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
const { buildHostManifest, manifestFileName, geckoId, extensionId } = require('../../host/install.js');
const { buildPackage } = require('../../installer/build-firefox.js');

// Reads a zip file the way an extractor does: through its central directory.
function readZip(file) {
  const bytes = fs.readFileSync(file);
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    const method = bytes.readUInt16LE(cursor + 10);
    const packedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const dataStart = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const packed = bytes.subarray(dataStart, dataStart + packedSize);
    const data = method === 8 ? zlib.inflateRawSync(packed) : packed;
    assert.equal(data.length, size, `${name} has the size the directory says`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('the manifest carries what Firefox needs next to what Chromium needs', () => {
  assert.match(manifest.browser_specific_settings.gecko.id, /^[\w.-]+@[\w.-]+$/);
  assert.equal(manifest.background.service_worker, 'background.js');
  // Firefox runs the background as an event page, which has no importScripts: the library comes first.
  assert.deepEqual(manifest.background.scripts, ['lib/update-check.js', 'lib/agent-pool.js', 'background.js']);
  assert.ok(manifest.permissions.includes('nativeMessaging'));
});

test('every file the manifest names exists', () => {
  const named = [
    manifest.background.service_worker,
    ...manifest.background.scripts,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => [...entry.js, ...(entry.css || [])]),
  ];
  for (const file of named) assert.ok(fs.existsSync(path.join(EXTENSION_DIR, file)), `${file} is missing`);
});

test('the host manifest for Firefox names the extension by its id, and Chromium by its key', () => {
  const firefox = buildHostManifest('firefox', 'C:\\host\\run-host.cmd');
  assert.deepEqual(firefox.allowed_extensions, [geckoId()]);
  assert.equal(firefox.allowed_origins, undefined);
  assert.equal(firefox.name, 'com.dsx.shell_host');
  assert.equal(firefox.type, 'stdio');

  const brave = buildHostManifest('brave', 'C:\\host\\run-host.cmd');
  assert.deepEqual(brave.allowed_origins, [`chrome-extension://${extensionId()}/`]);
  assert.equal(brave.allowed_extensions, undefined);
});

test('Firefox and Chromium keep their host manifests in separate files', () => {
  assert.equal(manifestFileName('firefox'), 'com.dsx.shell_host.firefox.json');
  assert.equal(manifestFileName('chrome'), 'com.dsx.shell_host.json');
});

test('the Firefox package holds the whole extension and a manifest without the Chromium key', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsx-firefox-'));
  try {
    const built = buildPackage({ outDir });
    assert.equal(path.basename(built.path), `dsx-${manifest.version}-firefox-unsigned.zip`);
    const entries = readZip(built.path);

    const onDisk = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        else onDisk.push(prefix + entry.name);
      }
    };
    walk(EXTENSION_DIR, '');
    assert.deepEqual([...entries.keys()].sort(), onDisk.sort());

    const packed = JSON.parse(entries.get('manifest.json').toString('utf8'));
    assert.equal(packed.key, undefined);
    assert.equal(packed.version, manifest.version);
    assert.deepEqual(packed.browser_specific_settings, manifest.browser_specific_settings);
    // Everything else is untouched.
    assert.deepEqual(entries.get('background.js'), fs.readFileSync(path.join(EXTENSION_DIR, 'background.js')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
