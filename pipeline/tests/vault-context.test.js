// SPDX-License-Identifier: BUSL-1.1
// T4 — FUNCTIONAL tests for the vault context loader (stub-C-vault-context.js).
//
// WHY THIS FILE EXISTS
// The loader is best-effort by design: every fetch failure degrades to null and
// is skipped. That is right for resilience and blinding for observability —
// "there is no context" and "the loader is broken" look identical from outside.
// A sibling production pipeline lost three of three context channels for weeks
// behind exactly that design, while a static test suite stayed green because it
// only asserted that certain strings existed in the source.
//
// So these tests do NOT grep the source. They EXECUTE the rendered node against
// a mocked GitHub/Zoom/Linear and assert on the text that actually lands in the
// prompt. Anything less cannot catch drift between this loader and the
// components that write what it reads.
//
// Run: node pipeline/tests/vault-context.test.js

'use strict';

const fs = require('fs');
const path = require('path');

const KIT = path.join(__dirname, '..', '..');
const CODE_DIR = path.join(KIT, 'pipeline', 'code');
const R = require(path.join(KIT, 'pipeline', 'tenant-render.js'));

const LOADER = 'transcripts/stub-C-vault-context.js';

/* ------------------------------------------------------------------ */
/* Tenant context — acme-en with a vault repo wired (fixture has none)  */
/* ------------------------------------------------------------------ */

const doc = R.loadTenant(path.join(KIT, 'pipeline', 'fixtures', 'tenants', 'acme-en.yaml'));
doc.vault = Object.assign({}, doc.vault, { repo: 'acme/acme-vault', branch: 'main' });
const packs = R.loadLangPacks(doc, path.join(KIT, 'pipeline', 'lang'));
const CTX = R.buildContext(doc, packs, {}, { kitRoot: KIT });

const RAW = fs.readFileSync(path.join(CODE_DIR, LOADER), 'utf8');
const RENDERED = R.renderSource(RAW, CTX).source;

/* ------------------------------------------------------------------ */
/* Mock transport — a virtual vault + Zoom + Linear                     */
/* ------------------------------------------------------------------ */

