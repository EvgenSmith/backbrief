#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * telemetry.js — Backbrief opt-in telemetry client.
 *
 * Kit script conventions: Node >= 18, zero npm dependencies,
 * `--help`, DRY_RUN=1 honored wherever a write happens.
 *
 * Hard rules this client enforces:
 *   - OPT-IN: without `features.telemetry.enabled: true` in tenant.yaml every
 *     `event` call is a silent no-op (zero outbound calls). The waitlist
 *     subcommand is the one exception — an explicitly typed email IS the
 *     consent, and it still sends only what the user typed.
 *   - NEVER content: the wire allowlist (mirrored from gateway/worker.js) is
 *     enforced client-side too. Anything outside the closed enum/counter
 *     vocabulary is dropped before it can leave the machine.
 *   - Silent fail: one send attempt, 2 s timeout, all network errors
 *     swallowed — a dead gateway must never dent UX (exit 0 on every event
 *     path). The waitlist subcommand is user-confirmed, so it reports its
 *     outcome honestly instead.
 *   - Anonymous: install_id is a locally generated random UUIDv4 stored in
 *     tenant.yaml at consent; it is never derived from anything
 *     identifying. If consent is on but the id is missing, this script
 *     generates one and persists it back into the telemetry block.
 *
 * Also usable as a library: require('./telemetry.js') exposes readConfig /
 * sendEvent / sendWaitlist and the wire-contract constants (main() only runs
 * when invoked directly).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ENDPOINT = 'https://backbrief-telemetry.backbrief.workers.dev';
const EVENT_TIMEOUT_MS = 2000;
const DRY_RUN = process.env.DRY_RUN === '1';
const DEBUG = process.env.TELEMETRY_DEBUG === '1';

/* ------------------------------------------------------------------ */
/* Wire contract — keep in sync with gateway/worker.js.                */
/* Both sides enforce the same closed allowlist.                       */
/* ------------------------------------------------------------------ */

const EVENTS = ['install', 'step_started', 'step_completed', 'step_skipped',
  'calls_processed', 'tasks_verdict', 'connector_demand', 'status_run', 'error'];
const STEP_EVENTS = ['step_started', 'step_completed', 'step_skipped'];
const STEPS = ['A0', 'A1', 'A2', 'A3', 'A4',
  'B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B5.5', 'B6', 'B7', 'B8'];
// 'B5.5' — the required Anthropic API key rung between B5 and B6 (deploy.md
// "Step B5.5"). A literal step id; keep in sync with gateway/worker.js.
// 'privacy' captures demand for privacy routing (1:1/board/legal auto-routing),
// which is deliberately not part of v0.1. Keep in sync with gateway/worker.js.
const INTERESTS = ['hosted', 'hands_on', 'connector', 'updates', 'privacy'];

// Closed enum of failure classes for the `error` event.
const ERROR_CLASSES = ['creds_zoom', 'creds_slack', 'creds_github', 'creds_linear',
  'creds_jira', 'creds_anthropic', 'env_check', 'tenant_validate', 'vault_validate',
  'normalize_transcript', 'deploy_put', 'webhook_selftest', 'history_import',
  'dlq_redrive', 'update_check', 'network', 'unknown'];

const STEP_PROPS = ['count', 'team_size_bucket', 'stack_path', 'source',
  'fork', 'hosting', 'tracker', 'persona'];

const PROPS_BY_EVENT = {
  install: [],
  step_started: STEP_PROPS,
  step_completed: STEP_PROPS,
  step_skipped: STEP_PROPS,
  calls_processed: ['count'],
  tasks_verdict: ['verdict', 'dedup', 'tracker'],
  connector_demand: ['tool'],
  status_run: ['count'],
  error: ['error_class'],
};

const ENUM_PROPS = {
  verdict: ['accepted', 'edited', 'skipped'],
  dedup: ['create', 'comment', 'duplicate', 'flag'],
  tracker: ['linear', 'jira', 'other', 'none'],
  team_size_bucket: ['lt10', '10-50', 'gt50'],
  stack_path: ['golden', 'custom'],
  source: ['slack', 'tracker', 'docs', 'survey'],
  fork: ['deploy', 'hosted_waitlist', 'hands_on', 'declined'],
  hosting: ['cloud', 'docker'],
  persona: ['solo', 'team_lead', 'company_lead'],
  error_class: ERROR_CLASSES,
};

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_COUNT = 100000;

