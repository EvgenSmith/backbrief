#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * validate-tenant.js — Backbrief tenant.yaml validator.
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies,
 * `--help`, DRY_RUN=1 honored wherever a write happens,
 * exit codes: 0 ok / 1 check failed / 2 operational error.
 *
 * What it does, in order:
 *   1. Parse tenant.yaml (embedded zero-dependency YAML-subset parser).
 *   2. Migration gate on schema_version (02 §5.4): older -> exact edit list
 *      (or --migrate applies it and shows the diff); newer -> refuse.
 *   3. Token-shape scan (02 §2.3.7): any credential-shaped value -> HARD FAIL.
 *   4. JSON-Schema validation against plugin/templates/tenant.schema.json
 *      (embedded minimal schema interpreter — the exact keyword subset the
 *      schema uses; no ajv, no npm).
 *   5. Seven cross-field semantic checks (02 §2.3). `--fix` creates missing
 *      vault folders (check S6).
 *
 * Folder-existence checks (S6) run only when the tenant file sits inside an
 * initialized vault (a `.backbrief/` dir or `AGENTS.md` next to it) — so CI
 * can validate plugin/templates/tenant.yaml.example without a vault.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CURRENT_SCHEMA_VERSION = 1;
const DRY_RUN = process.env.DRY_RUN === '1';

// Token shapes per 02 §2.3.7. Built by concatenation so the kit's own
// sanitize denylist grep (02 §8.4) never matches this source file.
const TOKEN_SHAPES = new RegExp(
  '(xox[bpo]|lin' + '_api|gh' + 'p_|github' + '_pat_|sk-' + 'ant-)'
);

const HELP = `validate-tenant.js — validate a Backbrief tenant.yaml

Usage:
  node validate-tenant.js [path/to/tenant.yaml] [options]

Path resolution: positional argument, else $TENANT, else ./tenant.yaml.

Options:
  --fix            create missing vault folders (semantic check S6);
                   only acts when the file sits inside an initialized vault
  --migrate        apply the schema migration edit list (older schema_version)
                   and show the diff; without it the edit list is only printed
  --schema <path>  override the schema file (default: ../templates/tenant.schema.json
                   relative to this script)
  -h, --help       this text

Environment:
  TENANT      default tenant.yaml path
  DRY_RUN=1   print what --fix/--migrate would do, write nothing

Checks:
  hard-fail   token-shaped value anywhere (secrets never live in tenant.yaml)
  schema      JSON-Schema (tenant.schema.json, schema_version 1)
  S1  raw_retention: vtt_mp4 requires features.drive.enabled: true
  S2  tracker.team_mapping[].team_tag must exist in vault.teams[].tag
      (unmapped teams -> warning: file-only tasks fallback)
  S3  roster lastnames unique; alias collisions -> error;
      team_mapping[].default_assignee must be a roster lastname
  S4  exactly one roster[].is_owner: true when Slack is enabled
  S6  vault.teams[].folder paths exist (--fix creates them)
  S7  = the token-shape hard fail above
  S8  team tags/folders must avoid the reserved skeleton root names
      (team, tasks, docs, private, pipeline, .backbrief)
  (S5 — sensitivity-pattern checks — removed with privacy routing, not in v0.1)

Exit codes: 0 ok / 1 check failed / 2 operational error`;

