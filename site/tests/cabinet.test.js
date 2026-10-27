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
import { demoData } from '../scripts/build.js';
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

function demoWorkspace(d = loadDemo(), now = '2026-10-19T11:05:00+01:00') {
  return V.buildWorkspace({
    info: { id: 'demo', name: 'Acme' },
    callPaths: d.of('call'),
    calls: d.calls,
    tasks: d.tasks,
    members: d.members,
    now,
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
  assert.equal(ws.stats.proposals, 25);
  assert.equal(ws.stats.duplicates_caught, 11, 'kept for older screens: every COMMENT and DUPLICATE verdict');
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
    [5, 'DUPLICATE', 'skipped', false, 'skip'],
  ], 'four wait; the pricing-page duplicate was skipped as already done before the demo starts');
  assert.equal(e.call_mode, 'discovery', 'a standup is not a planning call');
  assert.deepEqual(e.bulk, { approve_safe: { allowed: true, count: 2 }, skip_remaining: { count: 4 } });
  assert.deepEqual(e.counts, { extracted: 5, created: 0, commented: 0, skipped: 1 });
  const [create, comment, flag, dup] = e.proposals;
  assert.deepEqual([create.owner, create.owner_team, create.priority, create.ts], ['Brooks', 'product', 'high', '21:10']);
  assert.equal(comment.title, 'Billing: handle clinics mid-trial on the old plan', 'a COMMENT is titled by the action item at its timestamp');
  assert.deepEqual(comment.target, { ref: 'ENG-311', title: 'Estimate the billing work for the self-serve tier' });
  assert.equal(comment.evidence, 'the call adds the mid-trial case and a Thursday deadline');
  assert.deepEqual([flag.target, flag.similarity, flag.owner, flag.priority], [{ ref: 'GRW-102', title: 'Billing FAQ refresh' }, 0.65, null, 'medium']);
  assert.equal(dup.target.ref, 'ENG-318');
  for (const p of e.proposals.filter((x) => x.status === 'pending')) {
    assert.deepEqual(p.decision, { result: null, ref: null, reason: null, reason_kind: null });
    assert.deepEqual([p.agreement, p.prevents_duplicate, p.decided_at, p.edited], [null, false, null, false]);
  }
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
    calls: 7, raw_transcripts: 7, tasks_files: 7, proposals: 25, pending: 4, profiles: 5, templates: 7, training_rows: 21,
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
  assert.deepEqual(node('tasks/').counts, { files: 7, proposals: 25, pending: 4 });
  assert.equal(node('tasks/').about, "per-call task artifacts (every draft + the user's decision + tracker links)");
  assert.deepEqual(node('team/').counts, { profiles: 5 });
  assert.deepEqual(node('.backbrief/training/').counts, { rows: 21 });
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
  // A later call that reports an issue done links to it; the issue's body still links only to the call that filed it.
  const c19 = d.calls.find((c) => c.date === '2026-10-19');
  const c12 = d.calls.find((c) => c.date === '2026-10-12');
  assert.ok(v.edges.some((e) => e.from === c19.path && e.to === 'ENG-318' && /tracker_ref$/.test(e.via)));
  assert.ok(!v.edges.some((e) => e.rule && e.from === 'ENG-318' && e.to === c19.path));
  assert.ok(v.edges.some((e) => e.rule && e.from === 'ENG-318' && e.to === c12.path));
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
  assert.deepEqual(cfg.overview.setup.map((s) => s.id), ['agreement', 'sources', 'people', 'slack', 'first_call'], 'step 00 is the signed agreement');
  assert.ok(cfg.overview.setup[0].at < cfg.overview.setup[1].at, 'the agreement comes before any setup');
  const ws = demoWorkspace();
  const pending = ws.task_log.find((e) => e.pending);
  assert.deepEqual(Object.keys(cfg.issue_body), [pending.tasks_path]);
  assert.deepEqual(Object.keys(cfg.issue_body[pending.tasks_path]), pending.proposals.filter((p) => p.status === 'pending').map((p) => String(p.n)), 'one body per waiting proposal');
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
  // Open: GRW-224 and the GRW-219 test. GRW-205 and GRW-214 were finished on later calls; done counts one per issue.
  assert.deepEqual(activity, { calls: 6, open: 2, monitoring: 1, done: 3, helps: 1, tracker_refs: ['GRW-205', 'GRW-214', 'GRW-219', 'GRW-224'] });
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
  assert.deepEqual(ws.overview.open_by_owner, [{ owner: 'Brooks', open: 3 }, { owner: 'Carter', open: 2 }, { owner: 'Hughes', open: 2 }, { owner: 'Okafor', open: 1 }]);
  assert.deepEqual(ws.overview.training, { rows: 21, accepted: 11, edited: 1, skipped: 9 });
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
    assert.equal(row.user_action, p.status === 'approved' ? (p.edited ? 'edited' : 'accepted') : 'skipped');
    assert.equal(row.edit_summary || null, p.edit_summary, 'the edit note is the twin of the tasks file');
    assert.equal(row.reason || null, p.status === 'skipped' ? p.decision.reason : null, 'a skip keeps its reason');
    assert.equal(p.decided_at, row.ts, 'decided_at comes from the training log');
    assert.equal(row.tracker_ref || null, ['created', 'commented'].includes(p.decision.result) ? p.decision.ref : null);
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }

  // Settings a vault can answer: Linear activity and the Slack channels.
  const s = V.settingsFromVault({ tenant: d.tenant, calls: d.calls, taskLog: ws.task_log });
  assert.deepEqual(s.sources.find((x) => x.id === 'linear').activity, { issues_created: 7, comments: 4, file_only: 1 });
  assert.deepEqual(s.sources.find((x) => x.id === 'linear').settings.default_assignees, { product: 'Brooks', growth: 'Carter', engineering: 'Hughes' }, 'Sources › Linear: "product → PRD (Brooks)"');
  assert.deepEqual(s.slack, { channel: '#call-digests', per_team_channels: { product: '#product-sync' } });
});

