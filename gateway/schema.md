<!-- SPDX-License-Identifier: MIT -->
# Telemetry wire schema (v1)

The exact, exhaustive contract of the Backbrief telemetry gateway — every key,
every enum, every limit. The enforcing code is [`worker.js`](worker.js)
(server) and [`plugin/scripts/telemetry.js`](../plugin/scripts/telemetry.js)
(client); both carry this same allowlist, and **this file is the reference
they are kept in sync with**. Human-readable overview:
[`docs/telemetry.md`](../docs/telemetry.md); deploy guide: [`README.md`](README.md).

Design invariant, enforced structurally: **the API has no free-text field.**
Every value is a closed enum, a bounded integer, or a validated identifier.
The single quasi-free field (`tool`) is length-capped and slug-normalized
server-side. Unknown keys are rejected with `400` naming the key — on every
endpoint, at both the top level and inside `props`.

Base URL: `https://backbrief-telemetry.backbrief.workers.dev`. All paths carry the `/v1` version prefix; breaking
changes bump the prefix, additive enum values do not.

---

## POST /v1/events

Step events and counters. `content-type: application/json`.

### Top-level keys (closed set — anything else ⇒ `400 unknown key "<k>"`)

| Key | Type | Required | Validation |
|---|---|---|---|
| `install_id` | string | yes | UUIDv4 (`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, case-insensitive). Client-generated at consent; random, anonymous. |
| `kit_version` | string | yes | semver (`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`) |
| `event` | string | yes | event enum below |
| `step` | string | for `step_*` events | `A0`–`A4`, `B0`–`B5`, `B5.5`, `B6`–`B8` (15 values — `B5.5` is the required Anthropic API key rung between B5 and B6). Forbidden on non-step events. |
| `props` | object | no | per-event allowlist below; unknown prop key ⇒ `400` |
| `ts` | string | no | ISO 8601; **validated, never stored** (the server buckets by its own UTC date) |

### Event enum (9 values)

`install` · `step_started` · `step_completed` · `step_skipped` ·
`calls_processed` · `tasks_verdict` · `connector_demand` · `status_run` · `error`

### Per-event props allowlist

| Event | Allowed props |
|---|---|
| `install` | — (empty `props` or omitted) |
| `step_started` / `step_completed` / `step_skipped` | `count`, `team_size_bucket`, `stack_path`, `source`, `fork`, `hosting`, `tracker`, `persona` |
| `calls_processed` | `count` |
| `tasks_verdict` | `verdict`, `dedup`, `tracker` |
| `connector_demand` | `tool` |
| `status_run` | `count` |
| `error` | `error_class` |

### Prop value validation (enums + bounded integers only)

| Prop | Type | Values / bounds |
|---|---|---|
| `count` | integer | `0..100000` (batch size; for `status_run`: DLQ entries) |
| `verdict` | enum | `accepted` \| `edited` \| `skipped` |
| `dedup` | enum | `create` \| `comment` \| `duplicate` \| `flag` |
| `tracker` | enum | `linear` \| `jira` \| `other` \| `none` |
| `team_size_bucket` | enum | `lt10` \| `10-50` \| `gt50` |
| `stack_path` | enum | `golden` \| `custom` |
| `source` | enum | `slack` \| `tracker` \| `docs` \| `survey` |
| `fork` | enum | `deploy` \| `hosted_waitlist` \| `hands_on` \| `declined` |
| `hosting` | enum | `cloud` \| `docker` |
| `persona` | enum | `solo` \| `team_lead` \| `company_lead` (A0 persona fork) |
| `tool` | slug | ≤64 chars accepted, slug-normalized (`[a-z0-9-]`) and capped at 32 server-side |
| `error_class` | enum | `creds_zoom` \| `creds_slack` \| `creds_github` \| `creds_linear` \| `creds_jira` \| `creds_anthropic` \| `env_check` \| `tenant_validate` \| `vault_validate` \| `normalize_transcript` \| `deploy_put` \| `webhook_selftest` \| `history_import` \| `dlq_redrive` \| `update_check` \| `network` \| `unknown` |

### Responses

| Code | Meaning |
|---|---|
| `204` | accepted (no body) |
| `400` | schema violation — body is `{"error": "..."}` naming the offending key/value |
| `429` | rate-limited: > 120 events/hour per `install_id` |

Delivery semantics: counters tolerate at-most-once loss; the client never
retries more than once. Events are fire-and-forget on the client (a failed
send must never break a pipeline step).

---

## GET /v1/version

Unauthenticated. `cache-control: max-age=3600`.

Query params: `channel` (optional, `stable` only in v0.1) · `current`
(optional semver — used **only** for an aggregate version-distribution
counter, never linked to an install).

Response `200`:

```json
{
  "latest": "0.1.3",
  "min_supported": "0.1.0",
  "notes_url": "https://github.com/EvgenSmith/backbrief/releases/tag/v0.1.3",
  "update_hint": "claude plugin update backbrief  |  git pull"
}
```

With telemetry declined, the kit's update check calls the GitHub Releases API
instead — this endpoint is never contacted.

---

## POST /v1/waitlist

Demand capture. **The only endpoint that stores an email**, and only because
the user typed one in — typing it is the consent.

### Keys (closed set)

| Key | Type | Required | Validation |
|---|---|---|---|
| `email` | string | yes | `^[^@\s]+@[^@\s]+\.[^@\s]+$` |
| `interest` | enum | yes | `hosted` \| `hands_on` \| `connector` \| `updates` \| `privacy` |
| `tool` | slug | `connector` only | same slug rule as events `tool` |
| `source_step` | enum | no | `A0`–`A4`, `B0`–`B5`, `B5.5`, `B6`–`B8` — where in the ladder demand appeared (`B5.5` = the required Anthropic API key rung) |
| `install_id` | string | no | UUIDv4 — links demand to funnel stage (exists only after consent) |

`privacy` = demand for privacy routing (auto-routing 1:1/board/legal calls
into private vault slices) — removed from v0.1 pre-release;
`validate-tenant.js --migrate` points owners of legacy configs here.

### Responses

| Code | Meaning |
|---|---|
| `201` | created — `{"ok":true}` |
| `409` | duplicate `email`+`interest` — `{"ok":true,"dup":true}`; the client treats this as success |
| `400` | invalid/unknown field — `{"error": "..."}` |

Side effect: if the operator configured the optional `WAITLIST_WEBHOOK`
secret, it is notified with `{interest, tool, step}` — **never the email**.

---

## Storage layout (KV namespace `TELEMETRY`)

What each accepted request may write — nothing else is ever stored. No IP, no
User-Agent, no timestamps beyond day-granularity buckets.

| Key | Value | TTL |
|---|---|---|
| `i:<install_id>` | `{"v": "<kit_version>", "last": "<YYYY-MM-DD>"}` — install liveness | 180 d |
| `c:<day>:<event>:<step\|tool\|->` | integer counter (for `connector_demand` the tool slug folds into the key, so demand ranks per tool) | 400 d |
| `v:<day>:<semver>` | version-distribution counter from `/v1/version?current=` | 400 d |
| `w:<email>:<interest>` | `{"tool", "step", "install", "ts"}` — waitlist row | none |
| `rl:<hour>:<install_id>` | rate-limit bucket | 2 h |

KV read-modify-write counters are approximate under concurrency — acceptable
at this volume; revisit with Durable Objects / D1 only if lost
increments ever become visible.

---

## Change policy

- Adding an enum value or a new optional prop: allowed within `/v1`; old
  clients keep working (server-side allowlist is a superset check — the
  **client** allowlist gates what leaves the machine).
- Removing/renaming keys, changing validation, adding required fields:
  breaking ⇒ new `/v2` prefix, `/v1` kept accepting during a deprecation
  window announced via `notes_url`.
- Every schema change lands in this file, `worker.js`, and
  `plugin/scripts/telemetry.js` in the same commit — CI's
  **telemetry client↔gateway allowlist parity** job
  (`plugin/scripts/check-telemetry-contract.js`, wired in
  `.github/workflows/ci.yml`) diffs `EVENTS` / `STEPS` / `INTERESTS` /
  `ERROR_CLASSES` / `PROPS_BY_EVENT` / `ENUM_PROPS` between `worker.js` and
  `telemetry.js` and fails the build on any drift between the two allowlists.
  (This file is the human reference; the parity job guards the two enforcing
  copies against each other.)
