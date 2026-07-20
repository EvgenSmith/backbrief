// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 2 part A — build per-team Linear search queries.
//
// Input: normalizer_output.tasks[] from Stage 1.
// Output: N items (1 per unique team that has at least one searchable task).
//         Each output item has the GraphQL variables for that team's search.
//
// Searchable tasks: intent='create' AND skip_reason=null AND no linear_ref_explicit.
// Explicit-ref tasks also emit a query item (different query: get_by_id).
//
// Downstream HTTP Request node (Linear search) fans out per output item.
// Aggregator (03c) reassembles results back into tasks_with_candidates.
//
// V0.2 (2026-05-28): refactored from monolithic 03-matcher-search.js since
//                    Code-node getCredentials doesn't work in n8n cloud Code sandbox.
// V0.8 (2026-06-02): planning/mixed mode — also emit `team_cycle_issues` query
//                    per team-bucket. Prefetches current sprint cycle issues so
//                    semantic re-rank has ground-truth candidates even when
//                    Anthropic-generated titles diverge from real Linear titles.
//                    Recall booster for sprint-planning calls where 12+ of 14
//                    proposals were missed dupes (prod reviewer feedback).

// TEAM_TO_ID (tracker team key → UUID) is deploy-resolved into the
// TENANT_TRACKER region. STOP_WORDS / DOMAIN_BRIDGE / INFLECTION_SUFFIXES are
// unioned from the tenant's language packs into the TENANT_LANG region — ONE
// rendered region, two consumers (03a + 03c): the prod hand-kept drift pair
// is gone. The domain bridge exists because LLM-generated proposal titles can
// be in one language while tracker issue titles use another's domain terms —
// token overlap is structurally zero without it (prod: 22 of 23
// matcher-recall failures). Single-language tenants get an empty bridge and
// expandToken() degrades to identity.

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

// Inflection-normalized dict lookup: DOMAIN_BRIDGE keys are stems/nominative
// forms, generated titles use inflected forms — retry the lookup after
// stripping common inflection suffixes (length-guarded to avoid
// over-stripping). Additive only: never removes the original token.
function dictGet(t) {
  if (DOMAIN_BRIDGE[t]) return DOMAIN_BRIDGE[t];
  if (t.length >= 6) {
    for (const suf of INFLECTION_SUFFIXES) {
      if (t.endsWith(suf) && t.length - suf.length >= 4) {
        const stem = t.slice(0, -suf.length);
        if (DOMAIN_BRIDGE[stem]) return DOMAIN_BRIDGE[stem];
      }
    }
  }
  return null;
}

function expandToken(t) {
  const bridge = dictGet(t);
  if (!bridge) return [t];
  return [t, ...bridge.split(/\s+/)];
}

