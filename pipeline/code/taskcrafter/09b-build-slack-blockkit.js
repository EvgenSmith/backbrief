// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 5 (full) — build Slack Block Kit message with action buttons.
//
// Replaces plain-text preview. Each actionable task gets [✅ Approve][⏸ Skip]
// buttons. Bulk button [✅ Approve all safe] at the bottom.
//
// Slack action_id schema:
//   tc.approve.<task_id>          — per-task approve
//   tc.skip.<task_id>             — per-task skip
//   tc.approve_alt.<task_id>      — for FLAG: "Create new instead" alt path
//   tc.bulk_approve_safe          — bulk approve non-flagged tasks
//   tc.bulk_skip_all              — bulk skip
//
// V0.1 (2026-05-28): Phase 2 initial. No Edit modal yet (deferred to Phase 3).
// V0.7: planning mode — hide the "Approve all safe" bulk button + explicit
//       warning (prod feedback: 12 of 14 CREATE proposals on a planning call
//       were existing tasks; bulk-Approve auto-created a duplicate before
//       the host's review).

// V1.7 (2026-06-08) — discriminator collapsed inline.
//
// Previously 09a (build body) → Anthropic call → 09c (parse) → 09b. The
// discriminator is advisory-only and all 7 patterns (v1) are deterministic
// (matches on kind/score/duration/word-lists). Running them as JS removes a
// Claude round-trip, two nodes, and a failure surface — and behaves identically.
// If precision later requires semantic Pattern B (title-vs-quote meaning), add
// a single targeted LLM check just for it.
//
// Schema produced per task (identical to old 09c output, so the marker render
// at line ~118 needs no change): { verdict, confidence, concerns[] }.

