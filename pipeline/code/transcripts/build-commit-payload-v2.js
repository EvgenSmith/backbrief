// SPDX-License-Identifier: BUSL-1.1
// n8n Code node — runs once per item.
// Inputs:
//   $json.topic, .participants_lastnames, .start_time, .duration_min,
//   .zoom_meeting_uuid, .zoom_share_url, .vtt_content,
//   .classification (from Anthropic classify: { team, tags[], topic_slug }),
//   .summary  (from Anthropic summarize: 3-5 sentence string)
// Output: commit-ready payload with filename, vault_path, markdown_body, content_b64.
//
// Naming spec v1 (human mirror: the vault's docs/conventions.md):
//   <team-folder>/transcripts/YYYY-MM-DD HHMM <topic-slug> w <Lastname1,Lastname2>.md
// - Date first → ls sorts chronologically. 24h tenant-local time, no colon.
// - <topic-slug> = classification.topic_slug (LLM emits 2-6 kebab-case English
//   words), dashes replaced by spaces. Falls back to the cleaned raw topic only
//   when topic_slug is missing; non-ASCII is stripped (the pipeline never
//   writes non-Latin filenames).
// - "w <Lastnames>": max 4 comma-separated Latin lastnames; 5+ participants →
//   the whole "w" part is omitted (roster lives in frontmatter).
// - ≤100 chars basename. No en dash, no brace tokens.
//
// Folder routing: TEAM_TO_FOLDER / SUB_TAG_FOLDER are GENERATED from
// tenant.yaml (vault.teams, subteams) — TENANT regions below.

