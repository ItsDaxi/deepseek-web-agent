// A small TOML reader, enough for Codex's config.toml: tables, dotted keys, strings, numbers, booleans,
// arrays and inline tables. Dates are kept as text. It throws a plain Error with the line number when
// the file is not valid, so the caller can say which file is broken and carry on without it.
'use strict';

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

class Reader {
  constructor(text) {
    this.text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    this.pos = 0;
  }

  get line() {
    return this.text.slice(0, this.pos).split('\n').length;
  }

  fail(message) {
    throw new Error(`TOML error on line ${this.line}: ${message}`);
  }

  peek(count = 1) {
    return this.text.slice(this.pos, this.pos + count);
  }

  eof() {
    return this.pos >= this.text.length;
  }

  skipSpaces() {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos += 1;
  }

  // Spaces, line breaks and comments, as allowed inside an array.
  skipBlank() {
    for (;;) {
      const char = this.peek();
      if (char === ' ' || char === '\t' || char === '\n') this.pos += 1;
      else if (char === '#') this.skipComment();
      else return;
    }
  }

  skipComment() {
    while (!this.eof() && this.peek() !== '\n') this.pos += 1;
  }

  // The end of a statement: only a comment may follow on the line.
  endOfLine() {
    this.skipSpaces();
    if (this.peek() === '#') this.skipComment();
    if (!this.eof() && this.peek() !== '\n') this.fail(`unexpected "${this.peek()}"`);
  }

  basicString(multiline) {
    let out = '';
    for (;;) {
      if (this.eof()) this.fail('a string is not closed');
      const char = this.text[this.pos];
      if (multiline ? this.peek(3) === '"""' : char === '"') {
        this.pos += multiline ? 3 : 1;
        // Up to two more quotes may belong to the text, right before the closing ones.
        if (multiline) while (this.peek() === '"') { out += '"'; this.pos += 1; }
        return out;
      }
      if (char === '\n' && !multiline) this.fail('a string is not closed');
      this.pos += 1;
      if (char !== '\\') {
        out += char;
        continue;
      }
      const next = this.text[this.pos];
      this.pos += 1;
      if (next in ESCAPES) out += ESCAPES[next];
      else if (next === 'u' || next === 'U') {
        const length = next === 'u' ? 4 : 8;
        const code = this.text.slice(this.pos, this.pos + length);
        if (!/^[0-9a-f]+$/i.test(code) || code.length !== length) this.fail('bad unicode escape');
        out += String.fromCodePoint(parseInt(code, 16));
        this.pos += length;
      } else if (multiline && /\s/.test(next)) {
        // A backslash at the end of a line removes the line break and the blanks after it.
        while (/\s/.test(this.peek()) && !this.eof()) this.pos += 1;
      } else this.fail(`unknown escape \\${next}`);
    }
  }

  literalString(multiline) {
    const close = multiline ? "'''" : "'";
    const end = this.text.indexOf(close, this.pos);
    if (end === -1) this.fail('a string is not closed');
    let value = this.text.slice(this.pos, end);
    if (!multiline && value.includes('\n')) this.fail('a string is not closed');
    this.pos = end + close.length;
    if (multiline) while (this.peek() === "'") { value += "'"; this.pos += 1; }
    return value;
  }

  string() {
    const quote = this.peek();
    const multiline = this.peek(3) === quote.repeat(3);
    this.pos += multiline ? 3 : 1;
    if (multiline && this.peek() === '\n') this.pos += 1;
    return quote === '"' ? this.basicString(multiline) : this.literalString(multiline);
  }

