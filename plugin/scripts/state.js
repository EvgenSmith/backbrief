#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * state.js — Backbrief ladder-state reader/writer (.backbrief/state.yaml).
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies,
 * `--help`, DRY_RUN=1 honored wherever a write happens,
 * exit codes: 0 ok / 1 check failed / 2 operational error.
 *
 * state.yaml holds rung progress, the stack map, resume points, and session
 * counters ONLY — never secrets, never call content (_conventions.md §5).
 * Procedures read it at PREFLIGHT and write it at every step boundary.
 *
 * Subcommands:
 *   get [key]            print state (whole file, or one dotted key) as JSON.
 *                        No state file found => prints `null` (fresh install).
 *   set <key> <value>    write one dotted key (creates the file/dirs if
 *                        missing; atomic tmp+rename write). Writes matching
 *                        ^steps\.|^fork$ auto-regenerate .backbrief/roadmap.md.
 *   log-decision <json>  append one A3 outcome row to
 *                        .backbrief/training/task-decisions.jsonl (the
 *                        training-seed log (PRD FR-A4).
 *   waitlist-observe <slug> [--step <id>] [--emailed]
 *                        record an unsupported-tool observation in
 *                        .backbrief/waitlist.yaml (slugs only, no prose; emails
 *                        live ONLY in the telemetry gateway, never here).
 *   roadmap              regenerate .backbrief/roadmap.md from state.yaml +
 *                        tenant.yaml + waitlist.yaml (the user-facing mirror of
 *                        every deferred step: skip, cost, resume command).
 *   selftest             exercise get/set/waitlist-observe/roadmap in a temp
 *                        vault; exit 0 on pass.
 *
 * Canonical keys used by the Phase-A procedures (informational — any dotted
 * key works):
 *   steps.a0 .. steps.a4, steps.b0 .. steps.b5, steps.b5_5, steps.b6 .. steps.b8
 *                                                pending|in_progress|completed|skipped
 *   steps.<id>_substep                           resume point within a rung
 *   steps.<id>_skip_reason                       short slug/reason recorded at every SKIP
 *                                                (_conventions.md §13) — feeds roadmap.md
 *   persona                                      A0 answer: solo|team_lead|company_lead
 *   stack.calls|chat|tracker|git                 A0 stack map (zoom/slack/linear/github/...)
 *   stack_path                                   golden|custom
 *   team_size_bucket                             lt10|10-50|gt50
 *   fork                                         A4 outcome: deploy|hosted_waitlist|hands_on|declined
 *   counters.calls_processed|tasks_extracted|tasks_accepted|tasks_edited|
 *   counters.tasks_skipped|duplicates_caught     deterministic ROI arithmetic source (A4.2)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.DRY_RUN === '1';

const HELP = `state.js — read/write .backbrief/state.yaml (rung progress, resume points)

Usage:
  node state.js get [key]              print whole state (or one dotted key) as JSON
  node state.js set <key> <value>      set one dotted key (auto-typed; JSON accepted)
  node state.js log-decision '<json>'  append one row to .backbrief/training/task-decisions.jsonl
  node state.js waitlist-observe <slug> [--step <id>] [--emailed]
                                       record an unsupported-tool slug in .backbrief/waitlist.yaml
  node state.js roadmap                regenerate .backbrief/roadmap.md (deferred-steps mirror)
  node state.js selftest               run the built-in self-test in a temp vault

Key syntax: dotted path, e.g. steps.a1, stack.tracker, counters.calls_processed
Value typing on set: true/false/null/integers/floats are typed; values starting
with { or [ are parsed as JSON; everything else is a string.

Options:
  --vault <path>   vault root (default: $BACKBRIEF_VAULT, else walk up from the
                   current directory looking for .backbrief/ or tenant.yaml)
  --step <id>      waitlist-observe: the rung where the tool was named (A0, B3, ...)
  --emailed        waitlist-observe: an email was left at the telemetry gateway
  -h, --help       this text

Environment:
  BACKBRIEF_VAULT  default vault root
  DRY_RUN=1        print what would be written, write nothing

Behavior notes:
  get with no state file prints "null" and exits 0 — that IS the fresh-install
  signal the PREFLIGHT step looks for. get of a missing key prints "null".
  set creates .backbrief/ and state.yaml on first use; writes are atomic
  (tmp file + rename). state.yaml must never hold secrets or call content.
  set on a key matching ^steps\\.|^fork$ also regenerates .backbrief/roadmap.md
  (the user-facing deferred-steps file) — best-effort, never fails the write.
  waitlist-observe stores slugs only — emails go ONLY to the telemetry gateway
  (telemetry.js waitlist), never into the vault.

log-decision required fields:
  call_id, task_title, verdict_proposed (create|comment|duplicate|flag),
  user_action (accepted|edited|skipped). Optional: edit_summary, tracker_ref.
  A "ts" ISO timestamp is added automatically when absent. Extra keys pass
  through unchanged.

Examples:
  node state.js get
  node state.js get steps.a1
  node state.js set steps.a1 completed
  node state.js set steps.b3_skip_reason teams
  node state.js set stack '{"calls":"zoom","chat":"slack","tracker":"linear","git":"github"}'
  node state.js set counters.calls_processed 3
  node state.js waitlist-observe teams --step A0
  node state.js waitlist-observe privacy --step A0   # demand for privacy routing (not in v0.1)
  node state.js roadmap
  node state.js log-decision '{"call_id":"2026-07-10 1300 pricing model review",
    "task_title":"Rewrite pricing page copy","verdict_proposed":"create","user_action":"accepted"}'

Exit codes: 0 ok / 1 check failed (bad key/value/row) / 2 operational error`;

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
/* Minimal YAML serializer (comments are not preserved on set — the    */
/* file is machine state, not documentation).                          */
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
        return pad + '-' + body.slice(indent + 1);
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
      if (Array.isArray(v)) {
        if (!v.length) return `${pad}${key}: []`;
        return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
      }
      if (v !== null && typeof v === 'object') {
        if (!Object.keys(v).length) return `${pad}${key}: {}`;
        return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
      }
      return `${pad}${key}: ${scalarToYaml(v)}`;
    }).join('\n');
  }
  return pad + scalarToYaml(value);
}

