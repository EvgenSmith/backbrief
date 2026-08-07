<!-- SPDX-License-Identifier: MIT -->
# Changelog

All notable changes to the Backbrief kit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The single source of truth for the current version is the `VERSION` file;
`plugin/.claude-plugin/plugin.json` and the release git tag `vX.Y.Z` must match
it (CI-enforced).

## [Unreleased]

### Fixed — vault context loader: three defects that were invisible by construction

The loader is best-effort by design — every fetch failure degrades to null and is
skipped — so "this vault has no context" and "this loader is broken" looked
identical from outside. An audit against a defect class found in a sibling
production pipeline turned up three real ones:

- **Prior summaries never reached the prompt.** The extractor anchored on
  `## Summary`, but the pipeline writes `## Summary (Quick brief)`
  (`build-commit-payload-v2.js`). Files downloaded fine and parsed to null, so the
  channel was dead for every pipeline-filed call while still working for
  manually-filed ones. Section slicing is now index arithmetic rather than a
  regex — the obvious regex fix reads as correct and is not (under `/m` the `$`
  alternative matches end-of-line, silently truncating the summary to one line).
- **The enriched roster had two consumers reading different things.** The Zoom
  roster fetch exists because the webhook carries only the host; team profiles
  used the enriched roster while tracker context still read the raw seed, so open
  issues were fetched for one person on a call of eight. The enriched roster is
  also exported now (`participants_lastnames_enriched`) — under its own key, not
  overwriting the seed that upstream routing already ran on.
- **Injection was unbounded and scaled with the input.** One profile per
  participant, injected whole, capped nowhere; measured at 130 KB in one prompt.
  Per-channel and per-set caps now apply, and every clip is recorded in
  `truncated[]` so a clipped prompt is not mistaken for a small one.

### Added — telling "empty" apart from "broken"

- `__vault_context_meta` now carries `context_empty` (the one field worth alerting
  on), `channels[]` with per-channel status, and `prior_unparsed` — documents that
  downloaded but did not parse, which no empty vault can ever explain.
- `pipeline/tests/vault-context.test.js` — the loader executed for real against a
  mocked GitHub/Zoom/Linear, asserting on prompt content. The e2e suite stubs this
  node out because its fetches are live; that gap is how the sibling pipeline kept
  a green suite while three channels were down.

### Fixed — Zoom setup friction (the two clicks that fail silently)
- **"Add download token" is now a named, explained step**, not a line lost in a
  checklist. Unticked, Zoom sends no download token: every `.vtt` fetch 401s while the
  webhook, the Slack post and the vault commit all still look healthy. The pipeline now
  carries `download_token_present` from the event, and the failure alert names *that*
  cause and its one-checkbox fix instead of blaming the 24 h URL expiry — which was the
  wrong advice on every fresh setup.
- **`deploy-pipeline.js --crc`** — dry-runs Zoom's `endpoint.url_validation` handshake
  against your own webhook before you click **Validate** in the Zoom UI. Read-only. Zoom
  reports all three of its failure modes as one silent spinner; this names which it is
  (unreachable URL / inactive workflow / secret in n8n ≠ secret in the app).
- **`test-creds.js zoom` now states what it cannot see.** The event subscription is not
  exposed by any Zoom API for S2S apps, so a green credential probe was being read as
  "Zoom is fully wired". It now says which facts only a real test call can confirm.
- `docs/zoom-s2s-setup.md` opens with the whole setup as a click path; `deploy.md` B2/B6
  call out both silent-failure clicks and run `--crc` before sending you back to Zoom.

## [0.1.0] — 2026-07-20 — first public release

Opinionated kit for turning recorded calls into a team-owned context vault, task
proposals, and Slack digests — pre-wired for one recommended stack (Zoom + Google
Drive + Git + Linear + Slack + n8n + your own Anthropic key), designed to be adapted
to yours.

### Phase A — plugin skills (Claude Code / AGENTS.md agents)
- Guided setup (`start`), team profiles (`profiles`), tasks with live-backlog dedup
  (`tasks`), pipeline deploy (`deploy`), status + deferred-steps roadmap (`status`).
- Adaptive vault: solo / team-lead / company-lead persona shapes the folder layout;
  vault-shipped conventions + templates so your own agents inherit the contract.
- Company profile drafted from your answers + (optional) your website; feeds
  summarization, task extraction, and the glossary.

### Phase B — guided pipeline deploy (B0–B8) on your own n8n
- Zoom → summarize → commit to vault → Slack digest → task proposals → Linear;
  optional Drive archive. Every step is our-stack / skip / your-own-tool / do-it-for-me.

### Not in v0.1 (stated up front)
- Privacy/sensitivity routing (every call files to a team folder + digest channel).
- Autonomy levels L1/L2 (ships L0 — every task proposal needs a click).
- Trackers other than Linear (waitlist + adapt-the-skeleton).

### Licensing
- Root MIT (plugin + templates); `pipeline/` Business Source License 1.1 (self-hosted
  production permitted, hosted/managed resale prohibited; Change License Apache-2.0).
