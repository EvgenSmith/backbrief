<!-- SPDX-License-Identifier: MIT -->
# Backbrief — agent operating manual

You are operating the Backbrief kit: turn team call transcripts into tracked tasks
and a company memory vault in the user's own markdown repo.

## Routing

When the user asks to… → read and execute, step by step:

| Intent (EN / RU examples) | Procedure |
|---|---|
| set up / start / "разверни" / first transcript, no vault yet | `plugin/procedures/start.md` (A0–A1) |
| build team profiles / "кто есть кто" | `plugin/procedures/profiles.md` (A2) |
| extract tasks / "поставь задачи" / transcript pasted with task intent | `plugin/procedures/tasks.md` (A3) |
| wrap-up / "show the before/after" | `plugin/procedures/tasks.md` (terminal A4 phase) |
| deploy the automatic pipeline / "make it automatic" | `plugin/procedures/deploy.md` (B0–B8) |
| status / health / "is the pipeline alive?" / update | `plugin/procedures/status.md` |
| bare "backbrief" / "what's next?" | locate the vault first (see "Finding the vault" below), run `node plugin/scripts/state.js get`, name the highest completed rung, propose the next one in one sentence; if the vault has `.backbrief/roadmap.md`, mention the cheapest deferred step |

Before ANY procedure: read `plugin/procedures/_conventions.md` (global rules) and
`plugin/procedures/_capabilities.md` (tool bindings). Procedures are the single source
of truth; if this file and a procedure disagree, the procedure wins.

## Bindings for this environment

You have shell + file tools. Use the "CLI fallback" column of `_capabilities.md` for
every capability (`curl` for Slack/Linear/GitHub APIs, `node` for `plugin/scripts/*`).
Paths are repo-relative — you are running inside the cloned kit repo.
Secrets come from the user's environment / `.backbrief/secrets.env` (gitignored) —
never echo them, never commit them.

**Finding the vault.** The vault is a separate directory from this kit clone.
`plugin/scripts/state.js` resolves it in this order: `--vault <path>` → the
`BACKBRIEF_VAULT` env var → walking up from the cwd looking for `.backbrief/`. After
A0 creates the vault, run vault-state commands from inside it, pass
`--vault <path>`, or suggest the user `export BACKBRIEF_VAULT=<path>` — a bare
`state.js get` from inside the kit clone will NOT find a vault that lives elsewhere
and would misreport a fresh install.

## Hard rules

- Mirror the user's language in conversation; all files you write follow the templates'
  conventions (structural elements EN, transcript narrative in the call's language).
- One question per step; every step ends in a visible artifact; every step is skippable
  (skip = flag + one-sentence degradation, never a dead end).
- Never send transcript content, names, or vault paths anywhere except the user's own
  configured endpoints (their Slack, their tracker, their git remote). Telemetry is
  opt-in and counters-only (`_conventions.md` §7).

## Updating

`git pull` updates the kit — it holds no state (state lives in the user's vault:
`tenant.yaml`, `.backbrief/`). `node plugin/scripts/check-update.js` reports the latest release.
