#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * validate-vault.js — Backbrief vault-conventions lint.
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies, `--help`,
 * DRY_RUN=1 honored wherever a write happens (--fix),
 * exit codes: 0 ok / 1 check failed / 2 operational error.
 *
 * The checks (04 §9):
 *   1. Filename grammar (04 §3.1) for every **\/transcripts/*.{md,vtt};
 *      every .vtt needs an identically-named .md sibling.
 *   2. Frontmatter: parses as YAML; required keys per type + schema_version;
 *      NO unknown keys; enum values in the controlled vocabulary (04 §3.3);
 *      team in tenant teams; participants/owner lastnames in roster (warn).
 *   3. Digest body: required section headings present and in order (04 §4);
 *      two first-class heading profiles — manual/plugin (digest.md template)
 *      vs pipeline (build-commit-payload-v2.js), keyed by filed_by;
 *      (MM:SS) anchors well-formed.
 *   4. Profiles: filename = lastname field; alias uniqueness across team/*.md;
 *      status enum; optional email shape. 4b: company profile (type: company,
 *      vault.company_profile_path, default docs/company.md): closed key set,
 *      <= 60-line budget. Tenant team tags/folders must avoid the reserved
 *      root names (team, tasks, docs, private, pipeline, .backbrief).
 *   5. (removed — sensitivity/private-path checks left with privacy routing,
 *      which is not part of v0.1.)
 *   6. tasks files: call: path exists; counts arithmetic matches blocks;
 *      tracker_ref backlinks resolve both ways.
 *   7. Hygiene: no token-shaped secrets in any vault file; filenames ASCII;
 *      no en dash / brace tokens (--legacy-names grandfathers migrated names).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.DRY_RUN === '1';

const HELP = `validate-vault.js — Backbrief vault conventions lint

Usage:
  node validate-vault.js [options]

Options:
  --vault <path>   vault root (default: $BACKBRIEF_VAULT, else walk up from the
                   current directory looking for .backbrief/ or tenant.yaml)
  --fix            create missing team folders from tenant.yaml and repair
                   digest section ORDER where mechanical (all required
                   headings present exactly once)
  --legacy-names   grandfather migrated/imported filenames: naming-grammar,
                   ASCII, en-dash and brace-token findings become warnings
                   (adopted owner default — history imports keep old names)
  -h, --help       this text

Environment:
  BACKBRIEF_VAULT  default vault root
  DRY_RUN=1        with --fix: print what would change, write nothing

Exit codes: 0 all checks pass (warnings allowed) / 1 findings / 2 operational error`;

/* ------------------------------------------------------------------ */
/* Minimal YAML-subset parser (same dialect as the other kit scripts:  */
/* block maps, block lists, single-line flow [..]/{..}, quoted         */
/* scalars, comments; no anchors, no multi-line scalars).              */
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

/* ------------------------------------------------------------------ */
/* Controlled vocabulary (04 §3.3) — loaded from the shipped YAML,     */
/* embedded fallback keeps the script standalone.                      */
/* ------------------------------------------------------------------ */

const FALLBACK_VOCAB = {
  call_type: ['standup', 'planning', 'review', 'demo', 'discovery', '1on1', 'all-hands', 'external', 'mixed'],
  source: ['zoom', 'fireflies', 'granola', 'otter', 'teams', 'meet', 'manual', 'other'],
  platform: ['zoom', 'meet', 'teams', 'phone', 'in-person', 'slack-huddle', 'other'],
  digest_version: ['v0', 'v1'],
  filed_by: ['manual', 'plugin', 'pipeline'],
  ai_status: ['post-call', 'done-on-call', 'monitoring'],
  ai_priority: ['low', 'medium', 'high', 'urgent'],
  member_status: ['draft', 'confirmed', 'stale'],
  member_sources: ['slack', 'tracker', 'docs', 'survey', 'transcripts', 'web'],
  tasks_tracker: ['linear', 'none'],
  autonomy_level: ['L0', 'L1', 'L2'],
};

function loadVocabulary() {
  try {
    const file = path.join(__dirname, '..', 'templates', 'frontmatter', 'controlled-vocabulary.yaml');
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    const t = doc.transcript || {};
    const m = doc.member || {};
    const k = doc.tasks || {};
    const pick = (node, fb) => (node && Array.isArray(node.values) ? node.values : fb);
    return {
      call_type: pick(t.call_type, FALLBACK_VOCAB.call_type),
      source: pick(t.source, FALLBACK_VOCAB.source),
      platform: pick(t.platform, FALLBACK_VOCAB.platform),
      digest_version: pick(t.digest_version, FALLBACK_VOCAB.digest_version),
      filed_by: pick(t.filed_by, FALLBACK_VOCAB.filed_by),
      ai_status: pick(t.action_items && t.action_items.status, FALLBACK_VOCAB.ai_status),
      ai_priority: pick(t.action_items && t.action_items.priority, FALLBACK_VOCAB.ai_priority),
      member_status: pick(m.status, FALLBACK_VOCAB.member_status),
      member_sources: pick(m.sources, FALLBACK_VOCAB.member_sources),
      tasks_tracker: pick(k.tracker, FALLBACK_VOCAB.tasks_tracker),
      autonomy_level: pick(k.autonomy_level, FALLBACK_VOCAB.autonomy_level),
    };
  } catch {
    return { ...FALLBACK_VOCAB };
  }
}

