// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 2 — Matcher: build Anthropic batched semantic re-rank body.
//
// Input: tasks with matcher_candidates[] from 03-matcher-search.js
// Output: anthropic_body for batched scoring call.
//
// Only tasks needing semantic scoring get rerank entries:
//   - intent='create' AND no skip_reason AND matcher_candidates.length > 0
// Other tasks (skip, explicit_ref, no candidates, errors) bypass — decide-step
// handles them deterministically.
//
// Skips entire Anthropic call if no task needs scoring (returns empty rerank
// response — decide step handles).
//
// V0.1 (2026-05-28): initial.
// V0.2 (2026-06-12): switch dedup scorer from Sonnet 4.6 → Opus 4.8 with
// extended thinking. Rationale: this is the highest-reasoning step in the
// whole pipeline (judge candidate-vs-existing-issue similarity with
// nuance — anti-patterns, state decay, partial overlap). Sonnet was
// observed to both miss real dupes and over-flag legitimate new tasks.
// Opus + thinking budget gives the model room to actually compare each
// pair before scoring. Prompt caching on system already enabled, so the
// per-call cost is roughly 2x Sonnet (not 5x) — worth it for the impact.
// Downstream parser (05) updated to handle thinking-block-then-text shape.
// V0.3 (2026-07-06): FIX — Anthropic rejects `thinking:{type:'enabled',
// budget_tokens}` on claude-opus-4-8 with 400 invalid_request_error («Use
// "thinking.type.adaptive" and "output_config.effort"»), so EVERY rerank
// call since the V0.2 deploy failed: matcher saw no scores → all tasks
// became create_new → dedup layer silently dead (root cause of the 8
// duplicate proposals on the 07-01 Marketing Sprint call). Migrated to
// adaptive thinking + output_config.effort. Response shape for the 05
// parser is unchanged (thinking block(s) first, JSON in first text block;
// 05 already picks the text block by type, not index).
//
// Prompt treatment: LIGHT TOUCH — tenant-name token + the
// reason-language line. The scoring rubric / anti-patterns / state-decay
// rules ship VERBATIM (the tuned, F1-holdout-validated asset).

