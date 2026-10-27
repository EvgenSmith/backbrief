// SPDX-License-Identifier: MIT
/*
 * Cabinet tests: vault parsing, sessions, and the whole sign-in → workspace
 * path through the real Pages Functions over HTTP (scripts/serve.js handler,
 * in-memory KV, mock GitHub serving site/demo-vault). No network.
 *
 * Run: node --test site/tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import * as V from '../lib/vault.js';
import { createSessionCookie, readSession } from '../lib/session.js';
import { handle, devEnv } from '../scripts/serve.js';
import { requestReset, hashPassword, verifyPassword } from '../lib/auth.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = path.join(SITE, 'demo-vault');

function loadDemo() {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(VAULT).map((f) => path.relative(VAULT, f).split(path.sep).join('/'));
  const read = (p) => fs.readFileSync(path.join(VAULT, p), 'utf8');
  const of = (k) => files.filter((f) => V.classify(f) === k);
  return {
    files,
    read,
    of,
    calls: of('call').map((p) => V.parseCall(p, read(p))),
    tasks: of('tasks').map((p) => V.parseTasks(p, read(p))),
    members: of('member').map((p) => V.parseMember(p, read(p))),
    tenant: V.parseTenant(read('tenant.yaml')),
    training: of('training').flatMap((p) => V.parseTrainingLog(read(p))),
  };
}

function demoWorkspace(d = loadDemo()) {
  return V.buildWorkspace({
    info: { id: 'demo', name: 'Acme' },
    callPaths: d.of('call'),
    calls: d.calls,
    tasks: d.tasks,
    members: d.members,
    now: '2026-10-20T00:00:00Z',
    tenant: d.tenant,
    files: d.files,
    training: d.training,
  });
}

const demoConfig = () => JSON.parse(fs.readFileSync(path.join(SITE, 'demo.config.json'), 'utf8'));

// ------------------------------------------------------------------ parsing

test('yaml.js stays a verbatim copy of the parser in validate-vault.js', () => {
  const kit = fs.readFileSync(path.join(SITE, '..', 'plugin', 'scripts', 'validate-vault.js'), 'utf8');
  const ours = fs.readFileSync(path.join(SITE, 'lib', 'yaml.js'), 'utf8');
  const start = kit.indexOf('function stripComment(line)');
  const end = kit.indexOf('/* ------------------------------------------------------------------ */\n/* Controlled vocabulary');
  assert.ok(start > 0 && end > start, 'parser region not found in validate-vault.js');
  assert.ok(ours.includes(kit.slice(start, end).trimEnd()), 'site/lib/yaml.js drifted from plugin/scripts/validate-vault.js');
});

test('demo vault parses into the workspace the demo shows', () => {
  const ws = demoWorkspace();
  assert.equal(ws.calls.length, 7);
  assert.equal(ws.stats.calls_total, 7);
  assert.equal(ws.stats.people, 5);
  assert.equal(ws.stats.proposals, 22);
  assert.equal(ws.stats.duplicates_caught, 8);
  assert.deepEqual(ws.calls.map((c) => c.date), [...ws.calls.map((c) => c.date)].sort().reverse(), 'newest first');
  // The demo team is English: no Cyrillic and no surname of the old demo team
  // anywhere in the workspace or call-detail JSON a visitor loads.
  const blob = JSON.stringify(V.workspaceJson(ws)) + ws.calls.map((c) => JSON.stringify(ws._detail(c.id))).join('\n');
  assert.ok(!/[Ѐ-ԯ]/.test(blob), 'no Cyrillic in workspace and detail JSON');
  assert.ok(!/Ivanova|Petrov|Sidorova/.test(blob), 'no surname of the old demo team');
  assert.ok(ws.calls.every((c) => c.language === 'en'), 'every call is in English');
  assert.ok(ws.calls.some((c) => c.topic === 'Onboarding funnel review'), 'the former Russian call, in English');
  for (const c of ws.calls) {
    const d = ws._detail(c.id);
    assert.ok(d.sections.length >= 5, `${c.path}: digest sections`);
    assert.ok(!d.sections.some((s) => /<!--/.test(s.md)), 'HTML comments are stripped');
    for (const r of d.references) assert.ok(ws.calls.some((x) => x.id === r.id), `${c.path}: reference ${r.path} resolves`);
  }
});

test('call ids are derivable from the file name alone', () => {
  const ws = demoWorkspace();
  for (const c of ws.calls) assert.equal(c.id, V.callId(c.path, V.dateFromName(c.path).date));
});

test('one frontmatter line outside the YAML dialect does not blank the call', () => {
  const text = [
    '---', 'type: transcript', 'topic: Example meeting', 'date: 2026-10-19', 'time: "11:59"',
    'participants: [Alpha, Beta]', 'action_items: ', '  -', '    title: Do the thing', '    assignee_hint: Alpha',
    '    priority_hint: high', '    linear_ref_hint: GEN-1',
    'references_prior_calls: [knowledge/general/transcripts/{transcript} {zoom} a w B – 2026-10-13 1056.md]',
    '---', '', '## Что обсуждали', '', '- пункт', '', '## Transcript', '', 'x',
  ].join('\n');
  const c = V.parseCall('general/transcripts/{transcript} example – 2026-10-19 1159.md', text);
  assert.equal(c.topic, 'Example meeting');
  assert.deepEqual(c.participants, ['Alpha', 'Beta']);
  assert.equal(c.action_items[0].owner, 'Alpha');
  assert.equal(c.action_items[0].priority, 'high');
  assert.equal(c.action_items[0].tracker_ref, 'GEN-1');
  assert.deepEqual(c.sections.map((s) => s.heading), ['Что обсуждали']);
});

test('tasks files yield verdicts and decisions', () => {
  const ws = demoWorkspace();
  const d = ws._detail(ws.calls.find((c) => c.topic === 'Pricing model review').id);
  assert.deepEqual(d.tasks.drafts.map((x) => x.verdict), ['CREATE', 'COMMENT', 'FLAG', 'CREATE']);
  assert.deepEqual(d.tasks.drafts.map((x) => x.decision), ['accepted', 'accepted', 'skipped', 'accepted']);
  assert.ok(!d.tasks.drafts.some((x) => /\]\(/.test(x.title)), 'markdown links are stripped from titles');
});

// ------------------------------------------------------------------ demo screens

test('the pending call: task statuses and bulk counts', () => {
  const ws = demoWorkspace();
  const e = ws.task_log.find((x) => x.topic === 'Weekly sync: launch readiness');
  assert.equal(e.call_id, ws.calls[0].id, 'the newest call is the one waiting for a decision');
  assert.deepEqual(e.proposals.map((p) => [p.n, p.verdict, p.status, p.safe, p.suggested]), [
    [1, 'CREATE', 'pending', true, 'approve'],
    [2, 'COMMENT', 'pending', true, 'approve'],
    [3, 'FLAG', 'pending', false, 'review'],
    [4, 'DUPLICATE', 'pending', false, 'skip'],
  ]);
  assert.equal(e.call_mode, 'discovery', 'a standup is not a planning call');
  assert.deepEqual(e.bulk, { approve_safe: { allowed: true, count: 2 }, skip_remaining: { count: 4 } });
  assert.deepEqual(e.counts, { extracted: 4, created: 0, commented: 0, skipped: 0 });
  const [create, comment, flag, dup] = e.proposals;
  assert.deepEqual([create.owner, create.owner_team, create.priority, create.ts], ['Brooks', 'product', 'high', '21:10']);
  assert.equal(comment.title, 'Billing: handle clinics mid-trial on the old plan', 'a COMMENT is titled by the action item at its timestamp');
  assert.deepEqual(comment.target, { ref: 'ENG-311', title: 'Estimate the billing work for the self-serve tier' });
  assert.equal(comment.evidence, 'the call adds the mid-trial case and a Thursday deadline');
  assert.deepEqual([flag.target, flag.similarity, flag.owner, flag.priority], [{ ref: 'GRW-102', title: 'Billing FAQ refresh' }, 0.65, null, 'medium']);
  assert.equal(dup.target.ref, 'ENG-318');
  for (const p of e.proposals) assert.deepEqual(p.decision, { result: null, ref: null, reason: null });
  assert.equal(ws.stats.pending, 4);
  assert.equal(ws.stats.safe_pending, 2);
  // Every other call is decided; on a planning call 09b hides "Approve all safe".
  for (const x of ws.task_log.filter((y) => y !== e)) {
    assert.equal(x.pending, 0, `${x.topic}: decided`);
    assert.equal(x.bulk.skip_remaining.count, 0);
  }
  const planning = ws.task_log.find((x) => x.topic === 'Self-serve launch plan');
  assert.equal(planning.call_mode, 'planning');
  assert.equal(planning.bulk.approve_safe.allowed, false);
  assert.equal(ws.calls[0].proposals.pending, 4);
});

test('the pricing call matches the landing page', () => {
  const d = loadDemo();
  const ws = demoWorkspace(d);
  const c = ws._detail(ws.calls.find((x) => x.topic === 'Pricing model review').id);
  assert.equal(c.path, 'product/transcripts/2026-10-07 1300 pricing model review w Carter,Brooks.md');
  assert.deepEqual([c.time, c.duration_min, c.participants], ['13:00', 47, ['Carter', 'Brooks']]);
  assert.deepEqual(c.slack, { channel: '#product-sync', posted_at: '13:48' }, 'posted a minute after the call ends');
  assert.deepEqual(c.digest.decisions, [{ title: 'Ship the $19 self-serve tier before the Q4 campaign', why: 'the creative already assumes it', ts: '16:40' }]);
  assert.deepEqual(c.digest.agreements, [{ parties: ['Carter', 'Brooks'], text: 'pricing copy freezes Friday so engineering can cut the release on Monday', ts: '22:15' }]);
  assert.deepEqual(c.task_log.proposals.map((p) => [p.verdict, p.title, p.owner, p.priority, p.status, p.decision.result, p.decision.ref]), [
    ['CREATE', 'Rewrite pricing page copy for the self-serve tier', 'Carter', 'high', 'approved', 'created', 'GRW-214'],
    ['COMMENT', 'Pricing revamp', 'Carter', 'high', 'approved', 'commented', 'GRW-180'],
    ['FLAG', 'Update the billing FAQ', null, 'medium', 'skipped', 'skipped', null],
    ['CREATE', 'Ask legal about the annual-plan wording', 'Brooks', 'low', 'approved', 'file-only', null],
  ]);
  const [create, comment, flag] = c.task_log.proposals;
  assert.deepEqual([create.ts, create.quote], ['14:32', 'we need to rewrite pricing for self-serve by Friday']);
  assert.equal(comment.evidence, 'the call adds a Friday deadline and an owner');
  assert.deepEqual([flag.similarity, flag.target.ref, flag.decision.reason], [0.6, 'GRW-102', 'already covered']);
  assert.deepEqual(c.tasks.drafts[2].refs, ['GRW-102'], 'the bracketed ref survives parsing');
  assert.deepEqual(c.recording, { available: false, provider: 'zoom', url: null });
  assert.equal(c.transcript.path, 'product/transcripts/2026-10-07 1300 pricing model review w Carter,Brooks.vtt');
  const t = V.transcriptDetail(c, d.read(c.transcript.path), d.members);
  assert.deepEqual(t.segments.filter((s) => ['16:38', '16:40'].includes(s.ts_mmss)), [
    { speaker: 'Brooks', ts_mmss: '16:38', text: "The creative already assumes $19. We can't move it." },
    { speaker: 'Carter', ts_mmss: '16:40', text: 'Agreed. We ship the $19 tier before the Q4 campaign.' },
  ]);
});

test('parseVtt: Zoom-style cues become {speaker, ts_mmss, text}; speakers resolve through aliases', () => {
  const vtt = [
    'WEBVTT', '',
    '1', '00:16:38.000 --> 00:16:40.000', 'Nathan B.: The creative already assumes $19.', '',
    'NOTE not a cue', '',
    '2', '01:02:03.500 --> 01:02:09.000', '<v Emma C.>Agreed.</v>', '',
    '3', '00:00:05.000 --> 00:00:07.000', 'a line without a speaker', 'that wraps', '',
  ].join('\n');
  assert.deepEqual(V.parseVtt(vtt), [
    { speaker: 'Nathan B.', ts_mmss: '16:38', text: 'The creative already assumes $19.' },
    { speaker: 'Emma C.', ts_mmss: '62:03', text: 'Agreed.' },
    { speaker: null, ts_mmss: '00:05', text: 'a line without a speaker that wraps' },
  ]);
  const d = loadDemo();
  const call = d.calls.find((c) => c.topic === 'Pricing model review');
  const t = V.transcriptDetail(call, d.read(V.transcriptPathFor(call)), d.members);
  assert.deepEqual(t.speakers.map((s) => [s.label, s.lastname, s.external]), [
    ['Nathan B.', 'Brooks', false], ['Smith', null, true], ['Emma C.', 'Carter', false],
  ]);
  assert.ok(t.segments.every((s) => Object.keys(s).join() === 'speaker,ts_mmss,text'));
});

test('every call has a transcript that backs its digest', () => {
  const d = loadDemo();
  const aliases = new Set(d.members.flatMap((m) => m.aliases));
  for (const c of d.calls) {
    const vtt = V.transcriptPathFor(c);
    assert.ok(vtt && d.files.includes(vtt), `${c.path}: .vtt sibling named in transcript_file`);
    const at = new Map();
    for (const s of V.parseVtt(d.read(vtt))) at.set(s.ts_mmss, [...(at.get(s.ts_mmss) || []), s]);
    for (const ts of V.digestTimestamps(c.sections)) assert.ok(at.has(ts), `${c.path}: the digest cites (${ts}) but no cue starts there`);
    for (const step of V.digest(c.sections).next_steps.filter((s) => s.quote)) {
      assert.ok((at.get(step.ts) || []).some((s) => s.text.includes(step.quote)), `${c.path}: quote "${step.quote}" is not in the cue at ${step.ts}`);
    }
    const t = d.tasks.find((x) => x.call === c.path);
    for (const dr of (t ? t.drafts : []).filter((x) => x.quote && x.ts)) {
      assert.ok((at.get(dr.ts) || []).some((s) => s.text.includes(dr.quote)), `${t.path}: quote "${dr.quote}" is not in the cue at ${dr.ts}`);
    }
    for (const s of [...at.values()].flat()) {
      assert.ok(aliases.has(s.speaker) || c.external_participants.includes(s.speaker), `${c.path}: speaker "${s.speaker}" is neither a profile alias nor a guest`);
    }
  }
});

test('vault tree: counts, folder descriptions and links', () => {
  const d = loadDemo();
  const v = V.vaultTree({
    files: d.files, calls: d.calls, tasks: d.tasks, members: d.members, tenant: d.tenant, training: d.training,
    agentsMd: d.read('AGENTS.md'),
    readmes: Object.fromEntries(d.files.filter((f) => /README\.md$/.test(f)).map((f) => [f, d.read(f)])),
  });
  assert.equal(v.repo, 'acme/vault');
  assert.deepEqual(v.counts, {
    files: d.files.filter((f) => !f.endsWith('.gitkeep')).length,
    calls: 7, raw_transcripts: 7, tasks_files: 7, proposals: 22, pending: 4, profiles: 5, templates: 7, training_rows: 18,
  });
  const all = [];
  const visit = (n) => { all.push(n); (n.children || []).forEach(visit); };
  v.tree.forEach(visit);
  const node = (p) => all.find((n) => n.path === p);
  assert.ok(!all.some((n) => n.path.endsWith('.gitkeep')), '.gitkeep is hidden');
  assert.deepEqual(v.tree.slice(0, 4).map((n) => n.path), ['product/', 'growth/', 'engineering/', 'general/'], 'team folders first, in tenant order');
  assert.deepEqual([node('product/').about, node('product/').counts, node('product/').last_call],
    ['Product management, pricing, roadmap, launches', { calls: 2, raw_transcripts: 2 }, '2026-10-14']);
  assert.equal(node('general/transcripts/').about, 'one .md per call (digest + frontmatter) + optional .vtt sibling');
  assert.deepEqual(node('tasks/').counts, { files: 7, proposals: 22, pending: 4 });
  assert.equal(node('tasks/').about, "per-call task artifacts (every draft + the user's decision + tracker links)");
  assert.deepEqual(node('team/').counts, { profiles: 5 });
  assert.deepEqual(node('.backbrief/training/').counts, { rows: 18 });
  for (const c of d.calls) assert.equal(node(c.path).call_id, c.id, `${c.path}: call node carries its id`);
  const pricing = d.calls.find((c) => c.topic === 'Pricing model review');
  const edges = v.edges.filter((e) => e.call_id === pricing.id || e.to_call_id === pricing.id).map((e) => [e.from === pricing.path ? '<call>' : e.from, e.to === pricing.path ? '<call>' : e.to, e.via]);
  for (const want of [
    ['<call>', 'tasks/2026-10-07 1300 pricing model review w Carter,Brooks.tasks.md', 'same basename + call:'],
    ['tasks/2026-10-07 1300 pricing model review w Carter,Brooks.tasks.md', 'GRW-214', 'decision: accepted → [GRW-214]'],
    ['<call>', 'GRW-214', 'action_items[0].tracker_ref'],
    ['GRW-214', '<call>', 'issue body 📎 Source → Vault'],
    ['<call>', 'team/Carter.md', 'action_items[0].owner = lastname'],
    ['product/transcripts/2026-10-14 1500 self serve launch plan w Brooks,Carter,Kim.md', '<call>', 'references_prior_calls'],
  ]) assert.ok(edges.some((e) => e.join('|') === want.join('|')), `missing edge ${want.join(' → ')}`);
});

test('AGENTS.md: the opening sentence and the "How to find things" recipes; the tenant timezone', () => {
  const d = loadDemo();
  const a = V.agentsGuide(d.read('AGENTS.md'));
  assert.equal(a.path, 'AGENTS.md');
  assert.equal(a.intro, "This is Acme's call-memory vault: every team call becomes a markdown file with structured frontmatter (context digest + decisions + next steps), maintained by Backbrief.");
  assert.deepEqual(a.recipes.map((r) => r.want), [
    'All calls of a team', 'Calls in a date range', 'Who decided X', 'Open commitments of a person',
    "A person's role/zones/aliases", 'Everything about a topic', 'What a task came from',
  ], 'the header and separator rows are dropped');
  assert.equal(a.recipes[0].do, "`rg -l 'team: product' --glob '**/transcripts/*.md'`", 'cells keep their inline markdown');
  assert.equal(a.recipes[1].do, 'filenames sort chronologically: `ls <team>/transcripts/ | sort`', 'an escaped pipe stays in its cell');
  const v = V.vaultTree({ files: d.files, calls: d.calls, tasks: d.tasks, members: d.members, tenant: d.tenant, training: d.training, agentsMd: d.read('AGENTS.md') });
  assert.deepEqual(v.agents, a, 'vault.json carries it as agents');
  assert.equal(V.agentsGuide(''), null, 'no AGENTS.md, no agents block');
  assert.deepEqual(V.agentsGuide('# Vault\n\nFirst sentence. Second one.\nStill the intro.\n\n## How to find things\n\n| You want | Do |\n|:--|--|\n| a \\| b | `c` then d |\n\n## Next\n| x | y |\n'),
    { path: 'AGENTS.md', intro: 'First sentence.', recipes: [{ want: 'a | b', do: '`c` then d' }] }, 'only the recipes table is read');
  assert.equal(V.agentsGuide('# Vault\n\nNo recipes here.\n').recipes.length, 0);

  assert.equal(demoWorkspace(d).workspace.timezone, 'Europe/London', 'from tenant.yaml tenant.timezone');
  assert.equal(V.buildWorkspace({ info: { id: 'x' }, callPaths: [], calls: [], tasks: [], members: [] }).workspace.timezone, null, 'no tenant, no timezone');
});

test('demo config: Slack delivery default, setup steps and issue bodies', () => {
  const cfg = demoConfig();
  // The landing promises proposals with Approve and Skip in the call's thread: combination 7.
  assert.deepEqual(cfg.slack.delivery, { summary: true, transcript_link: false, recording_link: true, task_log: true });
  assert.ok(cfg.slack.channels_available.every((c) => /^#[a-z0-9-]+$/.test(c)));
  assert.ok(cfg.slack.channels_available.includes('#call-digests') && cfg.slack.channels_available.includes('#product-sync'));
  assert.deepEqual(cfg.overview.setup.map((s) => s.id), ['sources', 'people', 'slack', 'first_call']);
  const ws = demoWorkspace();
  const pending = ws.task_log.find((e) => e.pending);
  assert.deepEqual(Object.keys(cfg.issue_body), [pending.tasks_path]);
  assert.deepEqual(Object.keys(cfg.issue_body[pending.tasks_path]), pending.proposals.map((p) => String(p.n)), 'one body per waiting proposal');
  for (const body of Object.values(cfg.issue_body[pending.tasks_path])) {
    assert.deepEqual(Object.keys(body), ['context', 'task', 'result', 'extra'], 'the four blocks of task-4block.md');
  }
});

test('people: activity, unprofiled names, and every evidence quote is in the call it cites', () => {
  const d = loadDemo();
  const cfg = demoConfig();
  assert.equal(cfg._demo_only, true);
  const p = V.peopleIndex({ members: d.members, calls: d.calls, suggestions: cfg.people.suggestions, teams: ['product', 'growth', 'engineering'] });
  const carter = p.people.find((x) => x.lastname === 'Carter');
  assert.deepEqual(carter.zones, ['onboarding-emails', 'paid-acquisition', 'landing-pages'], 'zones stay plain strings');
  const { partners, last_call: lastCall, ...activity } = carter.activity;
  assert.deepEqual(activity, { calls: 6, open: 5, monitoring: 1, done: 1, helps: 1, tracker_refs: ['GRW-205', 'GRW-214', 'GRW-219', 'GRW-224'] });
  assert.deepEqual([partners[0], lastCall], [{ lastname: 'Brooks', calls: 5 }, '2026-10-19']);
  assert.deepEqual(carter.zone_evidence[1], { zone: 'paid-acquisition', evidence: null, inferred: true });
  assert.deepEqual(p.unprofiled.map((u) => [u.token, u.kind, u.calls, u.mentions, u.role_hint]), [
    ['Shah', 'teammate', 2, 3, 'support'],
    ['Smith', 'external', 1, 2, 'pricing advisor'],
  ]);
  const shah = p.add_person.suggestions.Shah;
  assert.deepEqual(shah.aliases, ['Priya', 'Priya S.', '@priya']);
  assert.deepEqual(shah.team, { value: null, ask: true, options: ['product', 'growth', 'engineering'] });
  assert.deepEqual(shah.typical_partners, ['Hughes']);
  assert.deepEqual(shah.accounts, { slack: '@priya', tracker: 'Priya Shah', matched_by: 'email' }, 'accounts pass through from the caller');
  assert.equal(V.peopleIndex({ members: d.members, calls: d.calls, suggestions: { X: {} } }).add_person.suggestions.X.accounts, null);
  assert.ok(p.add_person.taken.some((t) => t.name === 'Emma C.' && t.path === 'team/Carter.md'));

  // A quote counts as evidence only if the cited call says it at the cited time:
  // in a digest line under that (MM:SS), or in the transcript cue that starts there.
  const saidAt = (callId, ts, quote) => {
    const c = d.calls.find((x) => x.id === callId);
    if (!c) return false;
    const lines = V.digestLines(c).filter((l) => l.ts === ts).map((l) => l.text);
    const cues = V.parseVtt(d.read(V.transcriptPathFor(c))).filter((s) => s.ts_mmss === ts).map((s) => s.text);
    return [...lines, ...cues].some((text) => text.includes(quote));
  };
  const evidence = [
    ...Object.values(p.add_person.suggestions).flatMap((s) => [...s.role.evidence, ...s.zones.flatMap((z) => z.evidence)]),
    ...p.people.flatMap((x) => x.zone_evidence.filter((z) => z.evidence).map((z) => z.evidence)),
  ];
  assert.ok(evidence.length >= 10);
  for (const ev of evidence) assert.ok(saidAt(ev.call_id, ev.ts, ev.quote), `"${ev.quote}" is not in call ${ev.call_id} at ${ev.ts}`);
});

test('overview: what needs a decision, digest totals, and the training log', () => {
  const d = loadDemo();
  const ws = demoWorkspace(d);
  const pending = ws.task_log.find((x) => x.pending);
  assert.deepEqual(ws.overview.needs_decision, [
    { call_id: pending.call_id, topic: 'Weekly sync: launch readiness', date: '2026-10-19', pending: 4, safe: 2, flagged: 1, duplicates: 1 },
  ]);
  assert.deepEqual(ws.overview.digest_totals, { themes: 17, decisions: 8, agreements: 7, open_questions: 4, key_insights: 7 });
  assert.deepEqual(ws.overview.by_week, [{ week_of: '2026-10-05', calls: 3 }, { week_of: '2026-10-12', calls: 3 }, { week_of: '2026-10-19', calls: 1 }]);
  assert.deepEqual(ws.overview.by_team, { general: 2, growth: 2, product: 2, engineering: 1 });
  assert.deepEqual(ws.overview.open_by_owner.slice(0, 3), [{ owner: 'Carter', open: 5 }, { owner: 'Brooks', open: 3 }, { owner: 'Hughes', open: 3 }]);
  assert.deepEqual(ws.overview.training, { rows: 18, accepted: 13, edited: 0, skipped: 5 });
  assert.deepEqual(ws.overview.repeat_flags.map((f) => [f.ref, f.skipped, f.pending]), [['GRW-102', 2, 1]]);

  // One training row per decided draft, in the state.js log-decision shape.
  const decided = ws.task_log.flatMap((e) => e.proposals.filter((p) => p.status !== 'pending')
    .map((p) => ({ call: V.callBasename(ws.calls.find((c) => c.id === e.call_id).path), p })));
  assert.equal(d.training.length, decided.length);
  for (const { call, p } of decided) {
    const rows = d.training.filter((r) => r.call_id === call && r.task_title === p.title);
    assert.equal(rows.length, 1, `${call}: one row for "${p.title}"`);
    const [row] = rows;
    assert.equal(row.verdict_proposed, p.verdict.toLowerCase());
    assert.equal(row.user_action, p.status === 'approved' ? 'accepted' : 'skipped');
    assert.equal(row.tracker_ref || null, ['created', 'commented'].includes(p.decision.result) ? p.decision.ref : null);
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }

  // Settings a vault can answer: Linear activity and the Slack channels.
  const s = V.settingsFromVault({ tenant: d.tenant, calls: d.calls, taskLog: ws.task_log });
  assert.deepEqual(s.sources.find((x) => x.id === 'linear').activity, { issues_created: 7, comments: 4, file_only: 2 });
  assert.deepEqual(s.sources.find((x) => x.id === 'linear').settings.default_assignees, { product: 'Brooks', growth: 'Carter', engineering: 'Hughes' }, 'Sources › Linear: "product → PRD (Brooks)"');
  assert.deepEqual(s.slack, { channel: '#call-digests', per_team_channels: { product: '#product-sync' } });
});

// ------------------------------------------------------------------ sessions

test('session cookie: round trip, tamper, expiry, missing secret', async () => {
  const env = { SESSION_SECRET: 'x'.repeat(40) };
  const cookie = (await createSessionCookie(env, { email: 'a@b.co', workspace: 'w1' })).split(';')[0];
  const req = (c) => new Request('https://s.test/', { headers: { cookie: c } });
  assert.deepEqual(await readSession(req(cookie), env), { email: 'a@b.co', workspace: 'w1' });
  const [name, value] = cookie.split('=');
  const tampered = `${name}=${value.slice(0, -2)}${value.endsWith('A') ? 'B' : 'A'}${value.slice(-1)}`;
  assert.equal(await readSession(req(tampered), env), null);
  assert.equal(await readSession(req(cookie), { SESSION_SECRET: 'y'.repeat(40) }), null, 'another secret');
  assert.equal(await readSession(req(cookie), env, Date.now() + 15 * 864e5), null, 'expired');
  await assert.rejects(() => createSessionCookie({ SESSION_SECRET: 'short' }, { email: 'a', workspace: 'w' }));
});

// ------------------------------------------------------------------ HTTP end to end

async function server() {
  let env;
  const srv = http.createServer((req, res) => handle(req, res, env).catch((e) => { res.writeHead(500).end(String(e)); }));
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  env = await devEnv(port);
  const base = `http://localhost:${port}`;
  const call = (p, opt = {}) => fetch(base + p, { redirect: 'manual', ...opt });
  return { srv, env, base, call };
}

const postJson = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const postForm = (body, cookie) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(body).toString(),
});

test('password hashing: round trip, wrong password, salted', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.match(stored, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('correct horse batterz', stored), false);
  assert.notEqual(await hashPassword('correct horse battery'), stored, 'a fresh salt every time');
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('log in, reset password and workspace API end to end', async (t) => {
  const { srv, env, call } = await server();
  t.after(() => srv.close());

  // Not a member: the login page can offer a demo.
  let r = await call('/api/auth/login', postJson({ email: 'stranger@example.com', password: 'whatever-123' }));
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'not_registered' });
  r = await call('/api/auth/forgot', postJson({ email: 'stranger@example.com' }));
  assert.equal(r.status, 404);

  // Without JavaScript the form gets a redirect the page turns into a message.
  r = await call('/api/auth/login', postForm({ email: 'stranger@example.com', password: 'whatever-123' }));
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /\/login#not-registered$/);

  // Signed out: the API refuses.
  assert.equal((await call('/api/workspace')).status, 401);

  // A member without a password yet is told to set one.
  r = await call('/api/auth/login', postJson({ email: 'Dev@Acme.dev', password: 'whatever-123' }));
  assert.equal(r.status, 409);

  // Forgot password: a one-time link to /reset (returned only in the local preview).
  r = await call('/api/auth/forgot', postJson({ email: 'Dev@Acme.dev' }));
  assert.equal(r.status, 200);
  const { dev_link } = await r.json();
  assert.match(dev_link, /\/reset\?token=[0-9a-f]{64}$/);
  const token = new URL(dev_link).searchParams.get('token');

  // Too short is refused and does not burn the token.
  r = await call('/api/auth/password', postJson({ token, password: 'short' }));
  assert.equal(r.status, 400);

  // Setting the password signs the member in.
  r = await call('/api/auth/password', postJson({ token, password: 'a-long-enough-password' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, redirect: '/app' });
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);

  // The same link never works twice.
  r = await call('/api/auth/password', postJson({ token, password: 'another-long-password' }));
  assert.equal(r.status, 410);

  // Email and password from now on.
  r = await call('/api/auth/login', postJson({ email: 'dev@acme.dev', password: 'not-the-password' }));
  assert.equal(r.status, 401);
  r = await call('/api/auth/login', postJson({ email: 'DEV@acme.dev', password: 'a-long-enough-password' }));
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const auth = { headers: { cookie } };

  // Workspace data, read from the (mock) GitHub vault by the live code path.
  r = await call('/api/me', auth);
  assert.deepEqual(await r.json(), { email: 'dev@acme.dev', workspace: { id: 'acme-dev', name: 'Acme (local preview)' } });
  r = await call('/api/workspace', auth);
  const ws = await r.json();
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(ws.calls.length, 7);
  assert.equal(ws.stats.people, 5);
  assert.equal(ws.workspace.mode, 'live');
  r = await call(`/api/call?id=${ws.calls[0].id}`, auth);
  const detail = await r.json();
  assert.ok(detail.sections.length >= 5);
  assert.match(detail.vault_file_url, /^https:\/\/github\.com\/acme\/vault\/blob\/main\//);
  assert.equal((await call('/api/call?id=2026-01-01-00000000', auth)).status, 404);
  assert.equal((await call('/api/call?id=../../etc', auth)).status, 400);
  r = await call('/api/people', auth);
  assert.equal((await r.json()).people.length, 5);

  // Removed from the workspace: the session stops working at once, and so does the password.
  const cfg = await env.CABINET.get('workspace:acme-dev', { type: 'json' });
  await env.CABINET.put('workspace:acme-dev', JSON.stringify({ ...cfg, members: [] }));
  assert.equal((await call('/api/workspace', auth)).status, 403);
  await env.CABINET.put('workspace:acme-dev', JSON.stringify(cfg));

  // Log out clears the cookie.
  r = await call('/api/auth/logout', { method: 'POST', headers: { cookie } });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /\/login#signed-out$/);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('Google sign-in: unavailable without credentials, refuses a forged state', async (t) => {
  const { srv, call } = await server();
  t.after(() => srv.close());
  let r = await call('/api/auth/google');
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /\/login#google-unavailable$/);
  r = await call('/api/auth/google-callback?code=x&state=y');
  assert.match(r.headers.get('location'), /\/login#google-unavailable$/);
});

test('Google sign-in: redirects to Google with a state cookie, and checks it on the way back', async () => {
  const { onRequestGet: start } = await import('../functions/api/auth/google.js');
  const { onRequestGet: back } = await import('../functions/api/auth/google-callback.js');
  const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' };
  const r = await start({ request: new Request('https://backbrief.test/api/auth/google'), env });
  const to = new URL(r.headers.get('location'));
  assert.equal(to.origin, 'https://accounts.google.com');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://backbrief.test/api/auth/google-callback');
  const state = to.searchParams.get('state');
  assert.match(r.headers.get('set-cookie'), new RegExp(`bb_oauth=${state};.*HttpOnly`));
  const forged = await back({ request: new Request(`https://backbrief.test/api/auth/google-callback?code=c&state=other`, { headers: { cookie: `bb_oauth=${state}` } }), env });
  assert.match(forged.headers.get('location'), /\/login#google-failed$/);
});

test('the dev set-password shortcut never works off localhost', async () => {
  const env = await devEnv(0);
  const prod = await requestReset(env, { email: 'dev@acme.dev', origin: 'https://backbrief.example' });
  assert.equal(prod.status, 'sent');
  assert.equal(prod.link, undefined);
  const local = await requestReset(env, { email: 'dev@acme.dev', origin: 'http://localhost:8788' });
  assert.match(local.link, /^http:\/\/localhost:8788\/reset\?token=/);
});

test('password resets and log-in attempts are rate limited per email', async (t) => {
  const { srv, call } = await server();
  t.after(() => srv.close());
  const resets = [];
  for (let i = 0; i < 6; i++) resets.push((await call('/api/auth/forgot', postJson({ email: 'dev@acme.dev' }))).status);
  assert.deepEqual(resets, [200, 200, 200, 200, 200, 429]);
  const logins = [];
  for (let i = 0; i < 11; i++) logins.push((await call('/api/auth/login', postJson({ email: 'dev@acme.dev', password: 'whatever-123' }))).status);
  assert.deepEqual(logins.slice(-2), [409, 429]);
  assert.equal((await call('/api/auth/forgot', postJson({ email: 'not-an-email' }))).status, 400);
});

test('book-a-demo form posts through the same-origin function', async (t) => {
  const { srv, base, call } = await server();
  t.after(() => srv.close());
  let r = await call('/api/book', postJson({ email: 'a@b.co' }));
  assert.equal(r.status, 201);
  r = await call('/api/book', postForm({ email: 'a@b.co', name: 'Ann' }));
  assert.equal(r.status, 303);
  assert.equal(new URL(r.headers.get('location')).pathname + new URL(r.headers.get('location')).hash, '/#booked');
  // Without JavaScript the form returns to the page it was sent from, but only to a known same-origin page.
  const from = (referer) => ({ ...postForm({ email: 'a@b.co' }), headers: { ...postForm({}).headers, referer } });
  r = await call('/api/book', from(`${base}/book`));
  assert.match(r.headers.get('location'), /\/book#booked$/);
  r = await call('/api/book', from('https://elsewhere.example/book'));
  assert.match(r.headers.get('location'), /:\d+\/#booked$/);
  r = await call('/api/book', { ...from(`${base}/book`), body: new URLSearchParams({ email: 'nope' }).toString() });
  assert.match(r.headers.get('location'), /\/book#book-form$/);
});
