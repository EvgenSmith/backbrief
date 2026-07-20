// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 6 — handle Linear write result + post Slack confirmation.
//
// Input: either:
//   (a) Linear mutation response (HTTP node ran successfully) with `data.issueCreate.issue` etc.
//   (b) Skip/idempotent/noop pass-through items from 11-parse-slack-action.
//
// Output: posts message to Slack via response_url (ephemeral) AND to thread,
//         updates pending.executed[task_id] in staticData (idempotency mark).
//
// For Linear writes, we use response_url for an ephemeral acknowledgement to
// the clicker, and post a thread reply visible to everyone with the Linear URL.
//
// V0.1 (2026-05-28): Phase 2 initial.

const items = $input.all();
const out = [];
const data = $getWorkflowStaticData('global');

// SLACK_USER_ID_BY_LASTNAME comes from the TENANT_ROSTER region — ONE
// rendered region, three consumers (main thread-reply, 09b, 13); the prod
// triple-drift is gone. UI strings (S) come from the TENANT_LANG region.

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

// {placeholder} interpolation for ui_strings templates (language packs).
function fmt(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) =>
    (vars && vars[k] !== undefined && vars[k] !== null) ? String(vars[k]) : '');
}

// Resolve a routed lastname → Slack mention. Returns a real <@id> ping when the
// person is mapped (so they get notified), bold name as a visible-but-silent
// fallback when the lastname is known but unmapped.
function slackMention(lastname) {
  if (!lastname) return null;
  const id = SLACK_USER_ID_BY_LASTNAME[lastname];
  return id ? `<@${id}>` : `*${lastname}*`;
}

// V1.4 (2026-06-08): reconcile cross-call dedup state. Stage 05 (matcher-decide)
// records drafts in taskcrafter_drafts_by_uuid with outcome='pending' and relies
// on the Executor to overwrite them with the final outcome. That overwrite was
// never wired — drafts stayed 'pending' forever, so real created/commented tasks
// fell out of the dedup index after the 48h pending TTL instead of the 14d
// confirmed TTL, defeating cross-call dedup on recurring (weekly) calls.
function markDraftOutcome(callUuid, taskId, resultOutcome) {
  if (!callUuid || !taskId) return;
  const entry = data.taskcrafter_drafts_by_uuid?.[callUuid];
  if (!entry || !Array.isArray(entry.drafts)) return;
  let mapped;
  if (resultOutcome === 'created' || resultOutcome === 'commented' || resultOutcome === 'updated') {
    mapped = resultOutcome;                       // confirmed → 14d TTL, keeps blocking dupes
  } else if (resultOutcome === 'skipped' || resultOutcome === 'skipped_with_warning') {
    mapped = 'skipped';                           // skipped → never blocks future creates
  } else {
    return;                                       // failed/unknown → leave 'pending' (re-proposable)
  }
  const draft = entry.drafts.find(d => d.task_id === taskId);
  if (draft) draft.outcome = mapped;
}

// Reach back to Build Linear mutation for action context — when Linear HTTP node
// ran, it replaced $json with the Linear API response (data.issueCreate etc).
// The original __action_kind, task, channel, response_url etc are otherwise lost.
//
// V1.7.5 (2026-06-09) bulk-approve safety: previously the .first() fallback
// silently returned task-0's context for ALL items when itemMatching failed —
// so on bulk fan-out (N>1), every Linear write was reported under task[0]'s
// identity (wrong outcome attribution, wrong thread message). Now: positional
// `.all()[idx]` access keeps each item paired correctly; .first() only fires
// when idx===0 (single-task case).
function recoverContext(it, idx) {
  // First try: input item already has context (passthrough branch from IF false)
  const j = it.json || {};
  if (j.__action_kind) return j;

  // Second: reach back via pairedItem to Build Linear mutation
  try {
    const upstream = $('Build Linear mutation').itemMatching(idx);
    if (upstream && upstream.json && upstream.json.__action_kind) {
      return { ...upstream.json, ...j };
    }
  } catch (e) { /* itemMatching may fail in some n8n versions */ }

  // Third: positional fallback via .all()[idx] — keeps fan-out items aligned
  try {
    const all = $('Build Linear mutation').all();
    if (Array.isArray(all) && idx < all.length && all[idx] && all[idx].json && all[idx].json.__action_kind) {
      return { ...all[idx].json, ...j };
    }
    // Single-task case: .first() is safe only when idx===0
    if (idx === 0) {
      const first = $('Build Linear mutation').first();
      if (first && first.json && first.json.__action_kind) {
        return { ...first.json, ...j };
      }
    } else {
      console.warn(`[stage-13] recoverContext: idx=${idx} out of bounds in Build Linear mutation.all() (len=${all && all.length}); refusing to use first() to avoid mis-attribution`);
    }
  } catch (e) { /* */ }

  // Fourth: last-resort positional from Parse Slack action — same idx-bounded rule
  try {
    const pa = $('Parse Slack action').all();
    if (Array.isArray(pa) && idx < pa.length && pa[idx] && pa[idx].json) {
      return { ...pa[idx].json, ...j };
    }
  } catch (e) { /* */ }

  return j;
}

