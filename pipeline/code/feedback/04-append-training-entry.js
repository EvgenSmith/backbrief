// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — "Append training entry" (feedback collector, stage 4).
// Mode: Run Once for Each Item.
//
// Persist the parsed feedback as one JSONL line in the vault repo's training
// log (output path → vault.training_data_path, default
// .backbrief/training/feedback.jsonl — one training/ home shared with the
// A3 task-decisions log; training data stays committed — it is the team's asset).
//
// GitHub contents API read-modify-write on a single small file. A lost race
// (409/422 on concurrent update) is retried once with a fresh sha; a second
// failure only skips THIS training line — the digest post and the processed
// reaction still happen (training capture is best-effort by design, the
// Slack thread remains the source it can be rebuilt from).
//
// Degrades gracefully to a no-op (with a loud log line) when the vault repo
// is not wired (Phase A local-only vault) or the PAT was not injected.

// ── __TENANT_ROUTING_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const TENANT_NAME = 'Acme Robotics';
const KIT_VERSION = '0.1.0';
const REPO_OWNER = ''; // empty until B4 wires vault.repo
const REPO_NAME = '';
const BRANCH = 'main';
const PROFILES_FOLDER = 'team';
const SUMMARIZER_SKILL_PATH = 'docs/skills/summarizer.md';
const COMPANY_PROFILE_PATH = 'docs/company.md'; // company profile (born at A0) — size-capped context injection
const DLQ_FOLDER = 'pipeline/dlq';
const TRAINING_DATA_PATH = '.backbrief/training/feedback.jsonl'; // feedback training log (JSONL)
const TEAM_TO_FOLDER = {
  engineering: 'engineering/transcripts/',
  growth: 'growth/transcripts/',
  mixed: 'general/transcripts/',
  product: 'product/transcripts/',
};
const SUB_TAG_FOLDER = {};
const TRACKER_TO_VAULT_TEAM = {
  ENG: 'engineering',
  GRW: 'growth',
  PRD: 'product',
};
const LINEAR_TO_VAULT_TEAM = TRACKER_TO_VAULT_TEAM; // prod const name kept for diff reviewability
const VALID_TEAM = new Set(['engineering', 'growth', 'mixed', 'product']);
const VALID_SUB_TAG = new Set([]); // null also allowed
const VALID_SUB_FOR_TEAM = {
};
const GUESS_FOLDER_TABLE = [ // heuristic prior-context prefetch — wrong guess degrades gracefully
  { re: /product|roadmap|spec|pricing|launch/i, folder: 'product/transcripts/' },
  { re: /engineering|deploy|bug|api|firmware/i, folder: 'engineering/transcripts/' },
  { re: /growth|campaign|lead|partnership|funnel/i, folder: 'growth/transcripts/' },
];
const MIXED_FOLDER = 'general/transcripts/';
const RAW_RETENTION = 'vtt'; // none | vtt | vtt_mp4
// ── __TENANT_ROUTING_END__ ──

const GITHUB_PAT = '__GITHUB_PAT_PLACEHOLDER__';

const j = $json;
if (j.__skip || j.__error) {
  return { json: { ...j, __training_appended: false, __training_skip_reason: j.__error || j.__skip_reason } };
}

if (!REPO_OWNER || !REPO_NAME || GITHUB_PAT.includes('PLACEHOLDER')) {
  console.log('[fb-collector] vault repo or PAT not wired — skipping training append (digest + reaction still proceed)');
  return { json: { ...j, __training_appended: false, __training_skip_reason: 'vault_not_wired' } };
}

const entry = {
  collected_at: new Date().toISOString(),
  channel: j.channel,
  thread_ts: j.thread_ts,
  tc_message_ts: j.tc_message_ts,
  human_replies_count: j.human_replies_count || 0,
  per_proposal: (j.parsed_feedback && j.parsed_feedback.per_proposal) || [],
  global_signals: (j.parsed_feedback && j.parsed_feedback.global_signals) || [],
  kit_version: KIT_VERSION,
};
const line = JSON.stringify(entry) + '\n';

const apiBase = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${TRAINING_DATA_PATH}`;
const headers = {
  Authorization: `Bearer ${GITHUB_PAT}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'backbrief-pipeline',
};

async function readCurrent() {
  try {
    const res = await this.helpers.httpRequest({
      method: 'GET', url: `${apiBase}?ref=${encodeURIComponent(BRANCH)}`,
      headers, json: true, returnFullResponse: true, ignoreHttpStatusErrors: true,
    });
    if (res.statusCode === 404) return { sha: null, text: '' };
    if (res.statusCode >= 300) throw new Error(`GET ${TRAINING_DATA_PATH} → HTTP ${res.statusCode}`);
    const body = res.body || {};
    const text = Buffer.from(String(body.content || ''), 'base64').toString('utf8');
    return { sha: body.sha || null, text };
  } catch (e) {
    if (String(e.message || '').includes('404')) return { sha: null, text: '' };
    throw e;
  }
}

async function putAppend(attempt) {
  const cur = await readCurrent.call(this);
  // Idempotency: skip when this tc_message_ts already has a line (a retried
  // execution or an overlapping schedule run must not duplicate entries).
  if (cur.text.includes(`"tc_message_ts":${JSON.stringify(entry.tc_message_ts)}`)) {
    console.log(`[fb-collector] training entry for ts=${entry.tc_message_ts} already present — skipping append`);
    return { appended: false, reason: 'already_present' };
  }
  const put = await this.helpers.httpRequest({
    method: 'PUT', url: apiBase, headers, json: true,
    returnFullResponse: true, ignoreHttpStatusErrors: true,
    body: {
      message: `sync: feedback training entry (thread ${entry.thread_ts})`,
      content: Buffer.from(cur.text + line, 'utf8').toString('base64'),
      branch: BRANCH,
      ...(cur.sha ? { sha: cur.sha } : {}),
    },
  });
  if (put.statusCode >= 200 && put.statusCode < 300) return { appended: true };
  if ((put.statusCode === 409 || put.statusCode === 422) && attempt === 0) {
    console.warn(`[fb-collector] training append lost a race (HTTP ${put.statusCode}) — retrying with fresh sha`);
    return putAppend.call(this, 1);
  }
  throw new Error(`PUT ${TRAINING_DATA_PATH} → HTTP ${put.statusCode}: ${JSON.stringify(put.body).slice(0, 200)}`);
}

return (async () => {
  let result;
  try {
    result = await putAppend.call(this, 0);
  } catch (e) {
    console.warn(`[fb-collector] training append failed (non-fatal): ${e.message}`);
    return { json: { ...j, __training_appended: false, __training_skip_reason: String(e.message).slice(0, 200) } };
  }

  return { json: { ...j, __training_appended: result.appended === true } };
})();
