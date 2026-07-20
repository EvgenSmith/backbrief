// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — runs after a per-branch "Mark" Set-node has set
// $json.__branch ∈ {"created","duplicate","error"}.
//
// V1.4.1 — IMPORTANT FIX: previously we tried Block Kit rendering via
// `blocksUi: ={{ JSON.stringify($json.blocks) }}` on the Slack v2.2 node.
// Empirically that pattern does NOT work — n8n's Slack node treats the
// JSON-stringified array as a single string, Slack auto-converts it into
// one rich_text block, and only the `text` fallback ends up visible.
// (Confirmed via exec 27 output: 14 blocks emitted, Slack received 1.)
//
// Solution: put FULL content in `text` field as Slack mrkdwn. Keep messages
// split into 4 (Summary / Decisions+Insights / Action items / Vault) so the
// thread structure stays the same. Workflow node also switched to
// messageType: text.
//
// Future V1.5: replace Slack v2.2 node with HTTP Request to chat.postMessage
// for proper Block Kit (real header blocks, dividers, contexts with @-pings
// only on Tasks). For now mrkdwn-text is what reliably renders.

// Slack @-mention map (lastname → user_id). Section blocks DO ping; context
// blocks DON'T. In mrkdwn text mode, ALL @-mentions ping by default. To
// suppress a ping for Done/Monitoring sections we simply don't mention there.
//
// SLACK_USER_ID_BY_LASTNAME comes from the TENANT_ROSTER region — ONE
// rendered region, three consumers (this file, taskcrafter 09b, taskcrafter
// 13). That kills the prod triple-drift the old hand-kept copies had.
// UI strings come from the TENANT_LANG region (S table, language packs).

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
// ── __TENANT_SLACK_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const SLACK_ENABLED = true; // features.slack.enabled — false ⇒ builders post nothing
const OWNER_SLACK_USER_ID = ''; // deploy-resolved (test-creds.js slack)
const PUBLIC_CHANNEL_ID = '#call-digests'; // digest channel — name until deploy resolves the id
const DISPLAY_TIMEZONE = 'America/New_York';
// ── __TENANT_SLACK_END__ ──
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

function mention(lastname) {
  if (typeof lastname !== 'string' || !lastname) return null;
  const id = SLACK_USER_ID_BY_LASTNAME[lastname];
  // Escape the bold-name fallback (red-team rec 2): an unresolved lastname is
  // model-derived and could be "<!channel>"/"<@U…>" — escapeSlackText defangs
  // it so it can never fire as a live broadcast/mention.
  return id ? `<@${id}>` : `*${escapeSlackText(lastname)}*`;
}

// Non-pinging mention — used in Done/Monitoring sections so we don't notify
// people whose work is already finished or only being watched. Slack mrkdwn
// has no "silent mention" syntax (any <@U…> pings) — so fall back to bold name.
function mentionSilent(lastname) {
  if (typeof lastname !== 'string' || !lastname) return null;
  return `*${escapeSlackText(lastname)}*`;
}

// M-outinj: neutralize Slack control syntax in transcript/LLM-derived text so
// meeting content can't inject links (<url|text>), pings (<@U…>, <!channel>,
// <#C…>) or broadcast triggers. The three required escapes (& < >) defang every
// angle-bracket construct; we also break the bare broadcast keywords
// @here/@channel/@everyone. Applied ONLY to user/transcript values — our own
// static S[] labels and the real <@U…> mentions produced by mention() are left
// intact (those pings are intended).
function escapeSlackText(s) {
  if (s === null || s === undefined) return s;
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=(?:here|channel|everyone)\b)/gi, '@\u200b')
    // M-promptinj (3c): defuse dangerous URL schemes the model might emit so a
    // client that auto-links bare text can never form a javascript:/data:/vbscript:
    // link out of a summary/decision/insight. Zero-width space after the scheme colon.
    .replace(/\b(javascript|data|vbscript):/gi, '$1:\u200b');
}

