#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
/*
 * tenant-render.js — Backbrief TENANT region renderer.
 *
 * Renders tenant.yaml (+ language packs + optional .backbrief/pipeline-state.json)
 * into the generated `__TENANT_<KIND>_BEGIN__ … __TENANT_<KIND>_END__` regions
 * carried by every node source under pipeline/code/**. The node code below each
 * region never changes; n8n Code nodes need no require(). Same proven mechanism
 * as the production name-map region + secret injection, unified.
 *
 * Region kinds (one pure renderer each, golden-file tested in pipeline/tests/render.test.js):
 *   ROSTER      owner, internal domains, 3 name maps, Slack-ID map,
 *               EMAIL_TO_LASTNAME, USER_HOME_TEAM / LASTNAME_TO_TEAM
 *   ROUTING     folder taxonomy, route templates, repo coords, tenant name,
 *               VALID_TEAM / VALID_SUB_* sets, guessFolder table
 *   SLACK       channel ids / owner DM target / timezone
 *   TRACKER     deploy-resolved TEAM_MAP / TEAM_TO_ID / USER_MAP, label id,
 *               URL base, thresholds
 *   GLOSSARY    compiled ASR-fix regex pairs
 *   LANG        stop words, domain bridge, inflection suffixes, transliteration
 *               table, discriminator token lists, UI strings table (S)
 *   PROMPT      generated prompt fragments (team rules, language clause, voice
 *               triggers, status markers, few-shots)
 *   LLM         model/max_tokens/thinking per stage
 *   KNOBS       scalar knobs
 *
 * Determinism: same inputs ⇒ byte-identical output — sorted object
 * keys, stable formatting — so a re-render with no changes is a no-op.
 *
 * Kit script conventions: Node >= 18, zero npm dependencies, --help,
 * DRY_RUN=1 honored on writes, exit codes 0 ok / 1 drift or check failed /
 * 2 operational error.
 *
 * Usage:
 *   node pipeline/tenant-render.js --tenant path/to/tenant.yaml [--state s.json]
 *        [--dir pipeline/code] [--file one-node.js] [--write | --check]
 *
 * --check (default) reports which files' regions differ from a fresh render.
 * --write rewrites the regions in place (the deploy path renders in memory via
 * the exported API instead — deploy-pipeline.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* Minimal YAML-subset parser                                          */
/* Mirrors the embedded parser in plugin/scripts/validate-tenant.js    */
/* (that script is a CLI and exports nothing; the subset contract is   */
/* documented in plugin/templates/tenant.yaml.example).                */
/* ------------------------------------------------------------------ */

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === '\\') { out += line[i + 1] || ''; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) break;
    out += ch;
  }
  return out.replace(/\s+$/, '');
}

function yamlError(msg, lineNum) {
  const e = new Error(`YAML parse error at line ${lineNum}: ${msg}`);
  e.isYamlError = true;
  return e;
}

function parseYaml(text) {
  const lines = [];
  const raw = String(text).split(/\r?\n/);
  for (let n = 0; n < raw.length; n++) {
    if (raw[n].indexOf('---') === 0) throw yamlError('multi-document YAML is not supported', n + 1);
    const stripped = stripComment(raw[n]);
    if (stripped.trim() === '') continue;
    const indentStr = stripped.match(/^[ \t]*/)[0];
    if (indentStr.includes('\t')) throw yamlError('tabs are not allowed for indentation', n + 1);
    lines.push({ text: stripped, indent: indentStr.length, num: n + 1 });
  }
  if (!lines.length) return {};
  const state = { lines, i: 0 };
  const value = parseBlock(state, lines[0].indent);
  if (state.i !== lines.length) {
    throw yamlError('unexpected content (bad indentation?)', lines[state.i].num);
  }
  return value;
}

function isListLine(line, indent) {
  const t = line.text.slice(indent);
  return t === '-' || t.startsWith('- ');
}

function parseBlock(state, indent) {
  const line = state.lines[state.i];
  if (isListLine(line, indent)) return parseListBlock(state, indent);
  return parseMapBlock(state, indent);
}

function parseListBlock(state, indent) {
  const items = [];
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.indent !== indent || !isListLine(line, indent)) break;
    const rest = line.text.slice(indent + 1);
    const pad = rest.match(/^ */)[0].length;
    const content = rest.trim();
    if (content === '') {
      state.i++;
      const next = state.lines[state.i];
      if (!next || next.indent <= indent) throw yamlError('empty list item', line.num);
      items.push(parseBlock(state, next.indent));
    } else if (looksLikeMapEntry(content)) {
      const contentCol = indent + 1 + pad;
      state.lines[state.i] = { text: ' '.repeat(contentCol) + content, indent: contentCol, num: line.num };
      items.push(parseMapBlock(state, contentCol));
    } else {
      items.push(parseScalar(content, line.num));
      state.i++;
    }
  }
  return items;
}

function looksLikeMapEntry(s) {
  if (/^["'\[{]/.test(s)) return false;
  return /^[^:\s][^:]*:( |$)/.test(s);
}

function parseMapBlock(state, indent) {
  const map = {};
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.indent !== indent) {
      if (line.indent > indent) throw yamlError('bad indentation', line.num);
      break;
    }
    if (isListLine(line, indent)) break;
    const t = line.text.slice(indent);
    const m = t.match(/^(?:"([^"]*)"|'([^']*)'|([^:\s][^:]*?))\s*:(?:\s+(.*))?$/);
    if (!m) throw yamlError(`expected "key: value", got: ${t}`, line.num);
    const key = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    const rest = (m[4] || '').trim();
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw yamlError(`duplicate key "${key}"`, line.num);
    }
    if (rest === '') {
      state.i++;
      const next = state.lines[state.i];
      if (next && next.indent > indent) {
        map[key] = parseBlock(state, next.indent);
      } else {
        map[key] = null;
      }
    } else {
      map[key] = parseScalar(rest, line.num);
      state.i++;
    }
  }
  return map;
}

function parseScalar(s, lineNum) {
  s = s.trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    const flow = new FlowParser(s, lineNum);
    const v = flow.parseValue();
    flow.skipWs();
    if (flow.pos !== s.length) throw yamlError('trailing characters after flow value', lineNum);
    return v;
  }
  if (s.startsWith('|') || s.startsWith('>')) {
    throw yamlError('multi-line scalars (| >) are not supported', lineNum);
  }
  if (s.startsWith('&') || s.startsWith('*')) {
    throw yamlError('anchors/aliases are not supported', lineNum);
  }
  return typeScalar(unquoteIfQuoted(s, lineNum));
}

function unquoteIfQuoted(s, lineNum) {
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw yamlError('unterminated single quote', lineNum);
    return { str: s.slice(1, -1).replace(/''/g, "'") };
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw yamlError('unterminated double quote', lineNum);
    return { str: unescapeDouble(s.slice(1, -1)) };
  }
  return s;
}

function unescapeDouble(s) {
  return s.replace(/\\(.)/g, (_, c) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : c === '"' ? '"' : c);
}

function typeScalar(v) {
  if (typeof v === 'object' && v !== null && 'str' in v) return v.str;
  const s = v;
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True') return true;
  if (s === 'false' || s === 'False') return false;
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  return s;
}

