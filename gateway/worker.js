// SPDX-License-Identifier: MIT
/*
 * Backbrief telemetry gateway — Cloudflare Worker.
 *
 * Endpoints (versioned path prefix, contract in ../gateway/README.md):
 *   POST /v1/events    — step events + counters (closed allowlist, no free text)
 *   GET  /v1/version   — latest kit version (cacheable, 1 h)
 *   POST /v1/waitlist  — demand capture; the ONLY endpoint that stores an email
 *   GET  /waitlist     — self-contained HTML signup page (unversioned; a
 *                        browser front-end that POSTs to /v1/waitlist, for the
 *                        no-terminal persona who cannot run the kit CLI)
 *
 * Bindings:
 *   TELEMETRY        — KV namespace (counters, install liveness, waitlist rows)
 *   WAITLIST_WEBHOOK — optional secret: a webhook URL notified on new waitlist
 *                      rows (payload carries interest/tool/step — never the email)
 *
 * Privacy, enforced structurally:
 *   - The events endpoint accepts a closed enum vocabulary + integers only.
 *     There is no free-text field on /v1/events at all; the only quasi-free
 *     field in the whole API is waitlist.tool / connector_demand props.tool,
 *     capped at 32 chars and slug-normalized server-side.
 *   - No IP persistence (this worker never reads request IP headers), no user
 *     agent, no email except the explicit waitlist form.
 *   - install_id is a client-generated random UUIDv4 — anonymous by design.
 *
 * This file is published in-repo as the trust proof: the code that receives
 * your telemetry is right here, and it cannot accept content.
 */

/* ------------------------------------------------------------------ */
/* Release pointer — edit on every release, or move to KV             */
/* once that becomes annoying.                                         */
/* ------------------------------------------------------------------ */

const LATEST = {
  latest: '0.1.0',
  min_supported: '0.1.0',
  notes_url: 'https://github.com/EvgenSmith/backbrief/releases',
  update_hint: 'claude plugin update backbrief  |  git pull',
};

/* ------------------------------------------------------------------ */
/* Wire contract — keep in sync with the client-side copy in          */
/* plugin/scripts/telemetry.js (both sides enforce the same allowlist).*/
/* ------------------------------------------------------------------ */

const EVENTS = ['install', 'step_started', 'step_completed', 'step_skipped',
  'calls_processed', 'tasks_verdict', 'connector_demand', 'status_run', 'error'];
const STEP_EVENTS = ['step_started', 'step_completed', 'step_skipped'];
const STEPS = ['A0', 'A1', 'A2', 'A3', 'A4',
  'B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B5.5', 'B6', 'B7', 'B8'];
// 'B5.5' — the required Anthropic API key rung between B5 and B6 (deploy.md
// "Step B5.5"); a literal step id, kept in sync with telemetry.js.
// 'privacy' — demand signal for privacy routing (1:1/board/legal auto-routing
// into private slices), removed from v0.1 pre-release; validate-tenant.js
// --migrate points owners of legacy configs here.
const INTERESTS = ['hosted', 'hands_on', 'connector', 'updates', 'privacy'];

// Closed enum of failure classes for the `error` event (props.error_class).
const ERROR_CLASSES = ['creds_zoom', 'creds_slack', 'creds_github', 'creds_linear',
  'creds_jira', 'creds_anthropic', 'env_check', 'tenant_validate', 'vault_validate',
  'normalize_transcript', 'deploy_put', 'webhook_selftest', 'history_import',
  'dlq_redrive', 'update_check', 'network', 'unknown'];

// props carried by step_started / step_completed / step_skipped (01 §9 rows).
const STEP_PROPS = ['count', 'team_size_bucket', 'stack_path', 'source',
  'fork', 'hosting', 'tracker', 'persona'];

// Per-event props allowlist. Unknown key => 400 naming the key.
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

// Per-prop value validation: enums + bounded integers only.
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

const TOP_KEYS = ['install_id', 'kit_version', 'event', 'step', 'props', 'ts'];
const WAITLIST_KEYS = ['email', 'interest', 'tool', 'source_step', 'install_id'];

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const RATE_LIMIT_PER_HOUR = 120; // per install_id
const MAX_COUNT = 100000;

