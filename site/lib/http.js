// SPDX-License-Identifier: MIT
// Small response helpers shared by the Pages Functions.

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function redirect(to, request, headers = {}) {
  const location = new URL(to, request.url).toString();
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...headers } });
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  try {
    if (type.includes('application/json')) return { data: await request.json(), form: false };
    const form = await request.formData();
    return { data: Object.fromEntries(form.entries()), form: true };
  } catch {
    return { data: null, form: !type.includes('application/json') };
  }
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
