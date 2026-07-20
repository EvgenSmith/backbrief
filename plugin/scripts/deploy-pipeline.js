#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * deploy-pipeline.js — Backbrief pipeline deploy (B6).
 *
 * The ONLY sanctioned way to deploy the pipeline. Per workflow, in order:
 *
 *   1. GET live workflow → snapshot to .backbrief/snapshots/<wf>-pre-<ts>.json
 *      (rollback = PUT that snapshot back; snapshots are secret-scrubbed on
 *      disk, the in-memory original is what gets PUT).
 *   2. For each mapped Code node (SSOT: pipeline-nodes.js): repo file →
 *      tenant-render (TENANT_* regions) → INJECT_SECRETS(rendered, liveCode)
 *      (env → preserve-from-live → warn loudly; NEVER downgrades a live
 *      secret to a placeholder).
 *   3. Patch non-Code params: __BACKBRIEF_*__ tokens (channel ids, repo
 *      coords, n8n base URL), settings.timezone, settings.errorWorkflow,
 *      Anthropic credential binding (--anthropic-inline fallback).
 *   4. ONE atomic PUT per workflow (name/nodes/connections/allowed settings),
 *      re-activate, write .backbrief/pipeline-state.json (ids, versionId,
 *      rendered-config hash).
 *
 * First run: `--import` POSTs pipeline/workflows/*.json skeletons (placeholder
 * jsCode only — render is the single source of node code), THEN runs the same
 * render+inject PUT path. Skeletons carry a `backbrief_skeleton_version` tag
 * checked against VERSION, so a stale skeleton fails loudly instead of
 * silently reverting logic. Re-runs ALWAYS take the atomic-PUT path: once a
 * workflow id is recorded in pipeline-state, `--import` REFUSES to re-POST it
 * — the kit ships without any re-bootstrap path (the prod build-workflow.js
 * lesson: a bootstrap that re-POSTs reverts live fixes).
 *
 * Self-test (B6 gate):
 *   --selftest              sign + POST the synthetic fixture, assert the
 *                           execution succeeded, assert idempotent re-POST,
 *                           record created artifacts for cleanup
 *   --selftest-interactivity  post a test button to the digest channel, wait
 *                           for the human click to arrive via the
 *                           interactivity webhook (half-test)
 *   --selftest-cleanup      delete the synthetic Slack posts + revert the
 *                           synthetic vault files recorded by --selftest
 *
 * Kit script conventions: Node >= 18, zero npm dependencies, --help,
 * DRY_RUN=1 honored on writes, exit codes 0 ok / 1 check failed / 2 error.
 *
 * Env: N8N_BASE_URL, N8N_API_KEY (required)
 *      GITHUB_VAULT_PAT, LINEAR_API_TOKEN, ZOOM_* , SLACK_BOT_TOKEN,
 *      ANTHROPIC_API_KEY (optional — INJECT_SECRETS resolution + self-test)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NODES = require('./pipeline-nodes');
const KIT_ROOT = path.join(__dirname, '..', '..');
const { RENDER, PIPELINE_DIR } = require(path.join(__dirname, 'pipeline-root.js')).requirePipeline('deploy-pipeline.js');

const ALLOWED_SETTINGS = [
  'saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution',
  'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone',
  'executionOrder', 'callerPolicy', 'callerIds',
];

const HELP = `deploy-pipeline.js — render tenant config + secrets into the live n8n pipeline

Usage:
  node plugin/scripts/deploy-pipeline.js [--tenant tenant.yaml] [options]

Options:
  --tenant <path>          tenant.yaml (default: $TENANT, else ./tenant.yaml)
  --state <path>           pipeline-state JSON (default: <tenant dir>/.backbrief/pipeline-state.json)
  --import                 first-run only: POST skeletons for workflows that have
                           no recorded id yet, then deploy. REFUSES to re-import
                           an already-imported workflow (no re-bootstrap path).
  --workflow <key>         deploy only this workflow (repeatable). Keys: ${Object.keys(NODES.WORKFLOWS).join(', ')}
  --anthropic-inline       bind the Anthropic key as an HTTP header value instead
                           of an n8n credential (fallback for plans without the
                           credentials API; second-choice)
  --rotate-anthropic       update the backbrief-anthropic credential from
                           $ANTHROPIC_API_KEY and exit (no workflow PUT needed)
  --selftest               B6 gate: signed synthetic webhook -> assert success,
                           idempotent re-POST, record artifacts for cleanup
  --selftest-interactivity Slack button round-trip half-test (human clicks Skip)
  --selftest-cleanup       delete synthetic Slack posts + revert synthetic vault
                           files recorded by --selftest
  -h, --help               this text

Env: N8N_BASE_URL, N8N_API_KEY required; DRY_RUN=1 previews without writing.
Rollback: PUT the .backbrief/snapshots/<wf>-pre-<stamp>.json back via the n8n API.
Exit codes: 0 ok / 1 self-test or check failed / 2 operational error`;

/* ------------------------------------------------------------------ */
/* CLI + environment                                                   */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = {
    tenant: null, state: null, import: false, workflows: [],
    anthropicInline: false, rotateAnthropic: false,
    selftest: false, selftestInteractivity: false, selftestCleanup: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--state') o.state = argv[++i];
    else if (a === '--import') o.import = true;
    else if (a === '--workflow') o.workflows.push(argv[++i]);
    else if (a === '--anthropic-inline') o.anthropicInline = true;
    else if (a === '--rotate-anthropic') o.rotateAnthropic = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--selftest-interactivity') o.selftestInteractivity = true;
    else if (a === '--selftest-cleanup') o.selftestCleanup = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown option: ${a} (see --help)`); process.exit(2); }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(HELP); process.exit(0); }

// Load the documented secret contract (.backbrief/secrets.env) into the
// environment BEFORE reading any N8N_*/token env below — explicit env still
// wins, the file only fills gaps (remediation M-secrets). The vault whose
// secrets we load is the one holding the tenant file we are about to deploy.
require('./load-secrets-env').loadSecretsEnv(
  path.dirname(path.resolve(opts.tenant || process.env.TENANT || './tenant.yaml')));

const DRY = process.env.DRY_RUN === '1';
const BASE = (process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.N8N_API_KEY;
if (!BASE || !KEY) { console.error('N8N_BASE_URL and N8N_API_KEY required'); process.exit(2); }

const H = { 'X-N8N-API-KEY': KEY, Accept: 'application/json', 'Content-Type': 'application/json' };
async function api(method, p, body) {
  return fetch(`${BASE}/api/v1/${p}`, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* Tenant / state / version loading                                    */
/* ------------------------------------------------------------------ */

const tenantPath = path.resolve(opts.tenant || process.env.TENANT || './tenant.yaml');
if (!fs.existsSync(tenantPath)) { console.error(`tenant file not found: ${tenantPath}`); process.exit(2); }
const tenantDir = path.dirname(tenantPath);
const backbriefDir = path.join(tenantDir, '.backbrief');
const statePath = path.resolve(opts.state || path.join(backbriefDir, 'pipeline-state.json'));
const selftestStatePath = path.join(backbriefDir, 'selftest-state.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(p, obj) {
  if (DRY) { console.log(`[dry-run] would write ${p}`); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

const KIT_VERSION = (() => {
  try { return fs.readFileSync(path.join(KIT_ROOT, 'VERSION'), 'utf8').trim(); }
  catch (e) { return '0.0.0'; }
})();

let tenant;
try { tenant = RENDER.loadTenant(tenantPath); }
catch (e) { console.error(`tenant parse failed: ${e.message}`); process.exit(2); }
const state = readJson(statePath, {});
state.workflows = state.workflows || {};
const packs = RENDER.loadLangPacks(tenant, path.join(PIPELINE_DIR, 'lang'));
const ctx = RENDER.buildContext(tenant, packs, state, { kitRoot: KIT_ROOT, version: KIT_VERSION });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ------------------------------------------------------------------ */
/* Anthropic credential                                                */
/* ------------------------------------------------------------------ */

async function ensureAnthropicCredential() {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (opts.anthropicInline) return { mode: 'inline' };
  if (state.anthropic_credential_id && !opts.rotateAnthropic) {
    return { mode: 'credential', id: state.anthropic_credential_id };
  }
  if (!key) {
    console.log('  note: no ANTHROPIC_API_KEY in env — Anthropic nodes keep their current binding');
    return state.anthropic_credential_id
      ? { mode: 'credential', id: state.anthropic_credential_id }
      : { mode: 'none' };
  }
  if (opts.rotateAnthropic && state.anthropic_credential_id) {
    // The public n8n API has no PATCH for credentials — rotation = delete + recreate.
    if (!DRY) await api('DELETE', `credentials/${state.anthropic_credential_id}`);
    delete state.anthropic_credential_id;
  }
  if (DRY) { console.log('[dry-run] would create credential backbrief-anthropic'); return { mode: 'credential', id: 'dry-run' }; }
  const res = await api('POST', 'credentials', {
    name: 'backbrief-anthropic',
    type: 'httpHeaderAuth',
    data: { name: 'x-api-key', value: key },
  });
  if (!res.ok) {
    console.error(`  credentials API unavailable (HTTP ${res.status}) — falling back to --anthropic-inline semantics`);
    return { mode: 'inline' };
  }
  const cred = await res.json();
  state.anthropic_credential_id = cred.id;
  writeJson(statePath, state);
  console.log(`  created n8n credential backbrief-anthropic (${cred.id})`);
  return { mode: 'credential', id: cred.id };
}

function isAnthropicNode(node) {
  const url = node && node.parameters && node.parameters.url;
  return typeof url === 'string' && url.includes('api.anthropic.com');
}

function bindAnthropic(node, binding, notes) {
  if (!isAnthropicNode(node)) return;
  if (binding.mode === 'credential' && binding.id) {
    node.credentials = node.credentials || {};
    node.credentials.httpHeaderAuth = { id: binding.id, name: 'backbrief-anthropic' };
  } else if (binding.mode === 'inline') {
    // Header-value injection with INJECT_SECRETS semantics: env → preserve
    // whatever value is already there → leave the placeholder + warn.
    const p = node.parameters;
    p.sendHeaders = true;
    p.headerParameters = p.headerParameters || { parameters: [] };
    const params = p.headerParameters.parameters = p.headerParameters.parameters || [];
    let h = params.find((x) => x && String(x.name).toLowerCase() === 'x-api-key');
    if (!h) { h = { name: 'x-api-key', value: '__ANTHROPIC_API_KEY__' }; params.push(h); }
    const fromEnv = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (fromEnv) h.value = fromEnv;
    else if (!h.value || String(h.value).includes('__ANTHROPIC_API_KEY__')) {
      notes.push(`WARNING Anthropic key: no ANTHROPIC_API_KEY env and node "${node.name}" has only the placeholder — WILL 401`);
    }
    delete p.authentication;
    delete p.genericAuthType;
    delete p.nodeCredentialType;
    if (node.credentials) delete node.credentials.httpHeaderAuth;
  }
}

/* ------------------------------------------------------------------ */
/* Param-token patching (non-Code nodes)                               */
/* ------------------------------------------------------------------ */

function patchParamTokens(wf, notes) {
  const resolved = {};
  const unresolved = [];
  for (const t of NODES.PARAM_TOKENS) {
    const v = t.resolve(tenant, state, process.env);
    if (v) resolved[t.token] = String(v);
    else unresolved.push(t);
  }
  // jsCode is owned by the render+inject path — pull it out before the token
  // sweep so a token mentioned inside node code/comments is never rewritten
  // (that would make every deploy drift against a fresh render).
  const savedCode = wf.nodes.map((n) => {
    if (n.parameters && n.parameters.jsCode != null) {
      const code = n.parameters.jsCode;
      n.parameters.jsCode = '';
      return code;
    }
    return null;
  });
  let text = JSON.stringify(wf.nodes);
  for (const [token, value] of Object.entries(resolved)) {
    if (text.includes(token)) {
      text = text.split(token).join(value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
      notes.push(`param: ${token} -> ${value}`);
    }
  }
  for (const t of unresolved) {
    if (text.includes(t.token)) {
      notes.push(`WARNING param ${t.token} (${t.label}) unresolved — token left in place (wire it via tenant.yaml / test-creds.js, then redeploy)`);
    }
  }
  wf.nodes = JSON.parse(text);
  wf.nodes.forEach((n, i) => {
    if (savedCode[i] !== null) n.parameters.jsCode = savedCode[i];
  });
}

/* ------------------------------------------------------------------ */
/* Deploy one workflow                                                 */
/* ------------------------------------------------------------------ */

async function importSkeleton(key, def) {
  const skelPath = path.join(KIT_ROOT, def.skeleton);
  if (!fs.existsSync(skelPath)) { console.error(`  skeleton missing: ${def.skeleton}`); return null; }
  const skel = JSON.parse(fs.readFileSync(skelPath, 'utf8'));
  const tag = skel[NODES.SKELETON_VERSION_KEY];
  if (tag !== KIT_VERSION) {
    console.error(`  skeleton ${def.skeleton} carries ${NODES.SKELETON_VERSION_KEY}=${tag} but kit VERSION=${KIT_VERSION}`);
    console.error('  refusing a stale-skeleton import (update the kit / regenerate skeletons)');
    return null;
  }
  const payload = {
    name: skel.name,
    nodes: skel.nodes,
    connections: skel.connections,
    settings: skel.settings || {},
  };
  if (DRY) { console.log(`  [dry-run] would POST skeleton ${def.skeleton}`); return { id: `dry-${key}` }; }
  const res = await api('POST', 'workflows', payload);
  if (!res.ok) { console.error(`  POST skeleton failed: ${res.status} ${await res.text()}`); return null; }
  const created = await res.json();
  console.log(`  imported ${def.skeleton} -> workflow ${created.id}`);
  return created;
}

async function deployWorkflow(key, def) {
  console.log(`\n== ${key} (${def.label})`);
  const gate = def.gate(tenant);
  if (!gate.on) { console.log(`  skipped: ${gate.reason}`); return { key, status: 'skipped' }; }

  let stateWf = state.workflows[key];
  if (stateWf && stateWf.id && opts.import) {
    console.log(`  already imported as ${stateWf.id} — --import refused for this workflow;`);
    console.log('  re-runs always take the atomic-PUT path (no re-bootstrap — it would revert live fixes).');
  }
  if (!stateWf || !stateWf.id) {
    if (!opts.import) {
      console.error('  no workflow id in pipeline-state — first-time setup needs --import');
      return { key, status: 'failed' };
    }
    const created = await importSkeleton(key, def);
    if (!created) return { key, status: 'failed' };
    stateWf = state.workflows[key] = { id: created.id };
    writeJson(statePath, state);
    if (DRY) return { key, status: 'dry-imported' };
  }

  const gr = await api('GET', `workflows/${stateWf.id}`);
  if (!gr.ok) { console.error(`  GET workflow ${stateWf.id} failed: ${gr.status}`); return { key, status: 'failed' }; }
  const wf = await gr.json();

  // 1. Snapshot (scrubbed on disk; .backbrief/ is gitignored in the vault —
  //    defense in depth, the scrub keeps secrets out of any accidental commit).
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const snapPath = path.join(backbriefDir, 'snapshots', `${key}-pre-${stamp}.json`);
  const known = NODES.COLLECT_KNOWN_SECRETS([wf]);
  if (!DRY) {
    fs.mkdirSync(path.dirname(snapPath), { recursive: true });
    fs.writeFileSync(snapPath, JSON.stringify(NODES.SECRET_SCRUB(wf, known), null, 2) + '\n');
  }
  console.log(`  snapshot -> ${path.relative(process.cwd(), snapPath)} (rollback: PUT it back)`);

  // 2. Repo code → render tenant regions → inject secrets.
  const notes = [];
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  let changed = 0;
  const renderedHashes = [];
  for (const [name, file] of Object.entries(def.nodeFileMap)) {
    const node = byName[name];
    if (!node || !node.parameters) {
      console.error(`  !! live node not found: ${name} — live graph diverged from the skeleton; NOT deploying this workflow`);
      return { key, status: 'failed' };
    }
    const repoPath = path.join(KIT_ROOT, def.codeDir, file);
    if (!fs.existsSync(repoPath)) {
      console.error(`  !! mapped code file missing in kit: ${def.codeDir}/${file}`);
      return { key, status: 'failed' };
    }
    const repoCode = fs.readFileSync(repoPath, 'utf8');
    let rendered;
    try { rendered = RENDER.renderSource(repoCode, ctx).source; }
    catch (e) { console.error(`  !! render failed for ${file}: ${e.message}`); return { key, status: 'failed' }; }
    renderedHashes.push(`${name}:${sha256(rendered)}`);
    const liveCode = node.parameters.jsCode || '';
    const { code: deployCode, notes: n } = NODES.INJECT_SECRETS(rendered, liveCode);
    n.forEach((x) => notes.push(x));
    if (liveCode !== deployCode) { node.parameters.jsCode = deployCode; changed++; console.log(`  set  ${name} <- ${file}`); }
    else console.log(`  same ${name}`);
  }

  // 3. Non-Code params + credential bindings.
  patchParamTokens(wf, notes);
  const binding = await ensureAnthropicCredential();
  for (const n of wf.nodes) bindAnthropic(n, binding, notes);
  for (const n of wf.nodes) {
    for (const cred of Object.values(n.credentials || {})) {
      if (cred && typeof cred.id === 'string' && cred.id.startsWith('__BACKBRIEF_CREDENTIAL_')) {
        notes.push(`WARNING node "${n.name}" needs the "${cred.name}" credential assigned once in the n8n UI`);
      }
    }
  }
  const settings = {};
  for (const k of ALLOWED_SETTINGS) if (wf.settings && wf.settings[k] !== undefined) settings[k] = wf.settings[k];
  if (tenant.tenant && tenant.tenant.timezone) settings.timezone = tenant.tenant.timezone;
  const trapId = state.workflows['error-trap'] && state.workflows['error-trap'].id;
  if (key !== 'error-trap' && trapId && !String(trapId).startsWith('dry-')) settings.errorWorkflow = trapId;

  for (const x of notes) console.log(`       ${x}`);
  console.log(`  ${changed} node(s) to update`);
  if (DRY) { console.log('  DRY_RUN=1 — not writing to n8n'); return { key, status: 'dry' }; }

  // 4. Atomic PUT.
  const pr = await api('PUT', `workflows/${stateWf.id}`, {
    name: wf.name, nodes: wf.nodes, connections: wf.connections, settings,
  });
  if (!pr.ok) {
    console.error(`  PUT failed: ${pr.status} ${await pr.text()}`);
    console.error(`  ROLLBACK: PUT ${snapPath}`);
    return { key, status: 'failed' };
  }
  console.log('  PUT ok');

  // 5. Ensure active (webhooks/schedules register on activation).
  const chk = await (await api('GET', `workflows/${stateWf.id}`)).json();
  if (!chk.active) {
    const act = await api('POST', `workflows/${stateWf.id}/activate`);
    console.log(act.ok ? '  re-activated' : `  WARNING activate failed (${act.status}) — activate in the n8n UI`);
  }

  state.workflows[key] = {
    id: stateWf.id,
    name: wf.name,
    versionId: chk.versionId || null,
    deployed_at: new Date().toISOString(),
    kit_version: KIT_VERSION,
    rendered_config_hash: sha256(renderedHashes.sort().join('\n')),
  };
  writeJson(statePath, state);
  return { key, status: 'deployed' };
}

/* ------------------------------------------------------------------ */
/* Self-test                                                           */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function latestExecution(workflowId) {
  const res = await api('GET', `executions?workflowId=${encodeURIComponent(workflowId)}&limit=1`);
  if (!res.ok) return null;
  const body = await res.json();
  const list = body.data || body.results || [];
  return list[0] || null;
}

async function waitForNewExecution(workflowId, afterId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ex = await latestExecution(workflowId);
    if (ex && String(ex.id) !== String(afterId || '') && ex.finished !== false && ex.status !== 'running') return ex;
    await sleep(3000);
  }
  return null;
}

function nodeOutput(execData, nodeName) {
  let data = execData && execData.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
  return data && data.resultData && data.resultData.runData
    && data.resultData.runData[nodeName]
    && data.resultData.runData[nodeName][0]
    && data.resultData.runData[nodeName][0].data
    && data.resultData.runData[nodeName][0].data.main
    && data.resultData.runData[nodeName][0].data.main[0]
    && data.resultData.runData[nodeName][0].data.main[0][0]
    && data.resultData.runData[nodeName][0].data.main[0][0].json || null;
}

async function postSignedWebhook(fixtureBody) {
  const secret = (process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '').trim();
  if (!secret) throw new Error('ZOOM_WEBHOOK_SECRET_TOKEN env required for --selftest (the fixture must be signed)');
  const bodyStr = JSON.stringify(fixtureBody);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${bodyStr}`).digest('hex');
  const url = `${BASE}/webhook/backbrief-zoom`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-zm-request-timestamp': ts, 'x-zm-signature': sig },
    body: bodyStr,
  });
  return res;
}

