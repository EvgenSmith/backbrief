<!-- SPDX-License-Identifier: MIT -->
# Backbrief telemetry gateway

A ~450-line Cloudflare Worker + one KV namespace. It is a **counter box with a
mailbox** — nothing more: step events and counters land as daily
KV counters, and the waitlist endpoint stores an email only when a user
explicitly typed one in to be contacted.

This directory is published in the kit repo on purpose. The privacy promise in
the root README is load-bearing for this segment, and the cheapest possible
trust proof is: *the code that receives your telemetry is right here, and it
structurally cannot accept content.*

## Privacy guarantees (enforced in code, not policy)

| Guarantee | How the code enforces it |
|---|---|
| Opt-in only | The client (`plugin/scripts/telemetry.js`) hard no-ops unless `features.telemetry.enabled: true` in the user's `tenant.yaml`. With telemetry off, the kit makes zero calls here — version checks fall back to GitHub Releases. |
| Never content | `/v1/events` accepts a **closed enum vocabulary + bounded integers**. There is no free-text field on the endpoint at all. Unknown keys → `400` naming the key. The same allowlist is enforced client-side before anything leaves the machine. |
| The only quasi-free field | `tool` (connector demand / waitlist) — capped at 32 chars and slug-normalized (`[a-z0-9-]` only) server-side. |
| Anonymous | `install_id` is a locally generated random UUIDv4, created only at consent. Not derived from anything identifying. |
| No IP / no UA | The worker never reads client IP or User-Agent headers; neither is ever written to storage. |
| Email in exactly one place | `/v1/waitlist`, and only because the user typed it in. The optional operator notification webhook receives interest/tool/step — **never the email**. |

Not in v0.1 (explicitly): auth, sessions, content of any kind, per-user
dashboards.

## API contract

Base URL: `https://backbrief-telemetry.backbrief.workers.dev`. All paths carry the `/v1` version prefix.

### `POST /v1/events`

Step events + counters. Body (allowlist — unknown keys ⇒ `400`):

```jsonc
{
  "install_id": "3b2f6b6e-...",   // required, UUIDv4
  "kit_version": "0.1.0",         // required, semver
  "event": "step_started",        // required — see event enum below
  "step": "A2",                   // required for step_* events; enum A0..A4, B0..B5, B5.5, B6..B8
  "props": { "count": 3 },        // optional — per-event allowlist below
  "ts": "2026-07-10T12:00:00Z"    // optional ISO 8601; validated, not stored
}
```

**Event enum:** `install` · `step_started` · `step_completed` · `step_skipped`
· `calls_processed` · `tasks_verdict` · `connector_demand` · `status_run` ·
`error`

**Per-event props allowlist** (integers/enums only):

| Event | Allowed props |
|---|---|
| `install` | — |
| `step_started` / `step_completed` / `step_skipped` | `count`, `team_size_bucket`, `stack_path`, `source`, `fork`, `hosting`, `tracker`, `persona` |
| `calls_processed` | `count` |
| `tasks_verdict` | `verdict`, `dedup`, `tracker` |
| `connector_demand` | `tool` |
| `status_run` | `count` |
| `error` | `error_class` |

**Prop values:**

| Prop | Values |
|---|---|
| `count` | integer `0..100000` (batch size; `status_run`: DLQ entries) |
| `verdict` | `accepted` \| `edited` \| `skipped` |
| `dedup` | `create` \| `comment` \| `duplicate` \| `flag` |
| `tracker` | `linear` \| `jira` \| `other` \| `none` |
| `team_size_bucket` | `lt10` \| `10-50` \| `gt50` |
| `stack_path` | `golden` \| `custom` |
| `source` | `slack` \| `tracker` \| `docs` \| `survey` |
| `fork` | `deploy` \| `hosted_waitlist` \| `hands_on` \| `declined` |
| `hosting` | `cloud` \| `docker` |
| `persona` | `solo` \| `team_lead` \| `company_lead` (A0 persona fork) |
| `tool` | string ≤64 chars in, slugged to ≤32 (`[a-z0-9-]`) server-side |
| `error_class` | `creds_zoom` \| `creds_slack` \| `creds_github` \| `creds_linear` \| `creds_jira` \| `creds_anthropic` \| `env_check` \| `tenant_validate` \| `vault_validate` \| `normalize_transcript` \| `deploy_put` \| `webhook_selftest` \| `history_import` \| `dlq_redrive` \| `update_check` \| `network` \| `unknown` |

**Responses:** `204` accepted · `400` schema violation (body names the
offending key) · `429` rate-limited (per `install_id`, 120/h). Events are
idempotent-ish by design: counters tolerate at-most-once loss, and the client
never retries more than once.

### `GET /v1/version?channel=stable&current=0.1.0`

```json
{
  "latest": "0.1.3",
  "min_supported": "0.1.0",
  "notes_url": "https://github.com/EvgenSmith/backbrief/releases/tag/v0.1.3",
  "update_hint": "claude plugin update backbrief  |  git pull"
}
```

Unauthenticated, `cache-control: max-age=3600`. `current` is optional and used
only for aggregate version-distribution counting — it is never linked to an
install.

### `POST /v1/waitlist`

Demand capture — the waitlist prioritizes the connector roadmap by numbers.
**Email is required**; typing it is the consent. Anonymous demand (no email)
rides the `connector_demand` event instead.

```jsonc
{
  "email": "user@example.com",   // required, validated
  "interest": "hosted",          // required: hosted | hands_on | connector | updates | privacy
  "tool": "jira",                // connector only; slugged to <=32 chars server-side
  "source_step": "B5",           // optional: A0..B8 — where in the ladder demand appeared
  "install_id": "3b2f6b6e-..."   // optional — links demand to funnel stage (exists only after consent)
}
```

