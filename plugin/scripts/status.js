#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * status.js — pipeline + vault health snapshot for the `status` skill
 * Pipeline health, drift, DLQ peek, deferred-steps roadmap, update check.
 *
 * Read-only; safe to run always. Two modes, decided by what exists:
 *
 *   Phase A (no deployed workflows in pipeline-state)
 *     vault digest only: calls filed, profiles, task-decision counters from
 *     .backbrief/training/task-decisions.jsonl — plus the next suggested rung.
 *
 *   Phase B (pipeline-state has workflow ids)
 *     everything above PLUS, via the n8n API:
 *       - per-workflow liveness (active? last execution status/time)
 *       - last call processed (latest successful transcripts execution)
 *       - DLQ entry count (vault <dlq_folder>/, minus redriven/)
 *       - config-drift summary: current tenant render hash vs the hash
 *         recorded at deploy — catches "tenant.yaml edited but never
 *         redeployed" cheaply; node-level detail stays check-drift.js's job.
 *
 * High-acceptance signal (read-only): when the 30-day task acceptance is
 * >= 95% over >= 50 decisions, the report notes it. Raised task autonomy
 * (L1/L2 auto-create) is RESERVED — it ships a future release, so the note only
 * records the milestone; it never promises an unlockable knob (remediation
 * M-autonomy). This script never changes anything.
 *
 * Version line prints the installed kit version only — pair with
 * check-update.js for the latest-version comparison.
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies, --help,
 * DRY_RUN=1 honored on --save, exit codes:
 *   0 healthy / 1 attention needed (DLQ>0, inactive workflow, drift,
 *   n8n unreachable in Phase B) / 2 operational error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NODES = require('./pipeline-nodes');
const STATE = require('./state'); // deferred entries + ladder (CLI runs nothing on require)
const KIT_ROOT = path.join(__dirname, '..', '..');
// Soft-resolve the pipeline tree: a plugin-cache install carries plugin/ only
// (no sibling pipeline/), and a hard require here killed status entirely.
// RENDER === null -> the pipeline-dependent sections degrade with one honest
// line while the Phase-A sections (state, roadmap, update check) still render.
const PIPELINE_DIR = require('./pipeline-root').findPipelineDir();
const RENDER = PIPELINE_DIR ? require(path.join(PIPELINE_DIR, 'tenant-render.js')) : null;

const DRY_RUN = process.env.DRY_RUN === '1';
const TIMEOUT_MS = 15000;

const HELP = `status.js — pipeline health, last call, DLQ, vault stats (read-only)

Usage:
  node plugin/scripts/status.js [options]

Options:
  --tenant <path>   tenant.yaml (default: $TENANT, else walk up from cwd)
  --save            also write the report to .backbrief/status/<date>.md
  --json            machine-readable result on stdout (report on stderr)
  -h, --help        this text

Env:
  N8N_BASE_URL, N8N_API_KEY   needed for the Phase-B pipeline checks; without
                              them (or before deploy) the vault digest still prints.
  DRY_RUN=1                   skip the --save write

Exit codes: 0 healthy / 1 attention needed / 2 operational error`;

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = { tenant: null, save: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--save') o.save = true;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown option: ${a} (see --help)`); process.exit(2); }
  }
  return o;
}

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

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function ago(iso) {
  if (!iso) return 'unknown';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ------------------------------------------------------------------ */
/* Vault stats (Phase A + B)                                           */
/* ------------------------------------------------------------------ */

// Naming spec v1 (04 §3.1): date-first transcript basenames.
const CALL_RE = /^\d{4}-\d{2}-\d{2} \d{4} .+\.md$/;

function walkTranscripts(root, rel, acc) {
  const dir = path.join(root, rel);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) walkTranscripts(root, childRel, acc);
    else if (e.isFile() && /(^|[/\\])transcripts[/\\][^/\\]+$/.test(childRel) && CALL_RE.test(e.name)) {
      acc.push(childRel);
    }
  }
}

