#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * pipeline-nodes.js — Backbrief pipeline SSOT.
 *
 * Single source of truth for BOTH deploy-pipeline.js and check-drift.js, so
 * live deploys are ATOMIC (every mapped Code node from one repo state) and
 * drift checks compare the exact same set. Generalizes the production
 * main-nodes.js / taskcrafter-nodes.js / drive-nodes.js trio into ONE map
 * covering all pipeline workflows — closing the prod gap where only
 * main/taskcrafter had deploy+drift tooling.
 *
 * Contents:
 *   WORKFLOWS        — per-workflow: skeleton file, code dir, node→file map,
 *                      webhook paths, feature gate, inline-only Code nodes
 *   TENANT_REGIONS   — the region kinds rendered by pipeline/tenant-render.js
 *   SECRETS          — placeholder → env mapping (INJECT_SECRETS input)
 *   PARAM_TOKENS     — __BACKBRIEF_*__ tokens patched into NON-Code node
 *                      params at deploy (channel ids, repo coords, base URL)
 *   INJECT_SECRETS   — env → preserve-from-live → warn-loudly (verbatim
 *                      semantics from prod main-nodes.js; paid for with the
 *                      placeholder-downgrade incident — see the comment)
 *   NORMALIZE_SECRETS— re-placeholder live values for drift comparison
 *   COLLECT_KNOWN_SECRETS / SECRET_SCRUB — mirror/snapshot hygiene; the
 *                      known-secret list is COMPUTED (env + live values),
 *                      never a literal in source (a prod incident lesson)
 *
 * This file is a library (`require`d by the deploy/drift/redrive scripts);
 * running it directly prints the map for eyeballing.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Workflow map                                                        */
/* ------------------------------------------------------------------ */
// Paths are kit-root-relative. `nodeFileMap` keys are the node names in the
// shipped skeletons (pipeline/workflows/*.json) — owner-neutral renames of
// the production names. `inlineOnlyCodeNodes` are structural Code nodes that
// intentionally live only in the skeleton JSON (tiny, generic glue); the
// graph-lint in check-drift.js requires every skeleton Code node to be in
// exactly one of the two lists, so nothing can silently go uncovered.