// ── __TENANT_ROSTER_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const OWNER_LASTNAME = 'Novak';
const OWNER_ALIASES_PATTERN = 'elena n|elena|novak|el'; // longest-first, regex alternation
const INTERNAL_DOMAINS = ['acme.dev'];
const FIRSTNAME_TO_LASTNAME = {
  Andrei: 'Petrov',
  'Andrei P': 'Petrov',
  Andy: 'Petrov',
  El: 'Novak',
  Elena: 'Novak',
  'Elena N': 'Novak',
  Maria: 'Ivanova',
  'Maria I': 'Ivanova',
  Masha: 'Ivanova',
  Sam: 'Okafor',
  Sammy: 'Okafor',
  W: 'Chen',
  Wei: 'Chen',
  'Wei C': 'Chen',
};
const SURNAME_ALIAS_MAP = {};
const CYRILLIC_LASTNAME_MAP = {};
const EMAIL_TO_LASTNAME = {
  andrei: 'Petrov',
  andy: 'Petrov',
  chen: 'Chen',
  el: 'Novak',
  elena: 'Novak',
  ivanova: 'Ivanova',
  maria: 'Ivanova',
  masha: 'Ivanova',
  novak: 'Novak',
  okafor: 'Okafor',
  petrov: 'Petrov',
  sam: 'Okafor',
  sammy: 'Okafor',
  w: 'Chen',
  wei: 'Chen',
};
const USER_HOME_TEAM = {
  Chen: 'PRD',
  Ivanova: 'GRW',
  Novak: 'PRD',
  Okafor: 'GRW',
  Petrov: 'ENG',
};
const LASTNAME_TO_TEAM = USER_HOME_TEAM; // participant→team bias (same data, both prod const names kept)
const SLACK_USER_ID_BY_LASTNAME = {}; // deploy-resolved (pipeline-state) + per-roster overrides
// ── __TENANT_ROSTER_END__ ──
// ── __TENANT_ROUTING_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const TENANT_NAME = 'Acme Robotics';
const KIT_VERSION = '0.1.0';
const REPO_OWNER = ''; // empty until B4 wires vault.repo
const REPO_NAME = '';
const BRANCH = 'main';
const PROFILES_FOLDER = 'team';
const SUMMARIZER_SKILL_PATH = 'docs/skills/summarizer.md';
const COMPANY_PROFILE_PATH = 'docs/company.md'; // company profile (born at A0) — size-capped context injection
const DLQ_FOLDER = 'pipeline/dlq';
const TRAINING_DATA_PATH = '.backbrief/training/feedback.jsonl'; // feedback training log (JSONL)
const TEAM_TO_FOLDER = {
  engineering: 'engineering/transcripts/',
  growth: 'growth/transcripts/',
  mixed: 'general/transcripts/',
  product: 'product/transcripts/',
};
const SUB_TAG_FOLDER = {};
const TRACKER_TO_VAULT_TEAM = {
  ENG: 'engineering',
  GRW: 'growth',
  PRD: 'product',
};
const LINEAR_TO_VAULT_TEAM = TRACKER_TO_VAULT_TEAM; // prod const name kept for diff reviewability
const VALID_TEAM = new Set(['engineering', 'growth', 'mixed', 'product']);
const VALID_SUB_TAG = new Set([]); // null also allowed
const VALID_SUB_FOR_TEAM = {
};
const GUESS_FOLDER_TABLE = [ // heuristic prior-context prefetch — wrong guess degrades gracefully
  { re: /product|roadmap|spec|pricing|launch/i, folder: 'product/transcripts/' },
  { re: /engineering|deploy|bug|api|firmware/i, folder: 'engineering/transcripts/' },
  { re: /growth|campaign|lead|partnership|funnel/i, folder: 'growth/transcripts/' },
];
const MIXED_FOLDER = 'general/transcripts/';
const RAW_RETENTION = 'vtt'; // none | vtt | vtt_mp4
// ── __TENANT_ROUTING_END__ ──
// ── __TENANT_SLACK_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const SLACK_ENABLED = true; // features.slack.enabled — false ⇒ builders post nothing
const OWNER_SLACK_USER_ID = ''; // deploy-resolved (test-creds.js slack)
const PUBLIC_CHANNEL_ID = '#call-digests'; // digest channel — name until deploy resolves the id
const DISPLAY_TIMEZONE = 'America/New_York';
// ── __TENANT_SLACK_END__ ──
// ── __TENANT_LLM_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const LLM_COMPOSER = {
  max_tokens: 8192,
  model: 'claude-haiku-4-5',
};
const LLM_FEEDBACK = {
  max_tokens: 4096,
  model: 'claude-sonnet-4-6',
};
const LLM_MATCHER = {
  effort: 'high',
  max_tokens: 32000,
  model: 'claude-opus-4-8',
  thinking: 'adaptive',
};
const LLM_NORMALIZER = {
  max_tokens: 8192,
  model: 'claude-sonnet-4-6',
};
const LLM_SUMMARIZER = {
  max_tokens: 16384,
  model: 'claude-sonnet-4-6',
};
// ── __TENANT_LLM_END__ ──

const SOURCE = 'zoom';