/* ------------------------------------------------------------------ */
/* Minimal YAML-subset parser (zero-dependency)                        */
/*                                                                     */
/* Supports: block maps, block lists, single-line flow [..] / {..},    */
/* single/double-quoted scalars, comments, ints/floats/bools/null.     */
/* Not supported (by design, documented in tenant.yaml.example):       */
/* anchors/aliases, multi-line scalars (| >), multi-document (---).    */
/* ------------------------------------------------------------------ */

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
    if (raw[n].indexOf('---') === 0) throw yamlError('multi-document YAML is not supported', n + 1);
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
      // nested block on following deeper-indented lines
      state.i++;
      const next = state.lines[state.i];
      if (!next || next.indent <= indent) throw yamlError('empty list item', line.num);
      items.push(parseBlock(state, next.indent));
    } else if (looksLikeMapEntry(content)) {
      // "- key: value" starts an inline map item; re-anchor at the content column
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
  if (typeof v === 'object' && v !== null && 'str' in v) return v.str; // quoted: always string
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
    this.pos++; // [
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
    this.pos++; // {
    const obj = {};
    this.skipWs();
    if (this.peek() === '}') { this.pos++; return obj; }
    for (;;) {
      this.skipWs();
      let key;
      if (this.peek() === '"' || this.peek() === "'") key = this.parseQuoted();
      else key = String(this.parseBare([':'])); // bare key, colon-terminated
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

/* ------------------------------------------------------------------ */
/* Minimal YAML serializer (used by --migrate only; comments are NOT   */
/* preserved — the diff is shown so the user can restore any they need)*/
/* ------------------------------------------------------------------ */

function needsQuote(s) {
  return s === '' || /^[\s'"#&*\[\]{}>|%@`!,?:-]/.test(s) || /[:#]\s|\s$/.test(s) ||
    /^(true|false|null|Null|NULL|~|True|False)$/.test(s) ||
    /^[+-]?(\d+|\d*\.\d+)([eE][+-]?\d+)?$/.test(s);
}

function scalarToYaml(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return needsQuote(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

function toYaml(value, indent) {
  indent = indent || 0;
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return pad + '[]';
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        const body = toYaml(item, indent + 2);
        return pad + '-' + body.slice(indent + 1); // splice "- " into first line's indent
      }
      return `${pad}- ${scalarToYaml(item)}`;
    }).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return pad + '{}';
    return keys.map((k) => {
      const v = value[k];
      const key = needsQuote(k) ? `'${k.replace(/'/g, "''")}'` : k;
      if (v !== null && typeof v === 'object' && Object.keys(v).length) {
        return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
      }
      if (Array.isArray(v)) return `${pad}${key}: []`;
      if (v !== null && typeof v === 'object') return `${pad}${key}: {}`;
      return `${pad}${key}: ${scalarToYaml(v)}`;
    }).join('\n');
  }
  return pad + scalarToYaml(value);
}

/* ------------------------------------------------------------------ */
/* Minimal JSON-Schema interpreter — exactly the keyword subset        */
/* tenant.schema.json uses: type, const, enum, required, properties,   */
/* additionalProperties, items, minItems, minLength, pattern,          */
/* minimum, maximum, format, if/then, $ref (local #/$defs/...).        */
/* ------------------------------------------------------------------ */

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node && node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (!node) throw new Error(`unresolvable $ref: ${ref}`);
  return node;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string | boolean | object
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

const FORMATS = {
  email: (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  uri: (s) => { try { new URL(s); return true; } catch { return false; } },
  regex: (s) => { try { new RegExp(s); return true; } catch { return false; } },
};

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function validateNode(value, schema, root, pathStr, errors) {
  if (schema.$ref) {
    validateNode(value, resolveRef(root, schema.$ref), root, pathStr, errors);
    return;
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${pathStr}: must be ${JSON.stringify(schema.const)} (got ${JSON.stringify(value)})`);
    return;
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${pathStr}: must be one of ${schema.enum.join(' | ')} (got ${JSON.stringify(value)})`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${pathStr}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pathStr}: must be at least ${schema.minLength} character(s)`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${pathStr}: "${value}" does not match pattern ${schema.pattern}`);
    }
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](value)) {
      errors.push(`${pathStr}: "${value}" is not a valid ${schema.format}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${pathStr}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${pathStr}: must be <= ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pathStr}: must have at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, idx) => validateNode(item, schema.items, root, `${pathStr}[${idx}]`, errors));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required || []) {
      if (!(req in value) || value[req] === undefined) {
        errors.push(`${pathStr}: missing required key "${req}"`);
      }
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) {
        validateNode(v, props[k], root, `${pathStr}.${k}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${pathStr}: unknown key "${k}" (additionalProperties: false)`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNode(v, schema.additionalProperties, root, `${pathStr}.${k}`, errors);
      }
    }
    if (schema.if) {
      const ifErrors = [];
      validateNode(value, schema.if, root, pathStr, ifErrors);
      if (ifErrors.length === 0 && schema.then) {
        validateNode(value, schema.then, root, pathStr, errors);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Token-shape hard fail (02 §2.3.7)                                   */
/* ------------------------------------------------------------------ */

function scanTokens(value, pathStr, hits) {
  if (typeof value === 'string') {
    if (TOKEN_SHAPES.test(value)) hits.push(pathStr);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanTokens(v, `${pathStr}[${i}]`, hits));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanTokens(v, `${pathStr}.${k}`, hits);
  }
}

/* ------------------------------------------------------------------ */
/* Semantic checks S1–S6 (02 §2.3)                                     */
/* ------------------------------------------------------------------ */

function get(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function semanticChecks(doc, ctx) {
  const errors = [];
  const warnings = [];
  const notes = [];

  const features = get(doc, 'features') || {};
  const teams = Array.isArray(get(doc, 'vault', 'teams')) ? doc.vault.teams : [];
  const roster = Array.isArray(get(doc, 'roster')) ? doc.roster : [];
  const mapping = Array.isArray(get(features, 'tracker', 'team_mapping'))
    ? features.tracker.team_mapping : [];

  // S1 — vtt_mp4 requires drive
  if (get(features, 'raw_retention') === 'vtt_mp4' && get(features, 'drive', 'enabled') !== true) {
    errors.push('S1 features.raw_retention: "vtt_mp4" requires features.drive.enabled: true — ' +
      'enable drive (and set folder_id) or lower raw_retention to "vtt"');
  }

  // S2 — team_mapping tags exist; unmapped teams -> warning
  const teamTags = new Set(teams.map((t) => get(t, 'tag')).filter(Boolean));
  for (const m of mapping) {
    const tag = get(m, 'team_tag');
    if (tag && !teamTags.has(tag)) {
      errors.push(`S2 features.tracker.team_mapping: team_tag "${tag}" is not in vault.teams[].tag — ` +
        'add the team or remove the mapping');
    }
  }
  if (get(features, 'tracker', 'enabled') !== false && mapping.length) {
    const mappedTags = new Set(mapping.map((m) => get(m, 'team_tag')));
    for (const tag of teamTags) {
      if (!mappedTags.has(tag)) {
        warnings.push(`S2 team "${tag}" has no tracker mapping — its tasks fall back to file-only mode`);
      }
    }
  }

  // S3 — lastname uniqueness, alias collisions, default_assignee resolution
  const lastnames = new Map(); // lower -> canonical
  for (const p of roster) {
    const ln = get(p, 'lastname');
    if (!ln) continue;
    const key = ln.toLowerCase();
    if (lastnames.has(key)) {
      errors.push(`S3 roster: duplicate lastname "${ln}" — lastnames must be unique ` +
        '(use "Lastname-F" style for collisions, 04 D3)');
    }
    lastnames.set(key, ln);
  }
  const aliasOwner = new Map(); // alias lower -> lastname
  for (const p of roster) {
    const ln = get(p, 'lastname') || '?';
    for (const alias of Array.isArray(p.aliases) ? p.aliases : []) {
      const key = String(alias).toLowerCase().trim();
      if (!key) continue;
      if (aliasOwner.has(key) && aliasOwner.get(key) !== ln) {
        errors.push(`S3 roster: alias "${alias}" appears for both "${aliasOwner.get(key)}" and "${ln}" — ` +
          'assignee resolution would be ambiguous; make aliases unique');
      } else {
        aliasOwner.set(key, ln);
      }
      if (lastnames.has(key) && lastnames.get(key) !== ln) {
        errors.push(`S3 roster: alias "${alias}" of "${ln}" collides with lastname "${lastnames.get(key)}" — ` +
          'remove or change the alias');
      }
    }
  }
  for (const m of mapping) {
    const da = get(m, 'default_assignee');
    if (da && !lastnames.has(String(da).toLowerCase())) {
      errors.push(`S3 features.tracker.team_mapping: default_assignee "${da}" is not a roster lastname`);
    }
  }

  // S4 — exactly one owner when Slack is enabled (DLQ DM target)
  const owners = roster.filter((p) => get(p, 'is_owner') === true);
  const slackEnabled = !!get(features, 'slack') && get(features, 'slack', 'enabled') !== false;
  if (owners.length > 1) {
    errors.push(`S4 roster: ${owners.length} entries have is_owner: true — exactly one owner ` +
      '(DLQ DM + 1:1 routing target) is allowed');
  } else if (owners.length === 0) {
    if (slackEnabled) {
      errors.push('S4 roster: no entry has is_owner: true — Slack is enabled, so exactly one owner ' +
        '(DLQ DM target) is required');
    } else {
      warnings.push('S4 roster: no owner set (is_owner: true) — required before Phase-B deploy');
    }
  }

  // (S5 — sensitivity regex/route checks — removed: privacy routing is not in
  //  v0.1; the schema rejects a sensitivity block outright.)

  // S8 — reserved root names: folders the vault skeleton owns can never be
  // team tags or team folders (a team tagged "team" would collide with the
  // people-profiles folder; same list in init-vault.js + validate-vault.js).
  const RESERVED_ROOT = ['team', 'tasks', 'docs', 'private', 'pipeline', '.backbrief'];
  const checkReserved = (tag, folder, where) => {
    if (tag && RESERVED_ROOT.includes(String(tag))) {
      errors.push(`S8 ${where}: tag "${tag}" is a reserved root name ` +
        `(${RESERVED_ROOT.join(', ')}) — the vault skeleton owns that folder; pick another tag`);
    }
    const seg = folder ? String(folder).split('/')[0] : null;
    if (seg && RESERVED_ROOT.includes(seg)) {
      errors.push(`S8 ${where}: folder "${folder}" sits under the reserved root "${seg}" ` +
        `(${RESERVED_ROOT.join(', ')}) — pick a folder the skeleton does not own`);
    }
  };
  for (const t of teams) {
    checkReserved(get(t, 'tag'), get(t, 'folder'), 'vault.teams[]');
    for (const st of Array.isArray(get(t, 'subteams')) ? t.subteams : []) {
      checkReserved(get(st, 'tag'), get(st, 'folder'), 'vault.teams[].subteams[]');
    }
  }

  // S6 — vault folders exist (create-or-confirm with --fix); vault-mode only
  if (!ctx.insideVault) {
    notes.push('S6 folder checks skipped — the file is not inside an initialized vault ' +
      '(no .backbrief/ or AGENTS.md next to it); run from your vault to check folders');
  } else {
    const wanted = [];
    for (const t of teams) if (typeof get(t, 'folder') === 'string') wanted.push(t.folder);
    for (const folder of wanted) {
      const abs = path.join(ctx.vaultDir, folder);
      if (fs.existsSync(abs)) continue;
      if (ctx.fix) {
        if (DRY_RUN) {
          notes.push(`S6 [dry-run] would create folder: ${folder}`);
        } else {
          fs.mkdirSync(abs, { recursive: true });
          notes.push(`S6 created folder: ${folder}`);
        }
      } else {
        errors.push(`S6 vault folder "${folder}" does not exist — create it or re-run with --fix`);
      }
    }
  }

  return { errors, warnings, notes };
}

/* ------------------------------------------------------------------ */
/* Migration (02 §5.4): schema_version gate + legacy-key edit list     */
/* ------------------------------------------------------------------ */

// Legacy (pre-schema draft, reconciled away 2026-07-10 — 00 §5) -> v1 mapping.
function buildMigrationEdits(doc) {
  const edits = []; // { desc, apply(doc) }
  const features = get(doc, 'features');

  const rawStorage = get(doc, 'raw_storage') !== undefined ? ['raw_storage']
    : get(features, 'raw_storage') !== undefined ? ['features', 'raw_storage'] : null;
  if (rawStorage) {
    edits.push({
      desc: `${rawStorage.join('.')} -> features.raw_retention (value kept)`,
      apply(d) {
        const val = rawStorage.length === 1 ? d.raw_storage : d.features.raw_storage;
        d.features = d.features || {};
        d.features.raw_retention = val;
        if (rawStorage.length === 1) delete d.raw_storage; else delete d.features.raw_storage;
      },
    });
  }

  const trackerChoice = get(doc, 'tracker', 'choice') !== undefined ? ['tracker', 'choice']
    : get(features, 'tracker', 'choice') !== undefined ? ['features', 'tracker', 'choice'] : null;
  if (trackerChoice) {
    edits.push({
      desc: `${trackerChoice.join('.')} -> features.tracker.kind (value kept)`,
      apply(d) {
        const src = trackerChoice[0] === 'tracker' ? d.tracker : d.features.tracker;
        d.features = d.features || {};
        d.features.tracker = d.features.tracker || {};
        d.features.tracker.kind = src.choice;
        delete src.choice;
        if (trackerChoice[0] === 'tracker' && !Object.keys(d.tracker).length) delete d.tracker;
      },
    });
  }

  const driveUpload = get(doc, 'drive_upload') !== undefined ? ['drive_upload']
    : get(features, 'drive_upload') !== undefined ? ['features', 'drive_upload'] : null;
  if (driveUpload) {
    edits.push({
      desc: `${driveUpload.join('.')} -> features.drive.enabled (value kept)`,
      apply(d) {
        const val = driveUpload.length === 1 ? d.drive_upload : d.features.drive_upload;
        d.features = d.features || {};
        d.features.drive = d.features.drive || {};
        d.features.drive.enabled = !!val;
        if (driveUpload.length === 1) delete d.drive_upload; else delete d.features.drive_upload;
      },
    });
  }

  if (get(doc, 'vault_commit') !== undefined) {
    edits.push({
      desc: 'vault_commit -> dropped (vault.repo: null expresses a local-only vault)',
      apply(d) {
        d.vault = d.vault || {};
        if (!d.vault_commit && d.vault.repo === undefined) d.vault.repo = null;
        delete d.vault_commit;
      },
    });
  }

  if (get(doc, 'capture') !== undefined) {
    edits.push({
      desc: 'capture -> dropped (B2-skip is expressed by absent creds, not config)',
      apply(d) { delete d.capture; },
    });
  }

  // Privacy routing was removed from v0.1 pre-release (owner decision,
  // 2026-07-11): drop the config it used. Demand -> waitlist interest "privacy".
  if (get(doc, 'sensitivity') !== undefined) {
    edits.push({
      desc: 'sensitivity -> dropped (privacy routing is not in v0.1; waitlist interest: privacy)',
      apply(d) { delete d.sensitivity; },
    });
  }
  if (get(doc, 'vault', 'private_slices') !== undefined) {
    edits.push({
      desc: 'vault.private_slices -> dropped (privacy routing is not in v0.1)',
      apply(d) { delete d.vault.private_slices; },
    });
  }
  for (const key of ['dm_policy', 'board_channel']) {
    if (get(features, 'slack', key) !== undefined) {
      edits.push({
        desc: `features.slack.${key} -> dropped (privacy routing is not in v0.1)`,
        apply(d) { delete d.features.slack[key]; },
      });
    }
  }
  if (get(features, 'tracker', 'kind') === 'jira') {
    edits.push({
      desc: 'features.tracker.kind: jira -> other (no Jira path ships in v0.1; file-only + waitlist)',
      apply(d) { d.features.tracker.kind = 'other'; },
    });
  }

  edits.push({
    desc: `schema_version: ${doc.schema_version === undefined ? '(missing)' : doc.schema_version} -> 1`,
    apply(d) { d.schema_version = 1; },
  });

  return edits;
}

function diffLines(oldLines, newLines) {
  // simple LCS diff — files are small
  const n = oldLines.length; const m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { out.push(`  ${oldLines[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`- ${oldLines[i]}`); i++; }
    else { out.push(`+ ${newLines[j]}`); j++; }
  }
  while (i < n) out.push(`- ${oldLines[i++]}`);
  while (j < m) out.push(`+ ${newLines[j++]}`);
  // show only changed lines with 1 line of context
  const keep = new Set();
  out.forEach((line, idx) => {
    if (!line.startsWith('  ')) { keep.add(idx - 1); keep.add(idx); keep.add(idx + 1); }
  });
  const compact = [];
  let lastKept = -2;
  out.forEach((line, idx) => {
    if (!keep.has(idx)) return;
    if (idx > lastKept + 1) compact.push('  ...');
    compact.push(line);
    lastKept = idx;
  });
  return compact.join('\n');
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { file: null, fix: false, migrate: false, schema: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fix') opts.fix = true;
    else if (a === '--migrate') opts.migrate = true;
    else if (a === '--schema') opts.schema = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) { console.error(`unknown option: ${a} (see --help)`); process.exit(2); }
    else if (!opts.file) opts.file = a;
    else { console.error(`unexpected argument: ${a} (see --help)`); process.exit(2); }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const tenantPath = path.resolve(opts.file || process.env.TENANT || './tenant.yaml');
  const schemaPath = path.resolve(opts.schema ||
    path.join(__dirname, '..', 'templates', 'tenant.schema.json'));

  if (!fs.existsSync(tenantPath)) {
    console.error(`✖ tenant file not found: ${tenantPath}`);
    console.error('  (pass a path, set $TENANT, or run from the vault root)');
    process.exit(2);
  }
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (e) {
    console.error(`✖ cannot load schema ${schemaPath}: ${e.message}`);
    process.exit(2);
  }

  const rawText = fs.readFileSync(tenantPath, 'utf8');
  console.log(`validate-tenant: ${tenantPath}`);

  let doc;
  try {
    doc = parseYaml(rawText);
  } catch (e) {
    console.error(`✖ ${e.message}`);
    if (e.isYamlError) {
      console.error('  (the kit parser reads a plain YAML subset — no anchors, no multi-line scalars;' +
        ' see the header of tenant.yaml.example)');
    }
    process.exit(1);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    console.error('✖ tenant.yaml must be a mapping at the top level');
    process.exit(1);
  }

  // --- migration gate (02 §5.4) -------------------------------------
  const version = doc.schema_version;
  if (typeof version === 'number' && version > CURRENT_SCHEMA_VERSION) {
    console.error(`✖ schema_version ${version} is newer than this kit supports ` +
      `(${CURRENT_SCHEMA_VERSION}) — update the kit first: claude plugin update backbrief | git pull`);
    process.exit(2);
  }
  // Same-version migration trigger: privacy-routing keys were removed from the
  // v1 schema pre-release (not in v0.1) — a tenant still carrying them gets the
  // same edit-list treatment as an older schema_version.
  const legacyPrivacyKeys = get(doc, 'sensitivity') !== undefined ||
    get(doc, 'vault', 'private_slices') !== undefined ||
    get(doc, 'features', 'slack', 'dm_policy') !== undefined ||
    get(doc, 'features', 'slack', 'board_channel') !== undefined ||
    get(doc, 'features', 'tracker', 'kind') === 'jira';
  if (version === undefined || version === null ||
      (typeof version === 'number' && version < CURRENT_SCHEMA_VERSION) ||
      legacyPrivacyKeys) {
    const edits = buildMigrationEdits(doc);
    console.log(version === CURRENT_SCHEMA_VERSION
      ? '\nlegacy privacy-routing keys found (removed pre-release — not in v0.1). Edit list:'
      : `\nschema_version ${version === undefined || version === null ? '(missing)' : version} ` +
        `< ${CURRENT_SCHEMA_VERSION} — migration needed. Edit list:`);
    edits.forEach((e, i) => console.log(`  ${i + 1}. ${e.desc}`));
    if (!opts.migrate) {
      console.log('\nRe-run with --migrate to apply (DRY_RUN=1 to preview). Nothing was changed.');
      process.exit(1);
    }
    const beforeLines = rawText.split(/\r?\n/);
    for (const e of edits) e.apply(doc);
    const migrated = toYaml(doc, 0) + '\n';
    console.log('\nDiff (note: --migrate does not preserve comments — restore any you need):');
    console.log(diffLines(beforeLines, migrated.split(/\r?\n/)));
    if (DRY_RUN) {
      console.log('\n[dry-run] not writing; validating the migrated document in memory.');
    } else {
      fs.writeFileSync(tenantPath, migrated);
      console.log(`\nWrote migrated file: ${tenantPath}`);
    }
  }

  // --- token-shape hard fail (S7 / 02 §2.3.7) ------------------------
  const tokenHits = [];
  scanTokens(doc, 'tenant.yaml', tokenHits);
  if (TOKEN_SHAPES.test(rawText)) {
    // catch commented-out secrets too
    rawText.split(/\r?\n/).forEach((line, i) => {
      if (TOKEN_SHAPES.test(line)) tokenHits.push(`line ${i + 1}`);
    });
  }
  if (tokenHits.length) {
    console.error('\n✖ HARD FAIL — token-shaped value(s) found at: ' +
      [...new Set(tokenHits)].join(', '));
    console.error('  secrets never live in tenant.yaml — put it in .backbrief/secrets.env');
    process.exit(1);
  }

  // --- JSON-Schema validation ----------------------------------------
  const schemaErrors = [];
  try {
    validateNode(doc, schema, schema, 'tenant.yaml', schemaErrors);
  } catch (e) {
    console.error(`✖ schema interpreter error: ${e.message}`);
    process.exit(2);
  }

  // --- semantic checks -----------------------------------------------
  const vaultDir = path.dirname(tenantPath);
  const insideVault = fs.existsSync(path.join(vaultDir, '.backbrief')) ||
    fs.existsSync(path.join(vaultDir, 'AGENTS.md'));
  const { errors, warnings, notes } = semanticChecks(doc, { vaultDir, insideVault, fix: opts.fix });

  // --- report ----------------------------------------------------------
  for (const n of notes) console.log(`  ℹ ${n}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const e of schemaErrors) console.log(`  ✖ [schema] ${e}`);
  for (const e of errors) console.log(`  ✖ ${e}`);

  const errorCount = schemaErrors.length + errors.length;
  if (errorCount) {
    console.log(`\n✖ ${errorCount} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  console.log(`✔ valid (schema_version ${CURRENT_SCHEMA_VERSION}` +
    `${warnings.length ? `, ${warnings.length} warning(s)` : ''})`);
  process.exit(0);
}

main();