const WORKFLOWS = {
  transcripts: {
    label: 'Backbrief: transcripts (Zoom webhook -> Slack + vault)',
    skeleton: 'pipeline/workflows/main.json',
    codeDir: 'pipeline/code/transcripts',
    webhookPaths: ['backbrief-zoom'],
    // Feature gate: always on — this workflow IS the pipeline.
    gate: () => ({ on: true }),
    nodeFileMap: {
      // Verify node is mapped in the kit (prod kept it inline because it
      // baked in the real secret; the kit reads an injected const instead).
      'Verify Zoom signature':                  'verify-zoom-webhook.js',
      'Extract metadata':                       'extract-metadata.js',
      'Apply glossary':                         'apply-glossary.js',
      'Build Anthropic body':                   'build-anthropic-body.js',
      'Parse Anthropic response':               'parse-anthropic-response.js',
      'Build commit payload':                   'build-commit-payload-v2.js',
      // build-slack-root-minimal.js drives BOTH root builders (V1.5.26 unified).
      'Build Slack root minimal':               'build-slack-root-minimal.js',
      'Build Slack root (Phase 2)':             'build-slack-root-minimal.js',
      // capture-root-ts.js drives BOTH capture nodes (V1.7.5 merge).
      'Capture root ts':                        'capture-root-ts.js',
      'Capture root ts (Phase 1)':              'capture-root-ts.js',
      'Build GitHub body':                      'build-github-body.js',
      // Git-Data atomic-commit builders — extracted to files in the kit so
      // they gain drift coverage (tracked follow-up, done).
      'Build tree body':                        'build-tree-body.js',
      'Build commit body':                      'build-commit-body.js',
      'Build ref body':                         'build-ref-body.js',
      'Build thread reply':                     'build-slack-thread-reply.js',
      'STUB-C vault context':                   'stub-C-vault-context.js',
      'DLQ writer':                             'dlq-writer.js',
      'Recording state lookup':                 'recording-state-lookup.js',
      // recording-state-save.js drives both phase saves.
      'Recording state save (Phase 1)':         'recording-state-save.js',
      'Recording state save (Phase 2 oneshot)': 'recording-state-save.js',
      'Recording state finalize':               'recording-state-finalize.js',
      'AI fallback (stub summary)':             'ai-fallback-stub.js',
      'Recording state mark committed':         'recording-state-mark-committed.js',
      'Mark thread post failed':                'mark-thread-post-failed.js',
      'Build vtt-fail DM':                      'build-vtt-fail-dm.js',
    },
    inlineOnlyCodeNodes: [
      'Attach .vtt to item',     // graceful .vtt-download fallback (generic)
      'Merge GitHub response',   // status carry-over onto the payload
      'Mark created', 'Mark duplicate', 'Mark error', // 1-line branch tags
    ],
  },

  taskcrafter: {
    label: 'Backbrief: TaskCrafter (sub-workflow)',
    skeleton: 'pipeline/workflows/taskcrafter.json',
    codeDir: 'pipeline/code/taskcrafter',
    webhookPaths: ['backbrief-taskcrafter', 'backbrief-taskcrafter-interaction'],
    gate: (tenant) => {
      const kind = tenant && tenant.features && tenant.features.tracker && tenant.features.tracker.kind;
      if (!kind || kind === 'none') return { on: false, reason: 'features.tracker.kind is none/unset' };
      if (kind === 'jira') return { on: false, reason: 'Jira is waitlist-only in v0.1 (no adapter ships) — file-only tasks instead' };
      // TaskCrafter's whole delivery/approval surface (preview post + Approve/
      // Skip buttons) is Slack in v0.1 — without it every invocation would just
      // fail on the Slack nodes. File-only tasks (A3) stay available.
      const slack = tenant && tenant.features && tenant.features.slack;
      if (!slack || slack.enabled !== true) return { on: false, reason: 'features.slack.enabled is false — TaskCrafter approvals are Slack-only in v0.1; file-only tasks (A3) keep working' };
      return { on: true };
    },
    nodeFileMap: {
      'Normalize webhook payload': '00-normalize-webhook-payload.js',
      'Build normalizer body':     '01-build-normalizer-body.js',
      'Parse normalizer response': '02-parse-normalizer-response.js',
      'Build team queries':        '03a-build-team-queries.js',
      'Aggregate Linear results':  '03c-aggregate-linear-results.js',
      'Build rerank body':         '04-build-semantic-rerank-body.js',
      'Matcher decide':            '05-matcher-decide.js',
      'Router':                    '06-router.js',
      'Build composer body':       '07-build-composer-body.js',
      'Parse composer response':   '08-parse-composer-response.js',
      'Build Slack BlockKit':      '09b-build-slack-blockkit.js',
      'Save pending state':        '10-save-pending-state.js',
      'Parse Slack action':        '11-parse-slack-action.js',
      'Build Linear mutation':     '12-build-linear-mutation.js',
      'Handle result':             '13-handle-result-and-reply.js',
    },
    inlineOnlyCodeNodes: [],
  },

  drive: {
    label: 'Backbrief: Drive uploader (sub-workflow)',
    skeleton: 'pipeline/workflows/drive-uploader.json',
    codeDir: 'pipeline/code/drive',
    webhookPaths: ['backbrief-drive'],
    gate: (tenant) => {
      const d = tenant && tenant.features && tenant.features.drive;
      if (!d || d.enabled !== true) return { on: false, reason: 'features.drive.enabled is false (default)' };
      return { on: true };
    },
    nodeFileMap: {
      'Normalize webhook payload': 'normalize-webhook-payload.js',
      'Build Drive metadata':      'build-drive-metadata.js',
      'Build root post update':    'build-root-post-update.js',
      'Build chunk plan':          'build-chunk-plan.js',
      'Capture final upload body': 'capture-final-upload-body.js',
    },
    inlineOnlyCodeNodes: [],
  },

  feedback: {
    label: 'Backbrief: feedback collector',
    skeleton: 'pipeline/workflows/feedback-collector.json',
    codeDir: 'pipeline/code/feedback',
    webhookPaths: [],
    // Feedback reads TaskCrafter posts in the digest channel — same gate,
    // including the Slack condition (no Slack ⇒ no channel to read).
    gate: (tenant) => {
      const kind = tenant && tenant.features && tenant.features.tracker && tenant.features.tracker.kind;
      if (!kind || kind === 'none') return { on: false, reason: 'features.tracker.kind is none/unset (nothing to collect feedback on)' };
      if (kind === 'jira') return { on: false, reason: 'Jira is waitlist-only in v0.1 (no adapter ships) — file-only tasks instead, no TaskCrafter posts to collect feedback on' };
      const slack = tenant && tenant.features && tenant.features.slack;
      if (!slack || slack.enabled !== true) return { on: false, reason: 'features.slack.enabled is false — no digest channel to collect feedback from' };
      return { on: true };
    },
    nodeFileMap: {
      'Filter TC posts needing feedback': '01-filter-tc-posts.js',
      'Build feedback parser body':       '02-build-feedback-parser-body.js',
      'Build feedback digest':            '03-build-feedback-digest.js',
      'Append training entry':            '04-append-training-entry.js',
    },
    inlineOnlyCodeNodes: [],
  },

  'error-trap': {
    label: 'Backbrief: error trap',
    skeleton: 'pipeline/workflows/error-trap.json',
    codeDir: null, // no mapped Code nodes; "Format error DM" is inline glue
    webhookPaths: [],
    // The trap's only action is a Slack DM to the owner — without Slack it
    // would itself error on every alert. deploy-pipeline only wires
    // settings.errorWorkflow when the trap id exists, so skipping is safe;
    // failures then live in the n8n executions list (say so honestly).
    gate: (tenant) => {
      const slack = tenant && tenant.features && tenant.features.slack;
      if (!slack || slack.enabled !== true) return { on: false, reason: 'features.slack.enabled is false — error alerts are Slack DMs in v0.1; watch the n8n executions list instead' };
      return { on: true };
    },
    nodeFileMap: {},
    inlineOnlyCodeNodes: ['Format error DM'],
  },
};