// ------------------------------------------------------------------ truthful items, decisions, search, metrics

const callOn = (ws, date) => ws.calls.find((c) => c.date === date);
const proposalOn = (ws, date, n) => ws.task_log.find((e) => e.date === date).proposals.find((p) => p.n === n);

test('open items: what a later call records as done is closed, and lists show one row per issue', () => {
  const d = loadDemo();
  const ws = demoWorkspace(d);
  const row = (date, ref, status = 'post-call') => ws.action_items.find((a) => a.call_date === date && a.tracker_ref === ref && a.status === status);
  // [earlier row's call, issue, the call that recorded it done, the minute it says so, what it says]
  const closures = [
    ['2026-10-12', 'ENG-318', '2026-10-19', '15:20', 'the per-clinic rate limits are live'],
    ['2026-10-05', 'ENG-311', '2026-10-14', '01:30', 'The billing estimate came in at 6 engineering days'],
    ['2026-10-05', 'GRW-205', '2026-10-09', '02:30', 'Step data is in'],
    ['2026-10-09', 'GRW-221', '2026-10-16', '09:10', 'checklist went live'],
    ['2026-10-07', 'GRW-214', '2026-10-19', '01:40', 'The pricing page is done'],
    ['2026-10-14', 'GRW-214', '2026-10-19', '01:40', 'The pricing page is done'],
  ];
  for (const [date, ref, doneOn, ts, said] of closures) {
    const a = row(date, ref);
    const closer = callOn(ws, doneOn);
    const done = row(doneOn, ref, 'done-on-call');
    assert.ok(a && done, `${date} ${ref}: the row and the done-on-call row that closes it`);
    assert.deepEqual(a.closed_by, { call_id: closer.id, topic: closer.topic, date: doneOn, ts, title: done.title }, `${date} ${ref}: Done · ${doneOn} ▶ ${ts}`);
    assert.deepEqual([a.superseded, a.open], [true, false]);
    // The closing call says it: a Done-on-call entry in its digest, at a cue with the words.
    const c = d.calls.find((x) => x.date === doneOn);
    assert.ok(V.digest(c.sections).next_steps.some((st) => st.status === 'done-on-call' && st.ts === ts && st.title === done.title), `${doneOn}: Done on call lists "${done.title}"`);
    assert.ok(V.parseVtt(d.read(V.transcriptPathFor(c))).some((cue) => cue.ts_mmss === ts && cue.text.includes(said)), `${doneOn} ▶ ${ts} says "${said}"`);
  }
  // GRW-219 goes on: the A/B test row (16 Oct) replaces the rewrite row (9 Oct), and nothing says it is done.
  assert.deepEqual([row('2026-10-09', 'GRW-219').superseded, row('2026-10-09', 'GRW-219').closed_by, row('2026-10-16', 'GRW-219').open], [true, null, true]);
  // ENG-311 goes on too: the estimate is in, the mid-trial work is the issue's open row.
  assert.deepEqual([row('2026-10-14', 'ENG-311', 'done-on-call').superseded, row('2026-10-19', 'ENG-311').open], [true, true]);

  // A list shows one row per issue: the latest.
  const shown = ws.action_items.filter((a) => !a.superseded && a.tracker_ref).map((a) => a.tracker_ref);
  assert.deepEqual(shown, [...new Set(shown)]);
  assert.deepEqual([ws.stats.action_items, ws.stats.latest_items, ws.stats.open_items], [24, 16, 8]);

  // Every count reads only open items: not closed, not superseded.
  const open = ws.action_items.filter((a) => a.open);
  assert.ok(open.every((a) => a.status === 'post-call' && !a.closed_by && !a.superseded));
  assert.equal(ws.overview.open_by_owner.reduce((n, o) => n + o.open, 0), open.length);
  const people = V.peopleIndex({ members: d.members, calls: d.calls }).people;
  assert.equal(people.reduce((n, x) => n + x.activity.open, 0), open.length, 'people activity agrees');
  assert.deepEqual(people.find((x) => x.lastname === 'Kim').activity.open, 0, "both of Kim's items were finished on later calls");
  assert.deepEqual(people.find((x) => x.lastname === 'Okafor').activity.done, 1, 'ENG-318 counts for the person who owned it');

  // Call detail marks the same rows and their next steps; without the other calls (/app) nothing is closed.
  const call12 = d.calls.find((c) => c.date === '2026-10-12');
  const detail = ws._detail(call12.id);
  const ai = detail.action_items.find((a) => a.tracker_ref === 'ENG-318');
  assert.deepEqual([ai.closed_by.date, ai.closed_by.ts, ai.superseded, ai.open], ['2026-10-19', '15:20', true, false]);
  const step = detail.digest.next_steps.find((st) => st.ts === '12:30');
  assert.deepEqual([step.tracker_ref, step.closed_by.date, step.superseded], ['ENG-318', '2026-10-19', true]);
  assert.deepEqual(V.callDetail(call12, null).action_items.map((a) => [a.closed_by, a.superseded]), [[null, false], [null, false], [null, false]]);
});

