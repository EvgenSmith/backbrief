#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
/*
 * e2e.test.js — offline end-to-end pipeline harness (T1).
 * Ported from the production `_e2e.test.js`, render-first: every Code-node
 * body is rendered from the tenant fixture (tenant-render.js) before eval,
 * then the FULL main-workflow Code-node graph runs per webhook fixture with
 * only the external HTTP boundaries mocked (Anthropic / GitHub / Slack /
 * .vtt download). The whole matrix runs for BOTH tenant fixtures
 * (acme-en, vostok-ru) — config-independence is the point.
 *
 * Inline nodes ("Attach .vtt to item", "Merge GitHub response", "Mark *")
 * are loaded straight from the T9 skeleton pipeline/workflows/main.json —
 * the harness runs the ACTUAL shipped jsCode, so inline nodes cannot drift
 * (same property the prod harness had against workflows/live/main.json).
 * File-backed nodes in the skeleton are placeholders (deploy renders them);
 * the harness guards against accidentally eval'ing a placeholder.
 *
 * NOT covered offline (live-only — validated by
 * `deploy-pipeline.js --selftest` at B6 / T3 instead):
 *   - workflow JSON wiring (IF/Switch branches, onError routing, Merge)
 *   - this.helpers.httpRequest behavior + Code-node sandbox limits
 *   - webhook registration, Zoom URL-validation handshake against a live URL
 *   - Slack interactivity round-trip (button click → webhook)
 *   - staticData persistence across separate executions (+ parallel race)
 *   - errorWorkflow global trap invocation
 *
 * Run: node pipeline/tests/e2e.test.js       (exit 0 green / 1 failures)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const KIT = path.join(__dirname, '..', '..');
const CODE_DIR = path.join(KIT, 'pipeline', 'code');
const LANG_DIR = path.join(KIT, 'pipeline', 'lang');
const TENANT_FIXTURE_DIR = path.join(KIT, 'pipeline', 'fixtures', 'tenants');
const WEBHOOK_FIXTURE_DIR = path.join(KIT, 'pipeline', 'fixtures', 'webhooks');
const R = require(path.join(KIT, 'pipeline', 'tenant-render.js'));

/* ------------------------------------------------------------------ */
/* Tenants (render-first)                                              */
/* ------------------------------------------------------------------ */

function stateFixtureFor(doc) {
  const userIds = {};
  (doc.roster || []).forEach((p, i) => { userIds[p.lastname] = `U00000FAKE${i}`; });
  return {
    slack: { user_ids: userIds, channels: { digest: 'C00000DIG01' } },
    tracker: { url_base: 'https://linear.app/fixture-workspace' },
  };
}

function loadTenant(name) {
  const doc = R.loadTenant(path.join(TENANT_FIXTURE_DIR, `${name}.yaml`));
  const packs = R.loadLangPacks(doc, LANG_DIR);
  const state = stateFixtureFor(doc);
  return {
    name,
    doc,
    state,
    owner: (doc.roster || []).find((p) => p.is_owner) || doc.roster[0],
    roster: doc.roster || [],
    ctx: R.buildContext(doc, packs, state, { kitRoot: KIT }), // deployed context
  };
}

const TENANTS = [loadTenant('acme-en'), loadTenant('vostok-ru')];
const ACME = TENANTS[0];
const VOSTOK = TENANTS[1];

const _renderCache = new Map();
function renderedSource(relFile, tenant) {
  const key = `${tenant.name}|${relFile}`;
  if (!_renderCache.has(key)) {
    const src = fs.readFileSync(path.join(CODE_DIR, relFile), 'utf8');
    _renderCache.set(key, R.renderSource(src, tenant.ctx).source);
  }
  return _renderCache.get(key);
}