// ── __TENANT_PROMPT_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const PROMPT_TENANT_NAME = 'Acme Robotics';
const COMPANY_CONTEXT = 'About Acme Robotics: Builds warehouse robots and the SkyDock fleet-management platform for mid-size logistics operators.'; // from tenant.about — empty string when unset (prompts skip the line)
const PRIMARY_LANGUAGE_NAME = 'English';
const LANGUAGE_CLAUSE = 'LANGUAGE. Write all narrative fields in English. Proper nouns, product names, people\'s lastnames, and tracker identifiers stay as-is. Classification fields (team_tag, sub_tag, call_type, tags, topic_slug, priorities, enums) are ALWAYS English kebab-case code tokens — never translate them.';
const TEAM_TAG_ENUM = '"engineering" | "growth" | "mixed" | "product"';
const SUB_TAG_ENUM = 'null';
const TEAM_ROUTING_RULES = '  product (sub_tag=null)      : Product management, specs, pricing, roadmap (keywords: roadmap, spec, pricing, launch)\n  engineering (sub_tag=null)      : Backend, firmware, infra, releases (keywords: deploy, bug, api, firmware)\n  growth (sub_tag=null)      : Marketing, sales, partnerships, community (keywords: campaign, lead, partnership, funnel)\n  mixed                     : Multiple distinct topics, no dominant team';
const TEAM_INFERENCE_RULES = '- Product management, specs, pricing, roadmap → PRD\n- Backend, firmware, infra, releases → ENG\n- Marketing, sales, partnerships, community → GRW\n- ambiguous → null';
const VOICE_TRIGGER_RULES = 'Voice triggers (wake word + directive):\n  Wake words (any of, transcript may misspell): «backbrief»\n  Directives after wake:\n    explicit-task   : «task», «to-do», «make it a task», «create a task», «put it in a task», «log a task»\n    explicit-skip   : «not a task», «skip», «already done», «already fixed»\n    explicit-comment: «update PRD-123», «comment on PRD-123», «add to PRD-123»\n  False-positive guard: a wake word used as an ordinary noun with no directive within ~5 words is NOT a trigger.\n  When voice_marker is set, it HARD-OVERRIDES the auto-detected status:\n    explicit-task    → status=post-call (force-create as a tracker task downstream)\n    explicit-skip    → status=done-on-call (force-skip tracker task creation)\n    explicit-comment → status=in-progress (TaskCrafter adds a comment to the referenced issue instead of creating new)';
const STATUS_MARKER_RULES = 'action_items.status — CRITICAL detection rules:\n  done-on-call   : the action was COMPLETED during the call itself. Past-tense markers: «just fixed it», «we did it», «already done», «fixed it on the call», «we\'ve handled it». Default for problems that got solved mid-discussion. These will NOT become tracker tasks — TaskCrafter skips them.\n  post-call      : real future work that the assignee must do AFTER the call. Future-tense markers: «I\'ll do», «we\'ll need to», «I\'ll send», «I\'ll take it», «we should do». DEFAULT for genuine new commitments.\n  monitoring     : an ongoing observation/check, not a discrete deliverable. Markers: «keep an eye on», «monitor», «watch for», «track». TaskCrafter will NOT create tracker tasks for these.\n  in-progress    : ALREADY started before the call, continues after. Use sparingly — usually post-call is right.\nWhen in doubt between done-on-call and post-call — re-read the transcript_quote. Past verb + confirmed result → done-on-call. Future or imperative verb → post-call.';
const CONFIDENTIAL_TRIGGERS_LINE = 'named-individual layoff/firing/severance decisions, multisig wallet quorum changes, seed-phrase handling, private-key / deploy-wallet rotation, board-level resource reallocation between teams, founder compensation, equity / option grants, cap-table changes';
const TRACKER_REF_EXAMPLE = 'PRD-123';
const FEWSHOT_EXAMPLES = 'Ex 1 (normal CREATE):\nInput quote: "the staging deploy is red again — Novak, can you take a look" (12:34)\nOutput: {"id":"tc_a3f8d2e1","title":"Fix the red staging deploy","owner_lastname":"Novak","participants_lastnames":[],"team_inferred":"PRD","linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"high","transcript_quote":"the staging deploy is red again","source_ts_mmss":"12:34","skip_reason":null,"voice_marker":null,"rationale":"Explicit assignee, concrete deliverable"}\n\nEx 2 (status update on explicit ref):\nInput quote: "what about PRD-1234? — Done yesterday, we can close it" (08:15)\nOutput: {"id":"tc_b9e4c7a2","title":"Close PRD-1234 (completed)","owner_lastname":"Chen","participants_lastnames":[],"team_inferred":"PRD","linear_ref_explicit":"PRD-1234","intent":"update_status","intent_change_value":"Done","priority":"medium","transcript_quote":"Done yesterday, we can close it","source_ts_mmss":"08:15","skip_reason":null,"voice_marker":null,"rationale":"Existing issue, explicit completion"}\n\nEx 3 (skip philosophical):\nInput quote: "we should think about a new pricing model some day, let\'s revisit next time"\nOutput: {"id":"tc_c1f7d9b3","title":"(skip)","owner_lastname":null,"participants_lastnames":[],"team_inferred":null,"linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"medium","transcript_quote":"we should think about a new pricing model","source_ts_mmss":null,"skip_reason":"philosophical","voice_marker":null,"rationale":"Deferred to a future call, no commitment"}\n\nEx 4 (sensitivity):\nInput quote: "let\'s discuss Chen\'s compensation — raise it to X"\nOutput: {"id":"tc_d2a8b4f1","title":"(skip)","owner_lastname":null,"participants_lastnames":[],"team_inferred":null,"linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"medium","transcript_quote":"","source_ts_mmss":null,"skip_reason":"sensitive","voice_marker":null,"rationale":"Compensation — content sanitized"}\n\nEx 5 (consolidation — rule 3):\nInput: 3 micro items from Chen on the public docs (quickstart, FAQ, pricing page)\nOutput: {"id":"tc_e8b3a2c9","title":"Update the public docs: quickstart, FAQ, pricing","owner_lastname":"Chen","participants_lastnames":[],"team_inferred":"PRD","linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"medium","transcript_quote":"update the docs ... FAQ ... pricing","source_ts_mmss":null,"skip_reason":null,"voice_marker":null,"rationale":"One owner + one topic, merged per rule 3"}\n\nEx 6 (voice trigger):\nInput quote: "backbrief, make it a task: prepare the beta launch checklist"\nOutput: {"id":"tc_f1d4a8b3","title":"Prepare the beta launch checklist","owner_lastname":null,"participants_lastnames":[],"team_inferred":"PRD","linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"high","transcript_quote":"backbrief, make it a task: prepare the beta launch checklist","source_ts_mmss":null,"skip_reason":null,"voice_marker":"explicit-task","rationale":"Voice trigger — explicit command to create a task"}';
const FEEDBACK_PHRASE_HINTS = '  good: «looks good», «all correct», «approved», «lgtm»\n  already_exists: «task already exists», «already in the tracker», «we already have this one»\n  already_done: «already done», «done», «this is finished»\n  duplicate_in_batch: «duplicate of item», «same as item», «dupe of #»\n  wrong_owner: «wrong owner», «should be assigned to», «reassign to»\n  wrong_team: «wrong team», «belongs to the other team»\n  wrong_priority: «not urgent», «priority is wrong», «this is low priority»\n  wrong_title: «title is wrong», «rename it», «the title misses the point»'; // per-language exemplars (packs); hints only — P5 classifies by meaning
const TASK_BLOCK_HEADERS = {
  context: '📌 Context',
  extra: '📎 Additional information',
  result: '🎯 Expected result',
  task: '✅ Task',
}; // 4-block canon (plugin/templates/frontmatter/task-4block.md); primary-language pack may override
// ── __TENANT_PROMPT_END__ ──
// ── __TENANT_LLM_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const LLM_COMPOSER = {
  max_tokens: 8192,
  model: 'claude-haiku-4-5',
};
const LLM_FEEDBACK = {
  max_tokens: 4096,
  model: 'claude-sonnet-4-6',
};
const LLM_MATCHER = {
  effort: 'high',
  max_tokens: 32000,
  model: 'claude-opus-4-8',
  thinking: 'adaptive',
};
const LLM_NORMALIZER = {
  max_tokens: 8192,
  model: 'claude-sonnet-4-6',
};
const LLM_SUMMARIZER = {
  max_tokens: 16384,
  model: 'claude-sonnet-4-6',
};
// ── __TENANT_LLM_END__ ──

