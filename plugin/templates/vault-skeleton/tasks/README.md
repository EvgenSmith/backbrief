# tasks/ — per-call task artifacts

One `.tasks.md` per processed call, always written whether or not a tracker is
connected: `tasks/<call-file-basename>.tasks.md` (basename pairs deterministically
with the call file). Each file lists every extracted draft — including skipped
ones — with the user's decision and tracker backlinks; with no tracker connected
it carries copy-paste blocks and *is* the deliverable. Zero-task calls still get
a file ("No actionable items — valid outcome.").

Template: `docs/templates/tasks.md` (copied into this vault at init); written
by `/backbrief tasks` (step A3). Draft verdict markers are fixed:
✏️ CREATE · 💬 COMMENT · ⚠️ FLAG · 🔁 DUPLICATE.
