// SPDX-License-Identifier: MIT
// GET /api/auth/google-callback?code&state — finish "Continue with Google".
import { readCookie } from '../../../lib/http.js';
import { createSessionCookie } from '../../../lib/session.js';
import { memberWorkspace } from '../../../lib/auth.js';
import { googleConfigured, emailFromCode, STATE_COOKIE } from '../../../lib/google.js';

const clearState = `${STATE_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

function go(request, to, cookies = []) {
  const headers = new Headers({ location: new URL(to, request.url).toString(), 'cache-control': 'no-store' });
  for (const c of [clearState, ...cookies]) headers.append('set-cookie', c);
  return new Response(null, { status: 303, headers });
}

export async function onRequestGet({ request, env }) {
  if (!googleConfigured(env)) return go(request, '/login#google-unavailable');
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = readCookie(request, STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) return go(request, '/login#google-failed');
  let email;
  try {
    email = await emailFromCode(env, url.origin, code);
  } catch (e) {
    console.error(`[cabinet] google sign-in: ${e.message}`);
    return go(request, '/login#google-failed');
  }
  const workspace = await memberWorkspace(env, email);
  if (!workspace) return go(request, '/login#google-not-registered');
  return go(request, '/app', [await createSessionCookie(env, { email, workspace })]);
}
