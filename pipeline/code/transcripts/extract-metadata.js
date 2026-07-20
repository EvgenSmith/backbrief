// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — runs once.
// Input: verified Zoom event body (from verify-zoom-webhook.js).
// Output: 0 or 1 items. Emits 0 if no TRANSCRIPT file is in recording_files[]
//   (Zoom is expected to re-deliver when transcript_completed fires).
// Also resolves participants_lastnames from the Zoom display-name roster
// (name maps from the TENANT_ROSTER region) with a host-email seed fallback —
// the single point where display names become canonical lastnames.

// ── __TENANT_ROSTER_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const OWNER_LASTNAME = 'Novak';
const OWNER_ALIASES_PATTERN = 'elena n|elena|novak|el'; // longest-first, regex alternation
const INTERNAL_DOMAINS = ['acme.dev'];
const FIRSTNAME_TO_LASTNAME = {
  Andrei: 'Petrov',
  'Andrei P': 'Petrov',
  Andy: 'Petrov',
  El: 'Novak',
  Elena: 'Novak',
  'Elena N': 'Novak',
  Maria: 'Ivanova',
  'Maria I': 'Ivanova',
  Masha: 'Ivanova',
  Sam: 'Okafor',
  Sammy: 'Okafor',
  W: 'Chen',
  Wei: 'Chen',
  'Wei C': 'Chen',
};
const SURNAME_ALIAS_MAP = {};
const CYRILLIC_LASTNAME_MAP = {};
const EMAIL_TO_LASTNAME = {
  andrei: 'Petrov',
  andy: 'Petrov',
  chen: 'Chen',
  el: 'Novak',
  elena: 'Novak',
  ivanova: 'Ivanova',
  maria: 'Ivanova',
  masha: 'Ivanova',
  novak: 'Novak',
  okafor: 'Okafor',
  petrov: 'Petrov',
  sam: 'Okafor',
  sammy: 'Okafor',
  w: 'Chen',
  wei: 'Chen',
};
const USER_HOME_TEAM = {
  Chen: 'PRD',
  Ivanova: 'GRW',
  Novak: 'PRD',
  Okafor: 'GRW',
  Petrov: 'ENG',
};
const LASTNAME_TO_TEAM = USER_HOME_TEAM; // participant→team bias (same data, both prod const names kept)
const SLACK_USER_ID_BY_LASTNAME = {}; // deploy-resolved (pipeline-state) + per-roster overrides
// ── __TENANT_ROSTER_END__ ──
// ── __TENANT_LANG_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'and',
  'or',
  'but',
  'if',
  'as',
  'by',
  'from',
  'up',
  'about',
  'into',
  'over',
  'under',
  'also',
  'then',
  'so',
  'very',
  'just',
  'need',
  'must',
  'should',
  'can',
  'will',
  'would',
  'may',
  'might',
  'create',
  'update',
  'fix',
  'make',
  'prepare',
  'send',
  'review',
  'task',
  'tasks',
  'action',
  'item',
  'items',
]);
const DOMAIN_BRIDGE = {};
const INFLECTION_SUFFIXES = [];
const CYR_TO_LAT = {}; // empty table ⇒ transliterate degrades to identity
const DISC_RECURRING_TOKENS = [
  'prepare the report',
  'prepare a report',
  'run a sync',
  'update the content',
  'check',
  'clarify',
  'pick up the task',
  'resolve the conflict',
  'resolve',
  'test',
  'run an audit',
  'assemble',
  'refine the mockup',
  'refine',
];
const DISC_CONTINUATION_PHRASES = ['task on', 'mechanics', 'process', 'work on', 'finish up', 'carry through', 'finish'];
const DISC_GENERIC_ARTIFACTS = [
  'landing page',
  'repository',
  'materials',
  'document',
  'frontend',
  'backend',
  'infrastructure',
  'process',
  'architecture',
  'integration',
  'mockup',
  'dashboard',
  'table',
  'report',
  'summary',
  'chart',
  'graph',
  'research',
  'analysis',
];
const DISC_SPECIFIC_ARTIFACTS = [
  'slide',
  'zip',
  'pdf',
  'notion page',
  'notion',
  'excel sheet',
  'google sheet',
  'mock',
  'prototype',
  'csv',
  'json',
  'form',
  'voice note',
  'link',
  'diagram',
  'comment',
  'email',
  'frame',
  'component',
];
const DISC_TIME_MARKERS = [
  'today',
  'tomorrow',
  'before the meeting',
  'by friday',
  'by end of week',
  'by the demo',
  'before launch',
  'by the release',
  'urgent',
  'immediately',
  'asap',
];
const DISC_INFRA_KEYWORDS = ['n8n', 'workflow', 'cron', 'credentials', 'api key', 'api-key'];
const DISC_CALL_SCHEDULE_TOKENS = ['schedule a call', 'set up a call', 'get on a call', 'hop on a call', 'meet to'];
const DISC_DECIDE_TOKENS = [
  'make a decision',
  'make the final decision',
  'collective decision',
  'decide on',
  'decision on',
];
const DISC_CHAT_RESOLVE_TOKENS = ['resolve in chat', 'resolve in slack', 'discuss in chat', 'sort out in chat', 'in chat:'];
const S = {
  'disc.call_to_decide': 'A call scheduled to make a decision («{sched}»+«{decide}») — not a trackable task',
  'disc.chat_resolve': '«{token}» — gets resolved in chat, not a separate task',
  'disc.create_without_match': 'Long dev sync — a CREATE without a match is suspicious',
  'disc.flag_uncertain': 'FLAG with score {score} — the matcher is unsure',
  'disc.long_planning': 'Long planning call — duplicate risk among CREATEs',
  'disc.owner_unresolved': 'Owner unresolved → triage',
  'disc.planning_score': 'Planning + score {score} — possibly an existing issue',
  'disc.planning_score_token': 'Planning + score {score} + «{token}» — possibly an existing issue',
  'disc.title_generalized': 'Title generalized — quote: «{specific}», title: «{generic}»',
  'disc.urgent_no_deadline': 'urgent priority without a deadline in the title',
  'dlq.error_label': '*Error:*',
  'dlq.failed_node': '*Failed node:* `{node}`',
  'dlq.header': '🚨 *Backbrief pipeline failure* — exec `{exec_id}`',
  'dlq.http_status': '*HTTP:* `{status}`',
  'dlq.retry_hint': '_Run redrive-dlq.js on this DLQ entry — restores the artifact. Or n8n UI → "Retry from failed node"._',
  'dlq.topic': '*Topic:* {topic}',
  'dlq.zoom_uuid': '*Zoom UUID:* `{uuid}`',
  'feedback.digest_header': ':bar_chart: *Backbrief · tasks feedback digest* (auto-collected from thread replies)',
  'feedback.global_signals': '*Global signals:*',
  'feedback.replies_parsed': '_{count} human replies parsed_',
  'main.already_in_vault': ':information_source: Already in vault: <{url}|{filename}> (GitHub 422)',
  'main.commit_failed': ':x: *Vault commit failed* — GitHub status `{status}`',
  'main.decisions_header': ':white_check_mark: *Decisions ({count})*',
  'main.digest_footer': '_via Backbrief_',
  'main.insights_header': ':bulb: *Key insights ({count})*',
  'main.monitoring_header': ':eyes: *Monitoring ({count})* — _ongoing observation_',
  'main.no_thread_root_branch': '*Branch:* {branch}',
  'main.no_thread_root_header': ':rotating_light: *Pipeline failure — no Slack thread root*',
  'main.no_thread_root_topic': '*Topic:* {topic}',
  'main.no_thread_root_vault_ok': ':white_check_mark: Vault commit SUCCEEDED ({path}) — only the Slack posts are missing.',
  'main.no_thread_root_vault_unknown': ':x: Vault commit state unknown — check the n8n execution / DLQ entry.',
  'main.participants_line': '> *Participants:* {names}',
  'main.summary_header': ':speech_balloon: *Summary*',
  'main.summary_truncated': '⚠️ Summary truncated by the model max_tokens cap (output_tokens={output_tokens}). Some action items / decisions may be missing. Raise llm.summarizer.max_tokens if recurring.',
  'main.transcript_download_failed': '> :warning:  _Transcript download failed (status {status}). Summary built from metadata only._',
  'main.upstream_failed': ':x: *Processing failed before vault commit* — an upstream step (transcript download / AI summary / parse) errored, so nothing was committed.',
  'main.vault_link': ':file_folder: Vault: <{url}|{filename}>',
  'tasks.all_create_tripwire': '🚨 *0 matches across {count} proposals* — dedup almost certainly missed (matcher recall hole). Do NOT bulk-create: check the tracker first, and where an issue already exists, comment manually.',
  'tasks.already_executed': '_Already {outcome}: <{url}|{identifier}>_ (by <@{user_id}>)',
  'tasks.already_executed_short': '_Already executed earlier._',
  'tasks.assigned_to_suffix': ' · assigned to {mention}',
  'tasks.btn_add_comment': '💬 Add comment',
  'tasks.btn_apply_update': '🔄 Apply update',
  'tasks.btn_bulk_approve': '✅ Approve all safe ({count})',
  'tasks.btn_bulk_skip': '⏸ Skip all remaining',
  'tasks.btn_comment_existing': '💬 Comment on existing',
  'tasks.btn_create_anyway': '➕ Create anyway',
  'tasks.btn_create_instead': '➕ Create new instead',
  'tasks.btn_create_issue': '✅ Create issue',
  'tasks.btn_skip': '⏸ Skip',
  'tasks.bulk_noop': '_Nothing left to execute — all tasks already handled._',
  'tasks.cannot_create_no_team': 'Cannot create a new task: the router could not resolve a team for «{title}». Possible causes: assignee_hint=\'{owner}\' is not a member of any known team, or the matcher produced no alt payload. Create the task manually or tell me the team explicitly.',
  'tasks.cannot_create_no_team_short': '⚠️ Cannot create «{title}» — no team for assignee_hint=\'{owner}\'.',
  'tasks.comment_added': '💬 Comment added to <{url}|{identifier}>',
  'tasks.created_confirm': '✅ Created <{url}|{identifier}>: «{title}»{assignee_suffix}',
  'tasks.discriminator_line': ':warning: discriminator ({confidence}): {concerns}',
  'tasks.fallback_text': 'Backbrief · tasks — {count} proposals ({counts})',
  'tasks.footer': '_Click Approve → real write to the tracker (idempotent). Skip → log only._',
  'tasks.header': '🛠 Backbrief · tasks — {count} proposals',
  'tasks.intra_batch_dup_note': '_duplicate of task #{task_id} in this batch_',
  'tasks.meta_filtered': 'Filtered: {count}',
  'tasks.meta_mode': 'Mode: `{mode}`',
  'tasks.meta_triage': '⚠️ Triage: {count}',
  'tasks.new_context_line': 'New context: «{title}»',
  'tasks.nothing_left': '_Nothing left._',
  'tasks.planning_banner': '⚠️ _Planning mode_ — on these calls the team usually walks through issues that ALREADY exist in the tracker. Review every **CREATE** button manually — chances are the task already exists and needs a COMMENT, not a CREATE. Bulk-approve is disabled.',
  'tasks.quote_line': '_quote: «{quote}»{ts}_',
  'tasks.same_target_dup_note': '_both proposals target this issue; task #{task_id} was chosen_',
  'tasks.skip_match_done_note': '_already done/canceled_',
  'tasks.skipped': '⏸ Skipped: «{title}»',
  'tasks.tracker_failed': '❌ Tracker {mutation} failed ({code}): {message}',
  'tasks.tracker_forbidden_member': '⚠️ Tracker refused: `{assignee}` is not a member of the target team. \nOptions: (a) add `{assignee}` to that team in the tracker → retry; (b) tell me to create the task in a team where `{assignee}` is a member; (c) create it manually with the right team.',
  'tasks.tracker_no_success': '❌ Tracker {mutation} returned no success: {payload}',
  'tasks.triage_line': '⚠️ _triage: {reason}_',
  'tasks.truncation_note': '⚠️ +{count} proposals not shown (Slack\'s 50-block limit). Handle the visible ones (or «Skip all remaining»); the full list is in the thread/vault.',
  'tasks.unassigned': '⚠️ _<UNASSIGNED — team lead pick>_',
  'tasks.unassigned_suffix': ' · ⚠️ unassigned — team lead, please assign',
  'tasks.unknown_action_kind': '❌ Unknown action kind: {kind}',
  'tasks.update_not_applied': '⚠️ Could not apply the update: {warnings}. Update the status manually in the tracker.',
  'tasks.updated_confirm': '🔄 Updated <{url}|{identifier}>: {state}',
  'tasks.voice_trigger_line': '🎤 _voice trigger: {marker}_',
}; // ui_strings for tenant.primary_language (no runtime mirroring — the digest channel has ONE working language)
// ── __TENANT_LANG_END__ ──
// ── __TENANT_KNOBS_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const MIN_DURATION_MIN = 5;
const REPLAY_WINDOW_SEC = 900;
const TRANSCRIPT_CHAR_CAP = 60000;
const NORMALIZER_EXCERPT_CAP = 40000;
const TTL_LISTING_MS = 1 * 60 * 60 * 1000;
const TTL_FILE_MS = 12 * 60 * 60 * 1000;
// ── __TENANT_KNOBS_END__ ──

