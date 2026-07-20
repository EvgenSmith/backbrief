#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
/*
 * render.test.js — golden-file tests for tenant-render.js.
 *
 * Covers, per region renderer:
 *   1. acme-en fixture (inline; mirrors plugin/templates/tenant.yaml.example
 *      until T8 ships pipeline/fixtures/tenants/acme-en.yaml) — golden
 *      assertions on every region kind.
 *   2. vostok-ru-shaped inline fixture (fictional RU+EN tenant, Cyrillic
 *      aliases, subteams, partners) — proves config-independence + pack union.
 *   3. Deploy-resolved pipeline-state rendering (Slack ids, tracker UUIDs).
 *   4. Determinism (same inputs ⇒ byte-identical) and idempotency (re-render
 *      of rendered output is a no-op).
 *   5. The shipped pipeline/code/** matches a fresh render of
 *      plugin/templates/tenant.yaml.example (the golden-path example block —
 *      contract: fresh clone runs green with zero config).
 *   6. Alias-collision hard fail.
 *
 * Zero dependencies. Exit 0 = green, 1 = failures.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KIT = path.join(__dirname, '..', '..');
const R = require(path.join(KIT, 'pipeline', 'tenant-render.js'));

let passed = 0;
let failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`✖ ${name}${detail ? ` — ${detail}` : ''}`);
}
function includes(hay, needle, name) {
  ok(hay.includes(needle), name, `missing: ${JSON.stringify(needle).slice(0, 120)}`);
}
function excludes(hay, needle, name) {
  ok(!hay.includes(needle), name, `unexpected: ${JSON.stringify(needle).slice(0, 120)}`);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// Minimal acme-en fixture — golden-path EN tenant. Keep in sync with
// plugin/templates/tenant.yaml.example (T8's acme-en.yaml supersedes this).
const ACME_YAML = `
schema_version: 1
tenant:
  name: Acme Robotics
  about: Builds warehouse robots and the SkyDock fleet-management platform for mid-size logistics operators.
  persona: company_lead
  internal_domains: [acme.dev]
  languages: [en]
  primary_language: en
  timezone: America/New_York
vault:
  repo: null
  branch: main
  teams:
    - tag: product
      folder: product
      description: Product management, specs, pricing, roadmap
      keywords: [roadmap, spec, pricing, launch]
    - tag: engineering
      folder: engineering
      description: Backend, firmware, infra, releases
      keywords: [deploy, bug, api, firmware]
    - tag: growth
      folder: growth
      description: Marketing, sales, partnerships, community
      keywords: [campaign, lead, partnership, funnel]
  mixed_folder: general
roster:
  - lastname: Novak
    first_name: Elena
    email: elena@acme.dev
    role: CEO & co-founder
    aliases: [El, Elena N]
    home_team: PRD
    is_owner: true
  - lastname: Chen
    first_name: Wei
    email: wei@acme.dev
    role: Product lead
    aliases: [W, Wei C]
    home_team: PRD
glossary:
  - canonical: SkyDock
    variants: [sky dock, skydoc, sky-doc]
extraction:
  voice:
    wake_words: [backbrief]
features:
  slack:
    enabled: true
    digest_channel: "#call-digests"
  tracker:
    enabled: true
    kind: linear
    team_mapping:
      - team_tag: product
        tracker_team_key: PRD
        default_assignee: Novak
      - team_tag: engineering
        tracker_team_key: ENG
        default_assignee: Chen
    provenance_label: backbrief
    thresholds:
      comment: 0.75
      flag_discovery: 0.55
      flag_planning: 0.35
      dedup_confirmed_days: 14
      dedup_pending_hours: 48
llm:
  summarizer: {model: claude-sonnet-4-6, max_tokens: 16384}
pipeline:
  knobs:
    min_duration_min: 5
    replay_window_sec: 900
    transcript_char_cap: 60000
`;

// Fictional RU+EN tenant (vostok-ru-shaped): Cyrillic aliases, subteams.
// Zero real-company strings.
const VOSTOK_YAML = `
schema_version: 1
tenant:
  name: Vostok Labs
  internal_domains: [vostok.example]
  languages: [ru, en]
  primary_language: ru
  timezone: Europe/Belgrade
vault:
  repo: vostok-labs/team-vault
  branch: main
  teams:
    - tag: product
      folder: product
      description: Product and platform
      keywords: [roadmap, platform]
      subteams:
        - tag: mobile
          folder: product/mobile
          description: Mobile app
          aliases: []
    - tag: ops
      folder: ops
      description: Operations and finance
  mixed_folder: general
roster:
  - lastname: Sokolov
    first_name: Pyotr
    email: pyotr@vostok.example
    aliases: [Петя, Пётр, Соколов, Sokoloff]
    home_team: PLT
    is_owner: true
  - lastname: Lebedeva
    first_name: Anna
    email: anna@vostok.example
    aliases: [Аня, Лебедева]
    home_team: OPS
glossary:
  - canonical: OrbitaX
    variants: [orbita x, орбита икс]
extraction:
  voice:
    wake_words: [vostokbot]
features:
  slack:
    enabled: true
    digest_channel: "#call-digests"
  tracker:
    enabled: true
    kind: linear
    team_mapping:
      - team_tag: product
        tracker_team_key: PLT
        default_assignee: Sokolov
      - team_tag: ops
        tracker_team_key: OPS
        default_assignee: Lebedeva
`;

const STATE_FIXTURE = {
  slack: {
    user_ids: { Novak: 'U00000AAA11', Chen: 'U00000BBB22' },
    channels: { digest: 'C00000DIG01' },
  },
  tracker: {
    url_base: 'https://linear.app/acme-robotics',
    label_id: '00000000-0000-4000-8000-00000000fee1',
    teams: {
      PRD: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Product', todo_state_id: '00000000-0000-4000-8000-0000000000ab' },
      ENG: { id: '00000000-0000-4000-8000-0000000000ba', name: 'Engineering', todo_state_id: '00000000-0000-4000-8000-0000000000bb' },
    },
    users: { Novak: '00000000-0000-4000-8000-0000000000ca' },
  },
};

function ctxFor(yamlText, state) {
  const tenant = R.parseYaml(yamlText);
  const packs = R.loadLangPacks(tenant, path.join(KIT, 'pipeline', 'lang'));
  return R.buildContext(tenant, packs, state || {}, { kitRoot: KIT });
}

/* ------------------------------------------------------------------ */
/* 1. acme-en golden assertions per region                             */
/* ------------------------------------------------------------------ */

