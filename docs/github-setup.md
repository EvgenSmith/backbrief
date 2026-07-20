<!-- SPDX-License-Identifier: MIT -->
# GitHub vault repo setup (deploy step B4, ~5 minutes)

The vault is plain markdown; **git is what makes it durable, portable, and
agent-readable memory** — history, diffs, backup, and access control you own. In Phase B
the pipeline writes every call file through the GitHub API as an **atomic commit**
(`.md` digest + `.vtt` transcript in one tree — a partial write is impossible).

Skippable: no GitHub → `vault.repo: null` stays. This is the heaviest skip: the automatic
pipeline runs remotely and cannot write files to your laptop, so **automatic vault
commits turn off** (Slack digests and tracker tasks still work; manual Phase-A filing
keeps working locally). The skip is recorded in your vault's `.backbrief/roadmap.md`
with the resume command. Using GitLab or another git host? Say so during deploy — it
goes on the connector waitlist.

## Step 1 — create the repo (or pick an existing one)

- Recommended: a **new private repository** dedicated to the vault, e.g.
  `acme/team-vault`. The deploy procedure offers to create and push it for you.
- Reusing an existing repo works too — the vault skeleton lives at the repo root; the
  pipeline only ever writes into the configured team folders, `tasks/`, and its
  own `pipeline/dlq/`.

Push your Phase-A vault into it (the deploy procedure runs the `git init/remote/push`
with you). Then record it in `tenant.yaml`:

```yaml
vault:
  repo: acme/team-vault
  branch: main
```

## Step 2 — create a fine-grained personal access token

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token**:

| Setting | Value |
|---|---|
| Resource owner | the org/user that owns the vault repo |
| Repository access | **Only select repositories** → your vault repo (never "All") |
| Permissions | **Contents: Read and write** — that is the only permission the pipeline needs |
| Expiration | pick one you'll actually honor — and note it (see below) |

Copy it into `.backbrief/secrets.env`:

```bash
GITHUB_VAULT_PAT=...
```

**Set a renewal reminder now.** Production lesson: an expired PAT doesn't announce
itself — vault commits start failing with 401, calls pile up in the DLQ, and the digest
thread just quietly loses its "vault" link. When the token expires: issue a new one,
update `secrets.env`, re-run `node plugin/scripts/deploy-pipeline.js` (secrets are
injected at deploy).

## Step 3 — verify (live test, required)

```bash
node plugin/scripts/test-creds.js github
```

Proves: the PAT authenticates, it can read `vault.repo`/`vault.branch`
(`GET /commits/{branch}`), Git-Data write permission is present, and your Phase-A push
actually landed. It also confirms the vault's `.gitignore` excludes
`.backbrief/secrets.env` — a secrets file must never be committable.

## Who sees what (read before inviting collaborators)

- **Everyone with read access to the repo sees every filed transcript.** v0.1 has no
  privacy routing — there are no private slices; the whole vault is one shared surface.
  Keep the repo private and grant collaborators deliberately. Don't feed calls you
  would not share with the whole repo audience (`docs/privacy-and-consent.md`).
- **Git history is retroactive.** Anything ever committed stays visible to everyone you
  later add — a later cleanup does not un-share it.
- Need 1:1/board/legal calls auto-routed into separately-permissioned slices? That is
  the privacy-routing feature — deliberately not in v0.1; say so during setup
  (waitlist interest: privacy) and it gets prioritized by real demand.

## How the pipeline writes (for the curious)

One Git-Data sequence per call: get base commit → create tree (`.md` + `.vtt` as
siblings) → create commit → update ref with `force: false`. A concurrent-write race
returns 422 and is treated as "already committed" — never a clobber. Failures land in a
durable DLQ (`pipeline/dlq/<date>/` in the repo) recoverable with
`node plugin/scripts/redrive-dlq.js`. Details: `PRD.md` §4b, §8.