/* ------------------------------------------------------------------ */
/* Vault discovery + state I/O                                         */
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

function statePath(vaultRoot) {
  return path.join(vaultRoot, '.backbrief', 'state.yaml');
}

function readState(file) {
  if (!fs.existsSync(file)) return null; // fresh install
  return parseYaml(fs.readFileSync(file, 'utf8'));
}

const STATE_HEADER =
  '# Backbrief ladder state — machine-written via plugin/scripts/state.js.\n' +
  '# Holds rung progress, the stack map, resume points and counters ONLY —\n' +
  '# never secrets, never call content. Do not edit by hand.\n';

function writeState(file, doc) {
  const text = STATE_HEADER + toYaml(doc, 0) + '\n';
  if (DRY_RUN) {
    process.stdout.write(`[dry-run] would write ${file}:\n${text}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ */
/* Roadmap — .backbrief/roadmap.md (the user-facing deferred-steps     */
/* mirror, _conventions.md §13 / item I2-12). Regenerated on every     */
/* steps.<id> / fork write and via the `roadmap` subcommand.           */
/* Deterministic: built from state.yaml + tenant.yaml + waitlist.yaml. */
/* ------------------------------------------------------------------ */

const KIT_ROOT = path.join(__dirname, '..', '..');

function kitVersion() {
  try { return fs.readFileSync(path.join(KIT_ROOT, 'VERSION'), 'utf8').trim(); }
  catch (e) { return '0.0.0'; }
}

// Ladder order + per-rung roadmap copy. `flag` names the tenant.yaml switch a
// completed-then-disabled component shows up under.
const RUNGS = [
  { id: 'a0', label: 'A0 — vault + survey', degradation: 'no vault — nothing else can run', reenable: '/backbrief start' },
  { id: 'a1', label: 'A1 — transcript intake', degradation: 'no calls filed — digests and the demo need at least one call', reenable: '/backbrief start' },
  { id: 'a2', label: 'A2 — team profiles', degradation: 'task owners stay raw name-guesses; digests lose who-is-who', reenable: '/backbrief profiles' },
  { id: 'a3', label: 'A3 — task extraction', degradation: 'digests list next steps, but nothing reaches a tracker', reenable: '/backbrief tasks' },
  { id: 'a4', label: 'A4 — wrap-up demo + fork', degradation: 'no before/after demo; the automation fork is unanswered', reenable: '/backbrief tasks (wrap-up)' },
  { id: 'b0', label: 'B0 — hosting choice', degradation: 'no automatic pipeline — manual mode only', reenable: '/backbrief deploy' },
  { id: 'b1', label: 'B1 — tenant completion', degradation: 'pipeline configuration incomplete', reenable: '/backbrief deploy (step B1)' },
  { id: 'b2', label: 'B2 — Zoom auto-capture', degradation: 'auto-capture off; the pipeline runs only on manually fed transcripts', reenable: '/backbrief deploy (step B2)', flag: 'zoom' },
  { id: 'b3', label: 'B3 — Slack digests', degradation: 'digests stay in the vault; no channel posts or task buttons', reenable: '/backbrief deploy (step B3)', flag: 'slack' },
  { id: 'b4', label: 'B4 — GitHub vault sync', degradation: 'heaviest skip: the pipeline cannot write the vault (local-only)', reenable: '/backbrief deploy (step B4)', flag: 'github' },
  { id: 'b5', label: 'B5 — tracker connection', degradation: 'tasks land in tasks/ files only, no tracker writes', reenable: '/backbrief deploy (step B5)', flag: 'tracker' },
  { id: 'b5_5', label: 'B5.5 — Anthropic API key', degradation: 'the pipeline LLM stages cannot run', reenable: '/backbrief deploy (step B5.5)' },
  { id: 'b6', label: 'B6 — deploy + self-test', degradation: 'workflows not deployed', reenable: '/backbrief deploy (step B6)' },
  { id: 'b7', label: 'B7 — history import', degradation: 'the vault starts from today; no backfill of past calls', reenable: '/backbrief deploy (step B7)', flag: 'history' },
  { id: 'b8', label: 'B8 — registration', degradation: 'no update pings; the install stays anonymous', reenable: '/backbrief deploy (step B8)' },
];

function rungById(id) { return RUNGS.find((r) => r.id === id) || null; }

// Is the tenant flag for this rung explicitly OFF? (post-setup disable)
function flagOff(rung, tenant) {
  if (!rung.flag || !tenant) return false;
  const f = tenant.features || {};
  if (rung.flag === 'slack') return !!(f.slack && f.slack.enabled === false);
  if (rung.flag === 'tracker') return !!(f.tracker && f.tracker.enabled === false);
  if (rung.flag === 'history') return !!(f.history_import && f.history_import.enabled === false);
  if (rung.flag === 'github') return !!(tenant.vault && tenant.vault.repo === null);
  return false; // zoom has no tenant flag (implicit in creds presence)
}

// One entry per deferred step: skipped rungs, plus completed-then-disabled
// components (tenant flag flipped off after the rung ran).
function deferredEntries(stateDoc, tenant) {
  const steps = (stateDoc && stateDoc.steps) || {};
  const out = [];
  for (const rung of RUNGS) {
    const status = steps[rung.id];
    if (status === 'skipped') {
      out.push({
        id: rung.id, label: rung.label, kind: 'skipped',
        reason: typeof steps[`${rung.id}_skip_reason`] === 'string' ? steps[`${rung.id}_skip_reason`] : null,
        degradation: rung.degradation, reenable: rung.reenable,
      });
    } else if (status === 'completed' && flagOff(rung, tenant)) {
      out.push({
        id: rung.id, label: rung.label, kind: 'disabled',
        reason: 'disabled in tenant.yaml after setup',
        degradation: rung.degradation, reenable: rung.reenable,
      });
    }
  }
  return out;
}

// First rung in ladder order that is neither completed nor skipped.
function nextRung(stateDoc) {
  const steps = (stateDoc && stateDoc.steps) || {};
  for (const rung of RUNGS) {
    const s = steps[rung.id];
    if (s !== 'completed' && s !== 'skipped') return rung;
  }
  return null;
}

function waitlistPath(vaultRoot) {
  return path.join(vaultRoot, '.backbrief', 'waitlist.yaml');
}

// Lenient read: accepts both the legacy shorthand (observed: [slug, …]) and
// the structured form written by waitlist-observe below.
function readWaitlist(vaultRoot) {
  const file = waitlistPath(vaultRoot);
  if (!fs.existsSync(file)) return { observed: [] };
  let doc;
  try { doc = parseYaml(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { observed: [], parse_error: e.message }; }
  const raw = (doc && Array.isArray(doc.observed)) ? doc.observed : [];
  const observed = raw.map((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return { slug: String(item.slug || ''), step: item.step ? String(item.step) : null,
        date: item.date ? String(item.date) : null, emailed: item.emailed === true };
    }
    return { slug: String(item), step: null, date: null, emailed: false };
  }).filter((e) => e.slug);
  return { observed };
}

const WAITLIST_HEADER =
  '# Backbrief connector waitlist — machine-written via `state.js waitlist-observe`.\n' +
  '# One entry per unsupported tool observed during setup. Slugs only, no prose;\n' +
  '# emails live ONLY in the telemetry gateway (telemetry.js waitlist), never here.\n';

function writeWaitlist(vaultRoot, doc) {
  const file = waitlistPath(vaultRoot);
  const body = doc.observed.length
    ? toYaml({ observed: doc.observed.map((e) => {
        const row = { slug: e.slug };
        if (e.step) row.step = e.step;
        if (e.date) row.date = e.date;
        row.emailed = e.emailed === true;
        return row;
      }) }, 0)
    : 'observed: []';
  const text = WAITLIST_HEADER + body + '\n';
  if (DRY_RUN) { process.stdout.write(`[dry-run] would write ${file}:\n${text}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// MUST produce the same slug as telemetry.js slugTool (strip, never hyphenate:
// "Google Meet" -> "googlemeet") — the gateway demand counters key on the slug,
// and a vault/telemetry divergence fragments them. Keep the two in sync.
function slugify(raw) {
  return String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
}

function waitlistObserve(vaultRoot, rawSlug, step, emailed) {
  const slug = slugify(rawSlug);
  if (!slug) { console.error('✖ waitlist-observe: empty slug'); process.exit(1); }
  const doc = readWaitlist(vaultRoot);
  const hit = doc.observed.find((e) => e.slug === slug);
  if (hit) {
    if (step && !hit.step) hit.step = step;
    if (emailed) hit.emailed = true;
  } else {
    doc.observed.push({ slug, step: step || null, date: new Date().toISOString().slice(0, 10), emailed: !!emailed });
  }
  writeWaitlist(vaultRoot, doc);
  if (!DRY_RUN) process.stdout.write(`✔ waitlist: ${slug}${step ? ` (step ${step})` : ''}${emailed ? ' [emailed]' : ''} → .backbrief/waitlist.yaml\n`);
}

// Lenient tenant.yaml read for roadmap purposes only (never fails hard).
function readTenantLenient(vaultRoot) {
  const file = path.join(vaultRoot, 'tenant.yaml');
  if (!fs.existsSync(file)) return null;
  try { return parseYaml(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function buildRoadmap(stateDoc, tenant, waitlist) {
  const lines = [];
  lines.push('---');
  lines.push('type: roadmap');
  lines.push('schema_version: 1');
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`kit_version: ${kitVersion()}`);
  lines.push('---');
  lines.push('');
  lines.push('# Backbrief roadmap — deferred setup steps');
  lines.push('');
  lines.push('> Machine-regenerated by `plugin/scripts/state.js` on every step write — do not');
  lines.push('> edit by hand. Each entry names what was deferred, what it costs, and the command');
  lines.push('> that resumes it. `/backbrief status` shows the same summary.');
  lines.push('');
  lines.push('## Deferred steps');
  lines.push('');
  const deferred = deferredEntries(stateDoc, tenant);
  if (!deferred.length) {
    lines.push('None. Nothing is deferred — every visited step is either done or still ahead.');
  } else {
    for (const d of deferred) {
      lines.push(`- **${d.label}** — ${d.kind}${d.reason ? ` (reason: ${d.reason})` : ''}`);
      lines.push(`  - costs: ${d.degradation}`);
      lines.push(`  - resume: \`${d.reenable}\``);
    }
  }
  lines.push('');
  lines.push('## Watching for connectors');
  lines.push('');
  const observed = (waitlist && waitlist.observed) || [];
  if (!observed.length) {
    lines.push('None observed yet.');
  } else {
    for (const w of observed) {
      lines.push(`- \`${w.slug}\`${w.step ? ` — observed at ${w.step}` : ''}${w.date ? ` (${w.date})` : ''}${w.emailed ? ' · email left on the waitlist' : ' · no email left'}`);
    }
  }
  const fork = stateDoc && stateDoc.fork;
  if (fork === 'hosted_waitlist') lines.push('- hosted pipeline — you are on the hosted waitlist (A4).');
  if (fork === 'hands_on') lines.push('- hands-on setup — you are on the hands-on waitlist (A4).');
  lines.push('');
  lines.push('## Next suggested rung');
  lines.push('');
  const next = nextRung(stateDoc);
  lines.push(next ? `**${next.label}** → \`${next.reenable}\`` : 'All rungs complete. 🎉');
  lines.push('');
  return lines.join('\n');
}

function roadmapPath(vaultRoot) {
  return path.join(vaultRoot, '.backbrief', 'roadmap.md');
}

function regenerateRoadmap(vaultRoot) {
  const file = roadmapPath(vaultRoot);
  let stateDoc = null;
  try { stateDoc = readState(statePath(vaultRoot)); } catch (e) { stateDoc = null; }
  const text = buildRoadmap(stateDoc, readTenantLenient(vaultRoot), readWaitlist(vaultRoot));
  if (DRY_RUN) { process.stdout.write(`[dry-run] would write ${file}\n`); return file; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return file;
}

/* ------------------------------------------------------------------ */
/* Dotted-path helpers                                                 */
/* ------------------------------------------------------------------ */

const KEY_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

function getPath(doc, key) {
  let cur = doc;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = cur[part];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function setPath(doc, key, value) {
  const parts = key.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === null || cur[p] === undefined || typeof cur[p] !== 'object' || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function typeCliValue(raw) {
  const s = String(raw);
  if (/^[\[{"]/.test(s.trim())) {
    try { return JSON.parse(s); } catch (e) {
      throw new Error(`value looks like JSON but does not parse: ${e.message}`);
    }
  }
  return typeScalar(s);
}

/* ------------------------------------------------------------------ */
/* log-decision — the A3 training-seed writer                          */
/* ------------------------------------------------------------------ */

const VERDICTS = ['create', 'comment', 'duplicate', 'flag'];
const USER_ACTIONS = ['accepted', 'edited', 'skipped'];

function logDecision(vaultRoot, jsonArg) {
  let row;
  try {
    row = JSON.parse(jsonArg);
  } catch (e) {
    console.error(`✖ log-decision: argument is not valid JSON — ${e.message}`);
    process.exit(1);
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    console.error('✖ log-decision: the row must be a JSON object');
    process.exit(1);
  }
  const problems = [];
  for (const req of ['call_id', 'task_title', 'verdict_proposed', 'user_action']) {
    if (typeof row[req] !== 'string' || !row[req]) problems.push(`missing/empty "${req}"`);
  }
  if (row.verdict_proposed && !VERDICTS.includes(row.verdict_proposed)) {
    problems.push(`verdict_proposed must be one of ${VERDICTS.join('|')}`);
  }
  if (row.user_action && !USER_ACTIONS.includes(row.user_action)) {
    problems.push(`user_action must be one of ${USER_ACTIONS.join('|')}`);
  }
  if (problems.length) {
    console.error(`✖ log-decision: ${problems.join('; ')}`);
    process.exit(1);
  }
  if (!row.ts) row.ts = new Date().toISOString();
  const file = path.join(vaultRoot, '.backbrief', 'training', 'task-decisions.jsonl');
  const line = JSON.stringify(row) + '\n';
  if (DRY_RUN) {
    process.stdout.write(`[dry-run] would append to ${file}:\n${line}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line);
  process.stdout.write(`✔ logged decision (${row.user_action}) → ${path.relative(vaultRoot, file)}\n`);
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { vault: null, help: false, step: null, emailed: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--step') opts.step = argv[++i];
    else if (a === '--emailed') opts.emailed = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-') && a !== '-') {
      console.error(`unknown option: ${a} (see --help)`);
      process.exit(2);
    } else opts.positional.push(a);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.positional.length) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 2);
  }
  const [sub, ...rest] = opts.positional;

  if (sub === 'selftest') { selftest(); return; }

  const vaultRoot = findVaultRoot(opts.vault);
  if (!vaultRoot) {
    if (sub === 'get') {
      // No vault anywhere reachable = fresh install; PREFLIGHT relies on this.
      process.stdout.write('null\n');
      process.exit(0);
    }
    console.error('✖ no vault found (no .backbrief/ or tenant.yaml walking up from here) — ' +
      'pass --vault <path> or run init-vault.js first');
    process.exit(2);
  }
  const file = statePath(vaultRoot);

  if (sub === 'get') {
    const key = rest[0];
    if (key !== undefined && !KEY_RE.test(key)) {
      console.error(`✖ bad key "${key}" — dotted [A-Za-z0-9_-] segments only`);
      process.exit(1);
    }
    let doc;
    try {
      doc = readState(file);
    } catch (e) {
      console.error(`✖ ${file}: ${e.message}`);
      process.exit(2);
    }
    if (doc === null) { process.stdout.write('null\n'); process.exit(0); }
    const value = key === undefined ? doc : getPath(doc, key);
    process.stdout.write(JSON.stringify(value === undefined ? null : value, null, 2) + '\n');
    process.exit(0);
  }

  if (sub === 'set') {
    const [key, ...valueParts] = rest;
    if (!key || !valueParts.length) {
      console.error('✖ usage: state.js set <key> <value> (see --help)');
      process.exit(2);
    }
    if (!KEY_RE.test(key)) {
      console.error(`✖ bad key "${key}" — dotted [A-Za-z0-9_-] segments only`);
      process.exit(1);
    }
    let value;
    try {
      value = typeCliValue(valueParts.join(' '));
    } catch (e) {
      console.error(`✖ ${e.message}`);
      process.exit(1);
    }
    let doc;
    try {
      doc = readState(file);
    } catch (e) {
      console.error(`✖ ${file}: ${e.message} — fix or delete the file, then retry`);
      process.exit(2);
    }
    // A non-map root (e.g. a YAML list) parses fine but cannot hold dotted
    // keys — setPath would stamp properties the serializer silently drops.
    // Refuse loudly instead of "✔"-ing a write that vanishes.
    if (doc !== null && (typeof doc !== 'object' || Array.isArray(doc))) {
      console.error(`✖ ${file}: state.yaml is not a map — fix or delete it, then retry`);
      process.exit(2);
    }
    if (doc === null) doc = { schema_version: 1, created: new Date().toISOString() };
    setPath(doc, key, value);
    doc.updated = new Date().toISOString();
    try {
      writeState(file, doc);
    } catch (e) {
      console.error(`✖ cannot write ${file}: ${e.message}`);
      process.exit(2);
    }
    if (!DRY_RUN) process.stdout.write(`✔ ${key} = ${JSON.stringify(value)}\n`);
    // Deferred-steps mirror: any rung/fork write refreshes .backbrief/roadmap.md
    // (best-effort — a roadmap failure must never fail the state write).
    if (/^steps\.|^fork$/.test(key)) {
      try {
        const rp = regenerateRoadmap(vaultRoot);
        if (!DRY_RUN) process.stdout.write(`✔ roadmap refreshed → ${path.relative(vaultRoot, rp)}\n`);
      } catch (e) {
        console.error(`⚠ roadmap refresh failed (${e.message}) — run: state.js roadmap`);
      }
    }
    process.exit(0);
  }

  if (sub === 'log-decision') {
    if (!rest.length) {
      console.error('✖ usage: state.js log-decision \'<json>\' (see --help)');
      process.exit(2);
    }
    logDecision(vaultRoot, rest.join(' '));
    process.exit(0);
  }

  if (sub === 'waitlist-observe') {
    if (!rest.length) {
      console.error('✖ usage: state.js waitlist-observe <slug> [--step <id>] [--emailed] (see --help)');
      process.exit(2);
    }
    waitlistObserve(vaultRoot, rest[0], opts.step, opts.emailed);
    try { regenerateRoadmap(vaultRoot); } catch (e) { /* best effort */ }
    process.exit(0);
  }

  if (sub === 'roadmap') {
    try {
      const rp = regenerateRoadmap(vaultRoot);
      if (!DRY_RUN) process.stdout.write(`✔ roadmap written → ${rp}\n`);
      process.exit(0);
    } catch (e) {
      console.error(`✖ roadmap generation failed: ${e.message}`);
      process.exit(2);
    }
  }

  console.error(`✖ unknown subcommand "${sub}" (see --help)`);
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* Self-test (state.js selftest) — exercises the write/read/roadmap    */
/* loop in a throwaway vault; used by the kit's own checks.            */
/* ------------------------------------------------------------------ */

function selftest() {
  const os = require('os');
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'backbrief-state-selftest-'));
  const failures = [];
  const check = (name, cond) => { if (!cond) failures.push(name); };
  try {
    const file = statePath(tmpVault);
    // 1. Fresh install: no state file.
    check('fresh readState is null', readState(file) === null);
    // 2. set + get round-trip via internals.
    let doc = { schema_version: 1, created: new Date().toISOString() };
    setPath(doc, 'steps.a0', 'completed');
    setPath(doc, 'steps.a1', 'skipped');
    setPath(doc, 'steps.a1_skip_reason', 'no-transcripts');
    setPath(doc, 'stack', { calls: 'meet', chat: 'slack', tracker: 'linear', git: 'github' });
    writeState(file, doc);
    const back = readState(file);
    check('steps.a1 round-trips', getPath(back, 'steps.a1') === 'skipped');
    check('skip reason round-trips', getPath(back, 'steps.a1_skip_reason') === 'no-transcripts');
    check('stack map round-trips', getPath(back, 'stack.calls') === 'meet');
    // 3. waitlist-observe + dedupe.
    const origLog = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true; // silence ✔ lines during the test
    try {
      // "MS Teams!" must slug exactly like telemetry.js slugTool: "msteams".
      waitlistObserve(tmpVault, 'MS Teams!', 'A0', false);
      waitlistObserve(tmpVault, 'msteams', 'B3', true);
    } finally { process.stdout.write = origLog; }
    const wl = readWaitlist(tmpVault);
    check('waitlist slugified + deduped', wl.observed.length === 1 && wl.observed[0].slug === 'msteams');
    check('waitlist slug matches telemetry slugTool', slugify('Google Meet') === 'googlemeet');
    check('waitlist emailed upgraded', wl.observed[0].emailed === true);
    // 4. roadmap generation.
    const rp = regenerateRoadmap(tmpVault);
    const text = fs.readFileSync(rp, 'utf8');
    check('roadmap lists the skipped rung', /A1 — transcript intake/.test(text));
    check('roadmap carries the skip reason', /no-transcripts/.test(text));
    check('roadmap watches the connector', /msteams/.test(text));
    check('roadmap suggests next rung A2', /A2 — team profiles/.test(text));
    // 5. next rung skips over skipped rungs.
    check('nextRung returns a2', (nextRung(readState(file)) || {}).id === 'a2');
    // 6. deferred entries.
    const deferred = deferredEntries(readState(file), null);
    check('one deferred entry', deferred.length === 1 && deferred[0].id === 'a1');
  } catch (e) {
    failures.push(`unexpected error: ${e.message}`);
  } finally {
    try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
  if (failures.length) {
    console.error(`✖ state.js selftest FAILED:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('✅ state.js selftest ok (get/set, skip reasons, waitlist-observe, roadmap, next-rung)');
  process.exit(0);
}

if (require.main === module) main();

// Exposed for status.js (Deferred line + deterministic Next) — CLI behavior is
// unchanged; requiring this module runs nothing.
module.exports = {
  parseYaml,
  toYaml,
  RUNGS,
  rungById,
  deferredEntries,
  nextRung,
  readWaitlist,
  buildRoadmap,
  regenerateRoadmap,
  roadmapPath,
  readStateFile: readState,
  statePath,
  findVaultRoot,
};
