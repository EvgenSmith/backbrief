#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * test-creds.js — live connector probes for the B2–B6 credential rungs
 * Per-service credential probes (T2 live-test tier).
 *
 * "Every step ends with a VERIFIED artifact" (FR-B2): a credential is accepted
 * only after a live API call proves it works. Per service:
 *
 *   zoom      S2S OAuth token grant -> granted-scope check -> past_meetings
 *             participants probe (the roster API that bit us in prod — a 404
 *             on a fake meeting id proves auth+scope reached the resource)
 *             -> webhook secret shape check
 *   slack     auth.test -> granted scopes vs the shipped app manifest ->
 *             resolve EVERY roster member to a Slack user id
 *             (users.lookupByEmail per profile email; users.list name-match
 *             fallback; cached in pipeline-state slack.user_ids — this is what
 *             makes @mentions real instead of bold plain text) ->
 *             resolve digest channel #name -> C… id (cached in pipeline-state)
 *             -> live test post to the digest channel (the visible artifact)
 *   github    PAT probe on vault.repo -> push permission -> branch commits ->
 *             Git-Data ref read (dry atomic-commit permission check) ->
 *             vault .gitignore excludes .backbrief/secrets.env
 *   linear    viewer query -> resolve EVERY tracker_team_key in the tenant
 *             team_mapping + each team's "Todo" workflow state -> 1 search
 *             query per team -> provenance label get-or-create -> workspace
 *             URL slug (all cached in pipeline-state tracker.*) ->
 *             resolve roster members to Linear user ids (email first, name
 *             fallback; cached in pipeline-state tracker.users)
 *   anthropic 1-token probe per DISTINCT llm.* (model, thinking, effort)
 *             combination WITH the tenant's exact params — the matcher's
 *             thinking/effort combo is exactly what broke silently for 3
 *             weeks in prod, so it is probed as configured, not bare.
 *             Model-unavailable -> documented downgrade proposal (03 §6.3).
 *   all       run everything applicable per tenant feature flags; disabled
 *             components are skipped and say so (B6 gate).
 *
 * Secrets come from the environment; if `<vault>/.backbrief/secrets.env`
 * exists it is loaded first (env vars already set always win). Never echoes
 * secret values.
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies, --help,
 * DRY_RUN=1 skips the one visible write (the Slack test post + state cache),
 * exit codes 0 ok / 1 check failed / 2 operational error.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KIT_ROOT = path.join(__dirname, '..', '..');
const RENDER = require(path.join(KIT_ROOT, 'pipeline', 'tenant-render.js'));

const DRY_RUN = process.env.DRY_RUN === '1';
const TIMEOUT_MS = 15000;

const SERVICES = ['zoom', 'slack', 'github', 'linear', 'anthropic', 'all'];

