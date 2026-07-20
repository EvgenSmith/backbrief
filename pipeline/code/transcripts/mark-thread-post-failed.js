// SPDX-License-Identifier: BUSL-1.1
// Mark thread post failed. V1.8 (P0-3, 2026-07-02).
//
// Wired to the ERROR output of "Slack thread reply" (onError=
// continueErrorOutput) and feeds "DM owner (error diagnostics)" directly —
// deliberately NOT back into Mark error → DLQ → Build thread reply, which
// would create a cycle (thread reply failing again forever).
//
// The vault commit (if any) already happened upstream, so a thread-post
// failure is a notification loss, not an artifact loss — one DM to the owner
// is the right blast radius.

const items = $input.all();
const j = items[0] ? items[0].json : {};
const errMsg = (j.error && (j.error.message || JSON.stringify(j.error).slice(0, 300)))
  || j.message
  || 'no error detail';

return [{ json: {
  __dm_owner_required: true,
  dlq_dm_text: [
    ':warning: *Slack thread reply failed* (vault commit unaffected)',
    `*Topic:* ${j.topic || '(unknown — see execution)'}`,
    `*Error:* \`${String(errMsg).slice(0, 400)}\``,
    '_Artifact state: check the call thread / vault; the commit step runs before Slack posts (V1.8), so the transcript is safe._',
  ].join('\n'),
} }];
