#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * check-env.js — B0 environment probe.
 *
 * Answers one question before any Phase-B work starts: "can this machine and
 * this n8n actually run the pipeline?" Probes, in order:
 *
 *   1. node     — >= 18 (hard prereq; zero-dep scripts rely on global fetch)
 *   2. git      — present (vault persistence at B4)
 *   3. docker   — present? (only relevant for the self-hosted hosting choice;
 *                 informational, never a failure by itself)
 *   4. network  — outbound HTTPS egress (api.github.com probe)
 *   5. n8n      — when N8N_BASE_URL is set: reachability (/healthz), and when
 *                 N8N_API_KEY is also set: API auth (GET /api/v1/workflows)
 *                 + the Variables licensing probe (GET /api/v1/variables).
 *                 n8n cloud Starter has no Variables feature — the kit never
 *                 depends on it (secret inlining via INJECT_SECRETS is *the*
 *                 mechanism), but the capability is recorded in
 *                 .backbrief/pipeline-state.json so later tooling knows.
 *
 * ARTIFACT: environment report on stdout; `--save` also writes
 * `.backbrief/deploy/environment.md` (the B0 artifact file).
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies, --help,
 * DRY_RUN=1 honored on writes, exit codes 0 ok / 1 check failed / 2 error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DRY_RUN = process.env.DRY_RUN === '1';
const TIMEOUT_MS = 8000;

const HELP = `check-env.js — B0 environment probe (node/git/docker/network/n8n)

Usage:
  node plugin/scripts/check-env.js [options]

Options:
  --vault <path>   vault root for .backbrief/ state (default: $BACKBRIEF_VAULT,
                   else walk up from the current directory)
  --save           also write the report to .backbrief/deploy/environment.md
  --json           machine-readable result on stdout (report still on stderr)
  -h, --help       this text

Environment:
  N8N_BASE_URL     your n8n instance URL (n8n Cloud or self-hosted). Optional:
                   without it the n8n probes are skipped with a hint.
  N8N_API_KEY      n8n API key (Settings -> n8n API). Optional: without it only
                   reachability is probed, not API auth.
  DRY_RUN=1        print what would be written, write nothing

Failure semantics:
  node < 18 or no network egress        -> exit 1 (hard prereqs)
  N8N_BASE_URL set but unreachable/401  -> exit 1 (fix or switch hosting)
  N8N_BASE_URL not set                  -> informational, exit 0
  docker missing                        -> informational only (needed only for
                                           the self-hosted option)

Exit codes: 0 ok / 1 check failed / 2 operational error`;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = { vault: null, save: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') o.vault = argv[++i];
    else if (a === '--save') o.save = true;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown option: ${a} (see --help)`); process.exit(2); }
  }
  return o;
}

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

function cmdVersion(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return String(out).trim().split('\n')[0];
  } catch (e) {
    return null;
  }
}

async function probe(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: true, status: res.status, res };
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}` };
  }
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

