// SPDX-License-Identifier: MIT
/*
 * vault.js — turn a Backbrief vault (plain markdown in git) into the data the
 * cabinet renders. Pure functions, no I/O: the build script feeds it files
 * from disk (the demo vault), the Pages Functions feed it files from GitHub
 * (a customer's vault). Same code, same output shape, so the public demo is
 * a faithful preview of a real workspace.
 *
 * Reads both digest profiles the kit writes (plugin/manual and pipeline) and
 * older production vaults: sections are rendered generically by heading, and
 * action-item fields are normalized across their historical names.
 *
 * Everything here is derived from vault files alone. Facts no vault holds
 * (connection status, accounts, the ids a click would create) are merged in
 * by the caller: site/demo.config.json for the public demo.
 */
import { parseYaml, splitFrontmatter } from './yaml.js';

// ---------------------------------------------------------------- paths

/**
 * Classify a vault-relative path. Returns 'call' | 'tasks' | 'member' |
 * 'company' | 'vtt' | 'template' | 'training' | 'tenant' | null.
 */
export function classify(rel) {
  const base = rel.split('/').pop();
  if (/^readme\.md$/i.test(base)) return null;
  if (/(^|\/)tasks\/[^/]+\.tasks\.md$/.test(rel)) return 'tasks';
  if (/(^|\/)transcripts\/[^/]+\.md$/.test(rel)) return 'call';
  if (/(^|\/)transcripts\/[^/]+\.vtt$/.test(rel)) return 'vtt';
  if (/^team\/[^/]+\.md$/.test(rel)) return 'member';
  if (rel === 'docs/company.md') return 'company';
  if (/^docs\/templates\/[^/]+$/.test(rel)) return 'template';
  if (/^\.backbrief\/training\/[^/]+\.jsonl$/.test(rel)) return 'training';
  if (rel === 'tenant.yaml') return 'tenant';
  return null;
}

