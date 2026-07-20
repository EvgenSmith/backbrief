#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * generate-tenant.js — complete the A0-born tenant.yaml at B1 (01 §6 B1, 02 §3).
 *
 * tenant.yaml lifecycle: born minimal at A0 (init-vault.js), completed here at
 * B1 from facts Phase A already gathered — NO new user questions:
 *
 *   - roster              <- team/<Lastname>.md profiles (frontmatter: lastname,
 *                            first_names, aliases, role, team, email,
 *                            slack_user_id, tracker_handle). Profiles are the
 *                            SSOT for a person: new lastnames are appended and
 *                            existing entries get a field-level merge (alias
 *                            union + fill-empty scalars — hand-edited roster
 *                            values still win).
 *   - vault.teams         <- vault folders that contain a transcripts/ subdir
 *                            (skeleton-owned roots and the mixed folder excluded)
 *   - tenant.internal_domains <- roster email domains (when not already set)
 *   - tenant.persona      <- .backbrief/state.yaml persona (A0) — only when the
 *                            tenant is silent; never defaulted retroactively
 *   - tenant.about        <- docs/company.md "What <Company> does" section
 *                            (vault.company_profile_path), when absent
 *   - features.tracker.kind   <- .backbrief/state.yaml stack.tracker (A0/A3)
 *   - the WHOLE stack map is consumed (not just tracker): chat != slack flips
 *     features.slack.enabled off; git != github keeps vault.repo null;
 *     calls != zoom prints a B2-is-waitlist-territory note — each note names
 *     the waitlist slug so deploy stops re-pitching rejected tools
 *   - feature flags + llm + pipeline.knobs <- golden-path defaults (02 §2.4),
 *                            only where the key is absent
 *
 * MERGE RULE: existing tenant.yaml values ALWAYS win. This script only fills
 * gaps — re-running it never clobbers user edits (idempotency, 01 §1.5).
 * Exceptions: roster append + field-level fill-empty merge described above.
 *
 * It always prints a diff before writing (B1 contract); DRY_RUN=1 or
 * --dry-run previews without writing. Run validate-tenant.js after every
 * write — this script generates, the validator judges.
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies, --help,
 * DRY_RUN=1 honored, exit codes 0 ok / 1 check failed / 2 operational error.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KIT_ROOT = path.join(__dirname, '..', '..');
const RENDER = require(path.join(KIT_ROOT, 'pipeline', 'tenant-render.js'));

const DRY_RUN = process.env.DRY_RUN === '1';

const HELP = `generate-tenant.js — complete the A0-born tenant.yaml from Phase-A facts (B1)

Usage:
  node plugin/scripts/generate-tenant.js [--vault <path>] [options]

Options:
  --vault <path>    vault root (default: $BACKBRIEF_VAULT, else walk up looking
                    for tenant.yaml). tenant.yaml must already exist (A0 creates it).
  --tenant <path>   explicit tenant.yaml path (overrides --vault discovery)
  --dry-run         show the diff, write nothing (same as DRY_RUN=1)
  -h, --help        this text

What it fills (existing values always win — gaps only):
  roster from team/*.md profiles (append + alias-union/fill-empty merge),
  vault.teams from the folder layout, internal_domains from roster emails,
  persona + the whole stack map from state.yaml (tracker kind; chat/calls/git
  recognition flags + notes), tenant.about from docs/company.md,
  golden-path defaults for features/llm/pipeline knobs (02 §2.4).

It never writes secrets, never invents lastnames, and always shows a diff
before writing. Follow with: node plugin/scripts/validate-tenant.js

Exit codes: 0 ok (incl. "no changes needed") / 1 check failed / 2 error`;

