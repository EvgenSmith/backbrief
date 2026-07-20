#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * check-release-ready.js — the PUBLISH GATE for the Backbrief kit.
 *
 * Run this from the kit root BEFORE exporting the kit to its public repo
 * (see design/EXPORT.md — the maintainer release runbook). It EXITS NON-ZERO on anything that must not ship publicly,
 * so the export cannot proceed by accident:
 *
 *   1. `design/` still present   — internal working material (specs + the
 *      remediation plan). It must be stripped from the export tree.
 *   2. `EvgenSmith` literal    — the single placeholder for the real GitHub
 *      org/repo slug. Until the maintainer substitutes the real value, the
 *      quickstart is dead and the update check 404s — do not publish.
 *   3. Secret shapes / denylist   — real tokens or production coordinates
 *      (Slack/GitHub/Linear/Anthropic key shapes; the internal denylist of
 *      former-monorepo coordinates if provided).
 *   4. Internal-name leaks        — the former org name, the former working
 *      name, and `cv-` node ids (matched literal-free below so this guard is
 *      itself publishable).
 *
 * Usage:
 *   node plugin/scripts/check-release-ready.js [--root <dir>] [--denylist <file>]
 *
 *   --root      tree to check (default: the kit root, i.e. two levels up from
 *               this script). Point it at a STAGED export dir to gate the exact
 *               bundle you are about to publish.
 *   --denylist  internal denylist file (default: ../../ops/backbrief-denylist.txt
 *               relative to the kit root if it exists; skipped if absent — a
 *               public clone will not have it, which is correct).
 *
 * Exit: 0 = ready to publish · 1 = blockers found · 2 = operational error.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// The org placeholder token, assembled from parts so this guard file never
// contains the bare literal — otherwise the EXPORT.md substitution (a blanket
// sed over the tree) would rewrite the guard's own check and break it.
const ORG_TOKEN = 'BACKBRIEF' + '_ORG';

const KIT_ROOT = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(arg('--root', KIT_ROOT));
const DEFAULT_DENY = path.resolve(KIT_ROOT, '..', '..', 'ops', 'backbrief-denylist.txt');
const _deny = arg('--denylist', fs.existsSync(DEFAULT_DENY) ? DEFAULT_DENY : '');
const DENYLIST = _deny ? path.resolve(_deny) : ''; // absolute — sanitize-check resolves relative to its scan root otherwise

const blockers = [];
const notes = [];

// ── 1. design/ must be gone ────────────────────────────────────────────────
if (fs.existsSync(path.join(ROOT, 'design'))) {
  blockers.push('design/ is present in the export tree — strip it before publishing (it holds internal specs + the remediation plan).');
} else {
  notes.push('design/ absent ✓');
}

// Walk the tree once, collecting text files (skip .git, node_modules, binaries).
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TEXT_EXT = /\.(js|ts|json|md|ya?ml|txt|sh|toml|example|gitignore|vault)$/i;
function walk(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.git')) continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(fp, acc);
    else if (TEXT_EXT.test(ent.name) || ent.name === 'LICENSE' || ent.name === 'VERSION') acc.push(fp);
  }
  return acc;
}
const files = walk(ROOT, []);
const self = path.resolve(__filename);

// ── 2. EvgenSmith placeholder ───────────────────────────────────────────
const orgHits = [];
for (const f of files) {
  if (f === self) continue; // the guard assembles the token from parts; never a real hit
  const txt = fs.readFileSync(f, 'utf8');
  if (txt.includes(ORG_TOKEN)) orgHits.push(path.relative(ROOT, f));
}
if (orgHits.length) {
  blockers.push(`${ORG_TOKEN} placeholder still present in ${orgHits.length} file(s) — substitute the real org/repo slug first:\n    ${orgHits.slice(0, 12).join('\n    ')}${orgHits.length > 12 ? `\n    … +${orgHits.length - 12} more` : ''}`);
} else {
  notes.push(`${ORG_TOKEN} substituted ✓`);
}

