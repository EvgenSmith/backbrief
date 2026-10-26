// SPDX-License-Identifier: MIT
/*
 * auth.js — passwordless sign-in for beta workspaces.
 *
 * request: an email that belongs to a workspace gets a one-time link
 *          (token stored hashed in KV, 15-minute TTL, single use). Every
 *          request gets the same answer, so the endpoint never reveals who is
 *          in the beta. 5 requests per email per hour, 30 per client IP.
 * consume: the link opens a confirmation page whose button POSTs the token.
 *          Link scanners in corporate mail prefetch GET URLs; a GET that
 *          consumed the token would sign the user out of their own link.
 */
import { sha256, randomToken } from './session.js';
import { sendSignInEmail } from './mail.js';
import { workspaceIdForEmail } from './workspace.js';

const TOKEN_TTL = 15 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
export const validEmail = (e) => EMAIL_RE.test(e) && e.length <= 254;

async function overLimit(env, key, limit) {
  const hour = new Date().toISOString().slice(0, 13);
  const k = `rl:${key}:${hour}`;
  const used = Number(await env.CABINET.get(k)) || 0;
  if (used >= limit) return true;
  await env.CABINET.put(k, String(used + 1), { expirationTtl: 3700 });
  return false;
}

/**
 * Start a sign-in. Returns {sent, link?}; `link` only when DEV_RETURN_LINK=1
 * (local preview), never in production.
 */
export async function requestSignIn(env, { email, origin, ip }) {
  if (ip && await overLimit(env, `ip:${await sha256(ip)}`, 30)) return { sent: false, limited: true };
  if (await overLimit(env, `email:${await sha256(email)}`, 5)) return { sent: false, limited: true };
  const workspace = await workspaceIdForEmail(env, email);
  if (!workspace) return { sent: false };
  const token = randomToken();
  await env.CABINET.put(`login:${await sha256(token)}`, JSON.stringify({ e: email, w: workspace }), { expirationTtl: TOKEN_TTL });
  const link = `${origin}/api/auth/verify?token=${token}`;
  await sendSignInEmail(env, { to: email, link });
  // Returning the link skips the mailbox, so it only ever happens on localhost.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return { sent: true, link: env.DEV_RETURN_LINK === '1' && local ? link : undefined };
}

/** Consume a one-time token. Returns {email, workspace} or null. */
export async function consumeToken(env, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const key = `login:${await sha256(token)}`;
  const data = await env.CABINET.get(key, { type: 'json' });
  if (!data) return null;
  await env.CABINET.delete(key);
  return { email: data.e, workspace: data.w };
}