const HELP = `test-creds.js — live credential probes (B2–B6); a step is done only when this is green

Usage:
  node plugin/scripts/test-creds.js <${SERVICES.join('|')}> [options]

Options:
  --tenant <path>   tenant.yaml (default: $TENANT, else walk up from cwd)
  --no-post         slack: skip the visible test post (auth+scopes+resolve only)
  --json            machine-readable result on stdout
  -h, --help        this text

Env (also loaded from <vault>/.backbrief/secrets.env when present; real env wins):
  zoom      ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_WEBHOOK_SECRET_TOKEN
  slack     SLACK_BOT_TOKEN
  github    GITHUB_VAULT_PAT           (+ tenant vault.repo / vault.branch)
  linear    LINEAR_API_TOKEN           (+ tenant features.tracker.team_mapping)
  anthropic ANTHROPIC_API_KEY          (+ tenant llm.* stage configs)

DRY_RUN=1  read-only probes still run; the Slack test post and pipeline-state
           cache writes are skipped.

Exit codes: 0 all probes green / 1 a probe failed / 2 usage or config error`;

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = { service: null, tenant: null, noPost: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--no-post') o.noPost = true;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!a.startsWith('-') && !o.service) o.service = a;
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

// Load <vault>/.backbrief/secrets.env into process.env (existing env wins).
function loadSecretsEnv(tenantPath) {
  if (!tenantPath) return;
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
  return { status: res.status, headers: res.headers, body };
}

function readState(tenantPath) {
  const p = path.join(path.dirname(tenantPath), '.backbrief', 'pipeline-state.json');
  try { return { path: p, state: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { path: p, state: {} }; }
}

function writeState(stateFile, state) {
  if (DRY_RUN) { console.log(`  [dry-run] would update ${stateFile}`); return; }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

// Probe-result collector: pass/fail lines that read like the B-rung artifact.
class Report {
  constructor(service) { this.service = service; this.lines = []; this.failed = false; }
  ok(msg) { this.lines.push({ level: 'ok', msg }); console.log(`  ✅ ${msg}`); }
  warn(msg) { this.lines.push({ level: 'warn', msg }); console.log(`  ⚠  ${msg}`); }
  fail(msg) { this.lines.push({ level: 'fail', msg }); this.failed = true; console.log(`  ✖  ${msg}`); }
  skip(msg) { this.lines.push({ level: 'skip', msg }); console.log(`  ⏭  ${msg}`); }
}

function missingEnv(names) {
  return names.filter((n) => !(process.env[n] || '').trim());
}

/* ------------------------------------------------------------------ */
/* zoom (B2)                                                           */
/* ------------------------------------------------------------------ */

// Zoom scopes come in classic (`meeting:read:admin`) and granular
// (`meeting:read:list_past_participants:admin`) flavors — accept either.
const ZOOM_WANTED_SCOPES = [
  { need: 'past-meeting participants (roster)', match: /meeting:read(:admin|:.*participants)/ },
  { need: 'cloud recordings (B7 history import)', match: /(cloud_)?recording:read/ },
];

async function testZoom(report) {
  const miss = missingEnv(['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']);
  if (miss.length) { report.fail(`missing env: ${miss.join(', ')} (docs/zoom-s2s-setup.md)`); return; }

  // 1. S2S OAuth token grant.
  const basic = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  let token;
  try {
    const res = await http(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`,
      { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
    if (res.status !== 200 || !res.body || !res.body.access_token) {
      const reason = res.body && res.body.reason ? ` — ${res.body.reason}` : '';
      report.fail(`token grant failed (HTTP ${res.status}${reason}) — check Account ID / Client ID / Client Secret (checklist step 4)`);
      return;
    }
    token = res.body.access_token;
    report.ok('S2S OAuth token granted');
    // 2. Granted scopes (advisory — the live probe below is definitive).
    const scopes = String(res.body.scope || '');
    for (const w of ZOOM_WANTED_SCOPES) {
      if (w.match.test(scopes)) report.ok(`scope present: ${w.need}`);
      else report.warn(`scope possibly missing: ${w.need} — add it in the S2S app (checklist step 2) if the probe below fails`);
    }
  } catch (e) { report.fail(`token grant unreachable (${e.message})`); return; }

  // 3. Live participants-API probe. A fake meeting id must return "meeting
  //    not found" (404 / code 3001) — that proves auth AND scope reached the
  //    resource. 401 = bad token; 403/4700 = the scope is really missing.
  try {
    const res = await http('https://api.zoom.us/v2/past_meetings/00000000000/participants?page_size=1',
      { headers: { Authorization: `Bearer ${token}` } });
    const code = res.body && typeof res.body === 'object' ? res.body.code : null;
    if (res.status === 404 || code === 3001 || code === 1010) {
      report.ok('participants API reachable (auth + scope verified via not-found probe)');
    } else if (res.status === 401) {
      report.fail('participants API: 401 — token rejected (wrong account?)');
    } else if (res.status === 403 || code === 4700 || code === 4711) {
      report.fail('participants API: scope missing — revisit the S2S app scopes (checklist step 2), then Save + re-run');
    } else if (res.status === 200) {
      report.ok('participants API reachable');
    } else {
      report.warn(`participants API: unexpected HTTP ${res.status} (code ${code}) — probe inconclusive`);
    }
  } catch (e) { report.fail(`participants API unreachable (${e.message})`); }

  // 4. Webhook secret shape (the value is verified live at B6 self-test).
  const secret = (process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '').trim();
  if (!secret) report.fail('ZOOM_WEBHOOK_SECRET_TOKEN missing — copy the Secret Token from the app\'s Feature page (checklist step 3)');
  else if (secret.length < 8 || /\s/.test(secret) || /PLACEHOLDER|^__.*__$/.test(secret)) {
    report.fail('ZOOM_WEBHOOK_SECRET_TOKEN looks wrong (too short / whitespace / placeholder)');
  } else report.ok('webhook secret shape ok (live HMAC verified at B6 self-test)');
}

/* ------------------------------------------------------------------ */
/* slack (B3)                                                          */
/* ------------------------------------------------------------------ */

function manifestScopes() {
  try {
    const text = fs.readFileSync(path.join(KIT_ROOT, 'plugin', 'templates', 'slack-app-manifest.yaml'), 'utf8');
    const m = text.match(/bot:\s*\n((?:\s+-\s+\S+.*\n?)+)/);
    if (!m) return [];
    return m[1].split('\n')
      .map((l) => (l.match(/-\s+([a-z._:]+)/) || [])[1])
      .filter(Boolean);
  } catch (e) { return []; }
}

async function slackApi(method, token, payload) {
  return http(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

// Roster -> Slack user ids (the B3 promise "auto-resolved at deploy").
// Order per member: pre-set roster slack_user_id wins -> users.lookupByEmail
// (profile email; needs users:read.email) -> users.list name match. Results go
// to pipeline-state slack.user_ids — the map tenant-render's
// SLACK_USER_ID_BY_LASTNAME reads. missing_scope never fails the step.
async function resolveRosterMentions(report, tenant, token, stateBundle) {
  const roster = (tenant && Array.isArray(tenant.roster) ? tenant.roster : [])
    .filter((m) => m && m.lastname);
  if (!roster.length) {
    report.warn('roster is empty — @mention resolution skipped (B1 fills the roster from team/*.md)');
    return;
  }

  const resolved = {};
  for (const m of roster) {
    if (m.slack_user_id && /^U[A-Z0-9]{6,}$/.test(String(m.slack_user_id))) {
      resolved[m.lastname] = String(m.slack_user_id); // manual override wins
    }
  }

  // Pass 1 — email lookup (exact).
  let emailScopeMissing = false;
  for (const m of roster) {
    if (resolved[m.lastname] || emailScopeMissing) continue;
    const email = typeof m.email === 'string' && m.email.includes('@') ? m.email : null;
    if (!email) continue;
    let res;
    try {
      res = await http(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
        { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) { report.warn(`users.lookupByEmail unreachable (${e.message}) — name-matching fallback`); break; }
    if (res.body && res.body.ok && res.body.user) { resolved[m.lastname] = res.body.user.id; continue; }
    if (res.body && res.body.error === 'missing_scope') {
      emailScopeMissing = true;
      report.warn('users:read.email scope missing — email lookup unavailable; using name matching (reinstall the app from the shipped manifest to fix)');
    }
    // users_not_found -> fall through to the name-match pass
  }

  // Pass 2 — users.list name matching for the rest (+ preventive email hints).
  const emailHints = [];
  if (roster.some((m) => !resolved[m.lastname])) {
    const users = [];
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      let res;
      try {
        res = await http(`https://slack.com/api/users.list?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { headers: { Authorization: `Bearer ${token}` } });
      } catch (e) { report.warn(`users.list unreachable (${e.message})`); break; }
      if (!res.body || !res.body.ok) {
        report.warn(`users.list failed (${(res.body && res.body.error) || `HTTP ${res.status}`}) — check the users:read scope`);
        break;
      }
      users.push(...(res.body.members || []));
      cursor = res.body.response_metadata && res.body.response_metadata.next_cursor;
      if (!cursor) break;
    }
    const humans = users.filter((u) => u && !u.deleted && !u.is_bot && u.id !== 'USLACKBOT');
    for (const m of roster) {
      if (resolved[m.lastname]) continue;
      const needles = [String(m.lastname)];
      if (Array.isArray(m.aliases)) needles.push(...m.aliases.map(String));
      if (m.first_name) needles.push(`${m.first_name} ${m.lastname}`);
      const lower = needles.map((n) => n.toLowerCase()).filter((n) => n.length >= 3);
      const hits = humans.filter((u) => {
        const cands = [u.real_name, u.name, u.profile && u.profile.real_name,
          u.profile && u.profile.display_name].filter(Boolean).map((s) => String(s).toLowerCase());
        return cands.some((c) => lower.some((n) => c.includes(n)));
      });
      if (hits.length === 1) {
        resolved[m.lastname] = hits[0].id;
        const slackEmail = hits[0].profile && hits[0].profile.email;
        if (slackEmail && !(typeof m.email === 'string' && m.email.includes('@'))) {
          emailHints.push(`${m.lastname} → ${slackEmail}`);
        }
      } else if (hits.length > 1) {
        report.warn(`@mention ambiguous for ${m.lastname} (${hits.length} workspace matches) — set slack_user_id in the profile`);
      }
    }
  }

  const n = Object.keys(resolved).length;
  if (n) {
    report.ok(`@mentions resolved for ${n}/${roster.length} roster member(s) (cached in pipeline-state slack.user_ids)`);
    const { path: stateFile, state } = stateBundle;
    state.slack = state.slack || {};
    state.slack.user_ids = { ...(state.slack.user_ids || {}), ...resolved };
    writeState(stateFile, state);
  }
  const missing = roster.filter((m) => !resolved[m.lastname]).map((m) => m.lastname);
  if (missing.length) {
    report.warn(`unresolved: ${missing.join(', ')} — @mentions fall back to bold text; add email or slack_user_id to team/<Lastname>.md, then re-run`);
  }
  for (const hint of emailHints) {
    report.ok(`email found via Slack: ${hint} — add it as 'email:' to the profile (feeds Zoom attendance + internal_domains)`);
  }
}

async function resolveChannelId(token, nameOrId) {
  if (/^[CG][A-Z0-9]{6,}$/.test(nameOrId)) return nameOrId; // already an id
  const name = nameOrId.replace(/^#/, '');
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const res = await http(
      `https://slack.com/api/conversations.list?limit=200&types=public_channel,private_channel&exclude_archived=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!res.body || !res.body.ok) return { error: res.body && res.body.error };
    const hit = (res.body.channels || []).find((c) => c.name === name);
    if (hit) return hit.id;
    cursor = res.body.response_metadata && res.body.response_metadata.next_cursor;
    if (!cursor) break;
  }
  return null;
}

async function testSlack(report, tenant, stateBundle, opts) {
  const miss = missingEnv(['SLACK_BOT_TOKEN']);
  if (miss.length) { report.fail(`missing env: ${miss.join(', ')} (docs/slack-app-setup.md)`); return; }
  const token = process.env.SLACK_BOT_TOKEN.trim();

  // 1. auth.test
  let auth;
  try { auth = await slackApi('auth.test', token); }
  catch (e) { report.fail(`slack unreachable (${e.message})`); return; }
  if (!auth.body || !auth.body.ok) {
    report.fail(`auth.test failed (${(auth.body && auth.body.error) || `HTTP ${auth.status}`}) — re-copy the Bot User OAuth Token (xoxb-…)`);
    return;
  }
  report.ok(`auth.test ok — bot "${auth.body.user}" in workspace "${auth.body.team}"`);

  // 2. Granted scopes vs the shipped manifest.
  const granted = String(auth.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const wanted = manifestScopes();
  if (!wanted.length) report.warn('could not read the shipped manifest scopes — scope check skipped');
  else {
    const missing = wanted.filter((s) => !granted.includes(s));
    if (missing.length) {
      report.fail(`missing bot scopes: ${missing.join(', ')} — the app was probably not created from the shipped manifest; add them (OAuth & Permissions) and REINSTALL the app`);
    } else report.ok(`all ${wanted.length} manifest scopes granted`);
  }

  // 3. Roster -> Slack user ids (@mentions; cached in pipeline-state).
  await resolveRosterMentions(report, tenant, token, stateBundle);

  // 4. Resolve the digest channel name -> C… id, cache it in pipeline-state
  //    (deploy patches __BACKBRIEF_DIGEST_CHANNEL_ID__ from that cache).
  const chan = tenant && tenant.features && tenant.features.slack && tenant.features.slack.digest_channel;
  if (!chan) { report.warn('features.slack.digest_channel not set in tenant.yaml — set it, then re-run'); return; }
  let channelId;
  try { channelId = await resolveChannelId(token, String(chan)); }
  catch (e) { report.fail(`channel resolution failed (${e.message})`); return; }
  if (channelId && channelId.error) { report.fail(`conversations.list failed (${channelId.error}) — check channels:read / groups:read scopes`); return; }
  if (!channelId) {
    report.fail(`channel ${chan} not found — create it (or invite the bot for a private channel), then re-run`);
    return;
  }
  report.ok(`digest channel resolved: ${chan} -> ${channelId}`);
  const { path: stateFile, state } = stateBundle;
  state.slack = state.slack || {};
  state.slack.channels = state.slack.channels || {};
  state.slack.channels.digest = channelId;
  writeState(stateFile, state);

  // 5. Visible test post — THE B3 artifact.
  if (opts.noPost) { report.skip('test post skipped (--no-post)'); return; }
  if (DRY_RUN) { report.skip('[dry-run] test post skipped'); return; }
  const post = await slackApi('chat.postMessage', token, {
    channel: channelId,
    text: `:wave: Backbrief connected — this is the B3 verification post. Call digests will land here.`,
  });
  if (!post.body || !post.body.ok) {
    const err = (post.body && post.body.error) || `HTTP ${post.status}`;
    report.fail(`test post failed (${err})${err === 'not_in_channel' ? ` — /invite the bot into ${chan}` : ''}`);
    return;
  }
  report.ok(`test message posted to ${chan} — go look, that's the pipeline's voice`);
}

/* ------------------------------------------------------------------ */
/* github (B4)                                                         */
/* ------------------------------------------------------------------ */

// Minimal .gitignore matcher — just enough to prove one known path is
// excluded. Handles the common forms (`.backbrief/`, `/anchored`, `*`, `**`,
// `?`, trailing-slash directory patterns); no full git-spec ambitions.
function gitignorePatternCovers(pattern, relPath) {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  const src = p.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  let re;
  try { re = new RegExp(`^${src}$`); } catch (e) { return false; }
  const segs = relPath.split('/');
  if (!anchored) {
    // No slash: the pattern matches a file OR directory of that name at any
    // depth — test every path segment (a covered parent dir covers the file).
    const cands = dirOnly ? segs.slice(0, -1) : segs;
    return cands.some((s) => re.test(s));
  }
  // Anchored: match the full path or any parent-directory prefix of it.
  const prefixes = segs.map((_, i) => segs.slice(0, i + 1).join('/'));
  const cands = dirOnly ? prefixes.slice(0, -1) : prefixes;
  return cands.some((s) => re.test(s));
}

function gitignoreExcludes(text, relPath) {
  let covered = false;
  let winner = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (!gitignorePatternCovers(negated ? line.slice(1) : line, relPath)) continue;
    covered = !negated; // last matching pattern wins (git semantics)
    winner = line;
  }
  return { covered, winner };
}

async function testGithub(report, tenant, stateBundle) {
  const miss = missingEnv(['GITHUB_VAULT_PAT']);
  if (miss.length) { report.fail(`missing env: ${miss.join(', ')} (docs/github-setup.md)`); return; }
  const repo = tenant && tenant.vault && tenant.vault.repo;
  const branch = (tenant && tenant.vault && tenant.vault.branch) || 'main';
  if (!repo) { report.fail('tenant vault.repo is not set — B4 records "owner/repo" there first'); return; }
  const hdr = {
    Authorization: `Bearer ${process.env.GITHUB_VAULT_PAT.trim()}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'backbrief-test-creds',
  };

  // 1. Repo visibility + push permission (fine-grained PATs carry no
  //    x-oauth-scopes header — permissions.push on the repo object is the
  //    reliable signal for both PAT flavors).
  let r;
  try { r = await http(`https://api.github.com/repos/${repo}`, { headers: hdr }); }
  catch (e) { report.fail(`github unreachable (${e.message})`); return; }
  if (r.status === 401) { report.fail('PAT rejected (401) — regenerate it'); return; }
  if (r.status === 404) { report.fail(`repo ${repo} not visible to this PAT (404) — grant the PAT access to exactly this repo (contents: read/write)`); return; }
  if (r.status !== 200) { report.fail(`GET /repos/${repo} -> HTTP ${r.status}`); return; }
  report.ok(`repo visible: ${repo}${r.body.private ? ' (private)' : ' (PUBLIC — sure about that for call transcripts?)'}`);
  if (r.body.permissions && r.body.permissions.push === false) {
    report.fail('PAT has read-only access — the pipeline needs contents: read AND write');
  } else if (r.body.permissions && r.body.permissions.push === true) {
    report.ok('push permission confirmed (contents: write)');
  } else {
    report.warn('push permission not reported — will be proven by the B6 self-test commit');
  }

  // 2. Branch commits.
  const c = await http(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`, { headers: hdr });
  if (c.status === 200) report.ok(`branch ${branch} ok (HEAD ${String(c.body.sha || '').slice(0, 7)})`);
  else if (c.status === 409) report.warn(`repo is empty — push the Phase-A vault first (B4 step), then re-run`);
  else if (c.status === 404) report.fail(`branch ${branch} not found — push it, or fix vault.branch in tenant.yaml`);
  else report.fail(`GET commits/${branch} -> HTTP ${c.status}`);

  // 3. Dry Git-Data permission check (the atomic-commit path reads refs and
  //    trees before writing; prove the ref is readable through Git-Data).
  const ref = await http(`https://api.github.com/repos/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`, { headers: hdr });
  if (ref.status === 200) report.ok('Git-Data API readable (atomic-commit path clear)');
  else if (ref.status === 409 || ref.status === 404) report.warn('Git-Data ref not readable yet (empty repo/branch) — fine once the first push lands');
  else report.fail(`Git-Data ref read -> HTTP ${ref.status}`);

  // 4. The secrets file must never be committable: the vault's .gitignore has
  //    to exclude .backbrief/secrets.env (the docs/github-setup.md promise).
  const vaultDir = stateBundle && stateBundle.path ? path.dirname(path.dirname(stateBundle.path)) : null;
  if (!vaultDir) {
    report.warn('no tenant.yaml found — .gitignore check skipped');
  } else {
    const giPath = path.join(vaultDir, '.gitignore');
    if (!fs.existsSync(giPath)) {
      report.fail(`vault .gitignore missing (${giPath}) — create it with a ".backbrief/secrets.env" line; the secrets file must never be committable`);
    } else {
      const { covered, winner } = gitignoreExcludes(fs.readFileSync(giPath, 'utf8'), '.backbrief/secrets.env');
      if (covered) report.ok(`.gitignore excludes .backbrief/secrets.env (pattern: "${winner}")`);
      else report.fail('.gitignore does NOT exclude .backbrief/secrets.env — add a ".backbrief/secrets.env" (or ".backbrief/") line, then re-run');
    }
  }
}

/* ------------------------------------------------------------------ */
/* linear (B5)                                                         */
/* ------------------------------------------------------------------ */

async function linearGql(query, variables) {
  return http('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_TOKEN.trim(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
}

async function testLinear(report, tenant, stateBundle) {
  const miss = missingEnv(['LINEAR_API_TOKEN']);
  if (miss.length) { report.fail(`missing env: ${miss.join(', ')} (docs/linear-setup.md)`); return; }

  // 1. viewer
  let v;
  try { v = await linearGql('query { viewer { id name email } }'); }
  catch (e) { report.fail(`linear unreachable (${e.message})`); return; }
  if (v.status !== 200 || !v.body || !v.body.data || !v.body.data.viewer) {
    const err = v.body && v.body.errors ? v.body.errors.map((x) => x.message).join('; ') : `HTTP ${v.status}`;
    report.fail(`viewer query failed (${err}) — check LINEAR_API_TOKEN`);
    return;
  }
  report.ok(`authenticated as ${v.body.data.viewer.name}`);

  // 2. Resolve every tracker_team_key from the tenant mapping, plus each
  //    team's "Todo" workflow state — issueCreate needs a stateId, and the
  //    render contract (TEAM_MAP) wants { id, name, todo_state_id } per team.
  //    Pick: the unstarted-type state named "Todo"; workspaces that renamed
  //    it get the lowest-position unstarted state (the pick is reported).
  const tracker = (tenant && tenant.features && tenant.features.tracker) || {};
  const mapping = Array.isArray(tracker.team_mapping) ? tracker.team_mapping : [];
  const keys = [...new Set(mapping.map((m) => m && m.tracker_team_key).filter(Boolean))];
  const t = await linearGql('query { teams(first: 100) { nodes { id key name states { nodes { id name type position } } } } }');
  const teams = (t.body && t.body.data && t.body.data.teams && t.body.data.teams.nodes) || [];
  if (!teams.length) { report.fail('teams query returned nothing — token lacks read access'); return; }
  if (!keys.length) {
    report.warn(`tenant team_mapping is empty — workspace has: ${teams.map((x) => x.key).join(', ')} (B5 fills the mapping)`);
  }
  const resolved = {};
  let allResolved = true;
  for (const key of keys) {
    const hit = teams.find((x) => x.key === key);
    if (!hit) {
      allResolved = false;
      report.fail(`team key ${key} not found in this workspace (have: ${teams.map((x) => x.key).join(', ')})`);
      continue;
    }
    const unstarted = ((hit.states && hit.states.nodes) || [])
      .filter((s) => s && s.type === 'unstarted')
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    const todo = unstarted.find((s) => s.name === 'Todo') || unstarted[0] || null;
    resolved[key] = { id: hit.id, name: hit.name, todo_state_id: todo ? todo.id : null };
    if (todo) report.ok(`team ${key} -> "${hit.name}" (initial state: "${todo.name}")`);
    else report.warn(`team ${key} -> "${hit.name}" — no unstarted workflow state found; created issues will use the team's default state`);
  }

  // 3. One search query per mapped team (the dedup read path).
  for (const key of Object.keys(resolved)) {
    const s = await linearGql(
      'query($key: String!) { issues(first: 1, filter: { team: { key: { eq: $key } } }) { nodes { identifier } } }',
      { key });
    const nodes = s.body && s.body.data && s.body.data.issues && s.body.data.issues.nodes;
    if (Array.isArray(nodes)) report.ok(`search ok on ${key}${nodes[0] ? ` (latest: ${nodes[0].identifier})` : ' (no issues yet)'}`);
    else report.fail(`search failed on ${key} — token may be workspace-restricted`);
  }

  // 4. Provenance label — get-or-create by name -> tracker.label_id
  //    (LABEL_FROM_CALL_ID; stamped on every pipeline-created issue).
  const labelName = String(tracker.provenance_label || 'backbrief');
  let labelId = null;
  const lq = await linearGql(
    'query($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }) { nodes { id name } } }',
    { name: labelName });
  const labelNodes = lq.body && lq.body.data && lq.body.data.issueLabels && lq.body.data.issueLabels.nodes;
  if (!Array.isArray(labelNodes)) {
    report.warn('issueLabels query failed — provenance label unresolved (created issues will carry no label)');
  } else if (labelNodes.length) {
    labelId = labelNodes[0].id;
    report.ok(`provenance label "${labelName}" found -> ${labelId}`);
  } else if (DRY_RUN) {
    report.skip(`[dry-run] provenance label "${labelName}" missing — would create it (issueLabelCreate skipped)`);
  } else {
    const lc = await linearGql(
      'mutation($name: String!) { issueLabelCreate(input: { name: $name }) { issueLabel { id } } }',
      { name: labelName });
    const created = lc.body && lc.body.data && lc.body.data.issueLabelCreate && lc.body.data.issueLabelCreate.issueLabel;
    if (created && created.id) { labelId = created.id; report.ok(`provenance label "${labelName}" created -> ${labelId}`); }
    else report.warn('issueLabelCreate failed — created issues will carry no label; check the token\'s write access and re-run');
  }

  // 5. Workspace URL slug -> tracker.url_base (issue links in Slack digests).
  const org = await linearGql('query { organization { urlKey } }');
  const urlKey = org.body && org.body.data && org.body.data.organization && org.body.data.organization.urlKey;
  if (urlKey) report.ok(`workspace url: https://linear.app/${urlKey}`);
  else report.warn('organization urlKey query failed — issue links keep the placeholder url until re-run');

  // 6. Cache everything the deploy render reads (TEAM_MAP / TEAM_TO_ID /
  //    LABEL_FROM_CALL_ID / TRACKER_URL_BASE all come from these entries).
  {
    const { path: stateFile, state } = stateBundle;
    state.tracker = state.tracker || {};
    let dirty = false;
    if (allResolved && Object.keys(resolved).length) {
      state.tracker.teams = { ...(state.tracker.teams || {}), ...resolved };
      dirty = true;
    }
    if (labelId) { state.tracker.label_id = labelId; dirty = true; }
    if (urlKey) { state.tracker.url_base = `https://linear.app/${urlKey}`; dirty = true; }
    if (dirty) writeState(stateFile, state);
  }

  // 7. Roster -> Linear user ids (assignee resolution; email first, name
  //    fallback) — cached in pipeline-state tracker.users. Never fatal.
  const roster = (tenant && Array.isArray(tenant.roster) ? tenant.roster : [])
    .filter((m) => m && m.lastname);
  if (roster.length) {
    const u = await linearGql('query { users(first: 100) { nodes { id name displayName email active } } }');
    const nodes = u.body && u.body.data && u.body.data.users && u.body.data.users.nodes;
    if (!Array.isArray(nodes)) {
      report.warn('users query failed — assignee resolution skipped (tasks stay unassigned-by-id)');
    } else {
      const activeUsers = nodes.filter((x) => x && x.active !== false);
      const userIds = {};
      for (const m of roster) {
        const email = typeof m.email === 'string' && m.email.includes('@') ? m.email.toLowerCase() : null;
        let hit = email ? activeUsers.find((x) => String(x.email || '').toLowerCase() === email) : null;
        if (!hit) {
          const needles = [String(m.lastname), m.first_name ? `${m.first_name} ${m.lastname}` : null]
            .filter(Boolean).map((s) => s.toLowerCase()).filter((s) => s.length >= 3);
          const hits = activeUsers.filter((x) => {
            const cands = [x.name, x.displayName].filter(Boolean).map((s) => String(s).toLowerCase());
            return cands.some((c) => needles.some((n) => c.includes(n)));
          });
          if (hits.length === 1) hit = hits[0];
        }
        if (hit) userIds[m.lastname] = hit.id;
      }
      const nUsers = Object.keys(userIds).length;
      if (nUsers) {
        report.ok(`tracker users resolved for ${nUsers}/${roster.length} roster member(s) (cached in pipeline-state tracker.users)`);
        const { path: stateFile, state } = stateBundle;
        state.tracker = state.tracker || {};
        state.tracker.users = { ...(state.tracker.users || {}), ...userIds };
        writeState(stateFile, state);
      } else {
        report.warn('no roster members matched Linear users — add emails to profiles for exact matching');
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* anthropic (B6 pre-gate) — 03 §6.3                                   */
/* ------------------------------------------------------------------ */

const DOWNGRADES = {
  matcher: 'propose matcher downgrade to the summarizer model — WARNING: dedup precision drops; thresholds may need loosening',
  composer: 'propose composer upgrade to the summarizer model — cost note only',
};

function anthropicBody(cfg) {
  const body = {
    model: cfg.model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  };
  // The tenant's EXACT thinking/effort params (the prod 400-invalid-request
  // outage class hid for 3 weeks because probes were sent bare).
  if (cfg.thinking === 'adaptive') body.thinking = { type: 'adaptive' };
  if (cfg.effort) body.output_config = { effort: cfg.effort };
  return body;
}

async function testAnthropic(report, tenant) {
  const miss = missingEnv(['ANTHROPIC_API_KEY']);
  if (miss.length) { report.fail(`missing env: ${miss.join(', ')}`); return; }
  const llm = (tenant && tenant.llm) || {};
  const stages = Object.entries(llm).filter(([, cfg]) => cfg && cfg.model);
  if (!stages.length) { report.fail('tenant llm.* has no stage configs — generate-tenant.js fills the defaults'); return; }

  // Dedupe identical (model, thinking, effort) combinations.
  const combos = new Map();
  for (const [stage, cfg] of stages) {
    const key = JSON.stringify({ m: cfg.model, t: cfg.thinking || null, e: cfg.effort || null });
    if (!combos.has(key)) combos.set(key, { cfg, stages: [] });
    combos.get(key).stages.push(stage);
  }

  for (const { cfg, stages: names } of combos.values()) {
    const label = `${cfg.model}${cfg.thinking ? ` thinking=${cfg.thinking}` : ''}${cfg.effort ? ` effort=${cfg.effort}` : ''} (${names.join(', ')})`;
    let res;
    try {
      res = await http('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY.trim(),
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(anthropicBody(cfg)),
      });
    } catch (e) { report.fail(`${label}: unreachable (${e.message})`); continue; }

    if (res.status === 200) { report.ok(`${label}: 1-token probe ok`); continue; }
    const errType = res.body && res.body.error && res.body.error.type;
    const errMsg = res.body && res.body.error && res.body.error.message;
    if (res.status === 401) { report.fail(`${label}: 401 — bad ANTHROPIC_API_KEY`); continue; }
    if (res.status === 429) { report.warn(`${label}: 429 rate-limited — key VALID, plan is just busy`); continue; }
    if (res.status === 403 || res.status === 404) {
      report.fail(`${label}: HTTP ${res.status} (${errType || 'model unavailable'}) — this plan lacks the model`);
      for (const stage of names) if (DOWNGRADES[stage]) report.warn(`  downgrade path: ${DOWNGRADES[stage]} (write the accepted choice back to tenant.yaml llm.${stage})`);
      continue;
    }
    if (res.status === 400) {
      report.fail(`${label}: 400 invalid request — ${errMsg || 'params rejected'} — this is the silent-outage class; fix llm.* params (thinking/effort) BEFORE deploying`);
      continue;
    }
    report.fail(`${label}: HTTP ${res.status} (${errType || 'unexpected'})`);
  }
}

/* ------------------------------------------------------------------ */
/* all (B6 gate)                                                       */
/* ------------------------------------------------------------------ */

function applicable(tenant) {
  const f = (tenant && tenant.features) || {};
  const list = [];
  const zoomWired = ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']
    .some((n) => (process.env[n] || '').trim());
  list.push(zoomWired
    ? { name: 'zoom', run: true }
    : { name: 'zoom', run: false, why: 'no Zoom creds in env — auto-capture stays off (B2 skipped)' });
  list.push(f.slack && f.slack.enabled !== false
    ? { name: 'slack', run: true }
    : { name: 'slack', run: false, why: 'features.slack.enabled is false' });
  list.push(tenant && tenant.vault && tenant.vault.repo
    ? { name: 'github', run: true }
    : { name: 'github', run: false, why: 'vault.repo is null (local-only vault)' });
  const kind = f.tracker && f.tracker.enabled !== false ? (f.tracker && f.tracker.kind) : null;
  if (kind === 'linear') list.push({ name: 'linear', run: true });
  else list.push({ name: 'tracker', run: false, why: `tracker is ${kind || 'disabled'} — file-only tasks` });
  list.push({ name: 'anthropic', run: true }); // the pipeline always needs it
  return list;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function runService(name, tenant, stateBundle, opts) {
  console.log(`\n== test-creds: ${name}`);
  const report = new Report(name);
  if (name === 'zoom') await testZoom(report);
  else if (name === 'slack') await testSlack(report, tenant, stateBundle, opts);
  else if (name === 'github') await testGithub(report, tenant, stateBundle);
  else if (name === 'linear') await testLinear(report, tenant, stateBundle);
  else if (name === 'anthropic') await testAnthropic(report, tenant);
  return report;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.service) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 2);
  }
  if (!SERVICES.includes(opts.service)) {
    console.error(`unknown service "${opts.service}" — one of: ${SERVICES.join(', ')}`);
    process.exit(2);
  }

  const tenantPath = findTenantFile(opts.tenant);
  let tenant = null;
  if (tenantPath && fs.existsSync(tenantPath)) {
    loadSecretsEnv(tenantPath);
    try { tenant = RENDER.loadTenant(tenantPath); }
    catch (e) { console.error(`⚠ tenant.yaml unreadable (${e.message}) — probes that need tenant config will fail`); }
  } else {
    console.error('⚠ no tenant.yaml found — probes that need tenant config (slack channel, repo, teams, llm) will fail');
  }
  const stateBundle = tenantPath ? readState(tenantPath) : { path: null, state: {} };

  const reports = [];
  if (opts.service === 'all') {
    for (const item of applicable(tenant)) {
      if (!item.run) {
        console.log(`\n== test-creds: ${item.name}`);
        console.log(`  ⏭  skipped — ${item.why}`);
        reports.push({ service: item.name, skipped: true, why: item.why, failed: false, lines: [] });
        continue;
      }
      reports.push(await runService(item.name, tenant, stateBundle, opts));
    }
  } else {
    reports.push(await runService(opts.service, tenant, stateBundle, opts));
  }

  const failed = reports.some((r) => r.failed);
  console.log(`\n${failed ? '✖ one or more probes FAILED — fix and re-run' : '✅ all probes green'}`);
  if (opts.json) {
    console.log(JSON.stringify(reports.map((r) => ({
      service: r.service, failed: !!r.failed, skipped: !!r.skipped, why: r.why, lines: r.lines,
    })), null, 2));
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
