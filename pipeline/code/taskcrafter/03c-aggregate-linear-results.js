// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 2 part C — aggregate Linear search results back into tasks.
//
// Input: N items, each a Linear API response from the upstream HTTP request.
//        Each item retains __passthrough (original normalizer_output) and either
//        __task_ids (team_search) or __task_id+__explicit_ref (explicit_ref).
//
// Output: single item with normalizer_output.tasks[] augmented with
//         matcher_candidates[] and matcher_explicit_ref_issue.
//
// Client-side keyword filtering: for team_search results (which return up to 30
// issues for the whole team), filter per-task by keyword overlap with title.
// Top-10 candidates per task survive.
//
// V0.2 (2026-05-28): pairs with 03a-build-team-queries.
// V0.8 (2026-06-02): handle `team_cycle_issues` results. Cycle issues bypass
//                    the >=1 keyword overlap filter (score floor 0.5 below
//                    keyword matches) so Anthropic semantic re-rank can match
//                    against current-sprint ground truth even when titles
//                    diverge. Top-5 per task still applies.
// V1.7.17(2026-06-15): Patch A — cycle pool bypasses top-5 cut (CYCLE_CAP=20);
//                    Patch D — Cyrillic↔Latin DOMAIN_BRIDGE in tokenize().
// V1.7.18(2026-06-18): Patch B — recent-backlog pool (bypasses keyword filter,
//                    BACKLOG_CAP=15) + inflection-normalized dict lookup.
//                    NOTE: 2026-06-18 live eval showed 0/16 delta — kept as
//                    additive defense-in-depth, not a proven recall lever.
// V1.7.19(2026-06-18): keyword selection = UNION(overlap-top5, Linear-relevance-
//                    top8) capped at KW_CAP=10 — stop discarding searchIssues
//                    relevance order behind a near-useless overlap re-sort.
//                    Strictly non-regressive. See eval-slack-enrichment-2026-06-18.md.

// STOP_WORDS / DOMAIN_BRIDGE / INFLECTION_SUFFIXES come from the TENANT_LANG
// region — the SAME rendered region as 03a-build-team-queries.js (the prod
// "keep both copies in sync" drift warning is obsolete by construction).

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

// Inflection-normalized dict lookup — see 03a for rationale.
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