test('decisions: every decision has a why, and the register lists them newest first with the follow-up', () => {
  const ws = demoWorkspace();
  assert.equal(ws.decisions.length, 8);
  assert.equal(ws.decisions.length, ws.overview.digest_totals.decisions);
  for (const x of ws.decisions) {
    assert.ok(x.why && x.why.trim().length > 10, `${x.date} "${x.title}" says why`);
    assert.deepEqual(Object.keys(x), ['call_id', 'topic', 'date', 'time', 'team', 'n', 'title', 'why', 'ts', 'follow_up']);
  }
  assert.deepEqual(ws.decisions.map((x) => [x.date, x.ts, x.follow_up && x.follow_up.owner, x.follow_up && x.follow_up.tracker_ref]), [
    ['2026-10-19', '09:45', 'Hughes', 'ENG-311'],
    ['2026-10-16', '06:30', 'Carter', 'GRW-219'],
    ['2026-10-14', '04:15', 'Brooks', null],
    ['2026-10-14', '14:40', 'Kim', 'GRW-214'],
    ['2026-10-12', '12:30', 'Okafor', 'ENG-318'],
    ['2026-10-09', '10:05', 'Carter', 'GRW-219'],
    ['2026-10-07', '16:40', 'Carter', 'GRW-214'],
    ['2026-10-05', '16:20', 'Hughes', 'ENG-311'],
  ], 'newest call first; each with the action item that carries it out');
  const pricing = ws.decisions.find((x) => x.date === '2026-10-07');
  assert.deepEqual([pricing.call_id, pricing.topic, pricing.time, pricing.team, pricing.title, pricing.why],
    [callOn(ws, '2026-10-07').id, 'Pricing model review', '13:00', 'product', 'Ship the $19 self-serve tier before the Q4 campaign', 'the creative already assumes it'], 'the landing\'s wording, exactly');
  assert.deepEqual(pricing.follow_up, {
    title: 'Rewrite pricing page copy for the self-serve tier', owner: 'Carter', tracker_ref: 'GRW-214', ts: '14:32', status: 'post-call',
    closed_by: ws.action_items.find((a) => a.call_date === '2026-10-07' && a.tracker_ref === 'GRW-214').closed_by, superseded: true, open: false,
  });
  for (const c of ws.calls) assert.equal(c.first_decision, ws.decisions.find((x) => x.call_id === c.id).title, `${c.date}: first_decision`);
});

