// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — "Build feedback digest" (feedback collector, stage 3).
// Mode: Run Once for Each Item.
//
// Parse the Anthropic JSON output, build the Slack digest text posted back
// into the call thread. Extracted from the inline prod node; the verdict →
// emoji table mirrors the P5 verdict taxonomy (the contract) and is generic.
//
// Digest strings are EN (the digest channel has one working language —
// the pack contract; feedback.* keys are not all in ui_strings yet, tracked gap).
const resp = $json;
const ctx = $('Filter TC posts needing feedback').item.json;

let txt = (resp.content && resp.content[0]?.text) || '';
const fenceMatch = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
if (fenceMatch) txt = fenceMatch[1].trim();
const first = txt.indexOf('{');
const last = txt.lastIndexOf('}');
let parsed = null;
if (first !== -1 && last > first) {
  try { parsed = JSON.parse(txt.slice(first, last + 1)); }
  catch (e) { console.warn('[fb-collector] anthropic JSON parse failed:', e.message); }
}
if (!parsed) {
  return { json: { ...ctx, __error: 'parse_failed', raw: txt.slice(0, 500) }};
}

// M-outinj / M-promptinj (output-side): the parser output below (evidence
// quotes, improvement hints, global signals) is model-derived from untrusted
// human thread replies. Escape it before it enters the Slack digest mrkdwn so a
// crafted reply can't inject links (<url|text>), pings (<@U…>, <!channel>),
// @channel/@here/@everyone broadcasts, or javascript:/data: schemes. Same
// three-escape + broadcast/scheme defusing as the main digest builder.
function escapeSlackText(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=(?:here|channel|everyone)\b)/gi, '@​')
    .replace(/\b(javascript|data|vbscript):/gi, '$1:​');
}

const per = parsed.per_proposal || [];
const globals = parsed.global_signals || [];

const VERDICT_EMOJI = {
  good: ':white_check_mark:',
  already_exists: ':repeat:',
  already_done: ':checkered_flag:',
  duplicate_in_batch: ':copy:',
  wrong_owner: ':bust_in_silhouette:',
  wrong_team: ':busts_in_silhouette:',
  wrong_priority: ':triangular_flag_on_post:',
  wrong_title: ':pencil2:',
  unclear: ':grey_question:',
  no_signal: ':white_circle:',
};

const lines = [];
lines.push(':bar_chart: *Backbrief · tasks feedback digest* (auto-collected from thread replies)');
for (const p of per) {
  const e = VERDICT_EMOJI[p.verdict] || ':grey_question:';
  const quote = p.evidence_quote ? ` _\"${escapeSlackText(p.evidence_quote)}\"_` : '';
  const hint = p.improvement_hint ? ` — hint: ${escapeSlackText(p.improvement_hint)}` : '';
  lines.push(`${e} #${p.idx}: \`${p.verdict}\`${quote}${hint}`);
}
if (globals.length) {
  lines.push('');
  lines.push('*Global signals:*');
  for (const g of globals) lines.push(`- ${escapeSlackText(g)}`);
}
lines.push('');
lines.push(`_${ctx.human_replies_count} human replies parsed via Claude_`);

return { json: {
  ...ctx,
  digest_text: lines.join('\n'),
  parsed_feedback: parsed,
  anthropic_usage: resp.usage || null,
}};
