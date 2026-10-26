<!-- ==========================================================================
  Backbrief task 4-block template — spec v1.
  The canonical issue-body structure for every task the kit creates, in both
  execution modes:
    · Phase A (plugin, manual): the /tasks procedure reads THIS FILE when
      composing draft bodies — both for tracker-created issues AND for the
      file-only copy-paste blocks in tasks/*.tasks.md (same four blocks).
    · Phase B (pipeline): the TaskCrafter composer prompt carries the same
      structure; the header strings are rendered into the TENANT_PROMPT
      region from the language packs (pipeline/lang/<lang>.pack.json,
      key `task_block_headers`), selected by tenant.primary_language.
  This file is the ENGLISH CANON. To change wording for another language,
  edit that language's pack, then re-render/redeploy (tenant-render.js /
  deploy-pipeline.js). Editing this file alone changes Phase A drafts
  immediately but does NOT reach a deployed pipeline.
  Block ORDER and SEMANTICS are fixed — reviewers scan by heading, and the
  feedback loop (wrong_title / wrong_owner verdicts) assumes them.
=========================================================================== -->
# Task 4-block template (EN canon)

Every created issue body has exactly four blocks, all mandatory, in this
order, headers verbatim:

```markdown
## 📌 Context
[1-3 sentences. Why this task exists — what was discussed on the call and
the business reason. Reference the call topic. Name collaborators/helpers
mentioned around the task. Do NOT echo the transcript.]

## ✅ Task
[≤5 sentences. WHAT to do, specifically. One action verb, one owner,
a concrete deliverable — kept VERBATIM as named on the call (a "slide"
stays a slide, not a "deck"). Constraints if any.]

## 🎯 Expected result
[1-3 sentences. The verifiable outcome — what artifact, state change, or
metric proves completion. Observable definition of done.]

## 📎 Additional information

**Source:**
- Call: «<call topic>» (<start_time>)
- Quote: «<transcript_quote>» (<MM:SS>)
- Slack thread: <link, or "see the digest channel">
- Vault: <link to the transcript/digest file, or "pending">
- Created by: <plugin | pipeline> · <YYYY-MM-DD>
```

## Writing rules

1. **Title** (issue title, not a block): action verb first, ≤80 chars,
   concrete. Same semantics as the extracted draft — refine wording only.
2. **Scale block length to task complexity.** Trivial task → one line per
   block. Complex task → fuller paragraphs. Never pad.
3. **Never fabricate** tracker refs, dates, links, or names that are not in
   the source material. Write "TBD" or omit the line.
4. **Sensitive content** (compensation, equity, personnel evaluations,
   customer PII, NDA material) never reaches an issue body — it is filtered
   upstream; if encountered, sanitize and flag instead of composing.
5. **The Source footer is the audit trail** — it is what makes a task
   traceable back to the call ((MM:SS) deep link) and the vault artifact.
   Keep every line that has data.

## Language note

- **Header strings are per-language**: this file is the English canon; each
  language pack carries the translation under `task_block_headers`
  (`ru` ships the production-verbatim «📌 Контекст / ✅ Задача /
  🎯 Ожидаемый результат / 📎 Дополнительная информация»). The pipeline picks
  the tenant's `primary_language`; issue bodies live in the tracker in the
  team's working language — headers do not mirror per call.
- **Narrative text** (block contents, title) follows the language-mirroring
  clause: the team's working language, mirroring the
  transcript when its dominant language is another of the tenant's languages.
- **Code tokens stay English** always: tracker identifiers (ABC-123),
  priorities, status enums, lastnames in Latin script.
