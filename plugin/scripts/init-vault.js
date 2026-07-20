#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * init-vault.js — Backbrief A0: create the vault skeleton + minimal tenant.yaml
 * from plugin/templates/.
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies,
 * `--help`, DRY_RUN=1 honored wherever a write happens,
 * exit codes: 0 ok / 1 check failed / 2 operational error.
 *
 * Behavior contract:
 *   - CREATE-IF-MISSING, idempotent: existing files are NEVER overwritten
 *     (re-running only adds missing pieces — safe by construction, 01 §1.5).
 *   - tenant.yaml is born MINIMAL here (tenant name, languages, teams,
 *     telemetry consent + install_id-at-consent) and completed at B1 by
 *     generate-tenant.js (02 §2.1). No secrets, ever.
 *   - Team folders come from --teams (the A0 survey Q4); default is the
 *     `general` mixed route only (01 §2.1 A0.6). Golden-path skeleton team
 *     folders (product/engineering/growth) are created only when requested.
 *   - No privacy routing in v0.1 (owner decision, 2026-07-11): every call
 *     files into team folders; no private/ slices are created and no
 *     sensitivity config is written. Demand is captured via the waitlist
 *     (interest: privacy).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DRY_RUN = process.env.DRY_RUN === '1';
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const SKELETON_DIR = path.join(TEMPLATES_DIR, 'vault-skeleton');

// Single source for the kit-repo link rendered into vault files (<KitRepoURL>
// token). EvgenSmith is the pre-release org placeholder — the release
// checklist swaps it kit-wide (one constant here keeps the vault README in
// sync with whatever this kit's origin becomes).
const REPO_URL = 'https://github.com/EvgenSmith/backbrief';

// Root names the skeleton owns — can never be team tags/folders (a team named
// "team" would collide with the people-profiles folder; validate-tenant.js
// enforces the same list as check S8). "private" stays reserved even though
// v0.1 ships no private/ tree: the privacy-routing feature will claim it.
const RESERVED_ROOT_NAMES = ['team', 'tasks', 'docs', 'private', 'pipeline', '.backbrief'];

const HELP = `init-vault.js — create the Backbrief vault skeleton + minimal tenant.yaml (step A0)

Usage:
  node init-vault.js <path> [options]

Options:
  --company <name>          tenant display name (default: derived from <path>
                            basename, "-vault" suffix stripped, title-cased)
  --persona <p>             whose calls the vault holds (A0 survey Q2):
                            solo | team_lead | company_lead (default:
                            company_lead). Recorded as tenant.persona; the
                            persona shapes the survey and the team-folder
                            layout (solo: no team folders — general/ only)
  --teams <tag,tag,...>     team folders to create (lowercase tags; default:
                            none — the vault starts with the general/ mixed
                            route only, teams are added as they emerge)
  --languages <xx,yy>       ISO 639-1 tenant languages (default: en)
  --timezone <tz>           tenant timezone for filenames (default: UTC)
  --internal-domains <d,d>  company email domains (external-participant
                            detection; default: empty, completed at B1)
  --telemetry <yes|no>      A0 consent answer (default: no — consent can never
                            default to yes; yes also generates install_id)
  -h, --help                this text

Environment:
  DRY_RUN=1                 print what would be created, write nothing

Behavior:
  Create-if-missing and idempotent: re-running never overwrites an existing
  file (tenant.yaml, AGENTS.md, README.md, .gitignore included) — it only adds
  what is missing and reports each path as "created" or "exists".

Examples:
  node init-vault.js ./acme-vault --company "Acme Robotics" --telemetry no
  node init-vault.js ./acme-vault --teams product,growth --languages en,ru
  node init-vault.js ./my-vault --persona solo

Exit codes: 0 ok / 1 check failed (bad arguments) / 2 operational error`;