/* ------------------------------------------------------------------ */
/* Constants: naming grammar, frontmatter key sets, digest headings    */
/* ------------------------------------------------------------------ */

// 04 §3.1 validator regex, verbatim.
const NAME_RE = /^\d{4}-\d{2}-\d{2} \d{4} [a-z0-9][a-z0-9 -]{2,60}( w [A-Z][A-Za-z'-]+(,[A-Z][A-Za-z'-]+){0,3})?( \d)?\.(md|vtt)$/;

const TRANSCRIPT_REQUIRED = ['type', 'schema_version', 'team', 'topic', 'date', 'time',
  'duration_min', 'participants', 'language', 'source', 'digest_version'];
const TRANSCRIPT_KEYS = new Set([...TRANSCRIPT_REQUIRED,
  'filed_by', 'filer_model', 'pipeline_version', 'source_id',
  'sub_tag', 'platform', 'call_type', 'tags', 'external_participants',
  'recording_url', 'transcript_file', 'references_prior_calls',
  'action_items',
  // Pipeline provenance keys (build-commit-payload-v2.js, Phase B): tenant
  // name, topic-slug area, and the platform meeting UUID (replay/dedup key).
  'project', 'area', 'zoom_meeting_uuid']);

const MEMBER_REQUIRED = ['type', 'schema_version', 'lastname', 'status'];
const MEMBER_KEYS = new Set([...MEMBER_REQUIRED, 'first_names', 'aliases', 'role', 'team',
  'zones', 'typical_partners', 'languages', 'email', 'slack_user_id', 'tracker_handle',
  'sources', 'last_updated']);

// Company profile (type: company, default docs/company.md — 04/kit decision):
// closed key set like every other frontmatter type; born at A0, may be unfilled.
const COMPANY_KEYS = new Set(['type', 'schema_version', 'name', 'website', 'what_we_do',
  'products', 'stage', 'team_size', 'market', 'sources', 'last_updated']);

// Root names the vault skeleton owns — never valid as tenant team tags/folders
// (a team named "team" would collide with the people-profiles folder).
// Mirrored in init-vault.js and validate-tenant.js (check S8). "private" stays
// reserved even though v0.1 ships no private/ tree (future privacy routing).
const RESERVED_ROOT_NAMES = new Set(['team', 'tasks', 'docs', 'private', 'pipeline', '.backbrief']);

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_BASENAME = 100; // 04 §3.1 length cap

const TASKS_REQUIRED = ['type', 'schema_version', 'call', 'team', 'date', 'tracker',
  'autonomy_level', 'generated', 'counts'];
const TASKS_KEYS = new Set(TASKS_REQUIRED);

// Digest body — TWO first-class profiles (deliberate v0.1 shape, PRD §12):
// the manual/plugin digest (A1, templates/frontmatter/digest.md) vs the
// Phase-B pipeline emitter (build-commit-payload-v2.js, production-verbatim
// body). Selection keys off `filed_by: pipeline` — the provenance value only
// the pipeline writes.
const DIGEST_SECTIONS = ['Summary', 'Decisions', 'Agreements', 'Next steps',
  'Open questions', 'Key insights', 'Transcript'];
const PIPELINE_DIGEST_SECTIONS = ['Summary (Quick brief)', 'Decisions', 'Action items',
  'Open questions', 'Key insights', 'Next 24-48h', 'Transcript'];

const SECRET_SHAPES = /(xox[bpo]-|lin_api_|ghp_[A-Za-z0-9]|github_pat_|sk-ant-)/;
const MMSS_ANCHOR_CANDIDATE = /\((\d{1,4}:\d{1,4}(?::\d{1,4})?)\)/g;
const MMSS_VALID = /^\d{1,3}:[0-5]\d$/;
const ISSUE_REF = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

/* ------------------------------------------------------------------ */
/* Findings collector                                                  */
/* ------------------------------------------------------------------ */

const findings = [];
function err(file, msg) { findings.push({ level: 'error', file, msg }); }
function warn(file, msg) { findings.push({ level: 'warn', file, msg }); }

