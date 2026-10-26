// SPDX-License-Identifier: MIT
/*
 * workspace.js — beta workspaces: who may sign in, and where their vault is.
 *
 * Registry (KV namespace bound as CABINET; written by scripts/workspace.js
 * during hand-held onboarding):
 *   workspace:<id>   {"id","name","members":[emails],
 *                     "vault":{"owner","repo","branch","root"},
 *                     "tracker_url":"https://linear.app/<org>/issue/{ref}",
 *                     "integrations":{"zoom":true,"slack":true,"linear":true}}
 *   member:<email>   "<id>"
 * Vault read token: Pages secret VAULT_TOKEN_<ID> (id upper-cased, non
 * alphanumerics → _). Tokens never live in KV.
 *
 * Free-plan Functions allow 50 subrequests per request. A workspace load is
 * 1 tree request + one per call in the window + one per paired tasks file, so
 * the window defaults to 20 calls (CALLS_WINDOW raises it on a paid plan).
 * Team profiles load separately on the People tab.
 */
import { githubSource } from './github.js';
import {
  classify, dateFromName, callId, parseCall, parseTasks, parseMember,
  buildWorkspace, callDetail, labelFromName,
} from './vault.js';

export async function workspaceIdForEmail(env, email) {
  return env.CABINET.get(`member:${email.toLowerCase()}`);
}

export async function getWorkspaceConfig(env, id) {
  const cfg = await env.CABINET.get(`workspace:${id}`, { type: 'json' });
  return cfg && cfg.id === id ? cfg : null;
}

export const tokenVar = (id) => `VAULT_TOKEN_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

function sourceFor(env, cfg) {
  if (!cfg.vault || !cfg.vault.owner || !cfg.vault.repo) throw new Error(`workspace ${cfg.id}: vault.owner/repo not configured`);
  return githubSource(env, cfg.vault, env[tokenVar(cfg.id)], cfg.id);
}

const byDateDesc = (a, b) => {
  const da = dateFromName(a.path); const db = dateFromName(b.path);
  return `${db.date} ${db.time}`.localeCompare(`${da.date} ${da.time}`);
};

const tasksPathFor = (callPath) => `tasks/${callPath.split('/').pop().replace(/\.md$/, '')}.tasks.md`;

function info(cfg) {
  return {
    id: cfg.id,
    name: cfg.name,
    mode: 'live',
    vault_url: `https://github.com/${cfg.vault.owner}/${cfg.vault.repo}`,
    tracker_url: cfg.tracker_url || null,
    integrations: { ...(cfg.integrations || {}), github: true },
  };
}

/** Workspace overview: totals from the whole tree, details from the latest window of calls. */
export async function loadWorkspace(env, cfg, now = new Date().toISOString()) {
  const src = sourceFor(env, cfg);
  const { files } = await src.tree();
  const callFiles = files.filter((f) => classify(f.path) === 'call').sort(byDateDesc);
  const taskFiles = new Map(files.filter((f) => classify(f.path) === 'tasks').map((f) => [f.path, f]));
  const memberCount = files.filter((f) => classify(f.path) === 'member').length;
  const windowSize = Math.max(1, Number(env.CALLS_WINDOW) || 20);
  const recent = callFiles.slice(0, windowSize);

  const calls = await Promise.all(recent.map(async (f) => parseCall(f.path, await src.read(f.path, f.sha))));
  const tasks = (await Promise.all(recent.map(async (f) => {
    const t = taskFiles.get(tasksPathFor(f.path));
    return t ? parseTasks(t.path, await src.read(t.path, t.sha)) : null;
  }))).filter(Boolean);
  for (const c of calls) c.references = c.references.map((p) => stripRoot(p, src.root));

  const ws = buildWorkspace({
    info: info(cfg),
    callPaths: callFiles.map((f) => f.path),
    calls,
    tasks,
    members: [],
    now,
  });
  ws.stats.people = memberCount;
  return ws;
}

/** One call with its proposals; found by id from the tree alone. */
export async function loadCall(env, cfg, id) {
  const src = sourceFor(env, cfg);
  const { files } = await src.tree();
  const f = files.find((x) => classify(x.path) === 'call' && callId(x.path, dateFromName(x.path).date) === id);
  if (!f) return null;
  const call = parseCall(f.path, await src.read(f.path, f.sha));
  call.references = call.references.map((p) => stripRoot(p, src.root));
  const t = files.find((x) => x.path === tasksPathFor(f.path));
  const tasks = t ? parseTasks(t.path, await src.read(t.path, t.sha)) : null;
  const detail = callDetail(call, tasks);
  detail.vault_file_url = src.url(f.path);
  return detail;
}

/** Team profiles (the People tab). */
export async function loadPeople(env, cfg) {
  const src = sourceFor(env, cfg);
  const { files } = await src.tree();
  const members = files.filter((f) => classify(f.path) === 'member').slice(0, 40);
  const people = await Promise.all(members.map(async (f) => parseMember(f.path, await src.read(f.path, f.sha))));
  return people.filter((p) => p.status !== 'stale').sort((a, b) => a.lastname.localeCompare(b.lastname));
}

function stripRoot(p, root) {
  const s = String(p).replace(/^\/+/, '');
  return root && s.startsWith(`${root}/`) ? s.slice(root.length + 1) : s;
}

export { labelFromName };