/* ------------------------------------------------------------------ */
/* CLI parsing                                                         */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    path: null, company: null, persona: 'company_lead', teams: [], languages: ['en'],
    timezone: 'UTC', internalDomains: [], telemetry: false, help: false,
  };
  const takes = {
    '--company': 'company', '--persona': 'persona', '--teams': 'teams',
    '--languages': 'languages', '--timezone': 'timezone',
    '--internal-domains': 'internalDomains', '--telemetry': 'telemetry',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (takes[a]) {
      const v = argv[++i];
      if (v === undefined) { console.error(`✖ ${a} needs a value (see --help)`); process.exit(1); }
      if (a === '--teams' || a === '--languages' || a === '--internal-domains') {
        opts[takes[a]] = v.split(',').map((s) => s.trim()).filter(Boolean);
      } else if (a === '--telemetry') {
        if (!['yes', 'no', 'true', 'false'].includes(v)) {
          console.error('✖ --telemetry takes yes|no'); process.exit(1);
        }
        opts.telemetry = v === 'yes' || v === 'true';
      } else opts[takes[a]] = v;
      continue;
    }
    if (a.startsWith('-')) { console.error(`✖ unknown option: ${a} (see --help)`); process.exit(1); }
    if (opts.path) { console.error('✖ exactly one <path> argument (see --help)'); process.exit(1); }
    opts.path = a;
  }
  return opts;
}

function validateOpts(opts) {
  const problems = [];
  if (!['solo', 'team_lead', 'company_lead'].includes(opts.persona)) {
    problems.push(`persona "${opts.persona}" must be one of: solo, team_lead, company_lead`);
  }
  for (const t of opts.teams) {
    if (!/^[a-z0-9-]+$/.test(t)) problems.push(`team tag "${t}" must be lowercase [a-z0-9-]`);
    if (RESERVED_ROOT_NAMES.includes(t)) {
      problems.push(`team tag "${t}" is a reserved root name (${RESERVED_ROOT_NAMES.join(', ')}) — ` +
        'the vault skeleton owns that folder; pick another tag');
    }
  }
  for (const l of opts.languages) {
    if (!/^[a-z]{2}$/.test(l)) problems.push(`language "${l}" must be a 2-letter ISO 639-1 code`);
  }
  for (const d of opts.internalDomains) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) problems.push(`domain "${d}" does not look like a domain`);
  }
  if (opts.teams.includes('general')) {
    // general is the mixed route, always created — listing it as a team is fine, dedupe silently
    opts.teams = opts.teams.filter((t) => t !== 'general');
  }
  return problems;
}

function deriveCompany(vaultPath) {
  const base = path.basename(path.resolve(vaultPath)).replace(/-vault$/i, '');
  return base.split(/[-_ ]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'My Company';
}

/* ------------------------------------------------------------------ */
/* File operations (create-if-missing; DRY_RUN aware)                  */
/* ------------------------------------------------------------------ */

const report = { created: [], existing: [] };

function ensureDir(dir) {
  if (fs.existsSync(dir)) return;
  if (!DRY_RUN) fs.mkdirSync(dir, { recursive: true });
}

function writeIfMissing(dest, content) {
  if (fs.existsSync(dest)) { report.existing.push(dest); return; }
  if (!DRY_RUN) {
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, content);
  }
  report.created.push(dest);
}

function copyIfMissing(src, dest) {
  writeIfMissing(dest, fs.existsSync(src) ? fs.readFileSync(src) : '');
}

function copyTreeIfMissing(srcDir, destDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyTreeIfMissing(src, dest);
    else copyIfMissing(src, dest);
  }
}

/* ------------------------------------------------------------------ */
/* Template rendering                                                  */
/* ------------------------------------------------------------------ */

