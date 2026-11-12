// File tools for the model: read, write, edit, glob and grep.
// The host runs each call in a worker thread, so it can stop one that takes too long, such as a
// regular expression that never finishes.
'use strict';

const { isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_OUTPUT_CHARS = 18000;
const MAX_LINE_CHARS = 2000;
const DEFAULT_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 250;
const BINARY_PROBE_BYTES = 8192;
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache']);
// Searches never open these. Reading one by its exact path goes through approval instead.
const SENSITIVE_FILE = /(^|[\\/])(\.env(\.[^\\/]*)?|\.netrc|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.[^\\/]*)?|[^\\/]*\.(pem|key|pfx|p12))$|(^|[\\/])(\.ssh|\.aws|\.gnupg)([\\/]|$)/i;

// Files the model cannot read as text but the chat can: DeepSeek's own upload turns a PDF or an Office document
// into text, and reads the text in an image. `read` does not print these, it attaches them to the next message.
const ATTACHMENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  apng: 'image/apng',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
};
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

class ToolError extends Error {}

// The media type of a file `read` attaches instead of printing, or null for anything else.
function attachmentType(file) {
  const extension = path.extname(file).slice(1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_TYPES, extension) ? ATTACHMENT_TYPES[extension] : null;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Checks the file and describes it. The host sends the bytes itself once the call has finished.
function attach(file, mime) {
  let stats;
  try {
    stats = fs.statSync(file);
  } catch {
    throw new ToolError(`File not found: ${file}`);
  }
  if (stats.isDirectory()) throw new ToolError(`${file} is a folder. Use glob to list what is inside.`);
  if (stats.size === 0) throw new ToolError(`${file} is empty.`);
  if (stats.size > MAX_ATTACHMENT_BYTES) {
    throw new ToolError(`${file} is too large to attach (${formatSize(stats.size)}). The limit is ${formatSize(MAX_ATTACHMENT_BYTES)}.`);
  }
  const name = path.basename(file);
  return {
    text: `Attached ${name} (${formatSize(stats.size)}, ${mime}) to this message. The chat reads it for you: look at it in the message that carries this result.`,
    attachment: { path: file, name, mime, size: stats.size },
  };
}

function resolvePath(target, cwd) {
  const base = cwd || os.homedir();
  return target ? path.resolve(base, target) : base;
}

function looksBinary(buffer) {
  return buffer.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

function readText(file) {
  let stats;
  try {
    stats = fs.statSync(file);
  } catch {
    throw new ToolError(`File not found: ${file}`);
  }
  if (stats.isDirectory()) throw new ToolError(`${file} is a folder. Use glob to list what is inside.`);
  if (stats.size > MAX_READ_BYTES) throw new ToolError(`${file} is too large to read (${stats.size} bytes).`);
  const buffer = fs.readFileSync(file);
  if (looksBinary(buffer)) throw new ToolError(`${file} looks like a binary file.`);
  return buffer.toString('utf8');
}

function read({ path: target, cwd, offset, limit }) {
  if (!target) throw new ToolError('read needs a path.');
  const file = resolvePath(target, cwd);
  const mime = attachmentType(file);
  if (mime) return attach(file, mime);
  const text = readText(file);
  if (text === '') return `${file} is empty.`;

  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const first = Math.max(Number(offset) || 1, 1);
  const count = Math.max(Number(limit) || DEFAULT_READ_LINES, 1);
  if (first > lines.length) throw new ToolError(`${file} has only ${lines.length} lines.`);

  const output = [];
  let chars = 0;
  let line = first;
  for (; line <= lines.length && line < first + count; line += 1) {
    const raw = lines[line - 1];
    const shown = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)} [line cut]` : raw;
    const row = `${line}\t${shown}`;
    if (chars + row.length > MAX_OUTPUT_CHARS && output.length) break;
    output.push(row);
    chars += row.length + 1;
  }
  const last = line - 1;
  if (first > 1 || last < lines.length) {
    output.push(`[Showing lines ${first}-${last} of ${lines.length}. Use offset to read more.]`);
  }
  return output.join('\n');
}

function write({ path: target, cwd, body }) {
  if (!target) throw new ToolError('write needs a path.');
  const file = resolvePath(target, cwd);
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body || '', 'utf8');
  return `${existed ? 'Replaced' : 'Created'} ${file} (${Buffer.byteLength(body || '')} bytes).`;
}

function parseEdit(body) {
  const match = /<dsx:old>([\s\S]*?)<\/dsx:old>\s*<dsx:new>([\s\S]*?)<\/dsx:new>/.exec(body || '');
  if (!match) throw new ToolError('edit needs <dsx:old> and <dsx:new> blocks.');
  return { oldText: match[1], newText: match[2] };
}

function edit({ path: target, cwd, body, replace_all: replaceAll }) {
  if (!target) throw new ToolError('edit needs a path.');
  const file = resolvePath(target, cwd);
  const text = readText(file);
  let { oldText, newText } = parseEdit(body);
  if (oldText === '') throw new ToolError('The old text is empty.');
  if (oldText === newText) throw new ToolError('The old and new text are the same.');

  // Models write \n even when a file uses \r\n.
  if (!text.includes(oldText) && text.includes('\r\n')) {
    const toCrlf = (value) => value.replace(/\r?\n/g, '\r\n');
    oldText = toCrlf(oldText);
    newText = toCrlf(newText);
  }
  const occurrences = text.split(oldText).length - 1;
  if (occurrences === 0) throw new ToolError(`The old text was not found in ${file}. Read the file and copy it exactly.`);
  const all = replaceAll === true || replaceAll === 'true';
  if (occurrences > 1 && !all) {
    throw new ToolError(`The old text appears ${occurrences} times in ${file}. Include more surrounding lines, or set replace_all="true".`);
  }
  fs.writeFileSync(file, text.split(oldText).join(newText), 'utf8');
  return `Edited ${file} (${all ? occurrences : 1} replacement${all && occurrences !== 1 ? 's' : ''}).`;
}

function globToRegExp(pattern) {
  let source = '';
  let braces = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') {
      source += '(?:';
      braces += 1;
    } else if (char === '}' && braces) {
      source += ')';
      braces -= 1;
    } else if (char === ',' && braces) source += '|';
    else source += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

// Visits every file below root, without following links or entering skipped and sensitive folders.
function walk(root, visit) {
  const pending = [root];
  while (pending.length) {
    const folder = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name) && !SENSITIVE_FILE.test(full)) pending.push(full);
      } else if (entry.isFile() && visit(full) === false) {
        return;
      }
    }
  }
}

function relativePosix(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function glob({ path: target, cwd, body }) {
  const pattern = (body || '').trim();
  if (!pattern) throw new ToolError('glob needs a pattern.');
  const root = resolvePath(target, cwd);
  if (!fs.existsSync(root)) throw new ToolError(`Folder not found: ${root}`);
  const matcher = globToRegExp(pattern);
  const found = [];
  let more = false;
  walk(root, (file) => {
    if (SENSITIVE_FILE.test(file) || !matcher.test(relativePosix(root, file))) return true;
    if (found.length >= MAX_GLOB_RESULTS) {
      more = true;
      return false;
    }
    found.push(file);
    return true;
  });
  if (!found.length) return `No files match ${pattern} in ${root}.`;
  const times = new Map(found.map((file) => [file, fs.statSync(file).mtimeMs]));
  found.sort((a, b) => times.get(b) - times.get(a));
  const lines = [`Files in ${root}, newest first:`, ...found.map((file) => relativePosix(root, file))];
  if (more) lines.push(`[Stopped at ${MAX_GLOB_RESULTS} files. Use a narrower pattern.]`);
  return lines.join('\n');
}

function grep({ path: target, cwd, body, glob: fileFilter, ignore_case: ignoreCase, context }) {
  const pattern = (body || '').trim();
  if (!pattern) throw new ToolError('grep needs a regular expression.');
  let matcher;
  try {
    matcher = new RegExp(pattern, ignoreCase === true || ignoreCase === 'true' ? 'i' : '');
  } catch (error) {
    throw new ToolError(`Invalid regular expression: ${error.message}`);
  }
  const root = resolvePath(target, cwd);
  if (!fs.existsSync(root)) throw new ToolError(`Path not found: ${root}`);
  const nameMatcher = fileFilter ? globToRegExp(fileFilter.includes('/') ? fileFilter : `**/${fileFilter}`) : null;
  const around = Math.min(Math.max(Number(context) || 0, 0), 10);
  const output = [];
  let matches = 0;
  let chars = 0;
  let cut = false;

  const searchFile = (file, label) => {
    const stats = fs.statSync(file);
    if (stats.size > MAX_SEARCH_FILE_BYTES) return true;
    const buffer = fs.readFileSync(file);
    if (looksBinary(buffer)) return true;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    let printedUpTo = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher.test(lines[index])) continue;
      matches += 1;
      for (let row = Math.max(index - around, printedUpTo + 1); row <= Math.min(index + around, lines.length - 1); row += 1) {
        const text = `${label}:${row + 1}:${lines[row].slice(0, MAX_LINE_CHARS)}`;
        output.push(text);
        chars += text.length + 1;
        printedUpTo = row;
      }
      if (matches >= MAX_GREP_MATCHES || chars >= MAX_OUTPUT_CHARS) {
        cut = true;
        return false;
      }
    }
    return true;
  };

  if (fs.statSync(root).isFile()) {
    searchFile(root, path.basename(root));
  } else {
    walk(root, (file) => {
      if (SENSITIVE_FILE.test(file)) return true;
      const relative = relativePosix(root, file);
      if (nameMatcher && !nameMatcher.test(relative)) return true;
      return searchFile(file, relative);
    });
  }
  if (!matches) return `No matches for ${pattern} in ${root}.`;
  if (cut) output.push('[Stopped early. Use a narrower search.]');
  return output.join('\n');
}

const TOOLS = { read, write, edit, glob, grep };

function runTool(request) {
  const tool = TOOLS[request.tool];
  try {
    if (!tool) throw new ToolError(`Unknown tool: ${request.tool}`);
    const value = tool(request);
    // `read` answers with an object when the file is attached rather than printed.
    if (typeof value === 'string') return { status: 'ok', code: 0, output: value };
    return { status: 'ok', code: 0, output: value.text, attachment: value.attachment };
  } catch (error) {
    if (error instanceof ToolError || error.code) return { status: 'failed', code: 1, output: error.message };
    throw error;
  }
}

if (!isMainThread) parentPort.postMessage(runTool(workerData));

module.exports = { runTool, globToRegExp, SENSITIVE_FILE, attachmentType, MAX_ATTACHMENT_BYTES };
