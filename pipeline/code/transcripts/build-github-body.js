// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — prepares an ATOMIC multi-file GitHub commit via the Git Data
// API (create tree → create commit → update ref). Emits exactly ONE item.
//
// V2 (Fix A, 2026-06-24) — REPLACES the old Contents-API approach that emitted
// TWO items (.md + .vtt) and did TWO separate PUTs. Those two PUTs targeted the
// same branch back-to-back; the second one raced the first and GitHub returned
//   409 "is at <newSha> but expected <oldSha>"
// so the .vtt was silently dropped (continueOnFail swallowed it, and the old
// Merge node only read .first() — the .md — so the loss was invisible).
// Ground truth: exec 982, lp-onchain 2026-06-23 — .md=201, .vtt=409.
//
// Now: ONE commit carries BOTH files. There is no second write to race, so the
// .md and .vtt either both land or neither does (true atomicity per call).
//
// Output item ($json):
//   ...original payload (filename, vault_path, github_url, summary, etc.)
//   __file_kind            : 'md'        (kept so downstream filters stay valid)
//   github_commit_message  : commit subject
//   github_tree            : [ {path, mode, type, content}, ... ]  ← inline UTF-8
//   github_files_count     : 1 or 2
// The downstream HTTP nodes read github_tree / github_commit_message; the file
// contents are inlined as decoded UTF-8 text (tree entries accept `content`),
// which avoids a separate blob POST per file.

const items = $input.all();
const out = [];

for (const it of items) {
  const j = it.json;
  if (!j.filename || !j.content_b64 || !j.vault_path) {
    throw new Error(`build-github-body: missing payload fields (filename/content_b64/vault_path). got ${JSON.stringify(Object.keys(j))}`);
  }

  // Primary .md (vault summary). Tree entries take raw UTF-8 in `content`.
  const tree = [{
    path   : j.vault_path,
    mode   : '100644',
    type   : 'blob',
    content: Buffer.from(j.content_b64, 'base64').toString('utf8'),
  }];

  let commitMsg = `sync: file transcript ${j.filename.replace(/\.md$/, '')}`;

  // Sibling .vtt (raw transcript) — included in the SAME commit when present.
  if (j.transcript_content_b64 && j.transcript_vault_path && j.transcript_filename) {
    tree.push({
      path   : j.transcript_vault_path,
      mode   : '100644',
      type   : 'blob',
      content: Buffer.from(j.transcript_content_b64, 'base64').toString('utf8'),
    });
    commitMsg += ' (+ raw transcript)';
  }

  out.push({
    json: {
      ...j,
      __file_kind          : 'md',
      github_commit_message: commitMsg,
      github_tree          : tree,
      github_files_count   : tree.length,
    },
  });
}

return out;