/* ------------------------------------------------------------------ */
/* CLI + discovery                                                     */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = { vault: null, tenant: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') o.vault = argv[++i];
    else if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown option: ${a} (see --help)`); process.exit(2); }
  }
  return o;
}

function findVaultRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.BACKBRIEF_VAULT) return path.resolve(process.env.BACKBRIEF_VAULT);
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'tenant.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/* ------------------------------------------------------------------ */
/* Frontmatter reader for team/<Lastname>.md (lenient, read-only)      */
/* ------------------------------------------------------------------ */

function parseFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const doc = {};
  let currentListKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const list = line.match(/^\s+-\s+(.*)$/);
    if (list && currentListKey) {
      doc[currentListKey].push(unquote(list[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val === '') { doc[key] = []; currentListKey = key; continue; }
    currentListKey = null;
    if (val.startsWith('[') && val.endsWith(']')) {
      doc[key] = val.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      doc[key] = unquote(val);
    }
  }
  return doc;
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function readProfiles(vaultRoot, profilesFolder) {
  const dir = path.join(vaultRoot, profilesFolder);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.md') || /^readme\.md$/i.test(f)) continue;
    let fm;
    try { fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { continue; }
    if (!fm || fm.type !== 'member' || !fm.lastname) continue;
    out.push({ file: f, fm });
  }
  return out;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function profileToRosterEntry(fm) {
  const entry = { lastname: String(fm.lastname) };
  if (Array.isArray(fm.first_names) && fm.first_names.length) entry.first_name = String(fm.first_names[0]);
  // Email: the profile's explicit `email:` field wins; the legacy
  // email-shaped-tracker_handle heuristic stays as a fallback only.
  if (typeof fm.email === 'string' && EMAIL_RE.test(fm.email)) {
    entry.email = fm.email;
  } else {
    const handle = typeof fm.tracker_handle === 'string' ? fm.tracker_handle : '';
    if (EMAIL_RE.test(handle)) entry.email = handle;
  }
  if (fm.role) entry.role = String(fm.role);
  // home_team <- profile `team:` — the tracker team key that feeds
  // USER_HOME_TEAM / LASTNAME_TO_TEAM. Lowercase tag, same shape as
  // vault.teams tags (tenant.schema.json: ^[a-z0-9-]+$); anything that
  // does not normalize to a tag is dropped, never invented.
  if (typeof fm.team === 'string' && fm.team.trim()) {
    const tag = fm.team.trim().toLowerCase();
    if (/^[a-z0-9-]+$/.test(tag)) entry.home_team = tag;
  }
  if (Array.isArray(fm.aliases) && fm.aliases.length) entry.aliases = fm.aliases.map(String);
  if (fm.slack_user_id && !/X{3,}/.test(String(fm.slack_user_id))) {
    entry.slack_user_id = String(fm.slack_user_id);
  }
  return entry;
}

/* ------------------------------------------------------------------ */
/* Vault layout -> teams                                               */
/* ------------------------------------------------------------------ */

function scanTeamFolders(vaultRoot, opts) {
  const skip = new Set(['private', '.backbrief', '.git', 'tasks',
    opts.profilesFolder, opts.mixedFolder, 'docs', 'pipeline', 'node_modules']);
  const teams = [];
  for (const name of fs.readdirSync(vaultRoot).sort()) {
    if (skip.has(name) || name.startsWith('.')) continue;
    const dir = path.join(vaultRoot, name);
    let stat;
    try { stat = fs.statSync(dir); } catch (e) { continue; }
    if (!stat.isDirectory()) continue;
    if (fs.existsSync(path.join(dir, 'transcripts'))) {
      teams.push({ tag: name, folder: name });
    }
  }
  return teams;
}

/* ------------------------------------------------------------------ */
/* state.yaml (lenient read of the stack map only)                     */
/* ------------------------------------------------------------------ */

function readStackFromState(vaultRoot) {
  const file = path.join(vaultRoot, '.backbrief', 'state.yaml');
  if (!fs.existsSync(file)) return {};
  const stack = {};
  let inStack = false;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^stack:\s*$/.test(line)) { inStack = true; continue; }
    if (inStack) {
      const m = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/);
      if (m) { stack[m[1]] = unquote(m[2].trim()); continue; }
      if (/^\S/.test(line)) inStack = false;
    }
    const flow = line.match(/^stack:\s*\{(.+)\}\s*$/);
    if (flow) {
      for (const part of flow[1].split(',')) {
        const kv = part.split(':');
        if (kv.length === 2) stack[unquote(kv[0].trim())] = unquote(kv[1].trim());
      }
    }
  }
  return stack;
}

// Lenient read of one top-level scalar key from state.yaml (e.g. persona).
function readStateScalar(vaultRoot, key) {
  const file = path.join(vaultRoot, '.backbrief', 'state.yaml');
  if (!fs.existsSync(file)) return null;
  const re = new RegExp(`^${key}\\s*:\\s*(.+)$`);
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.replace(/\s+#.*$/, '').match(re);
    if (m) return unquote(m[1].trim());
  }
  return null;
}

function toolSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

// docs/company.md -> tenant.about: the first prose lines of the
// "## What <Company> does" section (inference suffixes stripped, size-capped).
function readCompanyAbout(companyPath) {
  if (!fs.existsSync(companyPath)) return null;
  let text;
  try { text = fs.readFileSync(companyPath, 'utf8'); } catch (e) { return null; }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+What\s+/i.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^##\s/.test(l)) break;
    if (!l || l === 'None.' || l.startsWith('<!--')) continue;
    out.push(l.replace(/\s*\(inferred[^)]*\)\s*/gi, ' ').replace(/\s+/g, ' ')
      .replace(/\s+([.,;:!?])/g, '$1').trim());
    if (out.length >= 3) break;
  }
  const about = out.join(' ').trim();
  if (!about) return null;
  return about.length > 300 ? `${about.slice(0, 297)}…` : about;
}

/* ------------------------------------------------------------------ */
/* Golden-path defaults (02 §2.4 — mirror of tenant.yaml.example)      */
/* ------------------------------------------------------------------ */

function goldenDefaults() {
  return {
    schema_version: 1,
    tenant: {
      // name/internal_domains are A0 facts — never defaulted here.
      languages: ['en'],
      primary_language: 'en',
      timezone: 'UTC',
    },
    vault: {
      repo: null,
      branch: 'main',
      teams: [],
      mixed_folder: 'general',
      profiles_folder: 'team',
      summarizer_skill_path: 'docs/skills/summarizer.md',
      company_profile_path: 'docs/company.md',
      dlq_folder: 'pipeline/dlq',
      training_data_path: '.backbrief/training/feedback.jsonl',
    },
    roster: [],
    // No sensitivity/private-slice defaults: privacy routing is not in v0.1
    // (owner decision, 2026-07-11) — every call files into team folders.
    features: {
      slack: { enabled: true, digest_channel: '#call-digests' },
      raw_retention: 'vtt',
      drive: { enabled: false, domain_restricted: true },
      tracker: {
        enabled: true,
        kind: 'linear',
        team_mapping: [],
        provenance_label: 'from-call',
        autonomy_level: 'L0',
        thresholds: {
          comment: 0.75, flag_discovery: 0.55, flag_planning: 0.35,
          dedup_confirmed_days: 14, dedup_pending_hours: 48,
        },
      },
      history_import: { enabled: false, days: 30 },
      telemetry: { enabled: false, endpoint: 'https://backbrief-telemetry.backbrief.workers.dev' },
    },
    llm: {
      summarizer: { model: 'claude-sonnet-4-6', max_tokens: 16384 },
      normalizer: { model: 'claude-sonnet-4-6', max_tokens: 8192 },
      matcher: { model: 'claude-opus-4-8', max_tokens: 32000, thinking: 'adaptive', effort: 'high' },
      composer: { model: 'claude-haiku-4-5', max_tokens: 8192 },
      feedback: { model: 'claude-sonnet-4-6', max_tokens: 4096 },
    },
    pipeline: {
      knobs: {
        min_duration_min: 5,
        replay_window_sec: 900,
        transcript_char_cap: 60000,
        vault_cache_ttl_listing_h: 1,
        vault_cache_ttl_file_h: 12,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Merge: existing values win; defaults fill gaps                      */
/* ------------------------------------------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `fill` INTO `base`: base's values are preserved; keys missing in
// base come from fill. Arrays are atomic (base wins when present).
function fillGaps(base, fill) {
  if (base === undefined) return clone(fill);
  if (!isPlainObject(base) || !isPlainObject(fill)) return clone(base);
  const out = {};
  for (const key of [...Object.keys(fill), ...Object.keys(base)]) {
    if (key in out) continue;
    if (key in base && key in fill) out[key] = fillGaps(base[key], fill[key]);
    else if (key in base) out[key] = clone(base[key]);
    else out[key] = clone(fill[key]);
  }
  return out;
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/* ------------------------------------------------------------------ */
/* YAML emitter (comment-annotated top-level sections)                 */
/* ------------------------------------------------------------------ */

function needsQuote(s) {
  return s === '' || /^[\s'"#&*\[\]{}>|%@`!,?:-]/.test(s) || /[:#]\s|\s$/.test(s) ||
    /^(true|false|null|Null|NULL|~|True|False)$/.test(s) ||
    /^[+-]?(\d+|\d*\.\d+)([eE][+-]?\d+)?$/.test(s) || /[\\\n\t]/.test(s);
}

