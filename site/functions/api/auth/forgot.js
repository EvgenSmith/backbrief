// SPDX-License-Identifier: MIT
// POST /api/auth/forgot {email} — email a workspace member a link to set a new password.
import { json, readBody, redirect } from '../../../lib/http.js';
import { requestReset, normalizeEmail, validEmail } from '../../../lib/auth.js';

export async function onRequestPost({ request, env }) {
  const { data, form } = await readBody(request);
  const email = normalizeEmail(data && data.email);
  if (!validEmail(email)) return form ? redirect('/login#forgot', request) : json({ error: 'invalid' }, 400);
  let result;
  try {
    result = await requestReset(env, { email, origin: new URL(request.url).origin, ip: request.headers.get('cf-connecting-ip') });
  } catch (e) {
    console.error(`[cabinet] password email: ${e.message}`);
    return form ? redirect('/login#send-failed', request) : json({ error: 'send_failed' }, 502);
  }
  if (result.status === 'limited') return form ? redirect('/login#limited', request) : json({ error: 'limited' }, 429);
  if (result.status === 'not_registered') return form ? redirect('/login#not-registered', request) : json({ error: 'not_registered' }, 404);
  if (form) return redirect('/login#reset-sent', request);
  return json({ ok: true, ...(result.link ? { dev_link: result.link } : {}) });
}