const acme = ctxFor(ACME_YAML);

const roster = R.RENDERERS.ROSTER(acme);
includes(roster, "const OWNER_LASTNAME = 'Novak';", 'ROSTER: owner');
includes(roster, "const INTERNAL_DOMAINS = ['acme.dev'];", 'ROSTER: internal domains');
includes(roster, "Elena: 'Novak'", 'ROSTER: first name → lastname');
includes(roster, "Wei: 'Chen'", 'ROSTER: second person');
includes(roster, "wei: 'Chen'", 'ROSTER: email localpart map');
includes(roster, 'const SURNAME_ALIAS_MAP = {}', 'ROSTER: no Latin surname variants for acme');
includes(roster, 'const CYRILLIC_LASTNAME_MAP = {}', 'ROSTER: empty Cyrillic map for EN tenant');
includes(roster, "Novak: 'PRD'", 'ROSTER: home team');
includes(roster, 'const LASTNAME_TO_TEAM = USER_HOME_TEAM;', 'ROSTER: both const names');
includes(roster, 'const SLACK_USER_ID_BY_LASTNAME = {};', 'ROSTER: empty Slack map pre-deploy');
includes(roster, "const OWNER_ALIASES_PATTERN = 'elena n|elena|novak|el';", 'ROSTER: owner alias alternation longest-first');

