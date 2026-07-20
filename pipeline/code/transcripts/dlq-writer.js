// SPDX-License-Identifier: BUSL-1.1
// DLQ writer — capture failed-execution context, route to the owner's Slack DM.
//
// Emits both legacy fields (__dlq_path, __dlq_body — kept for back-compat with
// any wiring still reading them) AND a rich `dlq_dm_text` field with a
// structured traceback that the downstream owner-DM error node renders to the
// tenant owner. (Earlier versions emitted a payload for a GitHub PUT that was
// never wired → diagnostics were lost after n8n exec history rolled over.)
//
// Retry strategy: the owner gets a DM → either click "Retry from this node" in
// the n8n UI, or replay the webhook with the same payload.
// V1.8: unwrap __passthrough — when the failure comes from a Slack node whose
// input was built by Build Slack root (Phase 2), the payload fields (topic,
// vault_path, content_b64…) live under __passthrough, not at the
// top level. Without the unwrap the DLQ entry would say "(no topic)" and lose
// the artifact exactly on the root-post-failure path this DLQ exists for.
// ── __TENANT_ROUTING_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const TENANT_NAME = 'Acme Robotics';
const KIT_VERSION = '0.1.0';
const REPO_OWNER = ''; // empty until B4 wires vault.repo
const REPO_NAME = '';
const BRANCH = 'main';
const PROFILES_FOLDER = 'team';
const SUMMARIZER_SKILL_PATH = 'docs/skills/summarizer.md';
const COMPANY_PROFILE_PATH = 'docs/company.md'; // company profile (born at A0) — size-capped context injection
const DLQ_FOLDER = 'pipeline/dlq';
const TRAINING_DATA_PATH = '.backbrief/training/feedback.jsonl'; // feedback training log (JSONL)
const TEAM_TO_FOLDER = {
  engineering: 'engineering/transcripts/',
  growth: 'growth/transcripts/',
  mixed: 'general/transcripts/',
  product: 'product/transcripts/',
};
const SUB_TAG_FOLDER = {};
const TRACKER_TO_VAULT_TEAM = {
  ENG: 'engineering',
  GRW: 'growth',
  PRD: 'product',
};
const LINEAR_TO_VAULT_TEAM = TRACKER_TO_VAULT_TEAM; // prod const name kept for diff reviewability
const VALID_TEAM = new Set(['engineering', 'growth', 'mixed', 'product']);
const VALID_SUB_TAG = new Set([]); // null also allowed
const VALID_SUB_FOR_TEAM = {
};
const GUESS_FOLDER_TABLE = [ // heuristic prior-context prefetch — wrong guess degrades gracefully
  { re: /product|roadmap|spec|pricing|launch/i, folder: 'product/transcripts/' },
  { re: /engineering|deploy|bug|api|firmware/i, folder: 'engineering/transcripts/' },
  { re: /growth|campaign|lead|partnership|funnel/i, folder: 'growth/transcripts/' },
];
const MIXED_FOLDER = 'general/transcripts/';
const RAW_RETENTION = 'vtt'; // none | vtt | vtt_mp4
// ── __TENANT_ROUTING_END__ ──
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

// {placeholder} interpolation for ui_strings templates (language packs).
function fmt(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) =>
    (vars && vars[k] !== undefined && vars[k] !== null) ? String(vars[k]) : '');
}

const raw = $input.first().json;
let item = (raw && raw.__passthrough && typeof raw.__passthrough === 'object')
  ? { ...raw.__passthrough, error: raw.error || raw.__passthrough.error }
  : raw;

