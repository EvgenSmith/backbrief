// SPDX-License-Identifier: MIT
/*
 * cabinet.js — the workspace shell and its core, exposed as window.BB.
 *
 * One shell, two data sources:
 *   /demo  static JSON built from site/demo-vault (a fictional team). Demo
 *          actions write to an overlay kept in this browser (BB.state).
 *   /app   /api/* for a signed-in workspace, read from its vault. Read-only:
 *          an action with no API behind it is not rendered at all.
 *
 * Modules plug in through BB. They load after this file as deferred scripts,
 * in this order, and register their routes while they load:
 *   cabinet-tasks.js    Action items (task log, open items, review history,
 *                       Slack delivery) and the proposal cards in call detail
 *   cabinet-people.js   People, profiles, Add person
 *   cabinet-memory.js   Company memory
 *   cabinet-sources.js  Sources
 * The first route runs on DOMContentLoaded, once every module is in.
 *
 * Escaping rules
 *   - Everything from the vault, the API or the overlay is untrusted text. It
 *     reaches the page only through esc() (plain text) or inline()/md()
 *     (escape first, then a small markdown subset). Build HTML strings from
 *     escaped values only; never put raw content into innerHTML.
 *   - URLs go through safeUrl(): http(s), a same-origin path or a #hash.
 *   - CSP is 'self': no inline scripts or on* attributes, no style attributes
 *     and no el.style writes (use classes and `hidden`), no other origin.
 *
 * ----------------------------------------------------------------- BB API
 * Full notes and examples: core-api.md. Functions that return markup return
 * HTML strings built from escaped values.
 *
 * Basics
 *   BB.mode 'demo'|'app'   BB.isDemo   BB.contact (email for /app notes)
 *   BB.API                 {me, workspace, people, vault, settings, call(id),
 *                          transcript(id)}; vault, settings and transcript are
 *                          null in /app (no endpoint yet)
 *   BB.esc(s)  BB.safeUrl(u)  BB.inline(text, {call})  BB.md(text, {call})
 *       inline/md: `code`, **bold**, _em_, _[high]_ → priority, [t](url), and
 *       (mm:ss) → BB.ts(call, mm:ss) when {call: id} is passed
 *   BB.fmtDate(d, t) '19 Oct 2026, 10:00'   BB.fmtDay(d) '19 Oct'
 *   BB.clock(iso) '10:44' in the workspace timezone   BB.stamp(iso, sep?) 'today, 14:07'
 *   BB.now() ISO time   BB.plural(n, one, many?)   BB.joinAnd(list)   BB.initials(name)
 *   BB.href(...segments, query?)  '#/call/<id>/transcript/16:40', '#/calls?team=product'
 *   BB.verdict(v)  BB.prio(p)  BB.ref(r)  BB.teamChip(t)  BB.person(lastname)
 *   BB.ts(callId, mmss)    '▶ 16:40' → #/call/<id>/transcript/16:40, labelled
 *                          "Transcript at 16:40"; plain '(16:40)' when nothing
 *                          can be opened
 *   BB.callRow(call, {compact})  BB.loading(what)  BB.emptyState(html)  BB.managed()
 *   BB.deliveryPhrase(delivery)  'summary, recording link and task log'
 *   BB.DEMO_NOTE.{linear, slack, github, browser, connection}  toast line 2
 *
 * Data
 *   BB.load(key) → Promise, cached per page load. Keys: 'workspace', 'people',
 *     'vault', 'settings', 'call:<id>', 'transcript:<id>'. Resolves null where
 *     /app has no endpoint; a call outside the workspace rejects (status 404).
 *   BB.cached(key) → the loaded value, or undefined   BB.workspace() = cached('workspace')
 *
 * Router  (hash routes: #/<a>/<b>?<query>)
 *   BB.route(prefix, handler, opts)  prefix 'calls', 'call', 'tasks', 'tasks/open'…
 *     ('' is Overview, where unknown routes go). Longest matching prefix
 *     wins; registering a prefix again replaces it.
 *     handler(parts, query, ctx): parts = decoded segments after the prefix,
 *       query = plain object, ctx = {stale(), render(...)} for async work.
 *     opts: {nav, title, loading, needs, notFound}. needs = keys (or
 *       (parts, query) => keys) loaded before the handler runs; 'people?'
 *       marks one optional (null on failure). Default ['workspace'].
 *   BB.render(title, html, navKey?, {eyebrow, lede, actions, focus})
 *     eyebrow/lede/actions are HTML; focus = selector, element or function.
 *     The first render after a route change moves focus to the h1 (or focus).
 *   BB.go(hash, {replace})   BB.current {prefix, parts, query, hash, nav}
 *   BB.setLeaveGuard(fn)     fn(toHash, fromHash) → truthy (or a sentence) to
 *     ask "Leave without saving?"; dropped when the route prefix changes.
 *
 * Demo state (spec §3.12): BB.state, kept in localStorage["backbrief.demo.v1"]
 *   {v, decisions, edits, log_sent, delivery, channels, people_added,
 *    zone_reviews, sources, requests, imports}; memory only if storage fails.
 *   Mutate it, then BB.save(); then BB.refresh() to re-render.
 *   BB.save()  BB.reset()  BB.changeCount()  BB.storage 'local'|'memory'|'none'
 *   BB.decide(key, {action, result, ref, reason, edited, edit_summary})
 *   Selectors (read-only results; copy before sorting):
 *     BB.effectiveProposals()        task_log entries with the overlay applied
 *     BB.effectiveProposals(callId)  one entry, or null
 *     BB.effectiveActionItems(callId?)  BB.effectiveStats()  BB.effectivePeople()
 *     BB.effectiveSources()  BB.effectiveSlack()  BB.waitingCount()
 *   BB.refresh({focus}) re-renders the current view, the nav count and the
 *     header's "Reset demo · N changes".
 *
 * UI kit
 *   BB.toast(line1, line2)  two lines, 6 s, pauses on hover, Dismiss button
 *   BB.dialog({title, html, actions, wide, onOpen, onClose, trigger, returnFocus})
 *     → {el, body, result: Promise, close(value), busy(label|false)}; native
 *     <dialog>, Esc closes, focus returns to the trigger. actions: [{label,
 *     value, primary, cancel, busy: 'Posting…', onClick(handle) → false keeps
 *     it open}]
 *   BB.confirm({title, text|html, confirm, cancel, danger}) → Promise<boolean>
 *   BB.tabs(items, currentKey, {label})  items: [{key, href, label, count, mark}]
 *
 * Hooks and events
 *   BB.hooks.callAside(call, el)  render call detail's "Task proposals" into
 *     el (#proposals); runs after every render of the call view. Until a module
 *     sets it, the core lists the proposals with a link to Action items.
 *   BB.hooks.sendLog(callId, trigger)  open "Send the task log to Slack";
 *     Overview's button calls it (without it, the button opens the task log)
 *   BB.on('state' | 'reset' | 'route', fn) → unsubscribe function
 */
