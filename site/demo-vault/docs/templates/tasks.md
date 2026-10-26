---
# ============================================================================
# Backbrief tasks artifact — spec v1 (schema_version: 1).
# File: tasks/<call-file-basename>.tasks.md — written by A3 for EVERY call.
# With a tracker it is the audit trail + backlinks; without one it IS the
# deliverable (copy-paste blocks). Every extracted draft appears, including
# skipped ones, with the user's decision — the human-readable twin of the
# training log. Zero-task calls still get the file, with
# counts: {extracted: 0} and one line: "No actionable items — valid outcome."
# Keys and enum values are English tokens; titles/quotes follow the call's
# language. Example values below describe a fictional team.
# ============================================================================
type: tasks
schema_version: 1
call: "product/transcripts/2026-07-10 1300 pricing model review w Ivanova,Petrov.md"
team: product
date: 2026-07-10
tracker: linear                  # linear | none (file-only mode)
autonomy_level: L0               # which approval mode produced these decisions (L0 | L1 | L2)
generated: 2026-07-10T13:52:00Z
counts: { extracted: 4, created: 2, commented: 1, skipped: 1 }
---

# Tasks — Pricing model review (2026-07-10)

<!-- One block per extracted draft, in extraction order. Verdict marker vocabulary is fixed:
     ✏️ CREATE · 💬 COMMENT · ⚠️ FLAG · 🔁 DUPLICATE -->

## 1. ✏️ CREATE — Rewrite pricing page copy for the self-serve tier
- owner: **Ivanova** (growth) · priority: high · (14:32)
- quote: "надо переписать прайсинг под self-serve до пятницы"
- dedup: no similar issues in backlog
- **decision: accepted → [GRW-214](https://linear.app/acme/issue/GRW-214)**

## 2. 💬 COMMENT on [GRW-180](https://linear.app/acme/issue/GRW-180) — "Pricing revamp"
- the call adds a deadline (Friday) and owner; commenting instead of duplicating
- quote: "это же по сути тот самый тикет про прайсинг" (18:05)
- **decision: accepted → comment posted**

## 3. ⚠️ FLAG — Update the billing FAQ
- looks 60% like GRW-102; owner unresolved
- **decision: skipped by user** ("already covered")

## 4. ✏️ CREATE — Ask legal about the annual-plan wording
- owner: **Petrov** · priority: medium · (41:10)
- **decision: accepted — file-only (no tracker connected)**
- copy-paste block (Description follows the 4-block canon — frontmatter/task-4block.md):
  ```
  Title:    Ask legal about the annual-plan wording
  Assignee: Petrov
  Priority: Medium
  Description:
    ## 📌 Context
    Annual-plan wording came up during the pricing model review — legal
    sign-off is needed before the new pricing page ships.
    ## ✅ Task
    Ask legal to review the annual-plan wording on the pricing page.
    ## 🎯 Expected result
    Written go/no-go from legal on the current wording.
    ## 📎 Additional information
    **Source:** Call: «Pricing model review» (2026-07-10) · Quote: "<quote>"
    (41:10) · Vault: <vault path> · Created by: plugin · 2026-07-10
  ```

---
_Decisions above are logged to `.backbrief/training/task-decisions.jsonl` — this team's
private training data for raising task autonomy (see tenant.yaml `tracker.autonomy_level`)._

<!-- Rules (validator-enforced):
     1. `call:` path must exist; `counts` arithmetic must match the blocks.
     2. `tracker_ref` values written here are mirrored back into the source
        transcript's frontmatter action_items[].tracker_ref — the two-way link
        that makes "task -> which call -> which minute" a two-hop lookup.
     3. File-only mode renders every accepted CREATE as a copy-paste block
        formatted for manual tracker entry; the Description carries the same
        four blocks (task-4block.md) as tracker-created issues. -->

<!-- WHY THIS SHAPE (decision → because):
     · Every draft appears, including skipped ones, with the user's decision —
       this file is the audit trail and the human-readable twin of the
       training log; it answers "why is there no task for X".
     · Zero-task calls still get a file — an absent file is indistinguishable
       from a failed run.
     · Verdict markers are a fixed vocabulary — agents and the feedback loop
       parse the block headings.
     · The 4-block Description is identical in file-only and tracker modes —
       reviewers scan by heading, and the Phase-B feedback loop
       (wrong_title/wrong_owner) assumes the structure.
     Full rationale: the "WHY THIS SHAPE" note above + docs/conventions.md in your vault. -->