// Load a Code-node body straight from the shipped workflow skeleton (T9) —
// the few INLINE nodes (attach/merge/mark) live only there, and running the
// actual jsCode keeps them drift-proof. File-backed skeleton nodes are
// placeholders that throw; the guard below keeps the harness honest.
let _mainWf = null;
function loadSkeletonNodeCode(nodeName) {
  if (!_mainWf) {
    _mainWf = JSON.parse(fs.readFileSync(path.join(KIT, 'pipeline', 'workflows', 'main.json'), 'utf8'));
  }
  const n = _mainWf.nodes.find((x) => x.name === nodeName);
  if (!n || !n.parameters || n.parameters.jsCode == null) {
    throw new Error(`main.json skeleton node not found / no jsCode: ${nodeName}`);
  }
  if (n.parameters.jsCode.includes('BACKBRIEF_SKELETON_PLACEHOLDER')) {
    throw new Error(`skeleton node "${nodeName}" is a placeholder — use the rendered file, not the skeleton`);
  }
  return n.parameters.jsCode;
}

// The rename-ready owner-DM flag: prod named it after the owner; the kit
// keeps the field until the owner-neutral rename lands. Tests read it via
// shape so they survive the rename (and stay off the sanitize denylist).
function dmOwnerFlag(json) {
  const k = Object.keys(json).find((key) => /^__dm_\w+_required$/.test(key));
  return k ? json[k] : undefined;
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
function it(desc, fn) {
  try { fn(); console.log(`  ✓ ${desc}`); pass++; }
  catch (e) { console.log(`  ✗ ${desc}\n      ${e.message}`); fail++; }
}

function displayName(p) { return `${p.first_name} ${p.lastname}`; }

function fixtureEvent(file) {
  return JSON.parse(fs.readFileSync(path.join(WEBHOOK_FIXTURE_DIR, file), 'utf8'));
}

// Re-map the synthetic payload onto the active tenant's roster (external
// "Name <email@ext>" entries kept verbatim) — one fixture, N tenants.
function adaptEventToTenant(ev, tenant) {
  const clone = JSON.parse(JSON.stringify(ev));
  const obj = clone.payload.object;
  obj.host_email = tenant.owner.email;
  if (Array.isArray(obj.participant_user_names)) {
    obj.participant_user_names = obj.participant_user_names.map((orig, i) =>
      /[@<]/.test(orig) ? orig : displayName(tenant.roster[i % tenant.roster.length]));
  }
  return clone;
}

// makeRunner: evaluates rendered Code-node bodies in graph order; outputs are
// stored under the node's logical n8n name so later nodes can $('Node').
const _staticData = { global: {} };
function makeRunner(tenant, prev) {
  return function run(relFile, n8nName, $input) {
    const code = renderedSource(relFile, tenant);
    return evalNode(code, prev, n8nName, $input);
  };
}
function evalNode(code, prev, n8nName, $input) {
  const $ = (name) => {
    const arr = prev[name];
    if (!arr) throw new Error(`harness $('${name}'): node not yet run`);
    return { first: () => arr[0], all: () => arr };
  };
  const $getWorkflowStaticData = () => _staticData.global;
  const $execution = { id: 'exec-e2e-1' };
  const $workflow = { id: 'wf-e2e-1' };
  const wrapped = `(function($input, $, $getWorkflowStaticData, $execution, $workflow){${code}\n})($input, $, $getWorkflowStaticData, $execution, $workflow)`;
  const out = eval(wrapped);
  prev[n8nName] = out;
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP boundary mocks                                                 */
/* ------------------------------------------------------------------ */

// Schema-valid Anthropic response derived from the metadata + tenant
// taxonomy (narrative language follows tenant.primary_language, code tokens
// stay English — the language-clause contract the mock mirrors).
function mockAnthropicResponse(tenant, meta) {
  const teamTag = tenant.doc.vault.teams[0].tag;
  const ru = (tenant.doc.tenant.primary_language === 'ru');
  const assignee = tenant.roster[1].lastname;
  return {
    body: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          team_tag: teamTag,
          sub_tag: null,
          tags: ['team-weekly', 'roadmap'],
          topic_slug: String(meta.topic || 'untitled call').toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '').trim().split(/\s+/).slice(0, 4).join('-') || 'untitled-call',
          confidence: 'high',
          // Prompt-shaped structured summary (opens at "### <Topic>", no top heading)
          // so the cross-contract validator run below exercises the real emitter shape
          // — the shape that surfaced the composer dead-heading defect (prod 2026-07-23).
          slack_summary: ru
            ? '### Итоги встречи (12:34)\n- Приняты решения\n- Задачи распределены'
            : '### Meeting outcomes (12:34)\n- Decisions made\n- Action items distributed',
          action_items: [
            { title: 'Ship feature X', assignee_hint: assignee, priority_hint: 'high', transcript_quote: 'We need X by Monday.' },
          ],
        }),
      }],
    },
    statusCode: 200,
  };
}