// V1.8 selftest finding (exec 1242): n8n Slack-node error output emits ONLY
// {error} — no passthrough at all. Reach back to Build commit payload (always
// ran on the oneshot/commit path) to restore topic/artifact so the
// DLQ entry is actually redrivable. try/catch: on the Anthropic/parse error
// path Build commit payload never ran — metadata stays minimal there.
if (!item.topic && !item.vault_path) {
  try {
    const u = $('Build commit payload').first();
    if (u && u.json) item = { ...u.json, ...item, error: item.error || u.json.error };
  } catch (e) { /* upstream payload node didn't run in this execution */ }
}
// V1.8.1 (exec 1248 finding): Phase-1 failures (root post for recording.completed)
// have no Build commit payload either — the DM said "(no topic)". Extract
// metadata runs on EVERY recording event, so it's the universal context source.
if (!item.topic) {
  try {
    const m = $('Extract metadata').first();
    if (m && m.json) item = { ...m.json, ...item, error: item.error || m.json.error };
  } catch (e) { /* non-recording event */ }
}

const exec_id  = $execution?.id || `unknown-${Date.now()}`;
const wf_id    = $workflow?.id  || 'unknown';
const node_err = item.__error_node || item.__branch || 'unknown';

const error_blob = item.gh_response_body
  || item.__error_message
  || (item.error && (item.error.message || JSON.stringify(item.error).slice(0, 500)))
  || 'no error blob available';

const dlq_path = `${DLQ_FOLDER}/${new Date().toISOString().slice(0, 10)}/${exec_id}.json`;

// V1.8 (P0-4, 2026-07-02): DURABLE DLQ — the entry is now actually committed to
// the repo by the downstream "DLQ persist (GitHub)" node (the PUT this file's
// header lamented was "never wired"). The entry carries the FULL artifact
// (rendered .md + raw .vtt, base64) so n8n/deploy/redrive-dlq.js can restore a
// lost call even after the n8n execution ages out of retention (~7 days —
// exactly how a prod transcript once nearly died). The artifact is embedded
// whenever the payload built one; a failure before Build commit payload has
// no artifact yet — redrive-dlq.js falls back to the n8n exec (while
// retained) or Zoom Cloud for those.
const artifact = item.content_b64 ? {
  vault_path             : item.vault_path,
  transcript_vault_path  : item.transcript_vault_path || null,
  content_b64            : item.content_b64,
  transcript_content_b64 : item.transcript_content_b64 || null,
} : null;

const dlq_body = {
  timestamp       : new Date().toISOString(),
  exec_id,
  workflow_id     : wf_id,
  failed_node     : node_err,
  zoom_event_id   : item.zoom_event_id || null,
  zoom_meeting_uuid: item.zoom_meeting_uuid || null,
  topic           : item.topic || null,
  participants    : item.participants_raw || [],
  status_code     : item.gh_status_code || null,
  error           : String(error_blob).slice(0, 1500),
  retry_hint      : 'Run redrive-dlq.js on this DLQ entry — restores the artifact. Or n8n UI → "Retry from failed node".',
  artifact,
};

const dm_lines = [
  fmt(S['dlq.header'], { exec_id }),
  fmt(S['dlq.topic'], { topic: dlq_body.topic || '(no topic)' }),
  fmt(S['dlq.failed_node'], { node: dlq_body.failed_node }),
  dlq_body.zoom_meeting_uuid ? fmt(S['dlq.zoom_uuid'], { uuid: dlq_body.zoom_meeting_uuid }) : null,
  dlq_body.status_code ? fmt(S['dlq.http_status'], { status: dlq_body.status_code }) : null,
  '',
  S['dlq.error_label'],
  '```',
  String(dlq_body.error).slice(0, 1200),
  '```',
  '',
  S['dlq.retry_hint'],
].filter(Boolean).join('\n');

return [{
  json: {
    ...item,
    __dlq_path: dlq_path,    // repo path the persist node PUTs to
    __dlq_body: dlq_body,    // full entry (kept for visibility in exec data)
    // V1.8: ready-to-PUT fields for the "DLQ persist (GitHub)" HTTP node
    __dlq_body_b64: Buffer.from(JSON.stringify(dlq_body, null, 2), 'utf8').toString('base64'),
    __dlq_commit_message: `dlq: pipeline failure ${exec_id} (${(item.topic || 'no topic').slice(0, 60)})`,
    dlq_dm_text: dm_lines,   // structured DM text for the owner-DM error node
  },
}];
