// SPDX-License-Identifier: MIT
/*
 * build.js — render the landing page into site/dist/.
 *
 * Zero dependencies (Node >= 18). Pages live in src/*.html and use three
 * directives:
 *   <!-- @include NAME -->   inline src/partials/NAME.html
 *   <!-- @team -->           team cards from site.config.json
 *   <!-- @hosts -->          demo hosts' photos (demo_hosts in site.config.json)
 *   <!-- @rating -->         G2 stars, only when links.g2_rating holds the rating G2 shows
 *   <!-- @demo -->           demo video block, only when demo_video_url is set
 *   {{ dotted.path }}        HTML-escaped value from site.config.json, the
 *                            page entry below, or {year, updated}
 * An unknown {{ token }} fails the build, so a typo can never ship as text.
 *
 * Values still starting with "TODO:" render verbatim so a preview shows what
 * is missing; `check.js --release` refuses to pass while any remain.
 *
 * Usage: node scripts/build.js [--out <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classify, parseCall, parseTasks, parseMember, parseCompany, buildWorkspace, workspaceJson,
} from '../lib/vault.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = path.resolve(outArg > -1 ? process.argv[outArg + 1] : path.join(ROOT, 'dist'));

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));

// The pages. `out` is the file name in dist/; Cloudflare Pages serves
// privacy.html at /privacy and 404.html for unknown paths.
export const PAGES = [
  {
    src: 'index.html', out: 'index.html', path: '/',
    title: `${config.product}: calls into tasks, digests and company memory`,
    description: `${config.product} turns recorded team calls into deduplicated tasks in your tracker, chat digests with timestamps, and a markdown memory in your own git repository.`,
  },
  {
    src: 'privacy.html', out: 'privacy.html', path: '/privacy',
    title: `Privacy policy | ${config.product}`,
    description: `How ${config.product} handles personal data on this website and in the hosted beta.`,
  },
  {
    src: 'terms.html', out: 'terms.html', path: '/terms',
    title: `Terms of use | ${config.product}`,
    description: `Terms for this website and the hosted ${config.product} beta.`,
  },
  {
    src: 'login.html', out: 'login.html', path: '/login',
    title: `Sign in | ${config.product}`,
    description: `Sign in to your ${config.product} beta workspace with a one-time email link.`,
  },
  {
    src: 'cabinet.html', out: 'demo.html', path: '/demo', mode: 'demo', robots: 'index, follow',
    title: `Demo workspace | ${config.product}`,
    description: `A live ${config.product} workspace for a fictional team: calls, digests, action items and task proposals read from an example vault.`,
  },
  {
    src: 'cabinet.html', out: 'app.html', path: '/app', mode: 'app', robots: 'noindex',
    title: `Workspace | ${config.product}`,
    description: `Your ${config.product} workspace: calls, digests, action items and people from your team's vault.`,
  },
  {
    src: 'book.html', out: 'book.html', path: '/book',
    title: `Book a demo | ${config.product}`,
    description: `Thirty minutes with the people who built ${config.product}: bring one recording of your team's call and see its decisions and tracker tasks live.`,
  },
  {
    src: '404.html', out: '404.html', path: '/404',
    title: `Page not found | ${config.product}`,
    description: `This page does not exist.`,
  },
];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function lookup(scope, dotted) {
  return dotted.split('.').reduce((v, k) => (v == null ? undefined : v[k]), scope);
}

function renderTeam(team) {
  const people = (team || []).map((p) => `
        <article class="person">
          ${p.photo ? `<img class="person-photo" src="${esc(p.photo)}" alt="" width="72" height="72">` : ''}
          <h3>${esc(p.name)}</h3>
          <p class="role">${esc(p.role)}</p>
          ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
          ${p.linkedin ? `<a href="${esc(p.linkedin)}">LinkedIn</a>` : ''}
        </article>`).join('');
  return `      <div class="team">${people}\n      </div>`;
}

function renderHosts(hosts) {
  const list = (hosts || []).filter((h) => h.name && h.photo);
  if (!list.length) return '';
  const names = list.map((h) => h.name);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
  const faces = list.map((h) =>
    `<img src="${esc(h.photo)}" alt="${esc(h.name)}" width="88" height="88">`).join('');
  return `<div class="hosts">${faces}</div>
          <p class="hosts-names">You'll talk to ${esc(who)}.</p>`;
}

// Stars are drawn only from the rating the public G2 page shows for real
// reviews (links.g2_rating); with no rating there is nothing to show.
function renderRating(rating) {
  const r = Number(rating);
  if (!rating || !(r >= 1 && r <= 5)) return '';
  const full = Math.round(r);
  return `<span class="rating" aria-label="Rated ${r.toFixed(1)} out of 5 on G2"><span class="stars" aria-hidden="true">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>${r.toFixed(1)}</span>`;
}

function renderDemo(url) {
  if (!url) return '';
  return `      <div class="demo"><video controls preload="none" src="${esc(url)}"></video></div>`;
}

function render(name, page, stack = []) {
  if (stack.includes(name)) throw new Error(`include cycle: ${[...stack, name].join(' → ')}`);
  let html = fs.readFileSync(path.join(ROOT, 'src', name), 'utf8');
  html = html.replace(/<!-- @include ([\w-]+) -->/g, (_, part) =>
    render(path.join('partials', `${part}.html`), page, [...stack, name]).trimEnd());
  html = html.replace(/<!-- @team -->/g, () => renderTeam(config.team));
  html = html.replace(/<!-- @demo -->/g, () => renderDemo(config.demo_video_url));
  html = html.replace(/<!-- @hosts -->/g, () => renderHosts(config.demo_hosts));
  html = html.replace(/<!-- @rating -->/g, () => renderRating(config.links.g2_rating));
  const scope = {
    ...config,
    page,
    year: new Date().getUTCFullYear(),
    updated: new Date().toISOString().slice(0, 10),
  };
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = lookup(scope, key);
    if (v === undefined || v === null || typeof v === 'object') {
      throw new Error(`${name}: unknown token {{ ${key} }}`);
    }
    return esc(v);
  });
}

// SPDX headers license the source in this repository; the served site is a
// commercial product page, so they are dropped from everything we publish.
const SPDX = /^[ \t]*(?:<!--|\/\*|\/\/)\s*SPDX-License-Identifier:[^\n]*\n/gm;
const stripSpdx = (text) => text.replace(SPDX, '');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else if (/\.(css|js|svg)$/.test(entry.name)) fs.writeFileSync(b, stripSpdx(fs.readFileSync(a, 'utf8')));
    else fs.copyFileSync(a, b);
  }
}

/*
 * The public demo workspace: site/demo-vault is a real vault (it passes the
 * kit's validate-vault.js), parsed by the same lib/vault.js the live cabinet
 * uses, and written out as the static JSON /demo reads.
 */
