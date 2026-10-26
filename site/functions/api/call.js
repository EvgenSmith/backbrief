// SPDX-License-Identifier: MIT
// GET /api/call?id=<call id> — one call: digest sections, action items, task proposals.
import { json } from '../../lib/http.js';
import { requireMember, failure } from '../../lib/guard.js';
import { loadCall } from '../../lib/workspace.js';

export async function onRequestGet({ request, env }) {
  const { error, cfg } = await requireMember(request, env);
  if (error) return error;
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[\w-]{6,40}$/.test(id)) return json({ error: 'bad id' }, 400);
  try {
    const call = await loadCall(env, cfg, id);
    return call ? json(call) : json({ error: 'not found' }, 404);
  } catch (e) {
    return failure('call', e);
  }
}
