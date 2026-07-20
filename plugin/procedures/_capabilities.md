<!-- SPDX-License-Identifier: MIT -->
# Backbrief procedures — capability bindings

> Procedures name **capabilities**, never vendor tools. This file binds
> each capability to the best tool available in the current session. Read it (together
> with `_conventions.md`) before executing any procedure.

## How to bind

1. At the start of a skill, resolve every capability the procedure uses:
   **Preferred** column if that tool is available in this session → else **CLI fallback**
   → else the **Absent →** behavior (a flag, a degradation sentence, or a hard prereq).
2. Claude Code wrappers (`plugin/skills/*/SKILL.md`) may override rows with richer
   session-specific tools (e.g. a connected MCP server). Codex and other `AGENTS.md`
   agents use the CLI-fallback column throughout.
3. Path resolution: under a Claude marketplace install, scripts live at
   `${CLAUDE_PLUGIN_ROOT}/scripts/`; under a cloned repo (Codex or manual), use
   repo-relative `plugin/scripts/`.
4. Secrets come from the user's environment or `.backbrief/secrets.env` (gitignored,
   `chmod 600`). Never echo them, never commit them, never write them into `tenant.yaml`
   (`validate-tenant.js` hard-fails on token-shaped values).

## Capability → tool binding table

| Capability | Purpose | Preferred (Claude MCP / built-in) | CLI fallback (any agent) | Absent → |
|---|---|---|---|---|
| `fs.read` / `fs.write` / `fs.edit` | vault files, templates, state | built-in Read/Write/Edit tools | any shell file tooling | hard prereq — an agent without file access cannot run Backbrief |
| `run.script(name, args)` | validators / deploy / creds | Bash: `node plugin/scripts/<name> …` | same | hard prereq — Node ≥ 18 is checked at A0 |
| `git.commit(paths, msg)` | vault persistence | Bash `git` | `git` | Phase-A vault is still local files (fine) |
| `slack.post(channel, blocks)` | digests, task buttons | Slack MCP send-message tool | `curl https://slack.com/api/chat.postMessage` with `$SLACK_BOT_TOKEN` | flag `features.slack.enabled: false`; digest stays in vault |
| `slack.users()` | roster for profiles (A2) | Slack MCP users-list tool | `curl https://slack.com/api/users.list` | fall to tracker → docs → 5-question form (A2 source chain) |
| `tracker.search(query, team)` | dedup vs live backlog (A3) | Linear MCP | Linear GraphQL via `curl https://api.linear.app/graphql` with `$LINEAR_API_TOKEN` | `tasks.md` file-only mode + waitlist note |
| `tracker.create` / `tracker.comment` | write task verdicts (A3) | Linear MCP | Linear GraphQL mutation via `curl` | copy-paste blocks in `tasks.md` |
| `telemetry.event(e)` / `telemetry.waitlist(…)` | opt-in pings, demand capture | `run.script(telemetry.js …)` | same | silently no-op when disabled (`_conventions.md` §7) |
| `web.fetch(url)` | update check, docs lookups, company-site fetch (A0.9) | WebFetch (or equivalent) | `curl` | update check skipped + A0.9 site enrichment skipped with one line; warn once |

Notes (v0.1 adopted scope — do not re-open in dialogue):

- **Connectors ship for our stack only** (Zoom, Google Drive, Git/GitHub, Linear, Slack,
  n8n, Anthropic). **Any other tracker (Jira included)** → `features.tracker.kind: other`,
  file-only tasks + connector waitlist; the honest own-tool pointer is "adapt the
  skeleton" (`PRD.md`). No foreign-tool adapters or setup guides ship.
- **GitLab / other git hosting is waitlist-only** at B4 (`vault.repo: null`, local-only
  vault; capture demand per `_conventions.md` §8).
- **Privacy routing is not in v0.1** — requests for private 1:1/board/legal handling are
  demand: `state.js waitlist-observe privacy` + `telemetry.js waitlist --interest=privacy`
  on a typed email.

## Script inventory — `plugin/scripts/` (which script does what)

Conventions (every script follows them; `--help` on each): Node ≥ 18, **zero npm dependencies** (global `fetch`, stdlib
only), `--help` on every script, `DRY_RUN=1` supported wherever a write happens. Exit
codes: `0` ok · `1` check failed (show the findings, offer fixes) · `2` operational error
(apply the error tone, `_conventions.md` §10).

