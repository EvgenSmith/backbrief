// SPDX-License-Identifier: MIT
// POST /api/auth/password {token, password} — set a new password from a reset
// link, then sign the member in.
import { json, readBody, redirect } from '../../../lib/http.js';
import { setPassword } from '../../../lib/auth.js';
import { createSessionCookie } from '../../../lib/session.js';

export async function onRequestPost({ request, env }) {
  const { data, form } = await readBody(request);
  const result = await setPassword(env, { token: data && data.token, password: data && data.password });
  if (result.status === 'weak') return form ? redirect('/login#forgot', request) : json({ error: 'weak' }, 400);
  if (result.status === 'expired') return form ? redirect('/login#reset-expired', request) : json({ error: 'expired' }, 410);
  const cookie = await createSessionCookie(env, { email: result.email, workspace: result.workspace });
  return form
    ? redirect('/app', request, { 'set-cookie': cookie })
    : json({ ok: true, redirect: '/app' }, 200, { 'set-cookie': cookie });
}
