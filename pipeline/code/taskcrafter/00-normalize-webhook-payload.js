// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter sub-workflow — normalize webhook payload.
//
// Webhook trigger emits {headers, body, query, ...}. Main pipeline POSTs JSON
// containing zoom_meeting_uuid, topic, action_items, classification, etc.
// This node flattens body.* fields to top-level so downstream Stages 1-5 work
// without code changes.
//
// If item arrives WITHOUT body wrapper (e.g. direct test invocation via test
// fixture), pass through unchanged.
//
// V0.1 (2026-05-28): initial — for taskcrafter sub-workflow production wiring.

const items = $input.all();
const out = [];

for (const it of items) {
  const j = it.json || {};
  const b = j.body && typeof j.body === 'object' ? j.body : null;

  // If already flat (test/fixture mode), pass through
  if (!b || !b.zoom_meeting_uuid) {
    if (j.zoom_meeting_uuid) {
      out.push({ json: j });
      continue;
    }
    // Empty / malformed payload
    out.push({ json: { ...j, __taskcrafter_error: 'webhook_no_payload' } });
    continue;
  }

  // Flatten body fields to top-level
  out.push({
    json: {
      zoom_meeting_uuid:      b.zoom_meeting_uuid,
      topic:                  b.topic || '',
      start_time:             b.start_time || '',
      duration_min:           b.duration_min || null,
      participants_lastnames: b.participants_lastnames || [],
      classification:         b.classification || {},
      action_items:           b.action_items || [],
      transcript_excerpts:    b.transcript_excerpts || '',
      slack_channel_id:       b.slack_channel_id || null,
      slack_root_ts:          b.slack_root_ts || null,
      vault_url:              b.vault_url || null,
      vault_link:             b.vault_link || b.vault_url || null,
      __taskcrafter_received_at: new Date().toISOString(),
    },
  });
}

return out;