function scalarToYaml(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return needsQuote(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

function toYaml(value, indent) {
  indent = indent || 0;
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        const body = toYaml(item, indent + 2);
        return `${pad}-${body.slice(indent + 1)}`;
      }
      return `${pad}- ${scalarToYaml(item)}`;
    }).join('\n');
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return `${pad}{}`;
    return keys.map((k) => {
      const v = value[k];
      const key = needsQuote(k) ? `'${k.replace(/'/g, "''")}'` : k;
      if (Array.isArray(v)) {
        if (!v.length) return `${pad}${key}: []`;
        return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
      }
      if (isPlainObject(v)) {
        if (!Object.keys(v).length) return `${pad}${key}: {}`;
        return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
      }
      return `${pad}${key}: ${scalarToYaml(v)}`;
    }).join('\n');
  }
  return pad + scalarToYaml(value);
}

const SECTION_COMMENTS = {
  tenant: 'company identity — name, domains, languages, timezone',
  vault: 'vault layout: repo coordinates, team taxonomy',
  roster: 'one entry per person; lastname is THE canonical token everywhere',
  glossary: 'ASR mis-hearings -> canonical spelling',
  extraction: 'voice directives and extraction knobs',
  features: 'component flags — one enabled boolean each; skips set these',
  llm: 'BYO Anthropic models per stage; test-creds.js anthropic probes them',
  pipeline: 'scalar knobs — prod-proven defaults, change with care',
};