const event = $input.first().json;

if (event.__validation) {
  // Validation handshake: Respond 200 OK is parallel to this branch and has already
  // echoed {plainToken, encryptedToken}. Stop here so downstream nodes don't try to
  // process a non-recording payload (was causing benign Download .vtt error executions).
  return [];
}

if (event.event !== 'recording.completed' && event.event !== 'recording.transcript_completed') {
  return []; // not our event type
}

const obj   = event.payload?.object || {};
const files = Array.isArray(obj.recording_files) ? obj.recording_files : [];

// Noise filters — skip recordings that shouldn't pollute the channel. Two
// cheap conditions, both fail-safe (skip only when the condition is
// unambiguously true; null/missing fields → let through):
//
// 1. Short calls (< pipeline.knobs.min_duration_min) — accidental clicks,
//    test calls, "wrong meeting" scenarios.
// 2. Empty participants (≤1) — phantom recurring auto-start where nobody
//    actually joined (prod-observed: a 16-min recording with
//    participant_user_names=null slipped past #1, caught by #2).
// V1.5.8 (2026-05-25): compute duration from recording_files first, since Zoom
// sends `obj.duration: 0` for personal/instant meetings. Order matters — duration
// filter below uses the computed value.
let computedDuration = null;
if (typeof obj.duration === 'number' && obj.duration > 0) {
  computedDuration = obj.duration;
} else if (files.length > 0) {
  let maxRangeMs = 0;
  for (const f of files) {
    if (f.recording_start && f.recording_end) {
      const startMs = new Date(f.recording_start).getTime();
      const endMs   = new Date(f.recording_end).getTime();
      if (endMs > startMs && (endMs - startMs) > maxRangeMs) {
        maxRangeMs = endMs - startMs;
      }
    }
  }
  if (maxRangeMs > 0) {
    computedDuration = Math.ceil(maxRangeMs / 60000);
  }
}

