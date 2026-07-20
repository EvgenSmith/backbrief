// SPDX-License-Identifier: BUSL-1.1
// Recording state — mark committed. V1.8 (P0-3, 2026-07-02).
//
// Runs IMMEDIATELY after "Merge GitHub response" (before Switch on status /
// any Slack node), so the state map records the vault-commit fact even if
// everything downstream (Slack root post, thread replies) fails. This is the
// red-team (c) requirement of the commit-before-Slack reorder: without it, a
// post-commit Slack failure would leave no durable record that the artifact
// IS already in the vault, and redrive tooling couldn't tell "lost" from
// "committed but unannounced".
//
// Does NOT change recording-state-lookup skip semantics (phase2_completed_at
// stays the only skip key): a Zoom retry after commit-but-Slack-failure will
// re-run and re-commit — Git Data with base_tree makes that an identical-tree
// commit (harmless) and the retry is the self-heal path for the Slack posts.

const data = $getWorkflowStaticData('global');
const j = $input.first().json;
const uuid = j.zoom_meeting_uuid || '';

if (uuid && j.github_statusCode >= 200 && j.github_statusCode < 300) {
  data.recordings = data.recordings || {};
  const existing = data.recordings[uuid] || {};
  data.recordings[uuid] = {
    ...existing,
    phase2_committed_at: new Date().toISOString(),
    vault_path         : j.vault_path || existing.vault_path || null,
    github_commit_sha  : j.github_commit_sha || existing.github_commit_sha || null,
  };
}

return $input.all();