(() => {
  'use strict';

  // ================================================================ basics
  const body = document.body;
  const mode = body.dataset.mode === 'app' ? 'app' : 'demo';
  const isDemo = mode === 'demo';
  const contact = body.dataset.contact || '';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const API = Object.freeze(isDemo
    ? {
      me: null,
      workspace: '/demo/workspace.json',
      people: '/demo/people.json',
      vault: '/demo/vault.json',
      settings: '/demo/settings.json',
      call: (id) => `/demo/calls/${encodeURIComponent(id)}.json`,
      transcript: (id) => `/demo/transcripts/${encodeURIComponent(id)}.json`,
    }
    : {
      me: '/api/me',
      workspace: '/api/workspace',
      people: '/api/people',
      vault: null,
      settings: null,
      call: (id) => `/api/call?id=${encodeURIComponent(id)}`,
      transcript: null,
    });

  const ui = {
    title: $('[data-view-title]'),
    eyebrow: $('[data-view-eyebrow]'),
    actions: $('[data-view-actions]'),
    lede: $('[data-view-lede]'),
    view: $('[data-view]'),
    navCount: $('[data-nav-count]'),
    reset: $('[data-reset]'),
    banner: $('[data-demo-banner]'),
    wsName: $('[data-ws-name]'),
    user: $('[data-user]'),
    toasts: $('[data-toasts]'),
  };
  for (const n of $$(isDemo ? '[data-app-only]' : '[data-demo-only]')) n.hidden = true;

  // ================================================================ helpers
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const safeUrl = (u) => (typeof u === 'string' && /^(https?:\/\/|\/(?!\/)|#)/i.test(u) ? u : null);
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? [+m[1], +m[2], +m[3]] : null; };
  const fmtDay = (d) => { const p = ymd(d); return p ? `${p[2]} ${MONTHS[p[1] - 1]}` : ''; };
  const fmtDate = (d, t) => {
    const p = ymd(d);
    if (!p) return '';
    const s = `${p[2]} ${MONTHS[p[1] - 1]} ${p[0]}`;
    return t ? `${s}, ${t}` : s;
  };
  const now = () => new Date().toISOString();
  const toSeconds = (mmss) => { const m = String(mmss || '').match(/^(\d{1,3}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

  /** Clock time of an ISO instant in the workspace timezone ('10:44'). */
  function clock(iso, tz = timezone()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz || undefined }).format(d);
    } catch {
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
  }

  /**
   * How demo actions are dated, on the viewer's clock: 'today, 14:07' (else
   * '19 Oct, 14:07'). Inside a sentence pass sep ' ': 'Log posted to #x, today 14:07.'
   */
  function stamp(iso, sep = ', ') {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === new Date().toDateString() ? `today${sep}${hm}` : `${d.getDate()} ${MONTHS[d.getMonth()]}${sep}${hm}`;
  }

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const joinAnd = (xs) => {
    const a = (xs || []).filter(Boolean);
    return a.length < 2 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
  };
  const initials = (name) => String(name || '').split(/[\s.-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  /** '#/' + path; args are segments (a/b allowed), an optional last object is the query. */
  function href(...args) {
    const last = args[args.length - 1];
    const query = last && typeof last === 'object' && !Array.isArray(last) ? args.pop() : null;
    const segs = args.flatMap((a) => String(a ?? '').split('/')).filter(Boolean)
      .map((s) => encodeURIComponent(s).replace(/%3A/gi, ':'));
    const q = query ? new URLSearchParams(Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
      .map(([k, v]) => [k, String(v)])).toString() : '';
    return `#/${segs.join('/')}${q ? `?${q}` : ''}`;
  }

  const VERDICT = { CREATE: 'Create', COMMENT: 'Comment', FLAG: 'Flag', DUPLICATE: 'Duplicate' };
  function verdict(v) {
    const k = String(v || '').toUpperCase();
    return VERDICT[k] ? `<span class="v v-${k.toLowerCase()}">${VERDICT[k]}</span>` : '<span class="v v-other">Other</span>';
  }
  const prio = (p) => (p ? `<span class="prio prio-${esc(String(p).toLowerCase())}">${esc(p)}</span>` : '');
  function ref(r) {
    if (!r) return '';
    const tpl = workspace() && workspace().workspace.tracker_url;
    const url = tpl ? safeUrl(String(tpl).replace('{ref}', encodeURIComponent(r))) : null;
    return url
      ? `<a class="chip chip-ref" href="${esc(url)}" rel="noopener">${esc(r)}</a>`
      : `<span class="chip chip-ref">${esc(r)}</span>`;
  }
  const teamChip = (t) => (t ? `<span class="chip">${esc(t)}</span>` : '');

  /** Can a ▶ for this call open its transcript here? (demo: yes when kept; /app: no endpoint yet) */
  function canOpenTranscript(callId) {
    if (!API.transcript || !callId) return false;
    const row = workspace() && workspace().calls.find((c) => c.id === callId);
    if (row) return Boolean(row.has_transcript);
    const d = cached(`call:${callId}`);
    return Boolean(d && d.transcript && d.transcript.available && d.transcript.url);
  }

  /** A call offset: '▶ 16:40' linking to the transcript cue, or plain '(16:40)'. */
  function ts(callId, mmss) {
    const t = String(mmss || '');
    if (!/^\d{1,3}:\d{2}$/.test(t)) return '';
    if (!canOpenTranscript(callId)) return `<span class="ts-plain">(${esc(t)})</span>`;
    return `<a class="ts" href="${esc(href('call', callId, 'transcript', t))}" aria-label="Transcript at ${esc(t)}">▶ ${esc(t)}</a>`;
  }

  /** Escape, then the markdown subset; ctx.call turns (mm:ss) into ▶ links. */
  function inline(text, ctx = {}) {
    let s = esc(String(text ?? '').replace(/\u0000/g, ''));
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(«“])_([^_]+)_(?=$|[\s).,;:!?»”])/g, '$1<em>$2</em>');
    s = s.replace(/<em>\[(urgent|high|medium|low)\]<\/em>/g, (m, p) => prio(p));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
      const url = safeUrl(u.replace(/&amp;/g, '&'));
      return url ? `<a href="${esc(url)}" rel="noopener">${t}</a>` : t;
    });
    s = s.replace(/\((\d{1,3}:\d{2})\)/g, (m, t) => ts(ctx.call, t));
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
  }

  /** Block markdown: ### headings, - and 1. lists (with > quotes under items), > quotes, paragraphs. */
  function md(src, ctx = {}) {
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '), ctx)}</p>`); para = []; } };
    const closeList = () => {
      if (!list) return;
      const start = list.tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
      out.push(`<${list.tag}${start}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const raw of String(src || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if (!line.trim()) { flushPara(); closeList(); continue; }
      if ((m = line.match(/^#{3,6}\s+(.*)$/))) { flushPara(); closeList(); out.push(`<h3>${inline(m[1], ctx)}</h3>`); continue; }
      if ((m = line.match(/^\s+>\s?(.*)$/)) && list) { list.items[list.items.length - 1] += `<blockquote>${inline(m[1], ctx)}</blockquote>`; continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); out.push(`<blockquote>${inline(m[1], ctx)}</blockquote>`); continue; }
      if ((m = line.match(/^[-*]\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== 'ul') { closeList(); list = { tag: 'ul', items: [] }; }
        list.items.push(inline(m[1], ctx));
        continue;
      }
      if ((m = line.match(/^(\d+)\.\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== 'ol') { closeList(); list = { tag: 'ol', start: Number(m[1]), items: [] }; }
        list.items.push(inline(m[2], ctx));
        continue;
      }
      if (list && /^\s+/.test(raw)) { list.items[list.items.length - 1] += ` ${inline(line.trim(), ctx)}`; continue; }
      closeList();
      para.push(line.trim());
    }
    flushPara();
    closeList();
    return out.join('\n');
  }

  const loading = (what) => `<p class="muted loading" role="status">Loading the ${esc(what)}…</p>`;
  const emptyState = (html) => `<div class="empty">${html}</div>`;
  const managed = () => `Managed by Backbrief. Ask us at <a href="mailto:${esc(contact)}">${esc(contact)}</a> to change it.`;
  const deliveryPhrase = (d = {}) => joinAnd(['summary', d.transcript_link && 'transcript link', d.recording_link && 'recording link', d.task_log && 'task log']);

  const DEMO_NOTE = Object.freeze({
    linear: 'Demo · nothing was sent to Linear.',
    slack: 'Demo · nothing was posted to Slack.',
    github: 'Demo · nothing was committed to GitHub.',
    browser: 'Demo · saved in this browser only.',
    connection: 'Demo · no connection was made.',
  });

  // ================================================================ data
  const cache = new Map();
  let dataVersion = 0;

  async function getJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!isDemo && (res.status === 401 || res.status === 403)) {
      location.href = '/login';
      throw Object.assign(new Error('Signed out.'), { status: res.status, signedOut: true });
    }
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw Object.assign(new Error(b.detail || b.error || `HTTP ${res.status}`), { status: res.status });
    }
    return res.json();
  }

  const notFound = () => Object.assign(new Error("This call isn't in the workspace."), { status: 404 });

  async function fetchCall(id) {
    if (!/^[\w-]{6,40}$/.test(id)) throw notFound();
    const w = await load('workspace');
    if (!w.calls.some((c) => c.id === id) && !(w.window && w.window.truncated)) throw notFound();
    try {
      return await getJson(API.call(id));
    } catch (e) {
      throw e.status === 404 ? notFound() : e;
    }
  }

  async function fetchTranscript(id) {
    if (!API.transcript) return null;
    const c = await load(`call:${id}`);
    const url = c && c.transcript && c.transcript.available ? c.transcript.url || API.transcript(id) : null;
    return url && /^\/(?!\/)/.test(url) ? getJson(url) : null;
  }

  function fetchKey(key) {
    const i = key.indexOf(':');
    const kind = i < 0 ? key : key.slice(0, i);
    const id = i < 0 ? '' : key.slice(i + 1);
    if (kind === 'workspace') return getJson(API.workspace);
    if (kind === 'people') {
      return getJson(API.people).then((p) => ({
        people: Array.isArray(p.people) ? p.people : [],
        unprofiled: Array.isArray(p.unprofiled) ? p.unprofiled : [],
        add_person: p.add_person || null,
      }));
    }
    if (kind === 'vault') return API.vault ? getJson(API.vault) : Promise.resolve(null);
    if (kind === 'settings') return API.settings ? getJson(API.settings) : Promise.resolve(null);
    if (kind === 'call' && id) return fetchCall(id);
    if (kind === 'transcript' && id) return fetchTranscript(id);
    return Promise.reject(new Error(`Unknown data key "${key}".`));
  }

  function load(key) {
    const k = String(key);
    const hit = cache.get(k);
    if (hit) return hit.promise;
    const entry = { done: false, value: undefined, promise: null };
    entry.promise = fetchKey(k).then(
      (v) => { entry.done = true; entry.value = v; dataVersion++; return v; },
      (e) => { if (cache.get(k) === entry) cache.delete(k); throw e; },
    );
    cache.set(k, entry);
    return entry.promise;
  }
  function cached(key) {
    const e = cache.get(String(key));
    return e && e.done ? e.value : undefined;
  }
  const workspace = () => cached('workspace');
  const timezone = () => (workspace() && workspace().workspace.timezone) || undefined;
  const company = () => {
    const w = workspace();
    return (w && w.workspace.company && w.workspace.company.name) || (w ? w.workspace.name : 'Workspace');
  };
  const displayName = () => (isDemo ? company() : (workspace() ? workspace().workspace.name : 'Workspace'));
  const titleName = () => (workspace() ? workspace().workspace.name : 'Workspace');
  const lastCallDate = () => {
    const w = workspace();
    return (w && w.stats.last_call && w.stats.last_call.date) || (w && w.calls[0] && w.calls[0].date) || '';
  };

  // ================================================================ demo state
  const STORE_KEY = 'backbrief.demo.v1';
  const blankState = () => ({
    v: 1, decisions: {}, edits: {}, log_sent: {}, delivery: null, channels: null,
    people_added: [], zone_reviews: {}, sources: {}, requests: {}, imports: [],
  });
  const state = blankState();
  let storage = isDemo ? 'local' : 'none';
  let stateVersion = 0;

  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  function adopt(saved) {
    const blank = blankState();
    for (const k of Object.keys(state)) delete state[k];
    for (const [k, def] of Object.entries(blank)) {
      const v = saved ? saved[k] : undefined;
      if (k === 'v') state.v = 1;
      else if (Array.isArray(def)) state[k] = Array.isArray(v) ? v : def;
      else if (def === null) state[k] = isObj(v) ? v : null;
      else state[k] = isObj(v) ? v : def;
    }
    stateVersion++;
  }

  function readStore() {
    if (!isDemo) return;
    let raw = null;
    try { raw = window.localStorage.getItem(STORE_KEY); storage = 'local'; } catch { storage = 'memory'; }
    let saved = null;
    try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
    adopt(saved && saved.v === 1 ? saved : null);
  }

  function save() {
    stateVersion++;
    if (isDemo) {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); storage = 'local'; } catch { storage = 'memory'; }
    }
    emit('state', state);
  }

  function reset() {
    adopt(null);
    if (isDemo) {
      try { window.localStorage.removeItem(STORE_KEY); } catch { storage = 'memory'; }
    }
    emit('reset', state);
    emit('state', state);
  }

  function changeCount() {
    const n = (o) => (isObj(o) ? Object.keys(o).length : 0);
    return n(state.decisions) + n(state.edits) + n(state.log_sent) + (state.delivery ? 1 : 0) + (state.channels ? 1 : 0)
      + state.people_added.length + n(state.zone_reviews) + n(state.sources) + n(state.requests) + state.imports.length;
  }

  /** Record a decision on proposal `key` ('<call_id>:<n>') and save. */
  function decide(key, d = {}) {
    state.decisions[key] = {
      action: 'approve', result: null, ref: null, reason: null, edited: false, edit_summary: null, ...d, at: d.at || now(),
    };
    save();
    return state.decisions[key];
  }

  // Selectors recompute when data loads or the state changes, not on every call.
  const memos = new Map();
  function memo(name, fn) {
    const v = `${dataVersion}.${stateVersion}`;
    const m = memos.get(name);
    if (m && m.v === v) return m.value;
    const value = fn();
    memos.set(name, { v, value });
    return value;
  }

  /** One task_log entry with the overlay's edits and decisions applied. */
  function overlayEntry(e) {
    const proposals = (e.proposals || []).map((p) => {
      const key = `${e.call_id}:${p.n}`;
      const out = { ...p, key, call_id: e.call_id, edited: false, changed: [], original: null, by: null, at: null, edit_summary: null };
      if (p.status !== 'pending') return out;
      const ed = state.edits[key];
      if (isObj(ed)) {
        out.original = { title: p.title, owner: p.owner, priority: p.priority, owner_team: p.owner_team };
        if (typeof ed.title === 'string' && ed.title.trim() && ed.title !== p.title) { out.title = ed.title; out.changed.push('title'); }
        if ('owner' in ed && (ed.owner || null) !== (p.owner || null)) { out.owner = ed.owner || null; out.changed.push('owner'); }
        if (ed.priority && ed.priority !== p.priority) { out.priority = ed.priority; out.changed.push('priority'); }
        if (ed.team && ed.team !== p.owner_team) { out.owner_team = ed.team; out.changed.push('team'); }
        if (typeof ed.comment === 'string') { out.comment = ed.comment; out.changed.push('comment'); }
        out.edited = out.changed.length > 0;
      }
      const d = state.decisions[key];
      if (isObj(d)) {
        out.status = d.action === 'skip' || d.result === 'skipped' ? 'skipped' : 'approved';
        out.decision = { result: d.result || (out.status === 'skipped' ? 'skipped' : null), ref: d.ref || null, reason: d.reason || null };
        out.by = 'you';
        out.at = d.at || null;
        out.edit_summary = d.edit_summary || null;
        if (d.edited) out.edited = true;
      }
      return out;
    });
    const pending = proposals.filter((p) => p.status === 'pending');
    const mine = proposals.filter((p) => p.by === 'you');
    const more = (r) => mine.filter((p) => p.decision.result === r).length;
    const base = e.counts || { extracted: proposals.length, created: 0, commented: 0, skipped: 0 };
    return {
      ...e,
      proposals,
      pending: pending.length,
      counts: { ...base, created: (base.created || 0) + more('created'), commented: (base.commented || 0) + more('commented'), skipped: (base.skipped || 0) + more('skipped') },
      bulk: {
        approve_safe: { allowed: e.bulk ? e.bulk.approve_safe.allowed !== false : true, count: pending.filter((p) => p.safe).length },
        skip_remaining: { count: pending.length },
      },
      decided_here: mine.length,
      log_sent: isObj(state.log_sent[e.call_id]) ? state.log_sent[e.call_id] : null,
    };
  }

  function effectiveProposals(callId) {
    const all = memo('proposals', () => {
      const w = workspace();
      return (w && Array.isArray(w.task_log) ? w.task_log : []).map(overlayEntry);
    });
    if (callId === undefined) return all;
    const hit = all.find((e) => e.call_id === callId);
    if (hit) return hit;
    const d = cached(`call:${callId}`);
    return d && d.task_log ? overlayEntry(d.task_log) : null;
  }

  const waitingCount = () => effectiveProposals().reduce((n, e) => n + e.pending, 0);

  function effectiveActionItems(callId) {
    const all = memo('items', () => {
      const w = workspace();
      // An approved CREATE or COMMENT gives the call's action item at the same minute its issue key.
      const gains = new Map();
      for (const e of effectiveProposals()) {
        for (const p of e.proposals) {
          if (p.by === 'you' && p.status === 'approved' && p.decision.ref && p.ts && (p.verdict === 'CREATE' || p.verdict === 'COMMENT')) {
            gains.set(`${e.call_id}|${p.ts}`, p.decision.ref);
          }
        }
      }
      return (w ? w.action_items : []).map((a) => {
        const g = gains.get(`${a.call_id}|${a.ts}`);
        return g && !a.tracker_ref ? { ...a, tracker_ref: g, ref_added: true } : a;
      });
    });
    if (callId === undefined) return all;
    const mine = all.filter((a) => a.call_id === callId);
    if (mine.length || (workspace() && workspace().calls.some((c) => c.id === callId))) return mine;
    const d = cached(`call:${callId}`);
    return d ? (d.action_items || []).map((a) => ({ ...a, call_id: callId, call_topic: d.topic, call_date: d.date })) : [];
  }

  function effectivePeople() {
    return memo('people', () => {
      const loaded = cached('people');
      const base = loaded || { people: (workspace() && workspace().people) || [], unprofiled: [], add_person: null };
      const reviews = isObj(state.zone_reviews) ? state.zone_reviews : {};
      const added = state.people_added.filter((p) => isObj(p) && typeof p.lastname === 'string').map((p) => ({ ...p, added: true }));
      const names = new Set(added.map((p) => p.lastname));
      const reviewed = (p) => {
        const verdictFor = (z) => reviews[`${p.lastname}:${z}`];
        return {
          ...p,
          zones: (p.zones || []).filter((z) => verdictFor(z) !== 'removed'),
          zone_evidence: (p.zone_evidence || []).filter((z) => verdictFor(z.zone) !== 'removed')
            .map((z) => (verdictFor(z.zone) === 'confirmed' ? { ...z, review: 'confirmed' } : z)),
        };
      };
      return {
        people: [...base.people.filter((p) => !names.has(p.lastname)), ...added].map(reviewed).sort((a, b) => a.lastname.localeCompare(b.lastname)),
        unprofiled: base.unprofiled.filter((u) => !names.has(u.token)),
        add_person: base.add_person,
        loaded: Boolean(loaded),
      };
    });
  }

  function effectiveStats() {
    return memo('stats', () => {
      const w = workspace();
      if (!w) return null;
      const s = { ...w.stats };
      const all = effectiveProposals().flatMap((e) => e.proposals);
      const mine = all.filter((p) => p.by === 'you');
      s.pending = all.filter((p) => p.status === 'pending').length;
      s.safe_pending = all.filter((p) => p.status === 'pending' && p.safe).length;
      s.accepted = (w.stats.accepted || 0) + mine.filter((p) => p.status === 'approved').length;
      s.skipped = (w.stats.skipped || 0) + mine.filter((p) => p.status === 'skipped').length;
      s.decided_here = mine.length;
      s.linked_to_tracker = effectiveActionItems().filter((a) => a.tracker_ref).length;
      s.people = (w.stats.people || 0) + state.people_added.length;
      s.unprofiled_teammates = cached('people') ? effectivePeople().unprofiled.filter((u) => u.kind === 'teammate').length : null;
      return s;
    });
  }

  const SOURCE_IDS = ['zoom', 'slack', 'linear', 'github'];
  function effectiveSources() {
    return memo('sources', () => {
      const st = cached('settings');
      if (!st) {
        const flags = (workspace() && workspace().workspace.integrations) || {};
        return SOURCE_IDS.map((id) => ({ id, status: flags[id] ? 'connected' : 'not_connected', account: null, connected_at: null, settings: {}, activity: null }));
      }
      return st.sources.map((s) => {
        const o = state.sources[s.id];
        if (!isObj(o)) return s;
        return { ...s, status: o.status || s.status, settings: { ...s.settings, ...(isObj(o.settings) ? o.settings : {}) }, changed_at: o.at || null, changed_here: true };
      });
    });
  }

  function effectiveSlack() {
    return memo('slack', () => {
      const st = cached('settings');
      const base = (st && st.slack) || { channel: null, per_team_channels: {}, delivery: { summary: true }, locked: ['summary'], channels_available: [], preview_call_id: null };
      const ch = isObj(state.channels) ? state.channels : null;
      return {
        ...base,
        channel: (ch && ch.default) || base.channel,
        per_team_channels: ch ? Object.fromEntries(Object.entries(ch).filter(([k, v]) => k !== 'default' && v)) : base.per_team_channels,
        delivery: { ...base.delivery, ...(isObj(state.delivery) ? state.delivery : {}), summary: true },
        base_delivery: base.delivery,
        changed: Boolean(state.delivery || state.channels),
      };
    });
  }

  // ================================================================ events and hooks
  const listeners = {};
  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
    return () => { listeners[evt] = listeners[evt].filter((f) => f !== fn); };
  }
  function emit(evt, arg) {
    for (const fn of listeners[evt] || []) {
      try { fn(arg); } catch (e) { console.error(e); }
    }
  }
  const hooks = { callAside: null, sendLog: null };

  // ================================================================ UI kit
  function toast(line1, line2 = '') {
    const box = ui.toasts;
    if (!box) return null;
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<p class="toast-1">${esc(line1)}</p>${line2 ? `<p class="toast-2">${esc(line2)}</p>` : ''}<button class="toast-x" type="button">Dismiss</button>`;
    let left = 6000;
    let started = 0;
    let timer = null;
    const close = () => { clearTimeout(timer); t.remove(); };
    const start = () => { clearTimeout(timer); started = Date.now(); timer = setTimeout(close, left); };
    const pause = () => { clearTimeout(timer); left = Math.max(1500, left - (Date.now() - started)); };
    t.addEventListener('mouseenter', pause);
    t.addEventListener('mouseleave', () => { if (!t.contains(document.activeElement)) start(); });
    t.addEventListener('focusin', pause);
    t.addEventListener('focusout', (e) => { if (!t.contains(e.relatedTarget)) start(); });
    t.querySelector('.toast-x').addEventListener('click', close);
    box.append(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    start();
    return { el: t, close };
  }

  function resolveFocus(x) {
    if (!x) return null;
    if (typeof x === 'function') { try { return resolveFocus(x()); } catch { return null; } }
    if (typeof x === 'string') return $(x, ui.view) || $(x);
    return x instanceof Element && x.isConnected ? x : null;
  }

  /** Focus an element and scroll it into view: centred, or from its top when it is tall (a task-log group). */
  function focusTarget(t, block) {
    if (!t) return;
    if (!t.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(t.tagName)) t.setAttribute('tabindex', '-1');
    t.focus({ preventScroll: true });
    const tall = t.getBoundingClientRect().height > window.innerHeight * 0.4;
    t.scrollIntoView({ block: block || (tall ? 'start' : 'center'), behavior: 'instant' });
  }

  let dialogSeq = 0;
  function dialog(opts = {}) {
    const {
      title = '', html = '', wide = false, onOpen = null, onClose = null, className = '',
      actions = [{ label: 'Close', value: null, cancel: true }],
    } = opts;
    const trigger = opts.trigger || document.activeElement;
    const id = `dlg-${++dialogSeq}`;
    const d = document.createElement('dialog');
    d.className = ['sheet', wide ? 'sheet-wide' : '', className].filter(Boolean).join(' ');
    d.setAttribute('aria-labelledby', `${id}-title`);
    const primaryAt = actions.findIndex((a) => a.primary) >= 0 ? actions.findIndex((a) => a.primary) : actions.findIndex((a) => !a.cancel);
    d.innerHTML = `<form class="sheet-form" novalidate>
      <div class="sheet-head"><h2 id="${id}-title">${esc(title)}</h2></div>
      <div class="sheet-body">${html}</div>
      <div class="sheet-actions">${actions.map((a, i) => `<button class="btn btn-small${i === primaryAt ? '' : ' btn-ghost'}" type="${a.cancel ? 'button' : 'submit'}" data-action="${i}"${a.autofocus ? ' autofocus' : ''}${a.disabled ? ' aria-disabled="true"' : ''}>${esc(a.label)}</button>`).join('')}</div>
    </form>`;
    document.body.append(d);
    const form = d.querySelector('form');
    const buttons = $$('[data-action]', d);
    let settled = false;
    let busyLabel = null;
    let resolve;
    const result = new Promise((r) => { resolve = r; });

    const handle = {
      el: d,
      body: d.querySelector('.sheet-body'),
      result,
      isBusy: false,
      button: (i) => buttons[i] || null,
      close(value = null) {
        if (settled) return;
        settled = true;
        if (d.open) d.close();
        finish(value);
      },
      busy(label, at = primaryAt) {
        if (label === false) {
          handle.isBusy = false;
          form.removeAttribute('aria-busy');
          for (const b of buttons) if (b.dataset.wasDisabled !== '1') b.removeAttribute('aria-disabled');
          if (busyLabel) { busyLabel.btn.textContent = busyLabel.text; busyLabel = null; }
          return;
        }
        handle.isBusy = true;
        form.setAttribute('aria-busy', 'true');
        for (const b of buttons) { b.dataset.wasDisabled = b.getAttribute('aria-disabled') === 'true' ? '1' : ''; b.setAttribute('aria-disabled', 'true'); }
        const btn = buttons[at];
        if (label && btn) { if (!busyLabel) busyLabel = { btn, text: btn.textContent }; btn.textContent = label; }
      },
    };

    function finish(value) {
      d.remove();
      try { if (onClose) onClose(value, handle); } catch (e) { console.error(e); }
      const back = trigger && trigger.isConnected && trigger !== document.body ? trigger : resolveFocus(opts.returnFocus) || ui.title;
      if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
      resolve(value);
    }

    async function act(i) {
      const a = actions[i];
      const btn = buttons[i];
      if (!a || handle.isBusy || settled || (btn && btn.getAttribute('aria-disabled') === 'true')) return;
      if (a.onClick) {
        let r;
        try {
          if (a.busy) handle.busy(a.busy, i);
          r = await a.onClick(handle);
        } catch (e) {
          console.error(e);
          r = false;
        }
        if (!settled) handle.busy(false);
        if (r === false || settled) return;
      }
      handle.close(a.value !== undefined ? a.value : !a.cancel);
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const at = e.submitter && e.submitter.dataset.action;
      act(at !== undefined ? Number(at) : buttons.findIndex((b) => b.type === 'submit'));
    });
    for (const b of buttons) if (b.type === 'button') b.addEventListener('click', () => act(Number(b.dataset.action)));
    d.addEventListener('cancel', (e) => { e.preventDefault(); if (!handle.isBusy) handle.close(null); });
    d.addEventListener('close', () => { if (!settled) { settled = true; finish(null); } });
    d.showModal();
    try { if (onOpen) onOpen(handle); } catch (e) { console.error(e); }
    return handle;
  }

  function confirm(opts = {}) {
    const h = dialog({
      title: opts.title || 'Are you sure?',
      html: opts.html || (opts.text ? `<p>${esc(opts.text)}</p>` : ''),
      actions: [
        { label: opts.confirm || 'OK', value: true, primary: true },
        { label: opts.cancel || 'Cancel', value: false, cancel: true, autofocus: Boolean(opts.danger) },
      ],
      trigger: opts.trigger,
      returnFocus: opts.returnFocus,
    });
    return h.result.then((v) => v === true);
  }

  function tabs(items, current, opts = {}) {
    return `<nav class="tabs" aria-label="${esc(opts.label || 'Views')}">${items.map((t) => {
      const n = t.count !== undefined && t.count !== null && t.count !== '' ? ` <span class="${t.mark && Number(t.count) > 0 ? 'chip-mark' : 'chip'}">${esc(t.count)}</span>` : '';
      return `<a href="${esc(t.href)}"${t.key === current ? ' aria-current="page"' : ''}>${esc(t.label)}${n}</a>`;
    }).join('')}</nav>`;
  }

  // ================================================================ router
  const routes = [];
  let current = null;
  let seq = 0;
  let booted = false;
  let pendingFocus = null;
  let leaveGuard = null;
  let guardPrefix = null;

  function route(prefix, handler, opts = {}) {
    const p = String(prefix || '').replace(/^#?\/*/, '').replace(/\/+$/, '');
    const r = { prefix: p, segs: p ? p.split('/') : [], handler, opts };
    const i = routes.findIndex((x) => x.prefix === p);
    if (i >= 0) routes[i] = r; else routes.push(r);
  }

  function parse(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '');
    const qi = raw.indexOf('?');
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const query = {};
    for (const [k, v] of new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '')) query[k] = v;
    return { segs: path.split('/').filter(Boolean).map(dec), query, hash: `#/${raw}` };
  }

  function match(segs) {
    let best = null;
    for (const r of routes) {
      if (r.segs.length > segs.length || !r.segs.every((s, i) => s === segs[i])) continue;
      if (!best || r.segs.length > best.segs.length) best = r;
    }
    return best;
  }

  function setNav(key) {
    for (const a of $$('[data-nav]')) {
      if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  /** In a strip that scrolls sideways (the phone nav, tab strips), bring the current item into view. */
  function revealCurrent(root) {
    for (const strip of $$('.app-nav, .tabs', root)) {
      const cur = $('[aria-current="page"]', strip);
      if (!cur || strip.scrollWidth <= strip.clientWidth) continue;
      const left = cur.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      strip.scrollLeft = Math.max(0, left - (strip.clientWidth - cur.offsetWidth) / 2);
    }
  }

  function setSlot(node, html) {
    if (!node) return;
    node.innerHTML = html || '';
    node.hidden = !html;
  }

  function render(heading, html, navKey, opts = {}) {
    ui.title.textContent = heading;
    setSlot(ui.eyebrow, opts.eyebrow);
    setSlot(ui.actions, opts.actions);
    setSlot(ui.lede, opts.lede);
    ui.view.innerHTML = html;
    setNav(navKey || (current && current.nav) || 'overview');
    document.title = `${heading} | ${titleName()} | Backbrief`;
    syncChrome();
    if (typeof opts.before === 'function') opts.before(ui.view);
    revealCurrent(document);
    const p = pendingFocus;
    pendingFocus = null;
    if (!p) return;
    if (p.refresh) {
      const t = resolveFocus(opts.focus) || resolveFocus(p.focus) || resolveFocus(p.restore);
      if (t && !t.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(t.tagName)) t.setAttribute('tabindex', '-1');
      if (t) t.focus({ preventScroll: true });
      else if (p.hadFocusInView) ui.title.focus({ preventScroll: true });
      return;
    }
    const t = resolveFocus(opts.focus) || resolveFocus(p.focus);
    if (t) focusTarget(t);
    else if (!p.initial) { ui.title.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
  }

  function renderLoading(r, needs) {
    const p = pendingFocus;
    pendingFocus = null;
    const kinds = needs.map((k) => k.replace(/\?$/, '').split(':')[0]);
    const noun = r.opts.loading || (kinds.includes('call') || kinds.includes('transcript') ? 'call'
      : kinds.includes('vault') ? 'repository map' : kinds.includes('people') ? 'profiles' : 'workspace');
    render(r.opts.title || 'Loading…', loading(noun), r.opts.nav);
    pendingFocus = p;
  }

  function renderError(r, parts, e) {
    if (e && e.status === 404 && typeof r.opts.notFound === 'function') {
      const x = r.opts.notFound(parts, e);
      render(x.title, x.html, r.opts.nav, { eyebrow: x.eyebrow, lede: x.lede });
      return;
    }
    render(e && e.status === 404 ? 'Not found' : 'Something went wrong', emptyState(`
      <p>${esc(e && e.status === 404 ? e.message : `This page could not load: ${e ? e.message : 'unknown error'}.`)}</p>
      <p><a href="#/">Back to Overview</a></p>`), r.opts.nav || 'overview');
  }

  function focusKey(a) {
    if (!a || a === document.body || !ui.view.contains(a)) return null;
    if (a.id) return `#${CSS.escape(a.id)}`;
    if (a.dataset && a.dataset.key) return `[data-key="${CSS.escape(a.dataset.key)}"]`;
    if (a.name) return `[name="${CSS.escape(a.name)}"]`;
    return null;
  }

  async function run(o = {}) {
    let loc = parse(location.hash);
    let r = match(loc.segs);
    if (!r || (r.prefix === '' && loc.segs.length)) {
      if (location.hash && location.hash !== '#/' && location.hash !== '#') history.replaceState(null, '', '#/');
      loc = parse('#/');
      r = match([]);
      if (!r) return;
    }
    const my = ++seq;
    const parts = loc.segs.slice(r.segs.length);
    current = { prefix: r.prefix, parts, query: loc.query, hash: loc.hash, nav: r.opts.nav || r.segs[0] || 'overview' };
    BB.current = current;
    if (guardPrefix !== null && guardPrefix !== r.prefix) { leaveGuard = null; guardPrefix = null; }
    const a = document.activeElement;
    pendingFocus = o.refresh
      ? { refresh: true, focus: o.focus, restore: focusKey(a), hadFocusInView: ui.view.contains(a) && a !== ui.view }
      : { refresh: false, focus: o.focus, initial: Boolean(o.initial) };
    const needs = (typeof r.opts.needs === 'function' ? r.opts.needs(parts, loc.query) : r.opts.needs) || ['workspace'];
    if (!o.refresh && needs.some((k) => cached(k.replace(/\?$/, '')) === undefined)) renderLoading(r, needs);
    let error = null;
    await Promise.all(needs.map((k) => (k.endsWith('?') ? load(k.slice(0, -1)).catch(() => null) : load(k)))).catch((e) => { error = e; });
    if (my !== seq) return;
    if (error) {
      if (!error.signedOut) renderError(r, parts, error);
      return;
    }
    const ctx = { stale: () => my !== seq, render: (...args) => { if (my === seq) render(...args); } };
    try {
      await r.handler(parts, loc.query, ctx);
    } catch (e) {
      console.error(e);
      if (my === seq) renderError(r, parts, e);
    }
    if (my === seq) emit('route', current);
  }

  function go(hash, opts = {}) {
    let h = String(hash || '#/');
    if (!h.startsWith('#')) h = `#${h.startsWith('/') ? '' : '/'}${h}`;
    if (opts.replace) { history.replaceState(null, '', h); run(); return; }
    if (location.hash === h) run();
    else location.hash = h;
  }

  function refresh(opts = {}) {
    stateVersion++;
    if (!booted) return Promise.resolve();
    return run({ ...opts, refresh: true });
  }

  function setLeaveGuard(fn) {
    leaveGuard = typeof fn === 'function' ? fn : null;
    guardPrefix = leaveGuard && current ? current.prefix : null;
  }

  async function onHashChange() {
    const h = location.hash;
    if (h && h !== '#' && !h.startsWith('#/')) {
      // An in-page anchor (#main, #proposals): focus it, keep the route.
      const target = document.getElementById(dec(h.slice(1)));
      history.replaceState(null, '', current ? current.hash : '#/');
      if (target) focusTarget(target, 'start');
      return;
    }
    if (current && leaveGuard) {
      const to = h || '#/';
      let ask = null;
      try { ask = leaveGuard(to, current.hash); } catch (e) { console.error(e); }
      if (ask) {
        history.replaceState(null, '', current.hash);
        const ok = await confirm({
          title: 'Leave without saving?',
          text: typeof ask === 'string' ? ask : 'Your changes on this page are not saved.',
          confirm: 'Leave', cancel: 'Stay', returnFocus: ui.title,
        });
        if (!ok) return;
        leaveGuard = null;
        guardPrefix = null;
        if (location.hash === to) run(); else location.hash = to;
        return;
      }
    }
    run();
  }

  function onDocClick(e) {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a) {
      const h = a.getAttribute('href');
      if (h !== '#' && !h.startsWith('#/')) {
        const target = document.getElementById(dec(h.slice(1)));
        if (target) { e.preventDefault(); focusTarget(target, 'start'); }
      }
      return;
    }
    const j = e.target.closest && e.target.closest('[data-jump]');
    if (j) {
      const target = document.getElementById(j.dataset.jump);
      if (target) { e.preventDefault(); focusTarget(target, 'start'); }
    }
  }

  // ================================================================ shell
  function bannerHtml(n) {
    const link = n ? `Start with the ${plural(n, 'proposal')} waiting for a decision →` : 'See what the team filed →';
    return `<span class="banner-long">Demo workspace for ${esc(company())}, a fictional team. Approve, skip, edit and connect anything: it all runs in your browser. <a href="#/tasks">${esc(link)}</a></span>`
      + '<span class="banner-short">Demo for a fictional team. Everything runs in your browser. <a href="#/tasks">Start here →</a></span>';
  }

  function syncChrome() {
    if (!workspace()) return;
    const n = waitingCount();
    if (ui.navCount) {
      ui.navCount.hidden = !n;
      const html = n ? `<span class="sr-only">, </span>${n}<span class="sr-only"> waiting</span>` : '';
      if (ui.navCount.innerHTML !== html) ui.navCount.innerHTML = html;
    }
    if (!isDemo) return;
    const c = changeCount();
    if (ui.reset) ui.reset.textContent = c ? `Reset demo · ${plural(c, 'change')}` : 'Reset demo';
    if (ui.banner) {
      const html = bannerHtml(n);
      if (ui.banner.innerHTML !== html) ui.banner.innerHTML = html;
    }
  }

  async function onReset() {
    const ok = await confirm({
      title: 'Reset the demo?',
      text: 'This clears your approvals, skips, edits, Slack settings, added people and connection changes in this browser.',
      confirm: 'Reset demo',
      cancel: 'Cancel',
      trigger: ui.reset,
    });
    if (!ok) return;
    reset();
    await refresh();
    toast(`Demo reset to ${fmtDay(lastCallDate())}.`, DEMO_NOTE.browser);
  }

  // ================================================================ shared views
  const profiled = (lastname) => effectivePeople().people.some((p) => p.lastname === lastname);
  /** A teammate's name, linked to the profile when there is one. */
  function person(lastname) {
    if (!lastname) return '';
    return profiled(lastname) ? `<a href="${esc(href('people', lastname))}">${esc(lastname)}</a>` : esc(lastname);
  }

  /** One call in a ledger: the full row (Calls) or the compact one (Overview, profiles). */
  function callRow(c, opts = {}) {
    const e = effectiveProposals(c.id);
    const waiting = e ? e.pending : (c.proposals && c.proposals.pending) || 0;
    const mark = waiting ? `<span class="chip-mark">${waiting} waiting</span>` : '';
    const who = `${esc((c.participants || []).join(', '))}${c.duration_min ? ` · ${esc(c.duration_min)} min` : ''}`;
    if (opts.compact) {
      return `<li class="call-row">
        <span class="call-date">${esc(fmtDay(c.date))}</span>
        <div class="call-main">
          <p class="call-topic"><a class="call-link" href="${esc(href('call', c.id))}">${esc(c.topic)}</a> ${mark}</p>
          <p class="call-people">${c.team ? `${esc(c.team)} · ` : ''}${who}</p>
        </div>
      </li>`;
    }
    const total = (c.proposals && c.proposals.total) || 0;
    const counts = [
      plural(c.decisions_count || 0, 'decision'),
      plural(c.agreements_count || 0, 'agreement'),
      plural(c.action_items_count || 0, 'action item'),
      plural(total, 'proposal'),
    ].map(esc);
    if (c.has_transcript && canOpenTranscript(c.id)) counts.push(`<a href="${esc(href('call', c.id, 'transcript'))}">Transcript</a>`);
    return `<li class="call-row">
      <span class="call-date"><span>${esc(fmtDay(c.date))}</span>${c.time ? `<span>${esc(c.time)}</span>` : ''}</span>
      <div class="call-main">
        <p class="call-topic"><a class="call-link" href="${esc(href('call', c.id))}">${esc(c.topic)}</a>
          <span class="call-meta">${teamChip(c.team)}${c.call_type ? `<span>${esc(c.call_type)}</span>` : ''}${mark}</span></p>
        <p class="call-people">${who}</p>
        <p class="call-counts">${counts.join(' · ')}</p>
      </div>
    </li>`;
  }

  // ================================================================ Overview (§3.1)
  const SOURCE_NAMES = { zoom: 'Zoom', slack: 'Slack', linear: 'Linear', github: 'GitHub' };

  function repoName() {
    const gh = effectiveSources().find((s) => s.id === 'github');
    if (gh && gh.account) return gh.account;
    const url = workspace() && workspace().workspace.vault_url;
    const m = String(url || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)/);
    return m ? m[1] : null;
  }

  function waitingPanel() {
    const w = workspace();
    const rows = [];
    let look = false;
    for (const nd of (w.overview && w.overview.needs_decision) || []) {
      const e = effectiveProposals(nd.call_id);
      if (!e) continue;
      const pend = e.proposals.filter((p) => p.status === 'pending');
      if (pend.length) {
        look = true;
        // "Approve all safe" is off on planning and mixed calls, so no "safe" chip there.
        const safe = e.bulk.approve_safe.allowed ? pend.filter((p) => p.safe).length : 0;
        const flagged = pend.filter((p) => p.verdict === 'FLAG').length;
        const dups = pend.filter((p) => p.verdict === 'DUPLICATE').length;
        const chips = [
          safe ? `<span class="chip">${safe > 1 ? `${safe} safe to approve together` : '1 safe to approve'}</span>` : '',
          flagged ? `<span class="v v-flag">${flagged} flagged</span>` : '',
          dups ? `<span class="v v-duplicate">${plural(dups, 'duplicate')}</span>` : '',
        ].join('');
        rows.push(`<div class="attn-row">
          <p class="attn-what"><strong>${plural(pend.length, 'task proposal')}</strong> from <a href="${esc(href('call', nd.call_id))}">${esc(nd.topic)}</a> <span class="mono muted">· ${esc(fmtDay(nd.date))}</span></p>
          <div class="attn-do"><span class="attn-chips">${chips}</span><a class="btn btn-small" href="${esc(href('tasks', 'call', nd.call_id))}">Review ${plural(pend.length, 'proposal')}</a></div>
        </div>`);
        continue;
      }
      // Everything this call proposed has been decided in the demo.
      const mine = e.proposals.filter((p) => p.by === 'you');
      const n = (r) => mine.filter((p) => p.decision.result === r).length;
      const parts = [n('created') && `${n('created')} created`, n('commented') && `${n('commented')} commented`, n('skipped') && `${n('skipped')} skipped`].filter(Boolean);
      const what = nd.pending === 1 ? `The proposal from ${fmtDay(nd.date)} is decided` : `All ${nd.pending} proposals from ${fmtDay(nd.date)} are decided`;
      const sent = e.log_sent;
      rows.push(`<div class="attn-row is-inline">
        <p class="attn-what">${esc(what)}${parts.length ? `: ${esc(parts.join(', '))}` : ''}.</p>
        ${sent ? `<p class="attn-done">Log posted to <span class="mono">${esc(sent.channel || '#call-digests')}</span>, ${esc(stamp(sent.at, ' '))}.</p>`
    : isDemo ? `<div class="attn-do"><button class="btn btn-small" type="button" data-send-log="${esc(nd.call_id)}">Send the log to Slack</button></div>` : ''}
      </div>`);
    }
    for (const u of effectivePeople().unprofiled.filter((x) => x.kind === 'teammate')) {
      look = true;
      rows.push(`<div class="attn-row is-inline">
        <p class="attn-what">${esc(u.token)} is named on ${plural(u.calls, 'call')} but has no profile.</p>
        ${isDemo ? `<div class="attn-do"><a class="btn btn-small btn-ghost" href="${esc(href('people', 'add', { last: u.token }))}">Add profile</a></div>` : ''}
      </div>`);
    }
    if (!rows.length) {
      rows.push(`<div class="attn-row"><p class="attn-what">${w.calls.length
        ? 'Nothing is waiting for you. Proposals from your next call show up here.'
        : "Nothing is waiting for you yet. Your first call's proposals show up here."}</p></div>`);
    }
    return `<section class="panel${look ? ' attn' : ''}" aria-labelledby="h-waiting"><h2 id="h-waiting">Waiting for you</h2>${rows.join('')}</section>`;
  }

  function statTiles() {
    const s = effectiveStats();
    const d = (workspace().overview && workspace().overview.digest_totals) || {};
    const u = s.unprofiled_teammates;
    const tiles = [
      { k: 'Calls', v: s.calls_total, sub: `${s.calls_last_30d} in the last 30 days`, to: '#/calls' },
      { k: 'Decisions', v: d.decisions ?? 0, sub: `${plural(d.agreements || 0, 'agreement')} · ${plural(d.open_questions || 0, 'open question')}` },
      { k: 'Task proposals', v: s.proposals, sub: `${s.accepted} approved · ${s.skipped} skipped · ${s.pending} waiting`, to: '#/tasks' },
      { k: 'Duplicates caught', v: s.duplicates_caught, sub: 'commented or skipped, not filed twice' },
      {
        k: 'People', v: s.people, to: '#/people',
        sub: u === null || u === undefined ? 'profiles the digests resolve names with' : u ? `${plural(u, 'teammate')} without a profile` : 'every teammate on calls has a profile',
      },
    ];
    return `<ul class="stat-grid" aria-label="Totals">${tiles.map((t) => {
      const inner = `<span class="stat-k">${esc(t.k)}</span><span class="stat-v">${esc(t.v)}</span><span class="stat-sub">${esc(t.sub)}</span>`;
      return `<li class="stat">${t.to ? `<a class="stat-box" href="${t.to}">${inner}</a>` : `<div class="stat-box">${inner}</div>`}</li>`;
    }).join('')}</ul>`;
  }

  function recentCalls() {
    const w = workspace();
    return `<section class="panel" aria-labelledby="h-recent">
      <div class="panel-head"><h2 id="h-recent">Recent calls</h2><a href="#/calls">All calls</a></div>
      <ol class="call-list">${w.calls.slice(0, 5).map((c) => callRow(c, { compact: true })).join('')}</ol>
    </section>`;
  }

  function openByOwner() {
    const list = (workspace().overview && workspace().overview.open_by_owner) || [];
    const total = list.reduce((n, o) => n + o.open, 0);
    const calls = new Set(effectiveActionItems().filter((a) => a.status === 'post-call' && a.owner).map((a) => a.call_id)).size;
    const rows = list.map((o) => `<li><a class="owner-row" href="${esc(href('tasks', 'open', { owner: o.owner }))}" aria-label="${esc(o.owner)}, ${esc(plural(o.open, 'open item'))}">
      <span>${esc(o.owner)}</span><span class="units" aria-hidden="true">${'<i></i>'.repeat(Math.min(o.open, 30))}</span><span class="owner-n">${esc(o.open)}</span></a></li>`).join('');
    return `<section class="panel" aria-labelledby="h-owners">
      <div class="panel-head"><h2 id="h-owners">Open items by owner</h2><a href="#/tasks/open">All open items</a></div>
      <p class="panel-note">${total ? `${esc(total)} open across ${esc(plural(calls, 'call'))}` : 'Nothing open.'}</p>
      ${rows ? `<ol class="owner-list">${rows}</ol>` : ''}
    </section>`;
  }

  function connectedPanel() {
    const w = workspace();
    const items = effectiveSources().map((s) => {
      const on = s.status === 'connected';
      return `<li><a href="${esc(href('sources', s.id))}">
        <span class="source-state${on ? '' : ' is-off'}"><span class="status-dot${on ? '' : ' is-off'}" aria-hidden="true"></span>${on ? 'Connected' : 'Not connected'}</span>
        <span class="source-name">${esc(SOURCE_NAMES[s.id] || s.id)}</span>
        ${isDemo && on && s.account ? `<span class="source-account">${esc(s.account)}</span>` : ''}
      </a></li>`;
    }).join('');
    const repo = repoName();
    const files = [plural(w.stats.calls_total, 'call'), plural(w.task_log.filter((e) => e.tasks_path).length, 'tasks file'), plural(w.stats.people, 'profile')].join(', ');
    return `<section class="panel" aria-labelledby="h-connected">
      <h2 id="h-connected">Connected</h2>
      <ul class="sources-row">${items}</ul>
      <p class="small muted">Saved to ${repo ? `<span class="mono">${esc(repo)}</span> on GitHub` : 'your git repository'}: ${esc(files)}. If you leave Backbrief, the files stay yours.</p>
    </section>`;
  }

  function setupSteps() {
    const w = workspace();
    if (w.overview && Array.isArray(w.overview.setup) && w.overview.setup.length) return w.overview.setup;
    if (isDemo) return null;
    // /app knows only what the vault and the workspace flags say: no dates.
    const flags = w.workspace.integrations || {};
    const first = [...w.calls].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))[0];
    return [
      { id: 'sources', done: SOURCE_IDS.every((k) => flags[k]) },
      { id: 'people', done: w.stats.people > 0, count: w.stats.people },
      { id: 'slack', done: Boolean(flags.slack) },
      { id: 'first_call', done: Boolean(first), at: first ? first.date : null, call_id: first ? first.id : null },
    ];
  }

  function setupPanel() {
    const steps = setupSteps();
    if (!steps) return '';
    const w = workspace();
    const delivery = (cached('settings') && cached('settings').slack && cached('settings').slack.delivery) || null;
    const firstTopic = (id) => { const c = w.calls.find((x) => x.id === id); return c ? c.topic : ''; };
    const META = {
      sources: () => ({ title: 'Tools connected', to: '#/sources', note: '', next: 'Connect your tools' }),
      people: (s) => ({ title: s.done ? `${plural(s.count || 0, 'profile')} confirmed` : "Check who's who", to: '#/people', note: '', next: 'Check profiles' }),
      slack: () => ({ title: 'Slack delivery chosen', to: '#/tasks/slack', note: delivery ? deliveryPhrase(delivery) : '', next: 'Choose what goes to Slack' }),
      first_call: (s) => ({ title: 'First call', to: s.call_id ? href('call', s.call_id) : '#/calls', note: s.call_id ? firstTopic(s.call_id) : '', next: 'See where calls arrive' }),
    };
    const nextAt = steps.findIndex((s) => !s.done);
    const cells = steps.map((s, i) => {
      const m = (META[s.id] || (() => ({ title: s.id, to: '#/', note: '' })))(s);
      const n = pad(i + 1);
      const when = [s.at ? fmtDay(s.at) : '', m.note].filter(Boolean).join(': ');
      const state = s.done ? '<span class="step-state">Done</span>' : i === nextAt ? '<span class="step-state is-next">Next</span>' : '<span class="step-state is-next">To do</span>';
      return `<li${s.done ? ' class="is-done"' : ''}>
        <p class="k"><span>${n}</span>${state}</p>
        <h3><a href="${esc(m.to)}">${esc(m.title)}</a></h3>
        ${when ? `<p>${esc(when)}</p>` : ''}
        ${!isDemo && i === nextAt ? `<a class="btn btn-small" href="${esc(m.to)}">${esc(m.next)}</a>` : ''}
      </li>`;
    }).join('');
    return `<section class="setup" aria-labelledby="h-setup"><h2 id="h-setup">How this workspace was set up</h2><ol class="start">${cells}</ol></section>`;
  }

  function overviewView() {
    const w = workspace();
    const has = w.calls.length > 0;
    const last = w.stats.last_call;
    const setup = setupPanel();
    const html = `
      ${!isDemo && !has ? setup : ''}
      ${waitingPanel()}
      ${statTiles()}
      ${has ? `<div class="two-col">${recentCalls()}${openByOwner()}</div>` : ''}
      ${connectedPanel()}
      ${isDemo ? setup : ''}`;
    render('Overview', html, 'overview', {
      eyebrow: `${esc(displayName())}${last ? ` · last call ${esc(fmtDay(last.date))}${last.time ? `, ${esc(last.time)}` : ''}` : ''}`,
    });
    for (const b of $$('[data-send-log]', ui.view)) {
      b.addEventListener('click', () => {
        if (typeof hooks.sendLog === 'function') hooks.sendLog(b.dataset.sendLog, b);
        else go(href('tasks', 'call', b.dataset.sendLog));
      });
    }
  }

  // ================================================================ Calls (§3.2)
  function weekOf(date) {
    const p = ymd(date);
    if (!p) return '';
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }

  function callsView(parts, query) {
    const w = workspace();
    const teams = [...new Set(w.calls.map((c) => c.team).filter(Boolean))].sort();
    const dates = w.calls.map((c) => c.date).filter(Boolean).sort();
    const eyebrow = w.calls.length
      ? `${esc(plural(w.window && w.window.truncated ? w.window.total : w.calls.length, 'call'))}${dates.length ? ` · ${esc(fmtDay(dates[0]))} to ${esc(fmtDay(dates[dates.length - 1]))}` : ''}`
      : '';
    const filters = w.calls.length ? `
      <form class="filters" role="search" aria-label="Filter calls" data-calls-filters>
        <label>Team <select name="team"><option value="">All teams</option>${teams.map((t) => `<option value="${esc(t)}"${t === query.team ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="waiting" value="1"${query.waiting === '1' ? ' checked' : ''}> Only calls waiting for a decision</label>
        <label class="grow">Search <input type="search" name="q" value="${esc(query.q || '')}" placeholder="Topic, person or tag" autocomplete="off"></label>
      </form>
      <p class="sr-only" role="status" data-calls-status></p>` : '';
    render('Calls', `${filters}<div data-calls-list></div>`, 'calls', {
      eyebrow,
      lede: 'Every recorded call: what it decided and what it proposed.',
      actions: isDemo ? `<a class="btn btn-small btn-ghost" href="${esc(href('sources', 'imports'))}">Import a transcript</a>` : '',
    });
    const list = $('[data-calls-list]', ui.view);
    if (!w.calls.length) {
      list.innerHTML = emptyState('<p>No calls yet. Record your next call to the Zoom cloud; it shows up here about an hour after it ends, with its digest and proposals.</p>');
      return;
    }
    const form = $('[data-calls-filters]', ui.view);
    const status = $('[data-calls-status]', ui.view);
    const field = (n) => form.elements.namedItem(n);
    const apply = () => {
      const f = { team: field('team').value, waiting: field('waiting').checked ? '1' : '', q: field('q').value.trim() };
      const h = href('calls', f);
      if (location.hash !== h) { history.replaceState(null, '', h); current.hash = h; current.query = f; }
      const needle = f.q.toLowerCase();
      const rows = w.calls.filter((c) => (!f.team || c.team === f.team)
        && (!f.waiting || (effectiveProposals(c.id) || { pending: 0 }).pending > 0)
        && (!needle || [c.topic, c.team, c.call_type, ...(c.participants || []), ...(c.external_participants || []), ...(c.tags || [])].join(' ').toLowerCase().includes(needle)));
      if (!rows.length) {
        list.innerHTML = emptyState('<p>No calls match these filters.</p><p><button class="btn btn-small btn-ghost" type="button" data-clear>Clear filters</button></p>');
        $('[data-clear]', list).addEventListener('click', () => {
          field('team').value = '';
          field('waiting').checked = false;
          field('q').value = '';
          apply();
          field('team').focus();
        });
        status.textContent = 'No calls match these filters.';
        return;
      }
      const weeks = new Map();
      for (const c of rows) {
        const k = weekOf(c.date);
        if (!weeks.has(k)) weeks.set(k, []);
        weeks.get(k).push(c);
      }
      list.innerHTML = [...weeks].map(([wk, cs]) => `
        <section class="week" aria-labelledby="wk-${esc(wk)}">
          <h2 class="week-head" id="wk-${esc(wk)}"><span>Week of ${esc(fmtDay(wk))}</span><span class="week-n">${esc(plural(cs.length, 'call'))}</span></h2>
          <ol class="call-list">${cs.map((c) => callRow(c)).join('')}</ol>
        </section>`).join('');
      status.textContent = rows.length === w.calls.length ? '' : `${plural(rows.length, 'call')} shown.`;
    };
    form.addEventListener('input', apply);
    form.addEventListener('submit', (e) => e.preventDefault());
    apply();
  }

  // ================================================================ Call detail (§3.3)
  const CITE_ORDER = ['Topic', 'Decision', 'Agreement', 'Action item', 'Task proposal', 'Open question', 'Key insight'];

  /**
   * Every minute the call record points to, and why. Each kind keeps what the
   * record says there: verbatim quotes, and the digest's own wording, so the
   * cue can mark just the words that became the record.
   */
  function citations(c) {
    const m = new Map();
    const add = (t, kind, quote, says) => {
      if (!t) return;
      const l = m.get(t) || [];
      let x = l.find((y) => y.kind === kind);
      if (!x) { x = { kind, quotes: [], says: [] }; l.push(x); }
      if (quote) x.quotes.push(quote);
      if (says) x.says.push(says);
      m.set(t, l);
    };
    const d = c.digest || {};
    for (const x of d.themes || []) add(x.ts, 'Topic');
    for (const x of d.decisions || []) add(x.ts, 'Decision', null, x.title);
    for (const x of d.agreements || []) add(x.ts, 'Agreement', null, x.text);
    for (const x of d.next_steps || []) add(x.ts, 'Action item', x.quote, x.title);
    for (const p of (c.task_log && c.task_log.proposals) || []) add(p.ts, 'Task proposal', p.quote, p.title);
    for (const x of d.open_questions || []) add(x.ts, 'Open question', null, x.title);
    for (const x of d.key_insights || []) add(x.ts, 'Key insight', null, x.title);
    for (const l of m.values()) l.sort((a, b) => CITE_ORDER.indexOf(a.kind) - CITE_ORDER.indexOf(b.kind));
    return m;
  }

  const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'its', 'our', 'can', 'will', 'from', 'into', 'than', 'then', 'they', 'them', 'have', 'has', 'all', 'one', 'out', 'who', 'what', 'when', 'just', 'we', 'it', 'is', 'on', 'to', 'of', 'in', 'a', 'an', 'so', 'be', 'by', 'or', 'as', 'at']);
  const words = (s) => (String(s).toLowerCase().match(/[a-z0-9$%][a-z0-9$%'-]*/g) || []).filter((w) => !STOP.has(w));

  /**
   * A cited cue with its record marked: the verbatim quote when the cue holds
   * it, else the sentence closest to what the digest says (the hero's
   * "Agreed. <mark>We ship…</mark>"). A cue cited only as a topic start is
   * not marked.
   */
  function markCue(text, cites) {
    const lower = text.toLowerCase();
    for (const q of cites.flatMap((x) => x.quotes)) {
      const i = q ? lower.indexOf(q.toLowerCase()) : -1;
      if (i >= 0) return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
    }
    const says = cites.flatMap((x) => x.says);
    if (!says.length) return esc(text);
    const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) || [text];
    if (sentences.length < 2) return `<mark>${esc(text)}</mark>`;
    const want = new Set(says.flatMap(words));
    let best = -1;
    let score = 0;
    sentences.forEach((sen, i) => {
      const n = words(sen).filter((w) => want.has(w)).length;
      if (n > score) { score = n; best = i; }
    });
    if (best < 0) return `<mark>${esc(text)}</mark>`;
    return sentences.map((sen, i) => {
      if (i !== best) return esc(sen);
      const body = sen.replace(/\s+$/, '');
      return `<mark>${esc(body)}</mark>${esc(sen.slice(body.length))}`;
    }).join('');
  }

  function speakerHtml(name, speakers) {
    const info = speakers.find((x) => x.lastname && x.lastname === name) || speakers.find((x) => x.label === name);
    if (info && info.lastname) return person(info.lastname);
    if (info && info.external) return `${esc(info.label)} <span class="guest">(guest)</span>`;
    return esc(name || 'Unknown speaker');
  }

  function transcriptHtml(c) {
    const t = cached(`transcript:${c.id}`);
    if (!t || !Array.isArray(t.segments) || !t.segments.length) {
      return emptyState('<p>No transcript kept for this call. Transcripts are kept when Sources › Zoom › Keep transcripts is on.</p>');
    }
    const cites = citations(c);
    const speakers = Array.isArray(t.speakers) ? t.speakers : [];
    const rec = c.recording && c.recording.available && /^https:\/\//.test(String(c.recording.url || '')) ? c.recording.url : null;
    const play = (mmss) => (rec ? ` <a class="play" href="${esc(`${rec}#t=${toSeconds(mmss)}`)}" target="_blank" rel="noopener">▶ Play from ${esc(mmss)}</a>` : '');
    const seen = new Map();
    const cues = t.segments.map((s) => {
      const base = `t-${String(s.ts_mmss).replace(':', '-')}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const cs = cites.get(s.ts_mmss);
      const said = cs ? markCue(String(s.text || ''), cs) : esc(s.text);
      const tags = cs ? `<span class="cue-tags">${cs.map((x) => `<span class="cue-tag">${esc(x.kind)}</span>`).join('')}</span>` : '';
      return `<p class="cue${cs ? ' is-cited' : ''}" id="${esc(n > 1 ? `${base}-${n}` : base)}" tabindex="-1" data-ts="${esc(s.ts_mmss)}">`
        + `<a class="tc" href="${esc(href('call', c.id, 'transcript', s.ts_mmss))}" aria-label="Line at ${esc(s.ts_mmss)}">${esc(s.ts_mmss)}</a>`
        + `<span class="who">${speakerHtml(s.speaker, speakers)}</span><span class="said">${said}${tags}${play(s.ts_mmss)}</span></p>`;
    }).join('');
    return `
      <div class="transcript-tools">
        <label class="find"><span class="find-label">Find in transcript</span><input type="search" data-find placeholder="A word or a name" autocomplete="off"></label>
        <p class="find-status small muted" data-find-status role="status"></p>
      </div>
      ${isDemo ? '<p class="small muted transcript-note">Demo transcripts keep only the lines the digest points to. Yours keep the whole call.</p>' : ''}
      <div class="transcript transcript-doc">
        <p class="transcript-head"><span>Transcript</span><span>${c.duration_min ? `${esc(c.duration_min)} min · ` : ''}${esc(plural(t.segments.length, 'line'))}</span></p>
        ${cues}
      </div>`;
  }

  function cueFor(at) {
    const secs = toSeconds(at);
    if (secs === null) return null;
    let best = null;
    const cues = $$('.cue', ui.view);
    for (const p of cues) {
      const s = toSeconds(p.dataset.ts);
      if (s !== null && s <= secs) best = p;
    }
    return best || cues[0] || null;
  }

  function wireTranscript(at) {
    const input = $('[data-find]', ui.view);
    const status = $('[data-find-status]', ui.view);
    const cues = $$('.cue', ui.view);
    if (input) {
      const apply = () => {
        const q = input.value.trim().toLowerCase();
        let n = 0;
        for (const p of cues) {
          const hit = !q || p.textContent.toLowerCase().includes(q);
          p.hidden = !hit;
          if (hit) n++;
        }
        status.textContent = !q ? '' : n ? `${plural(n, 'line')} of ${cues.length} match.` : 'No line matches.';
      };
      input.addEventListener('input', apply);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; apply(); }
      });
    }
    if (at) {
      const t = cueFor(at);
      if (t) {
        t.classList.add('is-target');
        setTimeout(() => t.classList.remove('is-target'), 1300);
      }
    }
  }

  function digestHtml(c) {
    const ctx = { call: c.id };
    const d = c.digest || {};
    const party = (p) => (profiled(p) ? `<a class="chip" href="${esc(href('people', p))}">${esc(p)}</a>` : `<span class="chip">${esc(p)}</span>`);
    const secs = (c.sections || []).map((s, i) => {
      const h = String(s.heading).trim().toLowerCase();
      let inner;
      if (h === 'decisions' && d.decisions && d.decisions.length) {
        inner = `<ol>${d.decisions.map((x) => `<li><strong>${inline(x.title, ctx)}</strong>${x.why ? ` <span class="why">— ${inline(x.why, ctx)}</span>` : ''} ${ts(c.id, x.ts)}</li>`).join('')}</ol>`;
      } else if (h === 'agreements' && d.agreements && d.agreements.length) {
        inner = `<ol>${d.agreements.map((x) => `<li>${x.parties && x.parties.length ? `<span class="parties">${x.parties.map(party).join(' ↔ ')}</span>` : ''}${inline(x.text, ctx)} ${ts(c.id, x.ts)}</li>`).join('')}</ol>`;
      } else {
        inner = md(s.md, ctx) || '<p class="muted">None.</p>';
      }
      return `<section class="digest-section" aria-labelledby="dg-${i}"><h2 id="dg-${i}">${esc(s.heading)}</h2>${inner}</section>`;
    }).join('');
    return `<article class="digest" aria-label="Digest">${secs || '<p class="muted">This call has no digest yet.</p>'}</article>`;
  }

  function outcomeText(p) {
    const r = p.decision || {};
    if (p.status === 'skipped') return `Skipped${r.reason ? ` · ${r.reason}` : ''}`;
    if (r.result === 'created') return r.ref ? `Created ${r.ref}` : 'Created';
    if (r.result === 'commented') return r.ref ? `Commented on ${r.ref}` : 'Commented';
    if (r.result === 'file-only') return 'Kept in the tasks file';
    return 'Approved';
  }

  /** The core's "Task proposals" list, until cabinet-tasks.js sets BB.hooks.callAside. */
  function defaultProposals(c) {
    const e = effectiveProposals(c.id);
    if (!e || !e.proposals.length) return '';
    const rows = e.proposals.map((p) => {
      const st = p.status === 'pending'
        ? (isDemo ? '<span class="chip-mark">Waiting for a decision</span>' : "Waiting for a decision in the call's Slack thread.")
        : `<span class="prop-state-text">${esc(outcomeText(p))}</span>`;
      return `<li>${verdict(p.verdict)}<span>${esc(p.title)}</span><span class="prop-state${p.status === 'approved' ? ' is-done' : ''}">${st}</span></li>`;
    }).join('');
    return `<h2>Task proposals</h2>
      <p class="panel-note">Checked against the Linear backlog before anything was filed.</p>
      <ul class="prop-list">${rows}</ul>
      <p class="panel-foot"><a href="${esc(href('tasks', 'call', c.id))}">Open in Action items</a></p>`;
  }

  function fillProposals(c) {
    const box = $('[data-call-aside]', ui.view);
    if (!box) return;
    if (typeof hooks.callAside === 'function') {
      try {
        box.innerHTML = '';
        box.hidden = false;
        hooks.callAside(c, box);
        return;
      } catch (e) {
        console.error('BB.hooks.callAside failed; the core list is shown instead.', e);
      }
    }
    box.innerHTML = defaultProposals(c);
    box.hidden = !box.innerHTML.trim();
  }

  function asideHtml(c) {
    const items = effectiveActionItems(c.id);
    const groups = [['post-call', 'Post-call'], ['monitoring', 'Monitoring'], ['done-on-call', 'Done on call']].map(([st, label]) => {
      const list = items.filter((a) => a.status === st);
      return list.length ? `<h3>${label}</h3><ul class="item-list">${list.map((a) => `<li>${esc(a.title)}
        <span class="item-meta">${a.owner ? person(a.owner) : '<span>no owner</span>'}${a.ts ? ` ${ts(c.id, a.ts)}` : ''} ${prio(a.priority)} ${ref(a.tracker_ref)}</span></li>`).join('')}</ul>` : '';
    }).join('');
    const refs = c.references || [];
    return `<aside class="call-aside" aria-label="Proposals, action items and earlier calls">
      <section class="panel" id="proposals" tabindex="-1" data-call-aside></section>
      <section class="panel" aria-labelledby="h-items"><h2 id="h-items">Action items</h2>${groups || '<p class="panel-note">No action items on this call.</p>'}</section>
      ${refs.length ? `<section class="panel" aria-labelledby="h-built"><h2 id="h-built">Built on</h2>
        <p class="panel-note">Earlier calls this digest was written with.</p>
        <ul class="link-list">${refs.map((r) => `<li><a href="${esc(href('call', r.id))}">${esc(r.topic)}</a> <span class="mono muted">${esc(fmtDay(String(r.id).slice(0, 10)))}</span></li>`).join('')}</ul></section>` : ''}
    </aside>`;
  }

  function recordingLine(c) {
    const rec = c.recording || {};
    if (!isDemo && rec.available && /^https:\/\//.test(String(rec.url || ''))) {
      return `<a href="${esc(rec.url)}" target="_blank" rel="noopener">▶ Recording</a>`;
    }
    return isDemo ? 'Recording: not in the demo' : 'Recording: not kept';
  }

  function callView(parts) {
    const [id, tab, at] = parts;
    if (!id) { go('#/calls', { replace: true }); return; }
    const c = cached(`call:${id}`);
    const withTranscriptTab = Boolean(API.transcript);
    if (tab && (tab !== 'transcript' || !withTranscriptTab)) { go(href('call', id), { replace: true }); return; }
    const onTranscript = tab === 'transcript';
    const e = effectiveProposals(id);
    const waiting = e ? e.pending : 0;
    const guests = c.external_participants || [];
    const meta = [
      teamChip(c.team),
      `<span class="mono">${esc(fmtDate(c.date, c.time))}</span>`,
      c.duration_min ? `${esc(c.duration_min)} min` : '',
      c.call_type ? esc(c.call_type) : '',
      (c.participants || []).map(person).join(', '),
      guests.length ? `${guests.length > 1 ? 'guests' : 'guest'}: ${guests.map(esc).join(', ')}` : '',
    ].filter(Boolean).join(' · ');
    const info = [
      recordingLine(c),
      c.slack && c.slack.channel ? `Posted in <span class="mono">${esc(c.slack.channel)}</span>${c.slack.posted_at ? ` at <span class="mono">${esc(c.slack.posted_at)}</span>` : ''}` : '',
    ].filter(Boolean).join(' · ');
    const buttons = [
      c.slack ? `<a class="btn btn-small btn-ghost" href="${esc(href('tasks', 'slack', id))}">Preview the Slack post</a>` : '',
      isDemo ? `<a class="btn btn-small btn-ghost" href="${esc(href('memory', { node: c.path }))}">Show the file</a>`
        : safeUrl(c.vault_file_url) ? `<a class="btn btn-small btn-ghost" href="${esc(c.vault_file_url)}" target="_blank" rel="noopener">Open in GitHub</a>` : '',
    ].filter(Boolean).join('');
    const strip = tabs([
      { key: 'digest', href: href('call', id), label: 'Digest' },
      ...(withTranscriptTab ? [{ key: 'transcript', href: href('call', id, 'transcript'), label: 'Transcript' }] : []),
    ], onTranscript ? 'transcript' : 'digest', { label: 'Call views' });
    const html = `
      <div class="call-bar">${strip}<div class="call-links"><p class="call-info">${info}</p>${buttons ? `<p class="call-btns">${buttons}</p>` : ''}</div></div>
      <div class="call-layout">
        <div class="call-main">${onTranscript ? transcriptHtml(c) : digestHtml(c)}</div>
        ${asideHtml(c)}
      </div>`;
    render(c.topic, html, 'calls', {
      eyebrow: '<a href="#/calls">← Calls</a>',
      lede: `${meta}${waiting ? ` <button class="chip-mark jump-proposals" type="button" data-jump="proposals">${esc(waiting)} waiting ↓</button>` : ''}`,
      focus: onTranscript && at ? () => cueFor(at) : null,
      before: () => fillProposals(c),
    });
    if (onTranscript) wireTranscript(at);
    else if (withTranscriptTab && c.transcript && c.transcript.available) load(`transcript:${id}`).catch(() => {});
  }

  const BB = {
    version: 1,
    mode,
    isDemo,
    contact,
    API,
    // helpers
    esc, safeUrl, inline, md, fmtDate, fmtDay, clock, stamp, now, plural, joinAnd, initials, href,
    verdict, prio, ref, teamChip, ts, person, callRow, loading, emptyState, managed, deliveryPhrase, DEMO_NOTE,
    // data
    load, cached, workspace,
    // router
    route, render, go, current: null, setLeaveGuard,
    // demo state
    state, save, reset, changeCount, decide, refresh,
    effectiveProposals, effectiveActionItems, effectiveStats, effectivePeople, effectiveSources, effectiveSlack, waitingCount,
    // UI kit
    toast, dialog, confirm, tabs,
    // hooks and events
    hooks, on,
  };
  Object.defineProperty(BB, 'storage', { get: () => storage, enumerable: true });
  window.BB = BB;

  // Core routes. Modules add 'tasks', 'people', 'memory' and 'sources'.
  route('', overviewView, { nav: 'overview', title: 'Overview', needs: () => (isDemo ? ['workspace', 'people?', 'settings?'] : ['workspace']) });
  route('calls', callsView, { nav: 'calls', title: 'Calls' });
  route('call', callView, {
    nav: 'calls',
    loading: 'call',
    needs: (parts) => (parts[0]
      ? ['workspace', 'people?', ...(isDemo ? ['settings?'] : []), `call:${parts[0]}`, ...(parts[1] === 'transcript' && API.transcript ? [`transcript:${parts[0]}?`] : [])]
      : ['workspace']),
    notFound: () => ({ title: 'Call not found', eyebrow: '<a href="#/calls">← Calls</a>', html: emptyState('<p>This call isn\'t in the workspace.</p><p><a href="#/calls">All calls</a></p>') }),
  });

  async function boot() {
    readStore();
    document.addEventListener('click', onDocClick);
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('beforeunload', (e) => {
      let ask = null;
      try { ask = leaveGuard && current ? leaveGuard(null, current.hash) : null; } catch { ask = null; }
      if (ask) { e.preventDefault(); e.returnValue = ''; }
    });
    window.addEventListener('storage', (e) => {
      if (e.key !== STORE_KEY && e.key !== null) return;
      readStore();
      refresh();
    });
    if (ui.reset) ui.reset.addEventListener('click', onReset);
    try {
      if (API.me) {
        const me = await getJson(API.me);
        if (ui.user) ui.user.textContent = me.email || '';
      }
      await load('workspace');
    } catch (e) {
      if (!e.signedOut) {
        ui.title.textContent = 'Could not load the workspace';
        ui.view.innerHTML = `<p>${esc(e.message)}</p><p>Try again in a minute. If it keeps failing, write to us${contact ? ` at <a href="mailto:${esc(contact)}">${esc(contact)}</a>` : ''}.</p>`;
      }
      return;
    }
    if (ui.wsName) ui.wsName.textContent = displayName();
    booted = true;
    syncChrome();
    run({ initial: true });
  }

  // Deferred scripts run before DOMContentLoaded, so every module has
  // registered its routes by the time the first route runs. 'load' is the
  // fallback if this file ever runs after DOMContentLoaded.
  let started = false;
  const start = () => { if (!started) { started = true; boot(); } };
  if (document.readyState === 'complete') start();
  else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    window.addEventListener('load', start, { once: true });
  }
})();
