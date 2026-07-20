// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 1 — Normalizer: parse + validate Anthropic response.
//
// Input: Anthropic Messages API response in $json (full response object).
//        Expected: { content: [{ type: 'text', text: '<JSON>' }], stop_reason, usage, ... }
//
// Output: validated structured task drafts → next stage (Matcher).
//
// On validation failure: emit error item with __taskcrafter_error so DLQ handler can pick up.
//
// V0.1 (2026-05-28): initial implementation.

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
const VALID_TEAM = VALID_TRACKER_TEAM;  // tracker team keys are tenant config (features.tracker.team_mapping)

const VALID_CALL_MODES = new Set(['discovery', 'planning', 'mixed']);
const VALID_INTENT = new Set(['create', 'update_status', 'update_assignee', 'update_priority', 'comment_only']);
const VALID_PRIORITY = new Set(['low', 'medium', 'high', 'urgent']);
const VALID_SKIP_REASON = new Set(['discussion_only', 'micro', 'sensitive', 'already_done_on_call', 'philosophical']);  // null also valid
const VALID_VOICE_MARKER = new Set(['explicit-task', 'explicit-skip', 'explicit-comment']);  // null also valid
const VALID_STATUS_VALUE = new Set(['Todo', 'In Progress', 'In Review', 'Done', 'Cancelled', 'Backlog', 'Triage']);

function extractJson(s) {
  // Anthropic sometimes returns text with markdown fences despite instructions.
  // Tolerate both.
  if (!s || typeof s !== 'string') return null;
  s = s.trim();
  // Strip ```json ... ``` fence
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // Find first { and last } to bracket
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch (e) {
    return null;
  }
}

function validateTask(task, idx) {
  const errs = [];
  if (typeof task !== 'object' || !task) {
    errs.push(`task[${idx}] is not an object`);
    return errs;
  }
  if (typeof task.id !== 'string' || !task.id.startsWith('tc_') || task.id.length !== 11) {
    errs.push(`task[${idx}].id "${task.id}" — must be tc_<8hex>`);
  }
  if (typeof task.title !== 'string' || task.title.length === 0 || task.title.length > 80) {
    errs.push(`task[${idx}].title invalid (${task.title?.length || 0} chars)`);
  }
  if (task.owner_lastname !== null && typeof task.owner_lastname !== 'string') {
    errs.push(`task[${idx}].owner_lastname must be string or null`);
  }
  if (!Array.isArray(task.participants_lastnames)) {
    errs.push(`task[${idx}].participants_lastnames not array`);
  }
  if (task.team_inferred !== null && !VALID_TEAM.has(task.team_inferred)) {
    errs.push(`task[${idx}].team_inferred invalid: "${task.team_inferred}"`);
  }
  if (task.linear_ref_explicit !== null) {
    if (typeof task.linear_ref_explicit !== 'string' || !/^[A-Z]{2,5}-\d+$/.test(task.linear_ref_explicit)) {
      errs.push(`task[${idx}].linear_ref_explicit "${task.linear_ref_explicit}" invalid format`);
    }
  }
  if (!VALID_INTENT.has(task.intent)) {
    errs.push(`task[${idx}].intent invalid: "${task.intent}"`);
  }
  // intent_change_value cross-validation
  if (task.intent === 'update_status' && task.intent_change_value !== null) {
    if (!VALID_STATUS_VALUE.has(task.intent_change_value)) {
      errs.push(`task[${idx}].intent_change_value "${task.intent_change_value}" invalid for update_status`);
    }
  }
  if (task.intent === 'update_priority' && task.intent_change_value !== null) {
    if (!VALID_PRIORITY.has(task.intent_change_value)) {
      errs.push(`task[${idx}].intent_change_value "${task.intent_change_value}" invalid for update_priority`);
    }
  }
  if (!VALID_PRIORITY.has(task.priority)) {
    errs.push(`task[${idx}].priority invalid: "${task.priority}"`);
  }
  if (typeof task.transcript_quote !== 'string' || task.transcript_quote.length > 200) {
    errs.push(`task[${idx}].transcript_quote too long (${task.transcript_quote?.length || 0})`);
  }
  if (task.skip_reason !== null && !VALID_SKIP_REASON.has(task.skip_reason)) {
    errs.push(`task[${idx}].skip_reason invalid: "${task.skip_reason}"`);
  }
  if (task.voice_marker !== null && task.voice_marker !== undefined && !VALID_VOICE_MARKER.has(task.voice_marker)) {
    errs.push(`task[${idx}].voice_marker invalid: "${task.voice_marker}"`);
  }
  return errs;
}