**Responses:** `201` created · `409` duplicate (`email`+`interest`) — treated
as success by the client · `400` invalid/unknown field.

`interest: "privacy"` captures demand for privacy routing (auto-routing
1:1/board/legal calls into private vault slices), which was removed from the
v0.1 pre-release.

### `GET /waitlist` (browser signup page)

A self-contained HTML page — inline CSS/JS, **no external dependencies**, no
`/v1` prefix — for the no-terminal persona (chat-only / non-technical) who
can't run the kit's `telemetry.js waitlist` CLI. It renders a small form
(interest + email, plus a tool field when `interest = connector`) and, on
submit, does a same-origin `fetch` `POST /v1/waitlist` with the exact JSON body
documented above — so it goes through the same validated, email-in-one-place
endpoint the CLI uses. It stores nothing itself; only the `POST` handler
writes. `201`/`409` both render as "you're on the list". Point non-technical
users at `https://backbrief-telemetry.backbrief.workers.dev/waitlist` (a fork:
the URL your own `wrangler deploy` prints). Cacheable (`max-age=3600`), `noindex`.

## Storage layout (KV namespace `TELEMETRY`)

| Key | Value | TTL |
|---|---|---|
| `i:<install_id>` | `{"v": "<kit_version>", "last": "<YYYY-MM-DD>"}` — install liveness | 180 d |
| `c:<day>:<event>:<step\|tool\|->` | integer counter (connector_demand folds the tool slug into the key so demand ranks per tool) | 400 d |
| `v:<day>:<semver>` | version-distribution counter from `/v1/version?current=` | 400 d |
| `w:<email>:<interest>` | `{"tool", "step", "install", "ts"}` — waitlist row | none |
| `rl:<hour>:<install_id>` | rate-limit bucket | 2 h |

KV read-modify-write counters are approximate under concurrency — fine at this
volume; move to Durable Objects / D1 only if launch traffic ever makes lost
increments visible.

## Deploy guide

Prerequisites: a Cloudflare account (free tier is enough) and
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/) ≥ 3
(`npm i -g wrangler`, `wrangler login`).

**1. Create the KV namespace:**

```bash
cd gateway
wrangler kv namespace create TELEMETRY
# note the returned id
```

**2. Write `gateway/wrangler.toml`** (gitignore your copy if you fork — the
`id` is account-specific):

```toml
name = "backbrief-telemetry"
main = "worker.js"
compatibility_date = "2026-07-01"

kv_namespaces = [
  { binding = "TELEMETRY", id = "<id from step 1>" }
]

# Custom domain (optional — the shipped client defaults to the hosted
# workers.dev URL). Requires the zone to be on this Cloudflare account.
# routes = [
#   { pattern = "api.<your-domain>", custom_domain = true }
# ]
```

**3. Optional — operator notification on new waitlist rows** (e.g. a Slack
incoming-webhook URL; the payload never contains the email):

```bash
wrangler secret put WAITLIST_WEBHOOK
```

**4. Deploy:**

```bash
wrangler deploy
```

**5. Smoke test:**

```bash
BASE=https://backbrief-telemetry.backbrief.workers.dev   # a fork: the URL your own deploy printed

curl -s "$BASE/v1/version" | jq .

curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/v1/events" \
  -H 'content-type: application/json' \
  -d '{"install_id":"11111111-1111-4111-8111-111111111111","kit_version":"0.1.0","event":"install"}'
# expect: 204

curl -s -X POST "$BASE/v1/events" -H 'content-type: application/json' \
  -d '{"install_id":"11111111-1111-4111-8111-111111111111","kit_version":"0.1.0","event":"install","oops":1}'
# expect: {"error":"unknown key \"oops\""} (HTTP 400)

curl -s -X POST "$BASE/v1/waitlist" -H 'content-type: application/json' \
  -d '{"email":"user@example.com","interest":"updates"}'
# expect: {"ok":true} (201); repeat → {"ok":true,"dup":true} (409)

curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/waitlist"
# expect: 200 text/html… (the browser signup page)
```

### Release checklist

On every kit release, edit the `LATEST` constant at the top of `worker.js`
(`latest`, `min_supported`, `notes_url`) and `wrangler deploy`. If manual edits
become annoying, move `LATEST` to a KV key — the constant is the v0.1
simplicity choice.

## Reading the funnel

No dashboard needed at ≤ a few hundred installs:

```bash
# daily counters for July 2026
wrangler kv key list --binding TELEMETRY --prefix "c:2026-07-" | jq -r '.[].name'

# a specific counter
wrangler kv key get --binding TELEMETRY "c:2026-07-10:step_completed:A1"

# connector demand ranking
wrangler kv key list --binding TELEMETRY --prefix "c:2026-07-" \
  | jq -r '.[].name' | grep ':connector_demand:'

# waitlist size (the kit→hosted trigger threshold measures from here)
wrangler kv key list --binding TELEMETRY --prefix "w:" | jq length
```

The funnel `install → A0 started → A1 completed → … → B6 completed →
calls_processed over time` reproduces the PRD success gates directly: Phase-A
launches, completed Phase-B installs, week-2 liveness (`calls_processed`
recency per `i:` row), and support/hosted demand (`w:` rows ÷ installs).

## Keeping client and worker in sync

The wire allowlist (event enum, step enum, per-event props, prop value enums,
error classes) lives in **two places by design** — `gateway/worker.js` and
`plugin/scripts/telemetry.js` — so each side enforces it independently. Any
contract change must update both files (and this README) in the same commit.
