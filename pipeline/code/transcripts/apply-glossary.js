// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — runs once for all items.
// Cleans up ASR mangling of the tenant's product/domain terms in WebVTT
// content (speech-to-text misrecognizes product names; tenant.glossary maps
// the observed variants back to canonical spellings).
//
// P0 contract vs v0: input.length MUST equal output.length, otherwise throw
// with the full diagnostic. This is the assertion that would have surfaced
// exec 56's silent 4→3 drop immediately.

// ── __TENANT_GLOSSARY_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const GLOSSARY = [ // ASR mis-hearings → canonical spelling, compiled from tenant.glossary
  [/\bsky\s+dock\b/gi, 'SkyDock'],
  [/\bskydoc\b/gi, 'SkyDock'],
  [/\bsky-doc\b/gi, 'SkyDock'],
  [/\bflux\s+api\b/gi, 'FluxAPI'],
  [/\bflex\s+api\b/gi, 'FluxAPI'],
  [/\brover\s+o\s+s\b/gi, 'RoverOS'],
  [/\brover\s+us\b/gi, 'RoverOS'],
];
// ── __TENANT_GLOSSARY_END__ ──

const items = $input.all();

function cleanVtt(s) {
  let v = String(s || '');
  for (const [re, repl] of GLOSSARY) v = v.replace(re, repl);
  return v;
}

const out = items.map((it, idx) => {
  const vtt = it.json.vtt_content || it.json.body || '';
  if (typeof vtt !== 'string' || vtt.length === 0) {
    // DO NOT silently drop. Surface bad items as flagged-pass so downstream sees them.
    return {
      json: {
        ...it.json,
        vtt_content: '',
        glossary_applied: false,
        glossary_warn   : `item[${idx}] has empty vtt_content`,
      },
    };
  }
  return {
    json: {
      ...it.json,
      vtt_content      : cleanVtt(vtt),
      glossary_applied : true,
    },
  };
});

// P0 assert — the missing piece in v0.
if (out.length !== items.length) {
  const inTopics  = items.map(i => i.json.topic || '(no topic)');
  const outTopics = out.map(i => i.json.topic   || '(no topic)');
  throw new Error(
    `Glossary node changed item count: in=${items.length} out=${out.length}. ` +
    `in_topics=${JSON.stringify(inTopics)} out_topics=${JSON.stringify(outTopics)}`
  );
}

return out;
