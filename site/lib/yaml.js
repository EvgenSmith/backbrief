// SPDX-License-Identifier: MIT
/*
 * yaml.js — the kit's YAML-subset parser, as an ES module for the site
 * (build script, Cloudflare Pages Functions).
 *
 * Copied verbatim from plugin/scripts/validate-vault.js so the cabinet reads a
 * vault exactly the way the validator does: block maps, block lists,
 * single-line flow [..]/{..}, quoted scalars, comments; no anchors, no
 * multi-line scalars. site/tests/cabinet.test.js fails if the two copies
 * drift apart.
 */

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === '\\') { out += line[i + 1] || ''; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) break;
    out += ch;
  }
  return out.replace(/\s+$/, '');
}

function yamlError(msg, lineNum) {
  const e = new Error(`YAML parse error at line ${lineNum}: ${msg}`);
  e.isYamlError = true;
  return e;
}

function parseYaml(text) {
  const lines = [];
  const raw = String(text).split(/\r?\n/);
  for (let n = 0; n < raw.length; n++) {
    const stripped = stripComment(raw[n]);
    if (stripped.trim() === '') continue;
    const indentStr = stripped.match(/^[ \t]*/)[0];
    if (indentStr.includes('\t')) throw yamlError('tabs are not allowed for indentation', n + 1);
    lines.push({ text: stripped, indent: indentStr.length, num: n + 1 });
  }
  if (!lines.length) return {};
  const state = { lines, i: 0 };
  const value = parseBlock(state, lines[0].indent);
  if (state.i !== lines.length) {
    throw yamlError('unexpected content (bad indentation?)', lines[state.i].num);
  }
  return value;
}

function isListLine(line, indent) {
  const t = line.text.slice(indent);
  return t === '-' || t.startsWith('- ');
}

function parseBlock(state, indent) {
  const line = state.lines[state.i];
  if (isListLine(line, indent)) return parseListBlock(state, indent);
  return parseMapBlock(state, indent);
}

function parseListBlock(state, indent) {
  const items = [];
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.indent !== indent || !isListLine(line, indent)) break;
    const rest = line.text.slice(indent + 1);
    const pad = rest.match(/^ */)[0].length;
    const content = rest.trim();
    if (content === '') {
      state.i++;
      const next = state.lines[state.i];
      if (!next || next.indent <= indent) throw yamlError('empty list item', line.num);
      items.push(parseBlock(state, next.indent));
    } else if (looksLikeMapEntry(content)) {
      const contentCol = indent + 1 + pad;
      state.lines[state.i] = { text: ' '.repeat(contentCol) + content, indent: contentCol, num: line.num };
      items.push(parseMapBlock(state, contentCol));
    } else {
      items.push(parseScalar(content, line.num));
      state.i++;
    }
  }
  return items;
}

function looksLikeMapEntry(s) {
  if (/^["'\[{]/.test(s)) return false;
  return /^[^:\s][^:]*:( |$)/.test(s);
}

function parseMapBlock(state, indent) {
  const map = {};
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.indent !== indent) {
      if (line.indent > indent) throw yamlError('bad indentation', line.num);
      break;
    }
    if (isListLine(line, indent)) break;
    const t = line.text.slice(indent);
    const m = t.match(/^(?:"([^"]*)"|'([^']*)'|([^:\s][^:]*?))\s*:(?:\s+(.*))?$/);
    if (!m) throw yamlError(`expected "key: value", got: ${t}`, line.num);
    const key = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    const rest = (m[4] || '').trim();
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw yamlError(`duplicate key "${key}"`, line.num);
    }
    if (rest === '') {
      state.i++;
      const next = state.lines[state.i];
      if (next && next.indent > indent) {
        map[key] = parseBlock(state, next.indent);
      } else {
        map[key] = null;
      }
    } else {
      map[key] = parseScalar(rest, line.num);
      state.i++;
    }
  }
  return map;
}

