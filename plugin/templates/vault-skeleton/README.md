<!--
  Backbrief template — vault root README. Rendered by init-vault.js at A0:
  `<Company>` <- tenant.name, `<Owner-Lastname>` <- roster entry with
  is_owner: true (omit the owner line when unset at init), `<KitRepoURL>` <-
  the kit repo URL (REPO_URL constant in init-vault.js).
  Team folders in this skeleton (product/, engineering/, growth/) are the
  golden-path defaults — init-vault.js creates one folder per tenant.yaml
  vault.teams[] entry instead when the tenant defines its own teams.
  tenant.yaml itself is written by init-vault.js, not shipped in the skeleton.
-->
# <Company> call-memory vault

What this is, in five lines:

1. Every team call lands here as one markdown file: structured frontmatter +
   a context digest (what happened, what was decided, who owes what, by when) —
   maintained by [Backbrief](<KitRepoURL>).
2. **Owner:** <Owner-Lastname>. Configuration lives in `tenant.yaml`; the rules
   any agent must follow live in [`AGENTS.md`](AGENTS.md) — **read that first**.
   The full grammar and the why behind each rule: [`docs/conventions.md`](docs/conventions.md).
3. Calls file into `<team>/transcripts/` by team; `general/` catches cross-team
   calls. (No privacy routing in v0.1 — every call is team-shared; ask for
   "privacy" on the waitlist if you need private slices.)
4. `team/` holds one profile per person (`<Lastname>.md`); `tasks/` holds the
   per-call task artifacts and tracker backlinks.
5. Navigation is frontmatter-first: `rg 'team: product' --glob '**/transcripts/*.md'`
   beats browsing folders — recipes are in `AGENTS.md`.

Growing the vault: add teams in `tenant.yaml` (`vault.teams[]`) and re-run the
validator with `--fix`; per-team subfolders (`decisions/`, `docs/`) are created
the day the first file needs them — no empty scaffolding.

Setup steps you deferred (and how to resume each) live in
[`.backbrief/roadmap.md`](.backbrief/roadmap.md); frontmatter templates your
own agents can copy from live in `docs/templates/`.