// Discriminator word lists come from the TENANT_LANG region (language packs,
// unioned across tenant.languages; per-language lists were adversarially
// tuned in prod on a labeled set). Pattern LOGIC below (score
// bands, dual gates, compound bonus) is language-independent and ships as-is.
// UI strings (S) come from the same region.

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
// M-outinj: neutralize Slack control syntax in transcript/LLM-derived text
// (task titles, quotes, skip/flag reasons) rendered into BlockKit *mrkdwn*
// sections — blocks a poisoned transcript from injecting links (<url|text>),
// pings (<@U…>, <!channel>) or broadcast triggers into the preview. The three
// required escapes (& < >) defang every angle-bracket construct; broadcast
// keywords are broken too. Applied ONLY to user/transcript values — never to
// our static S[] labels or the real <@U…> mentions from mentionPing().
function escapeSlackText(s) {
  if (s === null || s === undefined) return s;
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=(?:here|channel|everyone)\b)/gi, '@\u200b')
    // M-promptinj (3c): defuse dangerous URL schemes the model might emit, so a
    // client that auto-links bare text can never form a javascript:/data:/vbscript:
    // link from meeting content. Zero-width space after the scheme colon.
    .replace(/\b(javascript|data|vbscript):/gi, '$1:\u200b');
}
// M-promptinj (canary, advisory): obvious jailbreak markers in transcript-derived
// task text. Not blocking \u2014 surfaces a marker line the reviewer sees in Slack.
const INJECTION_MARKERS = [
  /ignore (all |the )?(previous|prior|above) instructions/i,
  /disregard (the|all|your|previous|any) (system|instructions|prompt|rules)/i,
  /you are now/i,
  /new instructions\s*:/i,
];
function scanInjection(text) {
  const s = String(text == null ? '' : text);
  for (const re of INJECTION_MARKERS) if (re.test(s)) return true;
  return false;
}
function discContains(haystack, needles) {
  if (!haystack) return null;
  const h = String(haystack).toLowerCase();
  for (const n of needles) if (h.includes(n)) return n;
  return null;
}
function decisionToKind(d) {
  return d === 'create_new' ? 'CREATE'
    : d === 'comment_on_match' ? 'COMMENT'
    : d === 'flag_for_review' ? 'FLAG'
    : d === 'skip_match_done' ? 'DONE'
    : d === 'use_explicit_ref' ? 'UPDATE'
    : 'SKIP';
}
// Returns {verdict, confidence, concerns[]} — same shape as previous LLM output.
function runDiscriminator(t, callMode, callDurationMin) {
  const kind = decisionToKind(t.matcher_decision);
  // Never flag passive / already-handled / skip decisions.
  if (kind === 'DONE' || kind === 'SKIP' || kind === 'UPDATE') {
    return { verdict: 'ok', confidence: 0.5, concerns: [] };
  }
  const title = (t.router_payload && t.router_payload.title) || t.title || '';
  const quote = t.transcript_quote || '';
  const score = (typeof t.matcher_best_score === 'number') ? t.matcher_best_score : null;
  const ownerNull = !t.owner_lastname;
  const targetNull = !t.best_match_identifier;
  const mode = callMode || 'discovery';
  const dur = callDurationMin || 0;

  const concerns = [];
  let confidence = 0;
  let firedCount = 0;
  const bump = (delta, c) => { confidence = Math.max(confidence, delta); if (c) concerns.push(c); firedCount++; };

  // PATTERN A — possible existing-issue match (CREATE/FLAG in planning|mixed)
  // D.3 (2026-07-09): the two `recur` arms were dead in prod (gated on
  // score===null, never true while matcher_best_score was `||0`). The 05 fix now
  // emits real nulls, but the harness shows lone-recur is net-negative (+5 FP /
  // 0 TP on the 2026-07 labeled set — reproduces the 2026-06-15 rerun rejection).
  // Retire it; keep only the numeric score-band arms. Pattern G below now revives
  // automatically (it gates on the same real null).
  if ((kind === 'CREATE' || kind === 'FLAG') && (mode === 'planning' || mode === 'mixed')) {
    const inBand = score !== null && score >= 0.3 && score <= 0.85;
    const cont = discContains(title, DISC_CONTINUATION_PHRASES);
    if (inBand && cont) bump(0.85, fmt(S['disc.planning_score_token'], { score: score.toFixed(2), token: cont }));
    else if (inBand) bump(0.75, fmt(S['disc.planning_score'], { score: score.toFixed(2) }));
  }
  // PATTERN B — normalizer title drift (generic in title vs specific in quote)
  {
    const generic = discContains(title, DISC_GENERIC_ARTIFACTS);
    const specific = discContains(quote, DISC_SPECIFIC_ARTIFACTS);
    if (generic && specific && generic !== specific) {
      bump(0.75, fmt(S['disc.title_generalized'], { specific, generic }));
    }
  }
  // PATTERN C — owner null with no fallback target
  if (ownerNull && targetNull) bump(0.70, S['disc.owner_unresolved']);
  // PATTERN D — long planning CREATE (weak)
  if (kind === 'CREATE' && mode === 'planning' && dur >= 30) {
    bump(0.55, S['disc.long_planning']);
  }
  // PATTERN E — urgent without timebox in title
  if ((t.priority === 'urgent') && !discContains(title, DISC_TIME_MARKERS)) {
    bump(0.60, S['disc.urgent_no_deadline']);
  }
  // PATTERN F — FLAG near-miss
  if (kind === 'FLAG' && (mode === 'planning' || mode === 'mixed')
      && score !== null && score >= 0.40 && score <= 0.70) {
    bump(0.65, fmt(S['disc.flag_uncertain'], { score: score.toFixed(2) }));
  }
  // PATTERN G — discovery/mixed long CREATE without score
  // V1.7.16: added infra-keyword exclusion. n8n/workflow/cron-setup conversations
  // produce legitimate new work; G was 0% TP-rate on those rows in 2026-06-15
  // rerun (4/4 FPs on a single infra-setup call alone). Skip G when title carries
  // an infra setup signal.
  if (kind === 'CREATE' && (mode === 'discovery' || mode === 'mixed')
      && score === null && dur >= 30
      && !discContains(title, DISC_INFRA_KEYWORDS)) {
    bump(0.55, S['disc.create_without_match']);
  }
  // PATTERN H — coordination call-to-decide (meeting, not a trackable deliverable)
  // Both gates required so an approved scoped prep-call title with a deadline
  // (call-verb, no decide-noun) never fires. 0 FP on the 349-row master set.
  if (kind === 'CREATE' || kind === 'FLAG') {
    const sched  = discContains(title, DISC_CALL_SCHEDULE_TOKENS);
    const decide = discContains(title, DISC_DECIDE_TOKENS);
    if (sched && decide) {
      bump(0.70, fmt(S['disc.call_to_decide'], { sched, decide }));
    }
  }
  // PATTERN I — chat/Slack-resolution item, not a tracked deliverable
  if (kind === 'CREATE' || kind === 'FLAG') {
    const chatres = discContains(title, DISC_CHAT_RESOLVE_TOKENS);
    if (chatres) {
      bump(0.65, fmt(S['disc.chat_resolve'], { token: chatres }));
    }
  }

  // Compound bonus: 2+ patterns → +0.10 (capped 0.95)
  if (firedCount >= 2) confidence = Math.min(0.95, confidence + 0.10);

  if (confidence < 0.5 || concerns.length === 0) {
    return { verdict: 'ok', confidence: 0.5, concerns: [] };
  }
  return { verdict: 'needs_review', confidence, concerns };
}