// MIN_DURATION_MIN comes from the TENANT_KNOBS region.
if (typeof computedDuration === 'number' && computedDuration > 0 && computedDuration < MIN_DURATION_MIN) {
  console.log(`[extract-metadata] skip: computedDuration ${computedDuration} min < ${MIN_DURATION_MIN} min threshold (uuid=${obj.uuid})`);
  return [];
}
const ppl = Array.isArray(obj.participant_user_names) ? obj.participant_user_names : [];
if (ppl.length > 0 && ppl.length < 2) {
  // Only filter when participant_user_names is non-empty (= Zoom did populate it) but contains 1
  // entry only (= only host, nobody joined). Empty array OR missing field → let through (might be
  // legitimate case where Zoom didn't deliver participant data yet, e.g. on early recording.completed).
  console.log(`[extract-metadata] skip: only ${ppl.length} participant in roster — likely phantom (uuid=${obj.uuid})`);
  return [];
}

// V1.0.2: NO short-circuit when transcript missing — always emit one item with
// `has_transcript` flag. Downstream branches:
//   - Phase 1 (no transcript): minimal Slack root + save state
//   - Phase 2 (has transcript): full Anthropic + GitHub + thread reply
const transcript = files.find(f => f.file_type === 'TRANSCRIPT' && f.status === 'completed');