const TTL_INSTALL = 60 * 60 * 24 * 180; // liveness rows: 180 d
const TTL_COUNTER = 60 * 60 * 24 * 400; // daily counters: 400 d
const TTL_RATE = 60 * 60 * 2;           // rate-limit buckets: 2 h

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/v1/version') return version(url, env, ctx);
    if (req.method === 'POST' && url.pathname === '/v1/events') return events(req, env);
    if (req.method === 'POST' && url.pathname === '/v1/waitlist') return waitlist(req, env, ctx);
    if (req.method === 'GET' && url.pathname === '/waitlist') return waitlistPage();
    return json({ error: 'not found' }, 404);
  },
};

/* ------------------------------------------------------------------ */
/* GET /v1/version                                                     */
/* ------------------------------------------------------------------ */

function version(url, env, ctx) {
  // `current` is optional and used ONLY for aggregate version-distribution
  // counting — never linked to an install.
  const current = url.searchParams.get('current');
  if (current && SEMVER_RE.test(current) && env.TELEMETRY) {
    const day = today();
    waitable(ctx, bump(env, `v:${day}:${current}`, 1, TTL_COUNTER));
  }
  return json(LATEST, 200, 3600);
}

/* ------------------------------------------------------------------ */
/* POST /v1/events                                                     */
/* ------------------------------------------------------------------ */

async function events(req, env) {
  const b = await req.json().catch(() => null);
  const bad = validateEvent(b); // closed allowlist; unknown key => reject
  if (bad) return json({ error: bad }, 400);

  // Rate limit: 120/h per install_id. KV read-modify-write is approximate —
  // acceptable: it bounds abuse, it is not billing.
  const hour = new Date().toISOString().slice(0, 13);
  const rlKey = `rl:${hour}:${b.install_id}`;
  const used = parseInt((await env.TELEMETRY.get(rlKey)) || '0', 10);
  if (used >= RATE_LIMIT_PER_HOUR) return json({ error: 'rate_limited' }, 429);
  await env.TELEMETRY.put(rlKey, String(used + 1), { expirationTtl: TTL_RATE });

  const day = today();

  // 1) install liveness (funnel numerator/denominator) — no IP, no UA stored.
  await env.TELEMETRY.put(
    `i:${b.install_id}`,
    JSON.stringify({ v: b.kit_version, last: day }),
    { expirationTtl: TTL_INSTALL },
  );

  // 2) daily counter per (event, step) — connector_demand folds props.tool
  //    (slug) into the counter key so demand ranks per tool. KV RMW is fine at
  //    this volume; move to Durable Object / D1 only if launch traffic ever
  //    makes lost increments visible.
  const dim = b.event === 'connector_demand'
    ? (slug(b.props && b.props.tool) || '-')
    : (b.step || '-');
  const inc = (b.props && Number.isInteger(b.props.count)) ? b.props.count : 1;
  await bump(env, `c:${day}:${b.event}:${dim}`, inc, TTL_COUNTER);

  return new Response(null, { status: 204 });
}

function validateEvent(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object';
  for (const k of Object.keys(b)) {
    if (!TOP_KEYS.includes(k)) return `unknown key "${k}"`;
  }
  if (typeof b.install_id !== 'string' || !UUID_V4_RE.test(b.install_id)) {
    return 'install_id: required, UUIDv4';
  }
  if (typeof b.kit_version !== 'string' || !SEMVER_RE.test(b.kit_version)) {
    return 'kit_version: required, semver';
  }
  if (!EVENTS.includes(b.event)) return `event: must be one of ${EVENTS.join('|')}`;
  if (STEP_EVENTS.includes(b.event) && !STEPS.includes(b.step)) {
    return `step: required for ${b.event}, one of ${STEPS.join('|')}`;
  }
  if (b.step !== undefined && !STEPS.includes(b.step)) {
    return `step: must be one of ${STEPS.join('|')}`;
  }
  if (b.ts !== undefined && (typeof b.ts !== 'string' || Number.isNaN(Date.parse(b.ts)))) {
    return 'ts: must be an ISO 8601 timestamp';
  }
  if (b.props !== undefined) {
    if (!b.props || typeof b.props !== 'object' || Array.isArray(b.props)) {
      return 'props: must be an object';
    }
    const allowed = PROPS_BY_EVENT[b.event];
    for (const [k, v] of Object.entries(b.props)) {
      if (!allowed.includes(k)) return `props.${k}: not allowed for event "${b.event}"`;
      const bad = validateProp(k, v);
      if (bad) return bad;
    }
  }
  return null;
}