function parseScalar(s, lineNum) {
  s = s.trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    const flow = new FlowParser(s, lineNum);
    const v = flow.parseValue();
    flow.skipWs();
    if (flow.pos !== s.length) throw yamlError('trailing characters after flow value', lineNum);
    return v;
  }
  if (s.startsWith('|') || s.startsWith('>')) {
    throw yamlError('multi-line scalars (| >) are not supported', lineNum);
  }
  if (s.startsWith('&') || s.startsWith('*')) {
    throw yamlError('anchors/aliases are not supported', lineNum);
  }
  return typeScalar(unquoteIfQuoted(s, lineNum));
}

function unquoteIfQuoted(s, lineNum) {
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw yamlError('unterminated single quote', lineNum);
    return { str: s.slice(1, -1).replace(/''/g, "'") };
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw yamlError('unterminated double quote', lineNum);
    return { str: unescapeDouble(s.slice(1, -1)) };
  }
  return s;
}

function unescapeDouble(s) {
  return s.replace(/\\(.)/g, (_, c) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : c === '"' ? '"' : c);
}

function typeScalar(v) {
  if (typeof v === 'object' && v !== null && 'str' in v) return v.str;
  const s = v;
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True') return true;
  if (s === 'false' || s === 'False') return false;
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  return s;
}

class FlowParser {
  constructor(src, lineNum) { this.src = src; this.pos = 0; this.lineNum = lineNum; }
  err(msg) { return yamlError(`${msg} (in flow value)`, this.lineNum); }
  skipWs() { while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++; }
  peek() { return this.src[this.pos]; }

  parseValue() {
    this.skipWs();
    const ch = this.peek();
    if (ch === '[') return this.parseArray();
    if (ch === '{') return this.parseObject();
    if (ch === '"' || ch === "'") return this.parseQuoted();
    return this.parseBare([',', ']', '}']);
  }

  parseArray() {
    this.pos++;
    const arr = [];
    this.skipWs();
    if (this.peek() === ']') { this.pos++; return arr; }
    for (;;) {
      arr.push(this.parseValue());
      this.skipWs();
      const ch = this.peek();
      if (ch === ',') { this.pos++; continue; }
      if (ch === ']') { this.pos++; return arr; }
      throw this.err(`expected "," or "]", got "${ch || 'end of input'}"`);
    }
  }

  parseObject() {
    this.pos++;
    const obj = {};
    this.skipWs();
    if (this.peek() === '}') { this.pos++; return obj; }
    for (;;) {
      this.skipWs();
      let key;
      if (this.peek() === '"' || this.peek() === "'") key = this.parseQuoted();
      else key = String(this.parseBare([':']));
      this.skipWs();
      if (this.peek() !== ':') throw this.err('expected ":" in flow mapping');
      this.pos++;
      obj[key] = this.parseValue();
      this.skipWs();
      const ch = this.peek();
      if (ch === ',') { this.pos++; continue; }
      if (ch === '}') { this.pos++; return obj; }
      throw this.err(`expected "," or "}", got "${ch || 'end of input'}"`);
    }
  }

  parseQuoted() {
    const quote = this.src[this.pos++];
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (quote === '"' && ch === '\\') { out += this.src[this.pos + 1] || ''; this.pos += 2; continue; }
      if (ch === quote) {
        if (quote === "'" && this.src[this.pos + 1] === "'") { out += "'"; this.pos += 2; continue; }
        this.pos++;
        return quote === '"' ? unescapeDouble(out) : out;
      }
      out += ch;
      this.pos++;
    }
    throw this.err('unterminated quoted string');
  }

  parseBare(stops) {
    let out = '';
    while (this.pos < this.src.length && !stops.includes(this.src[this.pos])) {
      out += this.src[this.pos++];
    }
    if (out.trim() === '') throw this.err('empty value');
    return typeScalar(out.trim());
  }
}

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const head = text.slice(4, end); // after "---\n"
  const bodyStart = text.indexOf('\n', end + 1);
  return { head, body: bodyStart >= 0 ? text.slice(bodyStart + 1) : '' };
}

export { parseYaml, splitFrontmatter };
