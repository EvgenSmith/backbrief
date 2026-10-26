// SPDX-License-Identifier: MIT
// GET /api/workspace — overview, recent calls and action items for the signed-in workspace.
import { json } from '../../lib/http.js';
import { requireMember, failure } from '../../lib/guard.js';
import { loadWorkspace } from '../../lib/workspace.js';
import { workspaceJson } from '../../lib/vault.js';

export async function onRequestGet({ request, env }) {
  const { error, cfg } = await requireMember(request, env);
  if (error) return error;
  try {
    return json(workspaceJson(await loadWorkspace(env, cfg)));
  } catch (e) {
    return failure('workspace', e);
  }
}
