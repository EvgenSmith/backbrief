// SPDX-License-Identifier: MIT
/*
 * session.js — stateless signed session cookie, and hashing helpers.
 *
 * Cookie value: base64url(JSON {e: email, w: workspace id, x: expiry (s)})
 * + "." + base64url(HMAC-SHA256(SESSION_SECRET, payload)). HttpOnly, Secure,
 * SameSite=Lax. Nothing is stored server-side; rotating SESSION_SECRET signs
 * everyone out.
 */
import { readCookie } from './http.js';

export const COOKIE = 'bb_session';
const MAX_AGE = 14 * 24 * 3600;
const enc = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function secretOf(env) {
  const s = env && env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET is missing or shorter than 32 characters');
  return s;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSessionCookie(env, { email, workspace }, now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ e: email, w: workspace, x: Math.floor(now / 1000) + MAX_AGE })));
  const value = `${payload}.${await hmac(secretOf(env), payload)}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Returns {email, workspace} for a valid, unexpired session, else null. */
export async function readSession(request, env, now = Date.now()) {
  const raw = readCookie(request, COOKIE);
  if (!raw || !raw.includes('.')) return null;
  const [payload, sig] = raw.split('.');
  let expected;
  try { expected = await hmac(secretOf(env), payload); } catch { return null; }
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (!data.e || !data.w || !(data.x > now / 1000)) return null;
    return { email: data.e, workspace: data.w };
  } catch {
    return null;
  }
}
