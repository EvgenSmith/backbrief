// SPDX-License-Identifier: MIT
/*
 * GET  /api/auth/verify?token=…  confirmation page with a "Sign in" button
 * POST /api/auth/verify          consume the token, set the session, go to /app
 *
 * Two steps on purpose: mail security scanners fetch links before the user
 * does, and a GET that consumed the single-use token would break the link.
 */
import { html, readBody, redirect, esc } from '../../../lib/http.js';
import { consumeToken } from '../../../lib/auth.js';
import { createSessionCookie } from '../../../lib/session.js';

export async function onRequestGet({ request }) {
  const token = new URL(request.url).searchParams.get('token') || '';
  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in | Backbrief</title>
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<main class="doc wrap narrow auth-card">
  <a class="brand" href="/"><img src="/assets/logo.svg" alt="" width="28" height="28"><span>Backbrief</span></a>
  <h1>Sign in to your workspace</h1>
  <form method="post" action="/api/auth/verify">
    <input type="hidden" name="token" value="${esc(token)}">
    <button class="btn" type="submit">Sign in</button>
  </form>
  <p class="small muted">This link works once and expires 15 minutes after it was sent.</p>
</main>
</body>
</html>`, 200, { 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
}

export async function onRequestPost({ request, env }) {
  const { data } = await readBody(request);
  const session = await consumeToken(env, data && data.token);
  if (!session) return redirect('/login?error=expired', request);
  return redirect('/app', request, { 'set-cookie': await createSessionCookie(env, session) });
}
