// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — "Build ref body" (atomic Git-Data commit, step 3 of 3).
//
// Extracted verbatim from the inline workflow node so it gains drift coverage.
// Tenant-agnostic.
//
// Guard + build the update-ref body. HARD-FAILS if create-commit returned no
// sha. force:false ⇒ GitHub rejects a non-fast-forward (concurrent commit race)
// with 422 instead of clobbering — the orphan commit is harmless and the next
// run/retry rebases on fresh HEAD.
const resp = $input.first().json;            // GH create commit (fullResponse)
const newCommitSha = resp.body && resp.body.sha;
if (!newCommitSha) {
  throw new Error('atomic-commit: create-commit returned no sha (status ' + resp.statusCode + '; body ' + JSON.stringify(resp.body).slice(0,300) + ')');
}
const prev = $('Build commit body').first().json;
return [{ json: {
  ...prev,
  __new_commit_sha: newCommitSha,
  github_ref_body : { sha: newCommitSha, force: false },
} }];
