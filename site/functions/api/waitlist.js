// SPDX-License-Identifier: MIT
/*
 * Cloudflare Pages Function: POST /api/waitlist
 *
 * Same-origin endpoint for the beta-access form. It forwards exactly one thing,
 * the typed email, to the existing waitlist API (gateway/worker.js,
 * POST /v1/waitlist, interest "hosted"). The gateway stays the only place an
 * email is stored, and it needs no CORS because the browser never calls it.
 *
 * Env:
 *   WAITLIST_API      base URL of the gateway (default: the hosted gateway)
 *   WAITLIST_DRY_RUN  "1" → validate and answer without calling upstream
 *                     (local preview, CI)
 *
 * Accepts JSON ({email, website}) from the enhanced form, or
 * application/x-www-form-urlencoded from the no-JavaScript form, which gets a
 * 303 redirect back to the page it came from (the landing page or /book)
 * instead of JSON. The form's name field is never forwarded or stored.
 */

const DEFAULT_API = 'https://backbrief-telemetry.backbrief.workers.dev';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env = {} }) {
  const type = request.headers.get('content-type') || '';
  const isForm = !type.includes('application/json');
  let email = '';
  let honeypot = '';
  try {
    if (isForm) {
      const data = await request.formData();
      email = String(data.get('email') || '');
      honeypot = String(data.get('website') || '');
    } else {
      const body = await request.json();
      email = typeof body?.email === 'string' ? body.email : '';
      honeypot = typeof body?.website === 'string' ? body.website : '';
    }
  } catch {
    return reply(isForm, request, 400, { error: 'invalid request body' });
  }

  email = email.trim();
  // Bots fill the hidden field; answer as if it worked and store nothing.
  if (honeypot) return reply(isForm, request, 201, { ok: true });
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return reply(isForm, request, 400, { error: 'email: required, must be a valid address' });
  }
  if (env.WAITLIST_DRY_RUN === '1') return reply(isForm, request, 201, { ok: true, dry_run: true });

  const api = (env.WAITLIST_API || DEFAULT_API).replace(/\/+$/, '');
  let upstream;
  try {
    upstream = await fetch(`${api}/v1/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, interest: 'hosted' }),
    });
  } catch {
    return reply(isForm, request, 502, { error: 'waitlist unavailable' });
  }
  // 201 created and 409 duplicate both mean "you're on the list".
  if (upstream.status === 201 || upstream.status === 409) return reply(isForm, request, 201, { ok: true });
  if (upstream.status === 400) return reply(isForm, request, 400, { error: 'email: required, must be a valid address' });
  return reply(isForm, request, 502, { error: 'waitlist unavailable' });
}

const FORM_PAGES = ['/', '/book'];

function reply(isForm, request, status, body) {
  if (isForm) {
    let page = '/';
    try {
      const from = new URL(request.headers.get('referer') || '');
      if (from.origin === new URL(request.url).origin && FORM_PAGES.includes(from.pathname)) page = from.pathname;
    } catch { /* no or malformed referer: back to the landing page */ }
    const to = new URL(`${page}${status < 300 ? '#booked' : '#book-form'}`, request.url);
    return Response.redirect(to.toString(), 303);
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
