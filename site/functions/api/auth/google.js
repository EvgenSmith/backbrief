// SPDX-License-Identifier: MIT
// GET /api/auth/google — start "Continue with Google" (see lib/google.js).
import { redirect } from '../../../lib/http.js';
import { randomToken } from '../../../lib/session.js';
import { googleConfigured, authUrl, STATE_COOKIE } from '../../../lib/google.js';

export async function onRequestGet({ request, env }) {
  if (!googleConfigured(env)) return redirect('/login#google-unavailable', request);
  const state = randomToken(16);
  return new Response(null, {
    status: 303,
    headers: {
      location: authUrl(env, new URL(request.url).origin, state),
      'set-cookie': `${STATE_COOKIE}=${state}; Path=/api/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  });
}