for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const j = recoverContext(it, i);
  const kind = j.__action_kind;
  const message_ts = j.message_ts;
  const response_url = j.response_url;
  const channel = j.channel;
  const thread_ts = j.thread_ts;
  const user = j.user;
  const task = j.task;

  let result_outcome = 'unknown';
  let result_linear_id = null;
  let result_linear_identifier = null;
  let result_linear_url = null;
  let thread_text = null;
  let ephemeral_text = null;

  if (kind === 'skip_single' || kind === 'bulk_skip') {
    result_outcome = 'skipped';
    ephemeral_text = fmt(S['tasks.skipped'], { title: task?.title?.slice(0, 80) || '?' });
    // V1.7.22: give a single skip a VISIBLE thread confirmation. The V1.7.21
    // filter (bottom of file) drops ephemeral-only outcomes and the response_url
    // ephemeral ack was never wired, so a skip click produced no feedback at all
    // (user-reported regression: skip clicks looked dead). skip_single carries channel+thread_ts
    // (11-parse-slack-action), so a thread post delivers. bulk_skip stays quiet
    // to avoid N "Skipped" lines when clearing the whole queue.
    if (kind === 'skip_single') thread_text = ephemeral_text;
  } else if (kind === 'idempotent') {
    // already done — just ephemeral notice, no thread post
    out.push({
      json: {
        __taskcrafter_stage: 'result-handled',
        __skip_response: false,
        slack_response_url: response_url,
        ephemeral_text: j.__response_text || S['tasks.already_executed_short'],
        thread_text: null,
        channel, thread_ts,
      },
    });
    continue;
  } else if (kind === 'bulk_noop') {
    out.push({
      json: {
        __taskcrafter_stage: 'result-handled',
        slack_response_url: response_url,
        ephemeral_text: j.__response_text || S['tasks.nothing_left'],
        thread_text: null,
        channel, thread_ts,
      },
    });
    continue;
  } else if (kind === 'approve_create' || kind === 'approve_comment' || kind === 'approve_update') {
    // V0.9 (2026-06-02, P0-5): warning-only items (Linear call skipped by 12
    // because no supported fields remain — e.g. update_status without stateId
    // lookup). Surface the warning instead of pretending success/failure.
    if (j.__linear_mutation === null && j.__taskcrafter_warning) {
      result_outcome = 'skipped_with_warning';
      thread_text = j.__response_text || `⚠️ ${j.__taskcrafter_warning}`;
      ephemeral_text = thread_text;
      // fall through to persist + emit
      if (task?.id && message_ts) {
        const pending = data.taskcrafter_pending?.[message_ts];
        if (pending) {
          pending.executed = pending.executed || {};
          pending.executed[task.id] = {
            outcome: result_outcome,
            warning: j.__taskcrafter_warning,
            by_user: user, at: new Date().toISOString(),
          };
        }
        markDraftOutcome(j.call_uuid, task.id, result_outcome);
      }
      out.push({
        json: {
          __taskcrafter_stage: 'result-handled',
          task_id: task?.id, result_outcome,
          slack_response_url: response_url, ephemeral_text, thread_text,
          channel, thread_ts,
        },
      });
      continue;
    }

    // Linear response should be in j.data
    const respData = j.data || {};
    const errs = j.errors;
    if (errs && errs.length > 0) {
      result_outcome = 'failed';
      // V1.5.28 (2026-06-03): detect specific Linear errors and format
      // actionable warnings instead of raw GraphQL dumps.
      const firstErr = errs[0] || {};
      const ext = firstErr.extensions || {};
      const code = ext.code || '';
      const presentable = ext.userPresentableMessage || firstErr.message || 'unknown error';
      if (code === 'FORBIDDEN' && /does not have access to this team|not a member/i.test(presentable)) {
        // Common case: Anthropic correctly inferred team + assignee independently,
        // but the assignee is not a member of that team in Linear (e.g. Lera in
        // GEN but task content goes to STR). Tell user what to do.
        const teamId = task?.router_payload?.teamId || 'unknown';
        const assigneeLastname = task?.router_payload?.assigneeLastname
          || task?.owner_lastname
          || 'assignee';
        thread_text = fmt(S['tasks.tracker_forbidden_member'], { assignee: assigneeLastname });
      } else {
        thread_text = fmt(S['tasks.tracker_failed'], { mutation: j.__linear_mutation, code: code || 'error', message: presentable.slice(0, 200) });
      }
      ephemeral_text = thread_text;
    } else if (kind === 'approve_create' && respData.issueCreate?.success) {
      const issue = respData.issueCreate.issue;
      result_outcome = 'created';
      result_linear_id = issue.id;
      result_linear_identifier = issue.identifier;
      result_linear_url = issue.url;
      // V1.7.20 (2026-06-16): @-mention the assignee in the creation confirmation
      // so they get a Slack notification and don't miss the new task. Previously we
      // printed the Linear displayName as plain text (no ping). Resolve the Slack
      // mention from the routed lastname — same map as the 09b proposal card.
      const createdAssigneeLastname = task?.router_payload?.assigneeLastname || task?.owner_lastname || null;
      const createdAssigneeMention = slackMention(createdAssigneeLastname);
      let createdAssigneeSuffix;
      if (createdAssigneeMention) {
        createdAssigneeSuffix = fmt(S['tasks.assigned_to_suffix'], { mention: createdAssigneeMention });
      } else if (issue.assignee?.displayName) {
        createdAssigneeSuffix = fmt(S['tasks.assigned_to_suffix'], { mention: issue.assignee.displayName });
      } else {
        createdAssigneeSuffix = S['tasks.unassigned_suffix'];
      }
      thread_text = fmt(S['tasks.created_confirm'], { url: issue.url, identifier: issue.identifier, title: issue.title, assignee_suffix: createdAssigneeSuffix });
      ephemeral_text = thread_text;
    } else if (kind === 'approve_comment' && respData.commentCreate?.success) {
      const comment = respData.commentCreate.comment;
      const issueRef = comment.issue;
      result_outcome = 'commented';
      result_linear_id = issueRef.id;
      result_linear_identifier = issueRef.identifier;
      result_linear_url = issueRef.url;
      thread_text = fmt(S['tasks.comment_added'], { url: issueRef.url, identifier: issueRef.identifier });
      ephemeral_text = thread_text;
    } else if (kind === 'approve_update' && respData.issueUpdate?.success) {
      const issue = respData.issueUpdate.issue;
      result_outcome = 'updated';
      result_linear_id = issue.id;
      result_linear_identifier = issue.identifier;
      result_linear_url = issue.url;
      thread_text = fmt(S['tasks.updated_confirm'], { url: issue.url, identifier: issue.identifier, state: issue.state?.name || '' })
                  + (issue.assignee?.displayName ? ` · ${issue.assignee.displayName}` : '');
      ephemeral_text = thread_text;
    } else {
      result_outcome = 'failed';
      thread_text = fmt(S['tasks.tracker_no_success'], { mutation: j.__linear_mutation, payload: JSON.stringify(respData).slice(0, 200) });
      ephemeral_text = thread_text;
    }
  } else {
    // unknown kind — pass through error
    out.push({
      json: {
        __taskcrafter_stage: 'result-handled',
        slack_response_url: response_url,
        ephemeral_text: fmt(S['tasks.unknown_action_kind'], { kind }),
        channel, thread_ts,
      },
    });
    continue;
  }

  // Persist idempotency mark
  if (task?.id && message_ts) {
    const pending = data.taskcrafter_pending?.[message_ts];
    if (pending) {
      pending.executed = pending.executed || {};
      pending.executed[task.id] = {
        outcome: result_outcome,
        linear_id: result_linear_id,
        linear_identifier: result_linear_identifier,
        linear_url: result_linear_url,
        by_user: user,
        at: new Date().toISOString(),
      };
    }
    markDraftOutcome(j.call_uuid, task.id, result_outcome);
  }

  out.push({
    json: {
      __taskcrafter_stage: 'result-handled',
      task_id: task?.id,
      result_outcome,
      result_linear_id,
      result_linear_identifier,
      result_linear_url,
      slack_response_url: response_url,
      ephemeral_text,
      thread_text,
      channel,
      thread_ts,
    },
  });
}


// V1.7.21 (2026-06-18) — the only downstream of this node is the Slack
// chat.postMessage thread-reply node (channelId = $json.channel). Ephemeral-only
// outcomes (skip / "already done" / no-pending) carry thread_text=null and often
// no channel (response_url posting was never wired), so they reached postMessage
// with an empty channel -> Slack invalid_arguments -> whole execution errored
// (exec 818). All staticData/idempotency side-effects already ran in the loop
// above, so it is safe to emit ONLY items that have a real thread destination.
// Ephemeral acks are dropped (they never delivered — they crashed); restoring
// them needs a response_url HTTP node (separate change).
return out.filter(o => o.json && o.json.channel && o.json.thread_text);