async function selftest() {
  console.log('\n== self-test (T3)');
  const wfState = state.workflows.transcripts;
  if (!wfState || !wfState.id) { console.error('  transcripts workflow not deployed — run a deploy first'); return false; }
  const fixturePath = path.join(PIPELINE_DIR, 'fixtures', 'webhooks', 'zoom-webhook-public-team-weekly.json');
  if (!fs.existsSync(fixturePath)) {
    console.error(`  fixture missing: ${path.relative(KIT_ROOT, fixturePath)} (shipped by the test-harness task) — cannot self-test`);
    return false;
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const body = fixture.body || fixture; // fixture may wrap {headers, body}

  const before = await latestExecution(wfState.id);
  console.log('  POST signed synthetic webhook (public team-weekly fixture)…');
  const res = await postSignedWebhook(body);
  if (!(res.status >= 200 && res.status < 300)) {
    console.error(`  webhook POST -> HTTP ${res.status} (expected 2xx). Is the workflow active?`);
    return false;
  }
  const ex = await waitForNewExecution(wfState.id, before && before.id, 180000);
  if (!ex) { console.error('  no new execution appeared within 180 s'); return false; }
  if (ex.status && ex.status !== 'success') {
    console.error(`  execution ${ex.id} finished with status=${ex.status} — check the n8n UI`);
    return false;
  }
  console.log(`  execution ${ex.id} ok (mode=${ex.mode || '?'})`);

  // Pull artifacts for assertion + cleanup bookkeeping.
  const exFull = await (await api('GET', `executions/${ex.id}?includeData=true`)).json();
  const commit = nodeOutput(exFull, 'Build commit payload') || {};
  const root = nodeOutput(exFull, 'Capture root ts') || nodeOutput(exFull, 'Capture root ts (Phase 1)') || {};
  const st = readJson(selftestStatePath, { slack_posts: [], vault_files: [] });
  if (root.slack_root_ts) st.slack_posts.push({ channel: root.slack_root_channel || null, ts: root.slack_root_ts });
  for (const p of [commit.vault_path, commit.transcript_vault_path]) if (p) st.vault_files.push(p);
  st.execution_id = ex.id;
  st.created_at = new Date().toISOString();
  writeJson(selftestStatePath, st);
  if (commit.vault_path) console.log(`  vault artifact: ${commit.vault_path}`);
  if (root.slack_root_ts) console.log(`  slack root: ts=${root.slack_root_ts}`);

  // Optional live GitHub assertion.
  const repo = tenant.vault && tenant.vault.repo;
  const pat = (process.env.GITHUB_VAULT_PAT || '').trim();
  if (repo && pat && commit.vault_path) {
    const gh = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(commit.vault_path).replace(/%2F/g, '/')}`,
      { headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'backbrief-pipeline' } });
    console.log(gh.ok ? '  vault commit landed (GitHub 200)' : `  WARNING vault file not found on GitHub (HTTP ${gh.status})`);
    if (!gh.ok) return false;
  }

  // Idempotency: re-POST the same body → the run must short-circuit, not
  // double-post (recording-state dedup). Assert: new execution, success.
  console.log('  re-POST same webhook (idempotency)…');
  const res2 = await postSignedWebhook(body);
  if (!(res2.status >= 200 && res2.status < 300)) { console.error(`  re-POST -> HTTP ${res2.status}`); return false; }
  const ex2 = await waitForNewExecution(wfState.id, ex.id, 120000);
  if (!ex2 || (ex2.status && ex2.status !== 'success')) {
    console.error('  idempotent re-run did not succeed — check recording-state dedup');
    return false;
  }
  console.log(`  idempotent re-run ok (execution ${ex2.id})`);

  // Optional negative fixture → error trap + DLQ (skipped when not shipped).
  const negPath = path.join(PIPELINE_DIR, 'fixtures', 'webhooks', 'zoom-webhook-negative.json');
  if (fs.existsSync(negPath)) {
    console.log('  POST negative fixture (DLQ path)…');
    const neg = JSON.parse(fs.readFileSync(negPath, 'utf8'));
    await postSignedWebhook(neg.body || neg);
    console.log('  (verify: owner DM + dlq/<date>/ entry — asserted manually or by status.js)');
  } else {
    console.log('  negative fixture not present — DLQ path not exercised');
  }

  console.log('  self-test PASSED — now run: node plugin/scripts/check-drift.js');
  console.log('  cleanup: node plugin/scripts/deploy-pipeline.js --selftest-cleanup');
  return true;
}

async function selftestInteractivity() {
  console.log('\n== self-test: Slack interactivity round-trip (half-test)');
  const tc = state.workflows.taskcrafter;
  if (!tc || !tc.id) { console.error('  taskcrafter workflow not deployed'); return false; }
  const token = (process.env.SLACK_BOT_TOKEN || '').trim();
  if (!token) { console.error('  SLACK_BOT_TOKEN env required'); return false; }
  const digest = NODES.PARAM_TOKENS.find((t) => t.token === '__BACKBRIEF_DIGEST_CHANNEL_ID__').resolve(tenant, state, process.env);
  if (!digest) { console.error('  digest channel unresolved (tenant features.slack.digest_channel / pipeline-state)'); return false; }

  const post = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      channel: digest,
      text: 'Backbrief interactivity self-test',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: ':wrench: *Backbrief interactivity self-test* — click *Skip* below. Nothing will be written anywhere; this only proves the Slack -> n8n webhook wiring.' } },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Skip' }, action_id: 'tc.bulk_skip_all', value: 'selftest' }] },
      ],
    }),
  });
  const postBody = await post.json();
  if (!postBody.ok) { console.error(`  Slack post failed: ${postBody.error}`); return false; }
  const st = readJson(selftestStatePath, { slack_posts: [], vault_files: [] });
  st.slack_posts.push({ channel: postBody.channel, ts: postBody.ts });
  writeJson(selftestStatePath, st);

  const before = await latestExecution(tc.id);
  console.log('  posted. CLICK the Skip button in Slack now (waiting up to 10 min)…');
  const ex = await waitForNewExecution(tc.id, before && before.id, 600000);
  if (!ex) { console.error('  no taskcrafter execution arrived — Slack interactivity URL is not wired to the n8n webhook'); return false; }
  console.log(`  interactivity round-trip ok (execution ${ex.id}, status=${ex.status || 'finished'})`);
  console.log('  note: the click lands outside a real pending batch — a "stale/unknown message" reply in the thread is EXPECTED and harmless.');
  return true;
}

async function selftestCleanup() {
  console.log('\n== self-test cleanup');
  const st = readJson(selftestStatePath, null);
  if (!st) { console.log('  nothing recorded — no cleanup needed'); return true; }
  let ok = true;

  const token = (process.env.SLACK_BOT_TOKEN || '').trim();
  for (const p of st.slack_posts || []) {
    if (!p || !p.ts) continue;
    if (!token) { console.log('  SLACK_BOT_TOKEN not set — skipping Slack deletions'); break; }
    if (DRY) { console.log(`  [dry-run] would delete Slack message ${p.channel}/${p.ts}`); continue; }
    const res = await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: p.channel, ts: p.ts }),
    });
    const body = await res.json();
    console.log(body.ok ? `  deleted Slack message ${p.ts}` : `  WARNING chat.delete ${p.ts}: ${body.error} (delete by hand)`);
    if (!body.ok) ok = false;
  }

  const repo = tenant.vault && tenant.vault.repo;
  const branch = (tenant.vault && tenant.vault.branch) || 'main';
  const pat = (process.env.GITHUB_VAULT_PAT || '').trim();
  for (const vp of st.vault_files || []) {
    if (!repo || !pat) { console.log('  vault repo / GITHUB_VAULT_PAT not set — remove synthetic vault files by hand:'); console.log(`    ${(st.vault_files || []).join('\n    ')}`); break; }
    if (DRY) { console.log(`  [dry-run] would delete ${vp} from ${repo}`); continue; }
    const url = `https://api.github.com/repos/${repo}/contents/${vp.split('/').map(encodeURIComponent).join('/')}`;
    const hdr = { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'backbrief-pipeline' };
    const get = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers: hdr });
    if (!get.ok) { console.log(`  ${vp}: not on GitHub (HTTP ${get.status}) — nothing to revert`); continue; }
    const file = await get.json();
    const del = await fetch(url, {
      method: 'DELETE', headers: hdr,
      body: JSON.stringify({ message: `chore: remove Backbrief self-test artifact ${path.basename(vp)}`, sha: file.sha, branch }),
    });
    console.log(del.ok ? `  reverted ${vp}` : `  WARNING delete ${vp} -> HTTP ${del.status}`);
    if (!del.ok) ok = false;
  }

  if (ok && !DRY) { fs.unlinkSync(selftestStatePath); console.log('  cleanup complete — selftest-state cleared'); }
  return ok;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  if (opts.rotateAnthropic) {
    const b = await ensureAnthropicCredential();
    console.log(b.mode === 'credential' ? `anthropic credential ready (${b.id})` : `mode: ${b.mode}`);
    process.exit(0);
  }
  if (opts.selftestCleanup) process.exit((await selftestCleanup()) ? 0 : 1);
  if (opts.selftestInteractivity) process.exit((await selftestInteractivity()) ? 0 : 1);
  if (opts.selftest && opts.workflows.length === 0 && !opts.import) {
    // bare --selftest runs against the already-deployed pipeline
    process.exit((await selftest()) ? 0 : 1);
  }

  const keys = opts.workflows.length ? opts.workflows : NODES.DEPLOY_ORDER;
  for (const k of keys) {
    if (!NODES.WORKFLOWS[k]) { console.error(`unknown workflow key: ${k} (known: ${Object.keys(NODES.WORKFLOWS).join(', ')})`); process.exit(2); }
  }
  const results = [];
  for (const k of NODES.DEPLOY_ORDER) {
    if (!keys.includes(k)) continue;
    results.push(await deployWorkflow(k, NODES.WORKFLOWS[k]));
  }
  console.log('\n=== summary ===');
  for (const r of results) console.log(`  ${r.key.padEnd(12)} ${r.status}`);
  // Webhook URLs — deploy.md B6 sends the user back to Zoom (and Slack) to
  // paste these; this summary is the canonical printed source of the URL.
  const withHooks = results.filter((r) => r.status !== 'skipped' && r.status !== 'failed'
    && (NODES.WORKFLOWS[r.key].webhookPaths || []).length);
  if (withHooks.length) {
    console.log('\n=== webhook URLs (paste these where the docs say) ===');
    for (const r of withHooks) {
      for (const p of NODES.WORKFLOWS[r.key].webhookPaths) {
        const hint = p === 'backbrief-zoom' ? '   <- Zoom app > Event Subscriptions (deploy.md B6 step 5)'
          : p.endsWith('-interaction') ? '   <- Slack app > Interactivity Request URL'
          : '';
        console.log(`  ${r.key.padEnd(12)} ${BASE}/webhook/${p}${hint}`);
      }
    }
  }
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) process.exit(2);
  if (opts.selftest) {
    const ok = await selftest();
    process.exit(ok ? 0 : 1);
  }
  console.log('-> now run: node plugin/scripts/check-drift.js');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
