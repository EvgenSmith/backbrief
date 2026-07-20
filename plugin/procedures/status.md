<!-- SPDX-License-Identifier: MIT -->
# Procedure: `status` — health, digest, updates

> Read `_conventions.md` (global rules) and `_capabilities.md` (tool bindings) first.
> Triggers: `/backbrief:status`, "is the pipeline alive?", "what's new in my
> vault", after any suspected failure.
> **No questions.** Read-only; safe to run always. Numbers come from script
> output — deterministic arithmetic, never LLM estimates (`_conventions.md` §6).

## Step S1 — gather                                        [flag: none | gate: none]

DO:
  1. `[SCRIPT: state.js get]` — determine mode:
     - **Phase A only** (no `steps.b6 = completed` / no deployed workflows) →
       vault digest mode: run step S2 with the Phase-A subset, plus
       `[SCRIPT: check-update.js]`, then S3. The next rung comes deterministically
       from `status.js` (first incomplete rung in ladder order) — relay it, don't
       re-derive it.
     - **Phase B deployed** → continue with the full set.
  2. `[SCRIPT: status.js]` — webhook liveness (n8n API: workflow active? last
     execution status/time), last call processed, DLQ entry count, component
     flags vs reality, and the cheap config-drift summary (tenant.yaml edited
     since last deploy). Exit 1 means "attention needed", not "broken script".
  3. `[SCRIPT: check-update.js]` — installed vs latest kit version (gateway
     when telemetry is on, GitHub Releases when it is not; 24 h cache).

## Step S2 — render the report                             [flag: none]

DO:
  1. Render ONE compact report from the script outputs (canonical shape):

```
Backbrief status — 2026-07-10 14:02
Pipeline   🟢 live · last call processed 2h ago ("weekly product sync")
Components slack ✅ · vault-commit ✅ · tracker ✅ · drive ⏭ off · history ✅
Attention  ⚠️ 1 DLQ entry (Jul 8, GitHub 502) → say "redrive" to retry it
Deferred   2 steps (B3 Slack digests, B7 history import) → .backbrief/roadmap.md
Vault      63 calls · 9 profiles · tasks: 118 accepted / 24 skipped (83% acceptance, 30d)
Version    0.1.3 (latest)
Next       all rungs complete
```

     The **Deferred** line is `status.js` output (skipped rungs + disabled
     components, mirrored from `.backbrief/roadmap.md`). When the user asks
     "what did I skip?" / "what's left?" — render the roadmap file itself: it
     carries the degradation + re-enable command per entry and the connector
     watchlist. `[SCRIPT: state.js roadmap]` regenerates it if stale.

  2. If `check-update.js` reported a newer version → one-line changelog note +
     "say 'update' and I'll walk you through it". The update itself is a
     guided `claude plugin update backbrief` / `git pull` of the kit, followed
     by `[SCRIPT: deploy-pipeline.js]` re-run and `[SCRIPT: check-drift.js]`
     (re-deploy IS the migration; snapshots keep the rollback).
  3. If `status.js` printed the high-acceptance note (30-day acceptance ≥ 95%
     over ≥ 50 decisions) → relay it as a milestone only. Raised task autonomy
     (L1/L2 auto-create) is **reserved — it ships a future release**; do NOT
     offer an autonomy knob or promise auto-create (`features.tracker.autonomy_level`
     stays L0 in v0.1).

ARTIFACT: the status report in chat; `[SCRIPT: status.js --save]` writes
  `.backbrief/status/<date>.md` when the user wants it kept.
TELEMETRY: `status_run` (+ prop `count: <DLQ entries>`)

## Step S3 — triage offers                                 [flag: none | only when attention > 0]

DO (each is an OFFER, one at a time — never auto-run recovery):
  1. **DLQ > 0** → offer redrive: `[SCRIPT: redrive-dlq.js --all]` (recovers
     vault artifacts locally, never writes outside the vault, never commits —
     review + commit stays with the user). Alternative per entry: n8n
     retry-from-failed-node or webhook replay per the DLQ hint format.
  2. **Webhook dead** (workflow inactive / no executions when calls happened) →
     triage tree, in order:
     a. n8n down? → `[SCRIPT: check-env.js]`;
     b. workflow inactive? → activate in n8n or `[SCRIPT: deploy-pipeline.js]`;
     c. Zoom event subscription disabled? → re-validate the endpoint URL in
        the Zoom app (handshake re-fires automatically);
     d. creds expired? → `[SCRIPT: test-creds.js zoom]`.
  3. **Config drift** flagged → offer `[SCRIPT: deploy-pipeline.js]` (redeploy)
     then `[SCRIPT: check-drift.js]` for per-node, region-named detail.

ERROR: n8n API unreachable → report **that** as the finding (plain words,
  ≤2 sentences), with the B0 environment notes (`.backbrief/deploy/environment.md`)
  and exactly three options: retry / re-run `check-env.js` / open n8n hosting
  docs (`docs/n8n-hosting.md`).

## HANDOFF

Phase A: relay the deterministic **Next** line from `status.js` (first incomplete
rung + its command), plus any Deferred entries worth resuming. Phase B healthy:
"All green — nothing to do" (+ the Deferred line when non-empty). Phase B with
attention: name the single highest-impact fix first.