function mockSlackRootResponse() {
  return { ok: true, channel: 'C00000DIG01', ts: '1770000000.123456', message: { ts: '1770000000.123456' } };
}

function runInline(nodeName, prev, $input) {
  return evalNode(loadSkeletonNodeCode(nodeName), prev, nodeName, $input);
}

/* ------------------------------------------------------------------ */
/* Pipeline runner for one fixture × one tenant                        */
/* ------------------------------------------------------------------ */

function runPipeline(fixtureFile, tenant, opts) {
  opts = opts || {};
  const ev = adaptEventToTenant(fixtureEvent(fixtureFile), tenant);
  const prev = {};
  const run = makeRunner(tenant, prev);

  // verify-zoom-webhook needs the injected secret + signed headers — its HMAC
  // path is smoke-tested; e2e starts from the post-verify item (as prod did).
  prev['Verify Zoom signature'] = [{ json: ev }];

  // Extract metadata — always 0 or 1 items with has_transcript flag.
  const meta = run('transcripts/extract-metadata.js', 'Extract metadata',
    { first: () => prev['Verify Zoom signature'][0], all: () => prev['Verify Zoom signature'] });
  if (meta.length === 0) return { skipped: true };
  if (!meta[0].json.has_transcript) {
    // Phase 1 branch: minimal root post + state save (wiring itself is T3/live).
    return { phase1_only: true, has_transcript: false, topic: meta[0].json.topic, uuid: meta[0].json.zoom_meeting_uuid };
  }

  // Recording state lookup — no prior state ⇒ run_full_oneshot passthrough
  // (the "Attach .vtt to item" inline node reads its item as the meta base).
  const looked = run('transcripts/recording-state-lookup.js', 'Recording state lookup',
    { first: () => meta[0], all: () => meta });
  if (looked[0].json.__pipeline_mode !== 'run_full_oneshot') {
    throw new Error(`expected run_full_oneshot, got ${looked[0].json.__pipeline_mode}`);
  }

  // .vtt download — MOCK. Transcript embeds the tenant's first glossary
  // variant so the glossary rewrite is provable per tenant.
  const g = tenant.doc.glossary[0];
  const fakeVtt = `WEBVTT\n\n1\n00:00:01 --> 00:00:03\n${tenant.roster[1].first_name}: Hello team, the ${g.variants[0]} deployment is live.\n`;
  prev['Download .vtt'] = [{ json: { statusCode: 200, body: opts.vttOverride != null ? opts.vttOverride : fakeVtt } }];

  // Attach .vtt to item — INLINE node, actual skeleton jsCode.
  runInline('Attach .vtt to item', prev,
    { first: () => prev['Download .vtt'][0], all: () => prev['Download .vtt'] });

  // NFR-2: the short-lived Zoom download token must not travel further.
  if (prev['Attach .vtt to item'][0].json.transcript_access_token) {
    throw new Error('NFR-2 violation: transcript_access_token leaked past Attach .vtt to item');
  }

  // Glossary
  const glossed = run('transcripts/apply-glossary.js', 'Apply glossary', { all: () => prev['Attach .vtt to item'] });
  if (opts.vttOverride == null && !glossed[0].json.vtt_content.includes(g.canonical)) {
    throw new Error(`glossary did not rewrite "${g.variants[0]}" → "${g.canonical}"`);
  }

  // STUB-C vault context — live GitHub/Linear fetches; skip execution and
  // inject the offline-fallback shape (all fetches null ⇒ empty prompt).
  prev['STUB-C vault context'] = [{ json: { ...glossed[0].json, vault_context_system_prompt: '', __stub_c_vault_context: 'loaded' } }];

  // Build Anthropic body
  const built = run('transcripts/build-anthropic-body.js', 'Build Anthropic body', { all: () => prev['STUB-C vault context'] });

  // Anthropic call — MOCK
  const anthropicResp = mockAnthropicResponse(tenant, meta[0].json);
  prev['Anthropic classify+summary+actions'] = [{ json: { ...built[0].json, ...anthropicResp } }];

  // Parse Anthropic response
  const parsed = run('transcripts/parse-anthropic-response.js', 'Parse Anthropic response', { all: () => prev['Anthropic classify+summary+actions'] });

  // Build commit payload — kit naming spec v1 invariants.
  const payload = run('transcripts/build-commit-payload-v2.js', 'Build commit payload', { all: () => parsed });
  const fname = payload[0].json.filename;
  if (fname.length > 100) throw new Error(`filename > 100 chars: ${fname}`);
  if (!/^\d{4}-\d{2}-\d{2} \d{4} /.test(fname)) throw new Error(`filename not date-first: ${fname}`);
  if (/[–{}]/.test(fname)) throw new Error(`filename carries en-dash/brace tokens: ${fname}`);
  if (/[^\x20-\x7E]/.test(fname)) throw new Error(`filename not ASCII: ${fname}`);
  const wMatch = fname.match(/ w ([^.]+)\.md$/);
  if (wMatch && /\s/.test(wMatch[1].trim())) throw new Error(`participants segment contains whitespace: "${wMatch[1]}"`);

  // Slack root post (channel routing) — then MOCK the Slack API response.
  const rootBlocks = run('transcripts/build-slack-root-minimal.js', 'Build Slack root minimal', { all: () => payload });
  if (!Array.isArray(rootBlocks[0].json.blocks) || !rootBlocks[0].json.blocks[0].text.text.includes('Title: [')) {
    throw new Error('root block missing Title line');
  }
  prev['Slack root post'] = [{ json: mockSlackRootResponse() }];

  // Capture root ts
  const captured = run('transcripts/capture-root-ts.js', 'Capture root ts',
    { first: () => prev['Slack root post'][0], all: () => prev['Slack root post'] });
  if (!captured[0].json.slack_root_ts) throw new Error('capture-root-ts did not produce slack_root_ts');

  // Atomic Git-Data commit chain: builders are extracted files (T7); the HTTP
  // responses are mocked happy-path unless the test overrides the outcome.
  const ghBody = run('transcripts/build-github-body.js', 'Build GitHub body', { all: () => captured });
  if (ghBody.length !== 1) throw new Error('build-github-body must emit exactly ONE item (atomic commit)');
  if (!ghBody[0].json.github_commit_message.startsWith('sync: file transcript ')) throw new Error('commit msg malformed');

  prev['GH get base'] = [{ json: { statusCode: 200, body: { sha: 'parentsha123', commit: { tree: { sha: 'basetreesha456' } } } } }];
  run('transcripts/build-tree-body.js', 'Build tree body', { first: () => prev['GH get base'][0], all: () => prev['GH get base'] });
  prev['GH create tree'] = [{ json: { statusCode: 201, body: { sha: 'newtreesha789' } } }];
  run('transcripts/build-commit-body.js', 'Build commit body', { first: () => prev['GH create tree'][0], all: () => prev['GH create tree'] });
  prev['GH create commit'] = [{ json: { statusCode: 201, body: { sha: 'newcommitshaABC' } } }];
  run('transcripts/build-ref-body.js', 'Build ref body', { first: () => prev['GH create commit'][0], all: () => prev['GH create commit'] });

  const ghFinal = opts.githubFinal || { statusCode: 200, body: { ref: 'refs/heads/main', object: { sha: 'newcommitshaABC' } } };
  prev['GH update ref'] = [{ json: ghFinal }];
  runInline('Merge GitHub response', prev, // actual skeleton jsCode
    { first: () => prev['GH update ref'][0], all: () => prev['GH update ref'] });

  if (prev['Build tree body'][0].json.github_tree_body.base_tree !== 'basetreesha456') {
    throw new Error('Build tree body lost base_tree (repo-wipe guard)');
  }

  // Branch selection is an IF/Switch in the workflow graph (live-only
  // #1); the harness picks the branch and runs the ACTUAL Mark-node jsCode.
  const status = prev['Merge GitHub response'][0].json.github_statusCode;
  const branch = (status >= 200 && status < 300) ? 'created' : status === 422 ? 'duplicate' : 'error';
  runInline('Mark ' + branch, prev,
    { first: () => prev['Merge GitHub response'][0], all: () => prev['Merge GitHub response'] });

  // Thread reply
  const thread = run('transcripts/build-slack-thread-reply.js', 'Build thread reply', { all: () => prev['Mark ' + branch] });
  if (thread.length < 1) throw new Error('thread reply emitted 0 items');
  for (const t of thread) {
    if (!t.json.thread_ts && !t.json.__skip_thread_post) throw new Error('thread_ts not propagated');
  }

  return {
    lastnames: meta[0].json.participants_lastnames,
    filename: fname,
    vault_path: payload[0].json.vault_path,
    markdown_body: payload[0].json.markdown_body,
    root_channel: rootBlocks[0].json.channel,
    branch,
    thread_msg_count: thread.length,
    thread_last_text: thread[thread.length - 1].json.text,
    thread_first: thread[0].json,
    summary: parsed[0].json.summary,
    action_items: parsed[0].json.action_items.length,
    anthropic_system: built[0].json.anthropic_body.system,
    anthropic_model: built[0].json.anthropic_body.model,
  };
}