/** Stable short id for a call: date + FNV-1a hash of its path. */
export function callId(rel, date) {
  let h = 0x811c9dc5;
  for (let i = 0; i < rel.length; i++) {
    h ^= rel.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${date || 'undated'}-${h.toString(16).padStart(8, '0')}`;
}

/** Date and time encoded in a call filename (kit grammar or older vaults). */
export function dateFromName(rel) {
  const m = rel.split('/').pop().match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):?(\d{2}))?/);
  if (!m) return { date: null, time: null };
  return { date: m[1], time: m[2] ? `${m[2]}:${m[3]}` : null };
}

/** tasks/<call basename>.tasks.md — the kit pairs the two by basename. */
export const tasksPathFor = (callPath) => `tasks/${callPath.split('/').pop().replace(/\.md$/, '')}.tasks.md`;

/** Call file basename without .md: the call_id the training log uses. */
export const callBasename = (callPath) => callPath.split('/').pop().replace(/\.md$/, '');

/** Vault path of a call's raw transcript sibling (frontmatter transcript_file, same folder). */
export function transcriptPathFor(call) {
  if (!call.transcript_file) return null;
  const dir = call.path.split('/').slice(0, -1).join('/');
  return dir ? `${dir}/${call.transcript_file}` : call.transcript_file;
}

// ---------------------------------------------------------------- parsing

function parse(text) {
  const split = splitFrontmatter(String(text).replace(/^﻿/, ''));
  if (!split) return { meta: {}, body: String(text) };
  return { meta: tolerantYaml(split.head), body: split.body };
}

// A display surface must not go blank because one frontmatter line is outside
// the kit's YAML dialect (older vaults have e.g. unquoted "{token}" names in
// flow lists). Drop the line the parser reports and retry, a few times.
function tolerantYaml(head) {
  let lines = head.split('\n');
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return parseYaml(lines.join('\n')) || {};
    } catch (e) {
      const n = Number((String(e.message).match(/line (\d+)/) || [])[1]);
      if (!n || n > lines.length) return {};
      lines = lines.filter((_, i) => i !== n - 1);
    }
  }
  return {};
}

const str = (v) => (v === null || v === undefined ? null : String(v));
const list = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
const TS_TAIL = /\s*\((\d{1,3}:\d{2})\)\s*$/;
const unbold = (s) => String(s).replace(/\*\*([^*]+)\*\*/g, '$1');
const unquote = (s) => String(s).trim().replace(/^["“«]([\s\S]*)["”»]$/, '$1');
const unlink = (s) => String(s).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

/** Split a markdown body into ## sections, dropping HTML comments and the # title. */
export function sections(body) {
  const clean = body.replace(/<!--[\s\S]*?-->/g, '').replace(/^# .*\n?/m, '');
  const out = [];
  let cur = null;
  for (const line of clean.split('\n')) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { cur = { heading: h[1], md: '' }; out.push(cur); continue; }
    if (cur) cur.md += line + '\n';
  }
  return out
    .map((s) => ({ heading: s.heading, md: s.md.replace(/^\s+|\s+$/g, '') }))
    .filter((s) => !/^transcript$/i.test(s.heading));
}

function normalizeItem(a) {
  if (!a || typeof a !== 'object') return null;
  const title = str(a.title);
  if (!title) return null;
  return {
    title,
    owner: str(a.owner ?? a.assignee_hint ?? a.assignee),
    helpers: list(a.helpers ?? a.helpers_mentioned),
    status: str(a.status ?? a.category) || 'post-call',
    priority: str(a.priority ?? a.priority_hint),
    ts: str(a.ts ?? a.source_ts_mmss),
    tracker_ref: str(a.tracker_ref ?? a.linear_ref_hint),
  };
}

/** One call file → call record (with body sections). */
export function parseCall(rel, text) {
  const { meta, body } = parse(text);
  const fromName = dateFromName(rel);
  const date = str(meta.date) || fromName.date;
  const time = str(meta.time) || fromName.time;
  const items = (Array.isArray(meta.action_items) ? meta.action_items : []).map(normalizeItem).filter(Boolean);
  const title = str(meta.topic) || rel.split('/').pop().replace(/\.md$/, '');
  return {
    id: callId(rel, fromName.date || date),
    path: rel,
    topic: title,
    date,
    time,
    team: str(meta.team) || rel.split('/')[0],
    duration_min: Number.isFinite(meta.duration_min) ? meta.duration_min : null,
    participants: list(meta.participants),
    external_participants: list(meta.external_participants),
    language: str(meta.language),
    call_type: str(meta.call_type),
    tags: list(meta.tags),
    source: str(meta.source),
    platform: str(meta.platform),
    filed_by: str(meta.filed_by),
    digest_version: str(meta.digest_version),
    recording_url: str(meta.recording_url),
    transcript_file: str(meta.transcript_file),
    references: list(meta.references_prior_calls),
    action_items: items,
    sections: sections(body),
  };
}

const VERDICTS = [
  ['CREATE', /✏️\s*CREATE/u], ['COMMENT', /💬\s*COMMENT/u],
  ['FLAG', /⚠️\s*FLAG/u], ['DUPLICATE', /🔁\s*DUPLICATE/u],
];
const REF = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/;

// "- owner: **Carter** (growth) · priority: high · (14:32)" or "- owner: unresolved · priority: medium"
function ownerLine(line) {
  const parts = line.replace(/^- owner:\s*/, '').split(/\s+·\s+/);
  const out = { owner: null, owner_team: null, priority: null, ts: null };
  const who = parts.shift() || '';
  const name = who.match(/\*\*([^*]+)\*\*/);
  if (name) out.owner = name[1].trim();
  const team = who.match(/\(([a-z0-9-]+)\)/);
  if (team) out.owner_team = team[1];
  for (const p of parts) {
    const pr = p.match(/^priority:\s*([a-z]+)/i);
    if (pr) out.priority = pr[1].toLowerCase();
    const ts = p.match(/^\((\d{1,3}:\d{2})\)$/);
    if (ts) out.ts = ts[1];
  }
  return out;
}

// Target issue named on a block line or heading: [REF](url) "Title"
function targetIn(text) {
  const m = String(text).match(/\[([A-Z][A-Z0-9]{1,9}-\d{1,6})\](?:\([^)]*\))?\s*(?:—\s*)?(?:"([^"]+)"|“([^”]+)”)?/);
  return m ? { ref: m[1], title: m[2] || m[3] || null } : null;
}

/** One tasks/*.tasks.md file → the task proposals and the decision on each. */
export function parseTasks(rel, text) {
  const { meta, body } = parse(text);
  const drafts = [];
  for (const block of body.split(/^## (?=\d+\.\s)/m).slice(1)) {
    const head = block.split('\n')[0];
    const verdict = (VERDICTS.find(([, re]) => re.test(head)) || ['OTHER'])[0];
    const title = head
      .replace(/^\d+\.\s+/, '')
      .replace(/^(✏️\s*CREATE|💬\s*COMMENT|⚠️\s*FLAG|🔁\s*DUPLICATE)\s*/u, '')
      .replace(/^on\s+/, '')
      .replace(/^—\s*/, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim();
    const decisionText = (block.match(/\*\*decision:\s*([^*]*)\*\*/) || [])[1] || '';
    const decision = /skipped/i.test(decisionText) ? 'skipped'
      : /accepted|edited/i.test(decisionText) ? 'accepted' : 'pending';
    const refs = [...block.matchAll(/\[([A-Z][A-Z0-9]+-\d+)\]/g)].map((m) => m[1]);
    const note = (block.match(/^- (?!owner:|quote:|dedup:|\*\*decision)(.+)$/m) || [])[1] || null;

    // The fields a reviewer sees on each draft (owner line, quote, dedup
    // evidence, similarity, the issue it targets, the reason a skip gave).
    const d = {
      n: Number((head.match(/^(\d+)\./) || [])[1]) || drafts.length + 1,
      owner: null, owner_team: null, priority: null, ts: null, quote: null, dedup: null,
      similarity: null, target: verdict === 'COMMENT' ? targetIn(head) : null, notes: [],
    };
    for (const raw of block.split('\n').slice(1)) {
      const line = raw.trim();
      if (!line.startsWith('- ')) continue;
      if (/^- owner:/.test(line)) {
        const o = ownerLine(line);
        for (const k of ['owner', 'owner_team', 'priority', 'ts']) if (o[k] !== null) d[k] = o[k];
        continue;
      }
      if (/^- quote:/.test(line)) {
        const q = line.replace(/^- quote:\s*/, '');
        const ts = q.match(TS_TAIL);
        d.quote = unquote(q.replace(TS_TAIL, ''));
        if (ts && !d.ts) d.ts = ts[1];
        continue;
      }
      if (/^- dedup:/.test(line)) { d.dedup = line.replace(/^- dedup:\s*/, ''); continue; }
      if (/^- \*\*decision/.test(line)) continue;
      const sim = line.match(/(\d{1,3})%\s+like\b/);
      if (sim) d.similarity = Number(sim[1]) / 100;
      if (!d.target && (sim || /^- matches\b/.test(line))) d.target = targetIn(line);
      if (!d.ts) { const ts = line.match(/\((\d{1,3}:\d{2})\)/); if (ts) d.ts = ts[1]; }
      d.notes.push(unlink(line.slice(2)));
    }
    const reason = (block.match(/\*\*decision:[^*]*\*\*\s*\(["“]([^"”]+)["”]\)/) || [])[1]
      || (decisionText.match(/file-only\s*\(([^)]+)\)/) || [])[1] || null;
    // "**decision: edited → [ENG-311](…)** (owner: Okafor → Hughes)": approved after a change.
    const edited = decision === 'accepted' && /\bedited\b/i.test(decisionText);
    const editNote = edited ? ((block.match(/\*\*decision:[^*]*\*\*\s*\(([^)"“]+)\)/) || [])[1] || '').trim() || null : null;
    const decisionRef = (decisionText.match(REF) || [])[1] || null;
    const result = decision === 'skipped' ? 'skipped'
      : decision === 'pending' ? null
        : verdict === 'COMMENT' ? 'commented'
          : /file-only/i.test(decisionText) ? 'file-only'
            : decisionRef ? 'created' : 'accepted';
    drafts.push({
      verdict, title, decision, decision_text: decisionText.trim(), refs: [...new Set(refs)], note,
      n: d.n, owner: d.owner, owner_team: d.owner_team, priority: d.priority, ts: d.ts, quote: d.quote,
      dedup: d.dedup, similarity: d.similarity, target: d.target, notes: d.notes,
      reason, result, result_ref: result === 'commented' ? (d.target && d.target.ref) || decisionRef : decisionRef,
      edited, edit_note: editNote,
    });
  }
  return {
    path: rel,
    call: str(meta.call),
    team: str(meta.team),
    date: str(meta.date),
    generated: str(meta.generated),
    tracker: str(meta.tracker),
    autonomy_level: str(meta.autonomy_level),
    counts: meta.counts && typeof meta.counts === 'object' ? meta.counts : null,
    drafts,
  };
}

// "- **onboarding-emails** — evidence: "quote" (2026-10-09 call, 08:20)" (A2 profile format)
function zoneLine(line) {
  const m = line.match(/^- \*\*([a-z0-9-]+)\*\*(?:\s+—\s+(.*))?$/);
  if (!m) return null;
  const rest = m[2] || '';
  const ev = rest.match(/evidence:\s*["“]([^"”]+)["”]\s*\((\d{4}-\d{2}-\d{2})(?:\s+call)?(?:,\s*(\d{1,3}:\d{2}))?\)/);
  return {
    zone: m[1],
    evidence: ev ? { date: ev[2], ts: ev[3] || null, quote: ev[1] } : null,
    inferred: !ev,
  };
}

/** One team/<Lastname>.md → person record. */
export function parseMember(rel, text) {
  const { meta, body } = parse(text);
  const lastname = str(meta.lastname) || rel.split('/').pop().replace(/\.md$/, '');
  const first = list(meta.first_names);
  const secs = sections(body);
  const sec = (h) => (secs.find((s) => s.heading.toLowerCase() === h) || {}).md || '';
  const zones = list(meta.zones);
  const evidence = sec('responsibility zones').split('\n').map((l) => zoneLine(l.trim())).filter(Boolean);
  const about = sec('role').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim() || null;
  return {
    lastname,
    first_names: first,
    role: str(meta.role),
    team: str(meta.team),
    aliases: list(meta.aliases),
    zones,
    typical_partners: list(meta.typical_partners),
    status: str(meta.status),
    name: [first[0], lastname].filter(Boolean).join(' '),
    email: str(meta.email),
    languages: list(meta.languages),
    sources: list(meta.sources),
    last_updated: str(meta.last_updated),
    path: rel,
    about: about && !/^none\.?$/i.test(about) ? about : null,
    zone_evidence: [
      ...zones.map((z) => evidence.find((e) => e.zone === z) || { zone: z, evidence: null, inferred: true }),
      ...evidence.filter((e) => !zones.includes(e.zone)),
    ],
  };
}

export function parseCompany(text) {
  const { meta } = parse(text);
  return { name: str(meta.name), what_we_do: str(meta.what_we_do), products: list(meta.products) };
}

/** tenant.yaml → the parsed config (or null). */
export function parseTenant(text) {
  if (!text) return null;
  const doc = tolerantYaml(String(text));
  return doc && typeof doc === 'object' && Object.keys(doc).length ? doc : null;
}

/** .backbrief/training/task-decisions.jsonl → rows (state.js log-decision shape); bad lines are skipped. */
export function parseTrainingLog(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch { /* not a row */ }
  }
  return rows;
}

// --------------------------------------------------------------- reviews

/**
 * The note an edited decision carries, "owner: Okafor → Hughes; title edited",
 * as {changed: ['owner', 'title'], from: {owner: 'Okafor'}, to: {owner: 'Hughes'}}.
 * Field names follow the workspace's edit form: title, owner, priority, team, comment.
 */
export function parseEditNote(note) {
  const out = { changed: [], from: {}, to: {} };
  const value = (v) => (/^(none|unresolved)$/i.test(v) ? null : v);
  for (const part of String(note || '').split(/;\s*/)) {
    const m = part.trim().match(/^(owner|priority|team|title)\s*:\s*(.+?)\s*→\s*(.+)$/i);
    if (m) {
      const f = m[1].toLowerCase();
      out.changed.push(f);
      out.from[f] = value(m[2]);
      out.to[f] = value(m[3]);
      continue;
    }
    const e = part.trim().match(/^(title|comment)\s+edited$/i);
    if (e) out.changed.push(e[1].toLowerCase());
  }
  return out;
}

/**
 * A skip reason as a review kind: covered | done | not_a_task | wrong_owner |
 * wrong_team | other, or null when no reason was given (a DUPLICATE skipped
 * without one counts as covered: that is what its verdict says). Reads the
 * tasks file's free text and the workspace's reason chips alike.
 */
export function reasonKind(reason, verdict = null) {
  const r = String(reason || '').trim().toLowerCase();
  if (!r) return verdict === 'DUPLICATE' ? 'covered' : null;
  if (/wrong team|other team|belongs to/.test(r)) return 'wrong_team';
  if (/wrong owner|reassign/.test(r)) return 'wrong_owner';
  if (/not a task|no ticket|decides|discussion only/.test(r)) return 'not_a_task';
  if (/\bdone\b|shipped|\blive\b|finished|\b(?:is|are) (?:already )?in\b/.test(r)) return 'done';
  if (/covered|same ticket|already (?:tracked|exists|in the tracker)|duplicate|\b[a-z][a-z0-9]{1,9}-\d+\b/.test(r)) return 'covered';
  return 'other';
}

/** Epoch ms of a wall-clock date and "HH:MM" in an IANA zone (read as UTC when the zone is missing or unknown). */
export function zonedMs(date, time, timeZone = null) {
  const d = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = String(time || '00:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!d || !t) return null;
  const wall = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  if (!timeZone) return wall;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    const offset = (ms) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
    };
    return wall - offset(wall - offset(wall));
  } catch {
    return wall;
  }
}

/** When a call ended (start in the tenant's zone + duration), as epoch ms; null without date, time or duration. */
export function callEndMs(call, timeZone = null) {
  const start = zonedMs(call.date, call.time, timeZone);
  return start === null || !Number.isFinite(call.duration_min) ? null : start + call.duration_min * 60000;
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

// --------------------------------------------------------------- transcripts

const VTT_TIMING = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;

function clockToSeconds(s) {
  const m = String(s).trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?$/);
  if (!m || Number(m[3]) > 59) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
const toMmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const tsSeconds = (ts) => clockToSeconds(ts);

/**
 * WebVTT (Zoom "Audio Transcript" style: "Display Name: text", or <v Name>)
 * → [{speaker, ts_mmss, text}], the segment shape normalize-transcript.js
 * emits. Cues are kept one per segment (not merged) so every (MM:SS) anchor a
 * digest cites lands on its own cue. Speakers are the raw labels; see
 * transcriptDetail() for mapping them to profile lastnames.
 */
export function parseVtt(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const tm = lines[i].match(VTT_TIMING);
    if (!tm) continue;
    const said = [];
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== ''; j++) said.push(lines[j].trim());
    i = j;
    let speaker = null;
    let line = said.join(' ');
    const voice = line.match(/^<v\s+([^>]+)>\s*(.*?)(?:<\/v>)?$/);
    if (voice) { speaker = voice[1].trim(); line = voice[2]; } else {
      const colon = line.match(/^([^:]{1,60}):\s+(.*)$/);
      if (colon && !/^\d+$/.test(colon[1].trim())) { speaker = colon[1].trim(); line = colon[2]; }
    }
    line = line.replace(/<[^>]+>/g, '').trim();
    const start = clockToSeconds(tm[1]);
    if (line && start !== null) out.push({ speaker, ts_mmss: toMmss(start), text: line });
  }
  return out;
}

/** Lower-cased name forms → canonical lastname: lastname, aliases, "First Last", unique first names. */
export function speakerIndex(members) {
  const idx = new Map();
  const firsts = new Map();
  const add = (k, v) => { const key = String(k || '').trim().toLowerCase(); if (key && !idx.has(key)) idx.set(key, v); };
  for (const m of members) {
    add(m.lastname, m.lastname);
    for (const a of m.aliases || []) add(a, m.lastname);
    for (const f of m.first_names || []) {
      add(`${f} ${m.lastname}`, m.lastname);
      const k = f.toLowerCase();
      firsts.set(k, firsts.has(k) ? null : m.lastname);
    }
  }
  for (const [k, v] of firsts) if (v) add(k, v);
  return idx;
}

/** A call's raw transcript, speakers resolved to profile lastnames where an alias matches. */
export function transcriptDetail(call, vttText, members = []) {
  const idx = speakerIndex(members);
  const raw = parseVtt(vttText);
  const speakers = [];
  const segments = raw.map((s) => {
    const lastname = s.speaker ? idx.get(s.speaker.toLowerCase()) || null : null;
    if (s.speaker && !speakers.some((x) => x.label === s.speaker)) {
      speakers.push({
        label: s.speaker,
        lastname,
        external: !lastname && call.external_participants.includes(s.speaker),
      });
    }
    return { speaker: lastname || s.speaker, ts_mmss: s.ts_mmss, text: s.text };
  });
  return { call_id: call.id, path: transcriptPathFor(call), format: 'vtt', speakers, segments };
}

// --------------------------------------------------------------- digest

const isNone = (s) => /^none\.?$/i.test(String(s).trim());

function numbered(md) {
  const out = [];
  for (const line of String(md || '').split('\n')) {
    const m = line.match(/^\d+\.\s+(.*)$/);
    if (m) {
      const t = m[1].trim();
      out.push({ text: t.replace(TS_TAIL, '').trim(), ts: (t.match(TS_TAIL) || [])[1] || null, quote: null });
      continue;
    }
    const q = line.match(/^\s+>\s?(.*)$/);
    if (q && out.length) out[out.length - 1].quote = unquote(q[1]);
  }
  return out.filter((x) => !isNone(x.text));
}

function splitDash(text) {
  const i = text.indexOf(' — ');
  return i < 0 ? [text, null] : [text.slice(0, i).trim(), text.slice(i + 3).trim()];
}

/**
 * The digest sections, as data: summary themes, decisions (+ why), agreements
 * (+ the two parties), next steps with their verbatim quotes, open questions
 * and key insights. Every entry keeps its (MM:SS) anchor.
 */
export function digest(secs) {
  const get = (h) => (secs.find((s) => s.heading.toLowerCase() === h) || {}).md || '';
  const themes = [];
  for (const line of get('summary').split('\n')) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) { themes.push({ title: h[1].replace(TS_TAIL, '').trim(), ts: (h[1].match(TS_TAIL) || [])[1] || null, points: [] }); continue; }
    const p = line.match(/^[-*]\s+(.*)$/);
    if (p && themes.length) themes[themes.length - 1].points.push(p[1].trim());
  }
  const nextSteps = [];
  let status = 'post-call';
  for (const block of get('next steps').split(/^(?=###\s)/m)) {
    const h = block.match(/^###\s+(.*)$/m);
    if (h) status = /done/i.test(h[1]) ? 'done-on-call' : /monitor/i.test(h[1]) ? 'monitoring' : 'post-call';
    for (const it of numbered(block)) {
      const m = it.text.match(/^(.*?)\s+—\s+\*\*([^*]+)\*\*(.*)$/);
      const rest = m ? m[3] : '';
      nextSteps.push({
        status,
        title: m ? m[1].trim() : it.text,
        owner: m ? m[2].trim() : null,
        helpers: ((rest.match(/\(helpers:\s*([^)]*)\)/) || [])[1] || '').split(',').map((x) => x.trim()).filter(Boolean),
        priority: (rest.match(/_\[(\w+)\]_/) || [])[1] || null,
        ts: it.ts,
        quote: it.quote,
      });
    }
  }
  return {
    themes,
    decisions: numbered(get('decisions')).map(({ text, ts }) => { const [title, why] = splitDash(text); return { title, why, ts }; }),
    agreements: numbered(get('agreements')).map(({ text, ts }) => {
      const m = text.match(/^(.+?):\s+(.*)$/);
      const parties = m && m[1].includes('↔') ? m[1].split('↔').map((x) => x.trim()) : [];
      return { parties, text: parties.length ? m[2] : text, ts };
    }),
    next_steps: nextSteps,
    open_questions: numbered(get('open questions')).map(({ text, ts }) => { const [title, why] = splitDash(text); return { title, why, ts }; }),
    key_insights: numbered(get('key insights')).map(({ text, ts }) => { const [title, implication] = splitDash(text); return { title, implication, ts }; }),
  };
}

/** Every (MM:SS) the digest body cites, in order of appearance (deduplicated). */
export function digestTimestamps(secs) {
  const seen = new Set();
  for (const s of secs) for (const m of s.md.matchAll(/\((\d{1,3}:\d{2})\)/g)) seen.add(m[1]);
  return [...seen];
}

/** Digest lines as plain text, each with the (MM:SS) it sits under: what a name search runs over. */
export function digestLines(call) {
  const out = [];
  for (const s of call.sections) {
    let ts = null;
    for (const raw of s.md.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const own = (line.match(/\((\d{1,3}:\d{2})\)/) || [])[1];
      if (own) ts = own;
      const text = unlink(unbold(line.replace(/^(#{3,6}|[-*>]|\d+\.)\s*/, '')))
        .replace(/\s*_\[(\w+)\]_/g, ' [$1]').replace(TS_TAIL, '').trim();
      out.push({ section: s.heading, ts, text });
    }
  }
  return out;
}

// --------------------------------------------------------------- across calls

/**
 * Where every action item stands once later calls are read, keyed
 * "<call id>|<index in action_items>":
 *   closed_by  — a later call recorded it as done: that call's done-on-call item
 *                with the same tracker_ref, as {call_id, topic, date, ts, title};
 *                null otherwise (and always null for done-on-call items themselves)
 *   superseded — a later row carries the same tracker_ref, so a list shows one
 *                row per issue: the latest
 * "Later" is call date and time, then the item's (MM:SS). Items without a
 * tracker_ref are never closed or superseded by another call.
 */
export function itemStates(calls) {
  const rows = calls.flatMap((c) => c.action_items.map((a, i) => ({ c, a, i, at: `${c.date || ''} ${c.time || ''}`, sec: tsSeconds(a.ts) ?? -1 })));
  const cmp = (x, y) => x.at.localeCompare(y.at) || x.sec - y.sec;
  const byRef = new Map();
  for (const r of rows) if (r.a.tracker_ref) byRef.set(r.a.tracker_ref, [...(byRef.get(r.a.tracker_ref) || []), r]);
  const out = new Map();
  for (const r of rows) {
    const later = r.a.tracker_ref ? byRef.get(r.a.tracker_ref).filter((x) => cmp(x, r) > 0).sort(cmp) : [];
    const done = r.a.status === 'done-on-call' ? null : later.find((x) => x.a.status === 'done-on-call');
    out.set(`${r.c.id}|${r.i}`, {
      closed_by: done ? { call_id: done.c.id, topic: done.c.topic, date: done.c.date, ts: done.a.ts, title: done.a.title } : null,
      superseded: later.length > 0,
    });
  }
  return out;
}

/** Still owed: a post-call item that no later call records as done, on the latest row for its issue. */
export const isOpenItem = (a, st = a) => a.status === 'post-call' && !(st && st.closed_by) && !(st && st.superseded);

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'its',
  'not', 'no', 'of', 'on', 'once', 'only', 'or', 'our', 'per', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'this', 'to',
  'until', 'we', 'what', 'when', 'with']);
function stems(text) {
  const out = new Set();
  for (let w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!w || STOP.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
    if (w.length > 5) w = w.replace(/(ing|ed)$/, '');
    if (w.length > 3) w = w.replace(/s$/, '');
    out.add(w);
  }
  return out;
}

/** The action item that carries a decision out: the same call's post-call item sharing the most words with it (two or more), the nearest in time on a tie. */
function followUpIndex(dec, call) {
  const want = stems(dec.title);
  const at = tsSeconds(dec.ts) ?? 0;
  let best = { i: -1, n: 1, gap: Infinity };
  call.action_items.forEach((a, i) => {
    if (a.status !== 'post-call') return;
    const have = stems(a.title);
    const n = [...want].filter((w) => have.has(w)).length;
    const gap = Math.abs((tsSeconds(a.ts) ?? 0) - at);
    if (n > best.n || (n === best.n && n > 1 && gap < best.gap)) best = { i, n, gap };
  });
  return best.i;
}

/**
 * Every decision across calls, newest call first (in digest order within a
 * call): {call_id, topic, date, time, team, n, title, why, ts, follow_up}.
 * follow_up is the action item that implements it ({title, owner, tracker_ref,
 * ts, status, closed_by, superseded, open}) or null when no item matches.
 */
export function decisionsIndex(calls, states = itemStates(calls)) {
  const out = [];
  for (const c of calls) {
    digest(c.sections || []).decisions.forEach((d, k) => {
      const i = followUpIndex(d, c);
      const a = i >= 0 ? c.action_items[i] : null;
      const st = (a && states.get(`${c.id}|${i}`)) || { closed_by: null, superseded: false };
      out.push({
        call_id: c.id, topic: c.topic, date: c.date, time: c.time, team: c.team, n: k + 1,
        title: d.title, why: d.why, ts: d.ts,
        follow_up: a ? {
          title: a.title, owner: a.owner, tracker_ref: a.tracker_ref, ts: a.ts, status: a.status,
          closed_by: st.closed_by, superseded: st.superseded, open: isOpenItem(a, st),
        } : null,
      });
    });
  }
  return out.sort((x, y) => `${y.date} ${y.time}`.localeCompare(`${x.date} ${x.time}`) || x.n - y.n);
}

const plain = (s) => unlink(unbold(String(s || ''))).replace(/\s+/g, ' ').trim();

/**
 * What a call search runs over, one line each with the (MM:SS) it sits at so a
 * hit can show ▶: topic, people (full names; guests marked), tags, summary
 * themes and points, decisions with their why, agreements, action items (owner,
 * helpers, issue key), open questions, key insights, verbatim quotes, and task
 * proposals that are not already an action item. kind names the source.
 */
export function searchLines(call, { proposals = [], names = new Map() } = {}) {
  const d = digest(call.sections || []);
  const lines = [];
  const seen = new Set();
  const add = (kind, text, ts = null) => {
    const t = plain(text);
    const key = `${kind}|${t}|${ts}`;
    if (!t || seen.has(key)) return;
    seen.add(key);
    lines.push({ text: t, ts: ts || null, kind });
  };
  add('topic', call.topic);
  add('people', [...call.participants.map((p) => names.get(p) || p), ...call.external_participants.map((p) => `${p} (guest)`)].join(', '));
  if (call.tags.length) add('tags', call.tags.join(', '));
  for (const th of d.themes) {
    add('summary', th.title, th.ts);
    for (const p of th.points) add('summary', p, th.ts);
  }
  for (const x of d.decisions) add('decision', x.why ? `${x.title} — ${x.why}` : x.title, x.ts);
  for (const x of d.agreements) add('agreement', x.parties.length ? `${x.parties.join(' ↔ ')}: ${x.text}` : x.text, x.ts);
  for (const a of call.action_items) {
    add('action_item', `${a.title} — ${a.owner || 'no owner'}${a.helpers.length ? ` (helpers: ${a.helpers.join(', ')})` : ''}${a.tracker_ref ? ` · ${a.tracker_ref}` : ''}`, a.ts);
  }
  for (const x of d.open_questions) add('open_question', x.why ? `${x.title} — ${x.why}` : x.title, x.ts);
  for (const x of d.key_insights) add('key_insight', x.implication ? `${x.title} — ${x.implication}` : x.title, x.ts);
  const quotes = new Set();
  for (const q of [...d.next_steps, ...proposals]) {
    if (q.quote && !quotes.has(q.quote)) { quotes.add(q.quote); add('quote', q.quote, q.ts); }
  }
  const itemTitles = new Set(call.action_items.map((a) => a.title));
  for (const p of proposals) {
    if (itemTitles.has(p.title)) continue;
    const ref = (p.target && p.target.ref) || (p.decision && p.decision.ref);
    add('proposal', `${p.title}${ref ? ` · ${ref}` : ''}`, p.ts);
  }
  return lines;
}

// --------------------------------------------------------------- call detail

/** Human label for a call path when its frontmatter wasn't read. */
export function labelFromName(rel) {
  const base = rel.split('/').pop().replace(/\.md$/, '');
  const kit = base.match(/^\d{4}-\d{2}-\d{2} \d{4} (.+?)(?: w .+)?$/);
  const raw = kit ? kit[1] : base.replace(/\{[^}]*\}/g, '').replace(/ – \d{4}-\d{2}-\d{2}.*$/, '').replace(/ w .+$/, '');
  const t = raw.trim().replace(/\s+/g, ' ');
  return t ? t[0].toUpperCase() + t.slice(1) : base;
}

function addMinutes(hhmm, minutes) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !Number.isFinite(minutes)) return null;
  const t = (Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Where the digest of this call was posted: the team's channel override, else
 * the digest channel (tenant.yaml features.slack). The root post goes out a
 * minute after the call ends (start + duration + 1 min, tenant-local time).
 */
export function slackPost(call, tenant) {
  const slack = tenant && tenant.features && tenant.features.slack;
  if (!slack || slack.enabled === false) return null;
  const perTeam = slack.per_team_channels && typeof slack.per_team_channels === 'object' ? slack.per_team_channels : {};
  return {
    channel: str(perTeam[call.team]) || str(slack.digest_channel),
    posted_at: addMinutes(call.time, call.duration_min === null ? null : call.duration_min + 1),
  };
}

/** The raw transcript reference of a call; `files` (all vault paths) confirms the sibling exists. */
export function transcriptRef(call, files = null, url = null) {
  const p = transcriptPathFor(call);
  const available = Boolean(p) && (!files || files.includes(p));
  return { available, path: available ? p : null, url: available && typeof url === 'function' ? url(call) : null };
}

/** The recording link: kept out of the vault unless the platform gave a share URL. */
export function recordingRef(call) {
  return { available: Boolean(call.recording_url), provider: call.platform || call.source || null, url: call.recording_url || null };
}

/**
 * Call detail: the call, its task proposals, and links to the calls it built on.
 * `states` (itemStates() over the workspace's calls) marks each action item and
 * next step closed_by / superseded; without it nothing is closed. `training`
 * (log rows) dates each decided proposal.
 */
export function callDetail(call, tasksFile = null, knownTopics = new Map(), opts = {}) {
  const { tenant = null, files = null, members = [], transcriptUrl = null, states = null, training = null } = opts;
  const st = (i) => (states && states.get(`${call.id}|${i}`)) || { closed_by: null, superseded: false };
  const d = digest(call.sections);
  d.next_steps = d.next_steps.map((s) => {
    const i = call.action_items.findIndex((a) => a.ts === s.ts && a.title === s.title);
    return i < 0 ? s : { ...s, tracker_ref: call.action_items[i].tracker_ref, closed_by: st(i).closed_by, superseded: st(i).superseded };
  });
  return {
    ...call,
    action_items: call.action_items.map((a, i) => ({ ...a, closed_by: st(i).closed_by, superseded: st(i).superseded, open: isOpenItem(a, st(i)) })),
    references: call.references.map((p) => ({
      path: p,
      id: callId(p, dateFromName(p).date),
      topic: knownTopics.get(p) || labelFromName(p),
    })),
    tasks: tasksFile,
    digest: d,
    transcript: transcriptRef(call, files, transcriptUrl),
    recording: recordingRef(call),
    slack: slackPost(call, tenant),
    task_log: taskLogEntry(call, tasksFile, members, { training }),
  };
}

// --------------------------------------------------------------- task log

const SAFE = new Set(['CREATE', 'COMMENT']); // what 09b's "Approve all safe" covers
const SUGGESTED = { CREATE: 'approve', COMMENT: 'approve', FLAG: 'review', DUPLICATE: 'skip' };

/** call_type → the taskcrafter call_mode (the vault does not store it): planning and mixed stay, else discovery. */
export const callMode = (callType) => (callType === 'planning' || callType === 'mixed' ? callType : 'discovery');

/**
 * How a decision relates to the verdict Backbrief proposed: 'agreed' (decided
 * as suggested), 'edited' (approved after a change) or 'overridden'; null while
 * pending. CREATE and COMMENT suggest approve; DUPLICATE suggests skip; a FLAG
 * (possible duplicate) is borne out by a skip or by a comment on the issue it
 * named, and overridden by filing a new issue instead.
 */
export function agreementOf(p) {
  if (!p || p.status === 'pending') return null;
  const approved = p.status === 'approved';
  const result = p.decision && p.decision.result;
  if (p.verdict === 'DUPLICATE') return approved ? 'overridden' : 'agreed';
  if (p.verdict === 'FLAG' && approved && result !== 'commented') return 'overridden';
  if (p.verdict === 'FLAG' && !approved) return 'agreed';
  if (!approved) return 'overridden';
  return p.edited ? 'edited' : 'agreed';
}

/**
 * Whether a decision kept a duplicate out of the tracker: a COMMENT approved,
 * a FLAG approved as a comment on its issue, or a FLAG or DUPLICATE skipped as
 * already covered or already done.
 */
export function preventsDuplicate(p) {
  if (!p || p.status === 'pending') return false;
  const d = p.decision || {};
  if (p.verdict === 'COMMENT') return p.status === 'approved';
  if (p.verdict === 'FLAG' && p.status === 'approved') return d.result === 'commented';
  if (p.verdict === 'FLAG' || p.verdict === 'DUPLICATE') {
    const kind = d.reason_kind !== undefined ? d.reason_kind : reasonKind(d.reason, p.verdict);
    return p.status === 'skipped' && (kind === 'covered' || kind === 'done');
  }
  return false;
}

/** One draft → the proposal a reviewer acts on (status, safe, suggested action, decision). */
function proposal(d, call, teamOf, steps, rowFor) {
  const item = d.ts ? call.action_items.find((a) => a.ts === d.ts) : null;
  const step = d.ts ? steps.find((s) => s.ts === d.ts && s.quote) : null;
  const title = d.verdict === 'COMMENT'
    ? (item && item.title) || (d.target && d.target.title) || d.title
    : d.title;
  const status = d.decision === 'accepted' ? 'approved' : d.decision === 'skipped' ? 'skipped' : 'pending';
  const evidence = d.verdict === 'CREATE' ? d.dedup : (d.note ? unlink(d.note).split(/;\s+/)[0] : null);
  const ownerTeam = d.owner_team || (d.owner && teamOf(d.owner)) || null;
  const priority = d.priority || (item && item.priority) || null;
  // An edited approval: the block shows what was filed; the note says what the proposal had.
  const edit = d.edited ? parseEditNote(d.edit_note) : null;
  const was = (f, now) => (edit && f in edit.from ? edit.from[f] : now);
  const row = status === 'pending' ? null : rowFor(title);
  const p = {
    n: d.n,
    verdict: d.verdict,
    title,
    target: d.target,
    owner: d.owner,
    owner_team: ownerTeam,
    priority,
    ts: d.ts,
    quote: d.quote || (step && step.quote) || null,
    evidence,
    similarity: d.similarity,
    status,
    safe: SAFE.has(d.verdict),
    suggested: SUGGESTED[d.verdict] || 'review',
    decision: { result: d.result, ref: d.result_ref, reason: d.reason, reason_kind: status === 'skipped' ? reasonKind(d.reason, d.verdict) : null },
    on_approve: null,
    edited: Boolean(d.edited),
    edit_summary: d.edited ? d.edit_note : null,
    changed: edit ? edit.changed : [],
    original: edit ? { title, owner: was('owner', d.owner), priority: was('priority', priority), owner_team: was('team', ownerTeam) } : null,
    decided_at: row ? str(row.ts) : null,
  };
  p.agreement = agreementOf(p);
  p.prevents_duplicate = preventsDuplicate(p);
  return p;
}

/**
 * One call's task artifact as a decision log: every proposal, its status, and
 * what bulk actions apply. `opts.training` (task-decisions.jsonl rows) dates
 * each decided proposal (decided_at).
 */
export function taskLogEntry(call, tasksFile, members = [], opts = {}) {
  const teams = new Map(members.map((m) => [m.lastname, m.team]));
  const teamOf = (ln) => teams.get(ln) || null;
  const steps = digest(call.sections || []).next_steps;
  const base = callBasename(call.path);
  const rows = (opts.training || []).filter((r) => r.call_id === base);
  const rowFor = (title) => rows.find((r) => r.task_title === title) || null;
  const proposals = tasksFile ? tasksFile.drafts.map((d) => proposal(d, call, teamOf, steps, rowFor)) : [];
  const pending = proposals.filter((p) => p.status === 'pending');
  const mode = callMode(call.call_type);
  return {
    call_id: call.id,
    topic: call.topic,
    date: call.date,
    time: call.time,
    team: call.team,
    tasks_path: tasksFile ? tasksFile.path : null,
    generated: tasksFile ? tasksFile.generated : null,
    tracker: tasksFile ? tasksFile.tracker : null,
    autonomy_level: tasksFile ? tasksFile.autonomy_level : null,
    counts: tasksFile && tasksFile.counts ? tasksFile.counts : { extracted: proposals.length, created: 0, commented: 0, skipped: 0 },
    pending: pending.length,
    call_mode: mode,
    bulk: {
      approve_safe: { allowed: mode !== 'planning' && mode !== 'mixed', count: pending.filter((p) => p.safe).length },
      skip_remaining: { count: pending.length },
    },
    proposals,
  };
}

// --------------------------------------------------------------- overview

/** Monday of the ISO week a YYYY-MM-DD date falls in. */
function weekOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * The Overview's review metrics, as base values the workspace recomputes with
 * the decisions made in the browser:
 *   verdict_agreement     {agreed, edited, decided}: agreed = decided as
 *                         suggested; edited = approved after a change
 *   duplicates_prevented  {confirmed}: COMMENT approved + FLAG approved as a
 *                         comment + FLAG or DUPLICATE skipped as covered or done
 *   time_to_decision      {median_minutes, over_48h, calls[]}: per fully decided
 *                         call, call end → its last decision (training log ts);
 *                         over_48h counts proposals decided, or still waiting at
 *                         `now`, more than 48 h after their call ended
 *   owner_coverage        {with_owner, total}: distinct tasks (call + minute)
 *                         that are open or were filed as an issue
 *   processing            {calls, median_digest_minutes, max_digest_minutes}:
 *                         call end → tasks file `generated` (else the Slack post);
 *                         the minutes are null without tenant.yaml (no zone)
 * Call times are wall-clock in tenant.yaml's timezone (UTC when it names none).
 */
export function metrics({ calls, taskLog, states = itemStates(calls), timezone = null, now = null, tenant = null }) {
  const all = taskLog.flatMap((e) => e.proposals.map((p) => ({ e, p })));
  const decided = all.filter(({ p }) => p.status !== 'pending');
  const byId = new Map(calls.map((c) => [c.id, c]));
  const nowMs = now ? Date.parse(now) : NaN;

  const perCall = [];
  let over48 = 0;
  for (const e of taskLog) {
    const c = byId.get(e.call_id);
    const end = c ? callEndMs(c, timezone) : null;
    if (end === null || !e.proposals.length) continue;
    const times = [];
    for (const p of e.proposals) {
      const t = p.status === 'pending' ? nowMs : Date.parse(p.decided_at || '');
      if (p.status !== 'pending' && Number.isFinite(t)) times.push(t);
      if (Number.isFinite(t) && t - end > 48 * 3600e3) over48++;
    }
    const last = e.pending === 0 && times.length ? Math.max(...times) : null;
    perCall.push({
      call_id: e.call_id, ended_at: new Date(end).toISOString(), decided_at: last ? new Date(last).toISOString() : null,
      minutes: last ? Math.round((last - end) / 60000) : null, pending: e.pending,
    });
  }

  const tasks = new Map();
  for (const c of calls) {
    c.action_items.forEach((a, i) => {
      if (isOpenItem(a, states.get(`${c.id}|${i}`) || {})) tasks.set(`${c.id}|${a.ts || a.title}`, a.owner || null);
    });
  }
  for (const { e, p } of all) {
    if (p.status === 'approved' && p.decision.result === 'created') tasks.set(`${e.call_id}|${p.ts || p.title}`, p.owner || null);
  }

  // Minutes to the digest need the tenant's clock: without tenant.yaml (/app today) they stay null.
  const digestMinutes = [];
  for (const c of tenant ? calls : []) {
    const end = callEndMs(c, timezone);
    if (end === null) continue;
    const e = taskLog.find((x) => x.call_id === c.id);
    let at = e && e.generated ? Date.parse(e.generated) : NaN;
    if (!Number.isFinite(at)) {
      const post = slackPost(c, tenant);
      at = post && post.posted_at ? zonedMs(c.date, post.posted_at, timezone) ?? NaN : NaN;
    }
    if (Number.isFinite(at)) digestMinutes.push(Math.round((at - end) / 60000));
  }

  return {
    verdict_agreement: {
      agreed: decided.filter(({ p }) => p.agreement === 'agreed').length,
      edited: decided.filter(({ p }) => p.agreement === 'edited').length,
      decided: decided.length,
    },
    duplicates_prevented: { confirmed: decided.filter(({ p }) => p.prevents_duplicate).length },
    time_to_decision: {
      median_minutes: median(perCall.map((x) => x.minutes).filter((m) => m !== null)),
      over_48h: over48,
      calls: perCall,
    },
    owner_coverage: { with_owner: [...tasks.values()].filter(Boolean).length, total: tasks.size },
    processing: {
      calls: calls.length,
      median_digest_minutes: median(digestMinutes),
      max_digest_minutes: digestMinutes.length ? Math.max(...digestMinutes) : null,
    },
  };
}

/** What needs a decision, digest totals, and how the calls spread over weeks, teams and owners. */
export function overview({ calls, taskLog, training = null, states = itemStates(calls), timezone = null, now = null, tenant = null }) {
  const totals = { themes: 0, decisions: 0, agreements: 0, open_questions: 0, key_insights: 0 };
  for (const c of calls) {
    const d = digest(c.sections);
    for (const k of Object.keys(totals)) totals[k] += d[k].length;
  }
  const weeks = new Map();
  const dated = calls.map((c) => c.date).filter(Boolean).sort();
  if (dated.length) {
    for (let w = weekOf(dated[0]); w <= weekOf(dated[dated.length - 1]);) {
      weeks.set(w, 0);
      const d = new Date(`${w}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); w = d.toISOString().slice(0, 10);
    }
    for (const date of dated) weeks.set(weekOf(date), weeks.get(weekOf(date)) + 1);
  }
  const byTeam = {};
  for (const c of calls) byTeam[c.team] = (byTeam[c.team] || 0) + 1;
  // Open = post-call, not recorded as done by a later call, latest row for its issue.
  const open = {};
  for (const c of calls) {
    c.action_items.forEach((a, i) => {
      if (a.owner && isOpenItem(a, states.get(`${c.id}|${i}`) || {})) open[a.owner] = (open[a.owner] || 0) + 1;
    });
  }
  const flags = new Map();
  for (const e of taskLog) {
    for (const p of e.proposals) {
      if (p.verdict !== 'FLAG' || !p.target) continue;
      const f = flags.get(p.target.ref) || { ref: p.target.ref, title: p.target.title, calls: [], skipped: 0, pending: 0 };
      f.calls.push(e.call_id);
      if (p.status === 'skipped') f.skipped++;
      if (p.status === 'pending') f.pending++;
      flags.set(p.target.ref, f);
    }
  }
  const sortCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  return {
    needs_decision: taskLog.filter((e) => e.pending > 0).map((e) => ({
      call_id: e.call_id,
      topic: e.topic,
      date: e.date,
      pending: e.pending,
      safe: e.proposals.filter((p) => p.status === 'pending' && p.safe).length,
      flagged: e.proposals.filter((p) => p.status === 'pending' && p.verdict === 'FLAG').length,
      duplicates: e.proposals.filter((p) => p.status === 'pending' && p.verdict === 'DUPLICATE').length,
    })),
    digest_totals: totals,
    by_week: [...weeks].map(([week_of, n]) => ({ week_of, calls: n })),
    by_team: Object.fromEntries(Object.entries(byTeam).sort(sortCount)),
    open_by_owner: Object.entries(open).sort(sortCount).map(([owner, n]) => ({ owner, open: n })),
    repeat_flags: [...flags.values()].filter((f) => f.calls.length > 1),
    training: training ? {
      rows: training.length,
      accepted: training.filter((r) => r.user_action === 'accepted').length,
      edited: training.filter((r) => r.user_action === 'edited').length,
      skipped: training.filter((r) => r.user_action === 'skipped').length,
    } : null,
    metrics: metrics({ calls, taskLog, states, timezone, now, tenant }),
  };
}

