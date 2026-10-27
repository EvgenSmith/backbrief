// SPDX-License-Identifier: MIT
/*
 * check.js — lint the built landing page against what startup-program
 * reviewers verify (site/README.md → "What reviewers check").
 *
 * Always enforced (exit 1 on failure):
 *   - every page: lang, <title>, meta description, viewport, exactly one <h1>
 *   - no third-party scripts, stylesheets, fonts or frames (CSP is 'self')
 *   - every internal link and #anchor resolves; every <img> has alt
 *   - required home-page sections exist: #product #how #security #fit #plans #team #beta
 *   - legal footer present on every page; privacy and terms pages linked
 *   - no wording that ties the product to crypto or to another company
 *     (NVIDIA Inception excludes "companies associated with cryptocurrency";
 *     Google and Oracle screen regulated sectors)
 *
 * --release additionally fails on:
 *   - any remaining "TODO" placeholder in the built pages
 *   - legal.reviewed !== true in site.config.json
 *   - a Spanish entity without its Registro Mercantil inscription (tomo, folio,
 *     hoja), which LSSI art. 10 requires on the site
 *   - contact email not on the site's own domain (Google, AWS, DigitalOcean,
 *     Cloudflare and NVIDIA all verify the email domain against the website)
 *   - no team member with a LinkedIn profile
 * and warns when fewer than two people are listed (NVIDIA asks for two
 * distinct contacts).
 *
 * Usage: node scripts/check.js [--release] [--dist <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = process.argv.includes('--release');
const distArg = process.argv.indexOf('--dist');
const DIST = path.resolve(distArg > -1 ? process.argv[distArg + 1] : path.join(ROOT, 'dist'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`no build found in ${DIST} — run: node scripts/build.js`);
  process.exit(2);
}

const pages = fs.readdirSync(DIST).filter((f) => f.endsWith('.html'));
const html = Object.fromEntries(pages.map((f) => [f, fs.readFileSync(path.join(DIST, f), 'utf8')]));

// Words that must never appear on the product site. Matched on visible text
// and attributes alike; word-bounded so "cryptographic" would still pass.
const DENY = [
  /\bcrypto(currenc(y|ies))?\b/i, /\bdefi\b/i, /\bblockchain\b/i, /\bweb3\b/i,
  /\btoken (sale|raise)s?\b/i, /\bstaking\b/i, /\byield\b/i, /\bearn ?park\b/i,
];

const idsOf = (doc) => new Set([...doc.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const pageForPath = (p) => {
  if (p === '/' || p === '') return 'index.html';
  const name = p.replace(/^\//, '').replace(/\/$/, '');
  if (html[`${name}.html`] !== undefined) return `${name}.html`;
  if (html[name] !== undefined) return name;
  return null;
};

for (const [file, doc] of Object.entries(html)) {
  if (!/<html lang="[a-z-]+"/i.test(doc)) fail(`${file}: <html> has no lang attribute`);
  if (!/<title>[^<]{5,}<\/title>/.test(doc)) fail(`${file}: missing <title>`);
  if (!/<meta name="description" content="[^"]{20,}"/.test(doc)) fail(`${file}: missing meta description`);
  if (!/<meta name="viewport"/.test(doc)) fail(`${file}: missing viewport meta`);
  const h1 = (doc.match(/<h1[\s>]/g) || []).length;
  if (h1 !== 1) fail(`${file}: expected exactly one <h1>, found ${h1}`);
  if (!/data-legal/.test(doc)) fail(`${file}: legal footer missing`);
  if (!/href="\/privacy"/.test(doc) || !/href="\/terms"/.test(doc)) fail(`${file}: privacy/terms links missing`);

  for (const m of doc.matchAll(/<(script|link|iframe|img|video|source)\b[^>]*\s(src|href)="([^"]+)"/g)) {
    const [, tag, , url] = m;
    if (/^https?:\/\//.test(url) && !(tag === 'video' || tag === 'source')) {
      fail(`${file}: external <${tag}> ${url} — keep every asset same-origin`);
    }
  }
  for (const m of doc.matchAll(/<img\b[^>]*>/g)) {
    if (!/\salt="/.test(m[0])) fail(`${file}: <img> without alt: ${m[0]}`);
  }
  for (const m of doc.matchAll(/\shref="([^"]+)"/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|TODO)/.test(href)) continue;
    const [p, anchor] = href.split('#');
    const target = p === '' ? file : pageForPath(p);
    if (p.startsWith('/assets/')) {
      if (!fs.existsSync(path.join(DIST, p))) fail(`${file}: broken asset link ${href}`);
      continue;
    }
    if (!target) { fail(`${file}: broken link ${href}`); continue; }
    if (anchor && !anchor.startsWith('/') && !idsOf(html[target]).has(anchor) && anchor !== 'beta-thanks') {
      fail(`${file}: link ${href} points to a missing #${anchor}`);
    }
  }
  const text = doc.replace(/<script[\s\S]*?<\/script>/g, '');
  for (const re of DENY) {
    const hit = text.match(re);
    if (hit) fail(`${file}: forbidden wording "${hit[0]}" — the product site must stand on its own`);
  }
  const todos = (doc.match(/TODO/g) || []).length;
  if (todos) (RELEASE ? fail : warn)(`${file}: ${todos} TODO placeholder(s) left`);
}

const home = html['index.html'] || '';
const ids = idsOf(home);
for (const id of ['product', 'how', 'security', 'fit', 'plans', 'team', 'beta']) {
  if (!ids.has(id)) fail(`index.html: required section #${id} is missing`);
}
if (!/<form[^>]+action="\/api\/book"/.test(home)) fail('index.html: book-a-demo form must post to /api/book');
// Backbrief is presented as a commercial, managed service: no open-source,
// self-hosting or licence wording, and no links to the public kit repository.
const COMMERCIAL = [/open[- ]source/i, /self[- ]host/i, /\bMIT\b/, /github\.com\/EvgenSmith/i, /\bn8n\b/i];
for (const [file, doc] of Object.entries(html)) {
  for (const re of COMMERCIAL) {
    const hit = doc.match(re);
    if (hit) fail(`${file}: open-source or self-hosting wording "${hit[0]}" (the site presents a commercial service)`);
  }
}
for (const f of ['privacy.html', 'terms.html', 'login.html', 'assets/styles.css', 'assets/cabinet.js', '_headers', 'robots.txt']) {
  if (!fs.existsSync(path.join(DIST, f))) fail(`dist is missing ${f}`);
}

// Cabinet pages and the demo data built from site/demo-vault.
for (const page of ['demo.html', 'app.html']) {
  if (!html[page]) { fail(`dist is missing ${page}`); continue; }
  if (!/data-view/.test(html[page])) fail(`${page}: cabinet shell has no [data-view] container`);
}
const demoDir = path.join(DIST, 'demo');
try {
  const ws = JSON.parse(fs.readFileSync(path.join(demoDir, 'workspace.json'), 'utf8'));
  if (!ws.calls || ws.calls.length < 3) fail('demo workspace has fewer than 3 calls');
  for (const c of ws.calls || []) {
    if (!fs.existsSync(path.join(demoDir, 'calls', `${c.id}.json`))) fail(`demo call detail missing: ${c.id}`);
  }
  const blob = fs.readdirSync(path.join(demoDir, 'calls')).map((f) => fs.readFileSync(path.join(demoDir, 'calls', f), 'utf8')).join('\n')
    + fs.readFileSync(path.join(demoDir, 'workspace.json'), 'utf8');
  for (const re of DENY) {
    const hit = blob.match(re);
    if (hit) fail(`demo data: forbidden wording "${hit[0]}"`);
  }
} catch (e) {
  fail(`demo workspace data unreadable: ${e.message}`);
}

const team = config.team || [];
if (!team.some((p) => p.name && p.linkedin)) {
  (RELEASE ? fail : warn)('team: at least one person with a LinkedIn profile is required');
}
if (team.length < 2) warn(`team: ${team.length} person listed — NVIDIA Inception asks for two distinct contacts`);

const domainSet = typeof config.domain === 'string' && !config.domain.startsWith('TODO');
const emailSet = typeof config.contact_email === 'string' && !config.contact_email.startsWith('TODO');
if (RELEASE) {
  if (config.legal?.reviewed !== true) fail('legal.reviewed is not true — privacy policy and terms need a human legal review');
  if (config.legal?.governing_law === 'Spain' && !/hoja/i.test(config.legal?.registration || '')) {
    fail('legal.registration: add the Registro Mercantil inscription (tomo, folio, hoja B-…); LSSI art. 10 requires it on the site');
  }
  if (!domainSet) fail('domain is not set');
  if (!emailSet) fail('contact_email is not set');
  if (domainSet && emailSet && !config.contact_email.toLowerCase().endsWith(`@${config.domain.toLowerCase()}`)) {
    fail(`contact_email ${config.contact_email} is not on ${config.domain} — reviewers match email domain to the website`);
  }
  if (!fs.existsSync(path.join(DIST, 'sitemap.xml'))) fail('sitemap.xml missing (set domain and rebuild)');
}
if (!config.links || !config.links.book_demo) warn('links.book_demo is empty — step 2 of the booking form promises an email instead of showing a calendar');
for (const host of config.demo_hosts || []) {
  if (!host.photo || !fs.existsSync(path.join(DIST, host.photo))) fail(`demo_hosts: no photo for ${host.name} at ${host.photo}`);
}
if ((config.demo_hosts || []).length === 0) warn('demo_hosts is empty — the booking form shows no faces');
if (!config.demo_video_url) warn('no demo video yet (demo_video_url) — Speechmatics and OVH ask for a demo');

for (const w of warnings) console.log(`  warn  ${w}`);
for (const e of errors) console.log(`  FAIL  ${e}`);
console.log(`\ncheck${RELEASE ? ' --release' : ''}: ${pages.length} pages, ${errors.length} failure(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
