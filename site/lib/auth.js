// SPDX-License-Identifier: MIT
/*
 * auth.js — workspace sign-in: email and password, password reset by email
 * link, and the membership check that Google sign-in shares.
 *
 * Accounts exist only for emails a workspace lists as members (workspace.js).
 * Anyone else gets "not_registered", so the login page can point them to a
 * demo. That answer is deliberate for an invite-only B2B product, and it is
 * rate limited.
 *
 * password  PBKDF2-SHA256, 100 000 iterations (the Workers ceiling), 16-byte
 *           salt, stored in KV as pw:<email> = "pbkdf2$<iterations>$<salt>$<hash>".
 * reset     a member asks for a link; its token is stored hashed in KV for
 *           30 minutes and works once. The link opens /reset, and only the POST
 *           that sets the new password consumes it, so mail scanners that
 *           prefetch links cannot burn it.
 * limits    login: 10 per email and 30 per client IP per hour;
 *           reset: 5 per email and 30 per client IP per hour.
 */
import { sha256, randomToken } from './session.js';
import { sendPasswordEmail } from './mail.js';
import { workspaceIdForEmail } from './workspace.js';

const RESET_TTL = 30 * 60;
const ITERATIONS = 100000;
export const MIN_PASSWORD = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const enc = new TextEncoder();
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

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

async function limited(env, kind, { email, ip }, perEmail) {
  if (ip && await overLimit(env, `${kind}:ip:${await sha256(ip)}`, 30)) return true;
  return overLimit(env, `${kind}:email:${await sha256(email)}`, perEmail);
}

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2$${ITERATIONS}$${salt}$${await pbkdf2(password, salt, ITERATIONS)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, expected] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2' || !salt || !expected) return false;
  const actual = await pbkdf2(password, salt, Number(iterations));
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** The workspace an email belongs to, or null. */
export const memberWorkspace = (env, email) => workspaceIdForEmail(env, email);

/**
 * Email and password sign-in.
 * Returns {status: 'ok', workspace} or {status: 'limited' | 'not_registered' |
 * 'no_password' | 'wrong_password'}.
 */
export async function signIn(env, { email, password, ip }) {
  if (await limited(env, 'login', { email, ip }, 10)) return { status: 'limited' };
  const workspace = await memberWorkspace(env, email);
  if (!workspace) return { status: 'not_registered' };
  const stored = await env.CABINET.get(`pw:${email}`);
  if (!stored) return { status: 'no_password' };
  if (!(await verifyPassword(password, stored))) return { status: 'wrong_password' };
  return { status: 'ok', workspace };
}

/**
 * Email a member a link to set a new password.
 * Returns {status: 'sent', link?} or {status: 'limited' | 'not_registered'};
 * `link` only when DEV_RETURN_LINK=1 on localhost, never in production.
 */
export async function requestReset(env, { email, origin, ip }) {
  if (await limited(env, 'reset', { email, ip }, 5)) return { status: 'limited' };
  const workspace = await memberWorkspace(env, email);
  if (!workspace) return { status: 'not_registered' };
  const token = randomToken();
  await env.CABINET.put(`reset:${await sha256(token)}`, JSON.stringify({ e: email, w: workspace }), { expirationTtl: RESET_TTL });
  const link = `${origin}/reset?token=${token}`;
  await sendPasswordEmail(env, { to: email, link });
  // Returning the link skips the mailbox, so it only ever happens on localhost.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return { status: 'sent', link: env.DEV_RETURN_LINK === '1' && local ? link : undefined };
}

/**
 * Set a new password with a reset token.
 * Returns {status: 'ok', email, workspace} or {status: 'weak' | 'expired'}.
 */
export async function setPassword(env, { token, password }) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) return { status: 'weak' };
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return { status: 'expired' };
  const key = `reset:${await sha256(token)}`;
  const data = await env.CABINET.get(key, { type: 'json' });
  if (!data) return { status: 'expired' };
  await env.CABINET.delete(key);
  // Membership is checked again: someone removed since the email was sent gets nothing.
  const workspace = await memberWorkspace(env, data.e);
  if (!workspace) return { status: 'expired' };
  await env.CABINET.put(`pw:${data.e}`, await hashPassword(password));
  return { status: 'ok', email: data.e, workspace };
}