// --------------------------------------------------------------- people

const ADD_PERSON_FIELDS = ['first_name*', 'lastname*', 'email'];
const ALIAS_RULES = ['{first}', '{first} {L}.', '@{email_local}'];

/** The fixed alias rules the "Add person" form applies: first name, "First L.", @email-local. */
export function aliasesFor({ first, lastname, email }) {
  const out = [];
  if (first) out.push(first);
  if (first && lastname) out.push(`${first} ${lastname[0]}.`);
  const local = email && String(email).split('@')[0];
  if (local) out.push(`@${local}`);
  return [...new Set(out)];
}

function callForEvidence(calls, ev) {
  if (ev.call) return calls.find((c) => c.path === ev.call) || null;
  const sameDay = calls.filter((c) => c.date === ev.date);
  if (sameDay.length <= 1) return sameDay[0] || null;
  return sameDay.find((c) => digestLines(c).some((l) => l.text.includes(ev.quote))) || sameDay[0];
}

/**
 * The People view: each profile with zone evidence resolved to calls and its
 * activity across calls; names heard on calls without a profile; and the
 * "Add person" form's rules. `suggestions` (role/zones a model would propose,
 * keyed by lastname) and `teams` (tenant team tags) come from the caller.
 */
export function peopleIndex({ members, calls, suggestions = {}, teams = [] }) {
  const profiled = new Set(members.map((m) => m.lastname));
  const idx = speakerIndex(members);
  const states = itemStates(calls);
  const people = members
    .filter((m) => m.status !== 'stale')
    .sort((a, b) => a.lastname.localeCompare(b.lastname))
    .map((m) => {
      const attended = calls.filter((c) => c.participants.includes(m.lastname));
      const rows = calls.flatMap((c) => c.action_items.map((a, i) => ({ a, key: `${c.id}|${i}`, st: states.get(`${c.id}|${i}`) || {} })))
        .filter((r) => r.a.owner === m.lastname);
      const owned = rows.map((r) => r.a);
      // Done: finished on a call, or closed by a later one; one count per issue.
      const done = new Set(rows.filter((r) => r.a.status === 'done-on-call' || r.st.closed_by)
        .map((r) => (r.a.tracker_ref ? `ref:${r.a.tracker_ref}` : r.key)));
      const partners = {};
      for (const c of attended) for (const p of c.participants) if (p !== m.lastname) partners[p] = (partners[p] || 0) + 1;
      return {
        ...m,
        zone_evidence: m.zone_evidence.map((z) => {
          if (!z.evidence) return { zone: z.zone, evidence: null, inferred: true };
          const c = callForEvidence(calls, z.evidence);
          return { zone: z.zone, evidence: { call_id: c ? c.id : null, date: z.evidence.date, ts: z.evidence.ts, quote: z.evidence.quote }, inferred: false };
        }),
        activity: {
          calls: attended.length,
          last_call: attended.map((c) => c.date).sort().pop() || null,
          open: rows.filter((r) => isOpenItem(r.a, r.st)).length,
          monitoring: rows.filter((r) => r.a.status === 'monitoring' && !r.st.closed_by && !r.st.superseded).length,
          done: done.size,
          helps: calls.reduce((n, c) => n + c.action_items.filter((a) => a.helpers.includes(m.lastname)).length, 0),
          tracker_refs: [...new Set(owned.map((a) => a.tracker_ref).filter(Boolean))].sort(),
          partners: Object.entries(partners).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([lastname, n]) => ({ lastname, calls: n })),
        },
      };
    });

  // Names heard on calls (participants, owners, helpers, guests) with no profile.
  const tokens = new Map();
  for (const c of calls) {
    const seen = [...c.participants, ...c.action_items.flatMap((a) => [a.owner, ...a.helpers])].filter(Boolean);
    for (const t of seen) {
      const known = profiled.has(t) || idx.has(t.toLowerCase());
      if (!known && !tokens.has(t)) tokens.set(t, { kind: 'teammate' });
    }
    for (const t of c.external_participants) if (!profiled.has(t)) tokens.set(t, { kind: 'external' });
  }
  const unprofiled = [...tokens].map(([token, { kind }]) => {
    const name = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(^|[^\\w])${name}(?![\\w])`);
    const mentions = calls.flatMap((c) => digestLines(c).filter((l) => word.test(l.text))
      .map((l) => ({ call_id: c.id, date: c.date, ts: l.ts, line: l.text })));
    const inCalls = new Set([
      ...calls.filter((c) => c.participants.includes(token) || c.external_participants.includes(token)
        || c.action_items.some((a) => a.owner === token || a.helpers.includes(token))).map((c) => c.id),
      ...mentions.map((x) => x.call_id),
    ]);
    const hint = mentions.map((x) => x.line.match(new RegExp(`${name}\\s+\\(([^)]+)\\)`))).find(Boolean);
    return { token, kind, calls: inCalls.size, mentions: mentions.length, role_hint: hint ? hint[1] : null, mentioned_in: mentions };
  }).sort((a, b) => b.calls - a.calls || b.mentions - a.mentions || a.token.localeCompare(b.token));

  const taken = [];
  for (const m of members) {
    for (const name of [m.lastname, ...m.aliases]) taken.push({ name, path: m.path || `team/${m.lastname}.md` });
  }
  const resolveEvidence = (list) => (list || []).map((ev) => {
    const c = callForEvidence(calls, ev);
    return { call_id: c ? c.id : null, ts: ev.ts || null, quote: ev.quote };
  });
  const suggested = {};
  for (const [lastname, s] of Object.entries(suggestions || {})) {
    const helpedWith = calls.flatMap((c) => c.action_items.filter((a) => a.helpers.includes(lastname)).map((a) => a.owner)).filter(Boolean);
    suggested[lastname] = {
      first_name: s.first_name || null,
      email: s.email || null,
      aliases: aliasesFor({ first: s.first_name, lastname, email: s.email }),
      role: s.role ? { value: s.role.value || null, evidence: resolveEvidence(s.role.evidence) } : null,
      team: { value: s.team || null, ask: !s.team, options: teams },
      zones: (s.zones || []).map((z) => ({ value: z.value, evidence: resolveEvidence(z.evidence) })),
      typical_partners: [...new Set(helpedWith)],
      // Chat and tracker accounts matched by email ({slack, tracker, matched_by}); the caller supplies them.
      accounts: s.accounts && typeof s.accounts === 'object' ? s.accounts : null,
    };
  }
  return {
    people,
    unprofiled,
    add_person: { fields: ADD_PERSON_FIELDS, alias_rules: ALIAS_RULES, teams, taken, suggestions: suggested },
  };
}

// --------------------------------------------------------------- vault map

const firstSentence = (s) => String(s || '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
  .split(/(?<=[a-z0-9)])\.\s+(?=[A-Z])/)[0].replace(/[\s;:.]+$/, '');

/** "`path` — what it is" entries from AGENTS.md's "## Folder map" (several may share one bullet). */
export function folderMap(agentsMd) {
  const part = String(agentsMd || '').split(/^## Folder map\s*$/m)[1];
  if (!part) return {};
  const bullets = [];
  for (const line of part.split(/^## /m)[0].split('\n')) {
    if (/^- /.test(line)) bullets.push(line.slice(2));
    else if (/^\s{2,}\S/.test(line) && bullets.length) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  const out = {};
  for (const b of bullets) {
    const marks = [...b.matchAll(/`([^`]+)`\s+—\s+/g)];
    marks.forEach((m, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].index : b.length;
      const about = firstSentence(b.slice(m.index + m[0].length, end));
      if (!(m[1] in out)) out[m[1]] = about;
    });
  }
  return out;
}

