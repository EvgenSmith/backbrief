// SPDX-License-Identifier: MIT
/*
 * serve.js — local preview of site/dist/ with Cloudflare Pages semantics:
 * clean URLs (/privacy → privacy.html), 404.html for unknown paths, and every
 * file under functions/ answering its route, exactly as on Pages.
 *
 * Nothing leaves the machine. The functions run against:
 *   - an in-memory KV (binding CABINET),
 *   - MAIL_PROVIDER=log + DEV_RETURN_LINK=1: the sign-in link is printed here
 *     and shown on the login page instead of being emailed,
 *   - WAITLIST_DRY_RUN=1: the beta form validates but stores nothing,
 *   - a mock GitHub API at /__github serving site/demo-vault as a repository,
 *     with a workspace "acme-dev" whose member is dev@acme.dev, so /app shows
 *     the live code path end to end.
 *
 * Usage: node scripts/serve.js [--port 8788]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const VAULT = path.join(ROOT, 'demo-vault');
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > -1 ? process.argv[portArg + 1] : 8788);

export function memoryKV() {
  const m = new Map();
  return {
    async get(k, opt) {
      const e = m.get(k);
      if (!e || (e.exp && e.exp < Date.now())) return null;
      const t = typeof opt === 'string' ? opt : opt && opt.type;
      return t === 'json' ? JSON.parse(e.v) : e.v;
    },
    async put(k, v, opt = {}) { m.set(k, { v: String(v), exp: opt.expirationTtl ? Date.now() + opt.expirationTtl * 1000 : 0 }); },
    async delete(k) { m.delete(k); },
  };
}

export async function devEnv(port) {
  const kv = memoryKV();
  const ws = {
    id: 'acme-dev',
    name: 'Acme (local preview)',
    members: ['dev@acme.dev'],
    vault: { owner: 'acme', repo: 'vault', branch: 'main', root: '' },
    tracker_url: null,
    integrations: { zoom: true, slack: true, linear: true },
  };
  await kv.put(`workspace:${ws.id}`, JSON.stringify(ws));
  await kv.put('member:dev@acme.dev', ws.id);
  return {
    CABINET: kv,
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    MAIL_PROVIDER: 'log',
    DEV_RETURN_LINK: '1',
    WAITLIST_DRY_RUN: '1',
    GITHUB_API: `http://localhost:${port}/__github`,
    VAULT_TOKEN_ACME_DEV: 'local-preview-token',
  };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.json': 'application/json; charset=utf-8',
};

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const candidates = clean === '/' ? ['index.html'] : [clean.slice(1), `${clean.slice(1)}.html`];
  for (const c of candidates) {
    const file = path.join(DIST, c);
    if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

// --- mock GitHub (tree + raw contents) over the demo vault -------------------
function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}
function mockGithub(url, res) {
  const u = new URL(url, 'http://x');
  const tree = u.pathname.match(/^\/__github\/repos\/[^/]+\/[^/]+\/git\/trees\/[^/]+$/);
  if (tree) {
    const entries = walk(VAULT).map((f) => ({
      path: path.relative(VAULT, f).split(path.sep).join('/'),
      type: 'blob',
      sha: crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'),
    }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tree: entries, truncated: false }));
    return;
  }
  const contents = u.pathname.match(/^\/__github\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
  if (contents) {
    const rel = contents[1].split('/').map(decodeURIComponent).join('/');
    const file = path.join(VAULT, rel);
    if (file.startsWith(VAULT) && fs.existsSync(file)) { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(file)); return; }
  }
  res.writeHead(404).end('{"message":"Not Found"}');
}

// --- Pages Functions routing --------------------------------------------------
const modules = new Map();
async function functionFor(urlPath) {
  const file = path.join(ROOT, 'functions', `${urlPath.split('?')[0].replace(/^\/+|\/+$/g, '')}.js`);
  if (!file.startsWith(path.join(ROOT, 'functions')) || !fs.existsSync(file)) return null;
  if (!modules.has(file)) modules.set(file, await import(pathToFileURL(file).href));
  return modules.get(file);
}

export async function handle(req, res, env) {
  if (req.url.startsWith('/__github/')) return mockGithub(req.url, res);
  if (req.url.startsWith('/api/')) {
    const mod = await functionFor(req.url);
    const method = req.method.charAt(0) + req.method.slice(1).toLowerCase();
    const fn = mod && (mod[`onRequest${method}`] || mod.onRequest);
    if (!fn) { res.writeHead(mod ? 405 : 404).end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(`http://${req.headers.host || `localhost:${PORT}`}${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await fn({ request, env });
    const out = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (cookies.length) out['set-cookie'] = cookies;
    console.log(`${req.method} ${req.url.split('?')[0]} → ${response.status}`);
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  const file = resolveFile(req.url) || path.join(DIST, '404.html');
  const status = file.endsWith(`${path.sep}404.html`) && !req.url.startsWith('/404') ? 404 : 200;
  res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = await devEnv(PORT);
  http.createServer((req, res) => handle(req, res, env).catch((e) => {
    console.error(e);
    res.writeHead(500).end('internal error');
  })).listen(PORT, () => {
    console.log(`preview: http://localhost:${PORT}  ·  demo: /demo  ·  sign in at /login as dev@acme.dev`);
  });
}