function tokenize(s) {
  if (!s) return new Set();
  // V1.7.17 — expand each basic token through DOMAIN_BRIDGE. overlap()
  // now bridges «линти» ↔ «eslint» and similar gaps that caused 22 of 23
  // matcher-recall failures on 2026-06-15 eval.
  const base = s.toLowerCase()
    .replace(/[«»"'.,!?;:()\[\]{}]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
  const out = new Set();
  for (const t of base) {
    for (const e of expandToken(t)) out.add(e);
  }
  return out;
}

function overlap(setA, setB) {
  let count = 0;
  for (const t of setA) if (setB.has(t)) count++;
  return count;
}

// === main ===
const linearResponses = $input.all();          // Linear HTTP responses (1 per query)
const queryItems     = $('Build team queries').all();  // original queries with passthrough

if (queryItems.length === 0) {
  return [{ json: { __taskcrafter_error: 'aggregate_no_query_items' } }];
}

// Pull normalizer_output from upstream Parse normalizer response (always has it)
const parsed_upstream = $('Parse normalizer response').first().json;
const no_in = parsed_upstream.normalizer_output;

if (!no_in || !Array.isArray(no_in.tasks)) {
  return [{ json: { __taskcrafter_error: 'aggregate_no_normalizer_output' } }];
}

// Build pools by ZIPping query items (have metadata) with HTTP responses (same order)
const team_pools = {};     // team_key -> { nodes (from keyword search), task_ids }
const cycle_pools = {};    // team_key -> { nodes (current cycle issues), task_ids }
const backlog_pools = {};  // team_key -> { nodes (recent backlog issues), task_ids }  V1.7.18 Patch B
const explicit_refs = {};

for (let i = 0; i < queryItems.length; i++) {
  const q = queryItems[i].json || {};
  const r = linearResponses[i]?.json || {};
  const qtype = q.query_type;

  if (qtype === 'noop' || qtype === undefined) continue;

  // n8n HTTP Request with responseFormat: json puts parsed body fields at top of $json
  // For GraphQL response: { data: { searchIssues: { nodes: [...] } } } or { errors: [...] }
  const data = r.data || {};

  if (qtype === 'team_search') {
    const team_key = q.__team_key;
    const task_ids = q.__task_ids || [];
    const nodes = (data.searchIssues?.nodes || [])
      .filter(n => n.state?.type !== 'canceled' && n.state?.type !== 'duplicate');
    team_pools[team_key] = { nodes, task_ids };
  } else if (qtype === 'team_cycle_issues') {
    // V0.8 — current cycle issues for planning-mode prefetch
    const team_key = q.__team_key;
    const task_ids = q.__task_ids || [];
    const cycle_nodes = data.team?.activeCycle?.issues?.nodes || [];
    cycle_pools[team_key] = { nodes: cycle_nodes, task_ids };
    console.log(`[aggregate] cycle prefetch for team=${team_key}: ${cycle_nodes.length} active-cycle issues`);
  } else if (qtype === 'team_backlog_issues') {
    // V1.7.18 — Patch B: recent backlog issues for planning-mode prefetch.
    const team_key = q.__team_key;
    const task_ids = q.__task_ids || [];
    const backlog_nodes = data.team?.issues?.nodes || [];
    backlog_pools[team_key] = { nodes: backlog_nodes, task_ids };
    console.log(`[aggregate] backlog prefetch for team=${team_key}: ${backlog_nodes.length} recent backlog issues`);
  } else if (qtype === 'explicit_ref') {
    const ref = q.__explicit_ref;
    if (data.issue) explicit_refs[ref] = data.issue;
  } else {
    console.warn(`[aggregate] unknown query_type=${qtype}`);
  }
}

// Now per-task: filter team pool by keyword overlap
const decorated_tasks = no_in.tasks.map(task => {
  const t = { ...task, matcher_candidates: [], matcher_explicit_ref_issue: null };

  if (t.skip_reason) {
    t.matcher_skipped_reason = `skip_reason=${t.skip_reason}`;
    return t;
  }

  if (t.linear_ref_explicit) {
    t.matcher_explicit_ref_issue = explicit_refs[t.linear_ref_explicit] || null;
    if (!t.matcher_explicit_ref_issue) {
      t.matcher_warning = `linear_ref_explicit ${t.linear_ref_explicit} not found`;
    }
    return t;
  }

  const title_tokens = tokenize(t.title);
  if (title_tokens.size === 0) {
    t.matcher_skipped_reason = 'no_keywords_extracted';
    return t;
  }

  // V0.3 — pool ALL team_pools nodes together (search was workspace-wide anyway).
  // V0.8 — also pool cycle_pools nodes for the task's team (if planning prefetch
  // ran). Cycle issues bypass the >=1 keyword overlap filter so Anthropic
  // semantic rerank gets a chance to match against current-sprint ground truth
  // even when Anthropic-generated titles diverge from real Linear titles.
  // Dedupe by id (issues might appear in both keyword search and cycle pool).
  const seen_ids = new Set();
  const keyword_nodes = [];   // require keyword overlap filter
  const cycle_nodes = [];     // bypass keyword filter; treated as "guaranteed candidates"
  const backlog_nodes = [];   // V1.7.18 Patch B — bypass keyword filter, like cycle
  for (const bucket of Object.values(team_pools)) {
    for (const n of bucket.nodes) {
      if (!seen_ids.has(n.id)) { seen_ids.add(n.id); keyword_nodes.push(n); }
    }
  }
  // Cycle pool: only nodes from THIS task's team (don't pollute cross-team)
  const team_inferred = t.team_inferred;
  if (team_inferred && cycle_pools[team_inferred]) {
    for (const n of cycle_pools[team_inferred].nodes) {
      // Filter out terminal states (canceled/completed/duplicate)
      if (n.state?.type === 'canceled' || n.state?.type === 'duplicate' || n.state?.type === 'completed') continue;
      if (!seen_ids.has(n.id)) { seen_ids.add(n.id); cycle_nodes.push(n); }
    }
  }
  // V1.7.18 — Patch B: backlog pool for THIS task's team. Deduped against
  // keyword+cycle via shared seen_ids (a backlog issue already pulled into the
  // active cycle won't be double-counted).
  if (team_inferred && backlog_pools[team_inferred]) {
    for (const n of backlog_pools[team_inferred].nodes) {
      if (n.state?.type === 'canceled' || n.state?.type === 'duplicate' || n.state?.type === 'completed') continue;
      if (!seen_ids.has(n.id)) { seen_ids.add(n.id); backlog_nodes.push(n); }
    }
  }

  // Score keyword pool by overlap (kept as metadata + one of two selection signals).
  const scored_kw = keyword_nodes
    .map(n => ({ node: n, score: overlap(title_tokens, tokenize(n.title + ' ' + (n.description || ''))), origin: 'keyword' }));

  // V1.7.17 (2026-06-15) — Patch A. Cycle pool now bypasses the top-5 cut
  // entirely: send ALL cycle issues up to CYCLE_CAP per task directly to
  // semantic rerank. Reason: on 2026-06-15 matcher recall eval, 22 of 23
  // already_exists rows had matcher_best_score=null because token overlap
  // between Anthropic-Russian proposal titles and Linear-English issue
  // titles is structurally zero. A prod recall-miss target was
  // returned by cycle prefetch with floor score 0.5 but lost the top-5 cut
  // to cycle issues with coincidental 1-token overlap. The semantic rerank
  // (Opus 4.8 + extended thinking, V1.7.15) is the right place to do
  // candidate disambiguation, not keyword overlap.
  //
  // V1.7.19 (2026-06-18) — keyword selection is now a UNION of two signals,
  // not overlap-sort alone. The 2026-06-18 live candidate-selection eval
  // (n8n/eval/taskcrafter-candidate-selection/live-run.js; 16 known-target /
  // score=null miss rows replayed against live Linear) found that searchIssues
  // already returns the true target at rank 1-5 for most FETCHED cases, but 03c
  // was discarding Linear's relevance order: it re-sorted the 40-result pool on
  // naive token overlap and cut to top-5, and 32-39 of 40 candidates score
  // overlap>=1 (DOMAIN_BRIDGE + common tokens make overlap a near-useless
  // discriminator), so selection was effectively arbitrary. Fix: take the union
  // of (a) the legacy overlap>=1 top-5 AND (b) Linear's relevance-ordered top-N,
  // deduped + capped at KW_CAP. STRICTLY non-regressive vs V1.7.17 (keeps every
  // prior survivor) and adds the Linear-ranked candidates for the semantic rerank
  // to disambiguate — consistent with the Patch A rationale above.
  // CAVEAT: the live replay is staleness-limited (15/16 ground-truth targets have
  // since moved to terminal states; cycle/backlog pools no longer contain them),
  // so this is a principled, non-regressive change, NOT a numerically-proven
  // recall gain. V1.7.18's inflection-norm + backlog showed 0/16 delta on this
  // eval. See docs/skills/taskcrafter/eval-slack-enrichment-2026-06-18.md.
  const CYCLE_CAP = 20;
  const BACKLOG_CAP = 15;   // V1.7.18 Patch B — backlog already orderBy updatedAt
  const KW_CAP = 10;        // V1.7.19 — union budget for the keyword pool
  const kw_overlap = scored_kw
    .filter(s => s.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const kw_relevance = keyword_nodes.slice(0, 8);  // searchIssues relevance order (best-first)
  const kw_seen = new Set();
  const top_kw = [];
  for (const s of kw_overlap) {
    if (kw_seen.has(s.node.id)) continue;
    kw_seen.add(s.node.id);
    top_kw.push({ ...s.node, __candidate_origin: 'keyword', __kw_overlap: s.score });
  }
  for (const n of kw_relevance) {
    if (top_kw.length >= KW_CAP) break;
    if (kw_seen.has(n.id)) continue;
    kw_seen.add(n.id);
    const sc = overlap(title_tokens, tokenize(n.title + ' ' + (n.description || '')));
    top_kw.push({ ...n, __candidate_origin: 'keyword_relevance', __kw_overlap: sc });
  }
  const top_cycle = cycle_nodes
    .slice(0, CYCLE_CAP)
    .map(n => ({ ...n, __candidate_origin: 'cycle' }));
  const top_backlog = backlog_nodes
    .slice(0, BACKLOG_CAP)
    .map(n => ({ ...n, __candidate_origin: 'backlog' }));
  // Dedupe by id — keyword/cycle/backlog pools may overlap.
  const final_seen = new Set();
  const scored = [];
  for (const c of [...top_kw, ...top_cycle, ...top_backlog]) {
    if (!final_seen.has(c.id)) { final_seen.add(c.id); scored.push(c); }
  }

  t.matcher_candidates = scored;
  t.matcher_keyword_count = title_tokens.size;
  t.matcher_pool_size = keyword_nodes.length + cycle_nodes.length + backlog_nodes.length;
  t.matcher_cycle_pool_size = cycle_nodes.length;
  t.matcher_backlog_pool_size = backlog_nodes.length;
  return t;
});

const total_candidates = decorated_tasks.reduce((s, t) => s + (t.matcher_candidates?.length || 0), 0);
const cycle_pool_total = Object.values(cycle_pools).reduce((s, b) => s + b.nodes.length, 0);
const backlog_pool_total = Object.values(backlog_pools).reduce((s, b) => s + b.nodes.length, 0);
const cycle_origin_count = decorated_tasks.reduce((s, t) =>
  s + (t.matcher_candidates || []).filter(c => c.__candidate_origin === 'cycle').length, 0);
const backlog_origin_count = decorated_tasks.reduce((s, t) =>
  s + (t.matcher_candidates || []).filter(c => c.__candidate_origin === 'backlog').length, 0);
console.log(`[aggregate] ${decorated_tasks.length} tasks, ${total_candidates} candidates ` +
            `(${cycle_origin_count} cycle of ${cycle_pool_total}, ${backlog_origin_count} backlog of ${backlog_pool_total}), ` +
            `${decorated_tasks.filter(t => t.matcher_explicit_ref_issue).length} explicit refs resolved`);

// Emit single item, carrying forward upstream meta from parsed normalizer
return [{
  json: {
    ...parsed_upstream,
    __taskcrafter_stage: 'matcher-searched',
    normalizer_output: {
      ...no_in,
      tasks: decorated_tasks,
    },
  },
}];
