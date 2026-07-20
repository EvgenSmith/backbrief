#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * load-secrets-env.js — shared, dependency-free loader for the documented
 * secret contract (`_capabilities.md`, deploy.md "Global deploy rules"):
 * Phase-B credentials live in `<vault>/.backbrief/secrets.env` (gitignored,
 * chmod 600). The deploy-side scripts read `process.env.<VAR>` — but nothing
 * loaded that file into the environment, so a user who followed the contract
 * to the letter got "N8N_API_KEY required" anyway (remediation M-secrets).
 *
 * This module reads secrets.env (a plain KEY=VALUE dotenv subset) into
 * process.env WITHOUT overriding values already present — an explicit shell
 * env var always wins, the file only fills gaps. Zero npm dependencies.
 *
 * Used by: deploy-pipeline.js, check-env.js, status.js, check-drift.js.
 *
 * secrets.env grammar (intentionally tiny):
 *   - `KEY=value`  (optional `export KEY=value`)
 *   - `# comment` lines and blank lines are ignored
 *   - single- or double-quoted values have the quotes stripped verbatim
 *   - on an UNquoted value, a trailing ` # comment` is trimmed
 *   - keys must match [A-Za-z_][A-Za-z0-9_]*; other lines are skipped silently
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val[0] === '"' || val[0] === "'") {
      // Quoted value: take everything up to the matching closing quote; discard
      // anything after it (a trailing inline comment). Tokens carry no embedded
      // quotes, so a plain indexOf of the closing quote is sufficient.
      const q = val[0];
      const end = val.indexOf(q, 1);
      val = end === -1 ? val.slice(1) : val.slice(1, end);
    } else {
      // Unquoted value: a whitespace-preceded `#` starts a trailing comment.
      const hash = val.search(/\s+#/);
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

// Walk up from `start` for a Backbrief vault root (.backbrief/ or tenant.yaml).
function findVaultRoot(start) {
  let dir = start || process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.backbrief')) ||
        fs.existsSync(path.join(dir, 'tenant.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/*
 * Load <vaultRoot>/.backbrief/secrets.env into process.env (gaps only —
 * existing env wins). `vaultRoot` may be a vault root OR any directory inside
 * one (e.g. the tenant.yaml directory); when omitted, walk up from cwd.
 * Never throws — a missing/unreadable file is a silent no-op (the caller's own
 * "VAR required" check still fires with its normal message).
 * Returns { loaded, path, keys } for optional diagnostics.
 */
function loadSecretsEnv(vaultRoot) {
  let root = vaultRoot ? path.resolve(vaultRoot) : findVaultRoot();
  if (!root) return { loaded: false, path: null, keys: [] };
  // Accept either the vault root or a dir inside it: if this dir has no
  // .backbrief/, try to locate one walking up (tenant dir === vault root in
  // the normal layout, so this is usually a no-op).
  let file = path.join(root, '.backbrief', 'secrets.env');
  if (!fs.existsSync(file)) {
    const up = findVaultRoot(root);
    if (up) { root = up; file = path.join(root, '.backbrief', 'secrets.env'); }
  }
  if (!fs.existsSync(file)) return { loaded: false, path: file, keys: [] };
  let parsed;
  try { parsed = parseEnvFile(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { loaded: false, path: file, keys: [], error: e.message }; }
  const keys = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
      keys.push(k);
    }
  }
  return { loaded: true, path: file, keys };
}

module.exports = { loadSecretsEnv, parseEnvFile, findVaultRoot };

/* ------------------------------------------------------------------ */
/* Direct-run helper (library first — imported by the deploy scripts). */
/* `node load-secrets-env.js` shows which keys the current vault's      */
/* secrets.env would load — names only, values are NEVER printed.       */
/* ------------------------------------------------------------------ */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const HELP = `load-secrets-env.js — shared loader for <vault>/.backbrief/secrets.env (library)

Imported by deploy-pipeline.js / check-env.js / status.js / check-drift.js to fill
process.env from the gitignored secrets.env WITHOUT overriding values already set
(an explicit shell env var always wins; the file only fills gaps). Not usually run
directly — run it to check which keys the current vault's secrets.env would load
(names only; values are never printed).

Usage:
  node plugin/scripts/load-secrets-env.js [--vault <path>]

Options:
  --vault <path>   vault root, or any directory inside it (default: walk up from cwd)
  -h, --help       this text

Exit codes: 0 always (a missing/unreadable secrets.env is a silent no-op)`;
  if (argv.includes('-h') || argv.includes('--help')) { console.log(HELP); process.exit(0); }
  const vi = argv.indexOf('--vault');
  const r = loadSecretsEnv(vi !== -1 ? argv[vi + 1] : undefined);
  if (!r.loaded) console.log(`no secrets.env loaded (looked for ${r.path || '<no vault found>'})`);
  else console.log(`loaded ${r.keys.length} key(s) from ${r.path}: ${r.keys.join(', ') || '(none — all already set in env)'}`);
}