const HELP = `telemetry.js — Backbrief opt-in telemetry client (gateway contract: gateway/schema.md)

Usage:
  node telemetry.js event <event> [<step>] [--<prop>=<value> ...]
  node telemetry.js waitlist --interest=<interest> --email=<address>
                             [--tool=<name>] [--source-step=<step>]

Subcommands:
  event      fire a step event / counter. Silent no-op unless
             features.telemetry.enabled: true in tenant.yaml. One send attempt,
             2 s timeout, all failures swallowed — ALWAYS exits 0.
  waitlist   join the waitlist (email required — typing it is the consent).
             Works even when telemetry is disabled; sends install_id only if
             one exists (i.e. telemetry consent was given).

Events (closed enum — anything else is dropped client-side):
  ${EVENTS.join(' | ')}
Steps: ${STEPS.join(' ')}   (required for step_* events)

Props (per-event allowlist, counters/enums only — never content):
  --count=<int>              calls_processed / status_run / step_* batch size
  --verdict=<v>              tasks_verdict: ${ENUM_PROPS.verdict.join('|')}
  --dedup=<v>                tasks_verdict: ${ENUM_PROPS.dedup.join('|')}
  --tracker=<v>              ${ENUM_PROPS.tracker.join('|')}
  --team-size-bucket=<v>     ${ENUM_PROPS.team_size_bucket.join('|')}
  --stack-path=<v>           ${ENUM_PROPS.stack_path.join('|')}
  --source=<v>               ${ENUM_PROPS.source.join('|')}
  --fork=<v>                 ${ENUM_PROPS.fork.join('|')}
  --hosting=<v>              ${ENUM_PROPS.hosting.join('|')}
  --persona=<v>              ${ENUM_PROPS.persona.join('|')} (A0 persona fork)
  --tool=<name>              connector_demand / waitlist: slugged to <=32 chars
  --error-class=<v>          error: closed failure-class enum

Waitlist:
  --interest=<v>             required: ${INTERESTS.join('|')}
  --email=<address>          required, validated
  --source-step=<step>       where in the ladder demand appeared (A0..B8)

Options:
  --tenant <path>   tenant.yaml to read (default: $TENANT, else walk up from
                    the current directory looking for tenant.yaml)
  --vault <path>    vault root — shorthand for --tenant <path>/tenant.yaml
                    (same convention as the sibling scripts)
  -h, --help        this text

Environment:
  TENANT             default tenant.yaml path
  DRY_RUN=1          print the payload that would be sent, send/write nothing
  TELEMETRY_DEBUG=1  explain no-ops and swallowed errors on stderr

Examples:
  node telemetry.js event step_completed A3
  node telemetry.js event calls_processed --count=3
  node telemetry.js event tasks_verdict --verdict=accepted --dedup=create --tracker=linear
  node telemetry.js event connector_demand --tool=asana
  node telemetry.js event error B2 --error-class=creds_zoom
  node telemetry.js waitlist --interest=connector --tool=asana --email=user@example.com

Exit codes:
  event:     always 0 (invalid payloads are dropped with a stderr note;
             network failures are swallowed — telemetry never fails the caller)
  waitlist:  0 accepted or already on the list / 1 gateway unreachable /
             2 usage error (missing or invalid --email / --interest)
  usage:     2 (unknown subcommand or option)`;

/* ------------------------------------------------------------------ */
/* Lenient YAML-subset reader — enough to extract features.telemetry.* */
/* from a tenant.yaml written by the kit. Never throws to the caller:  */
/* unparseable file => telemetry treated as disabled.                  */
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

function typeScalar(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2)
      || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true' || s === 'True') return true;
  if (s === 'false' || s === 'False') return false;
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)$/.test(s)) return parseFloat(s);
  return s; // flow lists/maps and anything exotic stay raw strings — we never read those
}