/* =================================================================== */
/* FIXTURE 1: public team weekly — happy path (both tenants)           */
/* =================================================================== */
console.log('\n[fixture: public team weekly — full graph, 200 created]');
for (const t of TENANTS) {
  it(`[${t.name}] full pipeline: team folder commit + 3-part thread`, () => {
    const r = runPipeline('zoom-webhook-public-team-weekly.json', t);
    if (r.skipped || r.phase1_only) throw new Error('should run the full graph');
    const teamFolder = t.doc.vault.teams[0].folder;
    if (!r.vault_path.startsWith(`${teamFolder}/transcripts/`)) throw new Error(`vault_path: ${r.vault_path}`);
    if (r.root_channel !== 'C00000DIG01') throw new Error(`root channel: ${r.root_channel}`);
    if (r.branch !== 'created') throw new Error(`branch: ${r.branch}`);
    if (!r.thread_last_text.includes(':file_folder:')) throw new Error(`vault link missing: ${r.thread_last_text}`);
    if (r.action_items < 1) throw new Error('expected ≥1 action item from mock');
    if (r.anthropic_model !== t.doc.llm.summarizer.model) throw new Error(`model: ${r.anthropic_model}`);
    console.log(`      → ${r.filename}`);
    console.log(`      → vault: ${r.vault_path}`);
  });
}