class FlowParser {
  constructor(src, lineNum) { this.src = src; this.pos = 0; this.lineNum = lineNum; }
  err(msg) { return yamlError(`${msg} (in flow value)`, this.lineNum); }
  skipWs() { while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++; }
  peek() { return this.src[this.pos]; }

  parseValue() {
    this.skipWs();
    const ch = this.peek();
    if (ch === '[') return this.parseArray();
    if (ch === '{') return this.parseObject();
    if (ch === '"' || ch === "'") return this.parseQuoted();
    return this.parseBare([',', ']', '}']);
  }

  parseArray() {
    this.pos++;
    const arr = [];
    this.skipWs();
    if (this.peek() === ']') { this.pos++; return arr; }
    for (;;) {
      arr.push(this.parseValue());
      this.skipWs();
      const ch = this.peek();
      if (ch === ',') { this.pos++; continue; }
      if (ch === ']') { this.pos++; return arr; }
      throw this.err(`expected "," or "]", got "${ch || 'end of input'}"`);
    }
  }

  parseObject() {
    this.pos++;
    const obj = {};
    this.skipWs();
    if (this.peek() === '}') { this.pos++; return obj; }
    for (;;) {
      this.skipWs();
      let key;
      if (this.peek() === '"' || this.peek() === "'") key = this.parseQuoted();
      else key = String(this.parseBare([':']));
      this.skipWs();
      if (this.peek() !== ':') throw this.err('expected ":" in flow mapping');
      this.pos++;
      obj[key] = this.parseValue();
      this.skipWs();
      const ch = this.peek();
      if (ch === ',') { this.pos++; continue; }
      if (ch === '}') { this.pos++; return obj; }
      throw this.err(`expected "," or "}", got "${ch || 'end of input'}"`);
    }
  }

  parseQuoted() {
    const quote = this.src[this.pos++];
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (quote === '"' && ch === '\\') { out += this.src[this.pos + 1] || ''; this.pos += 2; continue; }
      if (ch === quote) {
        if (quote === "'" && this.src[this.pos + 1] === "'") { out += "'"; this.pos += 2; continue; }
        this.pos++;
        return quote === '"' ? unescapeDouble(out) : out;
      }
      out += ch;
      this.pos++;
    }
    throw this.err('unterminated quoted string');
  }

  parseBare(stops) {
    let out = '';
    while (this.pos < this.src.length && !stops.includes(this.src[this.pos])) {
      out += this.src[this.pos++];
    }
    if (out.trim() === '') throw this.err('empty value');
    return typeScalar(out.trim());
  }
}

/* ------------------------------------------------------------------ */
/* JS-literal emitters (deterministic: sorted keys, stable quoting)    */
/* ------------------------------------------------------------------ */

function jsStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
}

function jsKey(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : jsStr(k);
}

function jsVal(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return arrLit(v);
  if (typeof v === 'object') return objLit(v);
  return jsStr(v);
}

// Multi-line object literal, keys sorted, 2-space indent.
function objLit(map, indent) {
  const pad = ' '.repeat(indent || 2);
  const keys = Object.keys(map).sort();
  if (!keys.length) return '{}';
  const lines = keys.map((k) => `${pad}${jsKey(k)}: ${jsVal(map[k])},`);
  return '{\n' + lines.join('\n') + '\n' + ' '.repeat((indent || 2) - 2) + '}';
}

