# Vault conventions (and why)

The full writing contract for this vault — for humans and for ANY agent, with or
without the Backbrief plugin installed. `AGENTS.md` is the short version agents
load every session; this file is the reference it links to. Machine-readable
templates live in `docs/templates/`. Every rule carries its WHY, so you can
change things without breaking what the rule protects.

## Transcript file naming

```
<team>/transcripts/YYYY-MM-DD HHMM <topic-slug> w <Lastname1,Lastname2>.md
```

Validator regex (verbatim — what `validate-vault.js` enforces):

```
^\d{4}-\d{2}-\d{2} \d{4} [a-z0-9][a-z0-9 -]{2,60}( w [A-Z][A-Za-z'-]+(,[A-Z][A-Za-z'-]+){0,3})?( \d)?\.(md|vtt)$
```

| Part | Rule | Why |
|---|---|---|
| `YYYY-MM-DD HHMM` | call start, tenant timezone, 24h, no colon | date-first makes `ls` a timeline; colons break on Windows and in URLs |
| `<topic-slug>` | 2–6 words, lowercase, ASCII English only, plain spaces | filesystem/git/URL portability across every OS and agent; also a leak guard — email-shaped and native-script names never end up in filenames. The original-language topic lives in frontmatter `topic:` |
| `w <Lastnames>` | `w` = "with"; canonical Latin lastnames, comma-separated, NO space after the comma, max 4; 5+ people → drop the whole `w` part | the filename is a human hint — the full roster lives in frontmatter `participants:`, which is the queryable record |
| collision suffix | same minute + same slug (rare re-filed call) → append ` 2` before the extension | true duplicates are caught by content-hash dedup and skipped — the suffix exists only for genuinely distinct calls |
| length cap | basename ≤ 100 characters | headroom for archives, Windows path limits, and URL encoding |
| separators | plain spaces and hyphen-minus only; **no en dash (–), no `{}` tokens** | en dash is a lookalike character that silently breaks regexes and greps; brace tokens duplicate what the path and frontmatter already encode |
| `.vtt` sibling | the raw transcript keeps the IDENTICAL basename next to the `.md` | pairing is trivial, nothing to keep in sync, one atomic commit per call |

Spaces in filenames are a deliberate tradeoff: human readability beats shell
convenience — quote your globs. Never guess a lastname and never write a
placeholder: ask.

## The lastname token

One Latin `Lastname` is the canonical token for a person **everywhere**:
filenames (`w Ivanova`), frontmatter `participants:`, `action_items[].owner`,
tracker assignee resolution, and the profile basename `team/<Lastname>.md`.
WHY: one token makes person lookup a directory listing plus a basename match;
a second spelling silently splits one person's history in two.

- **Collisions** (two people sharing a surname): `<Lastname>-<Firstinitial>`
  (e.g. `Kim-J`), used consistently in ALL the places above, including the
  profile filename and its `lastname:` field.
- **Every other form** a person is called — nicknames, native-script spellings,
  declined forms, chat handles — lives in the profile `aliases:` list (the
  name-map that resolves speech to the one token). Never in filenames.
- **Departed people**: set profile `status: stale`, never delete — WHY: their
  token keeps resolving in historical digests.

## Frontmatter is the retrieval surface

The folder tree is only routing; queries run against frontmatter
(`rg 'team: product'` works even on a misfiled file — frontmatter survives
moves). Consequences, all validator-enforced:

- Keys are a **closed set** per `schema_version` — unknown keys are rejected.
  WHY: structure that cannot drift stays queryable forever.
- Enum values come from the controlled vocabulary
  (`docs/templates/controlled-vocabulary.yaml`). New values enter ONLY by
  editing `tenant.yaml` + the `AGENTS.md` mirror — never ad-hoc in one file.
  WHY: one ad-hoc value and the vocabulary stops meaning anything for search.
- `tags:` is the only open field (freeform kebab-case EN).
- `action_items:` is a MIRROR of the digest body, not the source. WHY: agents
  query commitments without parsing prose; humans read the body.

## Privacy routing — deliberately not in v0.1

Privacy routing (auto-routing 1:1/board/legal calls into private slices, DM
delivery, confidential handling) is deliberately NOT part of v0.1 — every call
files into team folders and posts to the digest channel. If your team needs
it, say so (waitlist interest: privacy) — it exists in the reference
production deployment and ships when demand shows.

Practical consequence: everyone with read access to this vault repo can read
every filed call. Don't feed calls you wouldn't share with the whole vault
audience.

## Folder grammar + reserved root names

- `<team>/transcripts/` — team folders come from `tenant.yaml vault.teams[]`;
  `transcripts/` is the only pre-created subfolder (the path segment doubles as
  the type signal). Add `decisions/`, `docs/`, `research/` the day the first
  file needs them — no empty scaffolding (empty trees rot and mislead).
- `general/` — the mixed/unresolved route. A real team folder, not a junk
  drawer: digests here get full treatment.
- `team/` (literal, singular) — PEOPLE, one profile per person, flat. Do not
  confuse with team folders like `product/`. **Reserved root names** that can
  never be team tags or folders: `team`, `tasks`, `docs`, `private`,
  `pipeline`, `.backbrief` (validator-enforced) — the skeleton owns them.
  (`private` stays reserved even though v0.1 creates no such folder — the
  privacy-routing feature will claim it.)
- `.backbrief/` — machine state, do not edit by hand. Human-readable
  exception: `.backbrief/roadmap.md` — setup steps deferred so far, what each
  unlocks, and the exact resume command.

## Digest + tasks rules (the short list)

- Digest section order is FIXED (Summary / Decisions / Agreements / Next steps
  / Open questions / Key insights / Transcript); empty sections say `None.` —
  WHY: parseability beats prettiness; a missing heading is indistinguishable
  from a failed generation.
- **Agreements ≠ Decisions ≠ Next steps.** Agreements (who owes whom, informal)
  are what teams lose most; the split gives task extraction a clean boundary —
  next steps feed the tracker, agreements never do.
- Timestamps `(MM:SS)` are real or absent, never faked — the deep-link promise
  dies with one fabricated anchor.
- One `.tasks.md` per processed call — even zero-task and all-skipped calls.
  WHY: it is the audit trail and the answer to "why is there no task for X".
- Issue bodies follow the 4-block canon, headers verbatim: `📌 Context` /
  `✅ Task` / `🎯 Expected result` / `📎 Additional information`
  (`docs/templates/task-4block.md`). WHY: reviewers scan by heading and the
  feedback loop assumes the structure.
- Task verdict markers are fixed: `✏️ CREATE · 💬 COMMENT · ⚠️ FLAG · 🔁 DUPLICATE`.

## Language policy

Structure is English — file/folder names, frontmatter keys, enum values, tags,
slugs. Narrative — digest text, decisions, quotes, task titles — follows the
language of the call. WHY: one grep works across a multilingual corpus, and
any agent can parse any file; the team still reads its own language.

## No plugin? No problem

This document plus `docs/templates/` are the complete contract — they live in
YOUR vault and survive plugin uninstall. Copy a template head, fill it by the
rules above, and (if available) run the Backbrief `validate-vault.js` before
committing. The one-line WHY next to each rule below is the rationale you need.