const routing = R.RENDERERS.ROUTING(acme);
includes(routing, "const TENANT_NAME = 'Acme Robotics';", 'ROUTING: tenant name');
includes(routing, "const KIT_VERSION = '0.1.0';", 'ROUTING: kit VERSION stamp');
includes(routing, "const REPO_OWNER = '';", 'ROUTING: null repo → empty coords');
includes(routing, "product: 'product/transcripts/'", 'ROUTING: team folder + /transcripts/');
includes(routing, "mixed: 'general/transcripts/'", 'ROUTING: mixed folder');
includes(routing, "const VALID_TEAM = new Set(['engineering', 'growth', 'mixed', 'product']);", 'ROUTING: VALID_TEAM incl. mixed');
includes(routing, "PRD: 'product'", 'ROUTING: tracker→vault team bridge');
includes(routing, 'const GUESS_FOLDER_TABLE = [', 'ROUTING: guessFolder table');
includes(routing, "const COMPANY_PROFILE_PATH = 'docs/company.md';", 'ROUTING: company profile path (vault.company_profile_path default)');
// Privacy routing is not in v0.1 — no private-folder consts may render.
excludes(routing, 'PRIVATE_FOLDER_RE', 'ROUTING: no private-folder regex (privacy routing removed)');
excludes(routing, 'PERSONAL_1ON1_FOLDER_TEMPLATE', 'ROUTING: no 1on1 route template');
excludes(routing, 'BOARD_PRIVATE_FOLDER', 'ROUTING: no board route');
excludes(routing, 'SENSITIVITY_FOLDER', 'ROUTING: no sensitivity folder map');
excludes(routing, 'private/', 'ROUTING: no private/ folder leaks into the guess table');

const slack = R.RENDERERS.SLACK(acme);
includes(slack, "const OWNER_SLACK_USER_ID = '';", 'SLACK: owner id empty pre-deploy');
includes(slack, "const PUBLIC_CHANNEL_ID = '#call-digests';", 'SLACK: digest channel name pre-resolve (kit-wide default)');
excludes(slack, 'BOARD_CHANNEL_ID', 'SLACK: no board channel (privacy routing removed)');
excludes(slack, 'DM_POLICY', 'SLACK: no dm policy (privacy routing removed)');
includes(slack, "const DISPLAY_TIMEZONE = 'America/New_York';", 'SLACK: timezone');

const tracker = R.RENDERERS.TRACKER(acme);
includes(tracker, "const VALID_TRACKER_TEAM = new Set(['ENG', 'PRD']);", 'TRACKER: team keys');
includes(tracker, 'const TEAM_TO_ID = {};', 'TRACKER: no UUIDs pre-deploy');
includes(tracker, 'const TEAM_MAP = {};', 'TRACKER: no TEAM_MAP entries pre-deploy (router degrades to triage)');
includes(tracker, "PRD: 'product'", 'TRACKER: TEAM_DISPLAY still carries all keys pre-deploy');
includes(tracker, 'const COMMENT_THRESHOLD = 0.75;', 'TRACKER: thresholds');
includes(tracker, 'const FLAG_THRESHOLD_PLANNING = 0.35;', 'TRACKER: planning threshold');
includes(tracker, 'const LABEL_FROM_CALL_ID = null;', 'TRACKER: label null pre-deploy');