test('search: calls match on what was said, and every hit has its line and ▶', () => {
  const d = loadDemo();
  const ws = demoWorkspace(d);
  const hits = (q) => ws.calls.filter((c) => c.search.includes(q.toLowerCase())).map((c) => c.date).sort();
  assert.deepEqual(hits('Shah'), ['2026-10-12', '2026-10-19'], 'a name heard on calls');
  assert.deepEqual(hits('go/no-go'), ['2026-10-14', '2026-10-19']);
  assert.deepEqual(hits('$19'), ['2026-10-07']);
  assert.deepEqual(hits('ENG-318'), ['2026-10-12', '2026-10-19'], 'issue keys');
  assert.equal(hits('Emma Carter').length, 6, 'participants by full name');
  assert.deepEqual(hits('Smith'), ['2026-10-07'], 'guests');
  const KINDS = ['topic', 'people', 'tags', 'summary', 'decision', 'agreement', 'action_item', 'open_question', 'key_insight', 'quote', 'proposal'];
  for (const c of ws.calls) {
    assert.equal(c.search, c.search.toLowerCase());
    const call = d.calls.find((x) => x.id === c.id);
    const cues = new Set(V.parseVtt(d.read(V.transcriptPathFor(call))).map((cue) => cue.ts_mmss));
    for (const l of c.search_lines) {
      assert.deepEqual(Object.keys(l), ['text', 'ts', 'kind']);
      assert.ok(KINDS.includes(l.kind), l.kind);
      assert.ok(c.search.includes(l.text.toLowerCase()), `${c.date}: "${l.text}" is in the blob`);
      if (l.ts) assert.ok(cues.has(l.ts), `${c.date} "${l.text}": ▶ ${l.ts} opens a cue`);
    }
  }
  const shah = callOn(ws, '2026-10-12').search_lines.filter((l) => /shah/i.test(l.text));
  assert.deepEqual(shah, [
    { text: 'Shah (support): 31 clinics wrote in during the outage; every ticket was answered within the hour', ts: '01:45', kind: 'summary' },
    { text: 'Write the customer-facing incident note — Hughes (helpers: Shah)', ts: '33:40', kind: 'action_item' },
  ]);
  const decision = callOn(ws, '2026-10-07').search_lines.find((l) => l.kind === 'decision');
  assert.deepEqual(decision, { text: 'Ship the $19 self-serve tier before the Q4 campaign — the creative already assumes it', ts: '16:40', kind: 'decision' });
});

test('transcripts: about two lines of context on either side of every cited line', () => {
  const d = loadDemo();
  const cfg = demoConfig();
  const cited = new Map(d.calls.map((c) => [c.path, new Set(V.digestTimestamps(c.sections))]));
  for (const t of d.tasks) for (const dr of t.drafts) if (dr.ts) cited.get(t.call).add(dr.ts);
  for (const m of d.members) {
    for (const z of m.zone_evidence) if (z.evidence && z.evidence.ts) cited.get(d.calls.find((c) => c.date === z.evidence.date).path).add(z.evidence.ts);
  }
  for (const s of Object.values(cfg.people.suggestions)) {
    for (const ev of [...s.role.evidence, ...s.zones.flatMap((z) => z.evidence)]) cited.get(ev.call).add(ev.ts);
  }
  const sec = (ts) => { const [m, s] = ts.split(':').map(Number); return m * 60 + s; };
  let checked = 0;
  for (const c of d.calls) {
    const cues = V.parseVtt(d.read(V.transcriptPathFor(c)));
    for (const ts of cited.get(c.path)) {
      const i = cues.findIndex((cue) => cue.ts_mmss === ts);
      assert.ok(i >= 0, `${c.path}: a cue at ${ts}`);
      const around = [...cues.slice(Math.max(0, i - 2), i), ...cues.slice(i + 1, i + 3)];
      assert.equal(around.length, 4, `${c.path} ▶ ${ts}: two lines before and two after`);
      for (const x of around) assert.ok(Math.abs(sec(x.ts_mmss) - sec(ts)) <= 120, `${c.path} ▶ ${ts}: ${x.ts_mmss} is within two minutes`);
      checked++;
    }
    // Cues stay in order and never overlap.
    for (let i = 1; i < cues.length; i++) assert.ok(sec(cues[i].ts_mmss) > sec(cues[i - 1].ts_mmss), `${c.path}: cues in order at ${cues[i].ts_mmss}`);
  }
  assert.equal(checked, 59, 'every cited line in the seven calls');
});

