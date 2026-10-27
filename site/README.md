<!-- SPDX-License-Identifier: MIT -->
# Backbrief website and cabinet

The product website and the beta cabinet, built for Cloudflare Pages with no
dependencies and no third-party scripts:

- **Landing** (`/`): the product, a privacy policy, terms of use and a
  beta-access form.
- **Demo workspace** (`/demo`): a public cabinet for a fictional team. It is
  built from `demo-vault/`, a real vault that passes the kit's
  `validate-vault.js`.
- **Cabinet** (`/app`): a team logs in with email and password or with Google and
  sees its own calls, digests, action items, task proposals and people. The
  data is read live from the team's vault on GitHub.

It also serves as the website that startup programs (cloud, model and
speech-to-text credits) check when we apply. `scripts/check.js --release`
enforces what their reviewers verify, so the site cannot go live missing one of
those things.

## Layout

```
site/
├── site.config.json      ← everything that changes per deployment: domain, contact email,
│                            legal entity, team, links, production stats, demo settings
├── src/                  ← pages (index, book, privacy, terms, login, cabinet shell, 404) + partials
├── assets/               ← styles.css, logo.svg, fonts/, people/, book.js, login.js, and the workspace:
│                            cabinet.js (shell + window.BB core) with its modules cabinet-{tasks,people,
│                            memory,sources}.js and cabinet-{tasks,people}.css
├── demo-vault/           ← the fictional team's vault behind /demo (kit format, validated in CI)
├── demo.config.json      ← demo-only facts no vault holds (connections, Slack delivery toggles,
│                            ids a click would create); read by build.js for /demo, never by /app
├── lib/                  ← shared by the build and the functions: vault parsing, GitHub reads,
│                            sessions, sign-in, workspace registry
├── functions/api/        ← Cloudflare Pages Functions: book, auth/{request,verify,logout},
│                            me, workspace, call, people
├── scripts/              ← build.js · check.js · serve.js · workspace.js
└── tests/                ← cabinet.test.js (node --test)
```

## Commands

```bash
cd site
node scripts/build.js              # render pages into dist/
node scripts/check.js              # lint dist/: structure, links, no third-party assets, wording
node scripts/check.js --release    # also fails on TODO placeholders, unreviewed legal text,
                                   # contact email off the site's domain
node scripts/serve.js              # preview at http://localhost:8788 — see "Local preview"
node --test tests/cabinet.test.js  # parsing, sessions, sign-in → workspace over HTTP
```

### Local preview

`serve.js` runs every function the way Pages would, with nothing leaving the
machine: an in-memory KV, a mock GitHub API serving `demo-vault/` as a
repository, and password emails printed to the console instead of sent.
Open `/demo` for the public demo. To see the live cabinet, open `/login`, choose
"Forgot password?" for `dev@acme.dev`, follow the link that appears on the
page, set a password, and you are in.

## Before going live

Fill in `site.config.json`, then run `check.js --release` until it passes:

1. **Domain.** Register the product domain first: reviewers have declined
   applications because the domain was only weeks old or had no mail (MX)
   records. `backbrief.ai` belongs to an unrelated company, so it is not an
   option.
2. **Mailboxes on that domain.** `contact_email` must be on the same domain.
   Applicants need their own mailboxes there too (NVIDIA asks for two contacts
   with different addresses).
3. **Legal entity.** `legal.entity_name`, `registration` and `address` must
   match the incorporation certificate exactly, because reviewers compare them
   against the registry. Set `governing_law`.
4. **Legal review.** Have the privacy policy and terms read by someone
   qualified, then set `legal.reviewed: true`.
5. **Team.** Add each person shown on the site with their LinkedIn profile, and
   have them list their current role there. Only add people who have agreed to
   be listed.
6. **Copy.** Several programs screen out sites that look AI-generated. Read
   every sentence and rewrite anything that doesn't sound like you before
   applying.
7. **Stats.** Update `stats` from the production vault and keep `as_of` honest.
8. **Optional:** `links.linkedin_company` (DigitalOcean requires a company
   page), `demo_video_url` (a 2–3 minute walkthrough).

## The cabinet

**What a beta team sees:** an overview (calls processed, action items, task
proposals, duplicates caught, pipeline status), all calls with search and a
team filter, each call's digest with its action items, task proposals and the
earlier calls it was built on, action items across calls, and team profiles.
Everything is read from the team's own vault, and every call links to its file
there.