function validateResponse(parsed) {
  const errs = [];
  if (!parsed || typeof parsed !== 'object') {
    errs.push('response not an object');
    return errs;
  }
  if (!VALID_CALL_MODES.has(parsed.call_mode)) {
    errs.push(`call_mode invalid: "${parsed.call_mode}"`);
  }
  if (!Array.isArray(parsed.linear_refs_mentioned)) {
    errs.push('linear_refs_mentioned not array');
  }
  if (typeof parsed.filtered_count !== 'number') {
    errs.push('filtered_count not number');
  }
  if (!Array.isArray(parsed.filtered_reasons)) {
    errs.push('filtered_reasons not array');
  }
  if (!Array.isArray(parsed.tasks)) {
    errs.push('tasks not array');
    return errs;
  }
  parsed.tasks.forEach((t, i) => errs.push(...validateTask(t, i)));
  return errs;
}

// Drop initial-only patterns ("K." or "K") — single letters can't be valid lastnames.
// Mirror of V1.5.19 fix in n8n/code/parse-anthropic-response.js resolveLastname().
function sanitizeLastname(name) {
  if (typeof name !== 'string' || !name) return null;
  const trimmed = name.trim();
  if (/^[A-Za-zА-Яа-яЁё]\.?$/.test(trimmed)) return null;
  return trimmed;
}

function sanitizeTask(task) {
  if (task.owner_lastname) task.owner_lastname = sanitizeLastname(task.owner_lastname);
  if (Array.isArray(task.participants_lastnames)) {
    task.participants_lastnames = task.participants_lastnames
      .map(sanitizeLastname)
      .filter(p => p !== null);
  }
  return task;
}

// === main ===
const items = $input.all();
const out = [];

// Reach back to Build normalizer body for upstream context — Anthropic HTTP
// call replaces $json with API response, so meta fields (slack_channel_id,
// zoom_meeting_uuid, topic etc) are otherwise lost.
const upstream_ctx = $('Build normalizer body').first().json;

for (const it of items) {
  const j = it.json || {};
  // Strip pipeline-internal fields from upstream context — keep only meeting meta
  const { anthropic_body, __taskcrafter_stage, ...upstream_meta } = upstream_ctx;

  // Anthropic response shape: content[0].text contains the JSON string
  const content = (j.content && Array.isArray(j.content) && j.content[0]) || null;
  if (!content || content.type !== 'text' || typeof content.text !== 'string') {
    out.push({
      json: {
        ...upstream_meta,
        __taskcrafter_error: 'normalizer_no_content',
        __anthropic_raw: j,
      },
    });
    continue;
  }

  const stopReason = j.stop_reason;
  if (stopReason === 'max_tokens') {
    console.warn(`[normalizer-parse] stop_reason=max_tokens — response likely truncated`);
  }

  const parsed = extractJson(content.text);
  if (!parsed) {
    out.push({
      json: {
        ...upstream_meta,
        __taskcrafter_error: 'normalizer_unparseable_json',
        __anthropic_raw_text: content.text.slice(0, 500),
      },
    });
    continue;
  }

  // Sanitize tasks before validation (drop single-letter lastnames)
  if (Array.isArray(parsed.tasks)) parsed.tasks.forEach(sanitizeTask);

  const errs = validateResponse(parsed);
  if (errs.length > 0) {
    console.warn(`[normalizer-parse] schema validation failed: ${errs.slice(0, 5).join('; ')}`);
    out.push({
      json: {
        ...upstream_meta,
        __taskcrafter_error: 'normalizer_schema_invalid',
        __validation_errors: errs,
        normalizer_output: parsed,  // pass through anyway for inspection
      },
    });
    continue;
  }

  // Success
  console.log(`[normalizer-parse] OK — ${parsed.tasks.length} tasks, mode=${parsed.call_mode}, filtered=${parsed.filtered_count}`);
  out.push({
    json: {
      ...upstream_meta,
      __taskcrafter_stage: 'normalizer-parsed',
      normalizer_output: parsed,
      anthropic_usage: j.usage || null,
    },
  });
}

return out;
