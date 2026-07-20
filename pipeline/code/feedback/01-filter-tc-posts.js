// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — "Filter TC posts needing feedback" (feedback collector, stage 1).
// Mode: Run Once for All Items.
//
// First extraction of the production feedback collector to repo files
// (it never got the code-to-repo treatment in prod; this is
// the "Rewritten: extract, then parameterize" pass). Scans the digest channel
// history for TaskCrafter proposal posts that:
//  - live in a call thread (have a thread_ts pointing at a root post),
//  - carry the TaskCrafter fallback-text signature,
//  - are not yet processed (no PROCESSED_REACTION on the message),
//  - are older than FEEDBACK_MIN_AGE_H (give humans time to reply) but
//    younger than FEEDBACK_MAX_AGE_H (match the history window of the
//    upstream HTTP node).
//
// Emits one item per candidate, with thread_ts (the call root post) for the
// replies fetch downstream.
//
// The channel queried by the upstream "Slack conversations.history" HTTP node
// is patched at deploy time (__BACKBRIEF_DIGEST_CHANNEL_ID__ param token);
// this node stamps the same resolved channel onto every emitted item.

// ── __TENANT_SLACK_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const SLACK_ENABLED = true; // features.slack.enabled — false ⇒ builders post nothing
const OWNER_SLACK_USER_ID = ''; // deploy-resolved (test-creds.js slack)
const PUBLIC_CHANNEL_ID = '#call-digests'; // digest channel — name until deploy resolves the id
const DISPLAY_TIMEZONE = 'America/New_York';
// ── __TENANT_SLACK_END__ ──

// Signature match: conversations.history returns the message *fallback text*
// for Block Kit posts, so we match the ui_strings 'tasks.fallback_text' shape
// ("Backbrief · tasks — {count} proposals (…)") emitted by
// 09b-build-slack-blockkit. The legacy pre-rename signature is kept so posts
// made before an upgrade still collect feedback within the window.
const TC_SIGNATURES = ['Backbrief · tasks —', 'TaskCrafter —'];
const PROCESSED_REACTION = 'bar_chart';
// Tunable constants (knob candidates: pipeline.knobs.feedback_min_age_h /
// feedback_max_age_h — the TENANT_KNOBS renderer does not emit them yet, so
// the prod-proven defaults stay in code — window/cadence may become knobs later).
const FEEDBACK_MIN_AGE_H = 2;
const FEEDBACK_MAX_AGE_H = 72;

const MIN_AGE_SEC = FEEDBACK_MIN_AGE_H * 3600;
const MAX_AGE_SEC = FEEDBACK_MAX_AGE_H * 3600;
const NOW_SEC = Math.floor(Date.now() / 1000);

const items = $input.all();
const out = [];
for (const it of items) {
  const resp = it.json || {};
  if (!resp.ok) {
    console.warn('[fb-collector] history call failed:', resp.error);
    continue;
  }
  const messages = resp.messages || [];
  for (const m of messages) {
    const txt = m.text || '';
    if (!TC_SIGNATURES.some((sig) => txt.includes(sig))) continue;
    if (!m.thread_ts || m.thread_ts === m.ts) continue;  // must be in a thread
    const age = NOW_SEC - parseFloat(m.ts);
    if (age < MIN_AGE_SEC || age > MAX_AGE_SEC) continue;
    const reactions = m.reactions || [];
    const already_processed = reactions.some(r => r.name === PROCESSED_REACTION);
    if (already_processed) continue;
    out.push({ json: {
      tc_message_ts:   m.ts,
      tc_message_text: txt,
      thread_ts:       m.thread_ts,
      channel:         PUBLIC_CHANNEL_ID,
    }});
  }
}
console.log(`[fb-collector] ${out.length} candidate TaskCrafter posts to process`);
return out;
