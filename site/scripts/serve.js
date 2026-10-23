// SPDX-License-Identifier: MIT
/*
 * serve.js — local preview of site/dist/ with Cloudflare Pages semantics:
 * clean URLs (/privacy → privacy.html), 404.html for unknown paths, and the
 * real functions/api/waitlist.js answering POST /api/waitlist in dry-run mode
 * (nothing is sent anywhere).
 *
 * Usage: node scripts/serve.js [--port 8788]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../functions/api/waitlist.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > -1 ? process.argv[portArg + 1] : 8788);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
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

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/waitlist')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: 'POST', headers: req.headers, body: Buffer.concat(chunks),
    });
    const response = await onRequestPost({ request, env: { WAITLIST_DRY_RUN: '1' } });
    console.log(`POST /api/waitlist → ${response.status} (dry run)`);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  const file = resolveFile(req.url) || path.join(DIST, '404.html');
  const status = file.endsWith(`${path.sep}404.html`) && !req.url.startsWith('/404') ? 404 : 200;
  res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log(`preview: http://localhost:${PORT}`));