/* =================================================================== */
/* CROSS-CONTRACT (F4-M1): the committed .md must pass validate-vault  */
/* The emitter (build-commit-payload-v2.js) and the validator share    */
/* one contract; this runs the REAL validator (execFileSync) against a */
/* minimal temp vault holding the fixture run's committed output.      */
/* =================================================================== */
console.log('\n[cross-contract: committed .md passes validate-vault (F4-M1)]');
const VALIDATOR = path.join(KIT, 'plugin', 'scripts', 'validate-vault.js');
for (const t of TENANTS) {
  it(`[${t.name}] pipeline .md output validates with 0 errors + language lands`, () => {
    const r = runPipeline('zoom-webhook-public-team-weekly.json', t);
    if (r.skipped || r.phase1_only) throw new Error('should run the full graph');
    // language must land in frontmatter — the mock's narrative follows
    // tenant.primary_language (ru for vostok, en for acme).
    const expectLang = t.doc.tenant.primary_language;
    if (!r.markdown_body.includes(`\nlanguage: ${expectLang}\n`)) {
      throw new Error(`frontmatter "language: ${expectLang}" missing:\n` +
        r.markdown_body.slice(0, r.markdown_body.indexOf('---', 4)));
    }
    // Minimal vault skeleton the validator needs: tenant.yaml (teams/roster
    // context) + the committed .md at its routed path.
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), `backbrief-e2e-${t.name}-`));
    try {
      fs.copyFileSync(path.join(TENANT_FIXTURE_DIR, `${t.name}.yaml`),
        path.join(vaultDir, 'tenant.yaml'));
      const mdAbs = path.join(vaultDir, r.vault_path);
      fs.mkdirSync(path.dirname(mdAbs), { recursive: true });
      fs.writeFileSync(mdAbs, r.markdown_body);
      try {
        execFileSync(process.execPath, [VALIDATOR, '--vault', vaultDir], { encoding: 'utf8' });
      } catch (e) { // nonzero exit = errors (warnings alone exit 0)
        throw new Error('validate-vault rejected the pipeline output:\n      ' +
          String(e.stdout || e.message).trim().split('\n').join('\n      '));
      }
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
}

