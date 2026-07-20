// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 6 — parse Slack interactivity payload.
//
// Input: webhook trigger body containing Slack `payload` (URL-encoded JSON).
//        Slack sends form-data with field "payload" — n8n webhook unwraps
//        as $json.body.payload (string).
//
// Output: per-task action items, fanned out to downstream Linear writes.
//         Action types: approve_create | approve_comment | approve_update |
//                       approve_alt_create | skip | bulk_approve | bulk_skip
//
// Looks up the original pending state from staticData by message_ts.
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

// ── B4 · Slack interactivity signature verification ──────────────────────────
// This is the entry Code node behind the `backbrief-taskcrafter-interaction`
// webhook. That endpoint performs REAL tracker writes on button clicks, so an
// unauthenticated URL lets anyone forge mutations. We verify Slack's request
// signature: X-Slack-Signature == 'v0=' HMAC-SHA256(signing_secret,
// 'v0:'+timestamp+':'+rawBody), with a ±300s freshness window (replay guard).
//
// SLACK_SIGNING_SECRET is injected at deploy (INJECT_SECRETS, see
// plugin/scripts/pipeline-nodes.js SECRETS). The repo keeps the placeholder, so
// when it still starts with '__' (offline tests / pre-deploy render) verification
// is SKIPPED — same activation guard as the Zoom verify node and the
// recording-state race guard. A real deploy injects the secret and rejects
// forged clicks before any Linear write.
const SLACK_SIGNING_SECRET = '__SLACK_SIGNING_SECRET__';
const SLACK_SIG_MAX_SKEW_SEC = 300;
const _slackCrypto = require('crypto');

// Recover the exact raw request body Slack signed. Prefer the n8n webhook's raw
// body (rawBody enabled on the Interactivity webhook node): a string, or base64
// in the binary `data` property. Fall back to reconstructing the urlencoded form
// (payload=<json>) from the parsed body.
function slackRawBody(entry) {
  const j = (entry && entry.json) || {};
  if (typeof j.rawBody === 'string') return j.rawBody;
  const bin = entry && entry.binary && entry.binary.data;
  if (bin && typeof bin.data === 'string') {
    try { return Buffer.from(bin.data, 'base64').toString('utf8'); } catch (e) { /* fall through */ }
  }
  if (typeof j.body === 'string') return j.body;
  const p = j.body && j.body.payload;
  if (typeof p === 'string') return 'payload=' + encodeURIComponent(p);
  return null;
}

function verifySlackSignature(entry) {
  const secret = SLACK_SIGNING_SECRET.startsWith('__') ? '' : SLACK_SIGNING_SECRET;
  if (!secret) return { ok: true, skipped: true }; // placeholder ⇒ offline / not-yet-deployed
  const headers = (entry && entry.json && entry.json.headers) || {};
  const sig = headers['x-slack-signature'];
  const ts  = headers['x-slack-request-timestamp'];
  if (!sig || !ts) return { ok: false, reason: 'missing X-Slack-Signature / X-Slack-Request-Timestamp header' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: `timestamp not numeric: "${ts}"` };
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSec > SLACK_SIG_MAX_SKEW_SEC) return { ok: false, reason: `stale/skewed timestamp: age=${ageSec}s > ${SLACK_SIG_MAX_SKEW_SEC}s window` };
  const rawBody = slackRawBody(entry);
  if (rawBody === null) return { ok: false, reason: 'raw request body unavailable (enable rawBody on the webhook node)' };
  const expected = 'v0=' + _slackCrypto.createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  const good = a.length === b.length && _slackCrypto.timingSafeEqual(a, b);
  return good ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

const items = $input.all();
const out = [];

// B4 — reject forged/unsigned interactions BEFORE any tracker mutation. The
// request is signed once, so verify the entry item; on failure emit nothing so
// no downstream node (Linear write, Slack reply) runs. Skipped when the signing
// secret is still the placeholder (offline harness / pre-deploy).
const _sigCheck = verifySlackSignature(items[0]);
if (!_sigCheck.ok) {
  console.warn(`[parse-action] REJECTED interaction — Slack signature check failed: ${_sigCheck.reason}`);
  return [];
}

