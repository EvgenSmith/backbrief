<!-- ==========================================================================
  Backbrief context-digest template — the BODY of every transcript .md
  (pairs with frontmatter/transcript.md as the head).
  This is the main artifact: what is happening, what was agreed, what happens
  next and on whom — NOT a summary. Section order is FIXED so agents can
  parse by heading. Empty sections render as "None." — never disappear.
  Timestamps are mandatory anchors from the normalized segments; with no
  segment timing (pasted plain text) say so once at the top instead of
  faking anchors. Structure and headings are English; narrative content
  follows the call's language.
=========================================================================== -->
# <Topic> — <YYYY-MM-DD>

> **Digest v0** — generated without team profiles; owners are hints.
> Re-run after `/backbrief profiles` for the enriched version.
<!-- ^ v0 caveat block: present only while digest_version: v0; removed at the
     v1 regen (update-in-place, bump digest_version; git history keeps v0) -->

## Summary

<!-- 3–6 themed subsections. Every theme header carries its (MM:SS) start anchor.
     With recording_url present, render anchors as links: [MM:SS](<recording_url>#t=…).
     Narrative in the call's language. Bold the numbers and commitments. -->

### <Theme 1> (MM:SS)
- what was presented / discussed, with the concrete numbers and names
- …

### <Theme 2> (MM:SS)
- …

## Decisions

<!-- Choices that were MADE on the call: option picked + why. One numbered entry each:
     "<what was decided> — <context/why> (MM:SS)". Empty section stays with "None." -->

1. <Decision> — <why / what it replaces> (MM:SS)

## Agreements

<!-- Mutual commitments between people that are NOT tracker-shaped tasks:
     who owes what to whom, working arrangements, thresholds agreed.
     "<who> ↔ <who>: <commitment> (MM:SS)". This section is what teams lose most often.
     Next steps feed task extraction (A3); agreements do NOT create issues. -->

1. <A> ↔ <B>: <commitment> (MM:SS)

## Next steps

<!-- The operational projection — same items as the frontmatter action_items mirror,
     with the verbatim quote each was extracted from. Three fixed lists: -->

### 📋 Post-call
1. <Title> — **<Owner>** (helpers: <X>) _[priority]_ (MM:SS)
   > <verbatim transcript quote that triggered extraction>

### ✅ Done on call
1. <Title> — **<Owner>** (MM:SS)

### 👀 Monitoring
1. <What to watch, until when> — **<Owner>** (MM:SS)

## Open questions

1. <Question> — <why it was deferred> (MM:SS)

## Key insights

<!-- Non-actionable but load-bearing context: market signal, user quote, risk noticed.
     "<insight> — <implication>". Max 5. -->

1. <Insight> — <implication> (MM:SS)

## Transcript

Raw transcript: [<basename>.vtt](<basename>.vtt) · Recording: <recording_url or "not retained">

<!-- ^ Transcript footer rendering: with raw_retention: none there is no .vtt
     sibling — render "Raw transcript: not retained · Recording: …" (same
     fallback wording as recording_url). The section heading always stays. -->

<!-- WHY THIS SHAPE (decision → because):
     · Agreements ≠ Decisions ≠ Next steps — agreements (who owes whom,
       informal) are what teams lose most often; the split gives task
       extraction a clean boundary: next steps feed the tracker, agreements
       never create issues.
     · Fixed section order + empty sections render "None." — parseability
       beats prettiness; a missing heading is indistinguishable from a failed
       generation.
     · Timestamps are real or absent, never faked — the deep-link promise
       dies with one fabricated anchor.
     · The frontmatter action_items mirror duplicates Next steps on purpose —
       agents query commitments without parsing prose; this body stays
       authoritative for humans.
     · v0 → v1 regen updates the file in place and bumps digest_version —
       git history keeps v0; no appendix sprawl.
     Full rationale: the "WHY THIS SHAPE" note above + docs/conventions.md in your vault. -->
