// SPDX-License-Identifier: BUSL-1.1
// Phase 1 Slack root post — plain reference-style format:
//
//   Title: [<topic>]
//   Duration: [<n> min]
//   Started at [<MSK datetime>]
//   Organizer: [<host_email>]
//   Recording ready (<UTC date+time>): <zoom share URL>
//
// Uses a single mrkdwn section block so the existing Slack node config
// (messageType=block) keeps working; Slack auto-unfurls the URL.

// ── __TENANT_SLACK_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const SLACK_ENABLED = true; // features.slack.enabled — false ⇒ builders post nothing
const OWNER_SLACK_USER_ID = ''; // deploy-resolved (test-creds.js slack)
const PUBLIC_CHANNEL_ID = '#call-digests'; // digest channel — name until deploy resolves the id
const DISPLAY_TIMEZONE = 'America/New_York';
// ── __TENANT_SLACK_END__ ──

const items = $input.all();

// M-slackflag: honor features.slack.enabled:false. SLACK_ENABLED comes from the
// TENANT_SLACK region. When Slack is off, emit nothing → the downstream Slack
// node never fires (a no-Slack tenant runs clean; the vault-commit path is a
// separate branch and is unaffected).
if (!SLACK_ENABLED) return [];

// M-outinj: neutralize Slack control syntax in transcript/user-derived text so
// meeting content (topic, organizer) can't inject links (<url|text>), pings
// (<@U…>, <!channel>, <#C…>) or broadcast triggers. Slack's three required
// escapes (& < >) defang every angle-bracket construct; we also break the bare
// broadcast keywords @here/@channel/@everyone that some clients linkify. Applied
// ONLY to user/transcript values — never to our own static labels.
function escapeSlackText(s) {
  if (s === null || s === undefined) return s;
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=(?:here|channel|everyone)\b)/gi, '@\u200b');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtLocal(iso) {
  // Tenant display timezone (tenant.timezone, IANA). Offset label computed —
  // no hardcoded GMT+N.
  if (!iso) return '—';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: DISPLAY_TIMEZONE,
      month   : 'short',
      day     : 'numeric',
      hour    : '2-digit',
      minute  : '2-digit',
      hour12  : false,
      timeZoneName: 'shortOffset',
    });
    return fmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

function fmtUtcShort(iso) {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' '); // "2026-05-20 06:56"
}

// Combined "Started at" — tenant-local first (primary), UTC second (debug).
function fmtStartedAt(iso) {
  if (!iso) return '—';
  const msk = fmtLocal(iso);
  const utcRaw = iso.slice(11, 16); // "HH:MM"
  return `${msk} / ${utcRaw} UTC`;
}

const out = items.map(it => {
  const j        = it.json;
  // M-outinj: topic + organizer are meeting-set (attacker-controllable) — escape.
  const topic    = escapeSlackText(j.topic || '(no topic)');
  // V1.5.8 (2026-05-25): '?' more honest than '—' when missing — signals
  // upstream didn't provide. extract-metadata.js now computes from recording_files
  // timestamps when Zoom sends duration:0, so '?' should be rare.
  const dur      = j.duration_min ? `${j.duration_min} min` : '?';
  const startedAt = fmtStartedAt(j.start_time);
  const startUtc  = fmtUtcShort(j.start_time);
  const org      = escapeSlackText(j.host_email || '—');
  const share    = j.zoom_share_url || '';

  const lines = [
    `Title: [${topic}]`,
    `Duration: [${dur}]`,
    `Started at [${startedAt}]`,
    `Organizer: [${org}]`,
    share
      ? `Recording: ${share}`
      : `Recording: (share URL not yet available)`,
  ];
  const text = lines.join('\n');

  // Every call posts to the public digest channel — the channel id comes
  // from the TENANT_SLACK region (deploy-resolved).
  const channel = PUBLIC_CHANNEL_ID;

  return {
    json: {
      channel: channel,
      text   : text,
      blocks : [
        { type: 'section', text: { type: 'mrkdwn', text } },
      ],
      __passthrough: j,
    },
  };
});

return out;
