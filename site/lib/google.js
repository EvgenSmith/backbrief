// SPDX-License-Identifier: MIT
/*
 * google.js — "Continue with Google" for workspace members (OpenID Connect,
 * authorization code flow).
 *
 * Env: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Cloud OAuth
 * client of type "Web application", with <origin>/api/auth/google-callback as
 * an authorised redirect URI. Without them the button explains that Google
 * sign-in is not available instead of failing.
 *
 * The state value travels in a short-lived HttpOnly cookie and must come back
 * unchanged. Only a verified Google email is accepted, and it still has to be
 * a workspace member.
 */
export const STATE_COOKIE = 'bb_oauth';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

export const googleConfigured = (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const redirectUri = (origin) => `${origin}/api/auth/google-callback`;

export function authUrl(env, origin, state) {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account',
  });
  return `${AUTH}?${q}`;
}

/** Exchange the code for the user's verified email (lower-cased). Throws on any failure. */
export async function emailFromCode(env, origin, code) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(origin),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`google token: HTTP ${res.status}`);
  const { access_token: accessToken } = await res.json();
  const info = await fetch(USERINFO, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!info.ok) throw new Error(`google userinfo: HTTP ${info.status}`);
  const { email, email_verified: verified } = await info.json();
  if (!email || verified !== true) throw new Error('google: email missing or not verified');
  return String(email).toLowerCase();
}