function validateProp(key, value) {
  if (key === 'count') {
    if (!Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
      return `props.count: must be an integer 0..${MAX_COUNT}`;
    }
    return null;
  }
  if (key === 'tool') {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
      return 'props.tool: must be a string of 1..64 chars (slugged to 32 server-side)';
    }
    return null;
  }
  const allowed = ENUM_PROPS[key];
  if (!allowed.includes(value)) {
    return `props.${key}: must be one of ${allowed.join('|')}`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* POST /v1/waitlist — the only endpoint that stores an email, and     */
/* only because the user typed it in to be contacted.                 */
/* ------------------------------------------------------------------ */

async function waitlist(req, env, ctx) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return json({ error: 'body must be a JSON object' }, 400);
  }
  for (const k of Object.keys(b)) {
    if (!WAITLIST_KEYS.includes(k)) return json({ error: `unknown key "${k}"` }, 400);
  }
  if (typeof b.email !== 'string' || !EMAIL_RE.test(b.email) || b.email.length > 254) {
    return json({ error: 'email: required, must be a valid address' }, 400);
  }
  if (!INTERESTS.includes(b.interest)) {
    return json({ error: `interest: must be one of ${INTERESTS.join('|')}` }, 400);
  }
  if (b.source_step !== undefined && !STEPS.includes(b.source_step)) {
    return json({ error: `source_step: must be one of ${STEPS.join('|')}` }, 400);
  }
  if (b.install_id !== undefined
      && (typeof b.install_id !== 'string' || !UUID_V4_RE.test(b.install_id))) {
    return json({ error: 'install_id: must be a UUIDv4 when present' }, 400);
  }
  if (b.tool !== undefined && (typeof b.tool !== 'string' || b.tool.length > 64)) {
    return json({ error: 'tool: must be a string of at most 64 chars' }, 400);
  }

  const tool = slug(b.tool);
  const id = `w:${b.email.toLowerCase()}:${b.interest}`;
  if (await env.TELEMETRY.get(id)) return json({ ok: true, dup: true }, 409);
  await env.TELEMETRY.put(id, JSON.stringify({
    tool: tool || null,
    step: b.source_step || null,
    install: b.install_id || null,
    ts: Date.now(),
  }));
  // Optional operator notify — fire-and-forget, NEVER carries the email.
  if (env.WAITLIST_WEBHOOK) {
    waitable(ctx, fetch(env.WAITLIST_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `waitlist: ${b.interest}${tool ? ` ${tool}` : ''} @ ${b.source_step || '-'}`,
      }),
    }).catch(() => {}));
  }
  return json({ ok: true }, 201);
}

/* ------------------------------------------------------------------ */
/* GET /waitlist — a minimal, self-contained browser signup page.      */
/* For the no-terminal persona (chat-only / non-technical) who cannot  */
/* run the kit's `telemetry.js waitlist` CLI. No external deps: inline  */
/* HTML/CSS/JS, same-origin fetch() POST to /v1/waitlist (the API the   */
/* CLI also uses). Stores nothing here — the POST handler is the only   */
/* thing that writes. (waitlist browser form + JSON API.)             */
/* ------------------------------------------------------------------ */

