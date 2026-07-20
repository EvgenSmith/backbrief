// SPDX-License-Identifier: BUSL-1.1
// STUB-C — Vault context loader.
//
// Before each Phase 2 LLM call, this node fetches additional context
// from the vault (GitHub repo) and concatenates it into a single
// `vault_context_system_prompt` string that build-anthropic-body.js prepends
// to its baked-in SYSTEM prompt.
//
// Fetched:
//   0. vault.company_profile_path               — company profile (size-capped)
//   1. vault.summarizer_skill_path              — base team-meeting skill
//   2. <profiles folder>/<Lastname>.md per participant (team profile)
//   3. 3-5 prior summaries from heuristic team folder (Summary section only)
//   4. Tracker open issues per participant (when a tracker token is wired)
//
// All fetches are best-effort. 404 → skip that file. Total network overhead
// ~2-5 sec per Phase 2 execution; trade-off accepted for context quality.
//
// Secret injection: the consts below hold placeholders; deploy-pipeline.js
// replaces them with real values on PUT to n8n (INJECT_SECRETS — the repo
// keeps the placeholders). A value still starting with '__' is ABSENT.

const GITHUB_PAT = '__GITHUB_PAT_PLACEHOLDER__';
const LINEAR_TOKEN = '__LINEAR_API_KEY_PLACEHOLDER__';
// Zoom Server-to-Server OAuth creds for the full participant roster fetch
// (§1.5 below). Absent → roster fetch skipped → graceful host-seed fallback.
const ZOOM_ACCOUNT_ID    = '__ZOOM_ACCOUNT_ID__';
const ZOOM_CLIENT_ID     = '__ZOOM_CLIENT_ID__';
const ZOOM_CLIENT_SECRET = '__ZOOM_CLIENT_SECRET__';

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
// ── __TENANT_KNOBS_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const MIN_DURATION_MIN = 5;
const REPLAY_WINDOW_SEC = 900;
const TRANSCRIPT_CHAR_CAP = 60000;
const NORMALIZER_EXCERPT_CAP = 40000;
const TTL_LISTING_MS = 1 * 60 * 60 * 1000;
const TTL_FILE_MS = 12 * 60 * 60 * 1000;
// ── __TENANT_KNOBS_END__ ──

// The body below uses await; it runs inside an async ARROW IIFE so the file
// parses as plain CJS (node --check, offline harness) — the arrow keeps
// lexical `this` so this.helpers stays reachable; n8n awaits the returned
// promise.
return (async () => {
const item = $input.first().json;
const participants = Array.isArray(item.participants_lastnames) ? item.participants_lastnames : [];
const data = $getWorkflowStaticData('global');
data.linearUsers = data.linearUsers || {};

// V1.3 (2026-07-09): n8n Code nodes do NOT expose global `fetch` (verified live:
// `typeof fetch === 'undefined'`), so every ghGet threw "fetch is not defined" →
// caught → null → the loader silently injected an empty context on every call.
// Use the supported `this.helpers.httpRequest` instead (captured here at
// top-level where `this` is the execution context; a nested function loses it).
const httpHelpers = this.helpers;

// V1.5.26 (2026-06-02, P3-1): persistent vault cache with TTL.
// Previously every Phase 2 execution hit GitHub for: 1× summarizer skill,
// 1× team/ listing, N× participant profiles, 1× prior folder listing, 5× prior
// summary bodies → 8-13 GitHub calls per call. With 6 calls/day that's 50+
// GitHub HTTPs daily and ~2-4s added latency per call.
// Cache shape: { [path]: { content, fetched_at, sha? } }
// TTL: 1h for directory listings (vault changes frequently with sync commits),
//      12h for individual file contents (team profiles, skill docs rarely change).
data.vaultCache = data.vaultCache || {};
const NOW = Date.now();
// TTL_LISTING_MS / TTL_FILE_MS come from the TENANT_KNOBS region
// (pipeline.knobs.vault_cache_ttl_*_h).
let cache_hits = 0, cache_misses = 0;

async function ghGet(path, opts = {}) {
  const isListing = !path.includes('.');  // directory paths have no extension
  const ttl = isListing ? TTL_LISTING_MS : TTL_FILE_MS;
  const cached = data.vaultCache[path];
  if (cached && (NOW - cached.fetched_at) < ttl) {
    cache_hits++;
    return cached.content;
  }
  cache_misses++;
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURI(path)}?ref=${BRANCH}`;
  try {
    // returnFullResponse + ignoreHttpStatusErrors so a 404 (missing optional
    // file) surfaces as statusCode rather than a throw — mirrors the old
    // `!resp.ok` negative-cache branch. json:true parses the GitHub body.
    const resp = await httpHelpers.httpRequest({
      method: 'GET',
      url,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${GITHUB_PAT}`,
        'User-Agent': 'backbrief-vault-context-loader',
      },
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
    if (!resp || resp.statusCode < 200 || resp.statusCode >= 300) {
      // Cache negative result briefly (5min) to avoid hammering on 404s
      data.vaultCache[path] = { content: null, fetched_at: NOW - ttl + 5 * 60 * 1000 };
      return null;
    }
    const j = resp.body;
    let content;
    if (Array.isArray(j)) content = j;
    else if (j && j.content && j.encoding === 'base64') content = Buffer.from(j.content, 'base64').toString('utf8');
    else content = null;
    data.vaultCache[path] = { content, fetched_at: NOW };
    return content;
  } catch (e) {
    console.log(`[stub-C] httpRequest failed for ${path}: ${e.message}`);
    return null;
  }
}