// One-line array when short, multi-line otherwise. Order preserved (caller
// decides sorting) — pack list order is part of the contract.
function arrLit(arr) {
  const parts = arr.map(jsVal);
  const oneLine = '[' + parts.join(', ') + ']';
  if (oneLine.length <= 96) return oneLine;
  return '[\n' + parts.map((p) => '  ' + p + ',').join('\n') + '\n]';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function regexLit(source, flags) {
  return `/${source.replace(/\//g, '\\/')}/${flags || ''}`;
}

/* ------------------------------------------------------------------ */
/* Context building                                                    */
/* ------------------------------------------------------------------ */

const LANGUAGE_NAMES = {
  de: 'German', en: 'English', es: 'Spanish', fr: 'French', it: 'Italian',
  ja: 'Japanese', ko: 'Korean', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese',
  ru: 'Russian', tr: 'Turkish', uk: 'Ukrainian', zh: 'Chinese',
};

const KNOB_DEFAULTS = {
  min_duration_min: 5,
  normalizer_excerpt_cap: 40000,
  replay_window_sec: 900,
  transcript_char_cap: 60000,
  vault_cache_ttl_file_h: 12,
  vault_cache_ttl_listing_h: 1,
};

const LLM_DEFAULTS = {
  composer: { model: 'claude-haiku-4-5', max_tokens: 8192 },
  feedback: { model: 'claude-sonnet-4-6', max_tokens: 4096 },
  matcher: { model: 'claude-opus-4-8', max_tokens: 32000, thinking: 'adaptive', effort: 'high' },
  normalizer: { model: 'claude-sonnet-4-6', max_tokens: 8192 },
  summarizer: { model: 'claude-sonnet-4-6', max_tokens: 16384 },
};

const THRESHOLD_DEFAULTS = {
  comment: 0.75,
  dedup_confirmed_days: 14,
  dedup_pending_hours: 48,
  flag_discovery: 0.55,
  flag_planning: 0.35,
};

function get(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function loadTenant(tenantPath) {
  return parseYaml(fs.readFileSync(tenantPath, 'utf8'));
}

function loadLangPacks(tenant, langDir) {
  const langs = Array.isArray(get(tenant, 'tenant', 'languages')) && tenant.tenant.languages.length
    ? tenant.tenant.languages : ['en'];
  const packs = [];
  for (const lang of langs) {
    const p = path.join(langDir, `${lang}.pack.json`);
    if (!fs.existsSync(p)) {
      console.warn(`[tenant-render] warning: no language pack for "${lang}" (${p}) — skipping (helpers degrade to identity)`);
      continue;
    }
    packs.push({ lang, data: JSON.parse(fs.readFileSync(p, 'utf8')) });
  }
  warnUiStringsParity(packs);
  return packs;
}

// Pack contract: every pack carries the identical ui_strings key set (the
// new-language recipe is "copy en.pack.json, translate values, never delete
// keys"). A dropped key silently degrades that tenant's Slack strings, so
// warn per missing key against the union of all loaded packs.
function warnUiStringsParity(packs) {
  const union = new Set();
  for (const p of packs) {
    const ui = get(p.data, 'ui_strings') || {};
    for (const k of Object.keys(ui)) {
      if (!k.startsWith('_')) union.add(k);
    }
  }
  for (const p of packs) {
    const ui = get(p.data, 'ui_strings') || {};
    for (const k of [...union].sort()) {
      if (!(k in ui)) {
        console.warn(`[tenant-render] warning: ${p.lang}.pack.json ui_strings is missing "${k}" (present in another pack) — that string degrades for ${p.lang} tenants`);
      }
    }
  }
}

// Union a list-valued pack field across packs, in tenant.languages order.
function packUnion(packs, ...keys) {
  let out = [];
  for (const p of packs) {
    const v = get(p.data, ...keys);
    if (Array.isArray(v)) out = out.concat(v);
  }
  return dedupe(out);
}

// Merge an object-valued pack field across packs (later packs win on key clash).
function packMerge(packs, ...keys) {
  const out = {};
  for (const p of packs) {
    const v = get(p.data, ...keys);
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v);
  }
  return out;
}

function buildContext(tenant, packs, state, opts) {
  opts = opts || {};
  const primaryLang = get(tenant, 'tenant', 'primary_language')
    || (get(tenant, 'tenant', 'languages') || ['en'])[0] || 'en';
  const primaryPack = packs.find((p) => p.lang === primaryLang) || packs[0] || null;
  const roster = Array.isArray(tenant.roster) ? tenant.roster : [];
  const owner = roster.find((p) => p && p.is_owner === true) || roster[0] || null;
  return {
    tenant,
    packs,
    primaryLang,
    primaryPack,
    roster,
    owner,
    state: state || {},
    version: opts.version || readKitVersion(opts.kitRoot),
  };
}

function readKitVersion(kitRoot) {
  const candidates = [
    kitRoot && path.join(kitRoot, 'VERSION'),
    path.join(__dirname, '..', 'VERSION'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return fs.readFileSync(c, 'utf8').trim(); } catch (e) { /* next */ }
  }
  return '0.0.0';
}

/* ------------------------------------------------------------------ */
/* Shared roster derivations                                           */
/* ------------------------------------------------------------------ */

function hasNonLatin(s) {
  return /[^\u0000-\u024F]/.test(String(s));
}

// Split roster aliases into the three canonical name maps:
//   non-Latin alias                          → CYRILLIC_LASTNAME_MAP
//   Latin single-token capitalized alias that shares a ≥3-char prefix with
//   the canonical lastname (surname variant)  → SURNAME_ALIAS_MAP
//   everything else (nicknames, first names)  → FIRSTNAME_TO_LASTNAME
// first_name always joins FIRSTNAME_TO_LASTNAME. Hard-fails when one alias
// maps to two lastnames (ambiguous resolution would misfile artifacts).
function buildNameMaps(roster) {
  const firstname = {};
  const surnameAlias = {};
  const cyrillic = {};
  const claim = (map, key, lastname, kind) => {
    for (const m of [firstname, surnameAlias, cyrillic]) {
      if (m[key] !== undefined && m[key] !== lastname) {
        throw new Error(`roster alias collision: "${key}" maps to both "${m[key]}" and "${lastname}"`);
      }
    }
    if (map[key] === undefined) map[key] = lastname;
  };
  for (const p of roster) {
    if (!p || !p.lastname) continue;
    const ln = String(p.lastname);
    if (p.first_name) claim(firstname, String(p.first_name), ln, 'first');
    for (const alias of Array.isArray(p.aliases) ? p.aliases : []) {
      const a = String(alias).trim();
      if (!a || a === ln) continue;
      if (hasNonLatin(a)) {
        claim(cyrillic, a, ln, 'cyr');
      } else if (!/\s/.test(a) && /^[A-Z]/.test(a)
          && a.slice(0, 3).toLowerCase() === ln.slice(0, 3).toLowerCase() && a.length >= 4) {
        claim(surnameAlias, a, ln, 'surname');
      } else {
        claim(firstname, a, ln, 'first');
      }
    }
  }
  return { firstname, surnameAlias, cyrillic };
}

function buildEmailToLastname(roster) {
  const out = {};
  for (const p of roster) {
    if (!p || !p.lastname) continue;
    const ln = String(p.lastname);
    const keys = [];
    if (p.email && String(p.email).includes('@')) keys.push(String(p.email).split('@')[0]);
    if (p.first_name) keys.push(String(p.first_name));
    keys.push(ln);
    for (const alias of Array.isArray(p.aliases) ? p.aliases : []) {
      if (!hasNonLatin(alias) && !/\s/.test(String(alias))) keys.push(String(alias));
    }
    for (const k of keys.map((s) => s.toLowerCase())) {
      if (out[k] === undefined) out[k] = ln;
    }
  }
  return out;
}

function buildHomeTeams(roster) {
  const out = {};
  for (const p of roster) {
    if (p && p.lastname && p.home_team) out[String(p.lastname)] = String(p.home_team);
  }
  return out;
}

function normFolder(f) {
  let s = String(f || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return s ? s + '/' : '';
}

// Every transcript routes to its team folder (mixed → vault.mixed_folder).
const PUBLIC_ROUTE_TEMPLATE = '{team}/transcripts';

function teamFolders(ctx) {
  const teams = get(ctx.tenant, 'vault', 'teams') || [];
  const pub = PUBLIC_ROUTE_TEMPLATE;
  const out = {};
  for (const t of teams) {
    if (!t || !t.tag) continue;
    out[String(t.tag)] = normFolder(pub.replace('{team}', String(t.folder || t.tag)));
  }
  out.mixed = normFolder(pub.replace('{team}', String(get(ctx.tenant, 'vault', 'mixed_folder') || 'general')));
  return out;
}

function subTagFolders(ctx) {
  const teams = get(ctx.tenant, 'vault', 'teams') || [];
  const pub = PUBLIC_ROUTE_TEMPLATE;
  const out = {};
  for (const t of teams) {
    for (const st of Array.isArray(t && t.subteams) ? t.subteams : []) {
      if (!st || !st.tag) continue;
      const folder = normFolder(pub.replace('{team}', String(st.folder || `${t.folder}/${st.tag}`)));
      out[`${t.tag}:${st.tag}`] = folder;
      for (const alias of Array.isArray(st.aliases) ? st.aliases : []) {
        if (alias && alias.team && alias.sub) out[`${alias.team}:${alias.sub}`] = folder;
      }
    }
  }
  return out;
}

function languageName(code) {
  return LANGUAGE_NAMES[code] || code;
}

function firstTrackerKey(ctx) {
  const mapping = get(ctx.tenant, 'features', 'tracker', 'team_mapping') || [];
  const first = mapping.find((m) => m && m.tracker_team_key);
  return first ? String(first.tracker_team_key) : 'ABC';
}

/* ------------------------------------------------------------------ */
/* Region renderers — one pure function per region kind               */
/* ------------------------------------------------------------------ */

function renderROSTER(ctx) {
  const maps = buildNameMaps(ctx.roster);
  const owner = ctx.owner || {};
  const ownerAliases = dedupe(
    [owner.first_name, owner.lastname]
      .concat(Array.isArray(owner.aliases) ? owner.aliases : [])
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
  ).sort((a, b) => b.length - a.length).map(escapeRegex);
  const homeTeams = buildHomeTeams(ctx.roster);
  const slackIds = {};
  const stateIds = get(ctx.state, 'slack', 'user_ids') || {};
  for (const p of ctx.roster) {
    if (!p || !p.lastname) continue;
    const id = p.slack_user_id || stateIds[p.lastname];
    if (id) slackIds[String(p.lastname)] = String(id);
  }
  const lines = [
    `const OWNER_LASTNAME = ${jsStr(owner.lastname || '')};`,
    `const OWNER_ALIASES_PATTERN = ${jsStr(ownerAliases.join('|'))}; // longest-first, regex alternation`,
    `const INTERNAL_DOMAINS = ${arrLit((get(ctx.tenant, 'tenant', 'internal_domains') || []).map(String))};`,
    `const FIRSTNAME_TO_LASTNAME = ${objLit(maps.firstname)};`,
    `const SURNAME_ALIAS_MAP = ${objLit(maps.surnameAlias)};`,
    `const CYRILLIC_LASTNAME_MAP = ${objLit(maps.cyrillic)};`,
    `const EMAIL_TO_LASTNAME = ${objLit(buildEmailToLastname(ctx.roster))};`,
    `const USER_HOME_TEAM = ${objLit(homeTeams)};`,
    `const LASTNAME_TO_TEAM = USER_HOME_TEAM; // participant→team bias (same data, both prod const names kept)`,
    `const SLACK_USER_ID_BY_LASTNAME = ${objLit(slackIds)}; // deploy-resolved (pipeline-state) + per-roster overrides`,
  ];
  return lines.join('\n');
}

function renderROUTING(ctx) {
  const repo = get(ctx.tenant, 'vault', 'repo');
  const [repoOwner, repoName] = typeof repo === 'string' && repo.includes('/')
    ? repo.split('/') : ['', ''];
  const teams = get(ctx.tenant, 'vault', 'teams') || [];
  const tags = teams.map((t) => String(t.tag)).filter(Boolean);
  const subFolders = subTagFolders(ctx);
  const subTags = dedupe(Object.keys(subFolders).map((k) => k.split(':')[1]));
  const subForTeam = {};
  for (const k of Object.keys(subFolders)) {
    const [team, sub] = k.split(':');
    (subForTeam[team] = subForTeam[team] || []).push(sub);
  }
  const trackerToTeam = {};
  for (const m of get(ctx.tenant, 'features', 'tracker', 'team_mapping') || []) {
    if (m && m.tracker_team_key && m.team_tag) trackerToTeam[String(m.tracker_team_key)] = String(m.team_tag);
  }
  const guess = guessFolderTable(ctx);
  const lines = [
    `const TENANT_NAME = ${jsStr(get(ctx.tenant, 'tenant', 'name') || 'unnamed')};`,
    `const KIT_VERSION = ${jsStr(ctx.version)};`,
    `const REPO_OWNER = ${jsStr(repoOwner)}; // empty until B4 wires vault.repo`,
    `const REPO_NAME = ${jsStr(repoName)};`,
    `const BRANCH = ${jsStr(get(ctx.tenant, 'vault', 'branch') || 'main')};`,
    `const PROFILES_FOLDER = ${jsStr(get(ctx.tenant, 'vault', 'profiles_folder') || 'team')};`,
    `const SUMMARIZER_SKILL_PATH = ${jsStr(get(ctx.tenant, 'vault', 'summarizer_skill_path') || 'docs/skills/summarizer.md')};`,
    `const COMPANY_PROFILE_PATH = ${jsStr(get(ctx.tenant, 'vault', 'company_profile_path') || 'docs/company.md')}; // company profile (born at A0) — size-capped context injection`,
    `const DLQ_FOLDER = ${jsStr(String(get(ctx.tenant, 'vault', 'dlq_folder') || 'pipeline/dlq').replace(/\/+$/, ''))};`,
    `const TRAINING_DATA_PATH = ${jsStr(get(ctx.tenant, 'vault', 'training_data_path') || '.backbrief/training/feedback.jsonl')}; // feedback training log (JSONL)`,
    `const TEAM_TO_FOLDER = ${objLit(teamFolders(ctx))};`,
    `const SUB_TAG_FOLDER = ${objLit(subFolders)};`,
    `const TRACKER_TO_VAULT_TEAM = ${objLit(trackerToTeam)};`,
    `const LINEAR_TO_VAULT_TEAM = TRACKER_TO_VAULT_TEAM; // prod const name kept for diff reviewability`,
    `const VALID_TEAM = new Set(${arrLit(tags.concat(['mixed']).sort())});`,
    `const VALID_SUB_TAG = new Set(${arrLit(subTags.sort())}); // null also allowed`,
    `const VALID_SUB_FOR_TEAM = {`,
    ...Object.keys(subForTeam).sort().map((team) =>
      `  ${jsKey(team)}: new Set(${arrLit(dedupe(subForTeam[team]).sort())}),`),
    `};`,
    `const GUESS_FOLDER_TABLE = [ // heuristic prior-context prefetch — wrong guess degrades gracefully`,
    ...guess.map((g) => `  { re: ${regexLit(g.re, 'i')}, folder: ${jsStr(g.folder)} },`),
    `];`,
    `const MIXED_FOLDER = ${jsStr(teamFolders(ctx).mixed)};`,
    // B7 — raw_retention privacy control (features.raw_retention). 'none' keeps
    // the digest .md only; 'vtt'/'vtt_mp4' also commit the raw .vtt sibling.
    // build-commit-payload-v2.js gates the .vtt commit on this.
    `const RAW_RETENTION = ${jsStr(get(ctx.tenant, 'features', 'raw_retention') || 'vtt')}; // none | vtt | vtt_mp4`,
  ];
  return lines.join('\n');
}

// guessFolder table: generated from team keywords/descriptions;
// fallback = mixed folder.
function guessFolderTable(ctx) {
  const out = [];
  const folders = teamFolders(ctx);
  const subFolders = subTagFolders(ctx);
  const words = (list) => dedupe(list.filter(Boolean).map(String)).map(escapeRegex).join('|');
  // Sub-teams before their parent team (more specific match wins first).
  for (const t of get(ctx.tenant, 'vault', 'teams') || []) {
    for (const st of Array.isArray(t && t.subteams) ? t.subteams : []) {
      const kw = [st.tag].concat(st.keywords || []);
      if (st && st.tag && subFolders[`${t.tag}:${st.tag}`]) {
        out.push({ re: words(kw), folder: subFolders[`${t.tag}:${st.tag}`] });
      }
    }
  }
  for (const t of get(ctx.tenant, 'vault', 'teams') || []) {
    if (!t || !t.tag) continue;
    const kw = [t.tag].concat(t.keywords || []);
    out.push({ re: words(kw), folder: folders[t.tag] });
  }
  return out.filter((g) => g.re);
}

function renderSLACK(ctx) {
  const owner = ctx.owner || {};
  const stateIds = get(ctx.state, 'slack', 'user_ids') || {};
  const channels = get(ctx.state, 'slack', 'channels') || {};
  const slack = get(ctx.tenant, 'features', 'slack') || {};
  const digest = channels.digest || slack.digest_channel || '';
  // M-slackflag: features.slack.enabled:false must actually stop Slack posts.
  // Consumed by the Slack message builders (root + thread reply) — a no-Slack
  // tenant (e.g. Alex) renders SLACK_ENABLED=false and those builders emit
  // nothing, so the Slack nodes never fire. Default on (golden path posts).
  const slackEnabled = slack.enabled !== false;
  const lines = [
    `const SLACK_ENABLED = ${slackEnabled ? 'true' : 'false'}; // features.slack.enabled — false ⇒ builders post nothing`,
    `const OWNER_SLACK_USER_ID = ${jsStr(owner.slack_user_id || stateIds[owner.lastname] || '')}; // deploy-resolved (test-creds.js slack)`,
    `const PUBLIC_CHANNEL_ID = ${jsStr(digest)}; // digest channel — name until deploy resolves the id`,
    `const DISPLAY_TIMEZONE = ${jsStr(get(ctx.tenant, 'tenant', 'timezone') || 'UTC')};`,
  ];
  return lines.join('\n');
}

function renderTRACKER(ctx) {
  const tracker = get(ctx.tenant, 'features', 'tracker') || {};
  const st = get(ctx.state, 'tracker') || {};
  const stTeams = st.teams || {};
  const stUsers = st.users || {};
  const mapping = Array.isArray(tracker.team_mapping) ? tracker.team_mapping : [];
  const teamToId = {};
  const teamMap = {};
  const teamDisplay = {};
  for (const m of mapping) {
    if (!m || !m.tracker_team_key) continue;
    const key = String(m.tracker_team_key);
    // Legacy pipeline-state cached bare id strings ("KEY": "uuid") — tolerate
    // them so pre-fix deploys keep their team ids; the Todo state stays
    // unresolved until the next `test-creds.js linear` run refreshes the cache.
    let resolved = stTeams[key] || {};
    if (typeof resolved === 'string') resolved = { id: resolved };
    if (resolved.id) teamToId[key] = String(resolved.id);
    // TEAM_MAP entries only exist once deploy-resolved: an entry with a null
    // teamId would slip past the router's resolveTeam() triage guard and
    // produce an issueCreate without a team. Pre-deploy the router degrades
    // to flag_for_triage — the safe path.
    if (resolved.id) {
      teamMap[key] = {
        name: resolved.name || m.team_tag || key,
        teamId: String(resolved.id),
        todoStateId: resolved.todo_state_id || null,
      };
    }
    teamDisplay[key] = String(resolved.name || m.team_tag || key);
  }
  const userMap = {};
  for (const p of ctx.roster) {
    if (!p || !p.lastname) continue;
    const id = p.tracker_user_id || stUsers[p.lastname];
    if (id) userMap[String(p.lastname)] = String(id);
  }
  const th = Object.assign({}, THRESHOLD_DEFAULTS, tracker.thresholds || {});
  const lines = [
    `const TRACKER_KIND = ${jsStr(tracker.kind || 'linear')};`,
    `const VALID_TRACKER_TEAM = new Set(${arrLit(Object.keys(teamDisplay).sort())}); // config keys (team_mapping); null also valid`,
    `const TEAM_TO_ID = ${objLit(teamToId)}; // deploy-resolved team UUIDs (pipeline-state)`,
    `const TEAM_MAP = ${objLit(teamMap)}; // deploy-resolved: teamId + the team's Todo state`,
    `const USER_MAP = ${objLit(userMap)}; // deploy-resolved tracker user ids by lastname`,
    `const LABEL_FROM_CALL_ID = ${st.label_id ? jsStr(st.label_id) : 'null'}; // provenance label "${String(tracker.provenance_label || 'backbrief')}", deploy-resolved`,
    `const TRACKER_URL_BASE = ${jsStr(st.url_base || 'https://linear.app/your-workspace')};`,
    `const TEAM_DISPLAY = ${objLit(teamDisplay)};`,
    `const COMMENT_THRESHOLD = ${th.comment};`,
    `const FLAG_THRESHOLD_DISCOVERY = ${th.flag_discovery};`,
    `const FLAG_THRESHOLD_PLANNING = ${th.flag_planning};`,
    `const CROSS_CALL_TTL_DAYS_CONFIRMED = ${th.dedup_confirmed_days};`,
    `const CROSS_CALL_TTL_HOURS_PENDING = ${th.dedup_pending_hours};`,
  ];
  return lines.join('\n');
}

function renderGLOSSARY(ctx) {
  const entries = Array.isArray(ctx.tenant.glossary) ? ctx.tenant.glossary : [];
  const pairs = [];
  for (const e of entries) {
    if (!e || !e.canonical) continue;
    for (const v of Array.isArray(e.variants) ? e.variants : []) {
      let src = escapeRegex(String(v)).replace(/ +/g, '\\s+').replace(/\\-/g, '[\\s-]*');
      if (/^[A-Za-z0-9]/.test(String(v))) src = '\\b' + src;
      if (/[A-Za-z0-9]$/.test(String(v))) src = src + '\\b';
      pairs.push(`  [${regexLit(src, 'gi')}, ${jsStr(e.canonical)}],`);
    }
  }
  return [`const GLOSSARY = [ // ASR mis-hearings → canonical spelling, compiled from tenant.glossary`]
    .concat(pairs, [`];`]).join('\n');
}

function renderLANG(ctx) {
  const disc = (key) => packUnion(ctx.packs, 'discriminator', key);
  const ui = ctx.primaryPack ? get(ctx.primaryPack.data, 'ui_strings') || {} : {};
  const uiClean = {};
  for (const k of Object.keys(ui).sort()) {
    if (!k.startsWith('_')) uiClean[k] = ui[k];
  }
  const lines = [
    `const STOP_WORDS = new Set(${arrLit(packUnion(ctx.packs, 'stop_words'))});`,
    `const DOMAIN_BRIDGE = ${objLit(packMerge(ctx.packs, 'domain_bridge'))};`,
    `const INFLECTION_SUFFIXES = ${arrLit(packUnion(ctx.packs, 'inflection_suffixes'))};`,
    `const CYR_TO_LAT = ${objLit(packMerge(ctx.packs, 'transliteration'))}; // empty table ⇒ transliterate degrades to identity`,
    `const DISC_RECURRING_TOKENS = ${arrLit(disc('recurring_tokens'))};`,
    `const DISC_CONTINUATION_PHRASES = ${arrLit(disc('continuation_phrases'))};`,
    `const DISC_GENERIC_ARTIFACTS = ${arrLit(disc('generic_artifacts'))};`,
    `const DISC_SPECIFIC_ARTIFACTS = ${arrLit(disc('specific_artifacts'))};`,
    `const DISC_TIME_MARKERS = ${arrLit(disc('time_markers'))};`,
    `const DISC_INFRA_KEYWORDS = ${arrLit(disc('infra_keywords'))};`,
    `const DISC_CALL_SCHEDULE_TOKENS = ${arrLit(disc('call_schedule_tokens'))};`,
    `const DISC_DECIDE_TOKENS = ${arrLit(disc('decide_tokens'))};`,
    `const DISC_CHAT_RESOLVE_TOKENS = ${arrLit(disc('chat_resolve_tokens'))};`,
    `const S = ${objLit(uiClean)}; // ui_strings for tenant.primary_language (no runtime mirroring — the digest channel has ONE working language)`,
  ];
  return lines.join('\n');
}

function renderPROMPT(ctx) {
  const langs = get(ctx.tenant, 'tenant', 'languages') || ['en'];
  const primaryName = languageName(ctx.primaryLang);
  const langNames = langs.map(languageName);
  const clause = langs.length <= 1
    ? `LANGUAGE. Write all narrative fields in ${primaryName}. Proper nouns, product names, people's lastnames, and tracker identifiers stay as-is. Classification fields (team_tag, sub_tag, call_type, tags, topic_slug, priorities, enums) are ALWAYS English kebab-case code tokens — never translate them.`
    : `LANGUAGE. Write all narrative fields in ${primaryName} — the team's working language — regardless of the transcript's language. If the transcript's dominant language differs from ${primaryName} and is one of ${langNames.join(', ')}, mirror the transcript instead. Proper nouns, product names, people's lastnames, and tracker identifiers stay as-is. Classification fields (team_tag, sub_tag, call_type, tags, topic_slug, priorities, enums) are ALWAYS English kebab-case code tokens — never translate them.`;

  const teams = get(ctx.tenant, 'vault', 'teams') || [];
  const tags = teams.map((t) => String(t.tag)).filter(Boolean);
  const teamEnum = tags.concat(['mixed']).sort().map((t) => `"${t}"`).join(' | ');
  const subTags = dedupe(Object.keys(subTagFolders(ctx)).map((k) => k.split(':')[1])).sort();
  const subEnum = subTags.length ? subTags.map((t) => `"${t}"`).join(' | ') + ' | null' : 'null';

  const ruleLines = [];
  for (const t of teams) {
    if (!t || !t.tag) continue;
    const kw = Array.isArray(t.keywords) && t.keywords.length ? ` (keywords: ${t.keywords.join(', ')})` : '';
    ruleLines.push(`  ${t.tag} (sub_tag=null)      : ${t.description || t.tag}${kw}`);
    for (const st of Array.isArray(t.subteams) ? t.subteams : []) {
      if (st && st.tag) ruleLines.push(`  ${t.tag} (+sub_tag='${st.tag}') : ${st.description || st.tag}`);
    }
  }
  ruleLines.push(`  mixed                     : Multiple distinct topics, no dominant team`);

  const mapping = get(ctx.tenant, 'features', 'tracker', 'team_mapping') || [];
  const teamByTag = {};
  for (const t of teams) if (t && t.tag) teamByTag[t.tag] = t;
  const inferLines = [];
  for (const m of mapping) {
    if (!m || !m.tracker_team_key) continue;
    const desc = (teamByTag[m.team_tag] && teamByTag[m.team_tag].description) || m.team_tag || m.tracker_team_key;
    inferLines.push(`- ${desc} → ${m.tracker_team_key}`);
  }
  inferLines.push('- ambiguous → null');

  const wake = (get(ctx.tenant, 'extraction', 'voice', 'wake_words') || []).map(String);
  const refExample = `${firstTrackerKey(ctx)}-123`;
  const dir = (key) => packUnion(ctx.packs, 'voice_directives', key)
    .map((s) => `«${String(s).replace(/\[TRACKER-ID\]/g, refExample)}»`).join(', ');
  const voiceLines = [
    'Voice triggers (wake word + directive):',
    `  Wake words (any of, transcript may misspell): ${wake.map((w) => `«${w}»`).join(', ') || '(none configured)'}`,
    '  Directives after wake:',
    `    explicit-task   : ${dir('explicit_task')}`,
    `    explicit-skip   : ${dir('explicit_skip')}`,
    `    explicit-comment: ${dir('explicit_comment')}`,
    '  False-positive guard: a wake word used as an ordinary noun with no directive within ~5 words is NOT a trigger.',
    '  When voice_marker is set, it HARD-OVERRIDES the auto-detected status:',
    '    explicit-task    → status=post-call (force-create as a tracker task downstream)',
    '    explicit-skip    → status=done-on-call (force-skip tracker task creation)',
    '    explicit-comment → status=in-progress (TaskCrafter adds a comment to the referenced issue instead of creating new)',
  ];

  const marker = (key) => packUnion(ctx.packs, 'status_markers', key).map((s) => `«${s}»`).join(', ');
  const statusLines = [
    'action_items.status — CRITICAL detection rules:',
    `  done-on-call   : the action was COMPLETED during the call itself. Past-tense markers: ${marker('done_on_call')}. Default for problems that got solved mid-discussion. These will NOT become tracker tasks — TaskCrafter skips them.`,
    `  post-call      : real future work that the assignee must do AFTER the call. Future-tense markers: ${marker('post_call')}. DEFAULT for genuine new commitments.`,
    `  monitoring     : an ongoing observation/check, not a discrete deliverable. Markers: ${marker('monitoring')}. TaskCrafter will NOT create tracker tasks for these.`,
    '  in-progress    : ALREADY started before the call, continues after. Use sparingly — usually post-call is right.',
    'When in doubt between done-on-call and post-call — re-read the transcript_quote. Past verb + confirmed result → done-on-call. Future or imperative verb → post-call.',
  ];

  // Task-level sensitive-content filter (TaskCrafter skip list) — EN defaults.
  // Distinct from the removed privacy routing: this only keeps sensitive
  // content OUT of tracker tasks, it never routes artifacts.
  const confLine = 'named-individual layoff/firing/severance decisions, multisig wallet quorum changes, seed-phrase handling, private-key / deploy-wallet rotation, board-level resource reallocation between teams, founder compensation, equity / option grants, cap-table changes';

  const fewshots = buildFewshots(ctx);

  // Feedback-parser phrase exemplars: the verdict taxonomy is the
  // contract and lives in the P5 prompt; packs contribute per-language phrase
  // exemplars as HINTS — classification is by meaning, so replies in an
  // unlisted language still degrade gracefully.
  const FEEDBACK_CLASSES = [
    'good', 'already_exists', 'already_done', 'duplicate_in_batch',
    'wrong_owner', 'wrong_team', 'wrong_priority', 'wrong_title',
  ];
  const feedbackHints = FEEDBACK_CLASSES.map((cls) => {
    const ex = packUnion(ctx.packs, 'feedback_patterns', cls).map((s) => `«${s}»`).join(', ');
    return `  ${cls}: ${ex || '(no exemplars — classify by meaning)'}`;
  }).join('\n');

  // 4-block issue-body headers: EN canon is the default
  // (plugin/templates/frontmatter/task-4block.md); the primary-language pack
  // may override per language (ru = production-verbatim headers).
  const TASK_BLOCK_DEFAULTS = {
    context: '📌 Context',
    extra: '📎 Additional information',
    result: '🎯 Expected result',
    task: '✅ Task',
  };
  const packHeaders = ctx.primaryPack ? get(ctx.primaryPack.data, 'task_block_headers') || {} : {};
  const blockHeaders = Object.assign({}, TASK_BLOCK_DEFAULTS);
  for (const k of Object.keys(packHeaders)) {
    if (!k.startsWith('_') && typeof packHeaders[k] === 'string') blockHeaders[k] = packHeaders[k];
  }

  // Short company context (tenant.about, 2-3 sentences max): the TaskCrafter
  // flow never fetches the vault, so this rendered sentence is the only
  // company-level fact its prompts receive; the transcripts flow additionally
  // gets the full docs/company.md via STUB-C. B1 (generate-tenant.js) fills
  // tenant.about from the company profile's "What <Company> does" section.
  const about = String(get(ctx.tenant, 'tenant', 'about') || '').trim();
  const companyContext = about
    ? `About ${get(ctx.tenant, 'tenant', 'name') || 'the company'}: ${about}`
    : '';

  const lines = [
    `const PROMPT_TENANT_NAME = ${jsStr(get(ctx.tenant, 'tenant', 'name') || 'this team')};`,
    `const COMPANY_CONTEXT = ${jsStr(companyContext)}; // from tenant.about — empty string when unset (prompts skip the line)`,
    `const PRIMARY_LANGUAGE_NAME = ${jsStr(primaryName)};`,
    `const LANGUAGE_CLAUSE = ${jsStr(clause)};`,
    `const TEAM_TAG_ENUM = ${jsStr(teamEnum)};`,
    `const SUB_TAG_ENUM = ${jsStr(subEnum)};`,
    `const TEAM_ROUTING_RULES = ${jsStr(ruleLines.join('\n'))};`,
    `const TEAM_INFERENCE_RULES = ${jsStr(inferLines.join('\n'))};`,
    `const VOICE_TRIGGER_RULES = ${jsStr(voiceLines.join('\n'))};`,
    `const STATUS_MARKER_RULES = ${jsStr(statusLines.join('\n'))};`,
    `const CONFIDENTIAL_TRIGGERS_LINE = ${jsStr(confLine)};`,
    `const TRACKER_REF_EXAMPLE = ${jsStr(refExample)};`,
    `const FEWSHOT_EXAMPLES = ${jsStr(fewshots)};`,
    `const FEEDBACK_PHRASE_HINTS = ${jsStr(feedbackHints)}; // per-language exemplars (packs); hints only — P5 classifies by meaning`,
    `const TASK_BLOCK_HEADERS = ${objLit(blockHeaders)}; // 4-block canon (plugin/templates/frontmatter/task-4block.md); primary-language pack may override`,
  ];
  return lines.join('\n');
}

// Deterministic normalizer few-shots built from the tenant's own roster/teams
// (fictional-tenant examples; regenerated per tenant at render).
// Six base EN examples mirror the six production example SHAPES (create /
// status-update / philosophical-skip / sensitivity / consolidation /
// voice-trigger) — the production RU few-shots with real employees are
// replaced by these fictional generated ones (sanitize rule: no real people
// in shipped few-shots). Tenants whose
// languages include a language with a shipped mirroring snippet (RU) get one
// extra example demonstrating the language clause: narrative fields mirror the
// transcript language, code tokens stay English.
function buildFewshots(ctx) {
  const roster = ctx.roster.filter((p) => p && p.lastname);
  const a = roster[0] || { lastname: 'Alpha' };
  const b = roster[1] || a;
  const teamA = (a.home_team || firstTrackerKey(ctx));
  const teamB = (b.home_team || teamA);
  const ref = `${firstTrackerKey(ctx)}-1234`;
  const wake = String((get(ctx.tenant, 'extraction', 'voice', 'wake_words') || [])[0] || 'backbrief');
  const lines = [
    'Ex 1 (normal CREATE):',
    `Input quote: "the staging deploy is red again — ${a.lastname}, can you take a look" (12:34)`,
    `Output: {"id":"tc_a3f8d2e1","title":"Fix the red staging deploy","owner_lastname":"${a.lastname}","participants_lastnames":[],"team_inferred":"${teamA}","linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"high","transcript_quote":"the staging deploy is red again","source_ts_mmss":"12:34","skip_reason":null,"voice_marker":null,"rationale":"Explicit assignee, concrete deliverable"}`,
    '',
    'Ex 2 (status update on explicit ref):',
    `Input quote: "what about ${ref}? — Done yesterday, we can close it" (08:15)`,
    `Output: {"id":"tc_b9e4c7a2","title":"Close ${ref} (completed)","owner_lastname":"${b.lastname}","participants_lastnames":[],"team_inferred":"${teamA}","linear_ref_explicit":"${ref}","intent":"update_status","intent_change_value":"Done","priority":"medium","transcript_quote":"Done yesterday, we can close it","source_ts_mmss":"08:15","skip_reason":null,"voice_marker":null,"rationale":"Existing issue, explicit completion"}`,
    '',
    'Ex 3 (skip philosophical):',
    'Input quote: "we should think about a new pricing model some day, let\'s revisit next time"',
    'Output: {"id":"tc_c1f7d9b3","title":"(skip)","owner_lastname":null,"participants_lastnames":[],"team_inferred":null,"linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"medium","transcript_quote":"we should think about a new pricing model","source_ts_mmss":null,"skip_reason":"philosophical","voice_marker":null,"rationale":"Deferred to a future call, no commitment"}',
    '',
    'Ex 4 (sensitivity):',
    `Input quote: "let's discuss ${b.lastname}'s compensation — raise it to X"`,
    'Output: {"id":"tc_d2a8b4f1","title":"(skip)","owner_lastname":null,"participants_lastnames":[],"team_inferred":null,"linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"medium","transcript_quote":"","source_ts_mmss":null,"skip_reason":"sensitive","voice_marker":null,"rationale":"Compensation — content sanitized"}',
    '',
    'Ex 5 (consolidation — rule 3):',
    `Input: 3 micro items from ${b.lastname} on the public docs (quickstart, FAQ, pricing page)`,
    `Output: {"id":"tc_e8b3a2c9","title":"Update the public docs: quickstart, FAQ, pricing","owner_lastname":"${b.lastname}","participants_lastnames":[],"team_inferred":"${teamB}","linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"medium","transcript_quote":"update the docs ... FAQ ... pricing","source_ts_mmss":null,"skip_reason":null,"voice_marker":null,"rationale":"One owner + one topic, merged per rule 3"}`,
    '',
    'Ex 6 (voice trigger):',
    `Input quote: "${wake}, make it a task: prepare the beta launch checklist"`,
    `Output: {"id":"tc_f1d4a8b3","title":"Prepare the beta launch checklist","owner_lastname":null,"participants_lastnames":[],"team_inferred":"${teamA}","linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"high","transcript_quote":"${wake}, make it a task: prepare the beta launch checklist","source_ts_mmss":null,"skip_reason":null,"voice_marker":"explicit-task","rationale":"Voice trigger — explicit command to create a task"}`,
  ];
  const langs = (get(ctx.tenant, 'tenant', 'languages') || ['en']).map(String);
  if (langs.includes('ru')) {
    lines.push(
      '',
      'Ex 7 (language mirroring — RU transcript fragment → RU narrative fields, EN code tokens):',
      `Input quote: "лендинг под запуск надо обновить до пятницы — ${b.lastname}, возьмёшь?" (21:07)`,
      `Output: {"id":"tc_a7c2e9d4","title":"Обновить лендинг под запуск до пятницы","owner_lastname":"${b.lastname}","participants_lastnames":[],"team_inferred":"${teamB}","linear_ref_explicit":null,"intent":"create","intent_change_value":null,"priority":"high","transcript_quote":"лендинг под запуск надо обновить до пятницы","source_ts_mmss":"21:07","skip_reason":null,"voice_marker":null,"rationale":"Явный дедлайн и исполнитель"}`
    );
  }
  return lines.join('\n');
}

function renderLLM(ctx) {
  const cfg = Object.assign({}, LLM_DEFAULTS);
  const own = ctx.tenant.llm || {};
  const lines = [];
  for (const stage of Object.keys(cfg).sort()) {
    const merged = Object.assign({}, cfg[stage], own[stage] || {});
    lines.push(`const LLM_${stage.toUpperCase()} = ${objLit(merged)};`);
  }
  return lines.join('\n');
}

function renderKNOBS(ctx) {
  const knobs = Object.assign({}, KNOB_DEFAULTS, get(ctx.tenant, 'pipeline', 'knobs') || {});
  const lines = [
    `const MIN_DURATION_MIN = ${knobs.min_duration_min};`,
    `const REPLAY_WINDOW_SEC = ${knobs.replay_window_sec};`,
    `const TRANSCRIPT_CHAR_CAP = ${knobs.transcript_char_cap};`,
    `const NORMALIZER_EXCERPT_CAP = ${knobs.normalizer_excerpt_cap};`,
    `const TTL_LISTING_MS = ${knobs.vault_cache_ttl_listing_h} * 60 * 60 * 1000;`,
    `const TTL_FILE_MS = ${knobs.vault_cache_ttl_file_h} * 60 * 60 * 1000;`,
  ];
  return lines.join('\n');
}

// Drive uploader target (build-drive-metadata) — folder id comes
// from features.drive.folder_id (schema requires it when enabled: true), the
// permission domain from tenant.internal_domains[0]. Renders empty strings
// when the feature is off so render/tests never throw on disabled tenants;
// deploy-pipeline.js gates the whole drive workflow on features.drive.enabled
// long before this code could run.
function renderDRIVE(ctx) {
  const d = get(ctx.tenant, 'features', 'drive') || {};
  const domains = (get(ctx.tenant, 'tenant', 'internal_domains') || []).map(String);
  const lines = [
    `const DRIVE_FOLDER_ID = ${jsStr(d.folder_id || '')}; // Shared Drive / folder id (features.drive.folder_id)`,
    `const DRIVE_DOMAIN_RESTRICTED = ${d.domain_restricted === false ? 'false' : 'true'};`,
    `const DRIVE_PERMISSION_DOMAIN = ${jsStr(domains[0] || '')}; // tenant.internal_domains[0]`,
    `const TENANT_NAME = ${jsStr(get(ctx.tenant, 'tenant', 'name') || 'unnamed')};`,
  ];
  return lines.join('\n');
}

const RENDERERS = {
  DRIVE: renderDRIVE,
  GLOSSARY: renderGLOSSARY,
  KNOBS: renderKNOBS,
  LANG: renderLANG,
  LLM: renderLLM,
  PROMPT: renderPROMPT,
  ROSTER: renderROSTER,
  ROUTING: renderROUTING,
  SLACK: renderSLACK,
  TRACKER: renderTRACKER,
};

/* ------------------------------------------------------------------ */
/* Region splicing                                                     */
/* ------------------------------------------------------------------ */

const BEGIN_RE = /^\/\/ ── __TENANT_([A-Z]+)_BEGIN__.*$/;
const END_RE = /^\/\/ ── __TENANT_([A-Z]+)_END__.*$/;

function beginMarker(kind) {
  return `// ── __TENANT_${kind}_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──`;
}
function endMarker(kind) {
  return `// ── __TENANT_${kind}_END__ ──`;
}

// Replace every TENANT region's content in `source` with a fresh render.
// Markers are preserved (and normalized to the canonical marker text) so the
// operation is idempotent. Throws on unknown region kinds or unbalanced markers.
function renderSource(source, ctx) {
  const lines = String(source).split('\n');
  const out = [];
  const found = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(BEGIN_RE);
    if (!m) {
      if (END_RE.test(lines[i])) throw new Error(`stray END marker without BEGIN at line ${i + 1}`);
      out.push(lines[i]);
      i++;
      continue;
    }
    const kind = m[1];
    const renderer = RENDERERS[kind];
    if (!renderer) throw new Error(`unknown TENANT region kind: ${kind}`);
    let j = i + 1;
    for (;;) {
      if (j >= lines.length) throw new Error(`unterminated __TENANT_${kind}__ region (opened line ${i + 1})`);
      const e = lines[j].match(END_RE);
      if (e) {
        if (e[1] !== kind) throw new Error(`mismatched region markers: ${kind} closed by ${e[1]} (line ${j + 1})`);
        break;
      }
      if (BEGIN_RE.test(lines[j])) throw new Error(`nested TENANT regions are not supported (line ${j + 1})`);
      j++;
    }
    out.push(beginMarker(kind));
    out.push(renderer(ctx));
    out.push(endMarker(kind));
    found.push(kind);
    i = j + 1;
  }
  return { source: out.join('\n'), regions: found };
}

function listNodeFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listNodeFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const HELP = `tenant-render.js — render tenant.yaml into TENANT_* code regions

Usage:
  node pipeline/tenant-render.js --tenant <tenant.yaml> [options]

Options:
  --tenant <path>   tenant.yaml (default: $TENANT, else ./tenant.yaml)
  --state <path>    pipeline-state JSON with deploy-resolved ids
                    (default: .backbrief/pipeline-state.json next to tenant.yaml, if present)
  --lang-dir <dir>  language packs directory (default: pipeline/lang next to this script)
  --dir <dir>       node-code tree to render (default: pipeline/code next to this script)
  --file <path>     render a single file instead of --dir
  --write           rewrite regions in place (DRY_RUN=1 prints without writing)
  --check           compare only; non-zero exit when any file differs (default mode)
  -h, --help        this text

Exit codes: 0 ok / 1 drift (--check) or render failure / 2 operational error`;

function parseArgs(argv) {
  const o = { tenant: null, state: null, langDir: null, dir: null, file: null, write: false, check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--state') o.state = argv[++i];
    else if (a === '--lang-dir') o.langDir = argv[++i];
    else if (a === '--dir') o.dir = argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--write') o.write = true;
    else if (a === '--check') o.check = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown option: ${a} (see --help)`); process.exit(2); }
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }
  const tenantPath = path.resolve(opts.tenant || process.env.TENANT || './tenant.yaml');
  if (!fs.existsSync(tenantPath)) {
    console.error(`✖ tenant file not found: ${tenantPath}`);
    process.exit(2);
  }
  let tenant;
  try {
    tenant = loadTenant(tenantPath);
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(2);
  }
  let statePath = opts.state;
  if (!statePath) {
    const guess = path.join(path.dirname(tenantPath), '.backbrief', 'pipeline-state.json');
    if (fs.existsSync(guess)) statePath = guess;
  }
  const state = statePath ? JSON.parse(fs.readFileSync(path.resolve(statePath), 'utf8')) : {};
  const langDir = path.resolve(opts.langDir || path.join(__dirname, 'lang'));
  const packs = loadLangPacks(tenant, langDir);
  const ctx = buildContext(tenant, packs, state, {});

  const files = opts.file
    ? [path.resolve(opts.file)]
    : listNodeFiles(path.resolve(opts.dir || path.join(__dirname, 'code')));

  const DRY_RUN = process.env.DRY_RUN === '1';
  let drift = 0;
  let rendered = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let result;
    try {
      result = renderSource(src, ctx);
    } catch (e) {
      console.error(`✖ ${path.relative(process.cwd(), f)}: ${e.message}`);
      process.exit(1);
    }
    if (result.regions.length === 0) continue;
    rendered++;
    if (result.source === src) continue;
    drift++;
    if (opts.write) {
      if (DRY_RUN) {
        console.log(`[dry-run] would rewrite ${path.relative(process.cwd(), f)} (${result.regions.join(', ')})`);
      } else {
        fs.writeFileSync(f, result.source);
        console.log(`rendered ${path.relative(process.cwd(), f)} (${result.regions.join(', ')})`);
      }
    } else {
      console.log(`drift: ${path.relative(process.cwd(), f)} (${result.regions.join(', ')})`);
    }
  }
  if (opts.write) {
    console.log(`✔ ${rendered} file(s) carry TENANT regions; ${drift} rewritten`);
    process.exit(0);
  }
  if (drift) {
    console.log(`✖ ${drift} file(s) differ from a fresh render — run with --write (or redeploy)`);
    process.exit(1);
  }
  console.log(`✔ ${rendered} file(s) carry TENANT regions; all match the rendered output`);
  process.exit(0);
}

module.exports = {
  parseYaml,
  loadTenant,
  loadLangPacks,
  buildContext,
  buildNameMaps,
  RENDERERS,
  renderSource,
  listNodeFiles,
  beginMarker,
  endMarker,
};

if (require.main === module) main();