// Deploy order: error-trap first (other workflows' settings.errorWorkflow
// point at its id), sub-workflows before the main entry point.
const DEPLOY_ORDER = ['error-trap', 'drive', 'taskcrafter', 'feedback', 'transcripts'];

/* ------------------------------------------------------------------ */
/* Skeleton contract                                                   */
/* ------------------------------------------------------------------ */
// Every shipped skeleton carries this top-level key; deploy-pipeline.js
// checks it against the kit VERSION before --import and strips it from the
// POST payload. Inherited lesson: the prod build-workflow.js
// bootstrap silently reverted live fixes from a frozen skeleton — the kit's
// skeletons carry placeholder jsCode only (render is the single source of
// node code), and the version tag turns staleness into a loud failure.
const SKELETON_VERSION_KEY = 'backbrief_skeleton_version';

// Placeholder jsCode marker: mapped Code nodes in skeletons throw until
// deploy-pipeline.js replaces their body (a passthrough placeholder on e.g.
// the signature-verify node would be a security hole).
const SKELETON_PLACEHOLDER_MARK = 'BACKBRIEF_SKELETON_PLACEHOLDER';

/* ------------------------------------------------------------------ */
/* Tenant regions (must match pipeline/tenant-render.js RENDERERS)     */
/* ------------------------------------------------------------------ */
const TENANT_REGIONS = [
  'DRIVE', 'GLOSSARY', 'KNOBS', 'LANG', 'LLM', 'PROMPT',
  'ROSTER', 'ROUTING', 'SLACK', 'TRACKER',
];

