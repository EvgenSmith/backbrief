// SPDX-License-Identifier: MIT
// POST /api/auth/login {email, password} — sign a workspace member in.
// Emails that belong to no workspace get "not_registered", so the login page
// can offer a demo instead.
import { json, readBody, redirect } from '../../../lib/http.js';
import { signIn, normalizeEmail, validEmail } from '../../../lib/auth.js';
import { createSessionCookie } from '../../../lib/session.js';

const ANSWERS = {
  limited: [429, 'limited'],
  not_registered: [404, 'not-registered'],
  no_password: [409, 'no-password'],
  wrong_password: [401, 'wrong-password'],
};

export async function onRequestPost({ request, env }) {
  const { data, form } = await readBody(request);
  const email = normalizeEmail(data && data.email);
  const password = typeof data?.password === 'string' ? data.password : '';
  if (!validEmail(email) || !password) {
    return form ? redirect('/login#invalid', request) : json({ error: 'invalid' }, 400);
  }
  const result = await signIn(env, { email, password, ip: request.headers.get('cf-connecting-ip') });
  if (result.status !== 'ok') {
    const [status, hash] = ANSWERS[result.status];
    return form ? redirect(`/login#${hash}`, request) : json({ error: result.status }, status);
  }
  const cookie = await createSessionCookie(env, { email, workspace: result.workspace });
  return form
    ? redirect('/app', request, { 'set-cookie': cookie })
    : json({ ok: true, redirect: '/app' }, 200, { 'set-cookie': cookie });
}