test('review corrections: an owner changed before filing, and a "Wrong team" skip', () => {
  const d = loadDemo();
  const ws = demoWorkspace(d);
  const edit = proposalOn(ws, '2026-10-05', 2);
  assert.deepEqual([edit.status, edit.edited, edit.edit_summary, edit.changed, edit.owner, edit.original.owner, edit.decision.result, edit.decision.ref, edit.agreement],
    ['approved', true, 'owner: Okafor → Hughes', ['owner'], 'Hughes', 'Okafor', 'created', 'ENG-311', 'edited']);
  assert.deepEqual(edit.original, { title: edit.title, owner: 'Okafor', priority: 'high', owner_team: 'engineering' }, 'the shape the workspace\'s own edits use');
  const skip = proposalOn(ws, '2026-10-12', 3);
  assert.deepEqual([skip.verdict, skip.status, skip.decision.reason, skip.decision.reason_kind, skip.agreement, skip.prevents_duplicate],
    ['CREATE', 'skipped', 'Wrong team', 'wrong_team', 'overridden', false]);
  const row = (title) => d.training.find((r) => r.task_title === title);
  assert.deepEqual([row(edit.title).user_action, row(edit.title).edit_summary, row(edit.title).tracker_ref], ['edited', 'owner: Okafor → Hughes', 'ENG-311']);
  assert.deepEqual([row(skip.title).user_action, row(skip.title).reason], ['skipped', 'Wrong team']);
  // Create is no longer 9 of 9 with nothing edited.
  const creates = ws.task_log.flatMap((e) => e.proposals).filter((p) => p.verdict === 'CREATE' && p.status !== 'pending');
  assert.deepEqual([creates.length, creates.filter((p) => p.status === 'approved').length, creates.filter((p) => p.edited).length], [9, 8, 1]);
  // The checklist proposal was filed in growth, where GRW-221 lives.
  const checklist = proposalOn(ws, '2026-10-09', 2);
  assert.deepEqual([checklist.owner, checklist.owner_team, checklist.decision.ref], ['Kim', 'growth', 'GRW-221']);
  // The helpers read the workspace's own wording too.
  assert.deepEqual(V.parseEditNote('owner: none → Kim; priority: medium → high; title edited'),
    { changed: ['owner', 'priority', 'title'], from: { owner: null, priority: 'medium' }, to: { owner: 'Kim', priority: 'high' } });
  assert.deepEqual(['already covered', 'already done', 'not a task', 'wrong owner', 'wrong team', 'other', ''].map((r) => V.reasonKind(r, 'FLAG')),
    ['covered', 'done', 'not_a_task', 'wrong_owner', 'wrong_team', 'other', null]);
  assert.equal(V.reasonKind('', 'DUPLICATE'), 'covered', 'a duplicate skipped without a reason');
});

