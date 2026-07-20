<!-- SPDX-License-Identifier: MIT -->
# Telemetry — exactly what is sent, when, and how to verify it

This is the human-readable mirror of the wire spec in [`gateway/schema.md`](../gateway/schema.md).
The ~450-line worker that receives events is published in [`gateway/`](../gateway/) — the
strongest privacy statement we can make is that **you can read the code that receives
your telemetry and see that it cannot accept content.**

## Principles

1. **Opt-in, default no.** You are asked once, in plain words, during setup (A0). Decline
   and the kit makes **zero** calls to the gateway — including version checks, which fall
   back to the GitHub Releases API (or are skipped offline).
2. **Structurally content-free.** The events endpoint accepts a closed enum vocabulary
   plus integers. There is no free-text field. Unknown keys are rejected with a 400. The
   only quasi-free field in the whole API is a tool name on connector-demand, capped at
   32 chars and slug-normalized server-side.
3. **Anonymous.** `install_id` is a random UUIDv4 generated locally at the moment of
   consent — derived from nothing. The gateway stores no IP addresses and no user agents.
   The only endpoint that ever stores an email is the waitlist, and only because you
   typed one in to be contacted.
4. **Never in the way.** One attempt, 2-second timeout, fire-and-forget. A dead gateway
   never blocks or fails any step.

## What is sent (complete event list)

Guarded by `features.telemetry.enabled` in `tenant.yaml` — every row below is a no-op
when it is `false`.

| Event | When | Allowed props (ints/enums only) |
|---|---|---|
| `install` | first consent | — |
| `step_started` / `step_completed` / `step_skipped` | at each ladder rung A0–A4, B0–B8 (incl. `B5.5`, the required Anthropic API key rung between B5 and B6) | `step` (enum `A0…B8` plus `B5.5`); A0: `team_size_bucket` (`lt10\|10-50\|gt50`), `stack_path` (`golden\|custom`), `persona` (`solo\|team_lead\|company_lead`); A2: `source` (`slack\|tracker\|docs\|survey`); A4: `fork` (`deploy\|hosted_waitlist\|hands_on\|declined`); B0: `hosting` (`cloud\|docker`) |
| `calls_processed` | per processed batch, emitted by the **interactive kit steps only** (A1 transcript intake / B7 history import) — the n8n pipeline emits **no telemetry** in v0.1, so ongoing per-call processing is not counted here | `count` — an integer, nothing about the calls |
| `tasks_verdict` | per Approve/Skip decision | `verdict` (`accepted\|edited\|skipped`), `dedup` (`create\|comment\|duplicate\|flag`), `tracker` (`linear\|other\|none`; the wire enum also accepts the legacy `jira` slug) — counters about the *decision*, never the task text |
| `connector_demand` | you name an unsupported tool | `tool` — ≤32-char slug (e.g. `asana`), the only quasi-free field |
| `status_run` | `/backbrief status` | `count` (DLQ entries) |
| `error` | a step fails | `error_class` — closed enum of failure classes (e.g. `creds_zoom`); never the error text |

Example of a full payload — this is as rich as it ever gets:

```jsonc
{
  "install_id": "3b2f6b6e-…",        // random UUIDv4, generated locally at consent
  "kit_version": "0.1.0",
  "event": "step_completed",
  "step": "A2",
  "props": { "source": "slack", "count": 5 },
  "ts": "2026-07-10T12:00:00Z"
}
```

## What is never sent

Transcript content, summaries, task titles or descriptions, names, emails (outside the
explicit waitlist form), file paths, folder names, channel names, repo names, tenant
config values, prompts, or model outputs. Not "we promise not to" — **there is no field
to put them in**, and the gateway 400s unknown keys.

## The other two endpoints

- **`GET /v1/version`** — update check. Carries at most your current version string for
  aggregate version-distribution counting. When telemetry is off, `check-update.js` uses
  the GitHub Releases API instead, so opted-out installs still get update notices without
  touching the gateway.
- **`POST /v1/waitlist`** — hosted/connector/hands-on/privacy interest. Fields: `email`
  (required — this is the one place an email exists, always explicitly typed by you),
  `interest` (`hosted|hands_on|connector|updates|privacy` — `privacy` counts demand for
  the privacy-routing feature, which is not in v0.1), optional `tool` slug and
  `source_step`. Duplicate email+interest is treated as success. The agent may *offer*
  the waitlist; it never auto-submits an email it happens to know.

Rate limit: 120 events/hour per install. Retention: liveness keys ~180 days, daily
counters ~400 days — aggregate counters, nothing to "delete about you" beyond the
install_id row.

## Why we ask at all

The funnel — installs → step completions → skips → connector demand — is the only signal
that decides what gets built next (which connector ships, whether a hosted version is
worth building) and where onboarding breaks. Counters answer that; content wouldn't
help.

## Opting out (or in) later

```yaml
# tenant.yaml
features:
  telemetry:
    enabled: false     # zero outbound calls from the kit, effective immediately
```

Delete the `install_id` line too if you want no trace locally. Everything works
identically either way — opted-out installs just leave us blind, which is the deal.