// Find share URL — Zoom puts it on the recording (play_url is short-lived; share_url is the shareable one)
const shareEntry = files.find(f => f.file_type === 'MP4') || files[0];

// V1.5 (2026-05-22): expose MP4 download metadata for Drive uploader branch.
// Pick largest completed MP4 (Zoom splits long calls into segments).
// Without this, pick-mp4-url.js downstream sees a flattened item that
// has dropped the raw recording_files[] from the webhook payload.
const mp4s = files
  .filter(f => f.file_type === 'MP4' && (f.status === 'completed' || !f.status))
  .sort((a, b) => (b.file_size || 0) - (a.file_size || 0));
const mp4 = mp4s[0] || null;

const participants = Array.isArray(obj.participant_user_names)
  ? obj.participant_user_names
  : Array.isArray(obj.participants)
    ? obj.participants.map(p => p.user_name || p.email || p.name).filter(Boolean)
    : [];

// ── Participant lastname resolution (name maps from TENANT_ROSTER) ──────────
// Zoom display names arrive as "First Last", firstname-only ("Wei"), phonetic
// Latin, or Cyrillic. Resolve each to the canonical roster lastname; unknown
// names pass through unchanged (might be a new team member or an external
// guest — build-commit-payload's fail-soft sanitizer handles the leftovers).
// The name maps come from the TENANT_ROSTER region; the transliteration table
// from TENANT_LANG. Helpers degrade to identity on empty tables.
function transliterateCyrillic(s) {
  let out = '';
  for (const ch of s) out += (CYR_TO_LAT[ch] !== undefined ? CYR_TO_LAT[ch] : ch);
  if (out.length > 0 && /[a-z]/.test(out[0])) {
    out = out[0].toUpperCase() + out.slice(1);
  }
  return out;
}
function hasCyrillic(s) {
  return /[Ѐ-ӿ]/.test(String(s));
}

