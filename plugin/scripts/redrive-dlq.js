#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * redrive-dlq.js — recover vault artifacts from durable DLQ entries (02 §3).
 *
 * Generalization of the production redrive tool. The pipeline's error path
 * commits one JSON entry per failed execution to `<vault.dlq_folder>/<date>/
 * <execId>.json` in the VAULT repo; this script re-creates the lost vault
 * files in your local working copy:
 *   1. artifact embedded in the entry (artifact_gated=false) → decode + write;
 *   2. gated or absent artifact → pull the "Build commit payload" node output
 *      from the n8n execution API (needs N8N_BASE_URL + N8N_API_KEY);
 *   3. execution expired (n8n retention rolled over) → print manual Zoom
 *      Cloud recovery instructions and move on.
 * Recovered files are `git add`ed and the DLQ entry is MOVED to
 * `<dlq>/redriven/<same subpath>`. NOTHING is committed — a suggested commit
 * message is printed; review + commit stays with the operator.
 *
 * SAFETY (hard rule, inherited from prod — 02 §3): never writes outside the
 * vault root, and — pure defense-in-depth, since kit v0.1 ships no privacy
 * routing and creates no private/ paths — refuses to write into any
 * private-looking path (legacy private_slices/route prefixes + the
 * `-private/` / `/1on1/` conventions) and REFUSES entries stamped with a
 * legacy sensitivity of confidential / personal-1on1 —
 * that material must not be redriven into a shared vault; recover it by hand
 * into the private boundary if ever needed.
 *
 * Usage: node plugin/scripts/redrive-dlq.js <entry.json | date-dir> [--dry-run]
 *        node plugin/scripts/redrive-dlq.js --all [--dry-run]
 * Options:
 *        --vault <path>   vault repo working copy (default: cwd)
 *        --tenant <path>  tenant.yaml (default: <vault>/tenant.yaml)
 *
 * Env (only for gated/absent-artifact entries): N8N_BASE_URL, N8N_API_KEY
 * (also loaded from <vault>/.backbrief/secrets.env when present; env wins)
 * Exit codes: 0 ok (incl. gated-no-source — manual follow-up printed),
 *             1 one or more entries failed, 2 usage/config error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { RENDER } = require(path.join(__dirname, 'pipeline-root.js')).requirePipeline('redrive-dlq.js');

const PAYLOAD_NODE = 'Build commit payload'; // transcripts-workflow replay source
const BLOCKED_SENSITIVITY = ['confidential', 'personal-1on1'];