| Script | Ladder step | Purpose | Env / inputs |
|---|---|---|---|
| `state.js get\|set <key> [value]` | all | read/write `.backbrief/state.yaml` safely (rung progress, stack map, resume points) | — |
| `init-vault.js <path>` | A0 | vault skeleton + minimal `tenant.yaml` from `plugin/templates/vault-skeleton/` (create-if-missing, idempotent) | target path |
| `validate-vault.js` | A0/A1/status | vault conventions lint — naming grammar, frontmatter, digest sections, profiles (contract: the vault's own `docs/conventions.md`, rendered from `plugin/templates/vault-skeleton/`; `--legacy-names` grandfathers imported filenames) | vault path |
| `normalize-transcript.js <file>` | A1/A3/B7 | format detect (.vtt / Zoom / Fireflies / .txt / .md) → normalized segments JSON `{speaker, ts_mmss, text}`; nonzero exit signals LLM fallback (announce it) | file path |
| `check-env.js` | B0 | docker/node/network/n8n-API reachability + capability probes | `N8N_BASE_URL?` |
| `generate-tenant.js` | B1 | complete the A0-born `tenant.yaml` from state + `team/*.md` + vault layout; always shows a diff before writing | vault path |
| `validate-tenant.js` | B1 + every deploy | JSON-Schema + semantic checks against `plugin/templates/tenant.schema.json`; `--fix` creates missing folders; `--migrate` for older schema versions | `TENANT` path (default `./tenant.yaml`) |
| `test-creds.js zoom` | B2 | S2S OAuth token grant → past-meetings probe → webhook secret shape check | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET_TOKEN` |
| `test-creds.js slack` | B3 | `auth.test` → scope check vs shipped manifest → live test post to `features.slack.digest_channel` | `SLACK_BOT_TOKEN` |
| `test-creds.js github` | B4 | PAT scope probe → branch commits check on `vault.repo` → dry Git-Data tree permission check | `GITHUB_VAULT_PAT` |
| `test-creds.js linear` | B5 | viewer query → resolve every `tracker_team_key` → 1 search query per team | `LINEAR_API_TOKEN` |
| `test-creds.js anthropic` | B6 pre-gate | 1-token probe per distinct `llm.*` model with the tenant's exact params; graceful downgrade proposals | `ANTHROPIC_API_KEY` |
| `test-creds.js all` | B6 gate | run everything applicable per feature flags; skips disabled components and says so | all above |
| `pipeline-nodes.js` | — (library) | SSOT: workflow→node→file map, `SECRETS[]`, `INJECT_SECRETS` / `NORMALIZE_SECRETS` / `SECRET_SCRUB` | — |
| `load-secrets-env.js` | — (library) | dependency-free dotenv loader: reads `.backbrief/secrets.env` into `process.env` (gaps only, explicit env wins); called by deploy-pipeline / check-env / status / check-drift (test-creds.js and import-history.js read the same file via their own private parser copies) so the documented secret contract actually loads | — |
| `deploy-pipeline.js [--import\|--workflow <key>\|--selftest\|--selftest-interactivity\|--selftest-cleanup\|--rotate-anthropic\|--anthropic-inline]` | B6 | snapshot live → render tenant into code nodes → inject secrets → atomic PUT per workflow → activate → fixture self-test → write `.backbrief/pipeline-state.json` | `N8N_BASE_URL`, `N8N_API_KEY` + creds above |
| `check-drift.js` | status / CI | per-node live↔repo diff (secrets + tenant-render normalized on both sides); nonzero exit = tripwire | `N8N_BASE_URL`, `N8N_API_KEY` |
| `redrive-dlq.js` | status / ops | recover vault artifacts from DLQ entries; hard rule: never writes outside the vault root | `GITHUB_VAULT_PAT` |
| `import-history.js` | B7 | list Zoom Cloud recordings (`features.history_import.days`) → replay each through the live webhook, throttled; digest report | Zoom creds + `N8N_BASE_URL` |
| `telemetry.js event\|waitlist …` | all | gateway POST (wire spec: `gateway/schema.md`): `event step_completed A3`, `event connector_demand --tool=<slug>`, `waitlist --interest=… --email=…`; hard no-op unless `features.telemetry.enabled`; 2 s timeout, fire-and-forget, never blocks the caller | reads `tenant.yaml` only |
| `status.js` | status | webhook liveness, last processed call, DLQ count, flag↔reality drift summary | `N8N_BASE_URL`, `N8N_API_KEY` |
| `check-update.js` | status / any skill start | local `VERSION` vs latest (gateway `/v1/version` when telemetry on; GitHub Releases fallback); cached 24 h in `.backbrief/cache/` | none (network optional) |
| `sanitize-check.sh` | kit CI only | denylist grep gate for the kit repo itself — **not** invoked by procedures | — |

## Where things live (quick map)

| Path | Contents |
|---|---|
| `<vault>/tenant.yaml` | user-owned config: teams, roster, `features.*` flags (no secrets, ever) |
| `<vault>/.backbrief/state.yaml` | rung progress, stack map, resume points |
| `<vault>/.backbrief/waitlist.yaml` | local mirror of captured connector demand |
| `<vault>/.backbrief/training/task-decisions.jsonl` | A3 outcome log (per-team learning seed) |
| `<vault>/.backbrief/secrets.env` | Phase-B credentials (gitignored; offer scrub after B6) |
| `<vault>/.backbrief/pipeline-state.json` | machine-written deploy state: workflow ids, webhook URL, last deploy sha |
