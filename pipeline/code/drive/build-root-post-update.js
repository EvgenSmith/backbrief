// SPDX-License-Identifier: BUSL-1.1
// Build chat.update text for the root Slack post. Replaces Zoom share URL line
// with Drive URL line. Drive supports timestamp deep-link via ?t=NmSs — summary
// node references this same fileId with ?t=... for jump-to-quote links.
//
// V1.7.0 — port of the YouTube uploader's "Build YouTube thread reply".
// Timestamp format mirrors transcripts/build-slack-root-minimal.js (tenant
// display timezone via Intl shortOffset — no hardcoded GMT+N) so the updated
// root post reads identically to the one Phase 1 posted.

// ── __TENANT_SLACK_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const SLACK_ENABLED = true; // features.slack.enabled — false ⇒ builders post nothing
const OWNER_SLACK_USER_ID = ''; // deploy-resolved (test-creds.js slack)
const PUBLIC_CHANNEL_ID = '#call-digests'; // digest channel — name until deploy resolves the id
const DISPLAY_TIMEZONE = 'America/New_York';
// ── __TENANT_SLACK_END__ ──

const normalized = $('Normalize webhook payload').first().json;
const uploadResp = $input.first().json;
const j = { ...normalized };

const driveFile = uploadResp.body || uploadResp;
const fileId = (driveFile && driveFile.id) ? driveFile.id : null;
const uploadStatusCode = uploadResp.statusCode || 0;
const initResp = $('Init Drive session').first().json;
const initStatusCode = initResp.statusCode || 0;

function fmtLocal(iso) {
  // Tenant display timezone (tenant.timezone, IANA). Offset label computed —
  // no hardcoded GMT+N.
  if (!iso) return '—';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: DISPLAY_TIMEZONE,
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      timeZoneName: 'shortOffset',
    });
    return fmt.format(new Date(iso));
  } catch (e) { return iso; }
}
function fmtStartedAt(iso) {
  if (!iso) return '—';
  return fmtLocal(iso) + ' / ' + iso.slice(11, 16) + ' UTC';
}

const topic = j.topic || '(no topic)';
const dur = j.duration_min ? j.duration_min + ' min' : '?';
const startedAt = fmtStartedAt(j.start_time);
const org = j.host_email || '—';
const zoomUrl = j.zoom_share_url || '';

function buildRootText(recordingLine) {
  return [
    'Title: [' + topic + ']',
    'Duration: [' + dur + ']',
    'Started at [' + startedAt + ']',
    'Organizer: [' + org + ']',
    recordingLine,
  ].join('\n');
}

let recLine;
if (!fileId) {
  let note;
  if (initStatusCode && initStatusCode !== 200) note = 'Drive init HTTP ' + initStatusCode;
  else note = 'Drive upload failed HTTP ' + uploadStatusCode;
  recLine = zoomUrl
    ? 'Recording: <' + zoomUrl + '|zoom link>  (⚠️ ' + note + ')'
    : 'Recording: (no URL; ' + note + ')';
} else {
  const driveUrl = 'https://drive.google.com/file/d/' + fileId + '/view';
  recLine = zoomUrl
    ? 'Recording: ' + driveUrl + '  (zoom raw: <' + zoomUrl + '|link>)'
    : 'Recording: ' + driveUrl;
  j.drive_file_id = fileId;
  j.drive_url = driveUrl;
}

return [{
  json: {
    ...j,
    slack_root_text: buildRootText(recLine),
    slack_root_channel: j.slack_channel_id,
    slack_root_ts: j.slack_root_ts,
  },
}];