// Lenient block-map parse: nested maps + scalar leaves; list items and
// unrecognized lines are skipped (we only ever read features.telemetry.*).
function parseYamlLenient(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const body = line.trim();
    if (body.startsWith('- ') || body === '-') continue; // list items: not needed
    const m = body.match(/^([^:\s][^:]*?)\s*:(?:\s+(.*))?$/);
    if (!m) continue;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const key = m[1].replace(/^["']|["']$/g, '');
    if (m[2] === undefined || m[2].trim() === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = typeScalar(m[2]);
    }
  }
  return root;
}

/* ------------------------------------------------------------------ */
/* Tenant discovery + config                                           */
/* ------------------------------------------------------------------ */

function findTenantFile(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.TENANT) return path.resolve(process.env.TENANT);
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'tenant.yaml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// { enabled, installId, endpoint, tenantPath } — never throws.
function readConfig(explicitTenantPath) {
  const cfg = { enabled: false, installId: null, endpoint: DEFAULT_ENDPOINT, tenantPath: null };
  try {
    const tenantPath = findTenantFile(explicitTenantPath);
    if (!tenantPath || !fs.existsSync(tenantPath)) return cfg;
    cfg.tenantPath = tenantPath;
    const doc = parseYamlLenient(fs.readFileSync(tenantPath, 'utf8'));
    const tel = doc && doc.features && doc.features.telemetry;
    if (!tel || typeof tel !== 'object') return cfg;
    cfg.enabled = tel.enabled === true;
    if (typeof tel.install_id === 'string' && UUID_V4_RE.test(tel.install_id)) {
      cfg.installId = tel.install_id;
    }
    if (typeof tel.endpoint === 'string' && /^https?:\/\//.test(tel.endpoint)) {
      cfg.endpoint = tel.endpoint.replace(/\/+$/, '');
    }
  } catch (e) {
    debug(`tenant.yaml unreadable (${e.message}) — treating telemetry as disabled`);
  }
  return cfg;
}

// Surgical insert/replace of install_id inside the telemetry: block —
// preserves the rest of the file (comments included). Returns true on success.
function persistInstallId(tenantPath, id) {
  try {
    const raw = fs.readFileSync(tenantPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let telIdx = -1;
    let telIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = stripComment(lines[i]).match(/^(\s*)telemetry:\s*$/);
      if (m) { telIdx = i; telIndent = m[1].length; break; }
    }
    if (telIdx < 0) return false;
    let insertAfter = telIdx;
    let childIndent = null;
    for (let i = telIdx + 1; i < lines.length; i++) {
      const stripped = stripComment(lines[i]);
      if (!stripped.trim()) continue;               // blank / comment-only lines
      const indent = stripped.match(/^ */)[0].length;
      if (indent <= telIndent) break;               // block ended
      if (childIndent === null) childIndent = indent;
      if (/^\s*install_id\s*:/.test(stripped)) {    // replace an empty/stale value
        lines[i] = `${' '.repeat(indent)}install_id: ${id}`;
        fs.writeFileSync(tenantPath, lines.join('\n'));
        return true;
      }
      insertAfter = i;
    }
    const pad = ' '.repeat(childIndent === null ? telIndent + 2 : childIndent);
    lines.splice(insertAfter + 1, 0, `${pad}install_id: ${id}`);
    fs.writeFileSync(tenantPath, lines.join('\n'));
    return true;
  } catch (e) {
    debug(`could not persist install_id (${e.message}) — using it for this send only`);
    return false;
  }
}

// install_id is created only at consent; init-vault.js writes it at
// A0. Self-heal here covers hand-edited tenant files so funnel counts stay
// stable (an ephemeral id per ping would look like a new install every time).
function ensureInstallId(cfg) {
  if (cfg.installId) return cfg.installId;
  const id = crypto.randomUUID();
  if (!DRY_RUN && cfg.tenantPath) persistInstallId(cfg.tenantPath, id);
  cfg.installId = id;
  return id;
}

/* ------------------------------------------------------------------ */
/* Client-side allowlist enforcement (mirror of the gateway validator) */
/* ------------------------------------------------------------------ */

function slugTool(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
}

function validateEventPayload(b) {
  if (!EVENTS.includes(b.event)) return `event "${b.event}" is not in the allowlist (${EVENTS.join('|')})`;
  if (STEP_EVENTS.includes(b.event) && !STEPS.includes(b.step)) {
    return `step is required for ${b.event} (one of ${STEPS.join('|')})`;
  }
  if (b.step !== undefined && !STEPS.includes(b.step)) {
    return `step "${b.step}" is not in the allowlist`;
  }
  if (b.props !== undefined) {
    const allowed = PROPS_BY_EVENT[b.event];
    for (const [k, v] of Object.entries(b.props)) {
      if (!allowed.includes(k)) return `props.${k} is not allowed for event "${b.event}"`;
      if (k === 'count') {
        if (!Number.isInteger(v) || v < 0 || v > MAX_COUNT) return 'props.count must be an integer 0..100000';
      } else if (k === 'tool') {
        if (typeof v !== 'string' || !v) return 'props.tool must be a non-empty slug';
      } else if (!ENUM_PROPS[k].includes(v)) {
        return `props.${k} "${v}" is not in the allowlist (${ENUM_PROPS[k].join('|')})`;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function readKitVersion() {
  const candidates = [
    () => JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version,
    () => fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim(),
  ];
  for (const read of candidates) {
    try {
      const v = read();
      if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) return v;
    } catch { /* next candidate */ }
  }
  return '0.0.0';
}

async function post(url, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

/* ------------------------------------------------------------------ */
/* Library API                                                         */
/* ------------------------------------------------------------------ */

// Fire one event. Resolves true if accepted, false on any no-op/failure.
// Never throws, never retries (one 2 s attempt, failures swallowed).
async function sendEvent(event, step, props, opts) {
  opts = opts || {};
  const cfg = opts.config || readConfig(opts.tenantPath);
  if (!cfg.enabled) {
    debug('telemetry disabled (features.telemetry.enabled is not true) — no-op');
    return false;
  }
  const payload = {
    install_id: ensureInstallId(cfg),
    kit_version: readKitVersion(),
    event,
    ts: new Date().toISOString(),
  };
  if (step !== undefined && step !== null) payload.step = step;
  if (props && Object.keys(props).length) {
    if (props.tool !== undefined) props = { ...props, tool: slugTool(props.tool) };
    payload.props = props;
  }
  const bad = validateEventPayload(payload);
  if (bad) {
    process.stderr.write(`telemetry: dropped — ${bad}\n`);
    return false;
  }
  if (DRY_RUN) {
    process.stdout.write(`[dry-run] POST ${cfg.endpoint}/v1/events\n${JSON.stringify(payload, null, 2)}\n`);
    return true;
  }
  try {
    const res = await post(`${cfg.endpoint}/v1/events`, payload, EVENT_TIMEOUT_MS);
    debug(`gateway responded ${res.status}`);
    return res.status === 204;
  } catch (e) {
    debug(`send failed (${e.name}: ${e.message}) — swallowed`);
    return false;
  }
}

// Join the waitlist. Email required — an explicitly typed email is the
// consent, so this works even when telemetry is disabled. Returns
// { ok, dup, error? }. One retry allowed (user-confirmed action).
async function sendWaitlist(fields, opts) {
  opts = opts || {};
  const cfg = opts.config || readConfig(opts.tenantPath);
  const payload = { email: fields.email, interest: fields.interest };
  if (fields.tool) payload.tool = slugTool(fields.tool);
  if (fields.source_step) payload.source_step = fields.source_step;
  if (cfg.installId) payload.install_id = cfg.installId; // only if consent created one
  if (DRY_RUN) {
    process.stdout.write(`[dry-run] POST ${cfg.endpoint}/v1/waitlist\n${JSON.stringify(payload, null, 2)}\n`);
    return { ok: true, dup: false };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await post(`${cfg.endpoint}/v1/waitlist`, payload, EVENT_TIMEOUT_MS);
      if (res.status === 201) return { ok: true, dup: false };
      if (res.status === 409) return { ok: true, dup: true }; // duplicate = success by contract
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || `gateway responded ${res.status}` };
    } catch (e) {
      debug(`waitlist attempt ${attempt + 1} failed (${e.name}: ${e.message})`);
    }
  }
  return { ok: false, error: 'gateway unreachable' };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function debug(msg) {
  if (DEBUG || DRY_RUN) process.stderr.write(`telemetry: ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`telemetry: ${msg} (see --help)\n`);
  process.exit(2);
}

// --key=value / --key value → { key_snake: "value" }; positionals separate.
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key;
      let value;
      if (eq >= 0) { key = a.slice(2, eq); value = a.slice(eq + 1); }
      else {
        key = a.slice(2);
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
        else value = '';
      }
      flags[key.replace(/-/g, '_')] = value;
    } else if (a.startsWith('-')) {
      fail(`unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const PROP_FLAGS = ['count', 'verdict', 'dedup', 'tracker', 'team_size_bucket',
  'stack_path', 'source', 'fork', 'hosting', 'persona', 'tool', 'error_class'];

async function cmdEvent(positional, flags) {
  const event = positional[0];
  const step = positional[1];
  if (!event) fail('event: missing event name');
  const props = {};
  for (const key of PROP_FLAGS) {
    if (flags[key] === undefined) continue;
    props[key] = key === 'count' ? Number(flags[key]) : flags[key];
  }
  for (const key of Object.keys(flags)) {
    if (key === 'tenant' || key === 'help') continue;
    if (!PROP_FLAGS.includes(key)) {
      // unknown flag = allowlist violation; drop loudly but never fail the caller
      process.stderr.write(`telemetry: dropped — unknown prop --${key.replace(/_/g, '-')}\n`);
      process.exit(0);
    }
  }
  await sendEvent(event, step, props, { tenantPath: flags.tenant });
  process.exit(0); // events NEVER fail the caller
}

async function cmdWaitlist(flags) {
  for (const key of Object.keys(flags)) {
    if (!['interest', 'email', 'tool', 'source_step', 'tenant', 'help'].includes(key)) {
      fail(`waitlist: unknown option --${key.replace(/_/g, '-')}`);
    }
  }
  if (!flags.email || !EMAIL_RE.test(flags.email)) {
    fail('waitlist: --email=<address> is required and must be valid (the email IS the consent)');
  }
  if (!INTERESTS.includes(flags.interest)) {
    fail(`waitlist: --interest must be one of ${INTERESTS.join('|')}`);
  }
  if (flags.source_step !== undefined && !STEPS.includes(flags.source_step)) {
    fail(`waitlist: --source-step must be one of ${STEPS.join('|')}`);
  }
  const result = await sendWaitlist({
    email: flags.email,
    interest: flags.interest,
    tool: flags.tool,
    source_step: flags.source_step,
  }, { tenantPath: flags.tenant });
  if (result.ok && result.dup) {
    process.stdout.write(`✔ already on the waitlist (${flags.interest})\n`);
    process.exit(0);
  }
  if (result.ok) {
    process.stdout.write(`✔ added to the waitlist (${flags.interest})\n`);
    process.exit(0);
  }
  process.stderr.write(`✖ could not reach the waitlist service (${result.error}) — try again in a minute\n`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === '-h' || sub === '--help') {
    console.log(HELP);
    process.exit(sub ? 0 : 2);
  }
  const { flags, positional } = parseArgs(argv.slice(1));
  if (flags.help) { console.log(HELP); process.exit(0); }
  // --vault <dir> = sibling-script convention (state.js etc.): alias for
  // --tenant <dir>/tenant.yaml. Consume both here so neither ever reaches the
  // event-prop allowlist (user-tested: --vault got "dropped — unknown prop").
  if (flags.vault && !flags.tenant) flags.tenant = path.join(flags.vault, 'tenant.yaml');
  delete flags.vault;
  if (sub === 'event') return cmdEvent(positional, flags);
  if (sub === 'waitlist') return cmdWaitlist(flags);
  return fail(`unknown subcommand "${sub}"`);
}

if (require.main === module) {
  main().catch(() => process.exit(0)); // last-resort guard: telemetry never breaks a flow
} else {
  module.exports = {
    readConfig,
    sendEvent,
    sendWaitlist,
    slugTool,
    EVENTS,
    STEP_EVENTS,
    STEPS,
    INTERESTS,
    ERROR_CLASSES,
    PROPS_BY_EVENT,
    ENUM_PROPS,
    DEFAULT_ENDPOINT,
  };
}