/* ---------- CLI ---------- */
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`redrive-dlq.js — recover vault artifacts from dead-letter (DLQ) entries

Usage:
  node plugin/scripts/redrive-dlq.js <entry.json | date-dir> [options]   # one entry, or a day's folder
  node plugin/scripts/redrive-dlq.js --all [options]                     # every entry under the DLQ folder

Options:
  --vault <path>    vault repo working copy (default: current directory)
  --tenant <path>   tenant.yaml (default: <vault>/tenant.yaml — locates the DLQ folder)
  --dry-run         show what would be written, touch nothing (also honors DRY_RUN=1)
  --all             process every entry under the DLQ folder
  -h, --help        this text

Rebuilds the vault files a failed pipeline run lost — from the artifact embedded in
the entry, or (when gated/absent) the n8n execution data. It only ever writes inside
the vault root, and stages recovered files for your review — it never commits.

Env (only for gated/absent-artifact entries): N8N_BASE_URL, N8N_API_KEY
     (also loaded from <vault>/.backbrief/secrets.env when present; env wins)
Exit codes: 0 ok (incl. gated entries with manual follow-up printed) / 1 one or more entries failed / 2 usage or config error`);
  process.exit(0);
}
function takeOpt(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
const VAULT = path.resolve(takeOpt('--vault') || process.cwd());
const TENANT_PATH = path.resolve(takeOpt('--tenant') || path.join(VAULT, 'tenant.yaml'));
const DRY = args.includes('--dry-run') || process.env.DRY_RUN === '1';
const ALL = args.includes('--all');
const positional = args.filter((a) => !a.startsWith('--'));
const unknown = args.filter((a) => a.startsWith('--') && !['--dry-run', '--all'].includes(a));
if (unknown.length || (ALL && positional.length) || (!ALL && positional.length !== 1)) {
  console.error('usage: node plugin/scripts/redrive-dlq.js <dlq entry.json | date-dir> [--dry-run] (see --help)');
  process.exit(2);
}

/* ---------- tenant-derived config ---------- */
if (!fs.existsSync(TENANT_PATH)) {
  console.error(`tenant.yaml not found at ${TENANT_PATH} — pass --tenant (needed to locate the DLQ folder)`);
  process.exit(2);
}

// Load the documented secret contract (.backbrief/secrets.env) of the vault
// holding the tenant file BEFORE fetchFromN8n reads N8N_BASE_URL / N8N_API_KEY
// — explicit env still wins, the file only fills gaps (remediation M-secrets).
require('./load-secrets-env').loadSecretsEnv(path.dirname(TENANT_PATH));

let tenant;
try { tenant = RENDER.loadTenant(TENANT_PATH); }
catch (e) { console.error(`tenant parse failed: ${e.message}`); process.exit(2); }

const dlqFolder = String((tenant.vault && tenant.vault.dlq_folder) || 'pipeline/dlq').replace(/^\/+|\/+$/g, '');
const DLQ_DIR = path.join(VAULT, dlqFolder);
const REDRIVEN_DIR = path.join(DLQ_DIR, 'redriven');

// Private prefixes: tenant private_slices + 1:1/board route prefixes. The
// legacy `-private/` and `/1on1/` substring conventions stay as a safety net
// (kit-wide invariant — 03 §1.4).
function privatePrefixes() {
  const out = new Set();
  const slices = (tenant.vault && tenant.vault.private_slices) || {};
  for (const v of Object.values(slices)) {
    if (typeof v === 'string' && v.trim()) out.add(v.replace(/^\/+|\/+$/g, '') + '/');
  }
  const routes = (tenant.sensitivity && tenant.sensitivity.routes) || {};
  const p1 = routes['personal-1on1'] || 'private/1on1/{other}/transcripts';
  out.add(String(p1).split('{other}')[0].replace(/^\/+|\/+$/g, '') + '/');
  const bp = routes['board-private'] || 'private/board/transcripts';
  out.add(String(bp).replace(/^\/+|\/+$/g, '') + '/');
  return [...out].filter((s) => s !== '/');
}
const PRIVATE_PREFIXES = privatePrefixes();

/* ---------- helpers ---------- */
const git = (...a) => execFileSync('git', a, { cwd: VAULT, encoding: 'utf8' });
const gitTracked = (rel) => { try { git('ls-files', '--error-unmatch', rel); return true; } catch (e) { return false; } };
const rel = (p) => path.relative(VAULT, p);

function collectEntries() {
  if (ALL) {
    if (!fs.existsSync(DLQ_DIR)) { console.log(`${dlqFolder}/ does not exist — nothing to redrive`); process.exit(0); }
    return walkJson(DLQ_DIR);
  }
  let target = path.resolve(process.cwd(), positional[0]);
  if (!fs.existsSync(target)) target = path.resolve(VAULT, positional[0]); // allow vault-root-relative
  if (!fs.existsSync(target)) { console.error(`not found: ${positional[0]}`); process.exit(2); }
  return fs.statSync(target).isDirectory() ? walkJson(target) : [target];
}

function walkJson(dir) { // recursive, skips the redriven/ subtree
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (path.resolve(p) !== path.resolve(REDRIVEN_DIR)) out.push(...walkJson(p)); }
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

// Returns a refusal reason, or null if the vault-relative path is safe to write.
function pathGate(relPath) {
  const s = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  for (const prefix of PRIVATE_PREFIXES) {
    if (s.startsWith(prefix) || ('/' + s).includes('/' + prefix)) return `target path is inside the private slice "${prefix}"`;
  }
  for (const bad of ['-private/', '/1on1/']) if (('/' + s).includes(bad)) return `target path contains "${bad}"`;
  const abs = path.resolve(VAULT, s);
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep)) return 'target path escapes the vault root';
  return null;
}

function vttError(text) {
  const t = text.replace(/^﻿/, ''); // tolerate a BOM before the WEBVTT header
  if (!t.startsWith('WEBVTT')) return 'decoded transcript does not start with "WEBVTT"';
  if (!t.includes('-->')) return 'decoded transcript contains no "-->" cue line';
  return null;
}