test('overview metrics: the base values the workspace recomputes with its own decisions', () => {
  const d = loadDemo();
  const ws = demoWorkspace(d);
  const m = ws.overview.metrics;
  const decided = ws.task_log.flatMap((e) => e.proposals).filter((p) => p.status !== 'pending');
  assert.deepEqual(m.verdict_agreement, { agreed: 19, edited: 1, decided: 21 });
  assert.equal(decided.filter((p) => p.agreement === 'overridden').length, 1, 'the "Wrong team" skip');
  assert.deepEqual(m.duplicates_prevented, { confirmed: 11 });
  assert.equal(decided.filter((p) => p.prevents_duplicate).length, 11);
  assert.ok(m.duplicates_prevented.confirmed <= ws.stats.duplicates_caught);
  assert.deepEqual(m.owner_coverage, { with_owner: 14, total: 14 });
  assert.deepEqual(m.processing, {
    calls: 7, median_digest_minutes: 9, max_digest_minutes: 24,
    last: { call_id: callOn(ws, '2026-10-19').id, at: '2026-10-19T09:44:00.000Z', minutes: 9 },
  }, 'the newest call: tasks generated 10:44 BST, 9 min after the 35-minute call that began at 10:00');
  assert.deepEqual([m.time_to_decision.median_minutes, m.time_to_decision.over_48h], [13, 0]);
  assert.deepEqual(m.time_to_decision.calls.map((c) => [c.minutes, c.pending]), [[null, 4], [10, 0], [11, 0], [1350, 0], [14, 0], [11, 0], [38, 0]],
    'per call, newest first: call end → last decision; 12 Oct waited overnight for the "Wrong team" skip');
  const pricing = m.time_to_decision.calls.find((c) => c.call_id === callOn(ws, '2026-10-07').id);
  assert.deepEqual([pricing.ended_at, pricing.decided_at], ['2026-10-07T12:47:00.000Z', '2026-10-07T12:58:00.000Z'], '13:00 BST + 47 min');
  // Four proposals still wait; three days on they count as waiting more than 48 h.
  assert.equal(demoWorkspace(d, '2026-10-22T12:00:00Z').overview.metrics.time_to_decision.over_48h, 4);
  // Wall-clock times read in the tenant's zone, on both sides of the clock change.
  assert.equal(V.zonedMs('2026-10-05', '10:00', 'Europe/London'), Date.parse('2026-10-05T09:00:00Z'));
  assert.equal(V.zonedMs('2026-10-26', '10:00', 'Europe/London'), Date.parse('2026-10-26T10:00:00Z'));
  assert.equal(V.zonedMs('2026-10-05', '10:00'), Date.parse('2026-10-05T10:00:00Z'), 'no zone: UTC');
});

test('demo data: settings.issues covers every issue a proposal names; the demo clock is frozen', () => {
  const { ws, settings, details } = demoData();
  assert.equal(ws.workspace.demo_now, '2026-10-19T11:05:00+01:00');
  assert.equal(ws._detail, undefined);
  const named = new Set(ws.task_log.flatMap((e) => e.proposals.flatMap((p) => [
    p.target && p.target.ref, ['created', 'commented'].includes(p.decision.result) ? p.decision.ref : null,
  ])).filter(Boolean));
  assert.deepEqual(Object.keys(settings.issues).sort(), [...named].sort());
  assert.deepEqual(settings.issues['GRW-102'], { title: 'Billing FAQ refresh', status: 'Open', assignee: 'Carter', updated: '2026-10-03', team: 'GRW' });
  for (const e of ws.task_log) {
    for (const p of e.proposals) {
      if (p.target && p.target.title) assert.equal(settings.issues[p.target.ref].title, p.target.title, `${p.target.ref}: the vault's title`);
      if (p.decision.result === 'created') assert.equal(settings.issues[p.decision.ref].title, p.title, `${p.decision.ref}: filed under the proposal's title`);
    }
  }
  for (const [ref, i] of Object.entries(settings.issues)) assert.equal(i.team, ref.split('-')[0]);
  // The tracker agrees with the calls: an issue is Done exactly when its latest row is not open.
  for (const a of ws.action_items.filter((x) => x.tracker_ref && !x.superseded)) {
    assert.equal(settings.issues[a.tracker_ref].status === 'Done', !a.open, `${a.tracker_ref}: tracker status and the latest row agree`);
  }
  // The decided proposals keep no on_approve; the call detail carries the same item states.
  assert.ok(ws.task_log.every((e) => e.proposals.every((p) => p.status === 'pending' || p.on_approve === null)));
  const d19 = details.find((x) => x.date === '2026-10-19');
  assert.deepEqual(d19.action_items.map((a) => [a.tracker_ref, a.status, a.open]),
    [['ENG-311', 'post-call', true], [null, 'post-call', true], ['ENG-318', 'done-on-call', false], ['GRW-214', 'done-on-call', false]]);
  assert.equal(V.buildWorkspace({ info: { id: 'x' }, callPaths: [], calls: [], tasks: [], members: [] }).workspace.demo_now, undefined, '/app has no demo clock');
});

