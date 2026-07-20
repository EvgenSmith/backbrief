// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 5 (full) — save pending decisions to staticData after Slack
// preview is posted. Indexed by message ts so Stage 6 Executor can look up by
// payload.message.ts when interactivity webhook fires.
//
// Also persists per-task fingerprint for cross-call dedup (was done earlier in
// matcher-decide; re-confirm here after preview to keep TTL fresh).
//
// V0.1 (2026-05-28): Phase 2 initial.

const STATE_TTL_DAYS = 14;

const data = $getWorkflowStaticData('global');
data.taskcrafter_pending = data.taskcrafter_pending || {};

// TTL cleanup on every call
const cutoff = Date.now() - STATE_TTL_DAYS * 24 * 3600 * 1000;
let purged = 0;
for (const [ts, entry] of Object.entries(data.taskcrafter_pending)) {
  const saved = entry?.saved_at ? Date.parse(entry.saved_at) : 0;
  if (saved && saved < cutoff) {
    delete data.taskcrafter_pending[ts];
    purged++;
  }
}
if (purged > 0) console.log(`[save-state] purged ${purged} stale pending entries`);

const items = $input.all();
const out = [];

for (const it of items) {
  const j = it.json || {};
  const slack_resp = j.message || j;  // Slack send response has { ok, channel, ts, message: {...} }
  const message_ts = j.ts || j.message?.ts || slack_resp?.ts;
  const channel    = j.channel || j.message?.channel || slack_resp?.channel;

  // Reach back to preview builder for normalizer_output (Slack node output replaces $json)
  let upstream;
  try { upstream = $('Build Slack BlockKit').first().json; } catch (e) { upstream = null; }
  const no = upstream?.normalizer_output;

  if (!message_ts || !no) {
    console.warn(`[save-state] missing message_ts or normalizer_output. ts=${message_ts} no=${!!no}`);
    out.push({ json: { ...j, __taskcrafter_error: 'save_state_missing_context' } });
    continue;
  }

  // Compact task records — only what executor needs
  // V1.2: also persist router_payload_create_alt — without it,
  // 11-parse-slack-action cannot swap the payload when "Create new instead"
  // is clicked on a FLAG → the tracker receives a COMMENT-shaped payload with
  // no teamId → BAD_USER_INPUT. Production-observed on a planning call.
  const compact_tasks = (no.tasks || []).map(t => ({
    id: t.id,
    matcher_decision: t.matcher_decision,
    title: t.title,
    router_payload: t.router_payload,
    router_payload_create_alt: t.router_payload_create_alt || null,
    // Composer outputs land in router_payload.title / description_markdown / comment_markdown
    fingerprint: ((t.title || '').toLowerCase().replace(/\s+/g, ' ').trim() + '|' + (t.owner_lastname || '__none__').toLowerCase()),
  }));

  data.taskcrafter_pending[message_ts] = {
    channel,
    message_ts,
    thread_ts: upstream?.slack_root_ts || null,
    call_uuid: upstream?.zoom_meeting_uuid || null,
    topic: upstream?.topic || '',
    saved_at: new Date().toISOString(),
    tasks: compact_tasks,
    executed: {},  // task_id → { outcome: 'created' | 'commented' | 'skipped' | 'failed', linear_id, linear_url, by_user, at }
  };

  console.log(`[save-state] saved pending for ts=${message_ts} (${compact_tasks.length} tasks, call=${upstream?.zoom_meeting_uuid?.slice(0, 20)})`);

  out.push({
    json: {
      ...j,
      __taskcrafter_stage: 'pending-saved',
      pending_message_ts: message_ts,
      pending_task_count: compact_tasks.length,
    },
  });
}

return out;
