// SPDX-License-Identifier: MIT
// POST /api/auth/request {email} — send a one-time sign-in link to a beta member.
// The answer is identical whether or not the email belongs to a workspace.
import { json, readBody, redirect } from '../../../lib/http.js';
import { requestSignIn, normalizeEmail, validEmail } from '../../../lib/auth.js';

export async function onRequestPost({ request, env }) {
  const { data, form } = await readBody(request);
  const email = normalizeEmail(data && data.email);
  if (!validEmail(email)) {
    return form ? redirect('/login?error=email', request) : json({ error: 'email: required, must be a valid address' }, 400);
  }
  let result;
  try {
    result = await requestSignIn(env, {
      email,
      origin: new URL(request.url).origin,
      ip: request.headers.get('cf-connecting-ip'),
    });
  } catch (e) {
    console.error(`[cabinet] sign-in request: ${e.message}`);
    return form ? redirect('/login?error=send', request) : json({ error: 'could not send the email, try again later' }, 502);
  }
  if (result.limited) {
    return form ? redirect('/login?error=limit', request) : json({ error: 'too many requests, try again in an hour' }, 429);
  }
  if (form) return redirect('/login?sent=1', request);
  return json({ ok: true, ...(result.link ? { dev_link: result.link } : {}) });
}