const DECISION_EMOJI = {
  create_new:           '✏️ CREATE',
  comment_on_match:     '💬 COMMENT',
  flag_for_review:      '⚠️ FLAG',
  use_explicit_ref:     '🔄 UPDATE',
  skip:                 '⏸ SKIP',
  skip_cross_call_dup:  '🔁 DUP',
  skip_match_done:      '🏁 DONE',
  skip_intra_batch_dup: '📋 BATCH-DUP',
  skip_same_target_dup: '🎯 SAME-TARGET',
};

// TEAM_DISPLAY comes from the TENANT_TRACKER region (deploy-resolved team
// names); SLACK_USER_ID_BY_LASTNAME from the TENANT_ROSTER region — ONE
// rendered region, three consumers (main thread-reply, 09b, 13): the prod
// triple-drift is gone.

// ── __TENANT_TRACKER_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const TRACKER_KIND = 'linear';
const VALID_TRACKER_TEAM = new Set(['ENG', 'GRW', 'PRD']); // config keys (team_mapping); null also valid
const TEAM_TO_ID = {}; // deploy-resolved team UUIDs (pipeline-state)
const TEAM_MAP = {}; // deploy-resolved: teamId + the team's Todo state
const USER_MAP = {}; // deploy-resolved tracker user ids by lastname
const LABEL_FROM_CALL_ID = null; // provenance label "backbrief", deploy-resolved
const TRACKER_URL_BASE = 'https://linear.app/your-workspace';
const TEAM_DISPLAY = {
  ENG: 'engineering',
  GRW: 'growth',
  PRD: 'product',
};
const COMMENT_THRESHOLD = 0.75;
const FLAG_THRESHOLD_DISCOVERY = 0.55;
const FLAG_THRESHOLD_PLANNING = 0.35;
const CROSS_CALL_TTL_DAYS_CONFIRMED = 14;
const CROSS_CALL_TTL_HOURS_PENDING = 48;
// ── __TENANT_TRACKER_END__ ──
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

function mentionPing(lastname) {
  if (!lastname) return '⚠️';
  const id = SLACK_USER_ID_BY_LASTNAME[lastname];
  // Escape the fallback (red-team rec 2) — an unresolved, model-derived name
  // could be "<!channel>"/"<@U…>"; defang so it can't fire as a broadcast.
  return id ? `<@${id}>` : `*${escapeSlackText(lastname)}*`;
}

