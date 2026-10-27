// SPDX-License-Identifier: MIT
// POST /api/auth/logout — clear the session cookie.
import { redirect } from '../../../lib/http.js';
import { clearSessionCookie } from '../../../lib/session.js';

export async function onRequestPost({ request }) {
  return redirect('/login#signed-out', request, { 'set-cookie': clearSessionCookie() });
}
