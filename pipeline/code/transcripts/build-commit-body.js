// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — "Build commit body" (atomic Git-Data commit, step 2 of 3).
//
// Extracted verbatim from the inline workflow node so it gains drift coverage.
// Tenant-agnostic: the commit message is built upstream ("Build GitHub body"),
// repo coordinates live on the HTTP nodes.
//
// Guard + build the create-commit body. HARD-FAILS if create-tree returned no
// sha (so we never commit a tree we don't have).
const resp = $input.first().json;            // GH create tree (fullResponse)
const newTreeSha = resp.body && resp.body.sha;
if (!newTreeSha) {
  throw new Error('atomic-commit: create-tree returned no sha (status ' + resp.statusCode + '; body ' + JSON.stringify(resp.body).slice(0,300) + ')');
}
const prev = $('Build tree body').first().json;
return [{ json: {
  ...prev,
  __new_tree_sha    : newTreeSha,
  github_commit_body: {
    message: prev.github_commit_message,
    tree   : newTreeSha,
    parents: [prev.__base_commit_sha],
  },
} }];