/* ------------------------------------------------------------------ */
/* Non-Code parameter tokens                                           */
/* ------------------------------------------------------------------ */
// Skeleton NON-Code node params (Slack targets, GitHub URLs, sub-workflow
// trigger URLs) carry these tokens; deploy-pipeline.js string-replaces them
// from tenant.yaml + .backbrief/pipeline-state.json + env at PUT time.
// `resolve(tenant, state, env)` returns the value or null (null ⇒ warn, token
// left in place so the gap is visible in n8n rather than silently wrong).
const PARAM_TOKENS = [
  {
    token: '__BACKBRIEF_VAULT_REPO__', label: 'vault repo (owner/repo)',
    resolve: (t) => (t && t.vault && t.vault.repo) || null,
  },
  {
    token: '__BACKBRIEF_VAULT_BRANCH__', label: 'vault branch',
    resolve: (t) => (t && t.vault && t.vault.branch) || 'main',
  },
  {
    token: '__BACKBRIEF_OWNER_SLACK_USER_ID__', label: 'owner Slack user id',
    resolve: (t, s) => {
      const roster = Array.isArray(t && t.roster) ? t.roster : [];
      const owner = roster.find((p) => p && p.is_owner === true) || roster[0] || {};
      const stateIds = (s && s.slack && s.slack.user_ids) || {};
      return owner.slack_user_id || stateIds[owner.lastname] || null;
    },
  },
  {
    token: '__BACKBRIEF_DIGEST_CHANNEL_ID__', label: 'digest channel id',
    resolve: (t, s) => {
      const chan = (s && s.slack && s.slack.channels && s.slack.channels.digest)
        || (t && t.features && t.features.slack && t.features.slack.digest_channel) || null;
      // A '#name' is not a postable id — deploy warns; test-creds.js slack
      // resolves and caches the C… id in pipeline-state.
      return chan;
    },
  },
  {
    token: '__BACKBRIEF_N8N_BASE_URL__', label: 'n8n base URL',
    resolve: (t, s, env) => {
      const base = (env && env.N8N_BASE_URL) || (s && s.n8n_base_url) || null;
      return base ? String(base).replace(/\/+$/, '') : null;
    },
  },
];

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/* ------------------------------------------------------------------ */
// Repo code carries placeholders, never secrets. `varName` is the const name
// in the Code-node source (used to pull the live value back out for
// preserve-on-deploy and to re-placeholder it for drift).
const SECRETS = [
  { placeholder: '__GITHUB_PAT_PLACEHOLDER__',      varName: 'GITHUB_PAT',                env: 'GITHUB_VAULT_PAT',          label: 'GitHub vault PAT' },
  { placeholder: '__LINEAR_API_KEY_PLACEHOLDER__',  varName: 'LINEAR_TOKEN',              env: 'LINEAR_API_TOKEN',          label: 'Linear API token' },
  { placeholder: '__ZOOM_WEBHOOK_SECRET_TOKEN__',   varName: 'ZOOM_WEBHOOK_SECRET_TOKEN', env: 'ZOOM_WEBHOOK_SECRET_TOKEN', label: 'Zoom webhook secret' },
  { placeholder: '__ZOOM_ACCOUNT_ID__',             varName: 'ZOOM_ACCOUNT_ID',           env: 'ZOOM_ACCOUNT_ID',           label: 'Zoom S2S account id' },
  { placeholder: '__ZOOM_CLIENT_ID__',              varName: 'ZOOM_CLIENT_ID',            env: 'ZOOM_CLIENT_ID',            label: 'Zoom S2S client id' },
  { placeholder: '__ZOOM_CLIENT_SECRET__',          varName: 'ZOOM_CLIENT_SECRET',        env: 'ZOOM_CLIENT_SECRET',        label: 'Zoom S2S client secret' },
  // V1.8.1 — recording-state-lookup race guard re-reads own staticData via the
  // n8n API. The base URL is instance coordinates, not a secret, but riding the
  // SECRETS machinery gives it env → preserve-from-live → warn plus drift
  // normalization for free, and keeps the guard's activation condition honest
  // (placeholder still present ⇒ guard stays off, pre-V1.8.1 oneshot fallback).
  { placeholder: '__N8N_API_KEY_PLACEHOLDER__',     varName: 'N8N_API_KEY',               env: 'N8N_API_KEY',               label: 'n8n API key (race guard)' },
  { placeholder: '__BACKBRIEF_N8N_BASE_URL__',      varName: 'N8N_BASE',                  env: 'N8N_BASE_URL',              label: 'n8n base URL (race guard)' },
  // B4 — Slack interactivity signature verification. The taskcrafter interaction
  // entry node (11-parse-slack-action.js) reads this injected const to verify
  // X-Slack-Signature; repo keeps the placeholder, so the offline harness and any
  // pre-deploy render skip verification (secret still starts with '__' ⇒ guard
  // off, same activation pattern as the Zoom verify node + race guard). A real
  // deploy injects it and forged button clicks are rejected before any tracker write.
  { placeholder: '__SLACK_SIGNING_SECRET__',        varName: 'SLACK_SIGNING_SECRET',      env: 'SLACK_SIGNING_SECRET',      label: 'Slack signing secret (interactivity)' },
  // Not read by any Code node today: Slack goes through n8n credentials; the
  // Anthropic key belongs in an n8n credential with
  // `--anthropic-inline` as the header-value fallback. Both stay listed so
  // NORMALIZE/SCRUB cover every secret the pipeline can ever hold.
  { placeholder: '__SLACK_BOT_TOKEN_PLACEHOLDER__', varName: 'SLACK_BOT_TOKEN',           env: 'SLACK_BOT_TOKEN',           label: 'Slack bot token' },
  { placeholder: '__ANTHROPIC_API_KEY__',           varName: 'ANTHROPIC_API_KEY',         env: 'ANTHROPIC_API_KEY',         label: 'Anthropic API key (BYO)' },
];