function emitTenantYaml(doc) {
  const order = ['schema_version', 'tenant', 'vault', 'roster', 'glossary',
    'extraction', 'features', 'llm', 'pipeline'];
  const keys = [...order.filter((k) => k in doc), ...Object.keys(doc).filter((k) => !order.includes(k))];
  const parts = [
    '# =============================================================================',
    '# Backbrief tenant configuration — completed at B1 by generate-tenant.js.',
    '# Schema: plugin/templates/tenant.schema.json (schema_version: 1).',
    '# Edit by hand or by conversation; validate-tenant.js runs before every deploy.',
    '# *** NO SECRETS EVER *** — tokens live in .backbrief/secrets.env (gitignored).',
    '# =============================================================================',
    '',
  ];
  for (const k of keys) {
    if (doc[k] === undefined) continue;
    if (SECTION_COMMENTS[k]) parts.push(`# ${SECTION_COMMENTS[k]}`);
    const v = doc[k];
    if (isPlainObject(v) || Array.isArray(v)) {
      if (isPlainObject(v) && !Object.keys(v).length) parts.push(`${k}: {}`);
      else if (Array.isArray(v) && !v.length) parts.push(`${k}: []`);
      else parts.push(`${k}:\n${toYaml(v, 2)}`);
    } else {
      parts.push(`${k}: ${scalarToYaml(v)}`);
    }
    parts.push('');
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ------------------------------------------------------------------ */
/* Line diff (plain LCS — files are small)                             */
/* ------------------------------------------------------------------ */

function diffLines(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  // DP LCS table (n,m are a few hundred at most).
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', line: a[i] }); i++; }
    else { out.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', line: a[i++] });
  while (j < m) out.push({ t: '+', line: b[j++] });
  return out;
}

function printDiff(ops) {
  const CTX = 2;
  const keep = new Set();
  ops.forEach((op, idx) => {
    if (op.t !== ' ') {
      for (let k = Math.max(0, idx - CTX); k <= Math.min(ops.length - 1, idx + CTX); k++) keep.add(k);
    }
  });
  let lastPrinted = -2;
  let changes = 0;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!keep.has(idx)) continue;
    if (idx > lastPrinted + 1) console.log('  ...');
    console.log(`${ops[idx].t} ${ops[idx].line}`);
    lastPrinted = idx;
    if (ops[idx].t !== ' ') changes++;
  }
  return changes;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }
  const dryRun = DRY_RUN || opts.dryRun;

  let tenantPath;
  let vaultRoot;
  if (opts.tenant) {
    tenantPath = path.resolve(opts.tenant);
    vaultRoot = path.dirname(tenantPath);
  } else {
    vaultRoot = findVaultRoot(opts.vault);
    if (!vaultRoot) {
      console.error('✖ no tenant.yaml found walking up from here — run init-vault.js (A0) first, or pass --vault');
      process.exit(2);
    }
    tenantPath = path.join(vaultRoot, 'tenant.yaml');
  }
  if (!fs.existsSync(tenantPath)) {
    console.error(`✖ ${tenantPath} does not exist — A0 (init-vault.js) creates the minimal tenant.yaml first`);
    process.exit(2);
  }

  let existing;
  try { existing = RENDER.loadTenant(tenantPath) || {}; }
  catch (e) { console.error(`✖ tenant.yaml parse failed: ${e.message}`); process.exit(1); }

  // 1. Defaults fill gaps; existing values win.
  const doc = fillGaps(existing, goldenDefaults());

  // 2. Vault layout -> teams (only when the tenant has none yet).
  const profilesFolder = doc.vault.profiles_folder || 'team';
  const mixedFolder = doc.vault.mixed_folder || 'general';
  const notes = [];
  if (!Array.isArray(doc.vault.teams) || doc.vault.teams.length === 0) {
    const scanned = scanTeamFolders(vaultRoot, { profilesFolder, mixedFolder });
    if (scanned.length) {
      doc.vault.teams = scanned;
      notes.push(`teams: ${scanned.map((t) => t.tag).join(', ')} (from vault folders — add descriptions/keywords for better routing)`);
    }
  }

  // 3. Profiles -> roster. Profiles are the SSOT for a person: new lastnames
  //    are appended; existing entries get a field-level merge — alias UNION +
  //    fill-empty scalars (first_name, email, role, slack_user_id). Hand-set
  //    roster values are never overwritten, so post-B1 profile enrichment
  //    still reaches the rendered name-maps on the next run.
  const profiles = readProfiles(vaultRoot, profilesFolder);
  const byLastname = new Map((doc.roster || [])
    .filter((p) => p && p.lastname).map((p) => [p.lastname, p]));
  let appended = 0;
  let mergedCount = 0;
  const MERGE_SCALARS = ['first_name', 'email', 'role', 'slack_user_id', 'home_team'];
  for (const { fm } of profiles) {
    const entry = profileToRosterEntry(fm);
    const current = byLastname.get(fm.lastname);
    if (!current) {
      doc.roster.push(entry);
      byLastname.set(fm.lastname, entry);
      appended++;
      continue;
    }
    const mergedFields = [];
    if (Array.isArray(entry.aliases) && entry.aliases.length) {
      const haveAliases = new Set((current.aliases || []).map(String));
      const added = entry.aliases.filter((a) => !haveAliases.has(a));
      if (added.length) {
        current.aliases = [...(current.aliases || []), ...added];
        mergedFields.push(`aliases +${added.length}`);
      }
    }
    for (const k of MERGE_SCALARS) {
      if ((current[k] === undefined || current[k] === null || current[k] === '') && entry[k]) {
        current[k] = entry[k];
        mergedFields.push(k);
      }
    }
    if (mergedFields.length) {
      mergedCount++;
      notes.push(`roster merge ${fm.lastname}: ${mergedFields.join(', ')} (from ${profilesFolder}/${fm.lastname}.md)`);
    }
  }
  if (appended) notes.push(`roster: +${appended} member(s) from ${profilesFolder}/*.md`);
  if (mergedCount) notes.push(`roster: ${mergedCount} existing member(s) enriched from profiles (profile fills gaps; hand-edits win)`);
  if (!doc.roster.length) {
    // A2 is an optional rung — a golden-default (Slack-on) tenant that skipped
    // it used to reach B1 with an empty roster and hard-fail validate-tenant S4
    // (exactly one is_owner required) with no remediation prompt. When the A0
    // owner answer exists, synthesize a one-entry roster from it instead.
    const ownerSeed = readStateScalar(vaultRoot, 'owner');
    if (ownerSeed) {
      const bare = String(ownerSeed).split('@')[0];
      const lastname = bare.charAt(0).toUpperCase() + bare.slice(1);
      doc.roster.push({ lastname, is_owner: true });
      notes.push(`roster was EMPTY — seeded it from the A0 owner answer (${lastname}, is_owner: true) so S4 doesn't block B1; run the profiles skill (A2) for the real roster (and fix the name there if that isn't a lastname)`);
    } else {
      notes.push('roster is EMPTY — run the profiles skill (A2) or add members by hand; the pipeline cannot resolve speakers without it, and with Slack enabled validate-tenant S4 will block B1 until exactly one member has is_owner: true (tell me who owns this vault)');
    }
  }
  // Owner (is_owner: true) — validate-tenant S4 requires EXACTLY ONE when Slack
  // is enabled (the golden-path default), so a fresh vault used to hard-fail S4
  // at B1 every time (remediation M-tenant). Set the owner here from the A0
  // owner answer (state.yaml `owner`, matched by lastname or email local-part).
  // When the answer matches NO roster entry, a new entry is seeded from it —
  // NEVER the sole-member fallback (a one-entry roster can be an external
  // advisor from A2, and crowning them misroutes DLQ DMs). The sole-member
  // fallback applies only when there is no A0 owner answer at all. Never touch
  // an existing is_owner (idempotency) and never set a second one.
  if (doc.roster.length && !doc.roster.some((p) => p && p.is_owner === true)) {
    const ownerAnswer = readStateScalar(vaultRoot, 'owner');
    let ownerEntry = null;
    let ownerRule = null;
    if (ownerAnswer) {
      const want = String(ownerAnswer).toLowerCase();
      ownerEntry = doc.roster.find((p) => p && p.lastname && (
        String(p.lastname).toLowerCase() === want ||
        (typeof p.email === 'string' && p.email.toLowerCase().split('@')[0] === want)
      )) || null;
      if (ownerEntry) {
        ownerRule = 'matched the A0 owner answer';
      } else {
        // Same seeding style as the empty-roster branch above.
        const bare = String(ownerAnswer).split('@')[0];
        const lastname = bare.charAt(0).toUpperCase() + bare.slice(1);
        ownerEntry = { lastname, is_owner: true };
        doc.roster.push(ownerEntry);
        ownerRule = `seeded from the A0 owner answer — "${ownerAnswer}" matched no roster entry; ` +
          `if that isn't the right person/lastname, fix it in ${profilesFolder}/ and re-run`;
      }
    } else if (doc.roster.length === 1) {
      ownerEntry = doc.roster[0];
      ownerRule = 'sole roster member — no A0 owner answer';
    }
    if (ownerEntry) {
      ownerEntry.is_owner = true;
      notes.push(`is_owner: ${ownerEntry.lastname} (${ownerRule}) — DLQ DM + 1:1 routing target`);
    } else {
      notes.push('no roster entry has is_owner: true — set exactly one (DLQ DM target); ' +
        'tell me who owns this vault (B1 confirms it)');
    }
  }
  const noEmail = (doc.roster || [])
    .filter((p) => p && p.lastname && !(typeof p.email === 'string' && p.email.includes('@')))
    .map((p) => p.lastname);
  if (noEmail.length) {
    notes.push(`no email for ${noEmail.join(', ')} — Zoom attendance resolution and Slack @mentions degrade to name-matching; add 'email:' to ${profilesFolder}/<Lastname>.md (B1 asks once for the domain)`);
  }

  // 4. internal_domains from roster emails (only when missing/empty).
  const domains = [...new Set((doc.roster || [])
    .map((p) => (p && typeof p.email === 'string' && p.email.includes('@')) ? p.email.split('@')[1].toLowerCase() : null)
    .filter(Boolean))].sort();
  if ((!Array.isArray(doc.tenant.internal_domains) || !doc.tenant.internal_domains.length) && domains.length) {
    doc.tenant.internal_domains = domains;
    notes.push(`internal_domains: ${domains.join(', ')} (from roster emails)`);
  }

  // 5. Consume the WHOLE A0 stack map (not just tracker) — the user's answers
  //    must propagate so deploy stops re-pitching tools they already rejected.
  //    Existing tenant values still win everywhere.
  const stack = readStackFromState(vaultRoot);
  const kindAlreadySet = !!(existing.features && existing.features.tracker
    && existing.features.tracker.kind !== undefined);
  if (stack.tracker && doc.features.tracker && !kindAlreadySet) {
    const kind = stack.tracker === 'linear' ? 'linear' : 'other';
    doc.features.tracker.kind = kind;
    notes.push(`tracker.kind: ${kind} (from A0 stack map)${kind === 'other'
      ? ` — no ${stack.tracker} connector in v0.1: file-only tasks + waitlist` : ''}`);
  }
  const slackAlreadySet = !!(existing.features && existing.features.slack
    && existing.features.slack.enabled !== undefined);
  if (stack.chat && stack.chat !== 'slack' && doc.features.slack && !slackAlreadySet) {
    doc.features.slack.enabled = false;
    // chat = none is a choice, not a tool — no waitlist slug to advertise.
    const slugNote = stack.chat === 'none' ? '' : ` (waitlist slug: ${toolSlug(stack.chat)})`;
    notes.push(`slack digests OFF — at A0 you said chat = ${stack.chat}${slugNote}; digests stay in the vault; TaskCrafter/feedback/error-DM workflows won't deploy (their surface is Slack in v0.1 — file-only tasks keep working); B3 re-enables if you connect Slack anyway`);
  }
  if (stack.calls && stack.calls !== 'zoom') {
    notes.push(`calls = ${stack.calls} (A0) — B2 Zoom auto-capture is skip/waitlist territory (slug: ${toolSlug(stack.calls)}); manual transcript feed keeps working`);
  }
  if (stack.git && stack.git !== 'github' && (doc.vault.repo === null || doc.vault.repo === undefined)) {
    notes.push(`git = ${stack.git} (A0) — vault.repo stays null (local-only vault); GitLab/other hosting is waitlist-only at B4 (slug: ${toolSlug(stack.git)})`);
  }

  // 5b. Persona from A0 (state.yaml) — only when the tenant is silent; an
  //     existing tenant.persona always wins and is never re-defaulted.
  const persona = readStateScalar(vaultRoot, 'persona');
  const personaAlreadySet = !!(existing.tenant && existing.tenant.persona !== undefined);
  if (persona && ['solo', 'team_lead', 'company_lead'].includes(persona) && !personaAlreadySet) {
    doc.tenant.persona = persona;
    notes.push(`tenant.persona: ${persona} (from A0)`);
  }

  // 5c. tenant.about from the company profile doc (vault.company_profile_path)
  //     — the 2–3 sentence company gloss the pipeline prompt builders render.
  const companyRel = doc.vault.company_profile_path || 'docs/company.md';
  if (doc.tenant.about === undefined || doc.tenant.about === null || doc.tenant.about === '') {
    const about = readCompanyAbout(path.join(vaultRoot, companyRel));
    if (about) {
      doc.tenant.about = about;
      notes.push(`tenant.about: filled from ${companyRel} ("What the company does")`);
    }
  }

  // 5d. primary_language must MIRROR the tenant's real first language, never a
  //     hardcoded 'en' (remediation B6). The golden default seeds 'en'; when the
  //     tenant did not set primary_language explicitly, derive it from
  //     languages[0] so RU/any non-EN tenants get language-mirroring at B1.
  const primaryExplicit = !!(existing.tenant && existing.tenant.primary_language);
  if (!primaryExplicit && Array.isArray(doc.tenant.languages) && doc.tenant.languages.length) {
    const first = String(doc.tenant.languages[0]);
    if (doc.tenant.primary_language !== first) {
      doc.tenant.primary_language = first;
      notes.push(`primary_language: ${first} (from tenant.languages[0]; the pipeline mirrors this language)`);
    }
  }

  // 5e. Timezone: surface it instead of silently stamping UTC (remediation
  //     M-tz). init-vault records tenant.timezone at A0 (inferred from the
  //     locale/language answer or asked once); if it is still UTC, say so — the
  //     user may be on a real zone and transcript filenames key on it.
  if (doc.tenant.timezone === 'UTC') {
    notes.push('timezone is UTC — transcript filenames use tenant.timezone; ' +
      'set it (e.g. Europe/Moscow, America/New_York) if your team is not on UTC');
  }

  // 6. Emit + diff + write.
  const oldText = fs.readFileSync(tenantPath, 'utf8');
  const newText = emitTenantYaml(doc);

  // Re-parse what we would write — if our own emitter output does not parse
  // back to the same document, refuse (never write a broken tenant.yaml).
  const tmpCheck = path.join(require('os').tmpdir(), `backbrief-tenant-check-${process.pid}.yaml`);
  try {
    fs.writeFileSync(tmpCheck, newText);
    const back = RENDER.loadTenant(tmpCheck);
    if (JSON.stringify(back) !== JSON.stringify(JSON.parse(JSON.stringify(doc)))) {
      console.error('✖ internal error: emitted YAML does not round-trip — not writing (report this)');
      process.exit(2);
    }
  } finally {
    try { fs.unlinkSync(tmpCheck); } catch (e) { /* best effort */ }
  }

  console.log(`tenant.yaml completion — ${path.relative(process.cwd(), tenantPath) || 'tenant.yaml'}\n`);
  for (const n of notes) console.log(`  ℹ ${n}`);
  if (notes.length) console.log('');

  const ops = diffLines(oldText.replace(/\n$/, ''), newText.replace(/\n$/, ''));
  const changed = ops.some((op) => op.t !== ' ');
  if (!changed) {
    console.log('no changes needed — tenant.yaml is already complete');
    process.exit(0);
  }
  console.log('--- current');
  console.log('+++ generated');
  printDiff(ops);
  console.log('');

  if (dryRun) {
    console.log('[dry-run] not writing (re-run without --dry-run / DRY_RUN to apply)');
    process.exit(0);
  }
  const tmp = `${tenantPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, newText);
  fs.renameSync(tmp, tenantPath);
  // Quote the path in the copy-pasteable command when it contains whitespace.
  const rel = path.relative(process.cwd(), tenantPath) || 'tenant.yaml';
  const shown = /\s/.test(rel) ? `'${rel.replace(/'/g, "'\\''")}'` : rel;
  console.log(`✔ written — now run: node plugin/scripts/validate-tenant.js ${shown}`);
  process.exit(0);
}

main();