// Convert standard markdown to Slack mrkdwn:
//   **bold** → *bold*
//   ### / ## headers → *bold line*  (Slack mrkdwn has no real headers)
//   - bullet → • bullet
function toSlackMrkdwn(md) {
  if (typeof md !== 'string') return '';
  return md
    .replace(/^#{2,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^- /gm, '• ');
}

function participantsLine(j) {
  const raw = Array.isArray(j.participants_lastnames) ? j.participants_lastnames : [];
  const names = raw
    .map(p => typeof p === 'string' ? p : (p?.lastname || null))
    .filter(n => typeof n === 'string' && n && !n.includes('?'));
  if (names.length === 0) return '';
  // Participants line uses silent mention (bold) to avoid pinging everyone
  // every time. Real pings happen on action items only.
  return fmt(S['main.participants_line'], { names: names.map(mentionSilent).join(', ') });
}

function renderActionLine(ai, idx, pingAssignee) {
  const title   = escapeSlackText(ai.title || '(no title)');
  const m       = pingAssignee ? mention : mentionSilent;
  const who     = ai.assignee_hint ? ` — ${m(ai.assignee_hint)}` : '';
  const helpers = Array.isArray(ai.helpers_mentioned) && ai.helpers_mentioned.length > 0
    ? ` _(+${ai.helpers_mentioned.map(m).join(', ')})_` : '';
  const prio    = ai.priority_hint ? ` _[${ai.priority_hint}]_` : '';
  const linRef  = ai.linear_ref_hint ? ` → \`${ai.linear_ref_hint}\`` : '';
  const voice   = ai.voice_marker ? ' 🎤' : '';
  return `${idx + 1}. ${title}${who}${helpers}${prio}${linRef}${voice}`;
}

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

const items = $input.all();
const out = [];

// M-slackflag: honor features.slack.enabled:false (SLACK_ENABLED from the
// TENANT_SLACK region). No Slack ⇒ no thread posts and no owner DMs; the vault
// commit already happened upstream, so a no-Slack tenant runs clean.
if (!SLACK_ENABLED) return [];

for (const it of items) {
  const j      = it.json;
  // V1.4 — when build-github-body emits dual items (md + vtt), only the md item
  // should drive Slack thread messages. Skip the transcript sibling silently.
  if (j.__file_kind === 'transcript') continue;
  const branch = j.__branch;
  if (!branch) throw new Error('build-slack-thread-reply: $json.__branch missing — upstream Mark node not wired');

  // V1.7.12 (2026-06-12): when reached via the error path (Anthropic /
  // Parse Anthropic onError → Mark error → DLQ writer → here), input item is
  // the raw Anthropic response or the DLQ envelope — neither carries
  // slack_root_ts. Fall back to Recording state lookup which has
  // prior_slack_root_ts persisted from Phase 1. Without this, error-branch
  // executions died with "slack_root_ts missing" and the DLQ note never
  // reached the thread (prod-observed on a legal call — the model emitted
  // invalid JSON → Parse threw → Phase 2 lost its anchor).
  let rootTs  = j.slack_root_ts || j.prior_slack_root_ts;
  let channel = j.slack_root_channel || j.prior_slack_channel;
  if (!rootTs || !channel) {
    try {
      const sl = $('Recording state lookup').first();
      if (sl && sl.json) {
        rootTs  = rootTs  || sl.json.prior_slack_root_ts || sl.json.slack_root_ts;
        channel = channel || sl.json.prior_slack_channel || sl.json.slack_root_channel;
      }
    } catch (e) { /* node may not have run in this exec */ }
  }
  // No thread root — DON'T throw. Throwing here killed the execution with no
  // DM/DLQ exactly in the scenario that nearly lost a prod board-call
  // artifact (oneshot + Slack root post channel_not_found: no root
  // ts exists, the error item lands here, the old throw silenced everything).
  // Instead emit a skip-thread item: "IF thread postable" routes it around the
  // Slack thread post straight to the owner-DM check, and dlq_dm_text (set by
  // DLQ writer) or a fallback text reaches the owner.
  if (!rootTs) {
    out.push({ json: {
      channel: null, thread_ts: null, text: '',
      __skip_thread_post: true,
      __branch: branch, __dm_owner_required: true, __thread_msg_idx: 0,
      dlq_dm_text: j.dlq_dm_text || [
        S['main.no_thread_root_header'],
        fmt(S['main.no_thread_root_topic'], { topic: escapeSlackText(j.topic || '(unknown)') }),
        fmt(S['main.no_thread_root_branch'], { branch }),
        (j.github_statusCode >= 200 && j.github_statusCode < 300)
          ? fmt(S['main.no_thread_root_vault_ok'], { path: j.vault_path || 'path unknown' })
          : S['main.no_thread_root_vault_unknown'],
      ].join('\n'),
    }});
    continue;
  }
  channel = channel || PUBLIC_CHANNEL_ID;

  const filename = j.filename   || '(unknown filename)';
  const url      = j.github_url || '';
  const ghStatus = j.github_statusCode || j.statusCode;
  const ghBody   = j.github_body_response || j.body || {};

  // ERROR branch
  // V1.7.20 (2026-06-24): the error path is reached from TWO very different
  // places — (a) the GitHub commit subgraph failed (github_statusCode is set),
  // or (b) an UPSTREAM step failed before the commit was ever attempted
  // (transcript download / Anthropic summary / parse → onError → Mark error).
  // Previously both printed "Vault commit failed — status undefined {}", which
  // mislabels (b) as a commit failure and hides the real cause (prod-observed:
  // an Anthropic call failed after 3 retries and never reached GitHub).
  // Now distinguish the two and surface any
  // error detail the n8n error-output item carries.
  if (branch === 'error') {
    const reachedCommit = (j.github_statusCode != null) || (j.statusCode != null);
    const errMsg = (j.error && (j.error.message || j.error.description))
                || (j.body && j.body.error && (j.body.error.message || j.body.error))
                || null;
    let text;
    if (reachedCommit) {
      text = `${fmt(S['main.commit_failed'], { status: ghStatus })}\n\`\`\`${JSON.stringify(ghBody).slice(0, 800)}\`\`\``;
    } else {
      text = S['main.upstream_failed']
           + (errMsg ? `\n\`\`\`${String(errMsg).slice(0, 600)}\`\`\`` : ` Check the n8n execution for the failed node (usually "Anthropic classify+summary+actions" or "Parse Anthropic response").`);
    }
    out.push({ json: {
      channel, thread_ts: rootTs,
      text,
      __branch: branch, __dm_owner_required: true, __thread_msg_idx: 0,
    }});
    continue;
  }

  // DUPLICATE branch
  if (branch === 'duplicate') {
    out.push({ json: {
      channel, thread_ts: rootTs,
      text: fmt(S['main.already_in_vault'], { url, filename }),
      __branch: branch, __dm_owner_required: false, __thread_msg_idx: 0,
    }});
    continue;
  }

  // CREATED branch — V1.4.1 emits up to 4 messages, ALL CONTENT in `text` field:
  //   1) Summary    — Participants + topic sections + bullets
  //   2) Decisions + Insights (if any)
  //   3) Action items (Tasks / Done / Monitoring)
  //   4) Vault link

  // === 1. Summary ===
  const summaryMd = (j.summary || '').trim();
  if (summaryMd) {
    const lines = [S['main.summary_header']];
    const pl = participantsLine(j);
    if (pl) lines.push(pl);
    if (j.vtt_download_failed) {
      lines.push(fmt(S['main.transcript_download_failed'], { status: j.vtt_download_failed_status || 'unknown' }));
    }
    // V1.5.26 (P2-3): Anthropic max_tokens cap hit during this call — output
    // truncated, summary may be missing tail sections. parse-anthropic-response
    // sets anthropic_truncation_warning when stop_reason === 'max_tokens'.
    if (j.anthropic_truncation_warning) {
      lines.push(`> ${j.anthropic_truncation_warning}`);
    }
    lines.push('');
    // M-outinj: escape transcript-derived summary before markdown conversion.
    lines.push(toSlackMrkdwn(escapeSlackText(summaryMd)));
    out.push({ json: {
      channel, thread_ts: rootTs,
      text: lines.join('\n'),
      __branch: branch, __dm_owner_required: false, __thread_msg_idx: 1,
    }});
  }

  // === 2. Decisions + Insights (V1.5.6 — sensitive_flags removed from flow) ===
  const decisions    = Array.isArray(j.decisions)    ? j.decisions    : [];
  const key_insights = Array.isArray(j.key_insights) ? j.key_insights : [];
  if (decisions.length > 0 || key_insights.length > 0) {
    const lines = [];
    if (decisions.length > 0) {
      lines.push(fmt(S['main.decisions_header'], { count: decisions.length }));
      for (const [i, d] of decisions.entries()) {
        const ctx = d.context ? ` — _${escapeSlackText(d.context)}_` : '';
        lines.push(`${i + 1}. *${escapeSlackText(d.title || '(no title)')}*${ctx}`);
      }
    }
    if (key_insights.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(fmt(S['main.insights_header'], { count: key_insights.length }));
      for (const [i, k] of key_insights.entries()) {
        const impl = k.implication ? ` → _${escapeSlackText(k.implication)}_` : '';
        lines.push(`${i + 1}. ${escapeSlackText(k.insight || '(no insight)')}${impl}`);
      }
    }
    out.push({ json: {
      channel, thread_ts: rootTs,
      text: lines.join('\n'),
      __branch: branch, __dm_owner_required: false, __thread_msg_idx: 1.5,
    }});
  }

  // === 3. Monitoring only (Tasks moved to the TaskCrafter sub-workflow) ===
  // Tasks block REMOVED from the main pipeline. The TaskCrafter sub-workflow
  // emits Tasks with full decisions (CREATE/COMMENT/SKIP/DUP/FLAG) and
  // Linear match info. Main pipeline keeps Monitoring (different concept — "watch
  // but no action", TaskCrafter doesn't process these).
  const action_items = Array.isArray(j.action_items) ? j.action_items : [];
  if (action_items.length > 0) {
    const monitoring = action_items.filter(ai => ai.status === 'monitoring');

    if (monitoring.length > 0) {
      const lines = [];
      lines.push(fmt(S['main.monitoring_header'], { count: monitoring.length }));
      monitoring.forEach((ai, i) => lines.push(renderActionLine(ai, i, false /* no ping */)));
      out.push({ json: {
        channel, thread_ts: rootTs,
        text: lines.join('\n'),
        __branch: branch, __dm_owner_required: false, __thread_msg_idx: 2,
      }});
    }
  }

  // === 4. Vault link + "via Backbrief" footer ===
  // ONE footer per digest thread, on the closing message — the root post and
  // per-section messages stay clean (the bot display name already brands them).
  out.push({ json: {
    channel, thread_ts: rootTs,
    text: fmt(S['main.vault_link'], { url, filename })
      + '\n' + (S['main.digest_footer'] || '_via Backbrief_'),
    __branch: branch, __dm_owner_required: false, __thread_msg_idx: 3,
  }});
}

return out;
