// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — runs after the single Anthropic HTTP call.
// Extracts JSON from the response, validates the V1 schema, attaches a
// `classification` field (used by build-commit-payload-v2.js) plus `summary` and
// `action_items`. Throws on schema violation so we never silently drop fields.

// VALID_TEAM / VALID_SUB_TAG / VALID_SUB_FOR_TEAM are generated from
// vault.teams (TENANT_ROUTING region below).

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

// The model emits firstname-only ("Wei"), phonetic Latin, or raw non-Latin
// names in assignee_hint / helpers_mentioned. Resolve to the canonical
// lastname before the filename builder / tracker assignment / Slack
// @-mention. Maps come from the TENANT_ROSTER region; the transliteration
// table from TENANT_LANG (both rendered from tenant.yaml).
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
// Resolve a name token to canonical lastname. Returns the original token
// unchanged if no map hit (might be a new team member or external partner).
function resolveLastname(name) {
  if (typeof name !== 'string' || !name) return name;
  if (FIRSTNAME_TO_LASTNAME[name]) return FIRSTNAME_TO_LASTNAME[name];
  if (SURNAME_ALIAS_MAP[name])    return SURNAME_ALIAS_MAP[name];
  if (CYRILLIC_LASTNAME_MAP[name]) return CYRILLIC_LASTNAME_MAP[name];   // WI#2b: Cyrillic surnames now live here
  // V1.5.19 (2026-05-28): drop initial-only patterns like "K." or "K".
  if (/^[A-Za-zА-Яа-яЁё]\.?$/.test(name.trim())) return null;
  // V1.5.25: multi-word display names like "Maria I." or
  // "Maria Ivanova" arrive from Zoom participant_user_names. If first token
  // matches a known firstname → drop trailing initials/lastname stub, return
  // mapped lastname. Same logic for surname aliases.
  const trimmed = name.trim();
  if (/\s/.test(trimmed)) {
    const tokens = trimmed.split(/\s+/);
    const first = tokens[0];
    if (FIRSTNAME_TO_LASTNAME[first]) return FIRSTNAME_TO_LASTNAME[first];
    // Second token might be the real lastname (e.g. "Maria Ivanova" → Ivanova)
    const second = tokens[1];
    if (second && SURNAME_ALIAS_MAP[second])     return SURNAME_ALIAS_MAP[second];
    if (second && CYRILLIC_LASTNAME_MAP[second]) return CYRILLIC_LASTNAME_MAP[second];
    if (second && /^[A-Za-z][a-z]+$/.test(second)) {
      // Looks like a Latin lastname-ish word — accept as-is (not every lastname needs an alias entry)
      return second;
    }
    // F4-M1 minor: unknown Cyrillic lastname token ("Игорь Белкин") —
    // transliterate like extract-metadata lastName() does, re-checking the
    // alias map with the Latin form.
    if (second && hasCyrillic(second)) {
      const lat = transliterateCyrillic(second);
      if (SURNAME_ALIAS_MAP[lat]) return SURNAME_ALIAS_MAP[lat];
      if (/^[A-Za-z][A-Za-z\-']*$/.test(lat)) return lat;
    }
    // First token doesn't resolve, second is just initial → null (no usable lastname)
    return null;
  }
  // F4-M1 minor: unknown single Cyrillic token — transliterate to Latin
  // (mirrors extract-metadata lastName(); transliterateCyrillic was declared
  // here but never called, so an unknown Cyrillic assignee_hint stayed
  // Cyrillic while the SAME surname in participants_lastnames came out Latin,
  // breaking the one-Latin-token rule downstream). Re-check the maps with the
  // Latin form first — an alias table may know the transliterated spelling.
  if (hasCyrillic(name)) {
    const lat = transliterateCyrillic(name);
    return FIRSTNAME_TO_LASTNAME[lat] || SURNAME_ALIAS_MAP[lat] || CYRILLIC_LASTNAME_MAP[lat] || lat;
  }
  return name;
}
// VALID_SUB_TAG / VALID_SUB_FOR_TEAM come from the TENANT_ROUTING region.
const VALID_CONFIDENCE  = new Set(['low','medium','high']);
const VALID_PRIORITY    = new Set(['low','medium','high','urgent']);
// call_type controlled vocabulary (frontmatter/controlled-vocabulary.yaml) + 'unspecified' fallback token.
const VALID_CALL_TYPE   = new Set(['standup','planning','review','demo','discovery','1on1','all-hands','external','mixed','unspecified']);
// V1.4 action_items extensions
const VALID_ACTION_STATUS = new Set(['post-call','done-on-call','monitoring','in-progress']);
const VALID_DIRECTION     = new Set(['we-to-them','they-to-us','internal']);
const VALID_VOICE_MARKER  = new Set(['explicit-task','explicit-skip','explicit-comment']);

// F4-M1: dominant narrative language for the vault frontmatter `language`
// key (ISO 639-1, required by validate-vault.js). Same Cyrillic-ratio
// heuristic as plugin/scripts/normalize-transcript.js detectLanguage() —
// used as the fallback when the model response carries no detected_language.
function detectNarrativeLanguage(text) {
  const s = String(text || '');
  const cyr = (s.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  if (cyr + lat === 0) return 'en';
  return cyr / (cyr + lat) > 0.25 ? 'ru' : 'en';
}

function extractJson(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  // Allow either bare JSON or a fenced ```json ... ``` block (defensive).
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw   = fence ? fence[1] : trimmed;
  try { return JSON.parse(raw); } catch { return null; }
}

// V1.7.13 (2026-06-12) — tolerant parse for Anthropic's malformed JSON.
// Observed in production: when slack_summary contains nested double-quotes
// inside non-English markdown, the model occasionally emits them unescaped —
// JSON.parse throws on the inner quote (two prod execs, same break column).
//
// Strategy: try strict parse → try common repairs → regex-extract critical
// fields. Returns { obj, repair: 'strict'|'<repair-name>', warning?: '...' }.
function tolerantExtractJson(rawText) {
  if (typeof rawText !== 'string' || !rawText) return { obj: null, repair: 'empty' };
  const fence = rawText.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
  const text  = (fence ? fence[1] : rawText).trim();

  // (1) strict — succeeds in >99% of normal calls
  try { return { obj: JSON.parse(text), repair: 'strict' }; } catch (e) { /* fall through */ }

  // (2) common repairs: strip trailing commas before } or ]
  try {
    const v1 = text.replace(/,(\s*[}\]])/g, '$1');
    return { obj: JSON.parse(v1), repair: 'trailing-comma' };
  } catch (e) { /* fall through */ }

  // (3) repair unescaped inner quotes — heuristic: scan tokens, when inside
  //     a JSON string literal, treat any `"` that is NOT followed by one of
  //     `[,}\]]\s` (i.e. structural follow-ons) as a literal quote → escape it.
  //     Imperfect (false negatives possible), but catches the «foo "bar"» case.
  try {
    const repaired = repairUnescapedQuotes(text);
    return { obj: JSON.parse(repaired), repair: 'inner-quote-escape' };
  } catch (e) { /* fall through */ }

  // (4) last resort: regex-extract the fields the pipeline absolutely needs.
  //     Schema-required subset only; arrays default to []. Marked with
  //     warning so downstream nodes surface the degraded state.
  const pickStr = (key) => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;
  };
  const pickArr = (key) => {
    // Crude — grabs the array literal text; downstream uses an empty array
    // if we can't safely parse it (better than crashing the pipeline).
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]*?\\])\\s*,`));
    if (!m) return [];
    try { return JSON.parse(m[1]); } catch { return []; }
  };
  const obj = {
    team_tag:           pickStr('team_tag')           || 'mixed',
    sub_tag:            pickStr('sub_tag'),
    call_type:          pickStr('call_type')          || 'unspecified',
    topic_slug:         pickStr('topic_slug')         || 'untitled-call',
    confidence:         pickStr('confidence')         || 'low',
    tags:               pickArr('tags'),
    slack_summary:      pickStr('slack_summary')      || '(summary unavailable — Anthropic returned invalid JSON; regex-extracted)',
    decisions:          [],
    action_items:       [],
    open_questions:     [],
    key_insights:       [],
    next_24_48h:        [],
  };
  return {
    obj,
    repair: 'regex-extract',
    warning: '⚠️ Anthropic JSON malformed at parse-time — regex-extracted scalar fields, arrays defaulted to [] (decisions / action_items / insights missing). Source text first 200: ' + text.slice(0, 200),
  };
}

// Heuristic repair: walk the string char-by-char, track string-literal state,
// and escape any `"` inside a string that is NOT followed by structural JSON
// punctuation (`,` `:` `}` `]` `\n` after whitespace). Safe for the most
// common Anthropic failure mode (Russian markdown with nested ASCII quotes).
function repairUnescapedQuotes(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (ch === '"' && prev !== '\\') {
      if (!inStr) {
        // Entering a string literal
        inStr = true; out += ch; continue;
      }
      // Inside a string — decide: is THIS quote the closing one, or an
      // unescaped inner quote? Look ahead past whitespace for a structural
      // char.
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      const next = text[j];
      if (next === ',' || next === '}' || next === ']' || next === ':' || next === '\n' || next === '\r' || j >= text.length) {
        // Looks like the real string terminator → leave as-is, exit string
        inStr = false; out += ch; continue;
      }
      // Inner unescaped quote — escape it
      out += '\\"'; continue;
    }
    out += ch;
  }
  return out;
}