/* =================================================================== */
/* FIXTURE 2 (synthetic): 1:1/board-titled calls — plain team routing  */
/* Privacy routing was removed from v0.1: a "1:1 weekly sync" or a     */
/* "Board meeting Q2" title must get ZERO special-casing — same digest */
/* channel, same team-folder commit as any other call.                 */
/* =================================================================== */
console.log('\n[synthetic: 1:1/board titles get no special routing (privacy routing removed)]');
for (const topic of ['1:1 weekly sync', 'Board meeting Q2']) {
  for (const t of TENANTS) {
    it(`[${t.name}] "${topic}" → digest channel + team folder (no privacy special-case)`, () => {
      const ev = fixtureEvent('zoom-webhook-public-team-weekly.json');
      ev.payload.object.topic = topic;
      const tmp = path.join(WEBHOOK_FIXTURE_DIR, '.tmp-titled.json');
      fs.writeFileSync(tmp, JSON.stringify(ev));
      try {
        const r = runPipeline('.tmp-titled.json', t);
        if (r.skipped || r.phase1_only) throw new Error('should run the full graph');
        if (r.vault_path.includes('private')) throw new Error(`must not route privately: ${r.vault_path}`);
        const teamFolder = t.doc.vault.teams[0].folder;
        if (!r.vault_path.startsWith(`${teamFolder}/transcripts/`)) throw new Error(`vault_path: ${r.vault_path}`);
        if (r.root_channel !== 'C00000DIG01') throw new Error(`root must go to the digest channel, got ${r.root_channel}`);
      } finally { fs.unlinkSync(tmp); }
    });
  }
}

/* =================================================================== */
/* FIXTURE 3 (synthetic): external "Name <email>" participant          */
/* strips to a bare lastname (extract-metadata resolution)             */
/* =================================================================== */
console.log('\n[synthetic: bracketed external display name strips to lastname]');
it('[acme-en] "Dana Frost <dana@ext.example>" resolves to "Frost"', () => {
  const ev = fixtureEvent('zoom-webhook-public-team-weekly.json');
  ev.payload.object.participant_user_names = [
    'Elena Novak', 'Wei Chen', 'Dana Frost <dana@ext.example>',
  ];
  const tmp = path.join(WEBHOOK_FIXTURE_DIR, '.tmp-external.json');
  fs.writeFileSync(tmp, JSON.stringify(ev));
  try {
    const r = runPipeline('.tmp-external.json', ACME);
    if (!r.lastnames.includes('Frost')) throw new Error(`bracketed display name must strip to lastname: ${r.lastnames.join(',')}`);
    // No privacy routing: the external guest changes nothing about the route.
    const teamFolder = ACME.doc.vault.teams[0].folder;
    if (!r.vault_path.startsWith(`${teamFolder}/transcripts/`)) throw new Error(`vault_path: ${r.vault_path}`);
  } finally { fs.unlinkSync(tmp); }
});