function vaultStats(vaultRoot, tenant) {
  const calls = [];
  walkTranscripts(vaultRoot, '', calls);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const callsThisWeek = calls.filter((f) => {
    const m = path.basename(f).match(/^(\d{4}-\d{2}-\d{2})/);
    return m && new Date(m[1]).getTime() >= weekAgo;
  }).length;

  const profilesFolder = (tenant && tenant.vault && tenant.vault.profiles_folder) || 'team';
  let profiles = 0;
  try {
    profiles = fs.readdirSync(path.join(vaultRoot, profilesFolder))
      .filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f)).length;
  } catch (e) { /* no profiles yet */ }

  // Task decisions (deterministic ROI arithmetic — never LLM estimates).
  const decisions = { total: 0, accepted: 0, edited: 0, skipped: 0, last30d: { total: 0, accepted: 0, edited: 0, skipped: 0 } };
  const dfile = path.join(vaultRoot, '.backbrief', 'training', 'task-decisions.jsonl');
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  if (fs.existsSync(dfile)) {
    for (const line of fs.readFileSync(dfile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch (e) { continue; }
      const action = row.user_action;
      if (!['accepted', 'edited', 'skipped'].includes(action)) continue;
      decisions.total++;
      decisions[action]++;
      if (row.ts && new Date(row.ts).getTime() >= cutoff) {
        decisions.last30d.total++;
        decisions.last30d[action]++;
      }
    }
  }
  const d30 = decisions.last30d;
  const acceptancePct = d30.total ? Math.round(((d30.accepted + d30.edited) / d30.total) * 100) : null;
  return { calls: calls.length, callsThisWeek, profiles, decisions, acceptancePct };
}

function countDlq(vaultRoot, tenant) {
  const dlqFolder = (tenant && tenant.vault && tenant.vault.dlq_folder) || 'pipeline/dlq';
  const root = path.join(vaultRoot, dlqFolder);
  const entries = [];
  const walk = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of items) {
      if (e.name === 'redriven') continue; // already recovered
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.json')) entries.push(path.relative(root, p));
    }
  };
  walk(root);
  return entries;
}

/* ------------------------------------------------------------------ */
/* Phase-B pipeline checks                                             */
/* ------------------------------------------------------------------ */