function topicSlug(s) {
  return String(s || 'untitled')
    .toLowerCase()
    .replace(/[^a-zа-я0-9\s\-]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Filename-friendly English topic string.
// Priority:
//   1. classification.topic_slug — Anthropic-generated kebab-case English (2-6 words). Best.
//   2. Cleaned raw Zoom topic — fallback when topic_slug missing. May contain non-latin.
// Returns lowercase space-separated.
function topicForFilename(rawTopic, topicSlugFromCls) {
  if (typeof topicSlugFromCls === 'string' && topicSlugFromCls.trim()) {
    return topicSlugFromCls.trim().toLowerCase().replace(/-+/g, ' ');
  }
  return topicSlug(rawTopic);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDateTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  // Tenant-local call start — tenant.timezone via Intl; UTC fallback
  // if the runtime lacks the tz database entry.
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: DISPLAY_TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    const hour = p.hour === '24' ? '00' : p.hour;  // ICU hour-24 quirk
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}${p.minute}` };
  } catch (e) {
    const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const time = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
    return { date, time };
  }
}

// Render participant for display in filename. needs_review entries are dropped from
// the filename (kept in frontmatter as objects) so the filename never contains "?".
function participantToFilenameToken(p) {
  if (typeof p === 'string') return p;
  if (p && p.lastname) return p.lastname;
  return null; // needs_review without lastname — skip in filename
}

// Kit naming spec v1 — REWRITTEN from the prod grammar (which used
// brace tokens + a trailing en-dash date). Date-first, ASCII-only, ≤100 chars:
//   YYYY-MM-DD HHMM <topic-slug> w <Lastname1,Lastname2>.md
// The {zoom} source token moved to frontmatter `source:`; the team tag moved
// to the folder + frontmatter `team:` (deliberately dropped from the filename).
const FILENAME_MAX = 100;
function buildFilename(topic, participants, date, time) {
  // ASCII-only slug: strip non-[a-z0-9 -] after lowercase. Non-English calls
  // normally arrive with an English topic_slug from the LLM; the raw-topic
  // fallback loses non-ASCII characters by design.
  let slug = String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9 \-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  if (!slug) slug = 'untitled call';

  const ext    = '.md';
  const prefix = `${date} ${time} `;
  // Max 4 lastnames; 5+ participants → omit the whole "w" part (naming spec).
  let names = (participants || []).map(participantToFilenameToken).filter(Boolean);
  if (names.length > 4) names = [];
  let partStr = names.join(',');
  // Length budget: drop lastnames one by one, then trim the slug.
  while (names.length > 0 &&
         (prefix.length + slug.length + 3 /* " w " */ + partStr.length + ext.length) > FILENAME_MAX) {
    names.pop();
    partStr = names.join(',');
  }
  if (names.length === 0) {
    const budget = FILENAME_MAX - prefix.length - ext.length;
    slug = slug.slice(0, Math.max(3, budget)).trim();
    return `${prefix}${slug}${ext}`;
  }
  return `${prefix}${slug} w ${partStr}${ext}`;
}

function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  // V1.7.26 (2026-07-08): the old check missed several YAML indicator chars, so
  // a raw Zoom topic like "[Sales] Q3" → `topic: [Sales] Q3` parsed as a flow
  // sequence (invalid/misparsed for retrieval agents). Quote when the value is
  // empty, contains `: # "`, has leading/trailing whitespace, or STARTS with any
  // YAML indicator ( ! & * [ ] { } @ ` - ? , > | % : # " ' ).
  //
  // M-promptinj (deep layer, output-side): ALSO force-quote when the value
  // carries a newline / tab / any control char, and escape those chars inside
  // the double-quoted scalar. A crafted LLM field (topic, tag, action-item
  // title) with an embedded newline could otherwise dedent below the block and
  // inject a sibling YAML key or list item into the frontmatter. Double-quoting
  // + `\n` / `\t` / `\xNN` escaping keeps the value on one physical line —
  // lossless (YAML unescapes it back on read), never dropped.
  const needsQuote = s === ''
    || /[:#"]/.test(s)
    || /^\s|\s$/.test(s)
    || /[\u0000-\u001f\u007f]/.test(s)
    || /^[!&*\[\]{}@`\-?,>|%:#"']/.test(s);
  if (needsQuote) {
    const esc = s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/[\u0000-\u001f\u007f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    return `"${esc}"`;
  }
  return s;
}

function yamlValue(v, indent) {
  if (Array.isArray(v)) {
    // Array of strings → flow; array of objects → block list with sub-keys.
    const allScalar = v.every(x => x === null || ['string', 'number', 'boolean'].includes(typeof x));
    if (allScalar) return `[${v.map(yamlScalar).join(', ')}]`;
    // Nested objects — render as YAML block list. Inner array values use yamlValue recursively
    // so e.g. helpers_mentioned: ['Chen', 'Petrov'] renders as flow array, not String([...]).
    const block = v.map(o => {
      const entries = Object.entries(o).map(([k, vv]) => {
        const rendered = Array.isArray(vv) ? yamlValue(vv, `${indent}    `) : yamlScalar(vv);
        return `${indent}    ${k}: ${rendered}`;
      });
      return `${indent}  -\n${entries.join('\n')}`;
    }).join('\n');
    return `\n${block}`;
  }
  return yamlScalar(v);
}

// V1.4 — render one action item with status badge, helpers, direction, linear ref, voice marker.
// Used by both Tasks (post-call) and Done-on-call sections.
function renderActionItem(ai, num) {
  const title    = ai.title || '(no title)';
  const who      = ai.assignee_hint ? ` — **${ai.assignee_hint}**` : '';
  const prio     = ai.priority_hint ? ` _[${ai.priority_hint}]_` : '';
  const helpers  = Array.isArray(ai.helpers_mentioned) && ai.helpers_mentioned.length > 0
    ? ` (helpers: ${ai.helpers_mentioned.map(h => `**${h}**`).join(', ')})` : '';
  const linRef   = ai.linear_ref_hint ? ` → \`${ai.linear_ref_hint}\`` : '';
  const dir      = ai.direction && ai.direction !== 'internal' ? ` _[${ai.direction}]_` : '';
  const voice    = ai.voice_marker ? ` 🎤_${ai.voice_marker}_` : '';
  const quote    = ai.transcript_quote ? `\n   > ${String(ai.transcript_quote).replace(/\n+/g, ' ').trim()}` : '';
  return `${num}. ${title}${who}${helpers}${prio}${dir}${linRef}${voice}${quote}`;
}

function buildActionItemsMd(items) {
  if (!Array.isArray(items) || items.length === 0) return '_(none)_';
  // V1.4 — split by status. Tasks (post-call) get top billing, monitoring/done-on-call go below for audit.
  const tasks      = items.filter(ai => (ai.status || 'post-call') === 'post-call' || (ai.status || 'post-call') === 'in-progress');
  const doneOnCall = items.filter(ai => ai.status === 'done-on-call');
  const monitoring = items.filter(ai => ai.status === 'monitoring');
  const out = [];
  if (tasks.length > 0) {
    out.push('### 📋 Tasks (post-call)', '', tasks.map((ai, i) => renderActionItem(ai, i + 1)).join('\n'));
  }
  if (doneOnCall.length > 0) {
    out.push('', '### ✅ Done on call (no Linear task)', '', doneOnCall.map((ai, i) => renderActionItem(ai, i + 1)).join('\n'));
  }
  if (monitoring.length > 0) {
    out.push('', '### 👀 Monitoring (ongoing observation)', '', monitoring.map((ai, i) => renderActionItem(ai, i + 1)).join('\n'));
  }
  return out.length > 0 ? out.join('\n') : '_(none)_';
}

function buildDecisionsMd(items) {
  if (!Array.isArray(items) || items.length === 0) return '_(none)_';
  return items.map((d, i) => {
    const ctx = d.context ? ` — ${d.context}` : '';
    return `${i + 1}. ${d.title || '(no title)'}${ctx}`;
  }).join('\n');
}

function buildOpenQuestionsMd(items) {
  if (!Array.isArray(items) || items.length === 0) return '_(none)_';
  return items.map((q, i) => {
    const why = q.why_deferred ? ` — _${q.why_deferred}_` : '';
    return `${i + 1}. ${q.question || '(no question)'}${why}`;
  }).join('\n');
}

function buildInsightsMd(items) {
  if (!Array.isArray(items) || items.length === 0) return '_(none)_';
  return items.map((k, i) => {
    const impl = k.implication ? ` → ${k.implication}` : '';
    return `${i + 1}. ${k.insight || '(no insight)'}${impl}`;
  }).join('\n');
}

// buildSensitiveFlagsMd removed V1.5.6 — sensitive_flags dropped from flow.

function buildNext24_48hMd(items) {
  if (!Array.isArray(items) || items.length === 0) return '_(none)_';
  return items.map((n, i) => {
    const when = n.when ? ` — **${n.when}**` : '';
    return `${i + 1}. ${n.action || '(no action)'}${when}`;
  }).join('\n');
}

function buildBody({
  frontmatter, summary, decisions, action_items, open_questions,
  key_insights, next_24_48h, transcript_filename, transcript_chars,
  // sensitive_flags removed V1.5.6 — see backlog #17
}) {
  const fmYaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${yamlValue(v, '')}`)
    .join('\n');

  // V1.4 — full .vtt moved to separate file (frontmatter.transcript_file points to it).
  // Vault .md stays human-readable; agents wanting raw turns load the .vtt sibling.
  const transcriptRef = transcript_filename
    ? `_Full transcript: <./${encodeURI(transcript_filename)}> (${transcript_chars} chars, WebVTT)._`
    : '_(transcript unavailable)_';

  return [
    `---`,
    fmYaml,
    `---`,
    ``,
    `## Summary (Quick brief)`,
    ``,
    summary,
    ``,
    `## Decisions`,
    ``,
    buildDecisionsMd(decisions),
    ``,
    `## Action items`,
    ``,
    buildActionItemsMd(action_items),
    ``,
    `## Open questions`,
    ``,
    buildOpenQuestionsMd(open_questions),
    ``,
    `## Key insights`,
    ``,
    buildInsightsMd(key_insights),
    ``,
    `## Next 24-48h`,
    ``,
    buildNext24_48hMd(next_24_48h),
    ``,
    `## Transcript`,
    ``,
    transcriptRef,
    ``,
  ].join('\n');
}

// PARTICIPANT SANITIZATION — fail-soft (prod policy since V1.7).
//
// Previously this was a HARD ASSERTION that threw on any malformed participant
// lastname, dropping the entire meeting from the vault commit. That was the
// V1.0 behavior under hard-rule «no leaks ever». In practice one upstream bug
// (e.g. Anthropic leaking a topic phrase into a lastname slot) lost the whole
// recording — disproportionate.
//
// V1.7 policy: skip the broken participant (record as a `needs_review` warning
// in the payload so we can still notice), keep the meeting. Empty `lastNames`
// is already tolerated downstream.
//
// Accepts strings ("Chen") OR objects with { lastname?, needs_review?: true }.
function sanitizeParticipants(arr, ctx) {
  const warnings = [];
  if (!Array.isArray(arr)) {
    warnings.push(`participants not an array (got ${typeof arr}); treating as empty (${ctx})`);
    return { clean: [], warnings };
  }
  const clean = [];
  for (const p of arr) {
    const isString    = typeof p === 'string';
    const lastname    = isString ? p : (p && p.lastname);
    const needsReview = !isString && p && p.needs_review === true;
    if (needsReview) { clean.push(p); continue; }                                // already tagged — keep
    if (!lastname) {
      warnings.push(`dropped: missing lastname and no needs_review tag — ${JSON.stringify(p)}`);
      continue;
    }
    if (/\s/.test(lastname)) {
      warnings.push(`dropped: whitespace in lastname (firstname leak?) — "${lastname}"`);
      continue;
    }
    if (/[<>@]/.test(lastname)) {
      warnings.push(`dropped: forbidden char in lastname (email leak?) — "${lastname}"`);
      continue;
    }
    if (!/^[A-Za-z][A-Za-z\-']*$/.test(lastname)) {
      warnings.push(`dropped: non-Latin lastname — "${lastname}" (upstream extract-metadata lastName() should have transliterated)`);
      continue;
    }
    clean.push(p);
  }
  return { clean, warnings };
}

const items = $input.all();

// ── Team/folder determination (two-tier cascade) ────────────────────────────
// LLM context (cls.team) stays PRIMARY for the team (strongest signal on real
// calls — a naive title→owner→context order regressed 6/11 real calls in
// prod). OWNER tiebreak applies only when context yields no team
// (team === 'mixed'). Every call lands in its team folder
// (mixed → the general folder) — TEAM_TO_FOLDER / SUB_TAG_FOLDER from the
// TENANT_ROUTING region.

// Owner → vault team (tiebreak only). Zoom omits participants, so host_email
// is the reliable owner signal; participants_lastnames used when present.
// EMAIL_TO_LASTNAME / USER_HOME_TEAM come from the TENANT_ROSTER region;
// TRACKER_TO_VAULT_TEAM (tracker key → vault team tag) from TENANT_ROUTING.
function teamFromOwner(j) {
  const parts = (j.participants_lastnames || []).filter(x => typeof x === 'string' && x);
  let ln = parts.find(x => x !== OWNER_LASTNAME) || null;
  if (!ln) {
    const local = String(j.host_email || '').toLowerCase().split('@')[0];
    ln = EMAIL_TO_LASTNAME[local] || parts[0] || null;
  }
  const lt = ln ? USER_HOME_TEAM[ln] : null;
  return lt ? (LINEAR_TO_VAULT_TEAM[lt] || null) : null;
}

const out = items.map(it => {
  const j   = it.json;
  const cls = j.classification || {};
  // team/subTag via: LLM context → owner tiebreak.
  const ctxTeam = cls.team || 'mixed';
  let team, subTag, teamSource;
  if (ctxTeam !== 'mixed') {
    team = ctxTeam; subTag = cls.sub_tag || null; teamSource = 'context';
  } else {
    team = teamFromOwner(j) || 'mixed'; subTag = null; teamSource = team === 'mixed' ? 'fallback' : 'owner';
  }
  const subKey      = subTag ? `${team}:${subTag}` : null;

  const folder      = (subKey && SUB_TAG_FOLDER[subKey])
                   || TEAM_TO_FOLDER[team]
                   || TEAM_TO_FOLDER.mixed;

  // V1.7.1 (2026-06-09): drop assignee_hint fallback. Conflated assignees with
  // attendees on solo / script-readout calls. parse-anthropic-response.js is
  // now the single point where participants_lastnames is resolved (Zoom-only).
  const lastNamesRaw = j.participants_lastnames || [];
  const { clean: cleanLastNames, warnings: participantWarnings } =
    sanitizeParticipants(lastNamesRaw, `topic="${j.topic}"`);
  if (participantWarnings.length > 0) {
    console.warn(`[build-commit-payload] participant warnings (${participantWarnings.length}):\n  - ${participantWarnings.join('\n  - ')}`);
  }
  const lastNames = cleanLastNames;
  const { date, time } = fmtDateTime(j.start_time);
  const topicForName   = topicForFilename(j.topic, cls.topic_slug);
  // The kit naming spec carries no team tag in the filename — the folder +
  // frontmatter `team:` carry that signal (the prod filename markers were
  // brace tokens, dropped with the grammar — a deliberate drop, documented
  // in docs/conventions.md).
  const filename        = buildFilename(topicForName, lastNames, date, time);
  const vault_path      = `${folder}${filename}`;

  // V1.4 — action_items serialized as YAML so future agents (TaskCrafter retrieval,
  // backlog audit, "who has open tasks from X period" queries) can read frontmatter
  // without parsing markdown. The same data is also rendered as markdown body
  // (buildActionItemsMd) for human reading — single source of truth, dual rendering.
  const actionItemsYaml = (Array.isArray(j.action_items) ? j.action_items : []).map(ai => ({
    title             : ai.title || null,
    status            : ai.status || 'post-call',
    assignee_hint     : ai.assignee_hint || null,
    helpers_mentioned : Array.isArray(ai.helpers_mentioned) ? ai.helpers_mentioned : [],
    priority_hint     : ai.priority_hint || null,
    direction         : ai.direction || null,
    linear_ref_hint   : ai.linear_ref_hint || null,
    voice_marker      : ai.voice_marker || null,
  }));

  // F4-M1 contract fix (additive): validate-vault.js requires schema_version /
  // language / digest_version on every transcript — emit them. `language`
  // arrives from parse-anthropic-response.js (model detected_language →
  // narrative heuristic fallback); guard the ISO 639-1 shape here so a
  // malformed upstream value degrades to 'en' instead of failing the lint.
  const language = (typeof j.language === 'string' && /^[a-z]{2}$/.test(j.language))
    ? j.language : 'en';

  // sensitiveCount removed V1.5.6 — sensitive_flags dropped from flow.
  const frontmatter = {
    project           : TENANT_NAME,
    type              : 'transcript',
    schema_version    : 1,       // F4-M1: frontmatter spec v1 (validator closed key set)
    team,
    ...(subTag ? { sub_tag: subTag } : {}),
    // F4-M1: 'unspecified' is parse-anthropic-response's internal fallback
    // token, not a vocabulary value — treat as null (omit the nullable key).
    ...(cls.call_type && cls.call_type !== 'unspecified' ? { call_type: cls.call_type } : {}),
    tags              : ['transcript', SOURCE, ...(cls.tags || [])],
    area              : cls.topic_slug || topicSlug(j.topic).replace(/\s+/g, '-'),
    source            : SOURCE,
    // F4-M1: pipeline digests ship pre-A4-regen — v0 per the controlled
    // vocabulary (v0 = no team context yet; the A4 regen bumps to v1 in place).
    digest_version    : 'v0',
    platform          : 'zoom',
    participants      : lastNames,
    language          : language, // F4-M1: dominant call language, ISO 639-1
    topic             : j.topic,
    date,
    time              : `${time.slice(0, 2)}:${time.slice(2)}`,
    duration_min      : j.duration_min || null,
    zoom_meeting_uuid : j.zoom_meeting_uuid || '',
    filed_by          : 'pipeline',
    filer_model       : LLM_SUMMARIZER.model,
    pipeline_version  : KIT_VERSION,
    // V1.4 — structured action items for agent queries (mirror of markdown body).
    ...(actionItemsYaml.length > 0 ? { action_items: actionItemsYaml } : {}),
    // V1.4 — back-references to prior calls in the same heuristic folder (from STUB-C).
    // Lets retrieval agents walk the discussion graph without re-scanning the vault.
    ...(Array.isArray(j.references_prior_calls) && j.references_prior_calls.length > 0
      ? { references_prior_calls: j.references_prior_calls.slice(0, 5) }
      : {}),
  };

  // V1.4 — emit transcript as a sibling file (.vtt) referenced from the .md.
  // Keeps the markdown human-readable (~5-15 KB) while the raw transcript stays
  // accessible to retrieval agents that need raw speaker turns.
  //
  // B7 — raw_retention privacy control (RAW_RETENTION from the TENANT_ROUTING
  // region, features.raw_retention). 'none' keeps ONLY the digest .md — the raw
  // .vtt is never committed to the vault. 'vtt'/'vtt_mp4' commit the sibling.
  // (MP4 archival to Drive is a separate leg gated by drive.enabled — see the
  // Drive trigger in main.json; documented in the report HANDOFF.)
  const vttContent          = j.vtt_content || '';
  const commitVtt           = !!vttContent && RAW_RETENTION !== 'none';
  const transcript_filename = filename.replace(/\.md$/, '.vtt');
  const transcript_path     = `${folder}${transcript_filename}`;

  // Add transcript_file pointer to frontmatter so agents can resolve the sibling.
  if (commitVtt) frontmatter.transcript_file = transcript_filename;

  const markdown_body = buildBody({
    frontmatter,
    summary             : j.summary || '(summary unavailable)',
    decisions           : Array.isArray(j.decisions)       ? j.decisions       : [],
    action_items        : Array.isArray(j.action_items)    ? j.action_items    : [],
    open_questions      : Array.isArray(j.open_questions)  ? j.open_questions  : [],
    key_insights        : Array.isArray(j.key_insights)    ? j.key_insights    : [],
    // sensitive_flags removed V1.5.6
    next_24_48h         : Array.isArray(j.next_24_48h)     ? j.next_24_48h     : [],
    transcript_filename : commitVtt ? transcript_filename : null,
    transcript_chars    : commitVtt ? vttContent.length : 0,
  });

  return {
    json: {
      ...j,
      filename,
      vault_path,
      team_source: teamSource,   // V1.7.23 debug: which tier chose the team (private-override|context|owner|fallback)
      markdown_body,
      content_b64 : Buffer.from(markdown_body, 'utf-8').toString('base64'),
      github_url  : `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${BRANCH}/${encodeURI(vault_path)}`,
      // V1.7 fail-soft: surface dropped/malformed participants instead of throwing.
      ...(participantWarnings.length > 0 ? { __participant_warnings: participantWarnings } : {}),
      // Transcript sibling — picked up by build-github-body to emit a second PUT.
      // Gated on raw_retention (B7): omitted entirely when RAW_RETENTION==='none'.
      ...(commitVtt ? {
        transcript_filename,
        transcript_vault_path : transcript_path,
        transcript_content_b64: Buffer.from(vttContent, 'utf-8').toString('base64'),
        transcript_github_url : `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${BRANCH}/${encodeURI(transcript_path)}`,
      } : {}),
    },
  };
});

return out;
