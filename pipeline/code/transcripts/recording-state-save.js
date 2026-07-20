// SPDX-License-Identifier: BUSL-1.1
// State save — persist Phase 1 post coordinates so a later Phase 2 webhook
// can find the right thread to reply to.
//
// Called twice in the pipeline:
//   1. After Slack root post in Phase 1 (no transcript yet) — writes ts + channel
//   2. After Slack root post in Phase 2 single-shot (transcript present, no prior) —
//      also writes, defensive: if Zoom retries the same event later we won't
//      double-post.
//
// Map shape (workflow static data, global scope):
//   { recordings: { "<zoom_meeting_uuid>": {
//       slack_root_ts, slack_channel, topic, posted_at, has_transcript_at_save
//   } } }

const data = $getWorkflowStaticData('global');
const j = $input.first().json;
const uuid = j.zoom_meeting_uuid || '';

if (!uuid) {
  return [{ json: { ...j, __state_save_skipped: 'no zoom_meeting_uuid' } }];
}

data.recordings = data.recordings || {};
const now = new Date().toISOString();
data.recordings[uuid] = {
  slack_root_ts          : j.slack_root_ts || null,
  slack_channel          : j.slack_root_channel || j.channel || null,
  topic                  : j.topic || null,
  posted_at              : now,
  // V1.5.26 (P2-5): explicit Phase 1 timestamp so finalize TTL can purge
  // Phase-1-only entries (transcript never arrived) after 7d.
  phase1_completed_at    : now,
  has_transcript_at_save : !!j.has_transcript,
  // V1.5.12 (2026-05-27): also save MP4 download URL + access_token so the
  // Drive uploader branch on Phase 2 path can find them. Phase 2 webhook event
  // (recording.transcript_completed) contains only the TRANSCRIPT file in
  // recording_files[] — no MP4 → without this state passthrough, YouTube
  // upload could never trigger. Zoom access_token TTL ~2 hours; Phase 2
  // event typically arrives within 30 min, so token still valid.
  mp4_present            : !!j.mp4_present,
  mp4_download_url       : j.mp4_download_url || null,
  mp4_access_token       : j.mp4_access_token || null,
  mp4_file_size_bytes    : j.mp4_file_size_bytes || 0,
  mp4_recording_file_id  : j.mp4_recording_file_id || null,
};

return [{ json: { ...j, __state_saved: true } }];