/* =================================================================== */
/* FIXTURE 4: missing transcript — Phase 1 branch                      */
/* =================================================================== */
console.log('\n[fixture: missing transcript — Phase 1 branch]');
for (const t of TENANTS) {
  it(`[${t.name}] no TRANSCRIPT → 1 item, has_transcript=false, downstream Phase-1 only`, () => {
    const r = runPipeline('zoom-webhook-missing-transcript.json', t);
    if (!r.phase1_only) throw new Error('expected phase1_only path');
    if (!r.uuid) throw new Error('uuid missing from metadata');
  });
}

/* =================================================================== */
/* FIXTURE 7 (synthetic): GitHub 422 duplicate / 500 error branches    */
/* =================================================================== */
console.log('\n[synthetic: GitHub 422 duplicate + 500 error branches]');
it('[acme-en] 422 → duplicate branch: single info thread message, no owner DM', () => {
  const r = runPipeline('zoom-webhook-public-team-weekly.json', ACME,
    { githubFinal: { statusCode: 422, body: { message: 'Update is not a fast forward' } } });
  if (r.branch !== 'duplicate') throw new Error(`branch: ${r.branch}`);
  if (r.thread_msg_count !== 1) throw new Error(`duplicate must emit 1 thread item, got ${r.thread_msg_count}`);
  if (!r.thread_first.text.includes(':information_source:')) throw new Error(`thread: ${r.thread_first.text}`);
  if (dmOwnerFlag(r.thread_first)) throw new Error('duplicate must not require owner DM');
});
it('[acme-en] 500 → error branch: :x: thread message + owner DM required', () => {
  const r = runPipeline('zoom-webhook-public-team-weekly.json', ACME,
    { githubFinal: { statusCode: 500, body: { message: 'Internal Server Error' } } });
  if (r.branch !== 'error') throw new Error(`branch: ${r.branch}`);
  if (!r.thread_first.text.includes(':x:')) throw new Error(`thread: ${r.thread_first.text}`);
  if (!dmOwnerFlag(r.thread_first)) throw new Error('error must require owner DM');
});

/* =================================================================== */
/* FIXTURE 8: mixed-language transcript (EN transcript, RU tenant)     */
/* — asserts the language-mirroring contract on the LLM call INPUTS    */
/*   (language-clause contract; T1 spec addition)                      */
/* =================================================================== */
console.log('\n[mixed-language: EN transcript into the RU tenant]');
it('[vostok-ru] system prompt carries the mirroring clause + tenant team enum; EN transcript flows through', () => {
  const enVtt = 'WEBVTT\n\n1\n00:00:01 --> 00:00:03\nAnna: The quarterly launch plan is ready for review.\n';
  const r = runPipeline('zoom-webhook-public-team-weekly.json', VOSTOK, { vttOverride: enVtt });
  const sys = r.anthropic_system;
  if (!sys.includes('Write all narrative fields in Russian')) throw new Error('mirroring clause missing (primary=ru)');
  if (!sys.includes('mirror the transcript')) throw new Error('mirror-the-transcript branch missing');
  for (const team of VOSTOK.doc.vault.teams) {
    if (!sys.includes(team.tag)) throw new Error(`team enum missing "${team.tag}"`);
  }
  // Code-token invariant: filenames stay ASCII even for the RU tenant.
  if (/[^\x20-\x7E]/.test(r.filename)) throw new Error(`non-ASCII filename: ${r.filename}`);
});

/* ------------------------------------------------------------------- */
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
