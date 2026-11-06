#!/usr/bin/env node
// Registers (or removes) the native messaging host for the current user.
// Usage: node host/install.js [--uninstall] [--browsers chrome,brave,chromium,edge]
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST_NAME = 'com.dsx.shell_host';
const HOST_DIR = __dirname;
const EXTENSION_MANIFEST = path.join(HOST_DIR, '..', 'extension', 'manifest.json');

const CHROME_KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts';
const CHROMIUM_KEY = 'HKCU\\Software\\Chromium\\NativeMessagingHosts';

// Brave has no registry path of its own on Windows: its binary only knows the Chromium and Chrome ones.
const WINDOWS_KEYS = {
  chrome: [CHROME_KEY],
  brave: [CHROMIUM_KEY, CHROME_KEY],
  chromium: [CHROMIUM_KEY],
  edge: ['HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts'],
};

const home = os.homedir();
const POSIX_DIRS = {
  darwin: {
    chrome: `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts`,
    brave: `${home}/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts`,
    chromium: `${home}/Library/Application Support/Chromium/NativeMessagingHosts`,
    edge: `${home}/Library/Application Support/Microsoft Edge/NativeMessagingHosts`,
  },
  linux: {
    chrome: `${home}/.config/google-chrome/NativeMessagingHosts`,
    brave: `${home}/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts`,
    chromium: `${home}/.config/chromium/NativeMessagingHosts`,
    edge: `${home}/.config/microsoft-edge/NativeMessagingHosts`,
  },
};

function extensionId() {
  const { key } = JSON.parse(fs.readFileSync(EXTENSION_MANIFEST, 'utf8'));
  const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15)))
    .join('');
}

function writeLauncher() {
  const node = process.execPath;
  const hostScript = path.join(HOST_DIR, 'host.js');
  if (process.platform === 'win32') {
    const launcher = path.join(HOST_DIR, 'run-host.cmd');
    fs.writeFileSync(launcher, `@echo off\r\n"${node}" "${hostScript}"\r\n`);
    return launcher;
  }
  const launcher = path.join(HOST_DIR, 'run-host.sh');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${node}" "${hostScript}"\n`, { mode: 0o755 });
  return launcher;
}

function writeHostManifest(launcher, target) {
  fs.writeFileSync(
    target,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'DeepSeek Shell Tool native host',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId()}/`],
      },
      null,
      2,
    ),
  );
}

function selectedBrowsers() {
  const flag = process.argv.indexOf('--browsers');
  if (flag === -1) return Object.keys(WINDOWS_KEYS);
  return process.argv[flag + 1].split(',').map((name) => name.trim());
}

function installWindows(browsers) {
  const manifest = path.join(HOST_DIR, `${HOST_NAME}.json`);
  writeHostManifest(writeLauncher(), manifest);
  for (const browser of browsers) {
    for (const parent of WINDOWS_KEYS[browser]) {
      const key = `${parent}\\${HOST_NAME}`;
      execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'], { stdio: 'ignore' });
    }
    console.log(`Registered for ${browser}`);
  }
}

function uninstallWindows(browsers) {
  for (const browser of browsers) {
    for (const parent of WINDOWS_KEYS[browser]) {
      try {
        execFileSync('reg', ['delete', `${parent}\\${HOST_NAME}`, '/f'], { stdio: 'ignore' });
      } catch {
        // The key was not registered for this browser.
      }
    }
    console.log(`Removed for ${browser}`);
  }
}

function installPosix(browsers) {
  const dirs = POSIX_DIRS[process.platform];
  if (!dirs) throw new Error(`Unsupported platform: ${process.platform}`);
  const launcher = writeLauncher();
  for (const browser of browsers) {
    fs.mkdirSync(dirs[browser], { recursive: true });
    writeHostManifest(launcher, path.join(dirs[browser], `${HOST_NAME}.json`));
    console.log(`Registered for ${browser}`);
  }
}

function uninstallPosix(browsers) {
  const dirs = POSIX_DIRS[process.platform] || {};
  for (const browser of browsers) {
    if (dirs[browser]) fs.rmSync(path.join(dirs[browser], `${HOST_NAME}.json`), { force: true });
  }
}

const browsers = selectedBrowsers();
const uninstall = process.argv.includes('--uninstall');
if (process.platform === 'win32') {
  (uninstall ? uninstallWindows : installWindows)(browsers);
} else {
  (uninstall ? uninstallPosix : installPosix)(browsers);
}
console.log(uninstall ? 'Native host removed.' : `Native host installed for extension ${extensionId()}.`);
