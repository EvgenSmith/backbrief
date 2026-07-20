// SPDX-License-Identifier: BUSL-1.1
const items = $input.all();
const out = [];
for (const it of items) {
  const j = it.json || {};
  const b = j.body || {};
  const merged = {
    zoom_meeting_uuid:      b.zoom_meeting_uuid      ?? j.zoom_meeting_uuid      ?? null,
    topic:                  b.topic                  ?? j.topic                  ?? '',
    start_time:             b.start_time             ?? j.start_time             ?? '',
    duration_min:           b.duration_min           ?? j.duration_min           ?? null,
    participants_lastnames: b.participants_lastnames ?? j.participants_lastnames ?? [],
    classification:         b.classification         ?? j.classification         ?? null,
    summary:                b.summary                ?? j.summary                ?? '',
    action_items:           b.action_items           ?? j.action_items           ?? [],
    mp4_present:            (b.mp4_present === true) || (j.mp4_present === true),
    mp4_download_url:       b.mp4_download_url       ?? j.mp4_download_url       ?? null,
    mp4_access_token:       b.mp4_access_token       ?? j.mp4_access_token       ?? '',
    mp4_file_size_bytes:    b.mp4_file_size_bytes    ?? j.mp4_file_size_bytes    ?? 0,
    mp4_recording_file_id:  b.mp4_recording_file_id  ?? j.mp4_recording_file_id  ?? null,
    slack_root_ts:          b.slack_root_ts          ?? j.slack_root_ts          ?? null,
    slack_channel_id:       b.slack_channel_id       ?? j.slack_channel_id       ?? null,
    vault_url:              b.vault_url              ?? j.vault_url              ?? null,
    // V1.6.1 — needed for root post rebuild (Organizer line + zoom raw backup)
    zoom_share_url:         b.zoom_share_url         ?? j.zoom_share_url         ?? null,
    host_email:             b.host_email             ?? j.host_email             ?? null,
  };
  if (!merged.mp4_present || !merged.mp4_download_url || !merged.mp4_access_token) {
    // V1.7: used to be a silent `continue` — recordings with expired or
    // missing Zoom share tokens were dropped without trace. Now throws so the
    // failure appears in the Drive uploader execution log and downstream
    // alerts can attach. Most common cause: Phase 2 fires >2h after the
    // recording ended → Zoom MP4 share token expired → replay needs a fresh
    // webhook.
    throw new Error(
      '[drive-uploader/normalize] MP4 payload incomplete — cannot upload. ' +
      'mp4_present=' + merged.mp4_present +
      ' has_url=' + !!merged.mp4_download_url +
      ' has_token=' + !!merged.mp4_access_token +
      ' (likely cause: Zoom share token expired — TTL ~2h. ' +
      'Replay webhook with fresh recording.completed event from Zoom). ' +
      'topic=' + JSON.stringify(merged.topic) +
      ' uuid=' + merged.zoom_meeting_uuid +
      ' slack_thread=' + merged.slack_root_ts
    );
  }
  if (!merged.slack_root_ts || !merged.slack_channel_id) {
    console.warn('[drive-uploader/normalize] slack thread coords missing — will upload but cannot post link. ts=' + merged.slack_root_ts + ' ch=' + merged.slack_channel_id);
  }
  out.push({ json: merged });
}
return out;
