// SPDX-License-Identifier: BUSL-1.1
// C.3 (2026-07-09) — .vtt-download-failure alert builder (digest channel).
// Runs ONLY on the parallel alert branch off "Attach .vtt to item", when that
// node set vtt_download_failed=true (Download .vtt returned non-2xx or a body
// without WEBVTT — typically the 24h Zoom transcript_download_url expiry).
//
// NON-INVASIVE: the main path (Attach .vtt to item → Apply DeFi glossary v2 → …)
// still runs and the .md still commits with an empty .vtt exactly as before.
// This branch ONLY turns the previously-silent loss into a digest-channel
// alert. Before C.3 the sole signal was one thread-warning line
// (build-slack-thread-reply.js:214).
//
// STAGE NOTE: build-commit-payload has NOT run yet here, so vault_path/github_url
// do not exist. We alert with what "Attach .vtt to item" carries — enough to
// recover from Zoom Cloud while the recording is retained, or to redrive.
// ── __TENANT_SLACK_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const SLACK_ENABLED = true; // features.slack.enabled — false ⇒ builders post nothing
const OWNER_SLACK_USER_ID = ''; // deploy-resolved (test-creds.js slack)
const PUBLIC_CHANNEL_ID = '#call-digests'; // digest channel — name until deploy resolves the id
const DISPLAY_TIMEZONE = 'America/New_York';
// ── __TENANT_SLACK_END__ ──

// Slack off ⇒ no alert surface — end the branch (same contract as the other
// Slack builders; the main path already committed the .md without the .vtt).
if (!SLACK_ENABLED) return [];

const j = $input.first().json;

const partners = (j.participants_lastnames || [])
  .map(p => (typeof p === 'string' ? p : (p && p.lastname) || '?'))
  .filter(x => x && x !== 'null')
  .join(', ');

const status = j.vtt_download_failed_status || 'unknown';

const dm_text = [
  ':warning: *Raw .vtt download failed — transcript sidecar NOT saved*',
  `*Topic:* ${j.topic || '(no topic)'}`,
  partners ? `*Participants:* ${partners}` : null,
  j.duration_min ? `*Duration:* ${j.duration_min} min` : null,
  `*Zoom UUID:* \`${j.zoom_meeting_uuid || '?'}\``,
  `*Download status:* \`${status}\`  _(24h Zoom URL expiry is the usual cause)_`,
  j.zoom_share_url ? `*Recording:* <${j.zoom_share_url}|open in Zoom Cloud>` : null,
  '',
  '_The .md summary still commits, but WITHOUT the raw .vtt._',
  '_Recover the .vtt from Zoom Cloud while retained, or redrive: n8n UI → "Retry from failed node", or `redrive-dlq.js`._',
].filter(Boolean).join('\n');

// chat.postMessage-shaped payload — the alert goes to the public digest
// channel (TENANT_SLACK region). The "Digest alert (vtt fail)" Slack node
// consumes {{ $json.channel }} + {{ $json.dm_text }}; __vtt_alert is emitted
// too so the same item could drive a raw chat.postMessage HTTP call.
return [{ json: { ...j, dm_text, channel: PUBLIC_CHANNEL_ID, __vtt_alert: { channel: PUBLIC_CHANNEL_ID, text: dm_text } } }];
