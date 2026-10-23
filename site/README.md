<!-- SPDX-License-Identifier: MIT -->
# Backbrief landing page

The product website: one landing page, a privacy policy and terms of use, and a
beta-access form. Static HTML and CSS with no dependencies and no third-party
scripts, built for Cloudflare Pages.

It also serves as the website that startup programs (cloud, model and
speech-to-text credits) check when we apply. `scripts/check.js --release`
enforces what their reviewers verify, so the site cannot go live missing one of
those things.

## Layout

```
site/
├── site.config.json      ← everything that changes per deployment: domain, contact email,
│                            legal entity, team, links, production stats
├── src/                  ← pages (index, privacy, terms, 404) and partials (head, header, footer)
├── assets/               ← styles.css, waitlist.js (form enhancement), logo.svg
├── functions/api/        ← waitlist.js: Cloudflare Pages Function behind the beta form
└── scripts/              ← build.js · check.js · serve.js (zero-dependency Node ≥ 18)
```

## Commands

```bash
cd site
node scripts/build.js              # render pages into dist/
node scripts/check.js              # lint dist/: structure, links, no third-party assets, wording
node scripts/check.js --release    # also fails on TODO placeholders, unreviewed legal text,
                                   # contact email off the site's domain
node scripts/serve.js              # preview at http://localhost:8788 (form runs in dry-run mode)
```

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

## Deploy (Cloudflare Pages)

- Project root directory: `site`
- Build command: `node scripts/build.js`
- Build output directory: `dist`
- Functions are picked up from `site/functions/`.
- Environment variable `WAITLIST_API`: base URL of your telemetry gateway
  (`gateway/`). The default is the hosted gateway.

The beta form posts to `/api/waitlist` on the same domain. The function
forwards the email to the gateway's `POST /v1/waitlist` with `interest:
"hosted"`, so emails are still stored in exactly one place. Waitlist entries
have no automatic expiry: the privacy policy promises deletion when the beta
ends, so delete them then.

`_headers` sets a strict Content Security Policy (`'self'` only). Any external
script, font or stylesheet will be blocked by the browser and also fails
`check.js`.