function buildDemo(out) {
  const root = path.join(ROOT, 'demo-vault');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(root).map((f) => path.relative(root, f).split(path.sep).join('/'));
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const of = (kind) => files.filter((f) => classify(f) === kind).sort();
  const calls = of('call').map((p) => parseCall(p, read(p)));
  const latest = calls.map((c) => c.date).sort().pop() || new Date().toISOString().slice(0, 10);
  const ws = buildWorkspace({
    info: {
      id: 'demo',
      name: config.demo.name,
      mode: 'demo',
      vault_url: config.demo.vault_url || '',
      tracker_url: config.demo.tracker_url || null,
      integrations: { zoom: true, slack: true, linear: true, github: true },
    },
    callPaths: of('call'),
    calls,
    tasks: of('tasks').map((p) => parseTasks(p, read(p))),
    members: of('member').map((p) => parseMember(p, read(p))),
    company: of('company').length ? parseCompany(read('docs/company.md')) : null,
    // A fixed "now" keeps the demo's "last 30 days" stable as real time passes.
    now: new Date(`${latest}T23:59:59Z`).toISOString(),
  });
  const dir = path.join(out, 'demo');
  fs.mkdirSync(path.join(dir, 'calls'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(workspaceJson(ws)));
  fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify({ people: ws.people }));
  for (const c of ws.calls) {
    const detail = ws._detail(c.id);
    detail.vault_file_url = config.demo.file_url_base
      ? config.demo.file_url_base + c.path.split('/').map(encodeURIComponent).join('/')
      : null;
    fs.writeFileSync(path.join(dir, 'calls', `${c.id}.json`), JSON.stringify(detail));
  }
  return ws.calls.length;
}

function isSet(v) {
  return typeof v === 'string' && v.trim() !== '' && !v.startsWith('TODO');
}

export function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const page of PAGES) {
    fs.writeFileSync(path.join(OUT, page.out), stripSpdx(render(page.src, page)));
  }
  copyDir(path.join(ROOT, 'assets'), path.join(OUT, 'assets'));
  buildDemo(OUT);

  // Cloudflare Pages response headers: strict CSP (everything is same-origin
  // except the booking calendar, when one is configured), no framing, no
  // referrer leakage.
  const calendar = isSet(config.links.book_demo) ? ` frame-src ${new URL(config.links.book_demo).origin};` : '';
  fs.writeFileSync(path.join(OUT, '_headers'), [
    '/*',
    `  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; media-src 'self' https:;${calendar} form-action 'self'; base-uri 'self'; frame-ancestors 'none'`,
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  X-Content-Type-Options: nosniff',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
    '/app',
    '  X-Robots-Tag: noindex',
    '/login',
    '  X-Robots-Tag: noindex',
    '/api/*',
    '  X-Robots-Tag: noindex',
    '',
  ].join('\n'));

  const robots = ['User-agent: *', 'Allow: /', 'Disallow: /app', 'Disallow: /api/'];
  if (isSet(config.domain)) {
    const base = `https://${config.domain}`;
    const urls = PAGES.filter((p) => !['404.html', 'app.html', 'login.html'].includes(p.out))
      .map((p) => `  <url><loc>${base}${p.path === '/' ? '/' : p.path}</loc></url>`).join('\n');
    fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
    robots.push(`Sitemap: ${base}/sitemap.xml`);
  }
  fs.writeFileSync(path.join(OUT, 'robots.txt'), robots.join('\n') + '\n');
  return OUT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = build();
    console.log(`built ${PAGES.length} pages → ${path.relative(process.cwd(), out) || '.'}`);
  } catch (e) {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  }
}
