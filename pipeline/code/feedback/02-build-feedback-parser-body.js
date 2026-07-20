// SPDX-License-Identifier: BUSL-1.1
// Feedback Collector — Stage 2: build the Anthropic feedback-parser request
// body (P5).
//
// Extraction note: the production feedback collector lived
// ONLY inline in the workflow JSON (never got the code-to-repo treatment).
// This file is the parser-prompt extraction owned by the prompt-rebuild task;
// the sibling node extractions (01-filter-tc-posts, 03-build-feedback-digest,
// post/ack HTTP params) are the node-extraction task's outputs and register in
// pipeline-nodes.js alongside this file.
//
// n8n Code node, mode: runOnceForEachItem.
// Input: the Slack conversations.replies response for one TaskCrafter digest
//   post that needs feedback parsing; call context is re-stitched from the
//   'Filter TC posts needing feedback' node (tc_message_ts, tc_message_text).
// Output: { ...ctx, anthropic_body } — or { ...ctx, __skip: true } when the
//   thread has no human replies.
//
// P5 prompt strategy: the verdict taxonomy (good / already_exists
// / already_done / duplicate_in_batch / wrong_* / unclear / no_signal) is the
// CONTRACT — training aggregation depends on the exact tokens — and ships
// verbatim. Per-language phrase exemplars come from the language packs via the
// TENANT_PROMPT region as HINTS ONLY: the prompt instructs classification by
// MEANING, so a reply in an unlisted language still degrades gracefully.

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

const SYSTEM_PROMPT = `You analyze human feedback on automated task proposals for ${PROMPT_TENANT_NAME}.
The pipeline posted a message with N numbered task proposals to the team's digest channel; team members replied in the thread with free-form text saying which proposals were right and which were wrong.

Given the proposal post and the human replies, output strict JSON:
{
  "per_proposal": [
    {
      "idx": <1-based proposal number>,
      "verdict": "good" | "already_exists" | "already_done" | "duplicate_in_batch" | "wrong_owner" | "wrong_team" | "wrong_priority" | "wrong_title" | "unclear" | "no_signal",
      "evidence_quote": "<short quote from a human reply>",
      "improvement_hint": "<1-sentence hint for the pipeline's prompt designer, or empty>"
    }
  ],
  "global_signals": ["<any cross-cutting observations>"]
}

The verdict taxonomy is a fixed contract — downstream training aggregation depends on these exact tokens. NEVER invent new verdicts.

Verdict semantics:
- "good"               = a human approved the proposal.
- "already_exists"     = the task already exists in the tracker (a matcher recall miss).
- "already_done"       = the work is already finished — the proposal is stale.
- "duplicate_in_batch" = the same task appears more than once in THIS proposal batch.
- "wrong_owner" / "wrong_team" / "wrong_priority" / "wrong_title" = the named proposal field is wrong.
- "unclear"            = a human reacted to the proposal but the intent is ambiguous.
- "no_signal"          = no human said anything about this proposal.

Classify by MEANING, not by keyword match. The phrase exemplars below come from the team's working languages and are hints only — a reply in ANY language must still be classified by what it means:
${FEEDBACK_PHRASE_HINTS}

Rules:
- One entry per proposal in the original post (count from 1).
- If no human signal for a given proposal, use verdict "no_signal".
- evidence_quote ≤ 80 chars, verbatim in the reply's original language — do not translate it.
- ${LANGUAGE_CLAUSE} Narrative fields covered: improvement_hint, global_signals[]. verdict is a code token.
- Output JSON only, no prose, no markdown fences.`;

// === main ===
// Re-stitch the TC-post context captured by the filter node (n8n
// runOnceForEachItem keeps item lineage across nodes).
const ctx = $('Filter TC posts needing feedback').item.json;
const repliesResp = $json; // Slack conversations.replies response

const tc_ts = ctx.tc_message_ts;
const tc_text = ctx.tc_message_text;

// Human replies = thread messages after the proposal post that are not bot
// posts and not channel-event subtypes. Production pinned the bot's user id
// here; filtering on `bot_id` is equivalent (every bot post carries it,
// including the pipeline's own digest replies) and needs no tenant data.
const messages = (repliesResp.messages || []);
const human_replies = messages
  .filter(m => m.ts > tc_ts)
  .filter(m => m.user && !m.bot_id && !m.subtype)
  .map(m => ({ user: m.user, ts: m.ts, text: m.text || '' }))
  .filter(m => m.text.trim().length > 0);

if (human_replies.length === 0) {
  return { json: { ...ctx, __skip: true, __skip_reason: 'no_human_replies' } };
}

const replies_block = human_replies
  .map(r => `[user:${r.user}] ${r.text}`)
  .join('\n\n');

const user_prompt = `=== TASK PROPOSAL POST (numbered proposals) ===\n${tc_text}\n\n=== HUMAN REPLIES ===\n${replies_block}`;

return { json: {
  ...ctx,
  human_replies_count: human_replies.length,
  anthropic_body: {
    model: LLM_FEEDBACK.model,
    max_tokens: LLM_FEEDBACK.max_tokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user_prompt }],
  },
}};