// repo: { 'path/to/file.md': '<content>', 'dir': [{name,type}] }
// Anything not present answers 404, exactly like GitHub.
function makeTransport({ repo = {}, zoomParticipants = null, linearUsers = {} }) {
  const calls = { github: [], zoomToken: 0, zoomRoster: 0, linearQueries: [] };

  return {
    calls,
    async httpRequest(opts) {
      const url = String(opts.url || '');

      if (url.startsWith('https://api.github.com/')) {
        const p = decodeURI((url.match(/\/contents\/([^?]*)/) || [])[1] || '');
        calls.github.push(p);
        if (!(p in repo)) return { statusCode: 404, body: { message: 'Not Found' } };
        const v = repo[p];
        if (Array.isArray(v)) return { statusCode: 200, body: v };
        return {
          statusCode: 200,
          body: { content: Buffer.from(v, 'utf8').toString('base64'), encoding: 'base64' },
        };
      }

      if (url.startsWith('https://zoom.us/oauth/token')) {
        calls.zoomToken++;
        return { statusCode: 200, body: { access_token: 'zoom-test-token', expires_in: 3600 } };
      }

      if (url.includes('api.zoom.us/v2/past_meetings/')) {
        calls.zoomRoster++;
        if (!zoomParticipants) return { statusCode: 404, body: {} };
        return { statusCode: 200, body: { participants: zoomParticipants } };
      }

      if (url === 'https://api.linear.app/graphql') {
        const body = opts.body || {};
        calls.linearQueries.push(body);
        const q = String(body.query || '');
        if (q.includes('users(filter')) {
          const name = body.variables && body.variables.n;
          const id = linearUsers[name];
          return { statusCode: 200, body: { data: { users: { nodes: id ? [{ id, name }] : [] } } } };
        }
        return { statusCode: 200, body: { data: { open: { nodes: [] }, closed: { nodes: [] } } } };
      }

      return { statusCode: 404, body: {} };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Runner — execute the rendered loader with `this.helpers` bound       */
/* ------------------------------------------------------------------ */

async function runLoader({ item, transport, mutateSource, staticData }) {
  let code = RENDERED;
  if (mutateSource) code = mutateSource(code);

  const input = { first: () => ({ json: item }), all: () => [{ json: item }] };
  const store = { global: staticData || {} };

  const fn = new Function(
    '$input', '$env', '$', '$getWorkflowStaticData', '$execution', '$workflow',
    code,
  );
  const out = await fn.call(
    { helpers: { httpRequest: transport.httpRequest.bind(transport) } },
    input,
    {},
    () => input,
    (scope) => { if (scope !== 'global') throw new Error('only global'); return store.global; },
    { id: 'exec-t4' },
    { id: 'wf-t4' },
  );
  return out[0].json;
}

const withCreds = (code) => code
  .replace("'__LINEAR_API_KEY_PLACEHOLDER__'", "'lin_api_TESTTOKEN'")
  .replace("'__ZOOM_ACCOUNT_ID__'", "'acct-test'")
  .replace("'__ZOOM_CLIENT_ID__'", "'cid-test'")
  .replace("'__ZOOM_CLIENT_SECRET__'", "'csec-test'");

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// A digest exactly as the PIPELINE writes it (build-commit-payload-v2.js:383).
const pipelineDigest = (canary) => [
  '---', 'type: transcript', 'team: product', '---', '',
  '## Summary (Quick brief)', '',
  '### Pricing model (12:04)', `- ${canary}`, '',
  '## Decisions', '', '1. none', '',
].join('\n');

// A digest as the PLUGIN/manual path writes it (templates/frontmatter/digest.md:19).
const templateDigest = (canary) => [
  '---', 'type: transcript', 'team: product', '---', '',
  '## Summary', '',
  '### Pricing model (12:04)', `- ${canary}`, '',
  '## Decisions', '', '1. none', '',
].join('\n');

const PRIOR_FILE = '2026-07-10 1300 pricing model review w Ivanova,Petrov.md';

function vaultWith(digestBody) {
  return {
    'docs/company.md': '# Acme\nWe build robots.',
    'docs/skills/summarizer.md': '# Summarizer\nBe concise.',
    'team': [{ name: 'Novak.md', type: 'file' }],
    'team/Novak.md': '---\nlastname: Novak\n---\n# Elena Novak',
    'product/transcripts': [{ name: PRIOR_FILE, type: 'file' }],
    [`product/transcripts/${PRIOR_FILE}`]: digestBody,
  };
}

const baseItem = {
  topic: 'Pricing model review',
  participants_lastnames: ['Novak'],
  zoom_meeting_uuid: 'abc==',
};

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

let pass = 0, fail = 0;
const queue = [];
function it(desc, fn) { queue.push([desc, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  for (const [desc, fn] of queue) {
    try { await fn(); console.log(`  ✓ ${desc}`); pass++; }
    catch (e) { console.log(`  ✗ ${desc}\n      ${e.message}`); fail++; }
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

/* ================================================================== */
/* D2 — FORMAT DRIFT: the prior-summary extractor vs what the pipeline */
/*      actually writes.                                              */
/* ================================================================== */

console.log('\n[D2] prior-summary extraction — extractor vs generator');

it('reads the Summary section out of a PIPELINE-written digest', async () => {
  const t = makeTransport({ repo: vaultWith(pipelineDigest('CANARY-PIPELINE-A')) });
  const out = await runLoader({ item: baseItem, transport: t });
  assert(
    t.calls.github.includes(`product/transcripts/${PRIOR_FILE}`),
    'precondition: the loader never even fetched the prior digest',
  );
  assert(
    out.vault_context_system_prompt.includes('CANARY-PIPELINE-A'),
    'the prior digest downloaded fine but its Summary never reached the prompt — '
    + 'the extractor anchors on a heading the pipeline no longer writes',
  );
});

it('still reads a TEMPLATE-written digest (manual/plugin path)', async () => {
  const t = makeTransport({ repo: vaultWith(templateDigest('CANARY-TEMPLATE-B')) });
  const out = await runLoader({ item: baseItem, transport: t });
  assert(
    out.vault_context_system_prompt.includes('CANARY-TEMPLATE-B'),
    'regression: the manual-path heading must keep working',
  );
});

it('counts prior summaries it actually parsed, not ones it merely downloaded', async () => {
  const t = makeTransport({ repo: vaultWith(pipelineDigest('CANARY-PIPELINE-C')) });
  const out = await runLoader({ item: baseItem, transport: t });
  assert(
    out.__vault_context_meta.prior_summaries === 1,
    `prior_summaries=${out.__vault_context_meta.prior_summaries}, expected 1`,
  );
});

/* ================================================================== */
/* D4 — CONSUMER DIVERGENCE: the roster is enriched in one place;      */
/*      do all consumers read the enriched version?                   */
/* ================================================================== */

console.log('\n[D4] roster enrichment — do all consumers see it');

const ZOOM_ROSTER = [
  { name: 'Elena Novak', user_email: 'elena@acme.dev' },
  { name: 'Maria Ivanova', user_email: 'maria@acme.dev' },
  { name: 'Andrei Petrov', user_email: 'andrei@acme.dev' },
];

it('team profiles are fetched for the ENRICHED roster', async () => {
  const repo = vaultWith(templateDigest('x'));
  repo['team'] = [
    { name: 'Novak.md', type: 'file' },
    { name: 'Ivanova.md', type: 'file' },
    { name: 'Petrov.md', type: 'file' },
  ];
  repo['team/Ivanova.md'] = '# Maria Ivanova';
  repo['team/Petrov.md'] = '# Andrei Petrov';
  const t = makeTransport({ repo, zoomParticipants: ZOOM_ROSTER });
  const out = await runLoader({ item: baseItem, transport: t, mutateSource: withCreds });
  assert(out.__vault_context_meta.profiles_loaded === 3,
    `profiles_loaded=${out.__vault_context_meta.profiles_loaded}, expected 3`);
});

it('tracker context is fetched for the ENRICHED roster, not the host seed', async () => {
  const t = makeTransport({
    repo: vaultWith(templateDigest('x')),
    zoomParticipants: ZOOM_ROSTER,
    linearUsers: { Novak: 'u1', Ivanova: 'u2', Petrov: 'u3' },
  });
  await runLoader({ item: baseItem, transport: t, mutateSource: withCreds });
  const queried = t.calls.linearQueries
    .filter(q => String(q.query).includes('users(filter'))
    .map(q => q.variables.n)
    .sort();
  assert(
    JSON.stringify(queried) === JSON.stringify(['Ivanova', 'Novak', 'Petrov']),
    `tracker lookups ran for ${JSON.stringify(queried)} — the Zoom roster resolved 3 people `
    + 'but the tracker channel still reads the host seed, so open issues are fetched for one person',
  );
});

it('hands the enriched roster to downstream nodes', async () => {
  const t = makeTransport({ repo: vaultWith(templateDigest('x')), zoomParticipants: ZOOM_ROSTER });
  const out = await runLoader({ item: baseItem, transport: t, mutateSource: withCreds });
  const seen = [].concat(out.participants_lastnames_enriched || []).sort();
  assert(
    JSON.stringify(seen) === JSON.stringify(['Ivanova', 'Novak', 'Petrov']),
    'the enriched roster never leaves this node: downstream consumers (frontmatter, '
    + 'taskcrafter) still see only the host seed',
  );
});

/* ================================================================== */
/* D5 — UNBOUNDED INJECTION: worst case scales with the input          */
/* ================================================================== */

console.log('\n[D5] injection budget');

// Cap chosen as the pipeline-side guarantee. Chars, not tokens, because that is
// what this node can measure; ~4 chars/token puts the ceiling near 15k tokens.
const PROMPT_BUDGET = 60000;

it('caps the prompt with a big roster and big profiles', async () => {
  const names = ['Novak', 'Ivanova', 'Petrov', 'Chen', 'Okafor'];
  const repo = vaultWith(templateDigest('x'));
  repo['team'] = names.map(n => ({ name: `${n}.md`, type: 'file' }));
  for (const n of names) repo[`team/${n}.md`] = `# ${n}\n` + 'x'.repeat(20000);
  repo['docs/skills/summarizer.md'] = '# Summarizer\n' + 'y'.repeat(30000);

  const t = makeTransport({
    repo,
    zoomParticipants: names.map(n => ({ name: `First ${n}`, user_email: `${n.toLowerCase()}@acme.dev` })),
  });
  const out = await runLoader({ item: baseItem, transport: t, mutateSource: withCreds });
  const len = out.vault_context_system_prompt.length;
  assert(len <= PROMPT_BUDGET,
    `prompt is ${len} chars (budget ${PROMPT_BUDGET}) — every vault document is injected whole, `
    + 'so cost per call scales with roster size and with however large a team lets its files grow');
});

it('reports that it truncated, instead of silently shrinking context', async () => {
  const repo = vaultWith(templateDigest('x'));
  repo['team/Novak.md'] = '# Novak\n' + 'x'.repeat(50000);
  const t = makeTransport({ repo });
  const out = await runLoader({ item: baseItem, transport: t });
  assert(Array.isArray(out.__vault_context_meta.truncated),
    'meta carries no truncation record, so a clipped prompt is indistinguishable from a small one');
  assert(out.__vault_context_meta.truncated.length > 0,
    'a 50 KB profile was injected whole with no truncation reported');
});

/* ================================================================== */
/* D6 — OBSERVABILITY: can an operator tell empty from broken?         */
/* ================================================================== */

console.log('\n[D6] observability — empty vs broken');

it('raises an explicit alarm when EVERY channel returned nothing', async () => {
  const t = makeTransport({ repo: {} }); // whole vault 404s — the broken case
  const out = await runLoader({ item: baseItem, transport: t });
  const m = out.__vault_context_meta;
  assert(m.context_empty === true,
    'all four channels returned zero and the node reports no alarm — this is the exact state '
    + 'a dead loader produces, and nothing downstream can distinguish it from a fresh vault');
  assert(Array.isArray(m.channels) && m.channels.length >= 4,
    'no per-channel status list, so an operator cannot see WHICH channel died');
});

it('a healthy vault does not raise the alarm', async () => {
  const t = makeTransport({ repo: vaultWith(templateDigest('CANARY-OK')) });
  const out = await runLoader({ item: baseItem, transport: t });
  assert(out.__vault_context_meta.context_empty === false,
    'false alarm on a healthy vault');
});

main();
