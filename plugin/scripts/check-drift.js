#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * check-drift.js — live ↔ repo drift tripwire.
 *
 * Per mapped Code node (SSOT: pipeline-nodes.js), compares
 *
 *     normalize(live jsCode)  ==  normalize(render(repo file, tenant, state))
 *
 * where normalize = NORMALIZE_SECRETS on both sides + whitespace fold. By
 * construction:
 *   - editing tenant.yaml without redeploying  ⇒ drift, named by REGION
 *     ("config changed but the pipeline still runs the old roster");
 *   - hand-edits in the n8n UI                 ⇒ drift (same tripwire as prod);
 *   - real secrets never appear in the output  (normalized on both sides);
 *   - tenant values never appear in diffs      (we print region NAMES, not
 *     region contents).
 *
 * --graph-lint additionally runs the OFFLINE skeleton lint:
 * every mapped node exists in its skeleton as a Code node, every skeleton
 * Code node is either mapped or declared inline-only, mapped code files
 * exist, and the skeleton version tag matches the kit VERSION. Runs with no
 * n8n access (used by CI); combine with the live check by passing both env
 * vars and the flag.
 *
 * Env: N8N_BASE_URL, N8N_API_KEY (not needed for --graph-lint alone)
 * Exit codes: 0 ok / 1 drift or lint failure / 2 operational error
 */
'use strict';

const fs = require('fs');
const path = require('path');

const NODES = require('./pipeline-nodes');
const KIT_ROOT = path.join(__dirname, '..', '..');
const { RENDER, PIPELINE_DIR } = require(path.join(__dirname, 'pipeline-root.js')).requirePipeline('check-drift.js');

const HELP = `check-drift.js — compare live n8n Code nodes against rendered repo code

Usage:
  node plugin/scripts/check-drift.js [--tenant tenant.yaml] [--graph-lint] [--offline]

Options:
  --tenant <path>   tenant.yaml (default: $TENANT, else ./tenant.yaml)
  --state <path>    pipeline-state JSON (default: <tenant dir>/.backbrief/pipeline-state.json)
  --graph-lint      also run the offline skeleton lint (mapped nodes exist in
                    skeletons; skeleton Code nodes are mapped or inline-only;
                    skeleton version tag == VERSION)
  --offline         graph-lint ONLY — no n8n access (CI mode)
  -h, --help        this text

Env: N8N_BASE_URL, N8N_API_KEY (live check)
Exit codes: 0 ok / 1 drift or lint failure / 2 operational error`;