  array() {
    this.pos += 1;
    const items = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === ']') {
        this.pos += 1;
        return items;
      }
      items.push(this.value());
      this.skipBlank();
      if (this.peek() === ',') this.pos += 1;
      else if (this.peek() !== ']') this.fail('expected "," or "]" in an array');
    }
  }

  inlineTable() {
    this.pos += 1;
    const table = {};
    for (;;) {
      this.skipBlank();
      if (this.peek() === '}') {
        this.pos += 1;
        return table;
      }
      const keys = this.keyPath();
      this.skipSpaces();
      if (this.peek() !== '=') this.fail('expected "="');
      this.pos += 1;
      this.skipSpaces();
      assign(table, keys, this.value(), this);
      this.skipBlank();
      if (this.peek() === ',') this.pos += 1;
      else if (this.peek() !== '}') this.fail('expected "," or "}" in an inline table');
    }
  }

  value() {
    const char = this.peek();
    if (char === '"' || char === "'") return this.string();
    if (char === '[') return this.array();
    if (char === '{') return this.inlineTable();
    const match = /^[^\s,\]}#]+/.exec(this.text.slice(this.pos));
    if (!match) this.fail('a value is missing');
    this.pos += match[0].length;
    const word = match[0];
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(word)) return Number(word.replace('inf', 'Infinity').replace('nan', 'NaN'));
    const number = word.replace(/_/g, '');
    if (/^[+-]?\d+$/.test(number)) return Number(number);
    if (/^0x[0-9a-f]+$/i.test(number)) return parseInt(number, 16);
    if (/^0o[0-7]+$/i.test(number)) return parseInt(number.slice(2), 8);
    if (/^0b[01]+$/i.test(number)) return parseInt(number.slice(2), 2);
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(number)) return Number(number);
    // A date or a time. A space may separate its date from its time.
    if (/^\d{4}-\d\d-\d\d|^\d\d:\d\d/.test(word)) return word;
    return this.fail(`cannot read the value "${word}"`);
  }

  // A key such as name, "quoted name" or a.b."c d".
  keyPath() {
    const keys = [];
    for (;;) {
      this.skipSpaces();
      const char = this.peek();
      if (char === '"' || char === "'") {
        this.pos += 1;
        keys.push(char === '"' ? this.basicString(false) : this.literalString(false));
      } else {
        const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.pos));
        if (!match) this.fail('a key is missing');
        keys.push(match[0]);
        this.pos += match[0].length;
      }
      this.skipSpaces();
      if (this.peek() !== '.') return keys;
      this.pos += 1;
    }
  }
}

const isTable = (value) => value && typeof value === 'object' && !Array.isArray(value);

function descend(root, keys, reader) {
  let node = root;
  for (const key of keys) {
    let next = node[key];
    if (next === undefined) {
      next = {};
      node[key] = next;
    } else if (Array.isArray(next) && next.length && isTable(next[next.length - 1])) {
      next = next[next.length - 1];
    }
    if (!isTable(next)) reader.fail(`"${key}" is not a table`);
    node = next;
  }
  return node;
}

function assign(table, keys, value, reader) {
  const parent = descend(table, keys.slice(0, -1), reader);
  const last = keys[keys.length - 1];
  if (last in parent) reader.fail(`"${last}" is defined twice`);
  parent[last] = value;
}

function parse(text) {
  const reader = new Reader(String(text));
  const root = {};
  let current = root;
  for (;;) {
    reader.skipBlank();
    if (reader.eof()) return root;
    if (reader.peek() === '[') {
      const isArray = reader.peek(2) === '[[';
      reader.pos += isArray ? 2 : 1;
      const keys = reader.keyPath();
      reader.skipSpaces();
      const close = isArray ? ']]' : ']';
      if (reader.peek(close.length) !== close) reader.fail(`expected "${close}"`);
      reader.pos += close.length;
      reader.endOfLine();
      if (isArray) {
        const parent = descend(root, keys.slice(0, -1), reader);
        const last = keys[keys.length - 1];
        if (!(last in parent)) parent[last] = [];
        if (!Array.isArray(parent[last])) reader.fail(`"${last}" is not an array of tables`);
        current = {};
        parent[last].push(current);
      } else {
        current = descend(root, keys, reader);
      }
      continue;
    }
    const keys = reader.keyPath();
    reader.skipSpaces();
    if (reader.peek() !== '=') reader.fail('expected "="');
    reader.pos += 1;
    reader.skipSpaces();
    assign(current, keys, reader.value(), reader);
    reader.endOfLine();
  }
}

module.exports = { parse };
