// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — runs once per execution (Run Once for All Items mode).
// Verifies Zoom webhook signature per https://developers.zoom.us/docs/api/rest/webhook-reference/
// Throws on mismatch — n8n marks the execution failed, Zoom retries per its policy.
//
// Secret: injected at deploy time by deploy-pipeline.js (INJECT_SECRETS —
// n8n cloud plans expose no $env to users, so the node reads an injected
// const; the repo keeps the placeholder). Value = the "Secret Token" from
// Zoom App → Feature → Event Subscriptions, stored in .backbrief/secrets.env.
const ZOOM_WEBHOOK_SECRET_TOKEN = '__ZOOM_WEBHOOK_SECRET_TOKEN__';

// ── __TENANT_KNOBS_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const MIN_DURATION_MIN = 5;
const REPLAY_WINDOW_SEC = 900;
const TRANSCRIPT_CHAR_CAP = 60000;
const NORMALIZER_EXCERPT_CAP = 40000;
const TTL_LISTING_MS = 1 * 60 * 60 * 1000;
const TTL_FILE_MS = 12 * 60 * 60 * 1000;
// ── __TENANT_KNOBS_END__ ──

const crypto = require('crypto');

const headers = $input.first().json.headers || {};
const body    = $input.first().json.body    || {};

const timestamp = headers['x-zm-request-timestamp'];
const signature = headers['x-zm-signature'];
const secret    = ZOOM_WEBHOOK_SECRET_TOKEN.startsWith('__') ? '' : ZOOM_WEBHOOK_SECRET_TOKEN;

if (!secret) {
  throw new Error('ZOOM_WEBHOOK_SECRET_TOKEN not injected — run deploy-pipeline.js (INJECT_SECRETS)');
}
if (!timestamp || !signature) {
  throw new Error('Zoom webhook headers missing (x-zm-request-timestamp / x-zm-signature)');
}

// V1.7.7 (2026-06-09): replay protection. Zoom signs `v0:<timestamp>:<body>`
// but does NOT reject stale-but-valid signatures itself, so without this
// check a captured webhook can be replayed any time. The 15-minute window is
// generous against clock skew + normal network retry, narrow enough to
// block long-term replay (HMAC still gates forgery, so a wide window is low-risk).
// REPLAY_WINDOW_SEC comes from the TENANT_KNOBS region above
// (pipeline.knobs.replay_window_sec). The 900s default is prod-proven:
// a 300s window rejected every webhook on clock-skewed hosts → outage.
const tsNum = Number(timestamp);
if (!Number.isFinite(tsNum)) {
  throw new Error(`Zoom webhook timestamp not numeric: "${timestamp}"`);
}
const ageSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
if (ageSec > REPLAY_WINDOW_SEC) {
  throw new Error(
    `Zoom webhook timestamp stale or skewed: age=${ageSec}s > ${REPLAY_WINDOW_SEC}s window. ` +
    `ts=${timestamp} now=${Math.floor(Date.now()/1000)}. ` +
    `Either replay attack OR Zoom retry beyond window OR clock skew on n8n host.`
  );
}

// Zoom URL-validation handshake — event === "endpoint.url_validation"
if (body.event === 'endpoint.url_validation') {
  const plainToken     = body.payload.plainToken;
  const encryptedToken = crypto
    .createHmac('sha256', secret)
    .update(plainToken)
    .digest('hex');
  return [{ json: { plainToken, encryptedToken, __validation: true } }];
}

const message  = `v0:${timestamp}:${JSON.stringify(body)}`;
const expected = 'v0=' + crypto.createHmac('sha256', secret).update(message).digest('hex');

if (expected !== signature) {
  throw new Error(`Zoom signature mismatch. expected=${expected.slice(0, 16)}… got=${String(signature).slice(0, 16)}…`);
}

return [{ json: { ...body, __validated: true } }];
