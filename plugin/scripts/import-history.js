#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * import-history.js — B7 history backfill.
 *
 * Lists Zoom Cloud recordings for the last N days and replays each through the
 * LIVE pipeline webhook — the exact same entry point a fresh recording uses —
 * so imported calls get the full treatment: vault filing, digest, Slack root
 * post, TaskCrafter. (No privacy routing in v0.1: imported calls land in team
 * folders like any live call — review the plan before --confirm and leave out
 * recordings you would not share vault-wide.)
 *
 * Two-phase by design:
 *
 *   plan phase (default)    list recordings with per-call skip reasons
 *                           (no transcript / too short); nothing is replayed.
 *   run phase (--confirm)   replay the plan, throttled (the prod pipeline
 *                           documents a staticData race on parallel webhooks —
 *                           serial + spacing is deliberate).
 *
 * Replay mechanics: a synthetic `recording.completed` event is built from each
 * recording (host_email injected from the users listing — the recordings API
 * does not carry it), signed with the tenant's real Zoom webhook secret
 * (v0 HMAC, same as the B6 self-test), and POSTed to
 * `$N8N_BASE_URL/webhook/backbrief-zoom`. The S2S access token rides along as
 * `download_token` so the pipeline can download the .vtt (Zoom accepts the
 * account's OAuth token on recording download URLs).
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies, --help,
 * DRY_RUN=1 honored (plan runs; no webhook POSTs, no files written),
 * exit codes 0 ok / 1 some replays failed / 2 config error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { RENDER } = require(path.join(__dirname, 'pipeline-root.js')).requirePipeline('import-history.js');

const DRY_RUN = process.env.DRY_RUN === '1';
const TIMEOUT_MS = 20000;

const HELP = `import-history.js — backfill the vault from Zoom Cloud recordings (B7)

Usage:
  node plugin/scripts/import-history.js [options]              # plan (no writes)
  node plugin/scripts/import-history.js --confirm [options]    # replay

Options:
  --tenant <path>     tenant.yaml (default: $TENANT, else walk up from cwd)
  --days <n>          how far back (default: tenant features.history_import.days, else 30)
  --limit <n>         cap the number of recordings replayed (safety valve)
  --confirm           actually replay through the live webhook (default: plan only)
  --throttle-sec <n>  seconds between webhook POSTs (default 30 — the pipeline
                      state machine dislikes parallel webhooks; keep it gentle)
  --save              write the import digest to .backbrief/deploy/history-import.md
  -h, --help          this text

Env (also loaded from <vault>/.backbrief/secrets.env when present):
  ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET   S2S OAuth (listing + download token)
  ZOOM_WEBHOOK_SECRET_TOKEN                             signs the synthetic webhooks
  N8N_BASE_URL                                          webhook target (--confirm only)
  DRY_RUN=1                                             plan + pretend-replay, zero writes

ARTIFACT: import digest — calls found / filed / skipped / failed.
Exit codes: 0 ok / 1 one or more replays failed / 2 usage or config error`;

/* ------------------------------------------------------------------ */
/* CLI + shared plumbing                                               */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = {
    tenant: null, days: null, limit: null, confirm: false,
    throttleSec: 30, save: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--days') o.days = parseInt(argv[++i], 10);
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10);
    else if (a === '--confirm') o.confirm = true;
    else if (a === '--throttle-sec') o.throttleSec = parseInt(argv[++i], 10);
    else if (a === '--save') o.save = true;
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

function loadSecretsEnv(tenantPath) {
  const file = path.join(path.dirname(tenantPath), '.backbrief', 'secrets.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = val;
  }
}

async function http(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Zoom API                                                            */
/* ------------------------------------------------------------------ */

async function zoomToken() {
  const basic = Buffer.from(
    `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await http(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`,
    { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
  if (res.status !== 200 || !res.body || !res.body.access_token) {
    throw new Error(`Zoom token grant failed (HTTP ${res.status}${res.body && res.body.reason ? `: ${res.body.reason}` : ''})`);
  }
  return { token: res.body.access_token, grantedAt: Date.now() };
}

// Token TTL is ~1h; refresh when older than 45 min (long throttled runs).
async function freshToken(holder) {
  if (!holder.token || Date.now() - holder.grantedAt > 45 * 60 * 1000) {
    const t = await zoomToken();
    holder.token = t.token;
    holder.grantedAt = t.grantedAt;
  }
  return holder.token;
}

async function zoomGet(holder, pathAndQuery) {
  const token = await freshToken(holder);
  return http(`https://api.zoom.us/v2${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function listUsers(holder) {
  const users = [];
  let nextToken = '';
  for (let page = 0; page < 20; page++) {
    const res = await zoomGet(holder, `/users?page_size=300&status=active${nextToken ? `&next_page_token=${encodeURIComponent(nextToken)}` : ''}`);
    if (res.status !== 200) throw new Error(`GET /users -> HTTP ${res.status} (needs user:read scope)`);
    users.push(...(res.body.users || []));
    nextToken = res.body.next_page_token;
    if (!nextToken) break;
  }
  return users;
}

// Zoom caps a recordings query at a 30-day window — chunk the range.
function dateWindows(days) {
  const windows = [];
  const end = new Date();
  let to = new Date(end);
  let remaining = days;
  while (remaining > 0) {
    const span = Math.min(remaining, 30);
    const from = new Date(to.getTime() - span * 24 * 3600 * 1000);
    windows.push({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
    to = from;
    remaining -= span;
  }
  return windows;
}

async function listRecordings(holder, users, days) {
  const byUuid = new Map();
  for (const user of users) {
    for (const w of dateWindows(days)) {
      let nextToken = '';
      for (let page = 0; page < 20; page++) {
        const res = await zoomGet(holder,
          `/users/${encodeURIComponent(user.id)}/recordings?page_size=300&from=${w.from}&to=${w.to}${nextToken ? `&next_page_token=${encodeURIComponent(nextToken)}` : ''}`);
        if (res.status === 404) break; // user has no cloud recording
        if (res.status !== 200) throw new Error(`GET /users/${user.id}/recordings -> HTTP ${res.status} (needs recording:read scope)`);
        for (const m of res.body.meetings || []) {
          if (!byUuid.has(m.uuid)) byUuid.set(m.uuid, { ...m, host_email: user.email });
        }
        nextToken = res.body.next_page_token;
        if (!nextToken) break;
      }
    }
  }
  return [...byUuid.values()].sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
}

/* ------------------------------------------------------------------ */
/* Webhook replay (same signing as the B6 self-test)                   */
/* ------------------------------------------------------------------ */

function buildEvent(meeting, accessToken) {
  return {
    event: 'recording.completed',
    event_ts: Date.now(),
    payload: {
      account_id: process.env.ZOOM_ACCOUNT_ID,
      object: meeting, // uuid, topic, start_time, duration, host_email, recording_files…
    },
    download_token: accessToken,
  };
}

async function postSignedWebhook(base, body) {
  const secret = (process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '').trim();
  if (!secret) throw new Error('ZOOM_WEBHOOK_SECRET_TOKEN required — the pipeline verifies HMAC on every webhook');
  const bodyStr = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${bodyStr}`).digest('hex');
  const res = await fetch(`${base}/webhook/backbrief-zoom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-zm-request-timestamp': ts, 'x-zm-signature': sig },
    body: bodyStr,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res.status;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const tenantPath = findTenantFile(opts.tenant);
  if (!tenantPath) { console.error('✖ no tenant.yaml found — pass --tenant'); process.exit(2); }
  loadSecretsEnv(tenantPath);

  let tenant;
  try { tenant = RENDER.loadTenant(tenantPath); }
  catch (e) { console.error(`✖ tenant.yaml parse failed: ${e.message}`); process.exit(2); }

  const missing = ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']
    .filter((n) => !(process.env[n] || '').trim());
  if (missing.length) { console.error(`✖ missing env: ${missing.join(', ')} (B2 wires these)`); process.exit(2); }

  const hi = (tenant.features && tenant.features.history_import) || {};
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : (hi.days || 30);
  const minDuration = (tenant.pipeline && tenant.pipeline.knobs && tenant.pipeline.knobs.min_duration_min) || 5;

  console.log(`History import plan — last ${days} day(s) of Zoom Cloud recordings\n`);

  const holder = {};
  let users;
  let recordings;
  try {
    await freshToken(holder);
    users = await listUsers(holder);
    console.log(`  account users: ${users.length}`);
    recordings = await listRecordings(holder, users, days);
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(2);
  }

  // Build the plan (no sensitivity classification — privacy routing is not in
  // v0.1; the plan itself is the review surface before --confirm).
  const plan = recordings.map((m) => {
    const files = Array.isArray(m.recording_files) ? m.recording_files : [];
    const hasTranscript = files.some((f) => f.file_type === 'TRANSCRIPT' && (f.status === 'completed' || !f.status));
    const tooShort = Number(m.duration || 0) < minDuration;
    let action = 'replay';
    let reason = '';
    if (!hasTranscript) { action = 'skip'; reason = 'no transcript file (audio-only recording)'; }
    else if (tooShort) { action = 'skip'; reason = `shorter than min_duration_min (${minDuration})`; }
    return { meeting: m, action, reason };
  });

  let toReplay = plan.filter((p) => p.action === 'replay');
  const skipped = plan.filter((p) => p.action === 'skip');
  if (Number.isFinite(opts.limit) && opts.limit > 0) toReplay = toReplay.slice(0, opts.limit);

  console.log(`  found: ${recordings.length} · replayable: ${toReplay.length} · skipped: ${skipped.length}\n`);
  console.log('  note: imported calls file into team folders like live calls (no privacy');
  console.log('  routing in v0.1) — review the list; drop what you would not share vault-wide.\n');
  if (skipped.length) {
    for (const p of skipped.slice(0, 10)) {
      console.log(`  ⏭  ${String(p.meeting.start_time).slice(0, 16).replace('T', ' ')}  "${p.meeting.topic}" — ${p.reason}`);
    }
    if (skipped.length > 10) console.log(`  ⏭  … and ${skipped.length - 10} more skipped`);
    console.log('');
  }

  if (!opts.confirm) {
    console.log(`Plan only — nothing replayed. To import ${toReplay.length} call(s):`);
    console.log(`  node plugin/scripts/import-history.js --confirm${Number.isFinite(opts.days) ? ` --days ${days}` : ''}`);
    process.exit(0);
  }

  // Run phase.
  const base = (process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
  if (!base) { console.error('✖ N8N_BASE_URL required for --confirm (the replay target)'); process.exit(2); }
  const throttleMs = Math.max(1, opts.throttleSec) * 1000;

  console.log(`Replaying ${toReplay.length} call(s) -> ${base}/webhook/backbrief-zoom (throttle ${opts.throttleSec}s)\n`);
  let ok = 0;
  let failed = 0;
  const failures = [];
  for (let i = 0; i < toReplay.length; i++) {
    const { meeting } = toReplay[i];
    const label = `${String(meeting.start_time).slice(0, 16).replace('T', ' ')}  "${meeting.topic}"`;
    if (DRY_RUN) { console.log(`  [dry-run] would POST ${label}`); ok++; continue; }
    try {
      const token = await freshToken(holder);
      const status = await postSignedWebhook(base, buildEvent(meeting, token));
      if (status >= 200 && status < 300) { console.log(`  ✅ ${i + 1}/${toReplay.length} ${label}`); ok++; }
      else { console.log(`  ✖ ${i + 1}/${toReplay.length} ${label} — webhook HTTP ${status}`); failed++; failures.push({ label, why: `HTTP ${status}` }); }
    } catch (e) {
      console.log(`  ✖ ${i + 1}/${toReplay.length} ${label} — ${e.message}`);
      failed++;
      failures.push({ label, why: e.message });
    }
    if (i < toReplay.length - 1) await sleep(throttleMs);
  }

  // Digest (the B7 artifact).
  const digestLines = [
    `# Backbrief history import — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    `- window: last ${days} day(s)`,
    `- recordings found: ${recordings.length}`,
    `- replayed (filed): ${ok}`,
    `- skipped (no transcript / too short): ${skipped.length}`,
    `- failed: ${failed}`,
  ];
  if (failures.length) {
    digestLines.push('', '## Failures (retry: re-run --confirm — the state machine dedupes already-filed calls)');
    for (const f of failures) digestLines.push(`- ${f.label} — ${f.why}`);
  }
  const digest = digestLines.join('\n') + '\n';
  console.log(`\n${digest}`);
  if (opts.save) {
    const file = path.join(path.dirname(tenantPath), '.backbrief', 'deploy', 'history-import.md');
    if (DRY_RUN) console.log(`[dry-run] would write ${file}`);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, digest);
      console.log(`digest saved -> ${path.relative(process.cwd(), file)}`);
    }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