/* ------------------------------------------------------------------ */
/* Vault discovery + scanning                                          */
/* ------------------------------------------------------------------ */

function findVaultRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.BACKBRIEF_VAULT) return path.resolve(process.env.BACKBRIEF_VAULT);
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.backbrief')) ||
        fs.existsSync(path.join(dir, 'tenant.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const SKIP_DIRS = new Set(['.git', '.backbrief', 'node_modules']);

function walk(root) {
  const files = [];
  (function rec(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) rec(path.join(dir, entry.name));
      } else {
        files.push(path.join(dir, entry.name));
      }
    }
  })(root);
  return files;
}

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const head = text.slice(4, end); // after "---\n"
  const bodyStart = text.indexOf('\n', end + 1);
  return { head, body: bodyStart >= 0 ? text.slice(bodyStart + 1) : '' };
}

/* ------------------------------------------------------------------ */
/* Tenant context (teams, roster)                                      */
/* ------------------------------------------------------------------ */

function loadTenant(vault) {
  const file = path.join(vault, 'tenant.yaml');
  const ctx = {
    loaded: false, teamTags: [], teamFolders: [], mixed: 'general',
    roster: [], aliases: {},
    companyProfile: 'docs/company.md',
  };
  if (!fs.existsSync(file)) { warn('tenant.yaml', 'not found — tenant-dependent checks skipped'); return ctx; }
  let doc;
  try {
    doc = parseYaml(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    err('tenant.yaml', e.message);
    return ctx;
  }
  ctx.loaded = true;
  const vaultCfg = doc.vault || {};
  for (const t of Array.isArray(vaultCfg.teams) ? vaultCfg.teams : []) {
    if (t && t.tag) ctx.teamTags.push(String(t.tag));
    if (t && t.folder) ctx.teamFolders.push(String(t.folder));
    for (const st of Array.isArray(t && t.subteams) ? t.subteams : []) {
      if (st && st.folder) ctx.teamFolders.push(String(st.folder));
    }
  }
  if (vaultCfg.mixed_folder) ctx.mixed = String(vaultCfg.mixed_folder);
  if (vaultCfg.company_profile_path) ctx.companyProfile = String(vaultCfg.company_profile_path);
  for (const r of Array.isArray(doc.roster) ? doc.roster : []) {
    if (r && r.lastname) ctx.roster.push(String(r.lastname));
  }
  // Reserved root names (skeleton-owned) can never be team tags or folders.
  for (const tag of ctx.teamTags) {
    if (RESERVED_ROOT_NAMES.has(tag)) {
      err('tenant.yaml', `team tag "${tag}" is a reserved root name ` +
        `(${[...RESERVED_ROOT_NAMES].join(', ')}) — the vault skeleton owns that folder`);
    }
  }
  for (const folder of ctx.teamFolders) {
    const seg = String(folder).split('/')[0];
    if (RESERVED_ROOT_NAMES.has(seg)) {
      err('tenant.yaml', `team folder "${folder}" sits under the reserved root "${seg}" ` +
        `(${[...RESERVED_ROOT_NAMES].join(', ')}) — pick a folder the skeleton does not own`);
    }
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Check 1 — filenames + .vtt/.md pairing (and check 7 filename bits)  */
/* ------------------------------------------------------------------ */

function checkFilenames(vault, files, opts) {
  const nameLevel = opts.legacyNames ? warn : err;
  const transcriptFiles = files.filter((f) =>
    path.dirname(f).split(path.sep).includes('transcripts') && /\.(md|vtt)$/.test(f));

  const mdBasenames = new Set(transcriptFiles.filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3)));

  for (const f of files) {
    const base = path.basename(f);
    const rel = path.relative(vault, f);
    if (base === '.gitkeep' || base === '.gitignore') continue;
    // 04 §9.7: ASCII filenames, no en dash, no brace tokens — vault-wide.
    if (/[–—]/.test(base)) nameLevel(rel, 'filename contains an en/em dash (04 §3.1: hyphen-minus only)');
    if (/[{}]/.test(base)) nameLevel(rel, 'filename contains brace tokens (04 §3.1: dropped from the grammar)');
    if (/[^\x20-\x7E]/.test(base)) nameLevel(rel, 'filename contains non-ASCII characters (04 §3.1: ASCII only)');
  }

  for (const f of transcriptFiles) {
    const base = path.basename(f);
    const rel = path.relative(vault, f);
    if (base.endsWith('.tasks.md')) { err(rel, 'a .tasks.md belongs in tasks/, not in a transcripts/ folder'); continue; }
    if (base.length > MAX_BASENAME) {
      nameLevel(rel, `basename is ${base.length} chars — exceeds the ${MAX_BASENAME}-char cap (04 §3.1)`);
    }
    if (!NAME_RE.test(base)) {
      nameLevel(rel, 'filename does not match the naming grammar ' +
        '"YYYY-MM-DD HHMM <topic-slug>[ w <Lastname1,Lastname2>].(md|vtt)" (04 §3.1)');
    }
    if (f.endsWith('.vtt') && !mdBasenames.has(f.slice(0, -4))) {
      err(rel, '.vtt has no identically-named .md sibling (04 §9.1)');
    }
  }
  return transcriptFiles.filter((f) => f.endsWith('.md'));
}

/* ------------------------------------------------------------------ */
/* Check 2+3 — transcript frontmatter, digest body                     */
/* ------------------------------------------------------------------ */

function parseFrontmatterOrReport(file, rel) {
  const text = fs.readFileSync(file, 'utf8');
  const split = splitFrontmatter(text);
  if (!split) { err(rel, 'no frontmatter block (--- ... ---) found'); return null; }
  try {
    return { meta: parseYaml(split.head), body: split.body, text };
  } catch (e) {
    err(rel, `frontmatter: ${e.message}`);
    return null;
  }
}

function checkEnum(rel, meta, key, allowed, { required = false, nullable = false } = {}) {
  const v = meta[key];
  if (v === undefined || (v === null && nullable)) {
    if (required) err(rel, `missing required key "${key}"`);
    return;
  }
  if (!allowed.includes(v)) {
    err(rel, `"${key}: ${v}" is not in the controlled vocabulary (${allowed.join(' | ')})`);
  }
}

function checkTranscript(vault, file, tenant, vocab, opts, registry) {
  const rel = path.relative(vault, file);
  const parsed = parseFrontmatterOrReport(file, rel);
  if (!parsed) return;
  const { meta, body } = parsed;

  // -- required keys + closed key set --
  for (const k of TRANSCRIPT_REQUIRED) {
    if (meta[k] === undefined || meta[k] === null || meta[k] === '') err(rel, `missing required key "${k}"`);
  }
  for (const k of Object.keys(meta)) {
    if (!TRANSCRIPT_KEYS.has(k)) err(rel, `unknown frontmatter key "${k}" (closed set per schema_version, 04 §3.2)`);
  }
  if (meta.type !== undefined && meta.type !== 'transcript') err(rel, `type must be "transcript", got "${meta.type}"`);
  if (meta.schema_version !== undefined && meta.schema_version !== 1) {
    err(rel, `schema_version ${meta.schema_version} is not supported (kit knows: 1)`);
  }

  // -- enums --
  checkEnum(rel, meta, 'source', vocab.source, { required: true });
  checkEnum(rel, meta, 'digest_version', vocab.digest_version, { required: true });
  checkEnum(rel, meta, 'call_type', vocab.call_type, { nullable: true });
  checkEnum(rel, meta, 'platform', vocab.platform, { nullable: true });
  checkEnum(rel, meta, 'filed_by', vocab.filed_by, { nullable: true });
  if (meta.language !== undefined && !/^[a-z]{2}$/.test(String(meta.language))) {
    err(rel, `language "${meta.language}" is not an ISO 639-1 code`);
  }
  if (Array.isArray(meta.tags)) {
    for (const t of meta.tags) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(t))) warn(rel, `tag "${t}" is not kebab-case EN`);
    }
  }

  // -- team vs tenant --
  if (tenant.loaded && meta.team !== undefined && meta.team !== null) {
    const okTeams = tenant.teamTags.concat([tenant.mixed]);
    if (!okTeams.includes(meta.team)) {
      err(rel, `team "${meta.team}" is not in tenant.yaml vault.teams[].tag (+ mixed tag "${tenant.mixed}")`);
    }
  }

  // -- participants / owners vs roster (warn — externals happen) --
  const participants = Array.isArray(meta.participants) ? meta.participants : [];
  for (const p of participants) {
    if (/@/.test(String(p))) err(rel, `participant "${p}" is email-shaped — emails are dropped, use roster lastnames (04 §3.2.1)`);
    else if (tenant.loaded && tenant.roster.length && !tenant.roster.includes(String(p))) {
      warn(rel, `participant "${p}" is not in the tenant roster (external? move to external_participants)`);
    }
  }

  // -- provenance group --
  if (meta.filed_by !== undefined && meta.filed_by !== null && meta.filed_by !== 'manual') {
    for (const k of ['filer_model', 'pipeline_version']) {
      if (!meta[k]) err(rel, `filed_by: ${meta.filed_by} requires "${k}"`);
    }
    // The replay/dedup key only exists for automated platform capture
    // (filed_by: pipeline) — a manual A1 (plugin) filing of an exported
    // transcript has no platform id to carry, so no warning there.
    // zoom_meeting_uuid (the pipeline provenance key) satisfies it too.
    if (meta.filed_by === 'pipeline' && !meta.source_id && !meta.zoom_meeting_uuid) {
      warn(rel, `filed_by: pipeline without "source_id"/"zoom_meeting_uuid" — replay/dedup key missing`);
    }
  }

  // -- references_prior_calls: max 5, paths exist --
  if (Array.isArray(meta.references_prior_calls)) {
    if (meta.references_prior_calls.length > 5) err(rel, 'references_prior_calls has more than 5 entries (04 §3.2.3)');
    for (const ref of meta.references_prior_calls) {
      if (!fs.existsSync(path.join(vault, String(ref)))) warn(rel, `references_prior_calls path not found: ${ref}`);
    }
  }

  // -- action_items mirror --
  const trackerRefs = [];
  if (meta.action_items !== undefined && meta.action_items !== null) {
    if (!Array.isArray(meta.action_items)) err(rel, 'action_items must be a list');
    else {
      meta.action_items.forEach((item, i) => {
        if (!item || typeof item !== 'object') { err(rel, `action_items[${i}] must be a map`); return; }
        if (!item.title) err(rel, `action_items[${i}] is missing "title"`);
        if (item.status !== undefined && !vocab.ai_status.includes(item.status)) {
          err(rel, `action_items[${i}].status "${item.status}" not in (${vocab.ai_status.join(' | ')})`);
        }
        if (item.priority !== undefined && !vocab.ai_priority.includes(item.priority)) {
          err(rel, `action_items[${i}].priority "${item.priority}" not in (${vocab.ai_priority.join(' | ')})`);
        }
        if (item.ts !== undefined && item.ts !== null && !MMSS_VALID.test(String(item.ts))) {
          warn(rel, `action_items[${i}].ts "${item.ts}" is not MM:SS`);
        }
        if (item.owner !== undefined && item.owner !== null && tenant.loaded && tenant.roster.length
            && !tenant.roster.includes(String(item.owner))) {
          warn(rel, `action_items[${i}].owner "${item.owner}" is not in the tenant roster`);
        }
        if (item.tracker_ref) trackerRefs.push(String(item.tracker_ref));
      });
    }
  }
  registry.transcripts[rel.split(path.sep).join('/')] = { trackerRefs, meta };

  // -- check 3: digest body sections + anchors --
  // Profile selection: `filed_by: pipeline` ⇒ the Phase-B emitter's body
  // (PIPELINE_DIGEST_SECTIONS); anything else ⇒ the manual/plugin digest
  // template (DIGEST_SECTIONS). Findings name the matched profile.
  const isPipeline = meta.filed_by === 'pipeline';
  const profileName = isPipeline ? 'pipeline profile (filed_by: pipeline)' : 'manual/plugin profile';
  const sections = isPipeline ? PIPELINE_DIGEST_SECTIONS : DIGEST_SECTIONS;
  const headings = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^## (.+?)\s*$/);
    if (m) headings.push(m[1]);
  }
  const present = sections.filter((s) => headings.includes(s));
  const missing = sections.filter((s) => !headings.includes(s));
  for (const s of missing) err(rel, `digest body is missing the "## ${s}" section (${profileName}, 04 §4)`);
  const orderActual = headings.filter((h) => sections.includes(h));
  const orderExpected = sections.filter((s) => present.includes(s));
  if (orderActual.join('|') !== orderExpected.join('|')) {
    err(rel, `digest sections out of canonical order (${profileName}, 04 §4): found [${orderActual.join(', ')}]` +
      (opts.fix ? ' — --fix will reorder if each section appears exactly once' : ''));
    registry.reorderCandidates.push({ file, sections });
  }
  let m;
  MMSS_ANCHOR_CANDIDATE.lastIndex = 0;
  while ((m = MMSS_ANCHOR_CANDIDATE.exec(body)) !== null) {
    if (!MMSS_VALID.test(m[1])) warn(rel, `timestamp anchor "(${m[1]})" is not a well-formed (MM:SS)`);
  }
}

