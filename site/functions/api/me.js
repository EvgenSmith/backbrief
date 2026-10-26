// SPDX-License-Identifier: MIT
// GET /api/me — who is signed in, and to which workspace.
import { json } from '../../lib/http.js';
import { requireMember } from '../../lib/guard.js';

export async function onRequestGet({ request, env }) {
  const { error, session, cfg } = await requireMember(request, env);
  if (error) return error;
  return json({ email: session.email, workspace: { id: cfg.id, name: cfg.name } });
}
