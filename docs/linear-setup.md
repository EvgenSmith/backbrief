<!-- SPDX-License-Identifier: MIT -->
# Linear setup (deploy step B5, ~5 minutes)

Linear is the supported tracker default. With it connected, task proposals (posted to
Slack under the **"Backbrief · tasks"** header) are checked against your **live
backlog** (create / comment-on-existing / flag-as-duplicate) and one button click turns
a proposal into a real issue.

Skippable: `features.tracker.enabled: false` → tasks are written as `tasks/*.tasks.md`
files in the vault with copy-paste blocks instead, and the skip is recorded in your
vault's `.backbrief/roadmap.md` with the resume command. Any other tracker (Jira
included) → file-only mode + connector waitlist; no adapter or setup guide ships in
v0.1 — the honest alternative is adapting the skeleton to your stack (`PRD.md` is the
rebuildable spec).

## Step 1 — create an API key

Linear → **Settings → Security & access → API → Personal API keys** → create one
(name it e.g. `backbrief-pipeline`). Copy into `.backbrief/secrets.env`:

```bash
LINEAR_API_TOKEN=...
```

**Whose key?** Issues and comments are authored as the key's user, and the key can only
write into teams that user is a member of. Two sane options:

- a **service account** ("Pipeline Bot") that is a member of every mapped team — cleanest
  attribution and survives people leaving;
- the pipeline owner's personal key — fine for small teams, just know issues will say
  "created by you".

## Step 2 — map your teams

`tenant.yaml` maps vault team tags to Linear team **keys** (the human-readable prefix in
issue ids like `ENG-142` — never UUIDs):

```yaml
features:
  tracker:
    enabled: true
    kind: linear
    team_mapping:
      - team_tag: product
        tracker_team_key: PRD
        default_assignee: Novak      # roster lastname — fallback when no owner resolves
      - team_tag: engineering
        tracker_team_key: ENG
        default_assignee: Petrov
      - team_tag: growth
        tracker_team_key: GRW
        default_assignee: Ivanova
    provenance_label: backbrief      # stamped on every pipeline-created issue — carries
                                     # the product name into your tracker; rename freely
```

Unmapped teams are not an error — their tasks fall back to file-only mode (you'll get a
warning listing them).

## What you never have to provide (deploy resolves it)

The rule is: **never ask the user for an ID a script can resolve.** At B5,
`test-creds.js linear` resolves and caches into `.backbrief/pipeline-state.json`:

| Resolved | How |
|---|---|
| Team UUIDs | from each `tracker_team_key`, cached as `tracker.teams.<KEY>` (`{id, name, todo_state_id}`) |
| "Todo" workflow state per team | the `unstarted`-type state named "Todo"; if your workspace renamed it, the lowest-position `unstarted` state is used and the probe output names the pick (no `unstarted` states at all → recorded as null, issues use the team's default state) |
| `provenance_label` UUID | get-or-create by name (`issueLabels` lookup, then `issueLabelCreate` if absent — the create is skipped under `DRY_RUN=1` and the probe says so) → `tracker.label_id` |
| `roster[].tracker_user_id` | matched by email/lastname via the Linear users query; unresolved people are warned about — their tasks create **unassigned**, nothing breaks |
| Workspace URL slug | `organization.urlKey` → `tracker.url_base`, for rendering issue links in Slack |

## Step 3 — verify (live test, required)

```bash
node plugin/scripts/test-creds.js linear
```

Proves: the key authenticates (`viewer` query), **every** `tracker_team_key` resolves
(with its "Todo" state), one live search query per mapped team succeeds (the same query
shape the dedup stage uses), the provenance label exists (created if missing), and the
workspace URL slug resolves. Everything resolved is cached into
`.backbrief/pipeline-state.json`. The step's artifact is the confirmed mapping table.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `FORBIDDEN` on issue create | The key's user is not a member of the target team → add them (or switch to a service-account key) — the runtime error message in the Slack thread says which team. |
| Team key doesn't resolve | Typo, or the key's user can't see that team. Keys are case-sensitive (`ENG`, not `eng`). |
| Issues created unassigned | That person's `tracker_user_id` didn't auto-resolve — their Linear account email differs from the roster email. Set `roster[].tracker_user_id` manually or fix the email. |
| Wrong initial status | Your workspace has no `unstarted` state named "Todo", so the resolver picked the lowest-position `unstarted` state — the probe output and `tracker.teams.<KEY>.todo_state_id` in `.backbrief/pipeline-state.json` show which. Rename the state (or accept the pick) and re-run `test-creds.js linear`. With no `unstarted` states at all, issues land in the team's default state. |
| Rate limiting on big backfills (B7) | The history import throttles itself; if you still hit limits, lower `features.history_import.days`. |

## Tuning (later, not now)

Dedup/matcher thresholds live in `features.tracker.thresholds` with production-calibrated
defaults. The higher autonomy rungs (`autonomy_level` L1/L2 — auto-create high-confidence
tasks) are **reserved for a future release**; v0.1 always runs L0 (every proposal needs a
click), and your Approve/Skip decisions are logged as the training signal that will gate
them once they ship — see `PRD.md` §12 and the FAQ. Don't touch either on day one.
