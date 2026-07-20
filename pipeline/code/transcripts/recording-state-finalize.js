// SPDX-License-Identifier: BUSL-1.1
// Phase 2 finalize — marks the recording as fully processed (Phase 1 root +
// Phase 2 thread reply + vault commit all done) by stamping
// `phase2_completed_at` in the workflow static-data map.
//
// Any subsequent webhook for the same zoom_meeting_uuid will hit
// recording-state-lookup and resolve to mode 'skip_phase2_duplicate' → empty
// emit → workflow ends without firing any Slack/GitHub side-effects.
//
// Placed after Slack thread reply, before STUB-I metrics.

const data = $getWorkflowStaticData('global');
const j = $input.first().json;
const uuid = j.zoom_meeting_uuid || '';

if (!uuid) {
  return [{ json: { ...j, __finalize_skipped: 'no zoom_meeting_uuid' } }];
}

data.recordings = data.recordings || {};
const existing = data.recordings[uuid] || {};

// V1.8 (P0-3, 2026-07-02): do NOT stamp phase2_completed_at on the error
// branch. Previously an error-branch thread reply still finalized the record,
// so recording-state-lookup returned skip_phase2_duplicate on the Zoom retry
// and a failed call could never self-heal (observed on exec 966, Anthropic-500).
// Error runs keep the record open — a Zoom retry re-drives the pipeline; the
// already-committed case is safe because the retry lands on the duplicate
// branch (and phase2_committed_at records the commit fact for redrive).
if (j.__branch === 'error') {
  data.recordings[uuid] = {
    ...existing,
    phase2_error_at: new Date().toISOString(),
    vault_path: j.vault_path || existing.vault_path || null,
  };
  return [{ json: { ...j, __phase2_finalized: false, __finalize_skipped: 'error branch — record left open for retry' } }];
}

data.recordings[uuid] = {
  ...existing,
  phase2_completed_at: new Date().toISOString(),
  vault_path: j.vault_path || existing.vault_path || null,
  github_commit_sha: j.commit?.sha || j.github_body_response?.commit?.sha || existing.github_commit_sha || null,
};

// V1.4 — TTL cleanup. Without this, the recordings map grows unbounded over months
// and bloats the workflow JSON (each entry ~200 bytes; after 5k calls = ~1 MB).
// V1.5.26 (P2-5 fix): also purge Phase-1-only entries (transcript never arrived).
// Previously these lived forever because phase2_completed_at was never set,
// so the TTL check skipped them.
const TTL_DAYS_COMPLETED   = 30;  // Phase 2 finished — audit window
const TTL_DAYS_PHASE1_ONLY = 7;   // transcript never came — give up after a week
const now = Date.now();
const cutoffCompleted = now - TTL_DAYS_COMPLETED   * 24 * 3600 * 1000;
const cutoffPhase1    = now - TTL_DAYS_PHASE1_ONLY * 24 * 3600 * 1000;
let purged_completed = 0, purged_phase1_only = 0;
for (const [k, v] of Object.entries(data.recordings)) {
  if (!v) { delete data.recordings[k]; continue; }
  const completedAt = v.phase2_completed_at ? Date.parse(v.phase2_completed_at) : null;
  const phase1At    = v.phase1_completed_at ? Date.parse(v.phase1_completed_at) : null;
  if (completedAt && completedAt < cutoffCompleted) {
    delete data.recordings[k]; purged_completed++;
  } else if (!completedAt && phase1At && phase1At < cutoffPhase1) {
    delete data.recordings[k]; purged_phase1_only++;
  }
}
if (purged_completed + purged_phase1_only > 0) {
  console.log(`[finalize] purged ${purged_completed} completed (>${TTL_DAYS_COMPLETED}d) + ${purged_phase1_only} phase1-only (>${TTL_DAYS_PHASE1_ONLY}d) recording-state entries`);
}
const purged = purged_completed + purged_phase1_only;

return [{ json: { ...j, __phase2_finalized: true, __state_purged: purged } }];
