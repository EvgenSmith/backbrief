// SPDX-License-Identifier: MIT
// Session guard for the cabinet API: a valid session whose workspace still
// exists and still lists the user as a member, or a 401.
import { readSession } from './session.js';
import { getWorkspaceConfig } from './workspace.js';
import { json } from './http.js';

export async function requireMember(request, env) {
  const session = await readSession(request, env);
  if (!session) return { error: json({ error: 'not signed in' }, 401) };
  const cfg = await getWorkspaceConfig(env, session.workspace);
  const members = (cfg && cfg.members || []).map((m) => String(m).toLowerCase());
  if (!cfg || !members.includes(session.email)) return { error: json({ error: 'no access to this workspace' }, 403) };
  return { session, cfg };
}

/** Log the cause server-side, return a generic message to the browser. */
export function failure(where, err) {
  console.error(`[cabinet] ${where}: ${err && err.message}`);
  const status = err && (err.status === 401 || err.status === 403 || err.status === 404) ? 502 : 500;
  return json({ error: 'could not read the vault', detail: err && err.status ? `GitHub ${err.status}` : undefined }, status);
}