// Cache TTL hygiene: purge entries older than 24h to keep staticData small.
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;
let purged_cache = 0;
for (const [k, v] of Object.entries(data.vaultCache)) {
  if (!v || NOW - v.fetched_at > CACHE_MAX_AGE_MS) {
    delete data.vaultCache[k]; purged_cache++;
  }
}

// Name maps come from the TENANT_ROSTER region above; the transliteration
// table from TENANT_LANG. The helpers below are generic (empty table ⇒
// identity).
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

// 0. Company profile (vault.company_profile_path, default docs/company.md) —
//    injected FIRST: what the company does, product names and vocabulary
//    disambiguate topics/entities in every downstream section. HARD size cap:
//    the file is prompt budget (the template already caps it at ~60 lines /
//    ~2,000 chars; this cap is the pipeline-side guarantee). 404 → skip.
const COMPANY_PROFILE_CAP = 4000;
let companyProfile = await ghGet(COMPANY_PROFILE_PATH);
if (typeof companyProfile !== 'string') companyProfile = null;
if (companyProfile && companyProfile.length > COMPANY_PROFILE_CAP) {
  companyProfile = companyProfile.slice(0, COMPANY_PROFILE_CAP)
    + '\n\n[…company profile truncated at the injection cap — keep the file under ~60 lines]';
}

// 1. Base summarizer skill (vault.summarizer_skill_path)
const summarizerSkill = await ghGet(SUMMARIZER_SKILL_PATH);

// ─────────────────────────────────────────────────────────────────────────
// 1.5 — Full participant roster via Zoom Server-to-Server OAuth. (V1.8, 2026-07-09)
//
// Zoom's recording.transcript_completed webhook carries NO participant roster
// (participants_raw=[] on every prod call), so extract-metadata can only host-seed
// ONE lastname from host_email → at most one participant profile was ever injected.
// This block fetches the FULL attended roster from Zoom's
//   GET /past_meetings/{uuid}/participants
// and unions it with the host-seed. STUB-C runs AFTER routing inputs are
// fixed, so this augmentation is context-only — it can NEVER re-open a
// routing decision (that ran on the original roster upstream).
//
// GRACEFUL by construction: creds still placeholders / OAuth fail / API fail /
// meeting-not-found → keep rosterLastnames = incoming host-seed, never throw.
//
// The resolver reuses the canonical TENANT_ROSTER region above, shared with
// extract-metadata.js and parse-anthropic-response.js.
let rosterLastnames    = Array.from(new Set(participants)); // host-seed from extract-metadata
let roster_source      = 'seed_fallback';
let roster_participants = 0;