// Fetch the commit payload from the n8n execution. Returns
// { artifact } | { gone: <reason for manual recovery> }; throws on hard API errors.
async function fetchFromN8n(entry) {
  const BASE = process.env.N8N_BASE_URL, KEY = process.env.N8N_API_KEY;
  if (!BASE || !KEY) return { gone: 'N8N_BASE_URL / N8N_API_KEY not set — cannot query n8n' };
  const res = await fetch(`${BASE.replace(/\/+$/, '')}/api/v1/executions/${encodeURIComponent(entry.exec_id)}?includeData=true`,
    { headers: { 'X-N8N-API-KEY': KEY, Accept: 'application/json' } });
  if (res.status === 404) return { gone: `execution ${entry.exec_id} no longer in n8n (retention rolled over)` };
  if (!res.ok) throw new Error(`n8n GET executions/${entry.exec_id} -> HTTP ${res.status}`);
  const exec = await res.json();
  let data = exec.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
  const json = data && data.resultData && data.resultData.runData
    && data.resultData.runData[PAYLOAD_NODE]
    && data.resultData.runData[PAYLOAD_NODE][0]
    && data.resultData.runData[PAYLOAD_NODE][0].data
    && data.resultData.runData[PAYLOAD_NODE][0].data.main
    && data.resultData.runData[PAYLOAD_NODE][0].data.main[0]
    && data.resultData.runData[PAYLOAD_NODE][0].data.main[0][0]
    && data.resultData.runData[PAYLOAD_NODE][0].data.main[0][0].json;
  if (!json || !json.vault_path || !json.content_b64)
    return { gone: `execution ${entry.exec_id} exists but has no "${PAYLOAD_NODE}" output (failed upstream of it)` };
  return { artifact: {
    vault_path: json.vault_path, content_b64: json.content_b64,
    transcript_vault_path: json.transcript_vault_path != null ? json.transcript_vault_path : null,
    transcript_content_b64: json.transcript_content_b64 != null ? json.transcript_content_b64 : null,
  } };
}

function printZoomRecovery(entry, reason) {
  const uuid = entry.zoom_meeting_uuid || '<zoom meeting uuid>';
  const enc = encodeURIComponent(encodeURIComponent(uuid)); // Zoom requires double URL-encoding (uuid may contain / or //)
  console.log(`  !! ${reason}`);
  console.log('  Manual recovery — Zoom Cloud, Server-to-Server OAuth:');
  console.log('    1. token: POST https://zoom.us/oauth/token?grant_type=account_credentials&account_id=<ACCOUNT_ID>');
  console.log('       (Basic auth CLIENT_ID:CLIENT_SECRET of the S2S OAuth app — .backbrief/secrets.env)');
  console.log(`    2. GET https://api.zoom.us/v2/meetings/${enc}/recordings  (Authorization: Bearer <token>)`);
  console.log('       note: the meeting UUID above is already double-URL-encoded, use it verbatim');
  console.log('    3. in recording_files[], download the file_type="TRANSCRIPT" entry (download_url?access_token=<token>) — the .vtt');
  console.log('    4. re-file the transcript through the plugin, or replay the original webhook (see retry_hint in the entry)');
}

// Decode + gate + write the artifact. Returns list of vault-relative paths written.
function writeArtifact(a) {
  const targets = [['vault_path', a.vault_path]];
  if (a.transcript_content_b64) {
    if (!a.transcript_vault_path) throw new Error('transcript_content_b64 present but transcript_vault_path missing');
    targets.push(['transcript_vault_path', a.transcript_vault_path]);
  }
  for (const [field, p] of targets) {
    const refuse = pathGate(p);
    if (refuse) throw new Error(`SAFETY REFUSAL — ${refuse} (${field}: ${p}) — redrive this entry by hand if it is legitimate`);
  }
  const md = Buffer.from(a.content_b64, 'base64').toString('utf8');
  if (!md.length) throw new Error('content_b64 decoded to an empty document');
  let vtt = null;
  if (a.transcript_content_b64) {
    vtt = Buffer.from(a.transcript_content_b64, 'base64').toString('utf8');
    const bad = vttError(vtt);
    if (bad) throw new Error(`${bad} — refusing to write ${a.transcript_vault_path}`);
  }
  const written = [];
  for (const [p, body] of [[a.vault_path, md], ...(vtt !== null ? [[a.transcript_vault_path, vtt]] : [])]) {
    const abs = path.resolve(VAULT, p);
    if (DRY) { console.log(`  [dry-run] would write ${p} (${Buffer.byteLength(body)} bytes)`); }
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
      console.log(`  wrote ${p} (${Buffer.byteLength(body)} bytes)`);
    }
    written.push(p);
  }
  return written;
}

// Move a resolved DLQ entry to <dlq>/redriven/<same subpath>. Entries living
// outside the DLQ dir (ad-hoc paths, fixtures) are left in place with a note.
function moveEntry(file) {
  const sub = path.relative(DLQ_DIR, path.resolve(file));
  if (sub.startsWith('..') || path.isAbsolute(sub)) { console.log(`  entry is outside ${dlqFolder}/ — left in place: ${file}`); return; }
  const dest = path.join(REDRIVEN_DIR, sub);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (gitTracked(rel(file))) git('mv', rel(file), rel(dest)); // stages both sides
  else { fs.renameSync(path.resolve(file), dest); git('add', rel(dest)); }
  console.log(`  entry -> ${rel(dest)}`);
}

