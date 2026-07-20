// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 6 — build Linear GraphQL mutation per approved task.
//
// Input: action items from 11-parse-slack-action (one per task).
// Output: GraphQL mutation + variables ready for HTTP node. Bypasses Linear
//         entirely for skip/bulk_skip/idempotent paths.
//
// Mutations covered:
//   approve_create → issueCreate
//   approve_comment → commentCreate
//   approve_update → issueUpdate (state/assignee/priority)
//
// V0.1 (2026-05-28): Phase 2 initial.

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

// M-promptinj (deep layer, output-side sink guard): the issue title / body /
// comment are transcript-derived (Normalizer → Composer). Before they become a
// REAL tracker write, defuse any broadcast mention (@channel / @here /
// @everyone) or Slack/Linear control payload (<!channel>, <!subteam^…>, <@U…>,
// <#C…>) the model may have carried out of a poisoned transcript. Same intent
// as the digest Slack escaping — insert a zero-width space so the token no
// longer fires while the text stays readable (lossless, nothing dropped).
const ZW = '\u200b'; // U+200B zero-width space
function defuseSink(s) {
  if (s === null || s === undefined) return s;
  return String(s)
    .replace(/@(?=(?:here|channel|everyone)\b)/gi, `@${ZW}`)
    .replace(/<(?=[@#!])/g, `<${ZW}`)
    // red-team rec 3: break dangerous URL schemes so a composer-emitted
    // javascript:/data:/vbscript: link can't reach the tracker write as a live
    // link (lossless \u2014 inserts a zero-width space after the scheme name).
    .replace(/\b(javascript|data|vbscript)(?=:)/gi, `$1${ZW}`);
}

const ISSUE_CREATE = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title url assignee { id displayName } state { name } }
  }
}`;

const COMMENT_CREATE = `
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body url issue { id identifier url } }
  }
}`;

const ISSUE_UPDATE = `
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier title url assignee { id displayName } state { name } }
  }
}`;

const items = $input.all();
const out = [];

for (const it of items) {
  const j = it.json || {};
  const kind = j.__action_kind;

  // Pass through non-Linear paths unchanged — downstream node will skip if no mutation
  if (kind === 'skip_single' || kind === 'bulk_skip' || kind === 'idempotent' ||
      kind === 'bulk_noop' || kind === 'unknown' || !j.task) {
    out.push({ json: j });
    continue;
  }

  const task = j.task;
  const pl = task.router_payload || {};

  if (kind === 'approve_create') {
    const input = {
      teamId: pl.teamId,
      // defuseSink: transcript-derived title/body must not smuggle broadcast
      // mentions or Slack/Linear control payloads into the real tracker write.
      title: defuseSink(pl.title || task.title),
      description: defuseSink(pl.description_markdown || `_(no description composed)_`),
      stateId: pl.stateId,
      priority: pl.priority || 3,
      labelIds: pl.labelIds || [],
    };
    if (pl.assigneeId) input.assigneeId = pl.assigneeId;
    out.push({
      json: {
        ...j,
        __linear_mutation: 'issueCreate',
        query: ISSUE_CREATE,
        variables: { input },
      },
    });
  } else if (kind === 'approve_comment') {
    const input = {
      issueId: pl.target_issue_id,
      // defuseSink: same output-side guard as create — the comment body is
      // transcript-derived (Composer) and must not carry broadcast/control tokens.
      body: defuseSink(pl.comment_markdown || `_(no comment composed) — ref: call ${j.call_uuid?.slice(0, 12)}_`),
    };
    out.push({
      json: {
        ...j,
        __linear_mutation: 'commentCreate',
        query: COMMENT_CREATE,
        variables: { input },
      },
    });
  } else if (kind === 'approve_update') {
    const id = pl.target_issue_id;
    const input = {};
    // V0.9 (2026-06-02, P0-5 fix): explicit warning when target_state_name is
    // requested but we don't have stateId lookup yet. Previously silently set
    // stateId=null which made the update look successful in Slack but status
    // part was dropped (silent data loss on planning calls).
    const warnings = [];
    if (pl.target_state_name) {
      warnings.push(`status_update_unsupported: requested "${pl.target_state_name}" — stateId lookup not implemented; please update Status manually in Linear`);
    }
    if (pl.target_assignee_id) input.assigneeId = pl.target_assignee_id;
    if (pl.target_priority) input.priority = pl.target_priority;

    // If no actual update fields after dropping unsupported state — skip Linear
    // write entirely, emit a warning-only item that downstream handler shows in
    // Slack thread instead of pretending success.
    if (Object.keys(input).length === 0) {
      out.push({
        json: {
          ...j,
          __linear_mutation: null,
          __taskcrafter_warning: warnings.join('; ') || 'no_update_fields',
          __response_text: fmt(S['tasks.update_not_applied'], { warnings: warnings.join('; ') || 'no_update_fields' }),
        },
      });
    } else {
      out.push({
        json: {
          ...j,
          __linear_mutation: 'issueUpdate',
          query: ISSUE_UPDATE,
          variables: { id, input },
          __taskcrafter_warning: warnings.length ? warnings.join('; ') : null,
        },
      });
    }
  } else {
    out.push({ json: { ...j, __taskcrafter_error: 'unknown_kind_at_mutation_build', kind } });
  }
}

return out;