function extractKeywords(title) {
  if (!title) return [];
  const tokens = title.toLowerCase()
    .replace(/[«»"'.,!?;:()\[\]{}]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    // V1.7.17 — expand each token to Cyrillic+Latin domain pairs so the
    // Linear workspace search term covers both languages.
    for (const e of expandToken(t)) {
      if (!seen.has(e)) { seen.add(e); out.push(e); }
    }
  }
  // Slightly raised cap: was 5, now 8 to accommodate bridged forms (each
  // original token may contribute 2-3 bridge pairs). Linear's search
  // relevance tolerates longer term lists.
  return out.slice(0, 8);
}

// V0.3: dropped team filter from search — workspace-wide recall.
// Reason: the model's team_inferred misroutes for cross-team domain knowledge
// (a product-bot task inferred into one team while the real existing issues
// lived in another). Better to query workspace-wide + let semantic re-rank (Stage 2.2)
// reject false positives. Cost: ~40 candidates per call instead of per-team
// scoped — still well under Linear rate limit.
const SEARCH_QUERY = `query SearchIssues($term: String!, $first: Int!) {
  searchIssues(term: $term, first: $first, includeArchived: false) {
    nodes {
      id identifier title description
      state { name type }
      team { id key name }
      assignee { id name displayName }
      labels { nodes { name } }
      createdAt updatedAt url
    }
  }
}`;

const GET_BY_IDENTIFIER_QUERY = `query IssueByIdentifier($id: String!) {
  issue(id: $id) {
    id identifier title description
    state { name type }
    assignee { id name displayName }
    labels { nodes { name } }
    createdAt updatedAt url
  }
}`;

// V0.8 (2026-06-02): cycle-issues prefetch.
// On planning/mixed calls (sprint planning, demo, standup), team walks through
// issues already in current cycle by design. Keyword search alone misses these
// because Anthropic-generated task titles diverge from real Linear issue titles
// (different phrasing, abbreviations, etc). Prefetching current cycle issues
// gives Anthropic semantic re-rank ground-truth candidates to match against.
const TEAM_CYCLE_ISSUES_QUERY = `query TeamActiveCycleIssues($teamId: String!) {
  team(id: $teamId) {
    id key
    activeCycle {
      id number
      issues(first: 100, filter: { state: { type: { nin: ["canceled","completed","duplicate"] } } }) {
        nodes {
          id identifier title description
          state { name type }
          team { id key name }
          assignee { id name displayName }
          labels { nodes { name } }
          createdAt updatedAt url
        }
      }
    }
  }
}`;

// V1.7.18 (2026-06-18) — Patch B: recent-backlog prefetch.
// activeCycle prefetch (V0.8) only sees issues already pulled into the current
// sprint. On Dev Daily / Product Planning calls the duplicated task is often
// still in BACKLOG (discussed for an upcoming sprint, not yet in a cycle) —
// e.g. rolling-backlog items. A prod Slack-enrichment
// eval showed 91% of existing-issue misses still score=null AFTER
// V1.7.17 shipped, consistent with the true dup sitting in backlog where
// active-cycle prefetch can't reach. This query pulls the 50 most-recently-
// updated non-terminal team issues so semantic rerank also gets backlog
// ground-truth. Complements (does not replace) the cycle query; 03c dedupes.
const TEAM_RECENT_BACKLOG_QUERY = `query TeamRecentBacklog($teamId: String!) {
  team(id: $teamId) {
    id key
    issues(
      first: 50,
      orderBy: updatedAt,
      filter: { state: { type: { nin: ["canceled","completed","duplicate"] } } }
    ) {
      nodes {
        id identifier title description
        state { name type }
        team { id key name }
        assignee { id name displayName }
        labels { nodes { name } }
        createdAt updatedAt url
      }
    }
  }
}`;

// === main ===
const items = $input.all();
const out = [];

for (const it of items) {
  const j = it.json || {};
  const no = j.normalizer_output;
  if (!no || !Array.isArray(no.tasks)) {
    out.push({ json: { ...j, __taskcrafter_error: 'queries_no_normalizer_output', query_type: 'noop' } });
    continue;
  }

  // Group searchable tasks by team_inferred. Collect keywords per team.
  const team_buckets = {};  // teamKey -> { teamId, terms: Set, task_ids: [] }
  const explicit_refs = [];  // { task_id, linear_ref_explicit }
  const passthrough_meta = {
    zoom_meeting_uuid: j.zoom_meeting_uuid,
    normalizer_output: no,
    __upstream_meta: { ...j },
  };

  for (const task of no.tasks) {
    if (task.skip_reason) continue;  // these don't need search

    if (task.linear_ref_explicit) {
      explicit_refs.push({ task_id: task.id, ref: task.linear_ref_explicit });
      continue;
    }

    const teamId = TEAM_TO_ID[task.team_inferred];
    if (!teamId) continue;  // unknown team, skip search

    const keywords = extractKeywords(task.title);
    if (keywords.length === 0) continue;

    if (!team_buckets[task.team_inferred]) {
      team_buckets[task.team_inferred] = { teamId, terms: new Set(), task_ids: [] };
    }
    keywords.forEach(k => team_buckets[task.team_inferred].terms.add(k));
    team_buckets[task.team_inferred].task_ids.push(task.id);
  }

  const query_items = [];
  const call_mode = no.call_mode || 'discovery';
  const want_cycle_prefetch = (call_mode === 'planning' || call_mode === 'mixed');

  // V0.3 — single workspace-wide search per team-bucket (still chunked by team
  // to keep keyword groups coherent — Maker Core terms shouldn't compete with
  // Design terms for top-30 slots).
  // V0.8 — in planning/mixed mode, also emit a cycle-issues query per team.
  for (const [team_key, bucket] of Object.entries(team_buckets)) {
    const term = Array.from(bucket.terms).join(' ');
    query_items.push({
      query_type: 'team_search',
      query: SEARCH_QUERY,
      variables: { term, first: 40 },  // workspace-wide, broader recall
      __passthrough: passthrough_meta,
      __team_key: team_key,
      __task_ids: bucket.task_ids,
    });
    if (want_cycle_prefetch) {
      query_items.push({
        query_type: 'team_cycle_issues',
        query: TEAM_CYCLE_ISSUES_QUERY,
        variables: { teamId: bucket.teamId },
        __passthrough: passthrough_meta,
        __team_key: team_key,
        __task_ids: bucket.task_ids,
      });
      // V1.7.18 — Patch B: also prefetch recent backlog (not just active cycle).
      query_items.push({
        query_type: 'team_backlog_issues',
        query: TEAM_RECENT_BACKLOG_QUERY,
        variables: { teamId: bucket.teamId },
        __passthrough: passthrough_meta,
        __team_key: team_key,
        __task_ids: bucket.task_ids,
      });
    }
  }

  // Per-explicit-ref query: get_by_id
  for (const ref of explicit_refs) {
    query_items.push({
      query_type: 'explicit_ref',
      query: GET_BY_IDENTIFIER_QUERY,
      variables: { id: ref.ref },
      __passthrough: passthrough_meta,
      __task_id: ref.task_id,
      __explicit_ref: ref.ref,
    });
  }

  if (query_items.length === 0) {
    // No tasks need Linear lookup — emit a single passthrough item with noop query type
    // so Aggregator can still receive context and produce empty candidates.
    out.push({ json: { ...passthrough_meta, query_type: 'noop' } });
    continue;
  }

  const cycle_count = query_items.filter(q => q.query_type === 'team_cycle_issues').length;
  const backlog_count = query_items.filter(q => q.query_type === 'team_backlog_issues').length;
  console.log(`[build-queries] ${Object.keys(team_buckets).length} team-pool queries, ${cycle_count} cycle-prefetch + ${backlog_count} backlog-prefetch queries (mode=${call_mode}), ${explicit_refs.length} explicit-ref queries`);
  for (const q of query_items) out.push({ json: q });
}

return out;