function fmtPriority(p) {
  return ({ urgent: '🔴 urgent', high: '🟠 high', medium: 'medium', low: '🟢 low' })[p] || p || 'medium';
}

// Build Block Kit blocks for one task. Returns array of blocks.
function blocksForTask(idx, t) {
  const blocks = [];
  const pl = t.router_payload || {};
  const dec = t.matcher_decision;
  const label = DECISION_EMOJI[dec] || `❓ ${dec}`;
  // M-outinj: title is LLM/transcript-derived — escape before it enters mrkdwn.
  const title = escapeSlackText((pl.title || t.title || '(no title)').slice(0, 250));

  // === text section per decision ===
  let sectionText;
  if (dec === 'create_new') {
    // V1.7.22: show the ACTUAL routed team. The V1.5.30 assignee-home override
    // (resolveTeamForTask in 06-router) can route to a different team than the
    // LLM's team_inferred. Previously this preview showed team_inferred while the
    // write used the override → reviewer saw e.g. [Product] but the issue landed
    // in SUP. Show router_payload.teamName (the real destination) + an override
    // marker so the card never lies about where the task goes.
    const team = (pl.teamName || TEAM_DISPLAY[t.team_inferred] || t.team_inferred || '?')
      + (t.router_route_note ? ' ⤳override' : '');
    const owner = pl.assigneeLastname ? mentionPing(pl.assigneeLastname) : S['tasks.unassigned'];
    const prio = fmtPriority(t.priority);
    const lines = [`*${idx}. ${label}* [${team}] «${title}»`, `     → ${owner} · ${prio}`];
    if (t.voice_marker) lines.push('     ' + fmt(S['tasks.voice_trigger_line'], { marker: t.voice_marker }));
    if (t.transcript_quote) {
      const q = escapeSlackText(t.transcript_quote.slice(0, 140));
      const ts = t.source_ts_mmss ? ` (${t.source_ts_mmss})` : '';
      lines.push('     ' + fmt(S['tasks.quote_line'], { quote: q, ts }));
    }
    if (t.router_flag_for_triage) lines.push('     ' + fmt(S['tasks.triage_line'], { reason: escapeSlackText(t.router_flag_reason || 'manual review needed') }));
    sectionText = lines.join('\n');
  } else if (dec === 'comment_on_match' || dec === 'flag_for_review') {
    const target = pl.target_issue_identifier || '?';
    const score = t.matcher_best_score != null ? ` (score ${t.matcher_best_score.toFixed(2)})` : '';
    const link = pl.target_issue_url || `${TRACKER_URL_BASE}/issue/${target}`;
    const lines = [`*${idx}. ${label}* <${link}|${target}>${score}`, '     ' + fmt(S['tasks.new_context_line'], { title })];
    if (t.transcript_quote) lines.push('     ' + fmt(S['tasks.quote_line'], { quote: escapeSlackText(t.transcript_quote.slice(0, 140)), ts: '' }));
    sectionText = lines.join('\n');
  } else if (dec === 'use_explicit_ref') {
    const target = pl.target_issue_identifier || t.linear_ref_explicit || '?';
    // M-outinj: intent_change_value is transcript-derived (a reassign lastname /
    // status phrase) — escape it before it enters mrkdwn.
    const change = t.intent_change_value ? ` → ${escapeSlackText(t.intent_change_value)}` : '';
    const intent_short = (t.intent || '').replace(/^update_/, '').toUpperCase();
    const link = pl.target_issue_url || `${TRACKER_URL_BASE}/issue/${target}`;
    sectionText = `*${idx}. ${label}* <${link}|${target}> ${intent_short}${change}\n     «${title}»`;
  } else if (dec === 'skip') {
    sectionText = `*${idx}. ${label}* _${escapeSlackText(t.skip_reason)}_ — «${title}»`;
  } else if (dec === 'skip_cross_call_dup') {
    sectionText = `*${idx}. ${label}* _recently_drafted_ — «${title}»`;
  } else if (dec === 'skip_match_done') {
    const target = t.best_match_identifier || '?';
    const link = t.best_match_url || `${TRACKER_URL_BASE}/issue/${target}`;
    sectionText = `*${idx}. ${label}* <${link}|${target}> ${S['tasks.skip_match_done_note']} — «${title}»`;
  } else if (dec === 'skip_intra_batch_dup') {
    sectionText = `*${idx}. ${label}* ${fmt(S['tasks.intra_batch_dup_note'], { task_id: t.intra_batch_dup_of_task_id || '?' })} — «${title}»`;
  } else if (dec === 'skip_same_target_dup') {
    const target = t.best_match_identifier || '?';
    const link = t.best_match_url || `${TRACKER_URL_BASE}/issue/${target}`;
    sectionText = `*${idx}. ${label}* <${link}|${target}> ${fmt(S['tasks.same_target_dup_note'], { task_id: t.same_target_dup_of_task_id || '?' })} — «${title}»`;
  } else {
    sectionText = `*${idx}. ${label}* «${title}»`;
  }

  // V1.3 (2026-06-08) — discriminator v1 ⚠️ marker.
  // After Composer, discriminator-output node may have attached
  // {verdict, confidence, concerns[]}. If verdict=needs_review, append
  // a discreet marker line with concerns text. Confidence shown to let
  // user calibrate trust (high = strong signal; low = optional check).
  if (t.discriminator_output && t.discriminator_output.verdict === 'needs_review') {
    const concerns = (t.discriminator_output.concerns || []).slice(0, 2);
    const conf = t.discriminator_output.confidence;
    if (concerns.length > 0) {
      const confTag = typeof conf === 'number'
        ? (conf >= 0.8 ? 'high' : conf >= 0.65 ? 'medium' : 'low')
        : '';
      const concernText = concerns.map(c => `_${c}_`).join('; ');
      sectionText += '\n     ' + fmt(S['tasks.discriminator_line'], { confidence: confTag, concerns: concernText });
    }
  }

  blocks.push({
    type: 'section',
    block_id: `tc_text_${t.id}`,
    text: { type: 'mrkdwn', text: sectionText },
  });

  // === buttons per actionable decision ===
  // Most skips get NO buttons — already decided. Exception: skip_cross_call_dup
  // gets a single «➕ Create anyway» recovery button (see below).
  const actionable = ['create_new', 'comment_on_match', 'use_explicit_ref'].includes(dec);
  const needsAlt = dec === 'flag_for_review';

  if (actionable || needsAlt) {
    const elements = [];
    elements.push({
      type: 'button',
      action_id: `tc.approve.${t.id}`,
      text: { type: 'plain_text', text: dec === 'comment_on_match' ? S['tasks.btn_add_comment'] :
                                          dec === 'use_explicit_ref' ? S['tasks.btn_apply_update'] :
                                          needsAlt ? S['tasks.btn_comment_existing'] :
                                          S['tasks.btn_create_issue'] },
      style: 'primary',
      value: t.id,
    });
    if (needsAlt) {
      elements.push({
        type: 'button',
        action_id: `tc.approve_alt.${t.id}`,
        text: { type: 'plain_text', text: S['tasks.btn_create_instead'] },
        value: t.id,
      });
    }
    elements.push({
      type: 'button',
      action_id: `tc.skip.${t.id}`,
      text: { type: 'plain_text', text: S['tasks.btn_skip'] },
      value: t.id,
    });
    blocks.push({
      type: 'actions',
      block_id: `tc_act_${t.id}`,
      elements,
    });
  }

  // V1.7.27 (2026-07-09, D.2): cross-call-dup recovery button. skip_cross_call_dup
  // is a fingerprint (title|owner) match against a draft from the last 14d — on a
  // recurring weekly call THIS week's genuine instance gets suppressed with no way
  // to approve it from Slack (P1-6). Offer a single «➕ Create anyway» that forces a
  // create (11 swaps in router_payload_create_alt built in 06). No Approve/Skip pair
  // — the row is already dedup'd. Shown even when create_alt is null (team
  // unresolved): the click then degrades to 11's graceful-fail path, like flag.
  if (dec === 'skip_cross_call_dup') {
    blocks.push({
      type: 'actions',
      block_id: `tc_dupact_${t.id}`,
      elements: [{
        type: 'button',
        action_id: `tc.create_despite_dup.${t.id}`,
        text: { type: 'plain_text', text: S['tasks.btn_create_anyway'] },
        value: t.id,
      }],
    });
  }

  return blocks;
}