const SYSTEM_PROMPT = `You are TaskCrafter Matcher for ${PROMPT_TENANT_NAME} — semantic similarity scorer between proposed new tasks and existing tracker issues.
${COMPANY_CONTEXT ? COMPANY_CONTEXT + "\n" : ""}
INPUT: an object { candidates_corpus: [{id, identifier, title, description, state, assignee, labels}], tasks: [{...}] }.
Each task carries candidate_ids that reference entries in candidates_corpus (the corpus is DE-DUPLICATED — a candidate shared by several tasks appears once; look up each candidate's details there by id).
OUTPUT: strict JSON with scores per (task, candidate) pair. NO prose. NO markdown fence.

SCORING RULES:

For each candidate, score 0.00-1.00:
- 1.00 = identical task (same action, same scope, same intent)
- 0.85-0.99 = same task with minor wording differences → COMMENT on existing
- 0.70-0.84 = closely related (sub-task of the same effort, follow-up to same theme) → flag for human pick between COMMENT vs CREATE
- 0.40-0.69 = adjacent theme but different actual task → CREATE new, but mention existing in description
- 0.00-0.39 = unrelated → CREATE new, ignore candidate

CONSIDER:
- Title overlap (highest weight)
- Description content overlap
- Same assignee → bonus (+0.05)
- Same labels → bonus (+0.05)
- Candidate state: if Completed/Done within last 7d, score down by 0.10 (often "we already did the thing", new task is different work)
- Candidate state: if Cancelled, score down by 0.20 (it was dropped, new task likely different)

ANTI-PATTERNS (don't match):
- "Done previously, now redo it" — different tasks, not match (e.g. v1 fixed, v2 needed)
- Topic name matches but actions differ ("обсудить X" vs "сделать X" = different)
- Same person but different topic = no match

OUTPUT SCHEMA (strict):

{
  "scores": [
    {
      "task_id": "tc_xxx",
      "scored_candidates": [
        { "candidate_id": "<tracker-uuid>", "candidate_identifier": "${TRACKER_REF_EXAMPLE}", "score": 0.87, "reason": "<short>" }
      ],
      "best_score": 0.87,
      "best_candidate_id": "<tracker-uuid>" | null,
      "best_candidate_identifier": "${TRACKER_REF_EXAMPLE}" | null
    }
  ]
}

If scored_candidates is empty for a task (none of the candidates are relevant), set best_score: 0, best_candidate_id: null.

Write every "reason" in ${PRIMARY_LANGUAGE_NAME}. English for IDs.

Remember: output ONLY the JSON object. No markdown fence.`;

// === main ===
const items = $input.all();
const out = [];