async function runChecks() {
  const checks = []; // { name, status: 'pass'|'fail'|'warn'|'skip', detail }
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // 1. node
  const major = parseInt(process.versions.node.split('.')[0], 10);
  add('node', major >= 18 ? 'pass' : 'fail',
    `node ${process.version}${major >= 18 ? '' : ' — Node >= 18 is a hard prereq (global fetch)'}`);

  // 2. git
  const git = cmdVersion('git', ['--version']);
  add('git', git ? 'pass' : 'warn',
    git || 'git not found — needed at B4 to push the vault repo');

  // 3. docker (self-hosted option only)
  const docker = cmdVersion('docker', ['--version']);
  add('docker', docker ? 'pass' : 'skip',
    docker || 'docker not found — only needed for the self-hosted n8n option (option 2); n8n Cloud needs none');

  // 4. network egress
  const net = await probe('https://api.github.com/', { method: 'GET' });
  add('network', net.ok ? 'pass' : 'fail',
    net.ok ? `outbound HTTPS ok (api.github.com ${net.status})`
           : `no outbound HTTPS (${net.error}) — the pipeline cannot call Zoom/Slack/GitHub/Anthropic`);

  // 5. n8n
  const base = (process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
  const key = process.env.N8N_API_KEY;
  const n8n = { base: base || null, reachable: null, auth: null, variables: null };
  if (!base) {
    add('n8n', 'skip',
      'N8N_BASE_URL not set — pick a hosting option first (docs/n8n-hosting.md), then re-run');
  } else {
    const health = await probe(`${base}/healthz`);
    n8n.reachable = health.ok && health.status < 500;
    if (!n8n.reachable) {
      add('n8n reachability', 'fail',
        `cannot reach ${base}/healthz (${health.ok ? `HTTP ${health.status}` : health.error})`);
    } else {
      add('n8n reachability', 'pass', `${base} is up (healthz ${health.status})`);
      if (!key) {
        add('n8n API auth', 'skip',
          'N8N_API_KEY not set — create one in n8n (Settings -> n8n API), then re-run');
      } else {
        const auth = await probe(`${base}/api/v1/workflows?limit=1`,
          { headers: { 'X-N8N-API-KEY': key, Accept: 'application/json' } });
        n8n.auth = auth.ok && auth.status === 200;
        add('n8n API auth', n8n.auth ? 'pass' : 'fail',
          n8n.auth ? 'API key accepted (GET /workflows 200)'
                   : `API key rejected (${auth.ok ? `HTTP ${auth.status}` : auth.error}) — regenerate it in n8n Settings`);
        if (n8n.auth) {
          // Variables licensing probe (03 §5.1 #6). The kit never depends on
          // $vars/$env — this is recorded so tooling knows the plan's shape.
          const vars = await probe(`${base}/api/v1/variables`,
            { headers: { 'X-N8N-API-KEY': key, Accept: 'application/json' } });
          n8n.variables = vars.ok && vars.status === 200;
          add('n8n variables feature', n8n.variables ? 'pass' : 'skip',
            n8n.variables
              ? 'Variables API available on this plan (not required by the kit)'
              : `Variables API not available (HTTP ${vars.ok ? vars.status : '—'}) — fine: the kit injects secrets into node code, never via $vars`);
        }
      }
    }
  }

  return { checks, n8n };
}

/* ------------------------------------------------------------------ */
/* Report + state                                                      */
/* ------------------------------------------------------------------ */

const ICON = { pass: '✅', fail: '✖', warn: '⚠', skip: '⏭' };

function renderReport({ checks, n8n }) {
  const lines = [];
  lines.push(`# Backbrief environment report — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  lines.push('');
  for (const c of checks) lines.push(`- ${ICON[c.status]} **${c.name}** — ${c.detail}`);
  lines.push('');
  const fails = checks.filter((c) => c.status === 'fail');
  if (fails.length) {
    lines.push(`**Verdict:** ${fails.length} blocking issue(s) — fix the ✖ items above, or switch hosting option (docs/n8n-hosting.md).`);
  } else if (!n8n.base) {
    lines.push('**Verdict:** machine is ready. Next: choose hosting (n8n Cloud or Docker — docs/n8n-hosting.md), set N8N_BASE_URL + N8N_API_KEY, re-run this check.');
  } else if (n8n.auth) {
    lines.push('**Verdict:** ready to deploy — n8n is reachable and the API key works. Continue to B1 (tenant.yaml).');
  } else {
    lines.push('**Verdict:** n8n reachable but not yet API-ready — finish the API-key step, then re-run.');
  }
  return lines.join('\n') + '\n';
}

function recordPipelineState(vaultRoot, n8n) {
  if (!vaultRoot || !n8n.base) return null;
  const statePath = path.join(vaultRoot, '.backbrief', 'pipeline-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { /* fresh */ }
  state.n8n_base_url = n8n.base;
  state.capabilities = state.capabilities || {};
  if (n8n.variables !== null) state.capabilities.variables = n8n.variables;
  state.env_checked_at = new Date().toISOString();
  if (DRY_RUN) {
    console.error(`[dry-run] would record n8n_base_url + capabilities into ${statePath}`);
    return statePath;
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  return statePath;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const vaultRoot = findVaultRoot(opts.vault);
  // Load .backbrief/secrets.env so the n8n reachability/auth probe sees the
  // N8N_BASE_URL / N8N_API_KEY the user put there (M-secrets). Env still wins.
  require('./load-secrets-env').loadSecretsEnv(vaultRoot);
  const result = await runChecks();
  const report = renderReport(result);

  if (opts.json) {
    console.error(report);
    console.log(JSON.stringify({ checks: result.checks, n8n: result.n8n }, null, 2));
  } else {
    console.log(report);
  }

  if (result.n8n.auth) recordPipelineState(vaultRoot, result.n8n);

  if (opts.save) {
    if (!vaultRoot) {
      console.error('⚠ --save: no vault found (no .backbrief/ or tenant.yaml walking up) — report not saved');
    } else {
      const file = path.join(vaultRoot, '.backbrief', 'deploy', 'environment.md');
      if (DRY_RUN) {
        console.error(`[dry-run] would write ${file}`);
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, report);
        console.error(`report saved -> ${path.relative(process.cwd(), file)}`);
      }
    }
  }

  process.exit(result.checks.some((c) => c.status === 'fail') ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