// Strip the leading template-metadata HTML comment (build-time notes, not for
// the rendered vault) and substitute the tokens init-vault.js owns.
function renderTemplate(text, company, hasOwner) {
  let out = text;
  if (out.startsWith('<!--')) {
    const end = out.indexOf('-->');
    if (end >= 0) out = out.slice(end + 3).replace(/^\s*\n/, '');
  }
  out = out.replace(/<Company>/g, company);
  out = out.replace(/<KitRepoURL>/g, REPO_URL);
  if (!hasOwner) {
    // Owner is unknown at A0 (roster fills at A2/B1) — drop the owner mention,
    // keep the rest of the line (template contract: vault-skeleton/README.md).
    out = out.replace(/\*\*Owner:\*\* <Owner-Lastname>\.\s*/g, '');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Minimal tenant.yaml (born at A0, completed at B1 — 02 §2.1)         */
/* ------------------------------------------------------------------ */

function yamlSingleQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function buildTenantYaml(opts, company, installId) {
  const teams = opts.teams.length
    ? opts.teams
    : []; // no named teams yet: general/ (mixed route) carries everything
  const teamBlock = teams.length
    ? teams.map((t) => [
      `    - tag: ${t}`,
      `      folder: ${t}`,
      '      description: ""            # one line for the classifier: what this team does',
    ].join('\n')).join('\n')
    : [
      '    # No teams named yet — the general/ mixed route carries everything.',
      '    # Add entries as teams emerge, then re-run validate-vault.js --fix:',
      '    #   - tag: product',
      '    #     folder: product',
      '    #     description: "What this team does (one line for the classifier)"',
      '    - tag: general',
      '      folder: general',
      '      description: "Cross-team and general calls (default route)"',
    ].join('\n');

  const domains = opts.internalDomains.length
    ? `[${opts.internalDomains.join(', ')}]`
    : '[]                # completed at B1 — external-participant detection needs these';

  const telemetryBlock = [
    '  telemetry:',
    `    enabled: ${opts.telemetry}       # OPT-IN, asked once at A0; false = zero outbound calls`,
    '    endpoint: https://backbrief-telemetry.backbrief.workers.dev',
  ];
  if (opts.telemetry && installId) {
    telemetryBlock.push(`    install_id: ${installId}   # random UUIDv4, generated locally at consent`);
  }

  return [
    '# =============================================================================',
    `# ${company} — Backbrief tenant configuration`,
    '# Born minimal at A0 (init-vault.js); completed at B1 (generate-tenant.js).',
    '# Schema: plugin/templates/tenant.schema.json (schema_version: 1)',
    '# Edit by conversation with your agent (it shows a diff before writing) or by',
    '# hand; validate with: node plugin/scripts/validate-tenant.js',
    '#',
    '# *** NO SECRETS EVER *** — tokens and API keys live in .backbrief/secrets.env',
    '# (gitignored), never here. The validator hard-fails on token-shaped values.',
    '# =============================================================================',
    '',
    'schema_version: 1',
    '',
    'tenant:',
    `  name: ${/[:#]/.test(company) ? yamlSingleQuote(company) : company}`,
    `  persona: ${opts.persona}       # whose calls the vault holds (A0 fork): solo | team_lead | company_lead`,
    `  internal_domains: ${domains}`,
    `  languages: [${opts.languages.join(', ')}]`,
    `  timezone: ${opts.timezone}`,
    '',
    'vault:',
    '  repo: null                    # set at B4 (GitHub vault sync); local-only until then',
    '  branch: main',
    '  teams:',
    teamBlock,
    '  mixed_folder: general         # route when a call spans teams / team unresolved',
    '',
    'roster: []                      # filled at A2 (profiles) / B1 (generate-tenant.js)',
    '',
    '# Privacy routing (auto-routing 1:1/board/legal calls into private slices) is',
    '# deliberately NOT part of v0.1 — every call files into team folders. Need it?',
    '# Say so: waitlist interest "privacy".',
    '',
    'features:',
    '  raw_retention: vtt            # none = digest .md only | vtt = .vtt sibling committed',
    telemetryBlock.join('\n'),
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Skeleton assembly                                                   */
/* ------------------------------------------------------------------ */

function generatedTeamReadme(tag) {
  return `# ${tag}/ — ${tag} team calls\n\nTeam folder (tenant.yaml \`vault.teams[]\`). Calls land in \`transcripts/\`; add\nsubfolders (\`decisions/\`, \`docs/\`, \`research/\`) only the day the first file\nneeds them.\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }
  if (!opts.path) { console.log(HELP); process.exit(2); }
  const problems = validateOpts(opts);
  if (problems.length) {
    console.error(`✖ ${problems.join('\n✖ ')}`);
    process.exit(1);
  }
  if (!fs.existsSync(SKELETON_DIR)) {
    console.error(`✖ templates not found at ${SKELETON_DIR} — is the plugin installed intact?`);
    process.exit(2);
  }

  const vault = path.resolve(opts.path);
  const company = opts.company || deriveCompany(vault);

  // Which top-level skeleton dirs are optional golden-path team folders?
  // (any dir with a transcripts/ child, except the always-created general/)
  const skeletonTeamDirs = fs.readdirSync(SKELETON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'general' && !e.name.startsWith('.')
      && fs.existsSync(path.join(SKELETON_DIR, e.name, 'transcripts')))
    .map((e) => e.name);

  try {
    ensureDir(vault);

    // 1. Fixed skeleton parts (always): everything except optional team dirs.
    for (const entry of fs.readdirSync(SKELETON_DIR, { withFileTypes: true })) {
      if (skeletonTeamDirs.includes(entry.name)) continue;
      const src = path.join(SKELETON_DIR, entry.name);
      const dest = path.join(vault, entry.name);
      if (entry.isDirectory()) { copyTreeIfMissing(src, dest); continue; }
      if (entry.name === 'AGENTS.md' || entry.name === 'README.md') {
        writeIfMissing(dest, renderTemplate(fs.readFileSync(src, 'utf8'), company, false));
      } else {
        copyIfMissing(src, dest);
      }
    }

    // 1b. Machine-readable half of the conventions: frontmatter templates +
    //     controlled vocabulary are copied INTO the vault (docs/templates/) so
    //     the team's own agents inherit the full contract with no Backbrief
    //     plugin installed ("delete the plugin tomorrow — the vault remains
    //     self-describing"). docs/conventions.md ships with the skeleton above.
    const frontmatterSrc = path.join(TEMPLATES_DIR, 'frontmatter');
    if (fs.existsSync(frontmatterSrc)) {
      copyTreeIfMissing(frontmatterSrc, path.join(vault, 'docs', 'templates'));
    }

    // 2. Requested team folders (survey Q4). Skeleton versions when available,
    //    generated one-line README + transcripts/ otherwise.
    for (const tag of opts.teams) {
      const dest = path.join(vault, tag);
      if (skeletonTeamDirs.includes(tag)) {
        copyTreeIfMissing(path.join(SKELETON_DIR, tag), dest);
      } else {
        writeIfMissing(path.join(dest, 'README.md'), generatedTeamReadme(tag));
        writeIfMissing(path.join(dest, 'transcripts', '.gitkeep'), '');
      }
    }

    // 3. .gitignore from the shipped template.
    const gitignoreSrc = path.join(TEMPLATES_DIR, 'gitignore.vault');
    if (fs.existsSync(gitignoreSrc)) {
      writeIfMissing(path.join(vault, '.gitignore'), fs.readFileSync(gitignoreSrc, 'utf8'));
    }

    // 4. Minimal tenant.yaml (create-if-missing — never clobber a real config).
    const installId = opts.telemetry ? crypto.randomUUID() : null;
    writeIfMissing(path.join(vault, 'tenant.yaml'), buildTenantYaml(opts, company, installId));
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(2);
  }

  const rel = (p) => path.relative(process.cwd(), p) || '.';
  const prefix = DRY_RUN ? '[dry-run] would create' : '✔ created';
  for (const p of report.created) console.log(`${prefix}  ${rel(p)}`);
  for (const p of report.existing) console.log(`• exists (left untouched)  ${rel(p)}`);
  console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}vault ${report.created.length ? 'ready' : 'already complete'} at ${rel(vault)} — ` +
    `${report.created.length} created, ${report.existing.length} already present.`);
  console.log('Next: read AGENTS.md (the rules) + docs/conventions.md (grammar + why); ' +
    'file transcripts with /backbrief start (step A1).');
  process.exit(0);
}

main();