// ── 2b. Malformed substitution (org token replaced with org/repo) ──────────
// The token stands for the ORG ONLY — every URL already spells the repo name
// (`github.com/<token>/backbrief`). Substituting `org/backbrief` for the token
// produces the triple segment `<org>/backbrief/backbrief`: a dead clone URL no
// real org can fix. Matched as three segments; a legit org literally named
// after the repo stays out of the net (`github.com/backbrief/backbrief` — dot
// lookbehind; `api.github.com/repos/backbrief/backbrief/…` — `repos` is API
// structure, not an org). Pattern assembled from parts to never self-hit.
const REPO_NAME = 'back' + 'brief';
const DOUBLE_SEG = new RegExp(
  '(?<![.A-Za-z0-9-])(?!repos\\/)[A-Za-z0-9-]+\\/' + REPO_NAME + '\\/' + REPO_NAME + '(?![A-Za-z0-9-])', 'i');
const doubleHits = [];
for (const f of files) {
  if (f === self) continue;
  const txt = fs.readFileSync(f, 'utf8');
  if (DOUBLE_SEG.test(txt)) doubleHits.push(path.relative(ROOT, f));
}
if (doubleHits.length) {
  blockers.push(`malformed slug '<org>/${REPO_NAME}/${REPO_NAME}' in ${doubleHits.length} file(s) — the ${ORG_TOKEN} substitution must be the ORG ONLY (URLs already carry the repo name):\n    ${doubleHits.slice(0, 12).join('\n    ')}`);
} else {
  notes.push('no malformed org/repo substitution ✓');
}

// ── 3. Secret shapes + internal-name leaks ─────────────────────────────────
const SHAPES = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['slack-token', /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ['github-pat', /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/],
  ['linear-key', /lin_api_[A-Za-z0-9]{10,}/],
  ['gcp-key', /AIza[0-9A-Za-z_-]{30,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
// Patterns assembled from parts so this guard contains no bare internal
// literal — it is meant to ship and self-scan cleanly.
const NAME_LEAKS = [
  ['former-org-name', new RegExp('earn' + 'park', 'i')],
  ['former-working-name', new RegExp('call' + 'vault', 'i')],
  ['legacy-node-id', /"cv-[a-z0-9-]+"/],
];
const leakHits = [];
for (const f of files) {
  if (f === self) continue;
  const rel = path.relative(ROOT, f);
  const txt = fs.readFileSync(f, 'utf8');
  for (const [name, re] of SHAPES) if (re.test(txt)) leakHits.push(`${name} shape in ${rel}`);
  for (const [name, re] of NAME_LEAKS) {
    // allow the literal inside the release guard's own doc and license churn note
    if (re.test(txt)) leakHits.push(`${name} in ${rel}`);
  }
}
if (leakHits.length) {
  blockers.push(`Secret shapes / internal-name leaks:\n    ${[...new Set(leakHits)].slice(0, 20).join('\n    ')}`);
} else {
  notes.push('no secret shapes / no internal-name leaks ✓');
}

// ── 4. Denylist scan (internal coordinates), if the file is available ──────
if (DENYLIST && fs.existsSync(DENYLIST)) {
  try {
    execFileSync('bash', [
      path.join(ROOT, 'plugin/scripts/sanitize-check.sh'),
      '--denylist-only', '--denylist', DENYLIST, ROOT,
    ], { stdio: 'pipe' });
    notes.push(`denylist scan clean (${path.relative(process.cwd(), DENYLIST)}) ✓`);
  } catch (e) {
    const out = (e.stdout || e.stderr || Buffer.from('')).toString();
    blockers.push(`denylist scan FAILED (production coordinates present):\n    ${out.trim().split('\n').slice(0, 20).join('\n    ')}`);
  }
} else {
  notes.push('denylist not supplied — generic checks only (a public clone correctly has no internal denylist)');
}

// ── Verdict ────────────────────────────────────────────────────────────────
console.log(`check-release-ready — scanned ${files.length} files under ${ROOT}\n`);
for (const n of notes) console.log(`  ok   ${n}`);
if (blockers.length) {
  console.log('');
  for (const b of blockers) console.log(`  ✗ ${b}`);
  console.log(`\nNOT READY TO PUBLISH — ${blockers.length} blocker(s). See design/EXPORT.md.`);
  process.exit(1);
}
console.log('\nREADY TO PUBLISH ✓');
process.exit(0);