// Known secret SHAPES scrubbed from any mirror regardless of how the value
// got in (the drift normalizer and SECRET_SCRUB both treat the
// header value as a known secret shape).
const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,   // Anthropic API key
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub PATs
  /lin_api_[A-Za-z0-9]{10,}/g,   // Linear API keys
];

/* ------------------------------------------------------------------ */
/* Secret machinery (verbatim semantics from prod main-nodes.js)       */
/* ------------------------------------------------------------------ */

// Pull the real value of `const <varName> = '<value>'` out of live code,
// ignoring the placeholder itself.
function _liveSecret(liveCode, varName) {
  const m = String(liveCode || '').match(new RegExp('\\b' + varName + "\\s*=\\s*['\"]([^'\"]+)['\"]"));
  return m && !m[1].includes('PLACEHOLDER') && !/^__.*__$/.test(m[1]) ? m[1] : null;
}

// Replace each placeholder present in repoCode with the real secret.
// Returns { code, notes[] }. Resolution order: env var → PRESERVE whatever
// the live node already had → leave the placeholder and warn LOUDLY.
//
// NEVER downgrade a real live secret to a placeholder. That exact bug left
// the production "STUB-C vault context" carrying '__GITHUB_PAT_PLACEHOLDER__'
// for ≥ a week: every GitHub call 401'd and the whole vault-context loader
// silently loaded NOTHING (system prompt = 43 bytes) on every call. These
// semantics are non-negotiable.
//
// Idempotent: with no env var and a live node that already holds the real
// secret, the preserved value is re-inserted (PUT is a no-op diff).
function INJECT_SECRETS(repoCode, liveCode) {
  let code = repoCode;
  const notes = [];
  for (const s of SECRETS) {
    if (!code.includes(s.placeholder)) continue;
    const fromEnv = (process.env[s.env] || '').trim();
    const real = fromEnv || _liveSecret(liveCode, s.varName);
    if (real) {
      code = code.split(s.placeholder).join(real);
      notes.push(`key: ${s.label} <- ${fromEnv ? 'env ' + s.env : 'live (preserved)'}`);
    } else {
      notes.push(`WARNING ${s.label}: no ${s.env} env and live node has only the placeholder — node WILL 401 at runtime`);
    }
  }
  return { code, notes };
}