function lastName(displayName) {
  if (!displayName) return '';
  const stripped = String(displayName).replace(/\s*<[^>]*>\s*$/, '').trim();
  const parts    = stripped.split(/\s+/);
  let last       = parts[parts.length - 1] || '';
  if (last.includes('@') || last.includes('<') || last.includes('>')) return '';
  // V1.4.4: enforce Latin output. Cyrillic map first, transliterate as fallback.
  if (hasCyrillic(last)) {
    last = CYRILLIC_LASTNAME_MAP[last] || transliterateCyrillic(last);
  }
  // V1.4.5: firstname-only display names ("Wei") → canonical lastname ("Chen").
  // Check BEFORE surname alias to avoid mapping a first name that only looks
  // like a phonetic surname.
  if (FIRSTNAME_TO_LASTNAME[last]) {
    last = FIRSTNAME_TO_LASTNAME[last];
  }
  // V1.4.5: phonetic / legacy surname spellings → canonical (SURNAME_ALIAS_MAP).
  else if (SURNAME_ALIAS_MAP[last]) {
    last = SURNAME_ALIAS_MAP[last];
  }
  return last;
}

function emailDomain(emailOrName) {
  // Handles bare emails AND "Display Name <user@domain.tld>" forms.
  const m = String(emailOrName || '').match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : '';
}

