// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — "Build tree body" (atomic Git-Data commit, step 1 of 3).
//
// Extracted verbatim from the inline workflow node (drift coverage: the three
// Git-Data "Build … body" nodes move to files so they gain drift coverage;
// the atomic-commit design itself is inherited stack knowledge and ships
// untouched). Fully tenant-agnostic: repo coordinates live on the adjacent
// HTTP nodes ("GH get base" / "GH create tree"), not here.
//
// Guard + build the create-tree request body.
// HARD-FAILS (no continueOnFail) when the base commit/tree sha is missing. This
// is the safety gate: it guarantees a tree is never POSTed without base_tree
// (which would create a commit whose tree holds ONLY our files, deleting the
// rest of the repo). Nothing is written to the branch until "GH update ref".
const resp = $input.first().json;            // GH get base (fullResponse)
const baseTreeSha   = resp.body && resp.body.commit && resp.body.commit.tree && resp.body.commit.tree.sha;
const baseCommitSha = resp.body && resp.body.sha;
if (!baseTreeSha || !baseCommitSha) {
  throw new Error('atomic-commit: missing base sha (status ' + resp.statusCode + '; body ' + JSON.stringify(resp.body).slice(0,300) + ')');
}
const src = $('Build GitHub body').first().json;
if (!Array.isArray(src.github_tree) || src.github_tree.length === 0) {
  throw new Error('atomic-commit: github_tree missing/empty');
}
return [{ json: {
  ...src,
  __base_commit_sha: baseCommitSha,
  __base_tree_sha  : baseTreeSha,
  github_tree_body : { base_tree: baseTreeSha, tree: src.github_tree },
} }];
