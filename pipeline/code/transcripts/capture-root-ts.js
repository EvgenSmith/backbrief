// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — runs right after "Slack root post" (Phase 2 oneshot) OR
// "Slack root post (Phase 1)".
//
// V1.7.5 (2026-06-09): merged with capture-root-ts-phase1.js — auto-detects
// upstream context source. Used to be two near-identical files differing only
// in which named node to reach back to.
//
// Merges the Slack message timestamp back onto the upstream passthrough so
// downstream nodes (GitHub PUT, Build thread reply, state save) have one
// coherent $json without scattered $() cross-refs.
//
// n8n-nodes-base.slack v2.2 response shape: { ok: true, channel: "C…",
// ts: "1747...", message: {...} } — we read `ts` (the canonical thread root).

// ── __TENANT_SLACK_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const SLACK_ENABLED = true; // features.slack.enabled — false ⇒ builders post nothing
const OWNER_SLACK_USER_ID = ''; // deploy-resolved (test-creds.js slack)
const PUBLIC_CHANNEL_ID = '#call-digests'; // digest channel — name until deploy resolves the id
const DISPLAY_TIMEZONE = 'America/New_York';
// ── __TENANT_SLACK_END__ ──

const slackResp = $input.first().json;

// Auto-detect upstream context, in order:
//   1. Mark created — V1.8 (P0-3): in commit-first oneshot the root post now
//      runs AFTER the GitHub commit, so the richest item (full payload +
//      github_statusCode/github_url + __branch) comes from Mark created.
//      Build thread reply downstream needs __branch — without this preference
//      the created-branch context would be lost at the Slack boundary.
//   2. Build commit payload — pre-V1.8 oneshot fallback (kept for safety).
//   3. Recording state lookup — Phase 1 (no transcript yet).
let upstream = {};
try {
  const u = $('Mark created').first();
  if (u && u.json) upstream = u.json;
} catch (e) { /* phase 1 or error path — Mark created didn't run */ }
if (!upstream || Object.keys(upstream).length === 0) {
  try {
    const u = $('Build commit payload').first();
    if (u && u.json) upstream = u.json;
  } catch (e) { /* phase 1 — Build commit payload didn't run */ }
}
if (!upstream || Object.keys(upstream).length === 0) {
  try {
    const u = $('Recording state lookup').first();
    if (u && u.json) upstream = u.json;
  } catch (e) { /* */ }
}

const ts = slackResp.ts || slackResp.message?.ts;
if (!ts) {
  throw new Error(`Slack root post returned no ts. response=${JSON.stringify(slackResp).slice(0, 400)}`);
}

return [{
  json: {
    ...upstream,
    slack_root_ts     : ts,
    slack_root_channel: slackResp.channel || upstream.channel || PUBLIC_CHANNEL_ID,
  },
}];
