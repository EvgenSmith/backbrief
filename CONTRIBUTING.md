<!-- SPDX-License-Identifier: MIT -->
# Contributing to Backbrief

## Licensing split (read this first)

This repository ships under two licenses (see `README.md` → Licensing):

| Path | License | SPDX identifier |
|---|---|---|
| `pipeline/**` | Business Source License 1.1 (`pipeline/LICENSE`) | `BUSL-1.1` |
| everything else (root files, `plugin/**`, `gateway/**`, `docs/**`, `.github/**`) | MIT (root `LICENSE`) | `MIT` |

By contributing you agree that your contribution is licensed under the license
that governs the path it lands in.

## SPDX header convention

Every source file that supports comments carries an SPDX license identifier as
its **first line** (second line if the file starts with a shebang), matching
the table above.

Formats per file type:

```js
// SPDX-License-Identifier: MIT            (.js — plugin/, gateway/)
// SPDX-License-Identifier: BUSL-1.1       (.js — pipeline/code/**)
```

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: MIT             (.sh — after the shebang)
```

```yaml
# SPDX-License-Identifier: MIT             (.yaml / .yml / .toml / .toml.example)
```

```markdown
<!-- SPDX-License-Identifier: MIT -->      (.md — invisible when rendered)
```

Exemptions (files that cannot or should not carry a header):

- `*.json` — JSON has no comments; JSON files are licensed by path per the
  table above. Do not add pseudo-comment keys for this.
- `LICENSE`, `pipeline/LICENSE` — they *are* the license texts.
- `VERSION` — single-line SemVer value, machine-read.
- Vault templates under `plugin/templates/vault-skeleton/` and
  `plugin/templates/frontmatter/` — these are copied verbatim into user vaults;
  a kit license header inside a user's own document would be wrong. They are
  MIT by path.
- Synthetic fixtures under `pipeline/fixtures/` (JSON anyway) — BUSL-1.1 by path.

CI lints SPDX headers against path (`spdx-lint` job in
`.github/workflows/ci.yml`); a missing or path-mismatched identifier fails the
build.

## Version & release rules

- `VERSION` (root, SemVer) is the single source of truth. It must equal
  `plugin/.claude-plugin/plugin.json .version` and the release tag `vX.Y.Z` —
  the `version-consistency` CI job enforces this.
- Every user-visible change gets a `CHANGELOG.md` entry
  ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format).
- Release: bump `VERSION` + `plugin.json` + changelog in one PR → tag `vX.Y.Z`
  → GitHub Release with the changelog excerpt.

## Hard hygiene rules

- **No secrets, ever** — not in code, not in fixtures, not in tenant examples.
  Placeholders (`__*_PLACEHOLDER__`) only. `sanitize-check.sh` and secret
  scanning run in CI on every PR.
- **No real-tenant data** — fixtures use fictional teams only. Anything that
  looks like a real person, company coordinate, or live workflow ID fails the
  sanitize gate.
- Procedures (`plugin/procedures/*.md`) are the single source of truth for
  skill logic; `plugin/skills/*/SKILL.md` files are thin wrappers (≤40 lines,
  no procedure steps) — the procedure-sync CI lint enforces the split.