/* ---------- per-entry processing ---------- */
async function processEntry(file) {
  const label = rel(path.resolve(file)).startsWith('..') ? file : rel(path.resolve(file));
  console.log(`\n-- ${label}`);
  let entry;
  try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`  !! unparseable entry: ${e.message}`); return { file: label, status: 'failed', detail: 'unparseable JSON' }; }
  const detailBase = `exec ${entry.exec_id || '?'} · ${entry.topic || '(no topic)'}`;

  if (BLOCKED_SENSITIVITY.includes(entry.sensitivity)) {
    console.error(`  !! SAFETY REFUSAL — sensitivity "${entry.sensitivity}" must never be redriven into a shared vault (hard rule)`);
    return { file: label, status: 'failed', detail: `${detailBase} · refused: sensitivity ${entry.sensitivity}` };
  }

  // Resolve the artifact: embedded payload, else n8n execution data.
  let artifact = (!entry.artifact_gated && entry.artifact) ? entry.artifact : null;
  let source = 'payload';
  if (!artifact) {
    source = 'n8n';
    console.log(`  artifact ${entry.artifact_gated ? 'gated' : 'absent'} — trying n8n execution ${entry.exec_id}`);
    let got;
    try { got = await fetchFromN8n(entry); }
    catch (e) { console.error(`  !! ${e.message}`); return { file: label, status: 'failed', detail: `${detailBase} · ${e.message}` }; }
    if (got.gone) { printZoomRecovery(entry, got.gone); return { file: label, status: 'gated-no-source', detail: `${detailBase} · ${got.gone}` }; }
    artifact = got.artifact;
  }

  // Already recovered? (e.g. by hand, or by a previous partial run)
  if (artifact.vault_path && !pathGate(artifact.vault_path) && fs.existsSync(path.resolve(VAULT, artifact.vault_path))) {
    console.log(`  already in vault: ${artifact.vault_path}`);
    if (!DRY) moveEntry(file);
    return { file: label, status: 'already-present', detail: detailBase };
  }

  let written;
  try { written = writeArtifact(artifact); }
  catch (e) { console.error(`  !! ${e.message}`); return { file: label, status: 'failed', detail: `${detailBase} · ${e.message}` }; }

  if (!DRY) {
    for (const p of written) git('add', p);
    moveEntry(file);
  }
  return { file: label, status: `recovered-from-${source}`, detail: detailBase, written, exec_id: entry.exec_id };
}

/* ---------- main ---------- */
(async () => {
  try { git('rev-parse', '--is-inside-work-tree'); }
  catch (e) { console.error(`${VAULT} is not a git working copy — pass --vault <path to your vault repo>`); process.exit(2); }

  const files = collectEntries();
  if (!files.length) { console.log('no DLQ entries found'); process.exit(0); }
  console.log(`${files.length} DLQ entr${files.length === 1 ? 'y' : 'ies'} to redrive${DRY ? ' (DRY RUN — no writes, no git)' : ''}`);
  console.log(`vault: ${VAULT} · dlq: ${dlqFolder}/ · private prefixes gated: ${PRIVATE_PREFIXES.join(', ')}`);

  const results = [];
  for (const f of files) results.push(await processEntry(f)); // sequential: git index is not concurrency-safe

  // Summary table
  const w1 = Math.max(5, ...results.map((r) => r.file.length));
  const w2 = Math.max(6, ...results.map((r) => r.status.length));
  console.log('\n=== summary ===');
  console.log(`${'entry'.padEnd(w1)}  ${'status'.padEnd(w2)}  detail`);
  for (const r of results) console.log(`${r.file.padEnd(w1)}  ${r.status.padEnd(w2)}  ${r.detail}`);

  const recovered = results.filter((r) => r.status.startsWith('recovered-'));
  const failed = results.filter((r) => r.status === 'failed');
  const gated = results.filter((r) => r.status === 'gated-no-source');
  if (recovered.length && !DRY) {
    const ids = recovered.map((r) => r.exec_id).join(', ');
    const msg = recovered.length === 1
      ? `sync: redrive DLQ exec ${recovered[0].exec_id} — ${path.basename(recovered[0].written[0], '.md')}`
      : `sync: redrive ${recovered.length} DLQ entries (exec ${ids})`;
    console.log('\nrecovered files + moved entries are STAGED, not committed. Review, then:');
    console.log(`  git commit -m "${msg}"`);
  }
  if (gated.length) console.log(`\n${gated.length} entr${gated.length === 1 ? 'y needs' : 'ies need'} manual Zoom recovery — instructions above`);
  if (failed.length) { console.error(`\n${failed.length} entr${failed.length === 1 ? 'y' : 'ies'} FAILED`); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(2); });
