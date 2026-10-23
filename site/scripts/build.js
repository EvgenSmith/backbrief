// SPDX-License-Identifier: MIT
/*
 * build.js — render the landing page into site/dist/.
 *
 * Zero dependencies (Node >= 18). Pages live in src/*.html and use three
 * directives:
 *   <!-- @include NAME -->   inline src/partials/NAME.html
 *   <!-- @team -->           team cards from site.config.json
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
    description: `${config.product} turns recorded team calls into deduplicated tasks in your tracker, Slack digests with timestamps, and a markdown memory in your own git repository.`,
  },
  {
    src: 'privacy.html', out: 'privacy.html', path: '/privacy',
    title: `Privacy policy | ${config.product}`,
    description: `How ${config.product} handles personal data on this website, in the self-hosted kit and in the hosted beta.`,
  },
  {
    src: 'terms.html', out: 'terms.html', path: '/terms',
    title: `Terms of use | ${config.product}`,
    description: `Terms for this website and the hosted ${config.product} beta.`,
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
          <h3>${esc(p.name)}</h3>
          <p class="role">${esc(p.role)}</p>
          ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
          ${p.linkedin ? `<a href="${esc(p.linkedin)}">LinkedIn</a>` : ''}
        </article>`).join('');
  return `      <div class="team">${people}\n      </div>`;
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

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

function isSet(v) {
  return typeof v === 'string' && v.trim() !== '' && !v.startsWith('TODO');
}

export function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const page of PAGES) {
    fs.writeFileSync(path.join(OUT, page.out), render(page.src, page));
  }
  copyDir(path.join(ROOT, 'assets'), path.join(OUT, 'assets'));

  // Cloudflare Pages response headers: strict CSP (everything is same-origin),
  // no framing, no referrer leakage.
  fs.writeFileSync(path.join(OUT, '_headers'), [
    '/*',
    "  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; media-src 'self' https:; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  X-Content-Type-Options: nosniff',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
    '',
  ].join('\n'));

  const robots = ['User-agent: *', 'Allow: /'];
  if (isSet(config.domain)) {
    const base = `https://${config.domain}`;
    const urls = PAGES.filter((p) => p.out !== '404.html')
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