**Log in** (`/login`, code in `lib/auth.js` and `lib/google.js`):
- Accounts exist only for emails a workspace lists as members. Anyone else who
  tries to log in, reset a password or continue with Google is told there is
  no account for that email and offered a demo. This reveals whether an email
  has an account, on purpose, and is rate limited.
- Email and password: passwords are stored in KV as PBKDF2-SHA256 hashes
  (100 000 iterations, random salt) under `pw:<email>`.
- Forgot password: a member gets a link to `/reset`, stored hashed in KV,
  single use, valid for 30 minutes. Only the POST that sets the new password
  consumes it, so mail scanners that prefetch links cannot burn it. New
  members set their first password this way.
- Continue with Google: OpenID Connect code flow with a state cookie. Only a
  verified Google email that belongs to a workspace gets in. Without
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` the button says Google
  sign-in is unavailable.
- The session is a signed, HttpOnly, SameSite=Lax cookie that lasts 14 days.
  Removing someone from a workspace locks them out on their next request.
- Limits per hour: log in 10 per email and 30 per IP; reset 5 per email and
  30 per IP.

**Onboarding a team** (hand-held during the beta):

1. The team creates a fine-grained GitHub token: their vault repository only,
   permission *Contents: Read-only*.
2. Run `node scripts/workspace.js --id <id> --name "<Team>" --repo <owner/repo>
   [--root <folder>] --member <email> …`. It prints the KV entries, the
   `wrangler` commands that create them, and the secret name for the token
   (`VAULT_TOKEN_<ID>`).
3. Review and run the commands. The token goes into Pages secrets, never into
   KV.

**Limits:**
- Functions on the free plan may make 50 subrequests per request. A workspace
  load is 1 tree read plus one read per call and per tasks file, so the cabinet
  shows the latest 20 calls in detail. Totals still count every call.
  `CALLS_WINDOW` raises the window on a paid plan.
- File bodies are cached by content hash and the file list for a minute, so
  repeat views are cheap.

## Deploy (Cloudflare Pages)

- Project root directory: `site`
- Build command: `node scripts/build.js`
- Build output directory: `dist`
- Functions are picked up from `site/functions/`.
- Bindings and settings:

| Name | Kind | Purpose |
|---|---|---|
| `CABINET` | KV namespace | workspace registry, password hashes, reset tokens, rate limits |
| `SESSION_SECRET` | secret, 32+ chars | signs session cookies; rotating it signs everyone out |
| `MAIL_PROVIDER` | variable | `resend` in production; `log` (default) only prints |
| `RESEND_API_KEY` | secret | Resend API key, when `MAIL_PROVIDER=resend` |
| `MAIL_FROM` | variable | sender on the product domain, e.g. `Backbrief <hello@…>` |
| `VAULT_TOKEN_<ID>` | secret | one per workspace: read-only token for its vault repository |
| `GOOGLE_CLIENT_ID` | variable | Google OAuth client (Web application); redirect URI `https://<domain>/api/auth/google-callback` |
| `GOOGLE_CLIENT_SECRET` | secret | the client's secret |
| `WAITLIST_API` | variable | telemetry gateway base URL (default: the hosted gateway) |
| `CALLS_WINDOW` | variable, optional | calls loaded in detail per workspace view (default 20) |

Never set `DEV_RETURN_LINK` or `WAITLIST_DRY_RUN` in production. They exist
for the local preview.

The book-a-demo form (`/book` and the end of the landing page) posts to
`/api/book` on the same domain. The function
forwards the email to the gateway's `POST /v1/waitlist` with `interest:
"hosted"`, so emails are still stored in exactly one place. Waitlist entries
have no automatic expiry: the privacy policy promises deletion when the beta
ends, so delete them then.

`_headers` sets a strict Content Security Policy (`'self'` only, plus
`frame-src` for the booking calendar when `links.book_demo` is set). Any
external script, font or stylesheet will be blocked by the browser and also
fails `check.js`. Fonts are self-hosted in `assets/fonts/` (Archivo, IBM Plex
Sans and IBM Plex Mono, SIL Open Font License, see `assets/fonts/OFL.txt`).