const gloss = R.RENDERERS.GLOSSARY(acme);
includes(gloss, "'SkyDock'", 'GLOSSARY: canonical term');
{
  // Compiled variants actually catch the ASR forms.
  const m = gloss.match(/\[\/(.*?)\/gi, 'SkyDock'\]/);
  ok(!!m, 'GLOSSARY: compiled regex present');
  if (m) {
    const re = new RegExp(m[1].replace(/\\\//g, '/'), 'gi');
    ok(re.test('the sky  dock deployment'), 'GLOSSARY: multi-space variant matches');
  }
}

const lang = R.RENDERERS.LANG(acme);
includes(lang, 'const DOMAIN_BRIDGE = {};', 'LANG: EN-only tenant → empty bridge');
includes(lang, 'const INFLECTION_SUFFIXES = [];', 'LANG: EN-only tenant → no suffixes');
includes(lang, 'const CYR_TO_LAT = {}', 'LANG: EN-only tenant → empty translit table');
includes(lang, "'prepare the report'", 'LANG: EN discriminator list');
includes(lang, "'main.summary_header': ':speech_balloon: *Summary*'", 'LANG: EN ui_strings');
excludes(lang, "'_note':", 'LANG: annotation keys stripped');
includes(lang, "'main.digest_footer': '_via Backbrief_'", 'LANG: via-Backbrief digest footer shipped');
includes(lang, 'Backbrief · tasks — {count} proposals', 'LANG: tasks header rebranded (no user-facing TaskCrafter)');

const prompt = R.RENDERERS.PROMPT(acme);
includes(prompt, "const PROMPT_TENANT_NAME = 'Acme Robotics';", 'PROMPT: tenant name');
includes(prompt, 'Write all narrative fields in English.', 'PROMPT: single-language degenerate clause');
includes(prompt, '"engineering" | "growth" | "mixed" | "product"', 'PROMPT: team enum');
includes(prompt, "const SUB_TAG_ENUM = 'null';", 'PROMPT: no subteams → null enum');
includes(prompt, 'Backend, firmware, infra, releases → ENG', 'PROMPT: team inference rules');
includes(prompt, '«backbrief»', 'PROMPT: wake word');
includes(prompt, 'PRD-123', 'PROMPT: tracker ref example from first team key');
includes(prompt, 'Novak', 'PROMPT: few-shots use tenant roster');
includes(prompt, "const COMPANY_CONTEXT = 'About Acme Robotics: Builds warehouse robots", 'PROMPT: COMPANY_CONTEXT rendered from tenant.about');

const llm = R.RENDERERS.LLM(acme);
includes(llm, "model: 'claude-sonnet-4-6'", 'LLM: summarizer model');
includes(llm, "const LLM_MATCHER = {", 'LLM: matcher stage present (defaults)');
includes(llm, "thinking: 'adaptive'", 'LLM: matcher thinking default');

const knobs = R.RENDERERS.KNOBS(acme);
includes(knobs, 'const MIN_DURATION_MIN = 5;', 'KNOBS: min duration');
includes(knobs, 'const REPLAY_WINDOW_SEC = 900;', 'KNOBS: replay window');
includes(knobs, 'const TTL_FILE_MS = 12 * 60 * 60 * 1000;', 'KNOBS: cache TTL');

/* ------------------------------------------------------------------ */
/* 2. vostok-ru fixture — config-independence + pack union             */
/* ------------------------------------------------------------------ */

const vostok = ctxFor(VOSTOK_YAML);

const vRoster = R.RENDERERS.ROSTER(vostok);
includes(vRoster, "const OWNER_LASTNAME = 'Sokolov';", 'vostok ROSTER: owner');
includes(vRoster, "'Петя': 'Sokolov'", 'vostok ROSTER: Cyrillic nickname → firstname map');
includes(vRoster, "'Соколов': 'Sokolov'", 'vostok ROSTER: Cyrillic surname → cyrillic map');
includes(vRoster, "Sokoloff: 'Sokolov'", 'vostok ROSTER: Latin surname variant → alias map');
{
  // Verify the alias split put Соколов in CYRILLIC_LASTNAME_MAP, not FIRSTNAME.
  const cyr = vRoster.slice(vRoster.indexOf('CYRILLIC_LASTNAME_MAP'));
  includes(cyr, 'Соколов', 'vostok ROSTER: surname in Cyrillic map section');
  const surn = vRoster.slice(vRoster.indexOf('SURNAME_ALIAS_MAP'), vRoster.indexOf('CYRILLIC_LASTNAME_MAP'));
  includes(surn, 'Sokoloff', 'vostok ROSTER: Latin variant in surname-alias section');
}

const vRouting = R.RENDERERS.ROUTING(vostok);
includes(vRouting, "const REPO_OWNER = 'vostok-labs';", 'vostok ROUTING: repo owner split');
includes(vRouting, "const REPO_NAME = 'team-vault';", 'vostok ROUTING: repo name split');
includes(vRouting, "'product:mobile': 'product/mobile/transcripts/'", 'vostok ROUTING: subteam folder');
includes(vRouting, "const VALID_SUB_TAG = new Set(['mobile']);", 'vostok ROUTING: sub tag set');

ok(R.RENDERERS.SENSITIVITY === undefined, 'SENSITIVITY renderer removed with privacy routing');

const vLang = R.RENDERERS.LANG(vostok);
includes(vLang, "'линт': 'eslint lint'", 'vostok LANG: ru domain bridge');
includes(vLang, "'А': 'A'", 'vostok LANG: transliteration table');
includes(vLang, "'подготовить отчёт'", 'vostok LANG: ru discriminator tokens');
includes(vLang, "'prepare the report'", 'vostok LANG: en discriminator unioned (languages: ru+en)');
{
  // ui_strings come from the PRIMARY language pack (ru), not en.
  const sIdx = vLang.indexOf('const S = ');
  ok(sIdx > 0 && /Пропущено|Сводка|Создано|Резюме/.test(vLang.slice(sIdx)), 'vostok LANG: ru ui_strings selected');
}

const vPrompt = R.RENDERERS.PROMPT(vostok);
includes(vPrompt, 'Write all narrative fields in Russian', 'vostok PROMPT: mirroring clause primary=ru');
includes(vPrompt, 'Russian and is one of Russian, English', 'vostok PROMPT: languages list in clause');
includes(vPrompt, '«vostokbot»', 'vostok PROMPT: tenant wake word');
includes(vPrompt, '«в задачу»', 'vostok PROMPT: ru directive verbs from pack');
includes(vPrompt, "const COMPANY_CONTEXT = '';", 'vostok PROMPT: COMPANY_CONTEXT empty when tenant.about unset');

/* ------------------------------------------------------------------ */
/* 3. Deploy-resolved pipeline-state rendering                         */
/* ------------------------------------------------------------------ */

const acmeDeployed = ctxFor(ACME_YAML, STATE_FIXTURE);
const dRoster = R.RENDERERS.ROSTER(acmeDeployed);
includes(dRoster, "Novak: 'U00000AAA11'", 'state ROSTER: Slack ids from pipeline-state');
const dSlack = R.RENDERERS.SLACK(acmeDeployed);
includes(dSlack, "const OWNER_SLACK_USER_ID = 'U00000AAA11';", 'state SLACK: owner id resolved');
includes(dSlack, "const PUBLIC_CHANNEL_ID = 'C00000DIG01';", 'state SLACK: channel id resolved');
const dTracker = R.RENDERERS.TRACKER(acmeDeployed);
includes(dTracker, "PRD: '00000000-0000-4000-8000-0000000000aa'", 'state TRACKER: team UUIDs');
includes(dTracker, "todoStateId: '00000000-0000-4000-8000-0000000000ab'", 'state TRACKER: todo state id');
includes(dTracker, "const LABEL_FROM_CALL_ID = '00000000-0000-4000-8000-00000000fee1';", 'state TRACKER: label id');
includes(dTracker, "const TRACKER_URL_BASE = 'https://linear.app/acme-robotics';", 'state TRACKER: url base');

{
  // Legacy pipeline-state shape (pre-fix test-creds cached bare id strings):
  // the renderer tolerates it — team ids survive into TEAM_TO_ID / TEAM_MAP,
  // the Todo state just stays unresolved until the next test-creds run.
  const legacy = ctxFor(ACME_YAML, {
    tracker: { teams: { PRD: '00000000-0000-4000-8000-0000000000aa' } },
  });
  const lTracker = R.RENDERERS.TRACKER(legacy);
  includes(lTracker, "PRD: '00000000-0000-4000-8000-0000000000aa'", 'legacy state TRACKER: TEAM_TO_ID keeps the bare-string id');
  includes(lTracker, "teamId: '00000000-0000-4000-8000-0000000000aa'", 'legacy state TRACKER: TEAM_MAP entry built from the bare string');
  includes(lTracker, 'todoStateId: null', 'legacy state TRACKER: todo state unresolved for legacy entries');
}

/* ------------------------------------------------------------------ */
/* 4. Determinism + idempotency on a real shipped file                 */
/* ------------------------------------------------------------------ */

{
  const sample = fs.readFileSync(
    path.join(KIT, 'pipeline', 'code', 'transcripts', 'extract-metadata.js'), 'utf8');
  const once = R.renderSource(sample, acme);
  const twice = R.renderSource(once.source, acme);
  ok(once.source === twice.source, 'render is idempotent (re-render is a no-op)');
  ok(once.regions.join(',') === 'ROSTER,LANG,KNOBS', 'extract-metadata carries expected regions',
    `got: ${once.regions.join(',')}`);
  const again = R.renderSource(sample, ctxFor(ACME_YAML));
  ok(once.source === again.source, 'render is deterministic (fresh context, byte-identical)');
}

/* ------------------------------------------------------------------ */
/* 5. Shipped code == fresh render of tenant.yaml.example              */
/* ------------------------------------------------------------------ */

{
  const exampleCtx = (() => {
    const tenant = R.loadTenant(path.join(KIT, 'plugin', 'templates', 'tenant.yaml.example'));
    const packs = R.loadLangPacks(tenant, path.join(KIT, 'pipeline', 'lang'));
    return R.buildContext(tenant, packs, {}, { kitRoot: KIT });
  })();
  const files = R.listNodeFiles(path.join(KIT, 'pipeline', 'code'));
  ok(files.length >= 30, 'pipeline/code carries the copied node set', `got ${files.length}`);
  let regionFiles = 0;
  let stale = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const res = R.renderSource(src, exampleCtx);
    if (res.regions.length === 0) continue;
    regionFiles++;
    if (res.source !== src) stale.push(path.basename(f));
  }
  ok(regionFiles >= 24, 'enough files carry TENANT regions', `got ${regionFiles}`);
  ok(stale.length === 0, 'shipped code matches fresh render of tenant.yaml.example',
    `stale: ${stale.join(', ')}`);
}

/* ------------------------------------------------------------------ */
/* 6. Alias collision hard fail                                        */
/* ------------------------------------------------------------------ */

{
  let threw = false;
  try {
    R.buildNameMaps([
      { lastname: 'Novak', first_name: 'Elena', aliases: ['El'] },
      { lastname: 'Chen', first_name: 'Wei', aliases: ['El'] },
    ]);
  } catch (e) {
    threw = /collision/.test(e.message);
  }
  ok(threw, 'alias mapping to two lastnames hard-fails');
}

/* ------------------------------------------------------------------ */
/* 7. Roster email -> EMAIL_TO_LASTNAME localpart keys                  */
/* ------------------------------------------------------------------ */

{
  // Localpart deliberately matches neither first name nor lastname nor any
  // alias — only the roster `email` can produce this key (Zoom attendance
  // resolution depends on it: lastnameFromEmail walks EMAIL_TO_LASTNAME).
  const MINI_YAML = `
schema_version: 1
tenant:
  name: Mini Co
  internal_domains: [mini.example]
  languages: [en]
roster:
  - lastname: Zhou
    first_name: Ming
    email: mz@mini.example
    is_owner: true
`;
  const mini = ctxFor(MINI_YAML);
  const mRoster = R.RENDERERS.ROSTER(mini);
  includes(mRoster, "mz: 'Zhou'", 'ROSTER: roster email localpart keys EMAIL_TO_LASTNAME');
}

/* ------------------------------------------------------------------ */
/* 8. Language-pack ui_strings key parity (new-language contract)      */
/* ------------------------------------------------------------------ */

{
  const readPack = (lang) => JSON.parse(
    fs.readFileSync(path.join(KIT, 'pipeline', 'lang', `${lang}.pack.json`), 'utf8'));
  const keysOf = (pack) => Object.keys(pack.ui_strings || {})
    .filter((k) => !k.startsWith('_')).sort();
  const en = keysOf(readPack('en'));
  const ru = keysOf(readPack('ru'));
  const missingInRu = en.filter((k) => !ru.includes(k));
  const missingInEn = ru.filter((k) => !en.includes(k));
  ok(missingInRu.length === 0 && missingInEn.length === 0,
    'lang packs carry identical ui_strings key sets',
    `ru missing: [${missingInRu}] en missing: [${missingInEn}]`);
  ok(en.includes('main.digest_footer'), 'packs ship the via-Backbrief digest footer key');
}

/* ------------------------------------------------------------------ */

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