const zoomCredsPresent = [ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET]
  .every(v => typeof v === 'string' && v && !v.startsWith('__'));

if (zoomCredsPresent && item.zoom_meeting_uuid) {
  // INTERNAL_DOMAINS comes from the TENANT_ROSTER region (kills the
  // hand-kept duplicate the prod file carried).
  const CANONICAL_LASTNAMES = new Set([
    ...Object.values(FIRSTNAME_TO_LASTNAME),
    ...Object.values(SURNAME_ALIAS_MAP),
    ...Object.values(CYRILLIC_LASTNAME_MAP),
  ]);
  // = extract-metadata lastName(): strip <email>, take last token, Cyrillic→Latin,
  //   firstname→lastname, then surname alias.
  function lastNameFromDisplay(displayName) {
    if (!displayName) return '';
    const stripped = String(displayName).replace(/\s*<[^>]*>\s*$/, '').trim();
    const parts = stripped.split(/\s+/);
    let last = parts[parts.length - 1] || '';
    if (last.includes('@') || last.includes('<') || last.includes('>')) return '';
    if (hasCyrillic(last)) last = CYRILLIC_LASTNAME_MAP[last] || transliterateCyrillic(last);
    if (FIRSTNAME_TO_LASTNAME[last]) last = FIRSTNAME_TO_LASTNAME[last];
    else if (SURNAME_ALIAS_MAP[last]) last = SURNAME_ALIAS_MAP[last];
    return last;
  }
  // = extract-metadata hostLastnameFromEmail(): internal-domain only, tries the
  //   whole localpart + each dot/underscore/dash segment as firstname / alias /
  //   canonical surname (maxm@ won't resolve here — the display name covers it).
  function lastnameFromEmail(email) {
    const d = (String(email || '').match(/@([a-z0-9.-]+\.[a-z]{2,})/i) || [])[1];
    if (!d || !INTERNAL_DOMAINS.includes(d.toLowerCase())) return '';
    const local = String(email).split('@')[0];
    for (const c of [local, ...local.split(/[._+-]/)].filter(Boolean)) {
      const cap = c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
      if (FIRSTNAME_TO_LASTNAME[cap]) return FIRSTNAME_TO_LASTNAME[cap];
      if (SURNAME_ALIAS_MAP[cap])     return SURNAME_ALIAS_MAP[cap];
      if (CANONICAL_LASTNAMES.has(cap)) return cap;
    }
    return '';
  }

  // OAuth token, cached in staticData with a 60s safety margin (Phase 2 runs
  // ~6×/day; the account_credentials token lives ~1h, so re-auth ≈ once/hour).
  async function zoomToken() {
    const cached = data.zoomToken;
    if (cached && cached.access_token && cached.expires_at > NOW + 60000) return cached.access_token;
    const basic = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
    const resp = await httpHelpers.httpRequest({
      method: 'POST',
      url: `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(ZOOM_ACCOUNT_ID)}`,
      headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
    if (!resp || resp.statusCode < 200 || resp.statusCode >= 300) {
      console.log(`[stub-C] zoom OAuth failed: HTTP ${resp && resp.statusCode}`);
      return null;
    }
    const tok = resp.body && resp.body.access_token;
    if (!tok) return null;
    const ttlMs = (Number(resp.body.expires_in) || 3600) * 1000;
    data.zoomToken = { access_token: tok, expires_at: NOW + ttlMs };
    return tok;
  }

  // Zoom UUID quirk: UUIDs that start with '/' or contain '//' must be
  // DOUBLE-URL-encoded; all others single-encoded.
  function encodeZoomUUID(uuid) {
    const raw = String(uuid);
    return (raw.startsWith('/') || raw.includes('//'))
      ? encodeURIComponent(encodeURIComponent(raw))
      : encodeURIComponent(raw);
  }

  async function fetchZoomRoster(uuid, token) {
    const encoded = encodeZoomUUID(uuid);
    const MAX_PAGES = 3;          // a couple pages — Zoom page_size=100
    const out = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      let url = `https://api.zoom.us/v2/past_meetings/${encoded}/participants?page_size=100`;
      if (pageToken) url += `&next_page_token=${encodeURIComponent(pageToken)}`;
      const resp = await httpHelpers.httpRequest({
        method: 'GET',
        url,
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        json: true,
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
      });
      if (!resp || resp.statusCode < 200 || resp.statusCode >= 300) {
        console.log(`[stub-C] zoom participants HTTP ${resp && resp.statusCode} (page ${page}, uuid=${uuid})`);
        break;
      }
      const body = resp.body || {};
      const parts = Array.isArray(body.participants) ? body.participants : [];
      for (const p of parts) out.push(p);
      pageToken = body.next_page_token || '';
      if (!pageToken) break;
    }
    return out;
  }

  try {
    const token = await zoomToken();
    if (token) {
      const zoomParts = await fetchZoomRoster(item.zoom_meeting_uuid, token);
      if (zoomParts.length > 0) {
        roster_participants = zoomParts.length;
        roster_source = 'zoom_api';
        const resolved = [];
        for (const p of zoomParts) {
          const emailLast = lastnameFromEmail(p.user_email || p.email);
          const nameLast  = lastNameFromDisplay(p.name || p.user_name);
          if (emailLast) resolved.push(emailLast); // internal email → canonical
          if (nameLast)  resolved.push(nameLast);  // display name (covers maxm@ etc.)
        }
        // Union with host-seed, dedup, drop empties / needs-review markers.
        rosterLastnames = Array.from(new Set([...rosterLastnames, ...resolved]))
          .filter(x => typeof x === 'string' && x && !x.includes('?'));
      } else {
        console.log(`[stub-C] zoom roster empty (meeting not found / no participants, uuid=${item.zoom_meeting_uuid}) — keeping host-seed`);
      }
    }
  } catch (e) {
    console.log(`[stub-C] zoom roster failed: ${e.message} — keeping host-seed`);
  }
}

// 2. Team profiles per participant (lastname only — needs_review objects skipped)
// Kit convention (see the vault's docs/conventions.md): plain basename
// <Lastname>.md in the flat
// profiles folder (vault.profiles_folder, default team/). The
// list-and-match mechanism is kept from prod so listing stays one call.
// Uses rosterLastnames (host-seed ∪ Zoom API roster) instead of the raw seed.
let teamDirCache = null;
async function listTeamDir() {
  if (teamDirCache !== null) return teamDirCache;
  const listing = await ghGet(PROFILES_FOLDER);
  teamDirCache = Array.isArray(listing) ? listing : [];
  return teamDirCache;
}
const profilePromises = rosterLastnames
  .filter(p => typeof p === 'string' && p && !p.includes('?'))
  .map(async (lastname) => {
    const files = await listTeamDir();
    const match = files.find(f => f.type === 'file' && f.name === `${lastname}.md`);
    if (!match) return null;
    const content = await ghGet(`${PROFILES_FOLDER}/${match.name}`);
    return content ? { lastname, content } : null;
  });
const profilesRaw = await Promise.all(profilePromises);
const profiles = profilesRaw.filter(Boolean);

// 3. Prior summaries — heuristic team folder from topic regex (team_tag
//    unknown until the LLM responds, so we guess; a wrong guess still yields
//    relevant context from a related folder). The table is GENERATED from
//    vault.teams keywords/descriptions (TENANT_ROUTING region); fallback =
//    the mixed folder.
function guessFolder(topic) {
  const t = String(topic || '').toLowerCase();
  for (const g of GUESS_FOLDER_TABLE) {
    if (g.re.test(t)) return g.folder;
  }
  return MIXED_FOLDER;
}

const priorFolder = guessFolder(item.topic);
const folderListing = await ghGet(priorFolder.replace(/\/$/, ''));
let priorSummaries = [];
if (Array.isArray(folderListing)) {
  // Sort by filename descending (filename has YYYY-MM-DD HHMM, lexicographic = chronological)
  // Kit naming rule: date-first basenames sort chronologically (docs/conventions.md).
  const transcripts = folderListing
    .filter(f => f.type === 'file' && /^\d{4}-\d{2}-\d{2} \d{4} .*\.md$/.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 5);
  const summaryPromises = transcripts.map(async (f) => {
    const body = await ghGet(`${priorFolder}${f.name}`);
    if (!body) return null;
    // Extract `## Summary` section only (between '## Summary' and next '## ')
    const m = body.match(/##\s+Summary\s*\n+([\s\S]*?)(?=\n##\s+|$)/);
    return m ? { filename: f.name, summary: m[1].trim() } : null;
  });
  const results = await Promise.all(summaryPromises);
  priorSummaries = results.filter(Boolean);
}

// 4. Linear context — V1.2.5 active. Fetch user IDs by lastname → query open
//    issues for those assignees (top 20) + recently closed (last 14d, top 10).
async function linearGql(query, variables = {}) {
  try {
    // V1.3 (2026-07-09): fetch → this.helpers.httpRequest (no global fetch in
    // Code nodes). json:true sends+parses JSON; ignoreHttpStatusErrors keeps the
    // graceful null on non-2xx (Linear token is still a pending TODO).
    const resp = await httpHelpers.httpRequest({
      method: 'POST',
      url: 'https://api.linear.app/graphql',
      headers: { 'Authorization': LINEAR_TOKEN, 'Content-Type': 'application/json' },
      body: { query, variables },
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
    if (!resp || resp.statusCode < 200 || resp.statusCode >= 300) return null;
    const j = resp.body;
    if (!j || j.errors) return null;
    return j.data;
  } catch (e) {
    console.log(`[stub-C] linearGql fail: ${e.message}`);
    return null;
  }
}

async function resolveUserId(lastname) {
  if (!lastname) return null;
  if (data.linearUsers[lastname]) return data.linearUsers[lastname];
  const d = await linearGql(
    `query($n: String!) { users(filter: { name: { contains: $n } }) { nodes { id name } } }`,
    { n: lastname }
  );
  const nodes = d?.users?.nodes || [];
  if (nodes.length === 0) return null;
  const exact = nodes.find(u => new RegExp(`\\b${lastname}\\b`, 'i').test(u.name));
  const pick = exact || nodes[0];
  data.linearUsers[lastname] = pick.id;
  return pick.id;
}

let linearContext = null;
let linear_context_status = 'no-token';
if (LINEAR_TOKEN && !LINEAR_TOKEN.startsWith('__LINEAR')) {
  linear_context_status = 'attempted';
  const userIdsRaw = await Promise.all(
    participants
      .filter(p => typeof p === 'string' && p && !p.includes('?'))
      .map(p => resolveUserId(p))
  );
  const userIds = userIdsRaw.filter(Boolean);
  if (userIds.length > 0) {
    const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    // V1.5.26 (2026-06-02, P0-3 fix): Linear IssueFilter doesn't support `neq`
    // operator on state.type — only `eq`/`in`/`nin`. Previous query silently
    // returned null (linear_context_status='query-failed'), so Linear context
    // was never actually attached to summaries. Fix: list ACTIVE state types
    // explicitly.
    const issuesData = await linearGql(`
      query($users: [ID!]!, $since: DateTimeOrDuration!) {
        open: issues(
          first: 20,
          filter: { assignee: { id: { in: $users } }, state: { type: { in: ["unstarted","started","backlog","triage"] } } }
        ) { nodes { identifier title url priority assignee { name } state { name type } updatedAt } }
        closed: issues(
          first: 10,
          filter: { assignee: { id: { in: $users } }, completedAt: { gt: $since } }
        ) { nodes { identifier title url assignee { name } completedAt } }
      }`, { users: userIds, since });
    if (issuesData) {
      linearContext = issuesData;
      linear_context_status = `open=${issuesData.open?.nodes?.length || 0}, closed=${issuesData.closed?.nodes?.length || 0}`;
    } else {
      linear_context_status = 'query-failed';
    }
  } else {
    linear_context_status = 'no-resolvable-users';
  }
}

// Assemble vault_context_system_prompt
const sections = [];

if (companyProfile) {
  sections.push(`## Vault context — company profile (${COMPANY_PROFILE_PATH})\n\n${companyProfile}`);
}

if (summarizerSkill) {
  sections.push(`## Vault context — summarizer skill (docs/skills/summarizer.md)\n\n${summarizerSkill}`);
}

if (profiles.length > 0) {
  const profileText = profiles
    .map(p => `### ${p.lastname}\n\n${p.content}`)
    .join('\n\n---\n\n');
  sections.push(`## Vault context — participant profiles (team/)\n\n${profileText}`);
}

if (priorSummaries.length > 0) {
  const priorText = priorSummaries
    .map(p => `### ${p.filename}\n\n${p.summary}`)
    .join('\n\n---\n\n');
  sections.push(`## Vault context — prior summaries (${priorFolder}, last ${priorSummaries.length})\n\n${priorText}`);
}

if (linearContext) {
  const lines = [`## Vault context — Linear (${linear_context_status})`, ''];
  const openNodes = linearContext.open?.nodes || [];
  if (openNodes.length > 0) {
    lines.push('### Open issues with these participants as assignees (top 20 by recent activity)');
    lines.push('');
    for (const n of openNodes) {
      const prio = ['', 'urgent', 'high', 'medium', 'low'][n.priority] || '—';
      lines.push(`- **${n.identifier}** [${n.state?.name}, ${prio}] ${n.title} — *${n.assignee?.name || '—'}* — ${n.url}`);
    }
    lines.push('');
  }
  const closedNodes = linearContext.closed?.nodes || [];
  if (closedNodes.length > 0) {
    lines.push('### Recently closed (last 14 days, top 10)');
    lines.push('');
    for (const n of closedNodes) {
      lines.push(`- **${n.identifier}** ${n.title} — *${n.assignee?.name || '—'}* — closed ${(n.completedAt || '').slice(0, 10)}`);
    }
  }
  sections.push(lines.join('\n'));
} else {
  sections.push(`## Vault context — Linear\n\nstatus: ${linear_context_status}`);
}

const vault_context_system_prompt = sections.join('\n\n');

// V1.4 — surface prior call filenames so build-commit-payload-v2.js can put them
// in the new file's frontmatter as `references_prior_calls`. Lets future agents
// walk the discussion graph (find all calls in a thread) without re-running the
// folder listing each time.
const references_prior_calls = priorSummaries.map(p => `${priorFolder}${p.filename}`);

return [{ json: {
  ...item,
  vault_context_system_prompt,
  references_prior_calls,
  __stub_c_vault_context: 'loaded',
  __vault_context_meta: {
    company_loaded      : !!companyProfile,
    summarizer_loaded   : !!summarizerSkill,
    profiles_loaded     : profiles.length,
    profiles_requested  : rosterLastnames.length,
    roster_source       : roster_source,        // 'zoom_api' | 'seed_fallback'
    roster_participants : roster_participants,   // # participants returned by Zoom API
    roster_lastnames    : rosterLastnames.length,
    prior_summaries     : priorSummaries.length,
    prior_folder_guess  : priorFolder,
    linear_status       : linear_context_status,
    linear_users_cached : Object.keys(data.linearUsers || {}).length,
    vault_cache_hits    : cache_hits,
    vault_cache_misses  : cache_misses,
    vault_cache_purged  : purged_cache,
    vault_cache_size    : Object.keys(data.vaultCache || {}).length,
    bytes               : vault_context_system_prompt.length,
  },
} }];
})();