// === main ===
const items = $input.all();
const out = [];

for (const it of items) {
  const j = it.json || {};
  const no = j.normalizer_output;
  if (!no) {
    out.push({ json: { ...j, __taskcrafter_error: 'blockkit_no_normalizer' } });
    continue;
  }

  const counts = j.matcher_decision_counts || {};
  const triage = j.router_triage_count || 0;
  const total = (no.tasks || []).length;
  const filtered = no.filtered_count || 0;

  // V1.7 — run deterministic discriminator inline (replaces previous 09a/Anthropic/09c chain).
  for (const t of (no.tasks || [])) {
    t.discriminator_output = runDiscriminator(t, no.call_mode, j.duration_min || 0);
  }

  // Sort tasks: actionable first, skips last
  const order = { create_new: 1, comment_on_match: 2, flag_for_review: 3, use_explicit_ref: 4, skip: 9, skip_cross_call_dup: 9, skip_match_done: 9, skip_intra_batch_dup: 9, skip_same_target_dup: 9 };
  const sorted_tasks = (no.tasks || [])
    .map((t, i) => ({ t, original_idx: i }))
    .sort((a, b) => (order[a.t.matcher_decision] || 5) - (order[b.t.matcher_decision] || 5));

  // === build blocks ===
  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: fmt(S['tasks.header'], { count: total }) },
  });

  const meta_bits = [fmt(S['tasks.meta_mode'], { mode: no.call_mode })];
  if (filtered > 0) meta_bits.push(fmt(S['tasks.meta_filtered'], { count: filtered }));
  if (triage > 0) meta_bits.push(fmt(S['tasks.meta_triage'], { count: triage }));
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: meta_bits.join(' · ') }],
  });

  // M-promptinj (canary, advisory — visibility, NOT blocking): if any task's
  // transcript-derived title/quote carries obvious jailbreak markers, or an
  // upstream builder already flagged it, surface a single reviewer-visible line.
  // Buttons and routing are unchanged — this only tells the human to look twice.
  const canary_upstream = Array.isArray(j.__injection_canary) && j.__injection_canary.length > 0;
  const canary_here = (no.tasks || []).some(t => scanInjection(t.title) || scanInjection(t.transcript_quote));
  if (canary_upstream || canary_here) {
    console.warn('[blockkit] injection canary — a proposal carries jailbreak-shaped transcript text (advisory only, buttons unchanged)');
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '⚠️ _Heads up: the source transcript contains prompt-injection-shaped text (e.g. “ignore previous instructions”). Proposals below were summarized as data, not executed — but review each before approving._',
      }],
    });
  }

  // Warning banner for planning calls — bulk-approve disabled (matcher recall
  // is historically weak on planning calls; prod-observed).
  const is_planning = no.call_mode === 'planning' || no.call_mode === 'mixed';
  if (is_planning) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: S['tasks.planning_banner'],
      }],
    });
  }

  // V1.7.22: all-CREATE tripwire. The 2026-06-22 regression signature was a
  // planning call where EVERY proposal came back create_new (0 matches) — the
  // dedup/recall miss. Surface a loud banner so the reviewer never bulk-creates
  // duplicates when the matcher clearly found nothing. Guard for the still-open
  // RU-title↔EN-issue retrieval recall hole (see eval-matcher-recall docs).
  if (is_planning) {
    const decided = (no.tasks || []).filter(t =>
      ['create_new', 'comment_on_match', 'flag_for_review', 'use_explicit_ref'].includes(t.matcher_decision));
    const creates = decided.filter(t => t.matcher_decision === 'create_new').length;
    if (decided.length >= 4 && creates === decided.length) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: fmt(S['tasks.all_create_tripwire'], { count: creates }),
        }],
      });
    }
  }

  blocks.push({ type: 'divider' });

  // Per-task blocks.
  // V1.7.26 (2026-07-09): Slack hard-caps a message at 50 blocks; exceeding it
  // returns invalid_blocks and posts NOTHING — so a big planning call (~21+
  // actionable tasks × 2 blocks) would silently drop the entire preview AND all
  // Approve/Skip buttons. Cap the per-task blocks with headroom for the trailing
  // divider + bulk actions + footer + overflow note, and surface the remainder.
  const SLACK_BLOCK_LIMIT = 50;
  const TRAILING_RESERVE = 4; // divider + bulk-actions + footer + overflow note
  let truncated_tasks = 0;
  let blocks_capped = false;
  sorted_tasks.forEach(({ t }, displayIdx) => {
    if (blocks_capped) { truncated_tasks++; return; }
    const task_blocks = blocksForTask(displayIdx + 1, t);
    if (blocks.length + task_blocks.length > SLACK_BLOCK_LIMIT - TRAILING_RESERVE) {
      blocks_capped = true;
      truncated_tasks++;
      return;
    }
    blocks.push(...task_blocks);
  });
  if (truncated_tasks > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: fmt(S['tasks.truncation_note'], { count: truncated_tasks }) }],
    });
    console.log(`[blockkit] truncated ${truncated_tasks} task(s) to stay under Slack's 50-block limit`);
  }

  blocks.push({ type: 'divider' });

  // Bulk actions: only show if there are actionable non-flagged tasks.
  // V0.7: in planning mode hide "Approve all safe" (too risky — see banner above),
  // but keep "Skip all remaining" so reviewer can clear the queue.
  const safe_actionable = (no.tasks || []).filter(t =>
    ['create_new', 'comment_on_match', 'use_explicit_ref'].includes(t.matcher_decision)
  );
  if (safe_actionable.length > 0) {
    const bulk_elements = [];
    if (!is_planning) {
      bulk_elements.push({
        type: 'button',
        action_id: 'tc.bulk_approve_safe',
        text: { type: 'plain_text', text: fmt(S['tasks.btn_bulk_approve'], { count: safe_actionable.length }) },
        style: 'primary',
      });
    }
    bulk_elements.push({
      type: 'button',
      action_id: 'tc.bulk_skip_all',
      text: { type: 'plain_text', text: S['tasks.btn_bulk_skip'] },
      style: 'danger',
    });
    blocks.push({
      type: 'actions',
      block_id: 'tc_bulk',
      elements: bulk_elements,
    });
  }

  // Footer
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: S['tasks.footer'] }],
  });

  // Fallback text for notifications (and clients that don't render blocks)
  const fallback_text = fmt(S['tasks.fallback_text'], { count: total, counts: Object.entries(counts).map(([k,v]) => k+'='+v).join(', ') });

  out.push({
    json: {
      ...j,
      __taskcrafter_stage: 'blockkit-built',
      slack_blocks: blocks,
      slack_fallback_text: fallback_text,
      slack_preview_channel: j.slack_channel_id || null,
      slack_preview_thread_ts: j.slack_root_ts || null,
      slack_block_count: blocks.length,
    },
  });
}

return out;
