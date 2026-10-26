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
 */
import { parseYaml, splitFrontmatter } from './yaml.js';

// ---------------------------------------------------------------- paths

/** Classify a vault-relative path. Returns 'call' | 'tasks' | 'member' | 'company' | null. */
export function classify(rel) {
  const base = rel.split('/').pop();
  if (/^readme\.md$/i.test(base)) return null;
  if (/(^|\/)tasks\/[^/]+\.tasks\.md$/.test(rel)) return 'tasks';
  if (/(^|\/)transcripts\/[^/]+\.md$/.test(rel)) return 'call';
  if (/^team\/[^/]+\.md$/.test(rel)) return 'member';
  if (rel === 'docs/company.md') return 'company';
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
    digest_version: str(meta.digest_version),
    references: list(meta.references_prior_calls),
    action_items: items,
    sections: sections(body),
  };
}

const VERDICTS = [
  ['CREATE', /✏️\s*CREATE/u], ['COMMENT', /💬\s*COMMENT/u],
  ['FLAG', /⚠️\s*FLAG/u], ['DUPLICATE', /🔁\s*DUPLICATE/u],
];

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
    drafts.push({ verdict, title, decision, decision_text: decisionText.trim(), refs: [...new Set(refs)], note });
  }
  return {
    path: rel,
    call: str(meta.call),
    tracker: str(meta.tracker),
    autonomy_level: str(meta.autonomy_level),
    drafts,
  };
}

/** One team/<Lastname>.md → person record. */
export function parseMember(rel, text) {
  const { meta } = parse(text);
  return {
    lastname: str(meta.lastname) || rel.split('/').pop().replace(/\.md$/, ''),
    first_names: list(meta.first_names),
    role: str(meta.role),
    team: str(meta.team),
    aliases: list(meta.aliases),
    zones: list(meta.zones),
    typical_partners: list(meta.typical_partners),
    status: str(meta.status),
  };
}

export function parseCompany(text) {
  const { meta } = parse(text);
  return { name: str(meta.name), what_we_do: str(meta.what_we_do), products: list(meta.products) };
}

/** Human label for a call path when its frontmatter wasn't read. */
export function labelFromName(rel) {
  const base = rel.split('/').pop().replace(/\.md$/, '');
  const kit = base.match(/^\d{4}-\d{2}-\d{2} \d{4} (.+?)(?: w .+)?$/);
  const raw = kit ? kit[1] : base.replace(/\{[^}]*\}/g, '').replace(/ – \d{4}-\d{2}-\d{2}.*$/, '').replace(/ w .+$/, '');
  const t = raw.trim().replace(/\s+/g, ' ');
  return t ? t[0].toUpperCase() + t.slice(1) : base;
}

/** Call detail: the call, its task proposals, and links to the calls it built on. */
export function callDetail(call, tasksFile = null, knownTopics = new Map()) {
  return {
    ...call,
    references: call.references.map((p) => ({
      path: p,
      id: callId(p, dateFromName(p).date),
      topic: knownTopics.get(p) || labelFromName(p),
    })),
    tasks: tasksFile,
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
 * @param {string}   [o.now]       ISO date the "last 30 days" window ends on
 */
export function buildWorkspace({ info, callPaths, calls, tasks, members, company = null, now = new Date().toISOString() }) {
  const sorted = [...calls].sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  const tasksByCall = new Map(tasks.filter((t) => t.call).map((t) => [t.call, t]));

  const since = new Date(new Date(now).getTime() - 30 * 864e5).toISOString().slice(0, 10);
  const allDates = callPaths.map((p) => dateFromName(p).date).filter(Boolean);
  const items = [];
  for (const c of sorted) {
    for (const a of c.action_items) items.push({ ...a, call_id: c.id, call_topic: c.topic, call_date: c.date });
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

  return {
    workspace: { ...info, company },
    window: { calls: sorted.length, total: callPaths.length, truncated: sorted.length < callPaths.length },
    stats: {
      calls_total: callPaths.length,
      calls_last_30d: allDates.filter((d) => d >= since).length,
      action_items: items.length,
      linked_to_tracker: items.filter((a) => a.tracker_ref).length,
      proposals: verdicts.CREATE + verdicts.COMMENT + verdicts.FLAG + verdicts.DUPLICATE,
      duplicates_caught: verdicts.COMMENT + verdicts.DUPLICATE,
      accepted: verdicts.accepted,
      skipped: verdicts.skipped,
      people: members.length,
      last_call: last ? { id: last.id, date: last.date, time: last.time, topic: last.topic } : null,
    },
    calls: sorted.map(({ sections: _s, action_items, references, ...c }) => ({
      ...c,
      action_items_count: action_items.length,
      references_count: references.length,
      has_tasks_file: tasksByCall.has(c.path),
    })),
    action_items: items,
    people: members
      .filter((m) => m.status !== 'stale')
      .sort((a, b) => a.lastname.localeCompare(b.lastname)),
    _detail: (id) => {
      const c = sorted.find((x) => x.id === id);
      return c ? callDetail(c, tasksByCall.get(c.path) || null, new Map(sorted.map((x) => [x.path, x.topic]))) : null;
    },
  };
}

/** Serialize a workspace for the wire (drops the detail accessor). */
export function workspaceJson(ws) {
  const { _detail, ...rest } = ws;
  return rest;
}