for (const it of items) {
  const j = it.json || {};
  // Slack interactivity sends form-encoded body with 'payload' string field
  let payloadStr = j.body?.payload || j.payload || (typeof j.body === 'string' ? j.body : null);
  if (!payloadStr) {
    console.warn('[parse-action] no payload field in webhook body');
    out.push({ json: { __taskcrafter_error: 'no_payload', raw: j } });
    continue;
  }

  // URL-decode if needed (n8n form parsers usually decode automatically)
  let payload;
  try {
    payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
  } catch (e) {
    console.warn(`[parse-action] payload not JSON: ${e.message}`);
    out.push({ json: { __taskcrafter_error: 'payload_parse_fail', raw: payloadStr.slice(0, 200) } });
    continue;
  }

  const type = payload.type;
  const action = payload.actions && payload.actions[0];
  if (!action) {
    out.push({ json: { __taskcrafter_error: 'no_action_in_payload', payload_type: type } });
    continue;
  }

  const action_id = action.action_id || '';
  const message_ts = payload.message?.ts || payload.container?.message_ts;
  const channel = payload.channel?.id;
  const user = payload.user?.id;
  const response_url = payload.response_url;

  // Lookup pending state
  const data = $getWorkflowStaticData('global');
  const pending = data.taskcrafter_pending?.[message_ts];
  if (!pending) {
    console.warn(`[parse-action] no pending state for ts=${message_ts}`);
    out.push({
      json: {
        __taskcrafter_error: 'no_pending_state',
        message_ts, channel, user, action_id, response_url,
      },
    });
    continue;
  }

  // Decode action_id schema
  //   tc.approve.<task_id>       → approve task
  //   tc.skip.<task_id>          → skip task
  //   tc.approve_alt.<task_id>   → for FLAG, create new instead of commenting
  //   tc.bulk_approve_safe       → approve all actionable
  //   tc.bulk_skip_all           → skip all remaining
  let targetTasks = [];
  let action_kind = 'unknown';

  if (action_id === 'tc.bulk_approve_safe') {
    action_kind = 'bulk_approve';
    targetTasks = pending.tasks.filter(t =>
      ['create_new', 'comment_on_match', 'use_explicit_ref'].includes(t.matcher_decision)
      && !pending.executed[t.id]
    );
  } else if (action_id === 'tc.bulk_skip_all') {
    action_kind = 'bulk_skip';
    targetTasks = pending.tasks.filter(t =>
      ['create_new', 'comment_on_match', 'flag_for_review', 'use_explicit_ref'].includes(t.matcher_decision)
      && !pending.executed[t.id]
    );
  } else {
    const m = action_id.match(/^tc\.(approve|skip|approve_alt|create_despite_dup)\.(tc_[a-f0-9]+)$/);
    if (!m) {
      out.push({ json: { __taskcrafter_error: 'unknown_action_id', action_id } });
      continue;
    }
    const verb = m[1];
    const task_id = m[2];
    if (pending.executed[task_id]) {
      // Idempotency — already done
      const prev = pending.executed[task_id];
      out.push({
        json: {
          __action_kind: 'idempotent',
          action_id, task_id, message_ts, channel, response_url, user,
          thread_ts: pending.thread_ts,
          previous_outcome: prev,
          __response_text: fmt(S['tasks.already_executed'], { outcome: prev.outcome, url: prev.linear_url || '', identifier: prev.linear_identifier || '', user_id: prev.by_user }),
        },
      });
      continue;
    }
    const task = pending.tasks.find(t => t.id === task_id);
    if (!task) {
      out.push({ json: { __taskcrafter_error: 'task_not_in_pending', task_id, message_ts } });
      continue;
    }
    if (verb === 'skip') {
      action_kind = 'skip_single';
    } else if (verb === 'approve_alt' || verb === 'create_despite_dup') {
      // Two recovery paths share one mechanism:
      //   approve_alt         — FLAG «➕ Create new instead» (router_payload is COMMENT-shape)
      //   create_despite_dup  — skip_cross_call_dup «➕ Create anyway» (V1.7.27 D.2;
      //                         router_payload is null — the dup was suppressed)
      // Both force create_new by swapping in the CREATE-shape router_payload_create_alt
      // that 06-router pre-built (persisted by 10). Title falls back to the normalizer
      // title, description to the stage-12 placeholder — identical to the flag path.
      //
      // V1.7.5 (2026-06-09): null-guard — router sets create_alt=null when it
      // could not resolve a team (e.g. assignee not on any known team).
      // Without this guard the swap silently kept the COMMENT-shape payload,
      // 12-build-linear-mutation ran issueCreate without teamId and Linear
      // returned BAD_USER_INPUT in a stage where context is hard to recover.
      // Emit an actionable warning instead, surfaced via stage 13.
      if (!task.router_payload_create_alt) {
        out.push({ json: {
          __taskcrafter_stage: 'parse-slack-action',
          __action_kind: 'approve_create',
          __linear_mutation: null,
          __taskcrafter_warning:
            fmt(S['tasks.cannot_create_no_team'], { title: (task.title||'?').slice(0,60), owner: task.owner_lastname||'?' }),
          __response_text: fmt(S['tasks.cannot_create_no_team_short'], { title: (task.title||'?').slice(0,60), owner: task.owner_lastname||'?' }),
          task,
          message_ts, response_url, channel, user,
          thread_ts: pending.thread_ts,
          call_uuid: pending.call_uuid,
        }});
        continue;
      }
      action_kind = 'approve_create';
      task.matcher_decision = 'create_new';
      task.router_payload = task.router_payload_create_alt;
    } else {
      // approve — kind depends on task's decision
      if (task.matcher_decision === 'create_new') action_kind = 'approve_create';
      else if (task.matcher_decision === 'comment_on_match' || task.matcher_decision === 'flag_for_review') action_kind = 'approve_comment';
      else if (task.matcher_decision === 'use_explicit_ref') action_kind = 'approve_update';
      else action_kind = 'unknown';
    }
    targetTasks = [task];
  }

  console.log(`[parse-action] kind=${action_kind} tasks=${targetTasks.length} user=${user} ts=${message_ts}`);

  // Fan-out: emit one item per target task
  for (const task of targetTasks) {
    // V1.7.8 (2026-06-10): for bulk_approve compute per-task effective kind
    // based on matcher_decision, mirroring the single-task logic above.
    // Previously every fan-out item kept action_kind='bulk_approve', which
    // stage 13 (handle-result) had no branch for → "Unknown action kind:
    // bulk_approve" thrown N times in the Slack thread.
    let effective_kind = action_kind;
    if (action_kind === 'bulk_approve') {
      if (task.matcher_decision === 'create_new') effective_kind = 'approve_create';
      else if (task.matcher_decision === 'comment_on_match' || task.matcher_decision === 'flag_for_review') effective_kind = 'approve_comment';
      else if (task.matcher_decision === 'use_explicit_ref') effective_kind = 'approve_update';
      else effective_kind = 'unknown';
    }
    out.push({
      json: {
        __action_kind: effective_kind,
        action_id,
        message_ts,
        channel,
        user,
        response_url,
        thread_ts: pending.thread_ts,
        call_uuid: pending.call_uuid,
        task,
      },
    });
  }

  if (targetTasks.length === 0 && action_kind !== 'unknown') {
    // Bulk with nothing to do
    out.push({
      json: {
        __action_kind: 'bulk_noop',
        action_id, message_ts, channel, user, response_url,
        thread_ts: pending.thread_ts,
        __response_text: S['tasks.bulk_noop'],
      },
    });
  }
}

return out;