for (const it of items) {
  const j = it.json || {};
  const no = j.normalizer_output;
  if (!no || !Array.isArray(no.tasks)) {
    out.push({ json: { ...j, __taskcrafter_error: 'rerank_no_normalizer_output' } });
    continue;
  }

  // V0.4 (2026-07-08): COMPACT payload — de-duplicate candidates into a shared
  // corpus + per-task candidate_id references, and trim descriptions 400→150.
  // The 2026-07-08 efficiency audit found the old per-pair inline candidates
  // were ~76% duplicate serialisations (exec 1330: 559 candidate entries but
  // only 130 unique → 197.6k input tokens = $1.13 for ONE call, ~80% of that
  // run's LLM cost). The corpus form is LOSSLESS and cuts input ~70%
  // (197k→~55k). Output schema is unchanged, so 05 needs no change. Also
  // dropped low-signal fields (state_type — redundant with state.name;
  // updatedAt) that only inflated tokens.
  const corpus = new Map();   // candidate id → deduped candidate object
  const tasksC = [];
  for (const t of no.tasks) {
    if (t.skip_reason) continue;
    if (t.linear_ref_explicit) continue;  // direct ref — bypass scoring
    if (!Array.isArray(t.matcher_candidates) || t.matcher_candidates.length === 0) continue;

    const candidate_ids = [];
    for (const c of t.matcher_candidates) {
      if (!corpus.has(c.id)) {
        corpus.set(c.id, {
          id: c.id,
          identifier: c.identifier,
          title: c.title,
          description: (c.description || '').slice(0, 150),
          state: c.state?.name || 'unknown',
          assignee: c.assignee?.displayName || c.assignee?.name || null,
          labels: (c.labels?.nodes || []).map(l => l.name),
        });
      }
      candidate_ids.push(c.id);
    }
    tasksC.push({
      id: t.id,
      title: t.title,
      owner_lastname: t.owner_lastname,
      team_inferred: t.team_inferred,
      priority: t.priority,
      transcript_quote: t.transcript_quote?.slice(0, 200),
      candidate_ids,
    });
  }

  if (tasksC.length === 0) {
    // No tasks need scoring — skip Anthropic call, pass through with empty rerank
    console.log(`[rerank-body] no tasks need semantic scoring — skipping Anthropic`);
    out.push({
      json: {
        ...j,
        __taskcrafter_stage: 'rerank-body-built',
        __skip_anthropic_rerank: true,
        rerank_output: { scores: [] },  // pre-populate empty rerank
      },
    });
    continue;
  }

  const candidates_corpus = [...corpus.values()];
  const user_message = `Score each task's candidate_ids against that task, per the rules.
Candidate details are in candidates_corpus (de-duplicated — look up each id there).

\`\`\`json
${JSON.stringify({ candidates_corpus, tasks: tasksC }, null, 2)}
\`\`\`

Output only the JSON.`;

  const anthropic_body = {
    model: LLM_MATCHER.model,  // the highest-reasoning step — see file header (llm.matcher)
    // V0.3: max_tokens stays the TOTAL ceiling (thinking + output). Adaptive
    // thinking self-sizes per request; effort 'high' preserves the reasoning
    // depth the old 8k budget was buying (compare 10-15 pairs with
    // anti-patterns + state checks) while the model stops thinking as soon
    // as the comparison is done instead of padding toward a fixed budget.
    // Visible-output headroom for the JSON array is unchanged (~24k).
    max_tokens: LLM_MATCHER.max_tokens,
    thinking: { type: LLM_MATCHER.thinking },
    output_config: { effort: LLM_MATCHER.effort },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // V0.4 (2026-07-08): removed inert cache_control — the system prompt is
        // ~600 tokens, below Opus's 4096-token minimum cacheable prefix, so the
        // marker never created a cache (cache_creation=0 confirmed). Rerank also
        // runs once per pipeline, so there is never a second read. Misleading.
      },
    ],
    messages: [
      { role: 'user', content: user_message }
    ],
  };

  const totalRefs = tasksC.reduce((s, t) => s + t.candidate_ids.length, 0);
  console.log(`[rerank-body] built body for ${tasksC.length} tasks, ` +
              `${candidates_corpus.length} unique candidates (${totalRefs} refs — ${totalRefs - candidates_corpus.length} dedup'd)`);

  out.push({
    json: {
      ...j,
      __taskcrafter_stage: 'rerank-body-built',
      anthropic_body,
      __pairs_count: tasksC.length,
    },
  });
}

return out;
