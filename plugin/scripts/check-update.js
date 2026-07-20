#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * check-update.js — installed kit VERSION vs latest.
 *
 * Pull, never push. Behavior contract:
 *
 *   - Source: gateway GET /v1/version when telemetry is enabled (the endpoint
 *     comes from tenant.yaml via telemetry.js readConfig); GitHub Releases API
 *     when it is not — opted-out users get update notices without our gateway
 *     ever seeing them; fully skipped offline (warn once, cached).
 *   - Cache: 24 h in <vault>/.backbrief/cache/update.json (--force bypasses).
 *   - Notice only: the kit never self-modifies. Output is one line —
 *       "Backbrief X.Y.Z is available (you: A.B.C) -> claude plugin update
 *        backbrief | git pull"
 *     The agent may OFFER to run the update command (one-ask rule).
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies, --help,
 * DRY_RUN=1 honored on the cache write.
 * Exit codes: 0 up to date (or check skipped offline) / 1 update available
 *             (a "finding", not an error) / 2 usage error.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KIT_ROOT = path.join(__dirname, '..', '..');
// telemetry.js is require-safe (guards require.main) and owns the tenant
// discovery + endpoint logic — reuse, don't duplicate (02 §4.4).
const telemetry = require('./telemetry.js');

const DRY_RUN = process.env.DRY_RUN === '1';
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 24 * 3600 * 1000;
// Rename token (02 §8.3) — swapped with the kit name once naming lands.
const GITHUB_RELEASES_LATEST = 'https://api.github.com/repos/EvgenSmith/backbrief/releases/latest';
const UPDATE_HINT = 'claude plugin update backbrief  |  git pull';

const HELP = `check-update.js — compare installed kit version against the latest release

Usage:
  node plugin/scripts/check-update.js [options]

Options:
  --tenant <path>   tenant.yaml (default: $TENANT, else walk up) — decides the
                    source: telemetry on -> gateway /v1/version; off -> GitHub
                    Releases API (opted-out users never touch the gateway)
  --force           ignore the 24 h cache in .backbrief/cache/update.json
  --json            machine-readable result on stdout
  -h, --help        this text

Notice only — the kit never self-modifies. Offline: the check is skipped
quietly (exit 0) and a one-time warning is cached.

Exit codes: 0 up to date or skipped / 1 update available / 2 usage error`;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = { tenant: null, force: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--force') o.force = true;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown option: ${a} (see --help)`); process.exit(2); }
  }
  return o;
}

function installedVersion() {
  const candidates = [
    () => fs.readFileSync(path.join(KIT_ROOT, 'VERSION'), 'utf8').trim(),
    () => JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version,
  ];
  for (const read of candidates) {
    try {
      const v = read();
      if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) return v;
    } catch (e) { /* next */ }
  }
  return '0.0.0';
}

// semver compare on the numeric triple (prerelease tags ignored — the kit
// releases plain X.Y.Z tags per 02 §5.3).
function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function cachePath(cfg) {
  if (!cfg.tenantPath) return null;
  return path.join(path.dirname(cfg.tenantPath), '.backbrief', 'cache', 'update.json');
}

function readCache(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeCache(file, data) {
  if (!file) return;
  if (DRY_RUN) { console.error(`[dry-run] would cache -> ${file}`); return; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  } catch (e) { /* cache is best-effort */ }
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

async function fromGateway(endpoint, current) {
  const res = await fetch(`${endpoint}/v1/version?channel=stable&current=${encodeURIComponent(current)}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`gateway /v1/version -> HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.latest !== 'string') throw new Error('gateway returned no latest version');
  return {
    latest: body.latest,
    min_supported: body.min_supported || null,
    notes_url: body.notes_url || null,
    update_hint: body.update_hint || UPDATE_HINT,
    source: 'gateway',
  };
}

async function fromGithubReleases() {
  const res = await fetch(GITHUB_RELEASES_LATEST, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'backbrief-check-update' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub Releases -> HTTP ${res.status}`);
  const body = await res.json();
  const tag = body && body.tag_name;
  if (!tag) throw new Error('GitHub Releases returned no tag');
  return {
    latest: String(tag).replace(/^v/, ''),
    min_supported: null,
    notes_url: body.html_url || null,
    update_hint: UPDATE_HINT,
    source: 'github-releases',
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const current = installedVersion();
  const cfg = telemetry.readConfig(opts.tenant);
  const cacheFile = cachePath(cfg);

  // 24 h cache (02 §5.2 — the top-of-any-skill opportunistic check must be free).
  const cached = opts.force ? null : readCache(cacheFile);
  let info = null;
  const cacheFresh = cached && cached.checked_at
    && Date.now() - new Date(cached.checked_at).getTime() < CACHE_TTL_MS;
  if (cacheFresh && cached.latest) {
    info = { ...cached, fromCache: true };
  } else if (cacheFresh && cached.offline_warned) {
    // Last attempt within the TTL was offline — stay quiet, don't re-probe
    // (this check runs opportunistically at the start of any skill).
    if (opts.json) console.log(JSON.stringify({ current, skipped: true }, null, 2));
    else console.log(`Backbrief ${current} — update check skipped (offline, cached)`);
    process.exit(0);
  }

  if (!info) {
    // Telemetry on -> gateway; off -> GitHub Releases only (never the gateway).
    const attempts = cfg.enabled ? [() => fromGateway(cfg.endpoint, current), fromGithubReleases]
      : [fromGithubReleases];
    let lastErr = null;
    for (const attempt of attempts) {
      try { info = await attempt(); break; }
      catch (e) { lastErr = e; }
    }
    if (info) {
      writeCache(cacheFile, { ...info, checked_at: new Date().toISOString() });
    } else {
      // Offline / unreachable: skip quietly, warn once per cache period.
      const alreadyWarned = cached && cached.offline_warned;
      if (!alreadyWarned) {
        console.error(`update check skipped (${lastErr ? lastErr.message : 'offline'}) — will retry after the cache expires`);
        writeCache(cacheFile, { offline_warned: true, checked_at: new Date().toISOString() });
      }
      if (opts.json) console.log(JSON.stringify({ current, skipped: true }, null, 2));
      else console.log(`Backbrief ${current} — update check skipped (offline)`);
      process.exit(0);
    }
  }

  const behind = cmpSemver(current, info.latest) < 0;
  const unsupported = info.min_supported && cmpSemver(current, info.min_supported) < 0;

  if (opts.json) {
    console.log(JSON.stringify({
      current,
      latest: info.latest,
      min_supported: info.min_supported,
      update_available: behind,
      unsupported: !!unsupported,
      notes_url: info.notes_url,
      update_hint: info.update_hint,
      source: info.source,
      cached: !!info.fromCache,
    }, null, 2));
  } else if (behind) {
    console.log(`Backbrief ${info.latest} is available (you: ${current}) -> ${info.update_hint}`);
    if (unsupported) console.log(`⚠ your version is below min_supported (${info.min_supported}) — update before the next deploy`);
    if (info.notes_url) console.log(`notes: ${info.notes_url}`);
  } else {
    console.log(`Backbrief ${current} — up to date (latest: ${info.latest}${info.fromCache ? ', cached' : ''})`);
  }
  process.exit(behind ? 1 : 0);
})().catch((e) => {
  // A broken update check must never look like a broken kit.
  console.error(`update check skipped (${e.message})`);
  process.exit(0);
});
