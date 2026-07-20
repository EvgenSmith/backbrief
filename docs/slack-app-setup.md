<!-- SPDX-License-Identifier: MIT -->
# Slack app setup (deploy step B3, ~5 minutes)

Slack is where the pipeline's output becomes visible to the team: the root post per call,
the digest thread reply, the "Backbrief · tasks" proposals with **Approve/Skip** buttons,
owner DMs on pipeline failures, and the feedback collector that reads thread
replies back into training data.

The app is named **Backbrief** — the shipped manifest sets both the app name and the
bot display name, and digests carry a "via Backbrief" footer. Keep the name: the bot
identity is how every post identifies itself to your team.

Skippable: no Slack → `features.slack.enabled: false`; digests are still generated and
stay in the vault, task approval falls back to chat, and the skip is recorded in your
vault's `.backbrief/roadmap.md` with the resume command. Using another chat tool? Say so
during deploy — it goes on the connector waitlist.

## Step 1 — create the app from the shipped manifest

1. Open `api.slack.com/apps` → **Create New App** → **From a manifest**.
2. Pick your workspace.
3. Paste the contents of **`plugin/templates/slack-app-manifest.yaml`** (YAML tab) →
   **Next** → **Create**.
4. **Upload the app icon** (manifests cannot embed one): **Basic Information →
   Display Information → App icon** — any square PNG ≥ 512 px with the Backbrief
   wordmark. Without it, every digest shows Slack's default initial-letter avatar;
   every post the bot makes is a brand impression, so give it a face.

The manifest is paste-ready: bot user, all scopes, and interactivity pre-configured.

## Step 2 — install and copy credentials

1. **Install App** → **Install to Workspace** → allow.
2. Copy into `.backbrief/secrets.env`:

```bash
SLACK_BOT_TOKEN=...        # "OAuth & Permissions" → Bot User OAuth Token (starts with xoxb)
SLACK_SIGNING_SECRET=...   # "Basic Information" → App Credentials → Signing Secret
```

The signing secret authenticates button-click POSTs from Slack (interactivity); the bot
token is everything else.

## What the scopes are for (as shipped in the manifest)

| Scope | Used for |
|---|---|
| `chat:write` | digest root posts, thread replies, owner DMs |
| `chat:write.public` | posting to public channels the bot wasn't invited to |
| `im:write` | opening DMs (1:1 digests to the owner, failure alerts) |
| `users:read` | workspace roster (profiles at A2, assignee resolution) |
| `users:read.email` | `users.lookupByEmail` — auto-resolving `slack_user_id` from roster emails, so you never paste a Slack ID |
| `channels:read` / `groups:read` | resolving channel *names* in `tenant.yaml` to IDs at deploy (public / private) |
| `channels:history` / `groups:history` | the feedback collector reads the digest channel's threads |
| `reactions:read` / `reactions:write` | feedback-collector idempotency marker (a reaction marks a thread as processed) |

Production lesson baked into the manifest: a chat-only bot works for posting but
**silently starves the learning loop** — the feedback collector needs the history and
reactions scopes. Ship them all at once; adding scopes later requires reinstalling the
app.

Roster resolution degrades gracefully: a pre-set `slack_user_id` wins, then email
lookup (`users:read.email`), then a plain name match against `users.list`. Profile
`email:` fields stay optional, and a missing scope never fails the step.

## Step 3 — choose the digest channel

During deploy you'll be asked which channel call digests land in (written to
`features.slack.digest_channel`; the default offered is `"#call-digests"`). Use a name
or an ID — deploy resolves names to IDs and caches them in
`.backbrief/pipeline-state.json`.

- **Private channel?** Invite the bot to it (`/invite @Backbrief`) —
  `chat:write.public` covers public channels only, and `groups:history` requires
  membership.
- Optional extra in `tenant.yaml`: `features.slack.per_team_channels` (per-team routing
  overrides — team tag → channel).

## Step 4 — interactivity URL (deferred to B6)

The manifest ships a **placeholder** interactivity `request_url` — Slack accepts it at
creation. After B6 deploy prints your n8n webhook URL, update it once: app settings →
**Interactivity & Shortcuts** → set
`https://<your-n8n-host>/webhook/backbrief-taskcrafter-interaction` → Save. The path
segment is fixed by `pipeline/workflows/taskcrafter.json` — replace only the host; B6
prints the exact full URL. Until then, digest posts work; Approve/Skip buttons will
error on click.

No Events API subscription is needed: buttons use interactivity, and the feedback
collector polls channel history on a schedule.

## Step 5 — verify (live test, required)

```bash
node plugin/scripts/test-creds.js slack
```

Proves: `auth.test` passes, granted scopes match the manifest, and a **visible test
message** lands in your chosen digest channel — go look at it; that message is the step's
artifact.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `missing_scope` | Scope added after install → **Reinstall App** (OAuth & Permissions page), then re-run the test. |
| `not_in_channel` | Digest channel is private and the bot isn't a member → `/invite @Backbrief`. |
| `channel_not_found` at deploy | Name typo in `tenant.yaml`, or a private channel the bot can't see → invite the bot, re-deploy. |
| Buttons do nothing / Slack shows an error on click | Interactivity URL still the placeholder (Step 4), or `SLACK_SIGNING_SECRET` mismatch in n8n. |
| Feedback digests never appear | History/reactions scopes missing (reinstall), or the collector's schedule hasn't ticked yet (runs every 6 h). |
| Owner DMs not arriving | `roster[].is_owner` not set on exactly one person, or `slack_user_id` unresolved — check `users:read.email` scope and that the roster email matches the Slack account email. |