function parseArgs(argv) {
  const o = { tenant: null, state: null, graphLint: false, offline: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--state') o.state = argv[++i];
    else if (a === '--graph-lint') o.graphLint = true;
    else if (a === '--offline') { o.offline = true; o.graphLint = true; }
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown option: ${a} (see --help)`); process.exit(2); }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(HELP); process.exit(0); }

const norm = (s) => (s || '').replace(/\r/g, '').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');

const KIT_VERSION = (() => {
  try { return fs.readFileSync(path.join(KIT_ROOT, 'VERSION'), 'utf8').trim(); }
  catch (e) { return '0.0.0'; }
})();

/* ------------------------------------------------------------------ */
/* Region-aware diff naming: extract marker-delimited blocks so drift  */
/* output names the CONCERN that drifted, never its contents.          */
/* ------------------------------------------------------------------ */

function splitRegions(code) {
  const lines = String(code || '').split('\n');
  const regions = {};
  const rest = [];
  let current = null;
  for (const line of lines) {
    const b = line.match(/^\/\/ ── __TENANT_([A-Z]+)_BEGIN__/);
    const e = line.match(/^\/\/ ── __TENANT_([A-Z]+)_END__/);
    if (b) { current = b[1]; regions[current] = []; continue; }
    if (e) { current = null; continue; }
    if (current) regions[current].push(line);
    else rest.push(line);
  }
  return { regions, rest: rest.join('\n') };
}

function driftDetail(liveNorm, repoNorm) {
  const live = splitRegions(liveNorm);
  const repo = splitRegions(repoNorm);
  const drifted = [];
  for (const kind of NODES.TENANT_REGIONS) {
    const a = live.regions[kind] ? live.regions[kind].join('\n') : null;
    const b = repo.regions[kind] ? repo.regions[kind].join('\n') : null;
    if (norm(a || '') !== norm(b || '')) drifted.push(kind);
  }
  if (norm(live.rest) !== norm(repo.rest)) drifted.push('code-body');
  return drifted.length ? drifted.join(', ') : 'whitespace/marker';
}

/* ------------------------------------------------------------------ */
/* Offline graph lint                                                  */
/* ------------------------------------------------------------------ */

function graphLint() {
  console.log(`Graph lint (offline) — kit VERSION ${KIT_VERSION}`);
  let fails = 0;
  for (const [key, def] of Object.entries(NODES.WORKFLOWS)) {
    let wfFails = 0;
    const fail = (msg) => { console.log(`  FAIL ${key}: ${msg}`); wfFails++; };
    const skelPath = path.join(KIT_ROOT, def.skeleton);
    if (!fs.existsSync(skelPath)) { fail(`skeleton missing (${def.skeleton})`); fails += wfFails; continue; }
    let skel;
    try { skel = JSON.parse(fs.readFileSync(skelPath, 'utf8')); }
    catch (e) { fail(`skeleton unparseable (${e.message})`); fails += wfFails; continue; }

    const tag = skel[NODES.SKELETON_VERSION_KEY];
    if (tag !== KIT_VERSION) fail(`${NODES.SKELETON_VERSION_KEY}=${tag} != VERSION ${KIT_VERSION}`);

    const codeNodes = new Set(
      (skel.nodes || [])
        .filter((n) => n.parameters && n.parameters.jsCode != null)
        .map((n) => n.name)
    );
    const mapped = new Set(Object.keys(def.nodeFileMap));
    const inlineOk = new Set(def.inlineOnlyCodeNodes || []);

    for (const name of mapped) {
      if (!codeNodes.has(name)) fail(`mapped node not in skeleton (or not a Code node): ${name}`);
      const file = path.join(KIT_ROOT, def.codeDir || '', def.nodeFileMap[name]);
      if (!def.codeDir || !fs.existsSync(file)) fail(`mapped code file missing: ${def.codeDir}/${def.nodeFileMap[name]}`);
    }
    for (const name of codeNodes) {
      if (!mapped.has(name) && !inlineOk.has(name)) {
        fail(`skeleton Code node neither mapped nor declared inline-only: ${name}`);
      }
      if (mapped.has(name)) {
        const node = (skel.nodes || []).find((n) => n.name === name);
        if (node && !String(node.parameters.jsCode).includes(NODES.SKELETON_PLACEHOLDER_MARK)) {
          fail(`mapped skeleton node "${name}" carries real code instead of the placeholder (render is the single source of node code)`);
        }
      }
    }
    if (!wfFails) console.log(`  ok    ${key} (${codeNodes.size} code nodes: ${mapped.size} mapped, ${inlineOk.size} inline-only)`);
    fails += wfFails;
  }
  return fails;
}

/* ------------------------------------------------------------------ */
/* Live drift check                                                    */
/* ------------------------------------------------------------------ */

async function liveDrift() {
  // Load .backbrief/secrets.env (of the vault holding the tenant file) before
  // reading N8N_* below, so the documented secret contract works (M-secrets).
  require('./load-secrets-env').loadSecretsEnv(
    path.dirname(path.resolve(opts.tenant || process.env.TENANT || './tenant.yaml')));
  const BASE = (process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
  const KEY = process.env.N8N_API_KEY;
  if (!BASE || !KEY) { console.error('N8N_BASE_URL and N8N_API_KEY required (or use --offline)'); process.exit(2); }

  const tenantPath = path.resolve(opts.tenant || process.env.TENANT || './tenant.yaml');
  if (!fs.existsSync(tenantPath)) { console.error(`tenant file not found: ${tenantPath}`); process.exit(2); }
  let tenant;
  try { tenant = RENDER.loadTenant(tenantPath); }
  catch (e) { console.error(`tenant parse failed: ${e.message}`); process.exit(2); }
  const statePath = path.resolve(opts.state || path.join(path.dirname(tenantPath), '.backbrief', 'pipeline-state.json'));
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { /* fresh install */ }
  state.workflows = state.workflows || {};
  const packs = RENDER.loadLangPacks(tenant, path.join(PIPELINE_DIR, 'lang'));
  const ctx = RENDER.buildContext(tenant, packs, state, { kitRoot: KIT_ROOT, version: KIT_VERSION });

  let drift = 0, missing = 0, checkedNodes = 0;
  for (const [key, def] of Object.entries(NODES.WORKFLOWS)) {
    const gate = def.gate(tenant);
    const wfState = state.workflows[key];
    if (!wfState || !wfState.id) {
      console.log(`\n${key}: ${gate.on ? 'not deployed yet (no id in pipeline-state)' : `disabled (${gate.reason})`} — skipped`);
      continue;
    }
    const res = await fetch(`${BASE}/api/v1/workflows/${wfState.id}`, { headers: { 'X-N8N-API-KEY': KEY, Accept: 'application/json' } });
    if (!res.ok) { console.error(`\n${key}: GET workflow ${wfState.id} failed: ${res.status}`); missing++; continue; }
    const wf = await res.json();
    console.log(`\nDrift check ${key} vs live "${wf.name}" (${wfState.id}) active=${wf.active}`);
    const live = {};
    for (const n of wf.nodes) if (n.parameters && n.parameters.jsCode != null) live[n.name] = n.parameters.jsCode;

    for (const [name, file] of Object.entries(def.nodeFileMap)) {
      checkedNodes++;
      const repoPath = path.join(KIT_ROOT, def.codeDir, file);
      if (!fs.existsSync(repoPath)) { console.log(`  ?? MISSING repo file: ${def.codeDir}/${file}`); missing++; continue; }
      if (!(name in live)) { console.log(`  ?? MISSING live node: ${name}`); missing++; continue; }
      let rendered;
      try { rendered = RENDER.renderSource(fs.readFileSync(repoPath, 'utf8'), ctx).source; }
      catch (e) { console.log(`  ?? RENDER FAIL ${file}: ${e.message}`); missing++; continue; }
      const repoNorm = norm(NODES.NORMALIZE_SECRETS(rendered));
      const liveNorm = norm(NODES.NORMALIZE_SECRETS(live[name]));
      if (liveNorm === repoNorm) console.log(`  ok    ${name}`);
      else { console.log(`  DRIFT ${name}  (live != render(${file}); regions: ${driftDetail(liveNorm, repoNorm)})`); drift++; }
    }
  }
  console.log(`\n${drift} drift, ${missing} missing of ${checkedNodes} mapped nodes checked`);
  return drift + missing;
}

/* ------------------------------------------------------------------ */

(async () => {
  let fails = 0;
  if (opts.graphLint) fails += graphLint();
  if (!opts.offline) fails += await liveDrift();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
