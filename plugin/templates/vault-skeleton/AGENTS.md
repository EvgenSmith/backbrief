<!--
  Backbrief template — the operating manual for the customer's agents.
  Rendered by init-vault.js at A0: `<Company>` is replaced with tenant.name
  from tenant.yaml. All other angle-bracket forms (`<Lastname>`, `<team>`,
  `<Other>`, `<topic-word>`, `<ISSUE-KEY>`) are illustrative placeholders
  inside recipes and stay literal.
  Language policy: template structure, file/folder names, frontmatter keys,
  and controlled-vocabulary values are English tokens; narrative content
  (digest text, decisions, task titles, quotes) follows the call's language.
  Keep this file <= 100 lines: agents load it whole, every session. It states
  rules, never data — data lives in tenant.yaml; the full grammar and the WHY
  behind every rule live in docs/conventions.md.
-->
# <Company> vault — AGENTS.md

This is <Company>'s call-memory vault: every team call becomes a markdown file with
structured frontmatter (context digest + decisions + next steps), maintained by Backbrief.
You — any AI agent — are expected to READ it for context and WRITE to it only by its rules.

Conversation with users mirrors their language. Files follow the conventions below:
structure and frontmatter tokens are English; narrative content is in the call's language.
Full naming grammar + the rationale behind each rule: `docs/conventions.md`.

## Hard rules (read first)

1. **Follow the naming convention exactly:**
   `YYYY-MM-DD HHMM <topic-slug> w <Lastname1,Lastname2>.md` inside `<team>/transcripts/`.
   ASCII only, date first, lastnames only (comma-separated, no space), max 4 names, basename
   ≤ 100 chars; same-minute collision → suffix ` 2`; a raw `.vtt` sibling keeps the identical
   basename. Unsure about a lastname → ask, never guess or use a placeholder. Full grammar:
   `docs/conventions.md`.
2. **Controlled vocabulary is closed.** `team`, `call_type`, `source`, `platform`, statuses
   and priorities take only the values listed in tenant.yaml and
   `docs/templates/controlled-vocabulary.yaml`. New values enter by editing tenant.yaml —
   never ad-hoc in one file.
3. **Do not edit `.vtt` files or the frontmatter of existing transcripts** except via the
   Backbrief skills (digest regen, corrections). Body corrections requested by a user are fine.
4. **Retrieval is local-first:** grep this vault before calling any live API (Slack, tracker) —
   the vault is faster and is the record. Live systems are for what the vault does not hold.
5. **No secrets in the vault.** Credentials live in `.backbrief/secrets.env` (gitignored) or
   the user's env — never in tenant.yaml, never in any .md.
6. **No privacy routing in v0.1 — treat the whole vault as team-shared.** Every call files
   into team folders; there is no `private/` slice. Everyone with repo read access can read
   every call. Need 1:1/board/legal auto-routing? Say so (waitlist interest: privacy).

## How to find things (recipes)

| You want | Do |
|---|---|
| All calls of a team           | `rg -l 'team: product' --glob '**/transcripts/*.md'` |
| Calls in a date range         | filenames sort chronologically: `ls <team>/transcripts/ \| sort` |
| Who decided X                 | `rg -A2 'X' --glob '**/transcripts/*.md'` then read the Decisions section |
| Open commitments of a person  | `rg 'owner: <Lastname>' --glob '**/transcripts/*.md'` (frontmatter action_items) |
| A person's role/zones/aliases | read `team/<Lastname>.md` |
| Everything about a topic      | `rg -l '<topic-word>'` then prefer files whose `tags:` match |
| What a task came from         | tracker issue links back; or `rg '<ISSUE-KEY>' tasks/ --glob '*.tasks.md'` |

## Folder map

- `<team>/transcripts/` — one .md per call (digest + frontmatter) + optional .vtt sibling
- `general/` — cross-team calls and calls whose team could not be resolved
- `team/` — one profile per person: `<Lastname>.md` (role, zones, aliases). Resolve any name
  variant to its canonical lastname via the `aliases` list before using it as an owner token.
  (`team/` is people; team folders like `product/` hold calls — never name a team tag "team".)
- `tasks/` — per-call task artifacts (every draft + the user's decision + tracker links).
  Fixed verdict markers: ✏️ CREATE · 💬 COMMENT · ⚠️ FLAG · 🔁 DUPLICATE
- `docs/conventions.md` — the full writing contract (grammar + WHYs); `docs/templates/` —
  frontmatter templates + controlled vocabulary (copy heads from here when writing manually)
- `docs/company.md` — company profile (what we do, products, priorities); loaded as context
  for every digest and task run — keep it current and ≤ 60 lines
- `docs/skills/summarizer.md` — this team's digest house style; edit it to change every
  future digest (no code)
- `pipeline/dlq/` — failed-run artifacts written by the automatic pipeline; may contain
  transcript content — do not quote it outside the vault; recover via `/backbrief status`
- `tenant.yaml` — configuration: teams, roster, feature flags
- `.backbrief/` — machine state; not content, do not edit by hand. Human-readable exception:
  `.backbrief/roadmap.md` — setup steps deferred so far + the exact resume command for each

## Writing a new file

Use the Backbrief skills (`/backbrief start`, `…tasks`) — they apply the templates in order.
Writing manually: copy the matching template head from `docs/templates/` (works on a fresh
vault), fill it per `docs/conventions.md`, then validate (`validate-vault.js` from the
Backbrief plugin scripts — or just ask your agent to validate). No Backbrief plugin
installed? `docs/conventions.md` IS the contract — match it. A file that fails validation
must not be committed.