test('call files pass their record keys through; each source has health; the review log is feedback', () => {
  const d = loadDemo();
  const c19 = d.calls.find((c) => c.date === '2026-10-19');
  assert.deepEqual(
    ['type', 'schema_version', 'filer_model', 'pipeline_version', 'source_id'].map((k) => c19[k]),
    ['transcript', 1, 'claude-sonnet-4-6', '0.1.0', 'DEMOuuid0007x=='],
    'as written in the frontmatter',
  );
  const bare = V.parseCall('general/transcripts/2026-10-19 1000 x.md', '---\ntopic: X\ndate: 2026-10-19\n---\n\n## Summary\n\nx\n');
  assert.deepEqual([bare.type, bare.schema_version, bare.filer_model, bare.pipeline_version, bare.source_id], [null, null, null, null, null], 'absent keys stay null');

  const { settings, details, vault } = demoData();
  assert.equal(details.find((x) => x.id === c19.id).filer_model, 'claude-sonnet-4-6', 'call JSON carries them');
  const health = Object.fromEntries(settings.sources.map((s) => [s.id, s.health]));
  assert.deepEqual(health, {
    zoom: { last_event: '2026-10-19T09:35:00.000Z', failures_30d: 0 }, // the 35-minute call that began at 10:00 BST ended
    slack: { last_event: '2026-10-19T09:44:00.000Z', failures_30d: 0 }, // the proposals reply, after the 10:36 root post
    linear: { last_event: '2026-10-19T09:44:00.000Z', failures_30d: 0 }, // the backlog check
    github: { last_event: '2026-10-19T09:44:00.000Z', failures_30d: 0 }, // the commit with the tasks file
  });
  const fromVault = V.settingsFromVault({ tenant: d.tenant, calls: d.calls, taskLog: demoWorkspace(d).task_log });
  assert.ok(fromVault.sources.every((s) => s.health.failures_30d === null), 'the vault keeps no failure log: that count is config');

  const all = [];
  const visit = (n) => { all.push(n); (n.children || []).forEach(visit); };
  vault.tree.forEach(visit);
  const training = all.find((n) => n.path === '.backbrief/training/');
  assert.equal(training.about, V.TRAINING_ABOUT);
  assert.match(training.about, /feedback/);
  assert.ok(!/training data/i.test(JSON.stringify(vault)), 'vault.json never says "training data"');
});

test('processing minutes: unknown without the tenant clock, never negative', () => {
  const call = { id: '2026-10-19-x', date: '2026-10-19', time: '10:00', duration_min: 35, action_items: [] };
  const tenant = { tenant: { timezone: 'Europe/London' } };
  const run = (generated, t = tenant) => V.metrics({
    calls: [call], taskLog: [{ call_id: call.id, generated, pending: 0, proposals: [] }], timezone: t ? 'Europe/London' : null, tenant: t,
  }).processing;
  assert.deepEqual(run('2026-10-19T09:44:00Z'), { calls: 1, median_digest_minutes: 9, max_digest_minutes: 9, last: { call_id: call.id, at: '2026-10-19T09:44:00.000Z', minutes: 9 } });
  // Stamped before the call ended (a local time written as UTC, or a missing zone): unknown, not -26.
  assert.deepEqual(run('2026-10-19T09:09:00Z'), { calls: 1, median_digest_minutes: null, max_digest_minutes: null, last: { call_id: call.id, at: '2026-10-19T09:09:00.000Z', minutes: null } });
  // /app reads no tenant.yaml: when the digest came out is still known, how long after the call is not.
  assert.deepEqual(run('2026-10-19T09:44:00Z', null), { calls: 1, median_digest_minutes: null, max_digest_minutes: null, last: { call_id: call.id, at: '2026-10-19T09:44:00.000Z', minutes: null } });
  // No stamp at all: nothing to show.
  assert.equal(run(null, null).last, null);
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
  // The live path serves the same register, search and item states; it has no demo clock, and
  // minutes that need tenant.yaml's zone stay null until /app reads it.
  assert.equal(ws.decisions.length, 8);
  assert.ok(ws.calls.every((c) => typeof c.search === 'string' && Array.isArray(c.search_lines) && 'first_decision' in c));
  assert.equal(ws.stats.open_items, 8);
  assert.equal(ws.overview.metrics.processing.median_digest_minutes, null);
  assert.equal(ws.workspace.demo_now, undefined);
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