// Canonical lastnames the maps know — lets a localpart segment that is already a
// surname resolve directly (e.g. "m.ivanova@" → Ivanova).
const CANONICAL_LASTNAMES = new Set([
  ...Object.values(FIRSTNAME_TO_LASTNAME),
  ...Object.values(SURNAME_ALIAS_MAP),
  ...Object.values(CYRILLIC_LASTNAME_MAP),
]);

// Best-effort host lastname from host_email. host_email is the ONE attendee
// signal Zoom's recording.transcript_completed webhook reliably carries (the
// host always attended), so it is a SAFE seed when the participant roster is
// empty — it fabricates no attendees (respects "wrong > empty"). Internal hosts
// only. Tries the whole localpart and each dot/underscore/dash segment as a
// firstname (Elena→Novak), surname alias, or canonical
// surname (ivanova→Ivanova). Returns '' on no confident match.
function hostLastnameFromEmail(email) {
  if (!email || !INTERNAL_DOMAINS.includes(emailDomain(email))) return '';
  const local = String(email).split('@')[0];
  for (const c of [local, ...local.split(/[._+-]/)].filter(Boolean)) {
    const cap = c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
    if (FIRSTNAME_TO_LASTNAME[cap]) return FIRSTNAME_TO_LASTNAME[cap];
    if (SURNAME_ALIAS_MAP[cap])     return SURNAME_ALIAS_MAP[cap];
    if (CANONICAL_LASTNAMES.has(cap)) return cap;
  }
  return '';
}

let participants_lastnames = participants.filter(Boolean).map(lastName);
// V1.7.19 (2026-07-09): host-email roster seed. Zoom's
// recording.transcript_completed webhook carries NO participant roster
// (participants_raw was [] on EVERY production call), so participants_lastnames
// reached STUB-C empty → no participant profile was ever injected into the
// summarizer. The host always attended, so seed the host lastname from
// host_email when the roster is empty — additive, internal-only, no fabricated
// attendees. Full roster requires Zoom's past_meetings/{uuid}/participants API
// (Zoom S2S OAuth credential — STUB-C fetches it when configured).
let participants_source = participants.length ? 'zoom_roster' : 'empty';
if (participants_lastnames.length === 0) {
  const hostLast = hostLastnameFromEmail(obj.host_email);
  if (hostLast) {
    participants_lastnames = [hostLast];
    participants_source = 'host_email_seed';
  }
}

// V1.5.26 (2026-06-02, P2-8 fix): zoom_event_id must be stable across retries.
// Previous fallback used Date.now() which created new id each retry, breaking
// downstream dedup. New fallback: derive from uuid + first recording_files id.
const eventIdFallback = (() => {
  if (event.event_ts) return String(event.event_ts);
  const firstFileId = files[0]?.id || 'no-files';
  return `${obj.uuid}-${firstFileId}`;
})();

return [{
  json: {
    zoom_event_id     : eventIdFallback,
    zoom_meeting_uuid : obj.uuid,
    zoom_meeting_id   : obj.id,
    zoom_account_id   : event.payload?.account_id,
    topic             : obj.topic || '(no topic)',
    host_email        : obj.host_email,
    start_time        : obj.start_time,
    duration_min      : computedDuration,
    participants_raw  : participants,
    participants_count: participants.length,
    participants_lastnames,
    participants_source,
    zoom_share_url    : obj.share_url || shareEntry?.play_url || '',
    has_transcript          : !!transcript,
    transcript_download_url : transcript?.download_url || null,
    transcript_access_token : event.download_token || obj.download_token || '',
    recording_files_count   : files.length,
    // V1.5: MP4 metadata for Drive uploader branch (Pick MP4 reads these)
    mp4_present             : !!mp4,
    mp4_download_url        : mp4?.download_url || null,
    mp4_access_token        : event.download_token || obj.download_token || '',
    mp4_file_size_bytes     : mp4?.file_size || 0,
    mp4_file_duration_sec   : mp4?.recording_duration_seconds || mp4?.duration || 0,
    mp4_recording_file_id   : mp4?.id || null,
  },
}];