/**
 * AGENTS.md as the workspace shows it: the file's opening sentence and its
 * "How to find things" table as [{want, do}]. `do` keeps the cell's inline
 * markdown (commands in backticks); escaped pipes (\|) are unescaped. Null
 * when the vault has no AGENTS.md.
 */
export function agentsGuide(agentsMd, path = 'AGENTS.md') {
  const text = String(agentsMd || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const para = [];
  for (const line of lines.slice(lines.findIndex((l) => /^# /.test(l)) + 1)) {
    if (!line.trim()) { if (para.length) break; continue; }
    if (/^#/.test(line)) break;
    para.push(line.trim());
  }
  const intro = para.join(' ').split(/(?<=[.!?])\s+(?=[A-Z])/)[0] || null;
  const recipes = [];
  const section = text.split(/^## How to find things\b.*$/m)[1];
  for (const line of section ? section.split(/^## /m)[0].split(/\r?\n/) : []) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
      .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cells.length < 2 || cells.every((c) => /^:?-+:?$/.test(c))) continue;
    recipes.push({ want: cells[0], do: cells[1] });
  }
  if (recipes.length && /^you want$/i.test(recipes[0].want)) recipes.shift();
  return { path, intro, recipes };
}

/** A README's "# x/ — what it is" title, and "| `sub/` | what |" table rows, keyed by vault path. */
function readmeAbout(readmePath, text) {
  const dir = readmePath.split('/').slice(0, -1).join('/');
  const prefix = dir ? `${dir}/` : '';
  const out = {};
  const h1 = String(text || '').match(/^# (.+)$/m);
  if (h1) {
    const t = h1[1].match(/^(.+?)\s+—\s+(.+)$/);
    if (dir && t) out[prefix] = firstSentence(t[2]);
    if (!dir) out[''] = firstSentence(h1[1]);
  }
  for (const row of String(text || '').matchAll(/^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/gm)) {
    out[`${prefix}${row[1]}`] = firstSentence(row[2]);
  }
  return out;
}

/**
 * The vault as a map: a folder tree (what each part is, what it holds) and
 * the edges that link calls, tasks files, tracker issues and profiles.
 */
export function vaultTree({ files, calls, tasks, members, tenant = null, agentsMd = '', readmes = {}, training = [] }) {
  const visible = files.filter((f) => !/(^|\/)\.gitkeep$/.test(f)).sort();
  const v = (tenant && tenant.vault) || {};
  const teamTags = (Array.isArray(v.teams) ? v.teams : []).map((t) => t.folder || t.tag).filter(Boolean);
  const mixed = v.mixed_folder || 'general';
  const about = {};
  for (const [p, t] of Object.entries(readmes)) for (const [k, a] of Object.entries(readmeAbout(p, t))) about[k] = a;
  const map = folderMap(agentsMd);
  for (const [k, a] of Object.entries(map)) if (!k.includes('<')) about[k] = a;
  for (const t of Array.isArray(v.teams) ? v.teams : []) if (t.description) about[`${t.folder || t.tag}/`] = t.description;
  const transcriptsAbout = Object.entries(map).find(([k]) => /^<[^>]+>\/transcripts\/$/.test(k));

  const byPath = new Map(calls.map((c) => [c.path, c]));
  const tasksByPath = new Map(tasks.map((t) => [t.path, t]));
  const proposals = tasks.flatMap((t) => t.drafts);
  const node = (p, extra = {}) => ({ path: p, name: p.replace(/\/$/, '').split('/').pop() + (p.endsWith('/') ? '/' : ''), ...extra });

  const fileNode = (f) => {
    const kind = classify(f);
    const idFor = (p) => callId(p, dateFromName(p).date); // ids derive from the path alone
    if (kind === 'call') {
      const c = byPath.get(f);
      return node(f, { kind: 'call', call_id: idFor(f), topic: c ? c.topic : labelFromName(f), date: dateFromName(f).date });
    }
    if (kind === 'vtt') return node(f, { kind: 'transcript', call_id: idFor(f.replace(/\.vtt$/, '.md')) });
    if (kind === 'tasks') {
      const t = tasksByPath.get(f);
      return node(f, {
        kind: 'tasks-file',
        call_id: t && t.call ? idFor(t.call) : null,
        proposals: t ? t.drafts.length : null,
        pending: t ? t.drafts.filter((d) => d.decision === 'pending').length : null,
      });
    }
    if (kind === 'member') return node(f, { kind: 'profile', lastname: f.split('/').pop().replace(/\.md$/, '') });
    if (kind === 'training') return node(f, { kind: 'training-log', rows: training.length, about: about[f] || null });
    const k = kind === 'company' ? 'company' : kind === 'template' ? 'template' : kind === 'tenant' ? 'config'
      : /readme\.md$/i.test(f) ? 'readme' : f === 'AGENTS.md' ? 'agents' : /^docs\/skills\//.test(f) ? 'skill'
        : f === '.backbrief/roadmap.md' ? 'roadmap' : /(^|\/)\.gitignore$/.test(f) ? 'config' : 'doc';
    return node(f, { kind: k, about: about[f] || null });
  };

  // Build the nested folder structure.
  const root = { children: new Map(), files: [] };
  for (const f of visible) {
    const parts = f.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = `${parts.slice(0, i + 1).join('/')}/`;
      if (!cur.children.has(key)) cur.children.set(key, { children: new Map(), files: [] });
      cur = cur.children.get(key);
    }
    cur.files.push(f);
  }
  const folderKind = (p) => {
    if (/\/transcripts\/$/.test(p)) return 'calls';
    if (p === 'tasks/') return 'tasks';
    if (p === 'team/') return 'people';
    if (p === 'docs/templates/') return 'templates';
    if (p === 'docs/skills/') return 'skills';
    if (p === 'docs/') return 'docs';
    if (p === '.backbrief/training/') return 'training';
    if (p === '.backbrief/') return 'machine';
    if ([...teamTags, mixed].includes(p.replace(/\/$/, ''))) return 'team-folder';
    return 'folder';
  };
  const callsUnder = (p) => calls.filter((c) => c.path.startsWith(p));
  const build = (p, dir) => {
    const kind = folderKind(p);
    const under = callsUnder(p);
    const counts = {};
    if (kind === 'team-folder' || kind === 'calls') {
      counts.calls = under.length;
      counts.raw_transcripts = visible.filter((f) => f.startsWith(p) && classify(f) === 'vtt').length;
    }
    if (kind === 'tasks') {
      const here = tasks.filter((t) => t.path.startsWith(p));
      counts.files = here.length;
      counts.proposals = here.reduce((n, t) => n + t.drafts.length, 0);
      counts.pending = here.reduce((n, t) => n + t.drafts.filter((d) => d.decision === 'pending').length, 0);
    }
    if (kind === 'people') counts.profiles = visible.filter((f) => f.startsWith(p) && classify(f) === 'member').length;
    if (kind === 'templates') counts.templates = visible.filter((f) => f.startsWith(p)).length;
    if (kind === 'training') counts.rows = training.length;
    const own = about[p] || (kind === 'calls' && transcriptsAbout ? transcriptsAbout[1] : null);
    const kids = [...dir.children.entries()].map(([k, d]) => build(k, d)).sort((a, b) => a.path.localeCompare(b.path));
    return node(p, {
      kind,
      about: own || null,
      ...(Object.keys(counts).length ? { counts } : {}),
      ...(under.length && (kind === 'team-folder' || kind === 'calls') ? { last_call: under.map((c) => c.date).sort().pop() } : {}),
      children: [...kids, ...dir.files.sort().map(fileNode)],
    });
  };
  const order = [...teamTags, mixed].map((t) => `${t}/`).concat(['team/', 'tasks/', 'docs/', '.backbrief/']);
  const rank = (p) => (order.includes(p) ? order.indexOf(p) : order.length);
  const tree = [
    ...[...root.children.entries()].map(([k, d]) => build(k, d)).sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path)),
    ...root.files.sort().map(fileNode),
  ];

  // Edges: how one call links to its tasks file, tracker issues, owners and earlier calls.
  const edges = [];
  const profiles = new Set(members.map((m) => m.lastname));
  for (const c of calls) {
    const t = tasks.find((x) => x.call === c.path);
    if (t) {
      edges.push({ call_id: c.id, from: c.path, to: t.path, via: 'same basename + call:' });
      for (const d of t.drafts) {
        if (d.decision === 'accepted' && d.result === 'created' && d.result_ref) {
          edges.push({ call_id: c.id, from: t.path, to: d.result_ref, via: `decision: accepted → [${d.result_ref}]` });
        }
        if (d.decision === 'accepted' && d.result === 'commented' && d.result_ref) {
          edges.push({ call_id: c.id, from: t.path, to: d.result_ref, via: 'decision: accepted → comment posted' });
        }
      }
    }
    c.action_items.forEach((a, i) => {
      if (a.tracker_ref) {
        edges.push({ call_id: c.id, from: c.path, to: a.tracker_ref, via: `action_items[${i}].tracker_ref` });
        // The issue links back to the call that filed or commented on it, not to a later call that reports it done.
        if (a.status !== 'done-on-call') edges.push({ call_id: c.id, from: a.tracker_ref, to: c.path, via: 'issue body 📎 Source → Vault', rule: true });
      }
      if (a.owner && profiles.has(a.owner)) {
        edges.push({ call_id: c.id, from: c.path, to: `team/${a.owner}.md`, via: `action_items[${i}].owner = lastname` });
      }
    });
    for (const r of c.references) {
      edges.push({ call_id: c.id, from: c.path, to: r, via: 'references_prior_calls', to_call_id: callId(r, dateFromName(r).date) });
    }
    const vtt = transcriptPathFor(c);
    if (vtt && visible.includes(vtt)) edges.push({ call_id: c.id, from: c.path, to: vtt, via: 'transcript_file' });
  }

  return {
    repo: str(v.repo),
    branch: str(v.branch) || 'main',
    about: about[''] || null,
    counts: {
      files: visible.length,
      calls: calls.length,
      raw_transcripts: visible.filter((f) => classify(f) === 'vtt').length,
      tasks_files: tasks.length,
      proposals: proposals.length,
      pending: proposals.filter((d) => d.decision === 'pending').length,
      profiles: members.length,
      templates: visible.filter((f) => classify(f) === 'template').length,
      training_rows: training.length,
    },
    tree,
    edges,
    agents: agentsGuide(agentsMd),
  };
}

// --------------------------------------------------------------- settings

/**
 * The parts of Settings a vault can answer: per-source settings from
 * tenant.yaml and activity from calls and tasks files. Status, accounts and
 * scope wording are not in any vault; the caller merges them in.
 */
export function settingsFromVault({ tenant, calls, taskLog, slackScopes = [] }) {
  const f = (tenant && tenant.features) || {};
  const knobs = (tenant && tenant.pipeline && tenant.pipeline.knobs) || {};
  const slack = f.slack || {};
  const tracker = f.tracker || {};
  const v = (tenant && tenant.vault) || {};
  const last = calls.map((c) => c.date).filter(Boolean).sort().pop() || null;
  const decided = taskLog.flatMap((e) => e.proposals).filter((p) => p.status === 'approved');
  const slackSettings = {
    digest_channel: str(slack.digest_channel),
    per_team_channels: slack.per_team_channels && typeof slack.per_team_channels === 'object' ? slack.per_team_channels : {},
  };
  return {
    sources: [
      {
        id: 'zoom', category: 'meeting_platform',
        settings: {
          raw_retention: str(f.raw_retention) || 'vtt',
          min_duration_min: Number.isFinite(knobs.min_duration_min) ? knobs.min_duration_min : 5,
          history_import: { enabled: Boolean(f.history_import && f.history_import.enabled), days: (f.history_import && f.history_import.days) || 30 },
        },
        activity: { calls: calls.filter((c) => (c.platform || c.source) === 'zoom').length, last },
      },
      {
        id: 'slack', category: 'chat', enabled: slack.enabled !== false && Boolean(f.slack),
        scopes: slackScopes,
        settings: slackSettings,
        activity: { digests: calls.length, last },
      },
      {
        id: 'linear', category: 'tracker', enabled: tracker.enabled !== false && tracker.kind !== 'other',
        settings: {
          team_mapping: Object.fromEntries((Array.isArray(tracker.team_mapping) ? tracker.team_mapping : []).map((m) => [m.team_tag, m.tracker_team_key])),
          // Who gets a team's tasks that have no owner (tenant.yaml team_mapping[].default_assignee).
          default_assignees: Object.fromEntries((Array.isArray(tracker.team_mapping) ? tracker.team_mapping : []).filter((m) => m.default_assignee).map((m) => [m.team_tag, str(m.default_assignee)])),
          autonomy_level: str(tracker.autonomy_level) || 'L0',
          thresholds: { comment: 0.75, flag_discovery: 0.55, flag_planning: 0.35, ...(tracker.thresholds || {}) },
        },
        activity: {
          issues_created: decided.filter((p) => p.decision.result === 'created').length,
          comments: decided.filter((p) => p.decision.result === 'commented').length,
          file_only: decided.filter((p) => p.decision.result === 'file-only').length,
        },
      },
      {
        id: 'github', category: 'git_hosting',
        settings: { repo: str(v.repo), branch: str(v.branch) || 'main' },
        activity: { calls_filed: calls.length, last },
      },
    ],
    slack: { channel: slackSettings.digest_channel, per_team_channels: slackSettings.per_team_channels },
  };
}

// ---------------------------------------------------------------- workspace

/**
 * Assemble the workspace payload the cabinet renders.
 *
 * @param {object}   o
 * @param {object}   o.info        {id, name, mode, vault_url, tracker_url, integrations}
 * @param {string[]} o.callPaths   every call path in the vault (for totals)
 * @param {object[]} o.calls       parsed calls (may be only the most recent window)
 * @param {object[]} o.tasks       parsed tasks files
 * @param {object[]} o.members     parsed team profiles
 * @param {object}   [o.company]   parsed company profile
 * @param {string}   [o.now]       ISO time the "last 30 days" window ends on, and the clock
 *                                 overview.metrics measures waiting proposals against
 * @param {object}   [o.tenant]    parsed tenant.yaml (Slack channels for call details)
 * @param {string[]} [o.files]     every vault path (confirms .vtt siblings exist)
 * @param {object[]} [o.training]  parsed .backbrief/training/task-decisions.jsonl rows
 * @param {Function} [o.transcriptUrl] call → URL of its transcript JSON
 */
export function buildWorkspace({
  info, callPaths, calls, tasks, members, company = null, now = new Date().toISOString(),
  tenant = null, files = null, training = null, transcriptUrl = null,
}) {
  const sorted = [...calls].sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  const tasksByCall = new Map(tasks.filter((t) => t.call).map((t) => [t.call, t]));

  const since = new Date(new Date(now).getTime() - 30 * 864e5).toISOString().slice(0, 10);
  const allDates = callPaths.map((p) => dateFromName(p).date).filter(Boolean);
  const timezone = str(tenant && tenant.tenant && tenant.tenant.timezone);
  // Each item knows whether a later call closed it, and whether a later row for its issue replaces it.
  const states = itemStates(sorted);
  const items = [];
  for (const c of sorted) {
    c.action_items.forEach((a, i) => {
      const st = states.get(`${c.id}|${i}`);
      items.push({ ...a, call_id: c.id, call_topic: c.topic, call_date: c.date, closed_by: st.closed_by, superseded: st.superseded, open: isOpenItem(a, st) });
    });
  }
  const verdicts = { CREATE: 0, COMMENT: 0, FLAG: 0, DUPLICATE: 0, accepted: 0, skipped: 0 };
  for (const c of sorted) {
    const t = tasksByCall.get(c.path);
    if (!t) continue;
    for (const d of t.drafts) {
      if (verdicts[d.verdict] !== undefined) verdicts[d.verdict]++;
      if (d.decision === 'accepted') verdicts.accepted++;
      if (d.decision === 'skipped') verdicts.skipped++;
    }
  }
  const last = sorted[0] || null;
  const taskLog = sorted.map((c) => taskLogEntry(c, tasksByCall.get(c.path) || null, members, { training }));
  const logByCall = new Map(taskLog.map((e) => [e.call_id, e]));
  const names = new Map(members.map((m) => [m.lastname, m.name || m.lastname]));

  return {
    // timezone: tenant.yaml's IANA zone, for clock times the pipeline wrote in UTC (tasks `generated`).
    workspace: { ...info, company, timezone },
    window: { calls: sorted.length, total: callPaths.length, truncated: sorted.length < callPaths.length },
    stats: {
      calls_total: callPaths.length,
      calls_last_30d: allDates.filter((d) => d >= since).length,
      action_items: items.length,
      // open_items: still owed (see isOpenItem); latest_items: what a list shows, one row per issue.
      open_items: items.filter((a) => a.open).length,
      latest_items: items.filter((a) => !a.superseded).length,
      linked_to_tracker: items.filter((a) => a.tracker_ref).length,
      proposals: verdicts.CREATE + verdicts.COMMENT + verdicts.FLAG + verdicts.DUPLICATE,
      // Kept for older screens: every COMMENT and DUPLICATE verdict, decided or not.
      // overview.metrics.duplicates_prevented counts only the ones the team confirmed.
      duplicates_caught: verdicts.COMMENT + verdicts.DUPLICATE,
      accepted: verdicts.accepted,
      skipped: verdicts.skipped,
      pending: taskLog.reduce((n, e) => n + e.pending, 0),
      safe_pending: taskLog.reduce((n, e) => n + e.bulk.approve_safe.count, 0),
      people: members.length,
      last_call: last ? { id: last.id, date: last.date, time: last.time, topic: last.topic } : null,
    },
    calls: sorted.map((call) => {
      const { sections: secs, action_items, references, ...c } = call;
      const d = digest(secs);
      const log = logByCall.get(c.id);
      const lines = searchLines(call, { proposals: log.proposals, names });
      return {
        ...c,
        action_items_count: action_items.length,
        references_count: references.length,
        has_tasks_file: tasksByCall.has(c.path),
        decisions_count: d.decisions.length,
        agreements_count: d.agreements.length,
        first_decision: d.decisions.length ? d.decisions[0].title : null,
        proposals: { total: log.proposals.length, pending: log.pending },
        has_transcript: transcriptRef(c, files).available,
        has_recording: Boolean(c.recording_url),
        // Client-side search: match the lowercase blob, then show the matching line with ▶ ts.
        search: lines.map((l) => l.text).join('\n').toLowerCase(),
        search_lines: lines,
      };
    }),
    action_items: items,
    decisions: decisionsIndex(sorted, states),
    people: members
      .filter((m) => m.status !== 'stale')
      .sort((a, b) => a.lastname.localeCompare(b.lastname)),
    overview: overview({ calls: sorted, taskLog, training, states, timezone, now, tenant }),
    task_log: taskLog,
    _detail: (id) => {
      const c = sorted.find((x) => x.id === id);
      return c ? callDetail(c, tasksByCall.get(c.path) || null, new Map(sorted.map((x) => [x.path, x.topic])),
        { tenant, files, members, transcriptUrl, states, training }) : null;
    },
  };
}

/** Serialize a workspace for the wire (drops the detail accessor). */
export function workspaceJson(ws) {
  const { _detail, ...rest } = ws;
  return rest;
}
