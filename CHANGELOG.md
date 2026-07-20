<!-- SPDX-License-Identifier: MIT -->
# Changelog

All notable changes to the Backbrief kit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The single source of truth for the current version is the `VERSION` file;
`plugin/.claude-plugin/plugin.json` and the release git tag `vX.Y.Z` must match
it (CI-enforced).

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