function waitlistPage() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Backbrief — join the waitlist</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #f6f7f9; color: #16181d; padding: 24px;
  }
  .card {
    width: 100%; max-width: 26rem; background: #fff; border: 1px solid #e3e6ea;
    border-radius: 14px; padding: 28px 26px; box-shadow: 0 1px 3px rgba(0,0,0,.06);
  }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 1.25rem; color: #5b6270; font-size: .95rem; }
  label { display: block; font-weight: 600; font-size: .9rem; margin: 0 0 .35rem; }
  input, select {
    width: 100%; padding: .6rem .7rem; font: inherit; color: inherit;
    background: #fff; border: 1px solid #ccd2da; border-radius: 9px; margin: 0 0 1rem;
  }
  input:focus, select:focus { outline: 2px solid #3b82f6; outline-offset: 1px; }
  button {
    width: 100%; padding: .7rem; font: inherit; font-weight: 600; cursor: pointer;
    color: #fff; background: #2563eb; border: 0; border-radius: 9px;
  }
  button:hover { background: #1d4ed8; }
  button:disabled { opacity: .6; cursor: default; }
  #tool-field { display: none; }
  #msg { margin: 1rem 0 0; font-size: .92rem; min-height: 1.2em; }
  #msg.ok { color: #15803d; }
  #msg.err { color: #b91c1c; }
  .foot { margin: 1.25rem 0 0; font-size: .8rem; color: #7a828f; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e7e9ee; }
    .card { background: #171a21; border-color: #262b34; box-shadow: none; }
    p.sub { color: #9aa2b1; }
    input, select { background: #0f1115; border-color: #333a45; color: #e7e9ee; }
    .foot { color: #7a828f; }
    #msg.ok { color: #4ade80; }
    #msg.err { color: #f87171; }
  }
</style>
</head>
<body>
  <main class="card">
    <h1>Join the Backbrief waitlist</h1>
    <p class="sub">No install needed — leave an email and we will reach out.</p>
    <form id="f" novalidate>
      <label for="interest">I am interested in</label>
      <select id="interest" name="interest">
        <option value="hosted">A hosted version (nothing to run yourself)</option>
        <option value="hands_on">Hands-on help setting it up</option>
        <option value="connector">A connector for a tool I use</option>
        <option value="privacy">Privacy routing (sensitive calls)</option>
        <option value="updates">Product updates</option>
      </select>
      <div id="tool-field">
        <label for="tool">Which tool?</label>
        <input id="tool" name="tool" type="text" placeholder="e.g. asana" maxlength="64" autocomplete="off">
      </div>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" placeholder="you@company.com" autocomplete="email" required>
      <button id="submit" type="submit">Join the waitlist</button>
      <p id="msg" role="status" aria-live="polite"></p>
    </form>
    <p class="foot">We store your email and interest only — no tracking, no third parties.</p>
  </main>
<script>
  var interest = document.getElementById('interest');
  var toolField = document.getElementById('tool-field');
  var msg = document.getElementById('msg');
  var btn = document.getElementById('submit');
  function syncTool() { toolField.style.display = interest.value === 'connector' ? 'block' : 'none'; }
  interest.addEventListener('change', syncTool); syncTool();
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    msg.className = ''; msg.textContent = '';
    var email = document.getElementById('email').value.trim();
    if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) {
      msg.className = 'err'; msg.textContent = 'Please enter a valid email address.'; return;
    }
    var body = { email: email, interest: interest.value };
    if (interest.value === 'connector') {
      var tool = document.getElementById('tool').value.trim();
      if (tool) body.tool = tool;
    }
    btn.disabled = true;
    fetch('/v1/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 201) { msg.className = 'ok'; msg.textContent = 'You are on the list — thank you!'; return; }
      if (r.status === 409) { msg.className = 'ok'; msg.textContent = 'You are already on the list — thank you!'; return; }
      msg.className = 'err'; msg.textContent = 'Something went wrong. Please try again in a minute.';
      btn.disabled = false;
    }).catch(function () {
      msg.className = 'err'; msg.textContent = 'Could not reach the service. Please try again in a minute.';
      btn.disabled = false;
    });
  });
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function today() {
  return new Date().toISOString().slice(0, 10);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
}

async function bump(env, key, inc, ttl) {
  const cur = parseInt((await env.TELEMETRY.get(key)) || '0', 10);
  await env.TELEMETRY.put(key, String(cur + inc), { expirationTtl: ttl });
}

// Run a promise past the response when the runtime allows it (ctx.waitUntil);
// fall back to detached execution in test harnesses.
function waitable(ctx, promise) {
  const p = Promise.resolve(promise).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

function json(obj, status, cacheSeconds) {
  const headers = { 'content-type': 'application/json' };
  if (cacheSeconds) headers['cache-control'] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(obj), { status, headers });
}