// Re-placeholder every injected secret in a jsCode string, so the drift
// checker can compare live (real secret) against repo (placeholder) without
// a false DRIFT, and so real secrets never appear in diff output.
// Idempotent (placeholder → placeholder).
function NORMALIZE_SECRETS(code) {
  let out = String(code || '');
  for (const s of SECRETS) {
    out = out.replace(
      new RegExp('(\\b' + s.varName + "\\s*=\\s*['\"])[^'\"]+(['\"])"),
      '$1' + s.placeholder + '$2'
    );
  }
  return out;
}

// Compute the known-secret value list at runtime: env values + values sitting
// in live workflow nodes (via SECRETS[].varName). NEVER a literal in source —
// the prod SECRET_SCRUB carried the real Zoom webhook secret as a string
// literal in the repo; this replaces that pattern.
function COLLECT_KNOWN_SECRETS(workflows) {
  const known = new Set();
  for (const s of SECRETS) {
    const v = (process.env[s.env] || '').trim();
    if (v) known.add(v);
  }
  for (const wf of Array.isArray(workflows) ? workflows : [workflows]) {
    if (!wf || !Array.isArray(wf.nodes)) continue;
    for (const n of wf.nodes) {
      const code = n && n.parameters && n.parameters.jsCode;
      if (!code) continue;
      for (const s of SECRETS) {
        const v = _liveSecret(code, s.varName);
        if (v) known.add(v);
      }
    }
  }
  return [...known].filter((v) => v.length >= 6); // never scrub trivial strings
}

// Returns a scrubbed COPY safe to write to disk (snapshots kept out of git by
// .backbrief/ gitignore anyway — this is defense in depth). Three guards:
//  1. Drop `activeVersion`/`activeVersionId` — read-only fields embedding a
//     FULL duplicate of the workflow (second copy of every secret).
//  2. Drop `staticData` + `pinData` — volatile runtime state (recording dedup
//     keys, pending task drafts with real content) — not part of the
//     workflow DEFINITION and must never be committed.
//  3. Replace every known secret VALUE (computed, see COLLECT_KNOWN_SECRETS)
//     and every known secret SHAPE with a placeholder.
// Idempotent.
function SECRET_SCRUB(wf, knownSecrets) {
  const clone = JSON.parse(JSON.stringify(wf));
  delete clone.activeVersion;
  delete clone.activeVersionId;
  delete clone.staticData;
  delete clone.pinData;
  let text = JSON.stringify(clone);
  for (const v of Array.isArray(knownSecrets) ? knownSecrets : []) {
    if (!v || v.length < 6) continue;
    text = text.split(JSON.stringify(v).slice(1, -1)).join('__BACKBRIEF_SCRUBBED_SECRET__');
  }
  for (const re of SECRET_SHAPES) {
    text = text.replace(re, '__BACKBRIEF_SCRUBBED_SECRET__');
  }
  return JSON.parse(text);
}

/* ------------------------------------------------------------------ */

module.exports = {
  WORKFLOWS,
  DEPLOY_ORDER,
  SKELETON_VERSION_KEY,
  SKELETON_PLACEHOLDER_MARK,
  TENANT_REGIONS,
  PARAM_TOKENS,
  SECRETS,
  SECRET_SHAPES,
  _liveSecret,
  INJECT_SECRETS,
  NORMALIZE_SECRETS,
  COLLECT_KNOWN_SECRETS,
  SECRET_SCRUB,
};

if (require.main === module) {
  for (const [key, wf] of Object.entries(WORKFLOWS)) {
    console.log(`${key}  (${wf.label})`);
    console.log(`  skeleton: ${wf.skeleton}`);
    console.log(`  codeDir : ${wf.codeDir || '(none — inline glue only)'}`);
    for (const [node, file] of Object.entries(wf.nodeFileMap)) {
      console.log(`    ${node}  <-  ${file}`);
    }
    for (const node of wf.inlineOnlyCodeNodes) console.log(`    ${node}  (inline-only)`);
  }
  console.log(`\nregions: ${TENANT_REGIONS.join(', ')}`);
  console.log(`secrets: ${SECRETS.map((s) => s.label).join(' | ')}`);
}
