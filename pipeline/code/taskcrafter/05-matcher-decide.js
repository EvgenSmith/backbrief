// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 2 — Matcher decide.
//
// Combines per-task signals into a deterministic matcher_decision:
//   - 'skip'                       — task has skip_reason (sensitivity, philosophical, etc)
//   - 'use_explicit_ref'           — task has linear_ref_explicit, target issue fetched
//   - 'comment_on_match'           — best semantic score ≥ COMMENT_THRESHOLD
//   - 'flag_for_review'            — best semantic score ≥ FLAG_THRESHOLD (preview shows possible dup)
//   - 'create_new'                 — best score < FLAG_THRESHOLD OR no candidates OR search error
//   - 'skip_cross_call_dup'        — fingerprint match in recent (≤14d) taskcrafter outputs
//
// Cross-call dedup via $getWorkflowStaticData('global').taskcrafter_drafts_by_uuid.
//
// Input: items with normalizer_output.tasks[] (post-search) + rerank_output.scores[]
//        (post-anthropic). When __skip_anthropic_rerank flag set — no rerank.
//
// Output: items with each task augmented with matcher_decision + best_match_link.
//
// V0.1 (2026-05-28): initial.
// V0.7: planning-mode FLAG threshold lowered to 0.35 after prod feedback on a
//       planning call — 12 of 14 CREATE proposals were dupes of existing
//       tasks the matcher missed.
// V1.0: F1 — skip_match_done when the best matched issue is Done/Canceled.
//       F2 — intra-batch dedup via Jaccard tokens ≥ 0.5. Both driven by prod
//       reviewer feedback on a recurring dev daily.
// V1.1: F2.5 — same-best-match-target dedup. Two proposals pointing at the
//       same tracker issue → keep the higher-score one, demote the others to
//       skip_same_target_dup.
// V1.2: F3 — lowered COMMENT_THRESHOLD 0.85 → 0.75: proposals at score
//       0.3-0.4 were existing issues but became CREATE under the high
//       threshold. Tradeoff: possible false COMMENT on a near-miss, but the
//       reviewer can Skip manually. Net: +recall on existing issues.
// V1.3 (2026-07-06): loud failure on Anthropic error responses. The rerank
//                    HTTP node passes 4xx/5xx bodies through, and until now an
//                    API error just meant "no text block" → silent {scores:[]}
//                    → dedup dead with zero trace (this is exactly how the
//                    thinking enabled→adaptive 400 on opus-4-8 went unnoticed
//                    from 06-12 to 07-06). Still degrades to empty scores (a
//                    failed rerank must not kill the whole TaskCrafter run),
//                    but now stamps rerank_error into the output item and
//                    console.warn's loudly so exec review / telemetry sees it.

// Thresholds come from the TENANT_TRACKER region (features.tracker.thresholds
// — the L0→L2 autonomy dials; defaults are prod-calibrated):
//   COMMENT_THRESHOLD            best-score ≥ → comment on existing
//   FLAG_THRESHOLD_DISCOVERY     discovery (~70% of calls): strict, avoids noisy FLAGs
//   FLAG_THRESHOLD_PLANNING      planning walks existing issues → loose, near-
//                                matches surface as FLAG (manual pick) instead
//                                of a silent CREATE
//   CROSS_CALL_TTL_DAYS_CONFIRMED  confirmed writes block re-proposals (recurring calls)
//   CROSS_CALL_TTL_HOURS_PENDING   un-clicked proposals block only briefly
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
const STATE_TTL_DAYS = 60;  // forget taskcrafter_drafts entries older than this

// F1 — if the best matched candidate has state.type='completed' or
//      'canceled', emit `skip_match_done` instead of comment/flag ("already
//      done" reviewer feedback).
// F2 — after per-task decisions, run intra-batch dedup via Jaccard token
//      similarity ≥ 0.5 on title — a batch can carry two proposals from the
//      same workstream that the normalizer didn't merge.
const CLOSED_STATE_TYPES = new Set(['completed', 'canceled']);
const INTRA_BATCH_JACCARD_THRESHOLD = 0.5;

const data = $getWorkflowStaticData('global');
data.taskcrafter_drafts_by_uuid = data.taskcrafter_drafts_by_uuid || {};

// === fingerprint helpers ===
async function sha256Hex(s) {
  // n8n Code node — Node crypto is available
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(s).digest('hex');
}

