// SPDX-License-Identifier: MIT
// GET /api/people — team profiles of the signed-in workspace.
import { json } from '../../lib/http.js';
import { requireMember, failure } from '../../lib/guard.js';
import { loadPeople } from '../../lib/workspace.js';

export async function onRequestGet({ request, env }) {
  const { error, cfg } = await requireMember(request, env);
  if (error) return error;
  try {
    return json({ people: await loadPeople(env, cfg) });
  } catch (e) {
    return failure('people', e);
  }
}