async function api(base, key, p) {
  const res = await fetch(`${base}/api/v1/${p}`, {
    headers: { 'X-N8N-API-KEY': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
}

async function latestExecution(base, key, workflowId, onlySuccess) {
  const q = `executions?workflowId=${encodeURIComponent(workflowId)}&limit=1${onlySuccess ? '&status=success' : ''}`;
  const res = await api(base, key, q);
  if (!res.ok) return null;
  const list = res.body.data || res.body.results || [];
  return list[0] || null;
}

function nodeOutput(execData, nodeName) {
  let data = execData && execData.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
  const run = data && data.resultData && data.resultData.runData && data.resultData.runData[nodeName];
  return (run && run[0] && run[0].data && run[0].data.main && run[0].data.main[0]
    && run[0].data.main[0][0] && run[0].data.main[0][0].json) || null;
}

// Cheap config-drift check: recompute the render hash exactly as
// deploy-pipeline.js records it and compare per workflow.
function renderHash(def, ctx) {
  const hashes = [];
  for (const [name, file] of Object.entries(def.nodeFileMap)) {
    const repoPath = path.join(KIT_ROOT, def.codeDir, file);
    const source = fs.readFileSync(repoPath, 'utf8');
    const rendered = RENDER.renderSource(source, ctx).source;
    hashes.push(`${name}:${sha256(rendered)}`);
  }
  return sha256(hashes.sort().join('\n'));
}

async function pipelineChecks(tenant, state, vaultRoot) {
  const out = {
    reachable: null, workflows: {}, lastCall: null, drifted: [], attention: [],
  };
  const base = (process.env.N8N_BASE_URL || state.n8n_base_url || '').replace(/\/+$/, '');
  const key = process.env.N8N_API_KEY;
  if (!base || !key) {
    out.reachable = false;
    out.attention.push('N8N_BASE_URL / N8N_API_KEY not set — pipeline liveness not checked (set them, or run from the deploy session)');
    return out;
  }

  // Render context for the drift-hash comparison (never printed — hashes only).
  // Needs the pipeline tree; on a plugin-cache install (RENDER null) the drift
  // summary is skipped — the honest one-liner already printed in main().
  let ctx = null;
  if (RENDER) {
    try {
      const packs = RENDER.loadLangPacks(tenant, path.join(PIPELINE_DIR, 'lang'));
      const version = (() => {
        try { return fs.readFileSync(path.join(KIT_ROOT, 'VERSION'), 'utf8').trim(); } catch (e) { return '0.0.0'; }
      })();
      ctx = RENDER.buildContext(tenant, packs, state, { kitRoot: KIT_ROOT, version });
    } catch (e) { /* drift summary degrades gracefully */ }
  }

  for (const [wfKey, def] of Object.entries(NODES.WORKFLOWS)) {
    const wfState = state.workflows[wfKey];
    const gate = def.gate(tenant);
    if (!wfState || !wfState.id) {
      out.workflows[wfKey] = { status: gate.on ? 'not-deployed' : 'off', reason: gate.on ? 'no id in pipeline-state' : gate.reason };
      continue;
    }
    const res = await api(base, key, `workflows/${wfState.id}`);
    if (!res.ok) {
      out.reachable = out.reachable === null ? false : out.reachable;
      out.workflows[wfKey] = { status: 'unreachable', reason: `GET workflow -> HTTP ${res.status}` };
      out.attention.push(`${wfKey}: n8n API error (HTTP ${res.status})`);
      continue;
    }
    out.reachable = true;
    const active = !!res.body.active;
    const ex = await latestExecution(base, key, wfState.id, false);
    out.workflows[wfKey] = {
      status: active ? 'live' : 'INACTIVE',
      lastExecution: ex ? { id: ex.id, status: ex.status || (ex.finished ? 'success' : '?'), stoppedAt: ex.stoppedAt || ex.startedAt } : null,
    };
    if (!active) out.attention.push(`${wfKey}: workflow is INACTIVE — webhooks are not registered; activate it (n8n UI) or redeploy`);
    if (ex && ex.status && ex.status !== 'success' && ex.status !== 'running' && ex.status !== 'waiting') {
      out.attention.push(`${wfKey}: last execution ${ex.id} ended ${ex.status} (${ago(ex.stoppedAt)}) — check the n8n UI`);
    }
    // Drift summary (hash only — tenant values never printed).
    if (ctx && wfState.rendered_config_hash && def.codeDir) {
      try {
        if (renderHash(def, ctx) !== wfState.rendered_config_hash) {
          out.drifted.push(wfKey);
        }
      } catch (e) { /* render failure -> check-drift.js will name it */ }
    }
  }
  if (out.drifted.length) {
    out.attention.push(`config drift: tenant.yaml/kit changed since last deploy (${out.drifted.join(', ')}) — redeploy, then check-drift.js for node detail`);
  }

  // Last call processed — latest successful transcripts execution.
  const tState = state.workflows.transcripts;
  if (tState && tState.id) {
    const ex = await latestExecution(base, key, tState.id, true);
    if (ex) {
      let topic = null;
      const full = await api(base, key, `executions/${ex.id}?includeData=true`);
      if (full.ok) {
        const meta = nodeOutput(full.body, 'Recording state lookup')
          || nodeOutput(full.body, 'Extract metadata');
        if (meta && meta.topic) topic = String(meta.topic);
      }
      out.lastCall = { when: ex.stoppedAt || ex.startedAt, topic };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Report rendering (the 01 §7.1 compact block)                        */
/* ------------------------------------------------------------------ */

function kitVersion() {
  try { return fs.readFileSync(path.join(KIT_ROOT, 'VERSION'), 'utf8').trim(); }
  catch (e) { return '0.0.0'; }
}

const COMPONENT_LABELS = [
  ['slack', (t) => t.features && t.features.slack && t.features.slack.enabled !== false],
  ['vault-commit', (t) => !!(t.vault && t.vault.repo)],
  ['tracker', (t) => t.features && t.features.tracker && t.features.tracker.enabled !== false
    && t.features.tracker.kind && t.features.tracker.kind !== 'none'],
  ['drive', (t) => !!(t.features && t.features.drive && t.features.drive.enabled)],
  ['history', (t) => !!(t.features && t.features.history_import && t.features.history_import.enabled)],
];

function renderReport({ phase, tenant, stats, dlq, pipe, ladderState }) {
  const lines = [];
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  lines.push(`Backbrief status — ${stamp}`);

  if (phase === 'B') {
    const t = pipe.workflows.transcripts || {};
    const live = t.status === 'live';
    const lastCallStr = pipe.lastCall
      ? `last call processed ${ago(pipe.lastCall.when)}${pipe.lastCall.topic ? ` ("${pipe.lastCall.topic}")` : ''}`
      : 'no processed calls yet';
    lines.push(`Pipeline   ${live ? '🟢 live' : (pipe.reachable === false ? '🔴 unreachable' : `🔴 ${t.status || 'unknown'}`)} · ${lastCallStr}`);
    const comps = COMPONENT_LABELS
      .map(([name, on]) => `${name} ${on(tenant) ? '✅' : '⏭ off'}`)
      .join(' · ');
    lines.push(`Components ${comps}`);
  } else {
    lines.push('Pipeline   ⏭ not deployed (Phase A manual mode) — `/backbrief deploy` sets it up');
  }

  const attention = [];
  if (dlq.length) attention.push(`⚠️ ${dlq.length} DLQ entr${dlq.length === 1 ? 'y' : 'ies'} (${dlq.slice(0, 3).join(', ')}${dlq.length > 3 ? ', …' : ''}) → say "redrive" (redrive-dlq.js)`);
  if (phase === 'B') attention.push(...pipe.attention.map((a) => `⚠️ ${a}`));
  lines.push(attention.length ? `Attention  ${attention.join('\n           ')}` : 'Attention  none 🎉');

  // Deferred steps — the .backbrief/roadmap.md mirror (skipped rungs +
  // completed-then-disabled components), deterministic from state + tenant.
  const deferred = STATE.deferredEntries(ladderState, tenant);
  if (deferred.length) {
    const top = deferred.slice(0, 3).map((e) => e.label).join(', ');
    lines.push(`Deferred   ${deferred.length} step${deferred.length === 1 ? '' : 's'} (${top}${deferred.length > 3 ? ', …' : ''}) → .backbrief/roadmap.md`);
  } else {
    lines.push('Deferred   none');
  }

  const d = stats.decisions;
  const taskStr = d.total
    ? `tasks: ${d.accepted} accepted / ${d.edited} edited / ${d.skipped} skipped` +
      (stats.acceptancePct !== null ? ` (${stats.acceptancePct}% acceptance, 30d over ${d.last30d.total})` : '')
    : 'tasks: none logged yet';
  lines.push(`Vault      ${stats.calls} calls (${stats.callsThisWeek} this week) · ${stats.profiles} profiles · ${taskStr}`);
  lines.push(`Version    ${kitVersion()} installed (latest: run check-update.js)`);

  // High-acceptance milestone — read-only. Raised task autonomy (L1/L2
  // auto-create) is reserved for a future release, so this only records the
  // milestone; it does not promise an unlockable knob (M-autonomy).
  if (stats.acceptancePct !== null && stats.acceptancePct >= 95 && d.last30d.total >= 50) {
    lines.push('');
    lines.push(`Note: 30-day acceptance is ${stats.acceptancePct}% over ${d.last30d.total} decisions — task autonomy (auto-create) is reserved, ships a future release.`);
  }
  // Deterministic next step — first incomplete rung in ladder order (never an estimate).
  const next = STATE.nextRung(ladderState);
  lines.push('');
  if (next) lines.push(`Next: ${next.label} → \`${next.reenable}\``);
  else lines.push('Next: all rungs complete — record calls and let the pipeline run.');
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const tenantPath = findTenantFile(opts.tenant);
  if (!tenantPath) {
    console.error('✖ no tenant.yaml found walking up from here — nothing to report on (run start / init-vault.js first)');
    process.exit(2);
  }
  const vaultRoot = path.dirname(tenantPath);
  // Load .backbrief/secrets.env so the Phase-B pipeline liveness probe sees
  // N8N_BASE_URL / N8N_API_KEY from the documented secret file (M-secrets).
  // Explicit env still wins; harmless in Phase A (nothing reads it there).
  require('./load-secrets-env').loadSecretsEnv(vaultRoot);
  if (!RENDER) {
    console.error('⚠ pipeline sections unavailable (tenant render + drift checks skipped) — ' +
      'plugin-cache install carries plugin/ only; full checkout: git clone https://github.com/EvgenSmith/backbrief');
  }
  let tenant = {};
  // Without the pipeline tree, fall back to the kit's minimal YAML parser —
  // status only reads paths/flags from the tenant, never renders it.
  try {
    tenant = (RENDER
      ? RENDER.loadTenant(tenantPath)
      : STATE.parseYaml(fs.readFileSync(tenantPath, 'utf8'))) || {};
  } catch (e) { console.error(`⚠ tenant.yaml unreadable (${e.message}) — using defaults for paths`); }

  const state = readJson(path.join(vaultRoot, '.backbrief', 'pipeline-state.json'), {});
  state.workflows = state.workflows || {};
  const deployed = Object.values(state.workflows).some((w) => w && w.id);
  const phase = deployed ? 'B' : 'A';

  // Ladder state (.backbrief/state.yaml) — feeds the Deferred + Next lines.
  // A parse failure must be LOUD: rendering the fresh-install view over a
  // corrupted state file silently masks lost rung progress.
  let ladderState = null;
  try { ladderState = STATE.readStateFile(STATE.statePath(vaultRoot)); }
  catch (e) {
    console.error(`⚠ .backbrief/state.yaml exists but failed to parse (${e.message}) — ` +
      'the Deferred/Next lines below assume a FRESH install, which this is not; ' +
      'run `node plugin/scripts/state.js get` for the details, then fix or delete the file');
  }

  const stats = vaultStats(vaultRoot, tenant);
  const dlq = countDlq(vaultRoot, tenant);
  const pipe = phase === 'B'
    ? await pipelineChecks(tenant, state, vaultRoot)
    : { reachable: null, workflows: {}, lastCall: null, drifted: [], attention: [] };

  const report = renderReport({ phase, tenant, stats, dlq, pipe, ladderState });
  if (opts.json) {
    console.error(report);
    console.log(JSON.stringify({
      phase,
      stats,
      dlq_count: dlq.length,
      dlq_entries: dlq,
      deferred: STATE.deferredEntries(ladderState, tenant),
      next_rung: STATE.nextRung(ladderState),
      pipeline: pipe,
    }, null, 2));
  } else {
    console.log(report);
  }

  if (opts.save) {
    const file = path.join(vaultRoot, '.backbrief', 'status', `${new Date().toISOString().slice(0, 10)}.md`);
    if (DRY_RUN) console.error(`[dry-run] would write ${file}`);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, report);
      console.error(`report saved -> ${path.relative(process.cwd(), file)}`);
    }
  }

  const needsAttention = dlq.length > 0
    || (phase === 'B' && (pipe.attention.length > 0 || pipe.reachable === false));
  process.exit(needsAttention ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
