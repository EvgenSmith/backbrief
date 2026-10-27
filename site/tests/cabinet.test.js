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
import { requestSignIn } from '../lib/auth.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = path.join(SITE, 'demo-vault');

function demoWorkspace() {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(VAULT).map((f) => path.relative(VAULT, f).split(path.sep).join('/'));
  const read = (p) => fs.readFileSync(path.join(VAULT, p), 'utf8');
  const of = (k) => files.filter((f) => V.classify(f) === k);
  return V.buildWorkspace({
    info: { id: 'demo', name: 'Acme' },
    callPaths: of('call'),
    calls: of('call').map((p) => V.parseCall(p, read(p))),
    tasks: of('tasks').map((p) => V.parseTasks(p, read(p))),
    members: of('member').map((p) => V.parseMember(p, read(p))),
    now: '2026-10-20T00:00:00Z',
  });
}

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
  assert.equal(ws.stats.proposals, 14);
  assert.equal(ws.stats.duplicates_caught, 4);
  assert.deepEqual(ws.calls.map((c) => c.date), [...ws.calls.map((c) => c.date)].sort().reverse(), 'newest first');
  const ru = ws.calls.find((c) => c.language === 'ru');
  assert.ok(ru && /воронк/.test(ru.topic), 'the Russian call keeps its own language');
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

test('sign-in and workspace API end to end', async (t) => {
  const { srv, env, call } = await server();
  t.after(() => srv.close());

  // Unknown email: same answer, no link, nothing stored.
  let r = await call('/api/auth/request', postJson({ email: 'stranger@example.com' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).dev_link, undefined);

  // Signed out: the API refuses.
  assert.equal((await call('/api/workspace')).status, 401);

  // Member (case-insensitive): a one-time link.
  r = await call('/api/auth/request', postJson({ email: 'Dev@Acme.dev' }));
  const { dev_link } = await r.json();
  assert.match(dev_link, /\/api\/auth\/verify\?token=[0-9a-f]{64}$/);
  const token = new URL(dev_link).searchParams.get('token');

  // GET shows a confirmation page and does NOT consume the token (mail scanners).
  r = await call(`/api/auth/verify?token=${token}`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<form method="post" action="\/api\/auth\/verify">/);

  // POST consumes it and sets the session.
  r = await call('/api/auth/verify', postForm({ token }));
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /\/app$/);
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(';')[0];
  const auth = { headers: { cookie } };

  // The same link never works twice.
  r = await call('/api/auth/verify', postForm({ token }));
  assert.match(r.headers.get('location'), /error=expired/);

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

  // Removed from the workspace: the session stops working at once.
  const cfg = await env.CABINET.get('workspace:acme-dev', { type: 'json' });
  await env.CABINET.put('workspace:acme-dev', JSON.stringify({ ...cfg, members: [] }));
  assert.equal((await call('/api/workspace', auth)).status, 403);
  await env.CABINET.put('workspace:acme-dev', JSON.stringify(cfg));

  // Sign out clears the cookie.
  r = await call('/api/auth/logout', { method: 'POST', headers: { cookie } });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('the dev sign-in shortcut never works off localhost', async () => {
  const env = await devEnv(0);
  const prod = await requestSignIn(env, { email: 'dev@acme.dev', origin: 'https://backbrief.example' });
  assert.equal(prod.sent, true);
  assert.equal(prod.link, undefined);
  const local = await requestSignIn(env, { email: 'dev@acme.dev', origin: 'http://localhost:8788' });
  assert.match(local.link, /^http:\/\/localhost:8788\/api\/auth\/verify\?token=/);
});

test('sign-in requests are rate limited per email', async (t) => {
  const { srv, call } = await server();
  t.after(() => srv.close());
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call('/api/auth/request', postJson({ email: 'dev@acme.dev' }))).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
  assert.equal((await call('/api/auth/request', postJson({ email: 'not-an-email' }))).status, 400);
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