function fingerprintTask(task) {
  // Stable canonical string: lowercase title + owner_lastname (or '__none__')
  const owner = (task.owner_lastname || '__none__').toLowerCase();
  const title = (task.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${title}|${owner}`;
}

// F2 — intra-batch Jaccard similarity helpers.
const INTRA_STOP = new Set([
  'и','в','на','с','по','за','для','к','о','от','до','из','при','без','под','над',
  'что','как','где','когда','если','это','тот','же','же','ли','уже','ещё','или',
  'но','чтобы','тоже','только','очень','можно','нужно','надо',
  'the','of','in','on','at','to','for','with','and','or','but','if','as','by','from',
  'сделать','подготовить','провести','create','update','prepare','send','задача','task',
]);
function intraTokens(title) {
  return new Set(
    (title || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !INTRA_STOP.has(t))
  );
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function ttlCleanup(uuid_drafts_map, ttl_days) {
  const cutoff = Date.now() - ttl_days * 24 * 3600 * 1000;
  let purged = 0;
  for (const [uuid, entry] of Object.entries(uuid_drafts_map)) {
    const stamp = entry?.completed_at ? Date.parse(entry.completed_at) : 0;
    if (stamp && stamp < cutoff) {
      delete uuid_drafts_map[uuid];
      purged++;
    }
  }
  return purged;
}

// === main ===
const items = $input.all();
const out = [];

// Run TTL cleanup once
const purged = ttlCleanup(data.taskcrafter_drafts_by_uuid, STATE_TTL_DAYS);
if (purged > 0) console.log(`[matcher-decide] purged ${purged} stale taskcrafter state entries`);

// V0.9 (2026-06-02): per-outcome TTL split. `pending` entries (un-clicked
// Slack messages) only block future calls for 48h. Confirmed writes
// (`created` / `commented` / `updated`) block for 14d.
const confirmed_cutoff = Date.now() - CROSS_CALL_TTL_DAYS_CONFIRMED * 24 * 3600 * 1000;
const pending_cutoff   = Date.now() - CROSS_CALL_TTL_HOURS_PENDING  * 3600 * 1000;
const recent_fingerprints = new Map();  // fingerprint → { uuid, task_id, outcome, linear_id }
let counted_pending = 0, counted_confirmed = 0;
for (const [uuid, entry] of Object.entries(data.taskcrafter_drafts_by_uuid)) {
  const stamp = entry?.completed_at ? Date.parse(entry.completed_at) : 0;
  for (const draft of entry.drafts || []) {
    if (draft.outcome === 'skipped') continue;  // skipped drafts don't block future creates
    if (!draft.fingerprint) continue;
    const is_pending = draft.outcome === 'pending';
    const cutoff = is_pending ? pending_cutoff : confirmed_cutoff;
    if (stamp < cutoff) continue;
    if (!recent_fingerprints.has(draft.fingerprint)) {
      recent_fingerprints.set(draft.fingerprint, { uuid, ...draft });
      if (is_pending) counted_pending++; else counted_confirmed++;
    }
  }
}
console.log(`[matcher-decide] cross-call dedup index: ${recent_fingerprints.size} fingerprints (${counted_confirmed} confirmed ${CROSS_CALL_TTL_DAYS_CONFIRMED}d + ${counted_pending} pending ${CROSS_CALL_TTL_HOURS_PENDING}h)`);

// Reach back to Build rerank body for the canonical normalizer_output —
// because the FALSE branch of IF passes through Anthropic rerank call which
// replaces $json with its API response (model/content/usage) and loses our
// pipeline context.
const upstream_ctx = $('Build rerank body').first().json;

for (const it of items) {
  const j_in = it.json || {};
  // j is the "primary" item — either:
  //  (a) upstream_ctx if input was Anthropic raw (rerank-called branch), OR
  //  (b) input itself if it already has normalizer_output (skip branch)
  const j = (j_in.normalizer_output && Array.isArray(j_in.normalizer_output?.tasks))
    ? j_in
    : { ...upstream_ctx, ...j_in };

  const no = j.normalizer_output;
  if (!no || !Array.isArray(no.tasks)) {
    out.push({ json: { ...j, __taskcrafter_error: 'decide_no_normalizer_output' } });
    continue;
  }

  // V0.7: pick FLAG threshold per call_mode. Planning calls discuss tasks already
  // in Linear, so we want low-confidence matches to surface as FLAG (which forces
  // manual pick between Comment / Create-new) rather than auto-CREATE.
  const call_mode = no.call_mode || 'discovery';
  const flag_threshold = (call_mode === 'planning' || call_mode === 'mixed')
    ? FLAG_THRESHOLD_PLANNING
    : FLAG_THRESHOLD_DISCOVERY;

  // rerank_output may come either:
  //   (a) pre-set on `j` from skip branch of Stage 2 (empty scores), OR
  //   (b) Anthropic raw on `j_in` (rerank-call branch — has content[*] with
  //       the JSON-bearing text block). V0.2 (2026-06-12): with extended
  //       thinking enabled in stage 04, content[0] is now a `thinking` block
  //       and the JSON lives in the first `text`-type block. Pick by type
  //       instead of index so the parser tolerates both shapes (with/without
  //       thinking) — keeps the rerank-call branch backward compatible if we
  //       ever roll thinking back.
  // V1.3: detect an Anthropic API error body ({"type":"error","error":{...}})
  // flowing through the rerank node. Degrade gracefully but never silently.
  let rerank_error = null;
  if (j_in && j_in.type === 'error' && j_in.error) {
    rerank_error = `${j_in.error.type || 'api_error'}: ${String(j_in.error.message || '(no message)').slice(0, 300)}`;
    console.warn(`[matcher-decide] ⚠️ ANTHROPIC RERANK FAILED — dedup degraded, all scorable tasks fall through to create_new: ${rerank_error}`);
  } else if (j_in && j_in.stop_reason === 'max_tokens') {
    // V1.4 (2026-07-08): max_tokens is the SHARED thinking+output ceiling on
    // opus-4-8. On a big planning call the JSON scores can be truncated → the
    // brace-slice parse below yields partial/empty scores → dedup silently
    // degrades (the outage failure mode via truncation, not a 400). Stamp it
    // loudly. (The V0.4 payload compaction makes this rare by freeing output
    // headroom, but keep the guard.) Parsing still proceeds — partial scores
    // are better than none for the tasks that did serialise.
    rerank_error = 'rerank_truncated_max_tokens';
    console.warn('[matcher-decide] ⚠️ rerank hit max_tokens — JSON likely truncated, dedup degraded for the tail tasks');
  }

  let rerank_output = j.rerank_output;
  const textBlock = Array.isArray(j_in.content)
    ? j_in.content.find(b => b && b.type === 'text' && typeof b.text === 'string')
    : null;
  if (!rerank_output && textBlock) {
    let txt = textBlock.text.trim();
    const fenceMatch = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) txt = fenceMatch[1].trim();
    const first = txt.indexOf('{');
    const last = txt.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { rerank_output = JSON.parse(txt.slice(first, last + 1)); }
      catch (e) { console.warn(`[matcher-decide] rerank JSON parse failed: ${e.message}`); }
    }
  }
  // V1.3: any path that leaves us without scores when the skip branch didn't
  // pre-populate them is a degraded run — record why.
  if (!rerank_error && !rerank_output) {
    rerank_error = textBlock ? 'rerank_json_parse_failed' : 'rerank_response_missing_text_block';
    console.warn(`[matcher-decide] ⚠️ rerank produced no usable scores (${rerank_error}) — dedup degraded for this call`);
  }
  rerank_output = rerank_output || { scores: [] };

  const rerank_scores = rerank_output.scores || [];
  const scores_by_task_id = Object.fromEntries(rerank_scores.map(s => [s.task_id, s]));

  const this_call_uuid = j.zoom_meeting_uuid || j.__zoom_meeting_uuid || 'unknown';
  const this_call_fingerprints = new Set();  // collect for state save
  const this_call_drafts = [];

  const decided_tasks = [];
  for (const task of no.tasks) {
    const t = { ...task };

    // 1. Skip-reason tasks
    if (t.skip_reason) {
      t.matcher_decision = 'skip';
      t.matcher_decision_reason = t.skip_reason;
      decided_tasks.push(t);
      continue;
    }

    // 2. Explicit Linear ref (planning mode update_*) → use_explicit_ref
    if (t.linear_ref_explicit) {
      if (t.matcher_explicit_ref_issue) {
        t.matcher_decision = 'use_explicit_ref';
        t.matcher_decision_reason = `explicit_ref_to_${t.linear_ref_explicit}`;
        t.best_match_id = t.matcher_explicit_ref_issue.id;
        t.best_match_identifier = t.matcher_explicit_ref_issue.identifier;
        t.best_match_url = t.matcher_explicit_ref_issue.url;
      } else {
        t.matcher_decision = 'create_new';
        t.matcher_decision_reason = `explicit_ref_${t.linear_ref_explicit}_not_found_treating_as_new`;
      }
      decided_tasks.push(t);
      continue;
    }

    // 3. Cross-call dedup check
    const fp = fingerprintTask(t);
    this_call_fingerprints.add(fp);
    const existing = recent_fingerprints.get(fp);
    if (existing) {
      t.matcher_decision = 'skip_cross_call_dup';
      t.matcher_decision_reason = `recent_taskcrafter_draft_${existing.uuid}_${existing.outcome}`;
      t.cross_call_dup_existing_linear_id = existing.linear_id || null;
      decided_tasks.push(t);
      this_call_drafts.push({ fingerprint: fp, task_id: t.id, outcome: 'skipped' });
      continue;
    }

    // 4. Semantic re-rank — apply thresholds
    const score_obj = scores_by_task_id[t.id];
    const best_score = score_obj?.best_score || 0;
    const best_candidate = score_obj?.best_candidate_id ? {
      id: score_obj.best_candidate_id,
      identifier: score_obj.best_candidate_identifier,
    } : null;
    const all_scored = score_obj?.scored_candidates || [];

    // D.3 fix (2026-07-09): distinguish "no candidate scored" from "scored 0".
    // best_score is `score_obj?.best_score || 0` — a NUMBER for every reranked
    // task, so 09b's `score === null` gates (Pattern G, Pattern-A recur) could
    // never fire in prod: dead exactly when rerank degraded / found nothing.
    // best_candidate is null iff rerank returned no winner → encode that as null
    // so the no-candidate discriminator gates fire when they should. Every reader
    // of matcher_best_score is `|| 0` / `!= null` guarded (blast-radius checked).
    t.matcher_best_score = best_candidate ? best_score : null;
    t.matcher_scored_candidates = all_scored;

    // F1 — detect if best match is already done/canceled. Look up state from
    // original candidates list to decide whether to comment/flag or to skip.
    const best_cand_detail = best_candidate
      ? (t.matcher_candidates || []).find(c => c.id === best_candidate.id)
      : null;
    const best_is_closed = best_cand_detail
      && best_cand_detail.state
      && CLOSED_STATE_TYPES.has(best_cand_detail.state.type);

    if (best_candidate && best_score >= COMMENT_THRESHOLD) {
      if (best_is_closed) {
        t.matcher_decision = 'skip_match_done';
        t.matcher_decision_reason = `best_match_${best_cand_detail.state.type}_score_${best_score.toFixed(2)}`;
        t.best_match_id = best_candidate.id;
        t.best_match_identifier = best_candidate.identifier;
        t.best_match_url = best_cand_detail.url;
      } else {
        t.matcher_decision = 'comment_on_match';
        t.matcher_decision_reason = `best_score_${best_score.toFixed(2)}`;
        t.best_match_id = best_candidate.id;
        t.best_match_identifier = best_candidate.identifier;
        if (best_cand_detail) t.best_match_url = best_cand_detail.url;
      }
    } else if (best_candidate && best_score >= flag_threshold) {
      if (best_is_closed) {
        t.matcher_decision = 'skip_match_done';
        t.matcher_decision_reason = `best_match_${best_cand_detail.state.type}_score_${best_score.toFixed(2)}_mode_${call_mode}`;
        t.best_match_id = best_candidate.id;
        t.best_match_identifier = best_candidate.identifier;
        t.best_match_url = best_cand_detail.url;
      } else {
        t.matcher_decision = 'flag_for_review';
        t.matcher_decision_reason = `possible_dup_score_${best_score.toFixed(2)}_mode_${call_mode}`;
        t.best_match_id = best_candidate.id;
        t.best_match_identifier = best_candidate.identifier;
        if (best_cand_detail) t.best_match_url = best_cand_detail.url;
      }
    } else {
      t.matcher_decision = 'create_new';
      t.matcher_decision_reason = best_candidate ? `best_score_below_threshold_${best_score.toFixed(2)}` : 'no_relevant_candidates';
    }

    decided_tasks.push(t);
    // Tentatively record draft (will be marked pending until Executor confirms outcome).
    this_call_drafts.push({ fingerprint: fp, task_id: t.id, outcome: 'pending' });
  }

  // F2 — intra-batch dedup (prod reviewer feedback):
  // the normalizer occasionally emits two proposals from the same workstream that
  // share enough title tokens to be obvious duplicates. Collapse them here so
  // the user doesn't see noise.
  //
  // Only collapses tasks that are about to write (create_new / flag_for_review
  // / comment_on_match). Skips / explicit refs are left alone — they're either
  // already noise-filtered or addressing a specific Linear issue.
  const dup_eligible = new Set(['create_new', 'flag_for_review', 'comment_on_match']);
  const active = decided_tasks
    .map((t, idx) => ({ t, idx, tokens: intraTokens(t.title) }))
    .filter(x => dup_eligible.has(x.t.matcher_decision));
  let intra_dup_count = 0;
  for (let i = 0; i < active.length; i++) {
    for (let k = i + 1; k < active.length; k++) {
      const sim = jaccard(active[i].tokens, active[k].tokens);
      if (sim < INTRA_BATCH_JACCARD_THRESHOLD) continue;
      const dup = active[k].t;
      if (dup.matcher_decision === 'skip_intra_batch_dup') continue;  // already flagged
      dup.matcher_decision = 'skip_intra_batch_dup';
      dup.matcher_decision_reason = `intra_batch_dup_of_${active[i].t.id}_jaccard_${sim.toFixed(2)}`;
      dup.intra_batch_dup_of_task_id = active[i].t.id;
      intra_dup_count++;
    }
  }
  if (intra_dup_count > 0) {
    console.log(`[matcher-decide] intra-batch dedup: collapsed ${intra_dup_count} duplicate(s)`);
  }

  // F2.5 — same-best-match-target dedup (prod observation): two proposals can
  // have low Jaccard on titles yet point at the same existing tracker issue
  // via best_match_id. Both would compete for the same COMMENT — keep only
  // the higher-scoring one.
  //
  // Only applies to comment_on_match / flag_for_review (decisions that carry
  // a best_match_id). Closed-match (skip_match_done) already short-circuits.
  const target_eligible = new Set(['comment_on_match', 'flag_for_review']);
  const groups = {};
  for (let i = 0; i < decided_tasks.length; i++) {
    const t = decided_tasks[i];
    if (!target_eligible.has(t.matcher_decision)) continue;
    if (!t.best_match_id) continue;
    if (!groups[t.best_match_id]) groups[t.best_match_id] = [];
    groups[t.best_match_id].push(i);
  }
  let same_target_dup_count = 0;
  for (const [issue_id, idxs] of Object.entries(groups)) {
    if (idxs.length < 2) continue;
    idxs.sort((a, b) => (decided_tasks[b].matcher_best_score || 0) - (decided_tasks[a].matcher_best_score || 0));
    const winner = decided_tasks[idxs[0]];
    for (let k = 1; k < idxs.length; k++) {
      const loser = decided_tasks[idxs[k]];
      loser.matcher_decision = 'skip_same_target_dup';
      loser.matcher_decision_reason = `same_best_match_${issue_id}_lower_score_${(loser.matcher_best_score || 0).toFixed(2)}_kept_task_${winner.id}`;
      loser.same_target_dup_of_task_id = winner.id;
      same_target_dup_count++;
    }
  }
  if (same_target_dup_count > 0) {
    console.log(`[matcher-decide] same-target dedup: collapsed ${same_target_dup_count} duplicate(s)`);
  }

  // Persist into staticData for future cross-call dedup.
  // Outcome stays 'pending' until Executor (Stage 6) overwrites with 'created' / 'commented' / 'skipped'.
  data.taskcrafter_drafts_by_uuid[this_call_uuid] = {
    drafts: this_call_drafts,
    completed_at: new Date().toISOString(),
  };

  const counts = decided_tasks.reduce((acc, t) => {
    acc[t.matcher_decision] = (acc[t.matcher_decision] || 0) + 1;
    return acc;
  }, {});
  console.log(`[matcher-decide] decisions: ${JSON.stringify(counts)}`);

  // Strip Anthropic raw fields — they don't belong in our pipeline state
  const { model, content, stop_reason, stop_sequence, stop_details, usage, id: _id, type: _type, role: _role, ...clean_j } = j;

  out.push({
    json: {
      ...clean_j,
      __taskcrafter_stage: 'matcher-decided',
      normalizer_output: {
        ...no,
        tasks: decided_tasks,
      },
      matcher_decision_counts: counts,
      anthropic_rerank_usage: usage || null,
      rerank_error,  // V1.3: null on healthy runs; non-null = dedup was degraded
    },
  });
}

return out;