/* ------------------------------------------------------------------ */
/* Check 4 — profiles                                                  */
/* ------------------------------------------------------------------ */

function checkProfiles(vault, files, tenant, vocab) {
  const profileFiles = files.filter((f) => {
    const rel = path.relative(vault, f).split(path.sep);
    return rel.length === 2 && rel[0] === 'team' && rel[1].endsWith('.md')
      && rel[1].toLowerCase() !== 'readme.md';
  });
  const aliasOwners = {}; // alias (lowercased) -> first owning file
  const lastnames = {};
  for (const f of profileFiles) {
    const rel = path.relative(vault, f);
    const parsed = parseFrontmatterOrReport(f, rel);
    if (!parsed) continue;
    const { meta } = parsed;
    for (const k of MEMBER_REQUIRED) {
      if (meta[k] === undefined || meta[k] === null || meta[k] === '') err(rel, `missing required key "${k}"`);
    }
    for (const k of Object.keys(meta)) {
      if (!MEMBER_KEYS.has(k)) err(rel, `unknown frontmatter key "${k}" (closed set, 04 §5)`);
    }
    if (meta.type !== undefined && meta.type !== 'member') err(rel, `type must be "member", got "${meta.type}"`);
    checkEnum(rel, meta, 'status', vocab.member_status, { required: true });
    if (meta.email !== undefined && meta.email !== null && meta.email !== ''
        && !EMAIL_SHAPE.test(String(meta.email))) {
      warn(rel, `email "${meta.email}" does not look like an email address`);
    }
    if (Array.isArray(meta.sources)) {
      for (const s of meta.sources) {
        if (!vocab.member_sources.includes(s)) warn(rel, `sources value "${s}" not in (${vocab.member_sources.join(' | ')})`);
      }
    }
    const base = path.basename(f, '.md');
    if (meta.lastname && base !== String(meta.lastname)) {
      err(rel, `filename "${base}.md" must equal the lastname field "${meta.lastname}" (04 §9.4, D3)`);
    }
    if (meta.lastname) {
      if (lastnames[meta.lastname]) err(rel, `duplicate lastname "${meta.lastname}" (already in ${lastnames[meta.lastname]})`);
      else lastnames[meta.lastname] = rel;
    }
    if (tenant.loaded && tenant.roster.length && meta.lastname && !tenant.roster.includes(String(meta.lastname))) {
      warn(rel, `lastname "${meta.lastname}" is not in the tenant.yaml roster — add it at B1 (generate-tenant.js does this)`);
    }
    for (const a of Array.isArray(meta.aliases) ? meta.aliases : []) {
      const keyA = String(a).toLowerCase();
      if (aliasOwners[keyA] && aliasOwners[keyA] !== rel) {
        err(rel, `alias "${a}" collides with ${aliasOwners[keyA]} — assignee resolution would be ambiguous (04 §5.2)`);
      } else aliasOwners[keyA] = rel;
    }
  }
  // alias vs other lastnames
  for (const [ln, ownRel] of Object.entries(lastnames)) {
    const keyL = ln.toLowerCase();
    if (aliasOwners[keyL] && aliasOwners[keyL] !== ownRel) {
      err(aliasOwners[keyL], `alias "${ln}" collides with the lastname of ${ownRel}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Check 4b — company profile (type: company, default docs/company.md) */
/* ------------------------------------------------------------------ */

function checkCompanyProfile(vault, tenant) {
  const relPath = tenant.companyProfile;
  const abs = path.join(vault, relPath);
  if (!fs.existsSync(abs)) return; // optional artifact (born at A0 in new vaults)
  const parsed = parseFrontmatterOrReport(abs, relPath);
  if (!parsed) return;
  const { meta, text } = parsed;
  if (meta.type !== undefined && meta.type !== 'company') {
    err(relPath, `type must be "company", got "${meta.type}"`);
  }
  for (const k of Object.keys(meta)) {
    if (!COMPANY_KEYS.has(k)) err(relPath, `unknown frontmatter key "${k}" (closed set per schema_version)`);
  }
  if (meta.schema_version !== undefined && meta.schema_version !== 1) {
    err(relPath, `schema_version ${meta.schema_version} is not supported (kit knows: 1)`);
  }
  if (meta.name === undefined || meta.name === null || meta.name === '') {
    warn(relPath, 'company profile is not filled yet — /backbrief start (A0) infers it and asks you to correct');
  }
  const lineCount = text.split(/\r?\n/).length;
  if (lineCount > 60) {
    warn(relPath, `company profile is ${lineCount} lines — keep it <= 60 (injected whole into every digest/task prompt)`);
  }
}

/* ------------------------------------------------------------------ */
/* Check 6 — tasks artifacts                                           */
/* ------------------------------------------------------------------ */

function checkTasksFiles(vault, files, tenant, vocab, registry) {
  const tasksFiles = files.filter((f) => {
    const rel = path.relative(vault, f).split(path.sep);
    return rel[0] === 'tasks' && rel[rel.length - 1].endsWith('.tasks.md');
  });
  for (const f of tasksFiles) {
    const rel = path.relative(vault, f);
    const parsed = parseFrontmatterOrReport(f, rel);
    if (!parsed) continue;
    const { meta, body } = parsed;
    for (const k of TASKS_REQUIRED) {
      if (meta[k] === undefined || meta[k] === null || meta[k] === '') err(rel, `missing required key "${k}"`);
    }
    for (const k of Object.keys(meta)) {
      if (!TASKS_KEYS.has(k)) err(rel, `unknown frontmatter key "${k}" (closed set, 04 §7)`);
    }
    if (meta.type !== undefined && meta.type !== 'tasks') err(rel, `type must be "tasks", got "${meta.type}"`);
    checkEnum(rel, meta, 'tracker', vocab.tasks_tracker, { required: true });
    checkEnum(rel, meta, 'autonomy_level', vocab.autonomy_level, { required: true });

    // call: path exists + deterministic basename pairing (04 §7)
    let callRel = null;
    if (meta.call) {
      callRel = String(meta.call);
      if (!fs.existsSync(path.join(vault, callRel))) {
        err(rel, `call path does not exist: ${callRel}`);
        callRel = null;
      } else {
        const expectedBase = `${path.basename(callRel, '.md')}.tasks.md`;
        if (path.basename(f) !== expectedBase) {
          err(rel, `basename must pair with the call file: expected "${expectedBase}"`);
        }
      }
    }

    // counts arithmetic vs body blocks
    const blocks = [];
    const blockRe = /^## \d+\.\s+(✏️ CREATE|💬 COMMENT|⚠️ FLAG|🔁 DUPLICATE)/gmu;
    let bm;
    while ((bm = blockRe.exec(body)) !== null) blocks.push(bm[1]);
    const decisions = body.match(/\*\*decision:[^*]*\*\*/g) || [];
    const counted = { created: 0, commented: 0, skipped: 0 };
    // pair blocks with their decision lines in order of appearance
    const segments = body.split(/^## \d+\.\s+/m).slice(1);
    segments.forEach((seg) => {
      const marker = (seg.match(/^(✏️ CREATE|💬 COMMENT|⚠️ FLAG|🔁 DUPLICATE)/u) || [])[1];
      const decision = (seg.match(/\*\*decision:([^*]*)\*\*/) || [])[1] || '';
      if (/skipped/i.test(decision)) counted.skipped++;
      else if (/accepted/i.test(decision) || /edited/i.test(decision)) {
        if (marker === '💬 COMMENT') counted.commented++;
        else counted.created++;
      }
    });
    const counts = meta.counts && typeof meta.counts === 'object' ? meta.counts : {};
    if (counts.extracted !== undefined && counts.extracted !== blocks.length) {
      err(rel, `counts.extracted (${counts.extracted}) does not match the ${blocks.length} draft block(s) in the body`);
    }
    for (const k of ['created', 'commented', 'skipped']) {
      if (counts[k] !== undefined && counts[k] !== counted[k]) {
        err(rel, `counts.${k} (${counts[k]}) does not match the body decisions (${counted[k]})`);
      }
    }
    if (blocks.length === 0 && counts.extracted === 0 && !/no actionable items/i.test(body)) {
      warn(rel, 'zero-task file should say "No actionable items — valid outcome." (04 §7.2)');
    }
    if (decisions.length < blocks.length) {
      err(rel, `${blocks.length} draft block(s) but only ${decisions.length} "**decision: …**" line(s) — every draft carries the user's decision (04 §7.1)`);
    }

    // tracker_ref backlinks: both ways (04 §9.6)
    const bodyRefs = new Set();
    let rm;
    ISSUE_REF.lastIndex = 0;
    while ((rm = ISSUE_REF.exec(body)) !== null) bodyRefs.add(rm[1]);
    if (callRel) {
      const t = registry.transcripts[callRel.split(path.sep).join('/')];
      if (t) {
        for (const ref of t.trackerRefs) {
          if (!bodyRefs.has(ref)) {
            err(rel, `transcript action_items.tracker_ref "${ref}" is not mentioned in this tasks file (backlink broken)`);
          }
        }
        const acceptedRefs = [];
        segments.forEach((seg) => {
          const decision = (seg.match(/\*\*decision:([^*]*)\*\*/) || [])[1] || '';
          if (/accepted/i.test(decision)) {
            ISSUE_REF.lastIndex = 0;
            let am;
            while ((am = ISSUE_REF.exec(decision)) !== null) acceptedRefs.push(am[1]);
          }
        });
        for (const ref of acceptedRefs) {
          if (!t.trackerRefs.includes(ref)) {
            warn(rel, `accepted tracker ref "${ref}" is not mirrored back into the transcript's action_items[].tracker_ref`);
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Check 7 — hygiene: secret shapes in file contents                   */
/* ------------------------------------------------------------------ */

function checkSecrets(vault, files) {
  for (const f of files) {
    const rel = path.relative(vault, f);
    let text;
    try {
      if (fs.statSync(f).size > 1024 * 1024) continue; // content files only
      text = fs.readFileSync(f, 'utf8');
    } catch { continue; }
    const m = text.match(SECRET_SHAPES);
    if (m) {
      err(rel, `token-shaped secret ("${m[1]}…") found — secrets never live in vault files, ` +
        'move it to .backbrief/secrets.env (04 §9.7 / 02 §2.3.7)');
    }
  }
}

/* ------------------------------------------------------------------ */
/* --fix: create missing folders + mechanical section reorder          */
/* ------------------------------------------------------------------ */

function applyFix(vault, tenant, reorderCandidates) {
  const made = [];
  const wantDirs = [];
  for (const folder of tenant.teamFolders) wantDirs.push(path.join(folder, 'transcripts'));
  wantDirs.push(path.join(tenant.mixed, 'transcripts'));
  wantDirs.push('team', 'tasks');
  for (const d of wantDirs) {
    const abs = path.join(vault, d);
    if (!fs.existsSync(abs)) {
      if (!DRY_RUN) fs.mkdirSync(abs, { recursive: true });
      made.push(d);
    }
  }

  const reordered = [];
  for (const { file, sections } of reorderCandidates) {
    const text = fs.readFileSync(file, 'utf8');
    const split = splitFrontmatter(text);
    if (!split) continue;
    const bodyLines = split.body.split('\n');
    // slice body into: preamble + one chunk per H2 section
    const chunks = [];
    let current = { heading: null, lines: [] };
    for (const line of bodyLines) {
      const m = line.match(/^## (.+?)\s*$/);
      if (m) {
        chunks.push(current);
        current = { heading: m[1], lines: [line] };
      } else current.lines.push(line);
    }
    chunks.push(current);
    const preamble = chunks.shift();
    const byHeading = {};
    let mechanical = true;
    for (const c of chunks) {
      if (sections.includes(c.heading)) {
        if (byHeading[c.heading]) { mechanical = false; break; } // duplicates: not mechanical
        byHeading[c.heading] = c;
      }
    }
    if (!mechanical || Object.keys(byHeading).length !== chunks.filter((c) => sections.includes(c.heading)).length) continue;
    const known = sections.filter((s) => byHeading[s]).map((s) => byHeading[s]);
    const unknown = chunks.filter((c) => !sections.includes(c.heading));
    const newBody = [preamble, ...known, ...unknown].map((c) => c.lines.join('\n')).join('\n');
    const headEnd = text.indexOf('\n---', 3);
    const headBlock = text.slice(0, text.indexOf('\n', headEnd + 1) + 1);
    if (!DRY_RUN) fs.writeFileSync(file, headBlock + newBody);
    reordered.push(path.relative(vault, file));
  }
  return { made, reordered };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  const opts = { vault: null, fix: false, legacyNames: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--fix') opts.fix = true;
    else if (a === '--legacy-names') opts.legacyNames = true;
    else { console.error(`✖ unknown option: ${a} (see --help)`); process.exit(2); }
  }

  const vault = findVaultRoot(opts.vault);
  if (!vault) {
    console.error('✖ no vault found (no .backbrief/ or tenant.yaml walking up from here) — pass --vault <path>');
    process.exit(2);
  }

  const vocab = loadVocabulary();
  const tenant = loadTenant(vault);
  let files;
  try {
    files = walk(vault);
  } catch (e) {
    console.error(`✖ cannot scan ${vault}: ${e.message}`);
    process.exit(2);
  }

  const registry = { transcripts: {}, reorderCandidates: [] };

  const transcriptMds = checkFilenames(vault, files, opts);
  for (const f of transcriptMds) checkTranscript(vault, f, tenant, vocab, opts, registry);
  checkProfiles(vault, files, tenant, vocab);
  checkCompanyProfile(vault, tenant);
  checkTasksFiles(vault, files, tenant, vocab, registry);
  checkSecrets(vault, files);

  if (opts.fix) {
    const { made, reordered } = applyFix(vault, tenant, registry.reorderCandidates);
    const tag = DRY_RUN ? '[dry-run] would ' : '';
    for (const d of made) console.log(`✔ ${tag}create ${d}/`);
    for (const f of reordered) console.log(`✔ ${tag}reorder digest sections in ${f}`);
  }

  const errors = findings.filter((x) => x.level === 'error');
  const warnings = findings.filter((x) => x.level === 'warn');
  for (const x of findings) {
    console.log(`${x.level === 'error' ? '✖' : '⚠'} ${x.file}: ${x.msg}`);
  }
  console.log(`\nvalidate-vault: ${errors.length} error(s), ${warnings.length} warning(s) — ` +
    `${transcriptMds.length} transcript(s) checked in ${path.relative(process.cwd(), vault) || '.'}`);
  process.exit(errors.length ? 1 : 0);
}

main();
