// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 4 — Composer: parse Anthropic response, attach composed
// text to each task's router_payload.
//
// Input shapes:
//   (a) Anthropic raw response (FALSE branch of IF — composer called):
//       { model, content: [{type:'text', text:'<JSON>'}], usage, ... }
//   (b) Skip-branch from Build composer body (no composition needed):
//       { __skip_anthropic_composer: true, composer_output: { compositions: [] } }
//
// Output: items with `composer_output.compositions[]` and per-task
//         `router_payload.title` + `router_payload.description_markdown` (CREATE)
//         or `router_payload.comment_markdown` (COMMENT).
//
// V0.1 (2026-05-28): initial.

function extractJson(s) {
  if (!s || typeof s !== 'string') return null;
  s = s.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch (e) { return null; }
}

// M-promptinj (NOW-partial): validate the composer output against the expected
// schema and REPAIR off-schema output by dropping bad compositions (downstream
// falls back to the normalizer title / stage-12 placeholder — identical to a
// missing composition). A poisoned transcript that coaxes the composer into an
// off-shape blob can no longer smuggle fields into router_payload.
const VALID_COMPOSER_ACTION = new Set(['create', 'comment']);
function sanitizeComposerOutput(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.compositions)) {
    if (raw && typeof raw === 'object' && raw.compositions !== undefined) {
      warnings.push('compositions is not an array — dropped');
    }
    return { compositions: [], __composer_schema_warnings: warnings };
  }
  const clean = [];
  raw.compositions.forEach((c, i) => {
    if (!c || typeof c !== 'object') { warnings.push(`comp[${i}] not an object`); return; }
    if (typeof c.task_id !== 'string' || !c.task_id) { warnings.push(`comp[${i}] missing task_id`); return; }
    if (!VALID_COMPOSER_ACTION.has(c.action)) { warnings.push(`comp[${c.task_id}] bad action "${c.action}"`); return; }
    // Coerce off-type text fields to null rather than trusting arbitrary shapes.
    const strOrNull = (v) => (typeof v === 'string' ? v : null);
    clean.push({
      task_id: c.task_id,
      action: c.action,
      title: strOrNull(c.title),
      description_markdown: strOrNull(c.description_markdown),
      comment_markdown: strOrNull(c.comment_markdown),
      warning: strOrNull(c.warning),
    });
  });
  if (warnings.length > 0) {
    console.warn(`[composer-parse] schema repair dropped/cleaned ${warnings.length}: ${warnings.slice(0, 5).join('; ')}`);
  }
  return { compositions: clean, ...(warnings.length > 0 ? { __composer_schema_warnings: warnings } : {}) };
}

// Reach back to Build composer body for normalizer_output context — Anthropic
// rerank-call branch replaces $json so we lose pipeline state.
const upstream_ctx = $('Build composer body').first().json;

const items = $input.all();
const out = [];

for (const it of items) {
  const j_in = it.json || {};
  const j = (j_in.normalizer_output && Array.isArray(j_in.normalizer_output?.tasks))
    ? j_in
    : { ...upstream_ctx, ...j_in };

  const no = j.normalizer_output;
  if (!no || !Array.isArray(no.tasks)) {
    out.push({ json: { ...j, __taskcrafter_error: 'composer_parse_no_normalizer' } });
    continue;
  }

  // Extract composer_output: either pre-set (skip branch) or parse from Anthropic raw
  let composer_output = j.composer_output;
  if (!composer_output && Array.isArray(j_in.content) && j_in.content[0]?.text) {
    const parsed = extractJson(j_in.content[0].text);
    if (parsed) composer_output = parsed;
    else console.warn(`[composer-parse] JSON parse failed; text head: ${j_in.content[0].text.slice(0, 200)}`);
  }
  // M-promptinj: validate + repair against the expected output schema.
  composer_output = sanitizeComposerOutput(composer_output || { compositions: [] });

  const by_task_id = {};
  for (const c of (composer_output.compositions || [])) {
    if (c && c.task_id) by_task_id[c.task_id] = c;
  }

  // Attach to each task's router_payload
  const augmented_tasks = no.tasks.map(task => {
    const t = { ...task };
    const c = by_task_id[task.id];
    if (!c) return t;  // no composition (skip, no-action, or composer missed)

    if (!t.router_payload) t.router_payload = {};
    if (c.warning) t.router_payload.composer_warning = c.warning;

    if (c.action === 'create') {
      t.router_payload.title = c.title || task.title;  // fall back to normalizer title
      t.router_payload.description_markdown = c.description_markdown || null;
    } else if (c.action === 'comment') {
      t.router_payload.comment_markdown = c.comment_markdown || null;
    }
    return t;
  });

  // Strip Anthropic raw fields
  const { model, content, stop_reason, stop_sequence, stop_details, usage,
          id: _id, type: _type, role: _role, ...clean_j } = j;

  out.push({
    json: {
      ...clean_j,
      __taskcrafter_stage: 'composer-parsed',
      normalizer_output: {
        ...no,
        tasks: augmented_tasks,
      },
      composer_output,
      anthropic_composer_usage: usage || null,
    },
  });
}

return out;