function assertSchema(c) {
  if (!c || typeof c !== 'object') throw new Error('Anthropic returned non-object');
  if (!VALID_TEAM.has(c.team_tag))               throw new Error(`bad team_tag: ${c.team_tag}`);
  // sub_tag optional. V1.5.10 (2026-05-27) made tolerant — if Anthropic emits
  // a sub_tag that's not in global enum OR not valid for the chosen team
  // (observed: team=bdsm + sub_tag=legal because Marketing issues call had
  // legal subtopic), drop to null + warn instead of throwing. Pipeline survives,
  // routing falls back to team folder without sub-folder.
  if (c.sub_tag !== null && c.sub_tag !== undefined) {
    if (typeof c.sub_tag !== 'string' || !VALID_SUB_TAG.has(c.sub_tag)) {
      console.warn(`[parse-anthropic-response] dropping invalid sub_tag "${c.sub_tag}" (not in global enum)`);
      c.sub_tag_original = c.sub_tag;
      c.sub_tag = null;
    } else {
      const allowed = VALID_SUB_FOR_TEAM[c.team_tag];
      if (!allowed || !allowed.has(c.sub_tag)) {
        console.warn(`[parse-anthropic-response] dropping sub_tag "${c.sub_tag}" — not valid for team_tag "${c.team_tag}"`);
        c.sub_tag_original = c.sub_tag;
        c.sub_tag = null;
      }
    }
  }
  if (!VALID_CONFIDENCE.has(c.confidence))       throw new Error(`bad confidence: ${c.confidence}`);
  if (!Array.isArray(c.tags))                    throw new Error('tags must be array');
  if (typeof c.topic_slug !== 'string' || !c.topic_slug) throw new Error('topic_slug missing');
  // V1.4: enforced English/latin kebab-case so vault filenames stay readable across teams.
  // V1.4.3 (2026-05-21): tolerant slug normalization — Anthropic occasionally overshoots word
  // count (observed in prod: a 7-word slug blocked the entire pipeline).
  // Behavior:
  //   1. Lowercase + strip non-[a-z0-9-] chars (defensive against accidental punctuation).
  //   2. Collapse consecutive dashes; trim leading/trailing dash.
  //   3. If >6 words, truncate to first 6 and record `topic_slug_truncated_from`.
  //   4. Hard-fail only on <2 words (useless) or charset still invalid after normalize.
  const SLUG_MAX_WORDS = 6;
  let normalized = String(c.topic_slug).toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const slugWords = normalized.split('-').filter(Boolean);
  if (slugWords.length < 2) {
    throw new Error(`topic_slug must be English kebab-case [a-z0-9-], 2-6 words: got "${c.topic_slug}" (parsed ${slugWords.length} word(s))`);
  }
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new Error(`topic_slug normalization failed for "${c.topic_slug}" — got "${normalized}"`);
  }
  if (slugWords.length > SLUG_MAX_WORDS) {
    const truncated = slugWords.slice(0, SLUG_MAX_WORDS).join('-');
    console.warn(`[parse-anthropic-response] topic_slug truncated from ${slugWords.length} -> ${SLUG_MAX_WORDS} words: "${c.topic_slug}" -> "${truncated}"`);
    c.topic_slug_truncated_from = c.topic_slug;
    c.topic_slug = truncated;
  } else {
    c.topic_slug = normalized;
  }
  if (typeof c.slack_summary !== 'string')       throw new Error('slack_summary missing');
  if (!Array.isArray(c.action_items))            throw new Error('action_items must be array');
  // V1.3 POS-aligned fields — required, but may be empty arrays
  if (c.call_type !== undefined && !VALID_CALL_TYPE.has(c.call_type)) throw new Error(`bad call_type: ${c.call_type}`);
  for (const [field, validator] of [
    ['decisions',       d => typeof d.title === 'string'],
    ['open_questions',  q => typeof q.question === 'string'],
    ['key_insights',    k => typeof k.insight === 'string'],
    ['next_24_48h',     n => typeof n.action === 'string'],
  ]) {
    if (c[field] !== undefined) {
      if (!Array.isArray(c[field])) throw new Error(`${field} must be array`);
      for (const x of c[field]) if (!validator(x)) throw new Error(`${field} item malformed: ${JSON.stringify(x).slice(0,80)}`);
    }
  }
  // sensitive_flags processing disabled (owner decision, prod) —
  // backlogged. The model still may emit sensitive_flags in its
  // output, but we drop it here (don't validate, don't pass downstream).
  // build-commit-payload + build-slack-thread-reply already handle the
  // absence gracefully (check `length > 0` before rendering).
  if (c.sensitive_flags !== undefined) {
    c.sensitive_flags = [];
  }
  for (const ai of c.action_items) {
    if (typeof ai.title !== 'string')              throw new Error('action_item.title missing');
    if (ai.assignee_hint !== null && typeof ai.assignee_hint !== 'string')
      throw new Error(`action_item.assignee_hint invalid: ${ai.assignee_hint}`);
    // V1.4.5: resolve firstname / phonetic surname BEFORE whitespace check.
    // Mutates in-place so downstream consumers (Linear assignment, Slack @-mention,
    // 4-block Linear template Context section) see the canonical lastname.
    if (typeof ai.assignee_hint === 'string') {
      ai.assignee_hint = resolveLastname(ai.assignee_hint);
    }
    if (ai.assignee_hint && /\s/.test(ai.assignee_hint))
      throw new Error(`action_item.assignee_hint must be lastname only (no whitespace): "${ai.assignee_hint}"`);
    // red-team rec 2: reject Slack/mention control chars in a name token (a
    // model-derived "<!channel>"/"<@U…>"/"#chan" must never reach a mention).
    // Negative charset so Unicode lastnames (e.g. Cyrillic) still pass.
    if (ai.assignee_hint && /[<>@!#&|]/.test(ai.assignee_hint))
      throw new Error(`action_item.assignee_hint has forbidden control char: "${ai.assignee_hint}"`);
    if (!VALID_PRIORITY.has(ai.priority_hint))    throw new Error(`bad priority_hint: ${ai.priority_hint}`);
    if (typeof ai.transcript_quote !== 'string')  throw new Error('action_item.transcript_quote missing');
    // V1.4 — new fields. Tolerate missing (default to post-call / [] / null) for back-compat with old executions.
    if (ai.status !== undefined && !VALID_ACTION_STATUS.has(ai.status)) {
      throw new Error(`action_item.status invalid: "${ai.status}". Must be one of ${[...VALID_ACTION_STATUS].join('|')}`);
    }
    if (ai.helpers_mentioned !== undefined) {
      if (!Array.isArray(ai.helpers_mentioned)) throw new Error('action_item.helpers_mentioned must be array');
      // V1.4.5: resolve firstnames / phonetic surnames before validation,
      // mutating in-place. Also de-dup: after resolution, "Wei" and "Chen"
      // collapse to one entry. If helper resolves to the assignee, drop it
      // silently (was throw in V1.4 — now we forgive because alias resolution
      // legitimately collapses names that humans treated as distinct).
      ai.helpers_mentioned = ai.helpers_mentioned.map(h => typeof h === 'string' ? resolveLastname(h) : h);
      const seen = new Set();
      ai.helpers_mentioned = ai.helpers_mentioned.filter(h => {
        if (ai.assignee_hint && h === ai.assignee_hint) return false;
        if (seen.has(h)) return false;
        seen.add(h);
        return true;
      });
      for (const h of ai.helpers_mentioned) {
        if (typeof h !== 'string' || /\s/.test(h)) throw new Error(`action_item.helpers_mentioned must be lastnames only (no whitespace): ${JSON.stringify(h)}`);
        // red-team rec 2: reject Slack/mention control chars (Unicode-safe).
        if (/[<>@!#&|]/.test(h)) throw new Error(`action_item.helpers_mentioned has forbidden control char: ${JSON.stringify(h)}`);
      }
    }
    if (ai.direction !== undefined && ai.direction !== null && !VALID_DIRECTION.has(ai.direction)) {
      throw new Error(`action_item.direction invalid: "${ai.direction}"`);
    }
    if (ai.linear_ref_hint !== undefined && ai.linear_ref_hint !== null) {
      // V1.5.5 (2026-05-22): tolerant — linear_ref_hint is informational
      // (suggests existing Linear issue to comment on, vs creating new).
      // Anthropic occasionally emits bare numbers ("36538") or partial refs.
      // Hard-fail used to kill entire pipeline (exec 50, Dev Team Daily).
      // Now: keep value if matches [A-Z]{2,5}-\d+ shape, drop to null + warn
      // otherwise. Downstream Linear handler will skip "comment on existing"
      // path and fall back to "create new" — same outcome as null.
      if (typeof ai.linear_ref_hint !== 'string' || !/^[A-Z]{2,5}-\d+$/.test(ai.linear_ref_hint)) {
        console.warn(`[parse-anthropic-response] dropping malformed linear_ref_hint "${ai.linear_ref_hint}" — expected [A-Z]{2,5}-\\d+ shape`);
        ai.linear_ref_hint_original = ai.linear_ref_hint;
        ai.linear_ref_hint = null;
      }
    }
    if (ai.voice_marker !== undefined && ai.voice_marker !== null && !VALID_VOICE_MARKER.has(ai.voice_marker)) {
      throw new Error(`action_item.voice_marker invalid: "${ai.voice_marker}"`);
    }
  }
}

// n8n HTTP Request node REPLACES $json with the response body — upstream
// pipeline fields (topic, start_time, duration_min, …) are NOT
// in $input here. We pull them back via $('Build Anthropic body'), the last
// upstream Code node that holds the full item snapshot before the HTTP call.
const items = $input.all();
const out = items.map((it, idx) => {
  const respJson = it.json;
  // Anthropic Messages API: response.content[0].text contains model output.
  const respBody = respJson.body || respJson;
  const content  = respBody?.content;
  const text     = Array.isArray(content) && content[0]?.text;
  // V1.7.13 (2026-06-12): tolerant parse with graceful degradation. Tries
  // strict JSON.parse → common repairs (trailing comma, unescaped inner
  // quote) → regex-extract critical fields. Pipeline now survives Anthropic's
  // occasional malformed-JSON output (observed in prod on a legal call:
  // unescaped ASCII quotes inside non-English markdown broke the parse).
  const { obj: parsed, repair: parse_repair, warning: parse_warning } = tolerantExtractJson(text);
  if (parse_repair !== 'strict') {
    console.warn(`[parse-anthropic-response] tolerant parse engaged: ${parse_repair}`);
  }
  // V1.5.7 (2026-05-22): better diagnostic if parse fails — surface stop_reason
  // and output_tokens so it's obvious whether to bump max_tokens vs fix prompt.
  if (!parsed || typeof parsed !== 'object') {
    const stopReason  = respBody?.stop_reason || '?';
    const outputToks  = respBody?.usage?.output_tokens ?? '?';
    const textLen     = (text || '').length;
    throw new Error(
      `Anthropic JSON parse failed even with tolerant pass — stop_reason=${stopReason}, ` +
      `output_tokens=${outputToks}, text_chars=${textLen}. ` +
      `Likely max_tokens cap hit — bump in build-anthropic-body.js. ` +
      `First 200 chars: ${(text || '').slice(0, 200)}`
    );
  }
  // V1.5.26 (P2-3 fix): parse succeeded but Anthropic hit max_tokens cap →
  // output is truncated. Surface as a non-fatal warning that downstream Slack
  // thread reply can render. Without this, truncation was silent — summaries
  // would just be missing tail sections (last action items, last decisions).
  const stop_reason_observed = respBody?.stop_reason;
  const truncation_warning = stop_reason_observed === 'max_tokens'
    ? `⚠️ Summary truncated by Anthropic max_tokens cap (output_tokens=${respBody?.usage?.output_tokens ?? '?'}). Some action items / decisions may be missing. Bump max_tokens in build-anthropic-body.js if recurring.`
    : null;
  assertSchema(parsed);

  // Upstream context — reach back into Build Anthropic body, which carries
  // every field we need downstream (commit payload + Slack root blocks).
  const upstream = $('Build Anthropic body').all()[idx]?.json || {};

  // V1.7.1 (2026-06-09): participants_lastnames is now strictly Zoom's truth.
  // The V1.5.27 fallback that derived participants from action_items[].assignee_hint
  // was added to keep the «Participants:» line in Slack alive when Zoom returned
  // 0 participants — but it conflated *assignees* with *attendees*: a solo
  // call mentioning "give X to A and Y to B" expanded participants
  // to [A, B] even though neither was on the call. Wrong > empty.
  // Now: trust Zoom. If Zoom delivered 0, downstream Slack/filename simply
  // omits the participants segment.
  const participants_lastnames = Array.isArray(upstream.participants_lastnames) ? upstream.participants_lastnames : [];
  const participants_source = upstream.participants_source || 'zoom_webhook';

  // F4-M1: dominant call language for the vault frontmatter (`language`,
  // required by validate-vault.js). Prefer the model's detected_language when
  // the response carries one (ISO 639-1 shape); otherwise detect from the
  // narrative output — per the LANGUAGE clause it mirrors the transcript.
  const language = /^[a-z]{2}$/.test(String(parsed.detected_language || ''))
    ? parsed.detected_language
    : detectNarrativeLanguage(
        [parsed.slack_summary].concat(parsed.action_items.map(ai => ai.title || '')).join('\n'));

  return {
    json: {
      ...upstream,           // topic, start_time, duration_min, participants_*, vtt_content, zoom_share_url, …
      // Pass through the upstream (extract-metadata) resolution so Slack
      // thread, vault filename, and TaskCrafter all see the same list.
      participants_lastnames,
      participants_source,
      // F4-M1: consumed by build-commit-payload-v2.js frontmatter `language`.
      language,
      anthropic_response: {  // keep raw response metadata for debugging, scoped under one key
        model       : respJson.model,
        id          : respJson.id,
        usage       : respJson.usage,
        stop_reason : respJson.stop_reason,
      },
      // V1.5.26 (P2-3): non-null when output was truncated by max_tokens cap;
      // build-slack-thread-reply.js prepends a warning banner to thread.
      anthropic_truncation_warning: truncation_warning,
      // V1.7.13 (2026-06-12): non-null when tolerant parse engaged a repair.
      // Lets downstream surface the degraded state to thread + DLQ.
      anthropic_parse_repair: parse_repair !== 'strict' ? parse_repair : null,
      anthropic_parse_warning: parse_warning || null,
      classification: {
        team           : parsed.team_tag,
        sub_tag        : parsed.sub_tag || null,
        call_type      : parsed.call_type || 'unspecified',
        tags           : parsed.tags,
        topic_slug     : parsed.topic_slug,
        ...(parsed.topic_slug_truncated_from ? { topic_slug_truncated_from: parsed.topic_slug_truncated_from } : {}),
        confidence     : parsed.confidence,
      },
      summary         : parsed.slack_summary,
      action_items    : parsed.action_items.map(ai => ({
        // V1.4 — defaults for back-compat: if Anthropic omits new fields, treat as post-call with no helpers.
        status            : ai.status            || 'post-call',
        helpers_mentioned : Array.isArray(ai.helpers_mentioned) ? ai.helpers_mentioned : [],
        direction         : ai.direction         || null,
        linear_ref_hint   : ai.linear_ref_hint   || null,
        voice_marker      : ai.voice_marker      || null,
        ...ai,  // original fields trump defaults if present (no-op when defaults match)
      })),
      decisions       : parsed.decisions       || [],
      open_questions  : parsed.open_questions  || [],
      key_insights    : parsed.key_insights    || [],
      // sensitive_flags removed V1.5.6 — see backlog #17 for re-enable plan
      next_24_48h     : parsed.next_24_48h     || [],
    },
  };
});

return out;
