<!-- SPDX-License-Identifier: MIT -->
# Zoom Server-to-Server OAuth setup (deploy step B2, ~10 minutes)

This checklist wires Zoom into the pipeline. It is the longest credential step of the
deploy — everything after it is shorter. It is battle-tested: every gotcha below was hit
in production at least once.

**What this gives the pipeline:**

1. **Webhook capture** — Zoom POSTs a `recording.completed` event to your n8n the moment
   a cloud recording finishes; that event is the pipeline's only trigger.
2. **Participant roster** — Zoom's transcript-ready event carries an **empty participant
   list** (a known platform gap). The pipeline recovers the roster with a Server-to-Server
   OAuth call to `GET /past_meetings/{meetingUUID}/participants`. Without S2S credentials
   it falls back to seeding only the host's name from `host_email` — filed calls then
   under-report who attended.
3. **History import (B7, optional)** — listing past Zoom Cloud recordings to backfill
   your vault.

**What you end up with — 4 values in `.backbrief/secrets.env`:**

| Env var | What it is | Where you copy it |
|---|---|---|
| `ZOOM_ACCOUNT_ID` | S2S OAuth credential 1/3 | App Credentials page |
| `ZOOM_CLIENT_ID` | S2S OAuth credential 2/3 | App Credentials page |
| `ZOOM_CLIENT_SECRET` | S2S OAuth credential 3/3 | App Credentials page |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | HMAC secret for webhook signature verification | Feature → Event Subscriptions |

Secrets live **only** in `.backbrief/secrets.env` (gitignored, `chmod 600`). At B6 the
deploy script injects them into your n8n; they never enter `tenant.yaml`, the vault, or
any Backbrief server (there are none).

## Prerequisites

- A **paid Zoom plan** with **Cloud Recording** (Pro or higher). Local recordings do not
  fire the webhook.
- Admin (or developer-role) access to the Zoom account — S2S OAuth apps are account-level.
- 10 minutes.

## Step 0 — enable cloud recording + audio transcript

Zoom web portal → **Admin → Account Settings → Recording**:

- [ ] **Cloud recording** — ON.
- [ ] Under cloud recording settings: **Audio transcript** — ON (this is the checkbox
      that makes Zoom produce the `.vtt` the whole pipeline runs on).
- [ ] Recommended: **Recording disclaimer / consent prompt** — ON
      (see `docs/privacy-and-consent.md`).

Transcripts are generated asynchronously — typically **15–60 minutes after** the call for
long recordings. The pipeline is built for this (two-phase design): the Slack root post is
instant, the digest follows when the transcript lands.

## Step 1 — create the Server-to-Server OAuth app

1. Go to the Zoom App Marketplace: `marketplace.zoom.us` → **Develop → Build App**.
2. Choose **Server-to-Server OAuth** (not "General App", not JWT — JWT is deprecated).
3. Name it something recognizable, e.g. `Backbrief pipeline`.

## Step 2 — copy the three credentials

On the **App Credentials** page, copy into `.backbrief/secrets.env`:

```bash
ZOOM_ACCOUNT_ID=...
ZOOM_CLIENT_ID=...
ZOOM_CLIENT_SECRET=...
```

## Step 3 — add scopes

**Scopes** tab → **Add Scopes**. Zoom's granular-scope names (current default for new
apps):

| Scope | Why | Required? |
|---|---|---|
| `meeting:read:list_past_participants:admin` | roster for every filed call (the participant-list gap above) | **yes** |
| `cloud_recording:read:list_user_recordings:admin` | list a user's cloud recordings — history import (B7) | only for B7 |
| `cloud_recording:read:list_account_recordings:admin` | account-wide recording list — B7 across all hosts | only for B7 |

Notes:

- Older apps with **classic scopes** need the equivalents `meeting:read:admin` and
  `recording:read:admin` instead.
- Downloading the `.vtt`/MP4 files needs **no scope**: the webhook payload carries a
  short-TTL `download_token` used directly against the download URLs.
- Scope changes on S2S apps take effect immediately — no reinstall flow.

## Step 4 — event subscription + webhook secret

**Feature** tab → **Event Subscriptions** → enable → **Add Event Subscription**:

1. **Events:** under *Recording*, select **All Recordings have completed**
   (`recording.completed`). If your account also lists
   `recording.transcript_completed`, subscribe to it too — the pipeline handles both
   (that is exactly the two-phase state machine, see `PRD.md` §3).
2. **Secret Token:** shown on the same Feature page. Copy it now:

   ```bash
   ZOOM_WEBHOOK_SECRET_TOKEN=...
   ```

3. **Event notification endpoint URL:** this is your pipeline's webhook URL —
   `https://<your-n8n-host>/webhook/backbrief-zoom`. **You won't have it until
   step B6 deploys the workflows.** Zoom validates the URL with a challenge
   (`endpoint.url_validation`) that only the *deployed, active* pipeline can answer, so:
   - at B2: fill in everything else, leave this subscription unsaved or pointed at a
     placeholder;
   - **after B6:** the deploy prints your webhook URL — come back here, paste it, click
     **Validate** (the live pipeline answers the challenge), **Save**.

   If validation fails, the subscription is disabled and no events flow — the deploy
   procedure reminds you of this return-trip.

## Step 5 — activate

**Activation** tab → **Activate your app**. S2S apps activate account-wide instantly; no
review, no user install.

## Step 6 — verify (live test, required)

```bash
node plugin/scripts/test-creds.js zoom
```

This proves, in order: (1) token grant with your 3 credentials, (2) a live call to the
past-meeting participants API — the call that actually matters in production, (3) the
webhook secret is present and plausibly shaped. The B2 step is done only when this is
green.

## Troubleshooting (each of these happened in production)

| Symptom | Cause → fix |
|---|---|
| `invalid_client` on token grant | Client ID/Secret mismatch, or Account ID from a different account. Re-copy all three from the same app's Credentials page. |
| API error `4711` / "Invalid access token, does not contain scopes" | Missing scope. Add it (Step 3); takes effect immediately, then re-run `test-creds.js zoom`. |
| URL validation fails in Step 4 | Pipeline not deployed/active yet (do B6 first), wrong `ZOOM_WEBHOOK_SECRET_TOKEN` in n8n, or a typo in the URL. |
| Webhooks silently stop arriving | Zoom disables subscriptions that repeatedly fail validation or delivery. Re-validate the endpoint URL in the app settings. |
| Live events rejected with "timestamp stale or skewed" | The pipeline enforces a **15-minute replay window** (`pipeline.knobs.replay_window_sec`, default 900) on the signed timestamp. If *every* webhook is rejected, your n8n host's clock is skewed — fix NTP. (Production incident: >5 min of host clock skew rejected 100% of webhooks, including Zoom's retries.) |
| Digest never arrives, root post did | Transcript not ready yet (15–60 min lag), or Audio transcript is off (Step 0), or the call was shorter than `min_duration_min`. |
| Participants missing on filed calls | S2S roster call failing — re-run `test-creds.js zoom`; until fixed the pipeline seeds only the host from `host_email`. |
| Recording links in old Slack posts are dead | Zoom share links expire (~24 h TTL). That is why the optional Drive archive exists (`features.drive`) — it replaces the link with a permanent one. |

## Rotation

Rotate the webhook secret by regenerating the Secret Token in the Zoom app, updating
`.backbrief/secrets.env`, and re-running `node plugin/scripts/deploy-pipeline.js`
(secrets are injected at deploy; the repo never holds them). Same procedure for the
client secret. Rotate on your normal credential schedule.
