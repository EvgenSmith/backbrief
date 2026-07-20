# team/ — people profiles

One profile per person, flat, top-level: `<Lastname>.md` (canonical Latin
lastname, matching the roster in tenant.yaml). Never nest profiles — the
pipeline and skills locate a profile by listing this folder and matching the
basename; a subfolder makes the person invisible. Lastname collisions:
`<Lastname>-<Firstinitial>.md`, used consistently everywhere the token appears
(filenames, participants, owners).

Profiles hold role, responsibility zones, typical partners, optional corp
`email` (resolves Slack/tracker identity and Zoom attendance — members only,
never externals), and the `aliases` name-map: every form speech and chat
actually produce (native scripts, declensions, nicknames, display names,
handles). Aliases are what resolve any spoken variant to the one canonical
token. This file is the source of truth for a person — the tenant.yaml roster
is generated from it at B1; edit here, then re-run generate-tenant.

No compensation, performance, or HR data ever goes here — profiles are shared
vault content read by every agent session; sensitive person-data belongs
outside the shared vault entirely. Departed members are marked `status: stale`,
never deleted (history keeps resolving). Profiles stay ~1 page on purpose:
each is injected whole into the summarizer for every call the person attends —
size is a token budget.

Template: `docs/templates/team-profile.md` (copied into this vault at init);
`/backbrief profiles` (step A2) builds these for you.
