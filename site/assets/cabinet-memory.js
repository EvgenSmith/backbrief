// SPDX-License-Identifier: MIT
/*
 * cabinet-memory.js — Company memory (spec §3.9). The page leads with what
 * the memory is for: a question an AI agent answers from the files, quoting
 * the decision with its reason and minute, and citing the file. Then what the
 * repository holds (a tree with plain-English descriptions and who writes
 * each part; a selected call file shows its frontmatter and Decisions
 * section), how one call links up (a clickable chain with an excerpt of each
 * file, the linking lines marked) and, folded away for engineers, how agents
 * find things (AGENTS.md). Reads vault.json (tree, edges, counts, agents),
 * call details and people.json. Styles live in cabinet-people.css. API: the
 * BB block at the top of cabinet.js.
 *
 * Every excerpt is rebuilt here from the JSON the demo already loads,
 * escaped, in the file's own format; no file body is fetched or rendered.
 */
(() => {
  'use strict';
  const BB = window.BB;
  if (!BB) return;
  const { esc, href, plural } = BB;

  const $ = (sel, root = document) => root.querySelector(sel);
  const LEDE = 'Everything Backbrief writes is kept as plain files in your own git repository. Your team reads it here, your AI agents read it directly, and it stays yours if you leave Backbrief.';
  const ws = () => BB.workspace();
  const callOf = (id) => (ws() ? ws().calls.find((c) => c.id === id) : null) || null;
  const company = () => {
    const w = ws();
    return (w && w.workspace.company && w.workspace.company.name) || 'your company';
  };
  const repo = () => {
    const v = BB.cached('vault') || (model && model.v);
    return (v && v.repo) || 'your repository';
  };
  /** Every view of this module renders inside .screen, so its phone rules (tap targets) stay scoped. */
  const show = (title, html, opts) => BB.render(title, `<div class="screen screen-memory" data-memory>${html}</div>`, 'memory', opts);
  const TASKS_DONE = (n) => plural(n, 'approved or skipped task');

  // ------------------------------------------------------------ what each part is
  // The vault's own descriptions are written for engineers; these are for everyone.
  // Team folders keep the vault's `about` (the tenant's team descriptions).
  const WHO = { bb: 'Backbrief', you: 'You', both: 'Backbrief and your team' };
  const KIND = {
    'team-folder': { by: WHO.bb },
    calls: { about: () => 'Call files (digests), one per call, each with its transcript (.vtt).', by: WHO.bb },
    call: { by: WHO.bb },
    tasks: { about: () => "Every proposal and the team's decision, one file per call.", by: WHO.both },
    'tasks-file': { by: WHO.both },
    people: { about: () => 'One profile per person: role, zones and the names people use.', by: WHO.both },
    profile: { by: WHO.both },
    docs: { about: () => 'What Backbrief reads before it writes: your company, your house style and the templates.', by: WHO.both },
    company: { about: () => `What ${company()} does; read before every digest.`, by: WHO.you },
    skills: { about: () => 'Your digest house style: edit it and the next digest follows.', by: WHO.you },
    skill: { about: () => 'Your digest house style: edit it and the next digest follows.', by: WHO.you },
    templates: { about: (n) => `${plural((n.counts && n.counts.templates) || (n.children || []).length, 'template')} your AI agents copy from.`, by: WHO.bb },
    template: { about: () => 'A template your AI agents copy from.', by: WHO.bb },
    doc: { about: () => 'The writing rules every file in the repository follows.', by: WHO.bb },
    training: { about: () => `Every approve, edit and skip, kept in ${repo()} as feedback; your Backbrief team reviews it. Nothing here trains an AI model.`, by: WHO.both },
    'training-log': { about: (n) => `${TASKS_DONE(n.rows || 0)}, one line each. Feedback your Backbrief team reviews; nothing here trains an AI model.`, by: WHO.both },
    agents: { about: () => 'Instructions any AI agent reads first.', by: WHO.bb },
    'tenant.yaml': { about: () => 'Teams, people and connections. No passwords or keys.', by: WHO.both },
  };
  const kindOf = (n) => (n.path === 'tenant.yaml' ? 'tenant.yaml' : n.kind);
  const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
  const HIDDEN = new Set(['readme', 'roadmap', 'transcript', 'machine']);
  const CALL_FILE = 'Call file (digest)';

  // ------------------------------------------------------------ state

  let model = null; // {roots, byPath, parent, vtt, ids} for the loaded vault
  let selected = null;
  const expanded = new Set();
  let chainAt = 0;
  let lastQueryNode = null;
  let engOpen = false; // "For engineers" stays as the person left it across refreshes
  const failed = new Set(); // call details that could not load: say so instead of "Loading…"

  const loadCall = (id) => BB.load(`call:${id}`).catch(() => { failed.add(id); return null; });
  const ensureModel = (v) => { if (!model || model.v !== v) { model = buildModel(v); model.v = v; } };

  // ------------------------------------------------------------ the tree

  function buildModel(v) {
    const top = v.tree || [];
    const machine = top.find((n) => n.kind === 'machine');
    const training = machine && (machine.children || []).find((n) => n.kind === 'training');
    const order = [
      ...top.filter((n) => n.kind === 'team-folder'),
      ...top.filter((n) => n.kind === 'tasks'),
      ...top.filter((n) => n.kind === 'people'),
      ...top.filter((n) => n.kind === 'docs'),
      ...(training ? [{ ...training, name: '.backbrief/training/' }] : []),
      ...top.filter((n) => n.kind === 'agents'),
      ...top.filter((n) => n.path === 'tenant.yaml'),
    ];
    const rest = top.filter((n) => !order.some((o) => o.path === n.path) && n !== machine);
    const vtt = new Map();
    const byPath = new Map();
    const parent = new Map();
    const ids = new Map();
    const clean = (nodes, up) => nodes
      .filter((n) => {
        if (n.kind === 'transcript' && n.call_id) vtt.set(n.call_id, n);
        return !HIDDEN.has(n.kind) && n.name !== '.gitignore';
      })
      .map((n) => {
        const out = { ...n, children: null };
        byPath.set(n.path, out);
        if (up) parent.set(n.path, up);
        ids.set(n.path, ids.size + 1);
        out.children = n.children && n.children.length ? clean(n.children, n.path) : null;
        if (out.children && !out.children.length) out.children = null;
        return out;
      });
    // Hidden folders still hold the .vtt siblings: walk them for the call files' transcripts.
    const walk = (nodes) => { for (const n of nodes || []) { if (n.kind === 'transcript' && n.call_id) vtt.set(n.call_id, n); walk(n.children); } };
    walk(top);
    return { roots: clean([...order, ...rest], null), byPath, parent, vtt, ids };
  }

  function profileName(lastname) {
    const p = BB.effectivePeople().people.find((x) => x.lastname === lastname);
    return p ? `${p.name || p.lastname}${p.role ? ` · ${p.role}` : ''}` : lastname;
  }

  /** The one-line description under a node's name. */
  function aboutShort(n) {
    const k = kindOf(n);
    const c = n.counts || {};
    if (k === 'team-folder') return [cap(n.about), c.calls !== undefined ? plural(c.calls, 'call') : ''].filter(Boolean).join(' · ');
    if (k === 'calls') return `${KIND.calls.about()}${c.calls !== undefined ? ` ${plural(c.calls, 'call')}` : ''}`;
    if (k === 'call') return [n.topic, n.date ? BB.fmtDay(n.date) : ''].filter(Boolean).join(' · ');
    if (k === 'tasks') return `${KIND.tasks.about()}${c.files !== undefined ? ` ${plural(c.files, 'file')}${c.pending ? ` · ${c.pending} waiting` : ''}` : ''}`;
    if (k === 'tasks-file') {
      const call = callOf(n.call_id);
      return [call ? call.topic : '', n.proposals !== undefined ? plural(n.proposals, 'proposal') : '', n.pending ? `${n.pending} waiting` : ''].filter(Boolean).join(' · ');
    }
    if (k === 'people') return `${KIND.people.about()}${c.profiles !== undefined ? ` ${plural(c.profiles, 'profile')}` : ''}`;
    if (k === 'profile') return profileName(n.lastname);
    const m = KIND[k];
    return m && m.about ? m.about(n) : '';
  }

  /** Facts for the detail panel: [label, value] pairs and an onward link. */
  function details(n) {
    const k = kindOf(n);
    const c = n.counts || {};
    const facts = [];
    let about = KIND[k] && KIND[k].about ? KIND[k].about(n) : n.about || '';
    let onward = null;
    const team = String(n.path).split('/')[0];
    if (k === 'team-folder' || k === 'calls') {
      if (k === 'team-folder') about = n.about ? `${cap(n.about)}.` : 'Calls of this team.';
      facts.push(['Holds', [plural(c.calls || 0, 'call file'), plural(c.raw_transcripts || 0, 'transcript')].join(' · ')]);
      if (n.last_call) facts.push(['Last call', BB.fmtDay(n.last_call)]);
      onward = { href: href('calls', { team }), label: `All ${team} calls` };
    } else if (k === 'call') {
      const t = model.vtt.get(n.call_id);
      about = `The digest of ${n.topic || 'this call'}${n.date ? `, ${BB.fmtDay(n.date)}` : ''}: what was decided and why, who owns what next, and links to earlier calls.`;
      facts.push(['Holds', 'Frontmatter and the digest']);
      if (t) facts.push(['Transcript', t.name]);
      if (n.call_id) onward = { href: href('call', n.call_id), label: 'Open the call' };
    } else if (k === 'tasks') {
      facts.push(['Holds', [plural(c.files || 0, 'file'), plural(c.proposals || 0, 'proposal'), `${c.pending || 0} waiting`].join(' · ')]);
      onward = { href: '#/tasks', label: 'Open in Action items' };
    } else if (k === 'tasks-file') {
      const call = callOf(n.call_id);
      about = `Every proposal from ${call ? call.topic : 'one call'} and what the team decided, with links to the issues it filed.`;
      facts.push(['Holds', [plural(n.proposals || 0, 'proposal'), n.pending ? `${n.pending} waiting` : 'all decided'].join(' · ')]);
      if (n.call_id) onward = { href: href('tasks', 'call', n.call_id), label: 'Open its group in Action items' };
    } else if (k === 'people') {
      facts.push(['Holds', plural(c.profiles || 0, 'profile')]);
      onward = { href: '#/people', label: 'Open People' };
    } else if (k === 'profile') {
      about = `The profile of ${profileName(n.lastname)}: role, zones with their evidence, and every name people use.`;
      onward = { href: href('people', n.lastname), label: 'Open profile' };
    } else if (k === 'templates') {
      facts.push(['Holds', plural(c.templates || (n.children || []).length, 'template')]);
    } else if (k === 'training') {
      facts.push(['Holds', TASKS_DONE(c.rows || 0)]);
      onward = { href: '#/tasks/history', label: 'Open Review history' };
    } else if (k === 'training-log') {
      onward = { href: '#/tasks/history', label: 'Open Review history' };
    } else if (k === 'agents') {
      onward = { href: '#memory-agents', label: 'For engineers: how agents find things', jump: true };
    } else if (k === 'tenant.yaml') {
      onward = { href: '#/sources', label: 'Go to Sources' };
    }
    return { about, by: (KIND[k] && KIND[k].by) || WHO.bb, facts, onward, folder: Boolean(n.children), label: k === 'call' ? CALL_FILE : null };
  }

  function rootDetails(v) {
    const c = v.counts || {};
    if (v.partial) {
      return {
        about: `Your calls, tasks files and profiles${v.repo ? ` in ${v.repo}` : ''}${v.windowed ? ', for the latest calls' : ''}. Pick a folder or a file to see what it holds, who writes it and where it leads.`,
        by: WHO.both,
        facts: [['Holds', [plural(c.calls || 0, 'call file'), plural(c.tasks_files || 0, 'tasks file'), plural(c.profiles || 0, 'profile')].join(' · ')]],
        onward: null,
        folder: true,
      };
    }
    return {
      about: 'Everything Backbrief writes, in one repository on GitHub. Pick a folder or a file to see what it holds, who writes it and where it leads.',
      by: WHO.both,
      facts: [['Holds', plural(c.files || 0, 'file')], ['Branch', v.branch || 'main']],
      onward: null,
      folder: true,
    };
  }

  function detailHtml(v, n, inline) {
    const d = n ? details(n) : rootDetails(v);
    const title = n ? (n.name === '.backbrief/training/' ? n.name : n.path) : `${v.repo || 'repository'}`;
    const H = inline ? 'h3' : 'h2';
    const facts = [['Written by', d.by], ...d.facts];
    const kind = n ? d.label || (d.folder ? 'Folder' : 'File') : 'Repository';
    return `<p class="k">${esc(kind)}</p>
      <${H} class="memory-detail-title"${inline ? '' : ' id="h-detail"'}>${esc(title)}</${H}>
      <p class="memory-detail-about">${esc(d.about)}</p>
      <dl class="memory-facts">${facts.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join('')}</dl>
      ${d.onward ? `<p class="memory-onward"><a href="${esc(d.onward.href)}"${d.onward.jump ? ' data-open-eng' : ''}>${esc(d.onward.label)} ${d.onward.jump ? '↓' : '→'}</a></p>` : ''}
      ${v.partial ? githubLink(v, n || { path: '', children: true }) : ''}`;
  }

  function treeHtml(nodes) {
    const v = BB.cached('vault') || model.v;
    return nodes.map((n) => {
      const kids = n.children;
      const open = Boolean(kids) && expanded.has(n.path);
      const sel = selected === n.path;
      const id = `tn-${model.ids.get(n.path)}`;
      return `<li>
        <button class="tree-item" type="button" data-node="${esc(n.path)}"${kids ? ` aria-expanded="${open}" aria-controls="${id}"` : ''}${sel ? ' aria-current="true"' : ''}>
          <span class="tree-name">${esc(n.name)}</span>
          <span class="tree-about">${esc(aboutShort(n))}</span>
        </button>
        ${sel ? `<div class="memory-inline">${detailHtml(v, n, true)}</div>` : ''}
        ${sel && kindOf(n) === 'call' ? fileHtml(n) : ''}
        ${kids ? `<ul id="${id}"${open ? '' : ' hidden'}>${treeHtml(kids)}</ul>` : ''}
      </li>`;
    }).join('');
  }

  function selectFromQuery(path) {
    if (!path) return;
    let p = path;
    if (!model.byPath.has(p)) {
      // A .vtt points at its call file; anything else unknown selects nothing.
      const t = [...model.vtt.values()].find((x) => x.path === p);
      const call = t ? [...model.byPath.values()].find((x) => x.kind === 'call' && x.call_id === t.call_id) : null;
      p = call ? call.path : null;
    }
    if (!p) return;
    selected = p;
    for (let up = model.parent.get(p); up; up = model.parent.get(up)) expanded.add(up);
    if (model.byPath.get(p).children) expanded.add(p);
  }

  /** The call a ?node= path shows (a call file, or its .vtt), so its file can load with the page. */
  function callIdOfPath(path) {
    if (!path || !model) return null;
    const n = model.byPath.get(path);
    if (n) return kindOf(n) === 'call' ? n.call_id || null : null;
    const t = [...model.vtt.values()].find((x) => x.path === path);
    return t ? t.call_id : null;
  }

  // ------------------------------------------------------------ a call file, as it is in the repository

  // An excerpt line: a string, {t, mark}, or an array of those (a line marked in part).
  const seg = (s) => (typeof s === 'string' ? esc(s) : s.mark ? `<mark>${esc(s.t)}</mark>` : esc(s.t));
  const lineHtml = (l) => (Array.isArray(l) ? l.map(seg).join('') : seg(l));
  const yamlScalar = (v) => (/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(v)) ? String(v) : JSON.stringify(String(v)));
  const yamlList = (a) => `[${(a || []).map(yamlScalar).join(', ')}]`;
  const winHtml = (app, path, lines) => `<div class="win">
      <div class="win-bar"><span class="win-app">${esc(app)}</span><span class="win-path">${esc(path)}</span></div>
      <div class="win-body"><pre class="code">${lines.map(lineHtml).join('\n')}</pre></div>
    </div>`;

  /**
   * The call file's frontmatter, in the file's own key order, then its title
   * and Decisions section. `markItem` marks the owner and tracker_ref lines of
   * one action item (the lines a chain link rests on).
   */
  function callFileLines(c, markItem = -1) {
    const L = ['---', `type: ${c.type || 'transcript'}`, `schema_version: ${c.schema_version || 1}`, `team: ${c.team}`, `topic: ${JSON.stringify(String(c.topic || ''))}`, `date: ${c.date}`];
    if (c.time) L.push(`time: ${JSON.stringify(String(c.time))}`);
    if (c.duration_min !== null && c.duration_min !== undefined) L.push(`duration_min: ${c.duration_min}`);
    L.push(`participants: ${yamlList(c.participants)}`);
    for (const k of ['language', 'source', 'digest_version', 'filed_by', 'filer_model', 'pipeline_version', 'source_id', 'platform', 'call_type']) {
      if (c[k]) L.push(`${k}: ${yamlScalar(c[k])}`);
    }
    if (c.tags && c.tags.length) L.push(`tags: ${yamlList(c.tags)}`);
    if (c.external_participants && c.external_participants.length) L.push(`external_participants: ${yamlList(c.external_participants)}`);
    if (c.recording_url) L.push(`recording_url: ${JSON.stringify(String(c.recording_url))}`);
    if (c.transcript_file) L.push(`transcript_file: ${JSON.stringify(String(c.transcript_file))}`);
    const refs = (c.references || []).map((r) => (typeof r === 'string' ? r : r.path)).filter(Boolean);
    if (refs.length) L.push(`references_prior_calls: [${refs.map((p) => JSON.stringify(p)).join(', ')}]`);
    const items = c.action_items || [];
    if (items.length) {
      L.push('action_items:');
      items.forEach((a, i) => {
        const m = i === markItem;
        L.push(`  - title: ${JSON.stringify(String(a.title || ''))}`, { t: `    owner: ${a.owner || 'null'}`, mark: m && Boolean(a.owner) },
          `    helpers: ${yamlList(a.helpers)}`, `    status: ${a.status || 'null'}`, `    priority: ${a.priority || 'null'}`,
          `    ts: ${a.ts ? JSON.stringify(String(a.ts)) : 'null'}`, { t: `    tracker_ref: ${a.tracker_ref || 'null'}`, mark: m && Boolean(a.tracker_ref) });
      });
    }
    L.push('---', '', `# ${c.topic} — ${c.date}`, '', '…');
    const dec = (c.sections || []).find((s) => /^decisions$/i.test(String(s.heading || '').trim()));
    if (dec) L.push('', '## Decisions', '', ...String(dec.md || '').split('\n'), '', '…');
    return L;
  }

  /** What a call file links to: its tasks file, the issues its action items became, and their owners' profiles. */
  function linksOf(c) {
    const tasks = (c.task_log && c.task_log.tasks_path) || (c.tasks && c.tasks.path) || null;
    const items = c.action_items || [];
    const refs = [...new Set(items.map((a) => a.tracker_ref).filter(Boolean))];
    const profiles = [...new Set(items.map((a) => a.owner).filter(Boolean))].map((o) => `team/${o}.md`).filter((p) => model.byPath.has(p));
    return { tasks: tasks && model.byPath.has(tasks) ? tasks : null, refs, profiles };
  }

  /** "Show the file": the selected call file, under its row in the tree. */
  function fileHtml(n) {
    const id = n.call_id;
    const c = id ? BB.cached(`call:${id}`) : null;
    if (!c) {
      const why = !id || failed.has(id) ? "This file couldn't load here. Open the call to read its digest." : 'Loading the file…';
      return `<div class="memory-file"><p class="small muted" role="status">${esc(why)}</p></div>`;
    }
    const l = linksOf(c);
    const parts = [
      l.tasks ? `<a href="${esc(href('memory', { node: l.tasks }))}">tasks file</a>` : '',
      ...l.refs.map((r) => BB.ref(r)),
      ...l.profiles.map((p) => `<a class="mono" href="${esc(href('memory', { node: p }))}">${esc(p)}</a>`),
    ].filter(Boolean);
    return `<figure class="memory-file">
        ${winHtml('GitHub', n.path, callFileLines(c))}
        <figcaption class="memory-file-cap">
          <p class="memory-file-note small muted">The frontmatter and the Decisions section, as they are in ${esc(repo())}.</p>
          ${parts.length ? `<p class="memory-linked"><span class="memory-linked-k">Linked:</span> ${parts.join(' · ')}</p>` : ''}
        </figcaption>
      </figure>`;
  }

  // ------------------------------------------------------------ the chain

  const MARKER = { CREATE: '✏️ CREATE', COMMENT: '💬 COMMENT', FLAG: '⚠️ FLAG', DUPLICATE: '🔁 DUPLICATE' };

  /** The call file → tasks file → issue → owner profile → later call, from vault.json edges. */
  function chainFor(v, callId) {
    const nodes = [...model.byPath.values()];
    const callNode = nodes.find((n) => n.kind === 'call' && n.call_id === callId);
    if (!callNode) return null;
    const cp = callNode.path;
    const E = (v.edges || []).filter((e) => e.call_id === callId || e.to_call_id === callId);
    const toTasks = E.find((e) => e.from === cp && /^same basename/.test(e.via));
    const accepted = toTasks && E.find((e) => e.from === toTasks.to && /^decision: accepted → \[/.test(e.via));
    if (!accepted) return null;
    const ref = accepted.to;
    const refEdge = E.find((e) => e.from === cp && e.to === ref && /^action_items\[\d+\]\.tracker_ref$/.test(e.via));
    const i = refEdge ? Number(refEdge.via.match(/\[(\d+)\]/)[1]) : -1;
    const ownerEdge = i >= 0 && E.find((e) => e.from === cp && e.via === `action_items[${i}].owner = lastname`);
    const rule = E.find((e) => e.rule && e.from === ref && e.to === cp);
    const later = E.find((e) => e.via === 'references_prior_calls' && e.to === cp && e.call_id !== callId);
    if (!ownerEdge || !rule || !later) return null;
    return { callId, callPath: cp, tasksPath: toTasks.to, ref, item: i, profilePath: ownerEdge.to, laterId: later.call_id, laterPath: later.from };
  }

  function pickChain(v) {
    const st = BB.cached('settings');
    const prefer = st && st.slack && st.slack.preview_call_id;
    if (prefer) {
      const c = chainFor(v, prefer);
      if (c) return c;
    }
    for (const c of (ws() ? ws().calls : [])) {
      const x = chainFor(v, c.id);
      if (x) return x;
    }
    return null;
  }

  function excerptFor(ch, at) {
    const c = BB.cached(`call:${ch.callId}`);
    const later = BB.cached(`call:${ch.laterId}`);
    const people = BB.effectivePeople().people;
    const ai = c && (c.action_items || [])[ch.item];
    const owner = ai ? ai.owner : String(ch.profilePath).replace(/^team\/|\.md$/g, '');
    const ts = ai && ai.ts;
    const tlink = ts ? BB.ts(ch.callId, ts) : '';
    if (at === 0) {
      return {
        app: 'GitHub', path: ch.callPath, lines: callFileLines(c, ch.item),
        linked: [['tasks file', 1], [ch.ref, 2], [ch.profilePath, 3]],
        text: `${esc(c.topic)} is a plain file: its frontmatter, then the digest. Its action item names the owner, <span class="mono">owner: ${esc(owner)}</span>, and the issue it became, <span class="mono">${esc(ch.ref)}</span>. Its tasks file has the same file name, ending in <span class="mono">.tasks.md</span>.`,
        onward: { href: href('call', ch.callId), label: 'Open the call' },
      };
    }
    if (at === 1) {
      const t = c.tasks || {};
      const draft = (t.drafts || []).find((x) => x.result_ref === ch.ref || (x.refs || []).includes(ch.ref)) || {};
      const lines = ['---', 'type: tasks', { t: `call: ${JSON.stringify(t.call || ch.callPath)}`, mark: true }, `team: ${t.team || c.team}`, `date: ${t.date || c.date}`,
        `tracker: ${t.tracker || 'linear'}`, '…', '---', '', `# Tasks — ${c.topic} (${c.date})`, '',
        `## ${draft.n || 1}. ${MARKER[draft.verdict] || draft.verdict || ''} — ${draft.title || ''}`,
        `- owner: **${draft.owner || owner}**${draft.owner_team ? ` (${draft.owner_team})` : ''}${draft.priority ? ` · priority: ${draft.priority}` : ''}${draft.ts ? ` · (${draft.ts})` : ''}`];
      if (draft.quote) lines.push(`- quote: ${JSON.stringify(draft.quote)}`);
      if (draft.dedup) lines.push(`- dedup: ${draft.dedup}`);
      lines.push({ t: `- **decision: accepted → ${ch.ref}**`, mark: true }, '', '…');
      return {
        app: 'GitHub', path: ch.tasksPath, lines,
        text: `Every proposal from the call and what the team decided. Its <span class="mono">call:</span> line points back to the call file, and this proposal was accepted and filed as <span class="mono">${esc(ch.ref)}</span>.`,
        onward: { href: href('tasks', 'call', ch.callId), label: 'Open in Action items' },
      };
    }
    if (at === 2) {
      const t = c.tasks || {};
      const draft = (t.drafts || []).find((x) => x.result_ref === ch.ref || (x.refs || []).includes(ch.ref)) || {};
      const lin = BB.effectiveSources().find((s) => s.id === 'linear') || null;
      const teamKey = lin && lin.settings && lin.settings.team_mapping && draft.owner_team ? lin.settings.team_mapping[draft.owner_team] : null;
      const lines = [`${ch.ref} · ${draft.title || (ai && ai.title) || ''}`, '', { t: `Assignee: ${owner}`, mark: true }, 'Label: backbrief'];
      if (teamKey) lines.push(`Team: ${teamKey}`);
      if (draft.priority) lines.push(`Priority: ${draft.priority.charAt(0).toUpperCase()}${draft.priority.slice(1)}`);
      lines.push('', '…', { t: `📎 Source: ${ch.callPath} (${ts})`, mark: true });
      return {
        app: 'Linear', path: `Demo issue · ${ch.ref}`, lines,
        text: `The issue in Linear, assigned to ${esc(owner)}. Its description links back to the call at ${tlink}, so whoever picks it up can hear why.`,
        onward: null,
      };
    }
    if (at === 3) {
      const p = people.find((x) => (x.path || `team/${x.lastname}.md`) === ch.profilePath) || null;
      const lines = ['---', 'type: member', 'schema_version: 1', { t: `lastname: ${p ? p.lastname : owner}`, mark: true }];
      if (p) {
        if (p.first_names && p.first_names.length) lines.push(`first_names: ${yamlList(p.first_names)}`);
        if (p.aliases && p.aliases.length) lines.push('aliases:', ...p.aliases.map((a) => `  - ${yamlScalar(a)}`));
        if (p.role) lines.push(`role: ${JSON.stringify(p.role)}`);
        if (p.team) lines.push(`team: ${p.team}`);
        if (p.zones && p.zones.length) lines.push(`zones: ${yamlList(p.zones)}`);
        if (p.status) lines.push(`status: ${p.status}`);
      }
      lines.push('…', '---');
      return {
        app: 'GitHub', path: ch.profilePath, lines,
        text: `<span class="mono">owner: ${esc(owner)}</span> in the call file is this file's name. That is how digests and tasks know who ${esc(owner)} is, under every name people use for ${esc(p ? (p.first_names || [])[0] || owner : owner)}.`,
        onward: p ? { href: href('people', p.lastname), label: 'Open profile' } : null,
      };
    }
    const refs = (later && later.references) || [];
    const lines = ['---', 'type: transcript', `team: ${later ? later.team : ''}`, `topic: ${JSON.stringify(later ? later.topic : '')}`, `date: ${later ? later.date : ''}`, '…'];
    const parts = ['references_prior_calls: ['];
    refs.forEach((r, i) => {
      if (i) parts.push(', ');
      parts.push(r.path === ch.callPath ? { t: JSON.stringify(r.path), mark: true } : JSON.stringify(r.path));
    });
    parts.push(']');
    lines.push(refs.length ? parts : { t: `references_prior_calls: [${JSON.stringify(ch.callPath)}]`, mark: true }, '…', '---');
    return {
      app: 'GitHub', path: ch.laterPath, lines,
      text: `${esc(later ? later.topic : 'A later call')}${later ? `, ${esc(BB.fmtDay(later.date))},` : ''} was written with this call in mind: it lists the call file under <span class="mono">references_prior_calls</span>.`,
      onward: { href: href('call', ch.laterId), label: 'Open the call' },
    };
  }

  function chainNodes(ch) {
    const c = BB.cached(`call:${ch.callId}`);
    const later = BB.cached(`call:${ch.laterId}`);
    const ai = c && (c.action_items || [])[ch.item];
    const owner = ai ? ai.owner : '';
    const ts = ai ? BB.ts(ch.callId, ai.ts) : '';
    const drafts = (c && c.tasks && c.tasks.drafts) || [];
    return [
      { kind: CALL_FILE, title: c ? c.topic : ch.callPath, via: '<span class="sr-only">Links to </span>02: same file name' },
      { kind: 'Tasks file', title: drafts.length ? `${plural(drafts.length, 'proposal')} and the decisions` : 'Proposals and the decisions', via: `<span class="sr-only">Links to </span>03: accepted → ${esc(ch.ref)}` },
      { kind: 'Linear issue', title: ch.ref, via: `<span class="sr-only">Links to </span>01: its description links back to the call at ${ts}` },
      { kind: 'Profile', title: ch.profilePath, via: `<span class="sr-only">Linked </span>from 01: owner: ${esc(owner)}`, from: true },
      { kind: 'Later call', title: later ? `${later.topic}, ${BB.fmtDay(later.date)}` : ch.laterPath, via: '<span class="sr-only">Links to </span>01: built on' },
    ];
  }

  function chainListHtml(ch) {
    return chainNodes(ch).map((n, i) => `<li>
        <button class="chain-node" type="button" data-chain="${i}" aria-pressed="${i === chainAt}">
          <span class="chain-kind">${esc(n.kind)}</span><span class="chain-title">${esc(n.title)}</span>
        </button>
        <span class="chain-via${n.from ? ' is-from' : ''}">${n.via}</span>
      </li>`).join('');
  }

  function excerptHtml(ch) {
    const x = excerptFor(ch, chainAt);
    const n = chainNodes(ch)[chainAt];
    const linked = x.linked
      ? `<p class="memory-linked"><span class="memory-linked-k">Linked:</span> ${x.linked.map(([label, to]) => `<button class="btn-link" type="button" data-chain-go="${to}">${esc(label)}<span class="sr-only">: link ${String(to + 1).padStart(2, '0')}</span></button>`).join(' · ')}</p>`
      : '';
    return `<figure class="memory-excerpt">
        <div class="memory-excerpt-file">${winHtml(x.app, x.path, x.lines)}${linked}</div>
        <figcaption class="memory-excerpt-cap">
          <p class="k">${String(chainAt + 1).padStart(2, '0')} · ${esc(n.kind)}</p>
          <p>${x.text}</p>
          <p class="memory-excerpt-do">
            ${x.onward ? `<a href="${esc(x.onward.href)}">${esc(x.onward.label)} →</a>` : '<span class="small muted">A demo issue: Linear is not reachable from the demo.</span>'}
            <button class="btn btn-small btn-ghost" type="button" data-chain-next>Next link →</button>
          </p>
        </figcaption>
      </figure>`;
  }

  /** Long excerpts scroll inside their window: bring the first marked line into view. */
  function revealMark(root) {
    const body = root && $('.memory-excerpt .win-body', root);
    if (!body) return;
    const m = $('mark', body);
    if (!m) { body.scrollTop = 0; return; }
    const off = m.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    body.scrollTop = Math.max(0, off - 36);
  }

  // ------------------------------------------------------------ ask the memory

  /** The call the example question answers from: the chain's call, else the Slack preview call, else any call with a decision. */
  function askCallId(ch) {
    if (ch) return ch.callId;
    const st = BB.cached('settings');
    const pref = st && st.slack && st.slack.preview_call_id;
    const calls = ws() ? ws().calls : [];
    if (pref && calls.some((c) => c.id === pref)) return pref;
    const c = calls.find((x) => x.decisions_count > 0);
    return c ? c.id : null;
  }

  function askHtml(c) {
    const decs = (c && c.digest && c.digest.decisions) || [];
    const dec = decs.find((d) => /\$\d/.test(d.title)) || decs[0];
    if (!dec) return '';
    const price = (String(dec.title).match(/\$\d[\d,.]*/) || [])[0] || null;
    const q = price
      ? `Why did we pick ${price}${/self-serve/i.test(dec.title) ? ' for self-serve' : ''}?`
      : `Why did we decide to ${dec.title.charAt(0).toLowerCase()}${dec.title.slice(1)}?`;
    const quote = `${dec.title}${dec.why ? ` — ${dec.why}` : ''}`.replace(/\.?$/, '.');
    // The reasoning behind a price is usually in the Summary: the points that name it, with their minute.
    const themes = (c.digest.themes || []).map((t) => ({ ts: t.ts, points: (t.points || []).filter((p) => price && String(p).includes(price)) })).filter((t) => t.points.length);
    const points = themes.flatMap((t) => t.points).slice(0, 3);
    const reason = points.length
      ? `<p>The Summary of that call gives the reasoning behind the price${themes[0].ts ? ` ${BB.ts(c.id, themes[0].ts)}` : ''}:</p>
         <ul class="ask-points">${points.map((p) => `<li>${BB.inline(p)}</li>`).join('')}</ul>`
      : '';
    const file = href('memory', { node: c.path });
    const term = price ? ` for “${esc(price)}”` : '';
    return `<section class="memory-ask" aria-labelledby="h-ask">
        <h2 class="memory-h" id="h-ask">Ask the memory</h2>
        <p class="memory-sub">Any AI agent your team runs, on Claude or GPT, answers from these files and says where it found the answer.</p>
        <div class="win memory-ask-win">
          <div class="win-bar"><span class="win-app">AI agent</span><span class="win-path">reads ${esc(repo())}</span></div>
          <div class="memory-ask-body">
            <div class="ask-turn ask-q">
              <p class="ask-who">You</p>
              <p class="ask-text">${esc(q)}</p>
            </div>
            <div class="ask-turn ask-a">
              <p class="ask-who">Agent</p>
              <div class="ask-text">
                <p>${esc(c.topic)} decided it on ${esc(BB.fmtDay(c.date))}. From the call file's Decisions section:</p>
                <blockquote class="evidence ask-quote"><p>${BB.inline(quote)}</p><span class="evidence-src">Decisions · ${esc(c.topic)} · ${esc(BB.fmtDay(c.date))} · ${BB.ts(c.id, dec.ts)}</span></blockquote>
                ${reason}
                <p class="ask-src"><span class="ask-src-k">Source</span> <a class="mono" href="${esc(file)}">${esc(c.path)}</a></p>
              </div>
            </div>
          </div>
        </div>
        <p class="memory-ask-how">To answer, the agent read AGENTS.md, searched the call files${term} and read the Decisions section. <a href="#memory-agents" data-open-eng>For engineers: how agents find things ↓</a></p>
      </section>`;
  }

  // ------------------------------------------------------------ for engineers

  function engineersHtml(v) {
    const a = v.agents;
    if (!a) return '';
    const rows = (a.recipes || []).map((r) => `<tr><td>${esc(r.want)}</td><td>${BB.inline(r.do)}</td></tr>`).join('');
    return `<details class="memory-eng" data-eng${engOpen ? ' open' : ''}>
        <summary id="memory-agents">For engineers: how agents find things</summary>
        <div class="memory-eng-body">
          <p class="memory-eng-lede">Any agent your team runs opens ${esc(a.path || 'AGENTS.md')} first. It says what the repository holds and how to find things in it, with plain commands like these.</p>
          <div class="win">
            <div class="win-bar"><span class="win-app">GitHub</span><span class="win-path">${esc(a.path || 'AGENTS.md')}</span></div>
            <div class="win-body memory-agents-body">
              <p class="memory-agents-intro">${esc(a.intro || '')}</p>
              ${rows ? `<p class="memory-agents-h">How to find things</p>
              <table class="memory-recipes"><thead><tr><th scope="col">You want</th><th scope="col">Do</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
            </div>
          </div>
        </div>
      </details>`;
  }

  // ------------------------------------------------------------ the page

  function localChanges() {
    if (!BB.isDemo) return '';
    const decided = BB.effectiveProposals().reduce((n, e) => n + e.proposals.filter((p) => p.by === 'you').length, 0);
    const added = BB.effectivePeople().people.filter((p) => p.added).length;
    const edits = Object.keys(BB.state.zone_reviews || {}).length;
    const parts = [decided && TASKS_DONE(decided), added && plural(added, 'new profile'), edits && plural(edits, 'profile change')].filter(Boolean);
    if (!parts.length) return '';
    return `<p class="memory-local"><span class="memory-local-dot" aria-hidden="true"></span>+${esc(parts.join(', '))} in this browser, not in ${esc(repo())}.</p>`;
  }

  /**
   * /app has no repository map yet (BB.API.vault is null): rebuild the part of
   * the tree the workspace already knows — team folders with their call files,
   * tasks/ and team/ — so the map, its descriptions and onward links still work.
   * How files link up and AGENTS.md need the full map, so they stay out.
   */
  function synthVault() {
    const w = ws();
    if (!w || !w.calls.length) return null;
    const url = BB.safeUrl(w.workspace.vault_url);
    const m = String(url || '').match(/^https:\/\/github\.com\/([^/]+\/[^/?#]+)/);
    const folders = new Map();
    for (const c of w.calls) {
      const segs = String(c.path || '').split('/');
      if (segs.length < 2) continue;
      const team = segs[0];
      const sub = segs.length > 2 ? segs[1] : null;
      if (!folders.has(team)) {
        folders.set(team, { path: `${team}/`, name: `${team}/`, kind: 'team-folder', about: null, counts: { calls: 0, raw_transcripts: 0 }, last_call: null, children: [] });
      }
      const f = folders.get(team);
      let holder = f;
      if (sub) {
        holder = f.children.find((x) => x.name === `${sub}/`);
        if (!holder) { holder = { path: `${team}/${sub}/`, name: `${sub}/`, kind: 'calls', counts: { calls: 0, raw_transcripts: 0 }, last_call: null, children: [] }; f.children.push(holder); }
      }
      for (const x of sub ? [f, holder] : [f]) {
        x.counts.calls++;
        if (c.has_transcript) x.counts.raw_transcripts++;
        if (!x.last_call || c.date > x.last_call) x.last_call = c.date;
      }
      holder.children.push({ path: c.path, name: segs[segs.length - 1], kind: 'call', call_id: c.id, topic: c.topic, date: c.date });
    }
    for (const f of folders.values()) for (const x of [f, ...f.children]) if (x.children) x.children.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const log = (w.task_log || []).filter((e) => e.tasks_path);
    // Team folders alphabetically, the mixed folder (general/) last, as the tenant usually lists them.
    const tree = [...folders.values()].sort((a, b) => (a.name === 'general/') - (b.name === 'general/') || a.name.localeCompare(b.name));
    if (log.length) {
      tree.push({
        path: 'tasks/', name: 'tasks/', kind: 'tasks',
        counts: { files: log.length, proposals: log.reduce((n, e) => n + (e.proposals || []).length, 0), pending: log.reduce((n, e) => n + (e.pending || 0), 0) },
        children: log.map((e) => ({ path: e.tasks_path, name: e.tasks_path.split('/').pop(), kind: 'tasks-file', call_id: e.call_id, proposals: (e.proposals || []).length, pending: e.pending || 0 }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    const people = BB.effectivePeople().people.filter((x) => !x.added && x.path);
    if (people.length) {
      tree.push({ path: 'team/', name: 'team/', kind: 'people', counts: { profiles: people.length }, children: people.map((x) => ({ path: x.path, name: x.path.split('/').pop(), kind: 'profile', lastname: x.lastname })) });
    }
    const decided = log.reduce((n, e) => n + (e.proposals || []).filter((x) => x.status !== 'pending').length, 0);
    return {
      partial: true,
      repo: m ? m[1] : null,
      url,
      branch: null,
      counts: { calls: w.stats.calls_total || w.calls.length, raw_transcripts: w.calls.filter((c) => c.has_transcript).length, tasks_files: log.length, profiles: w.stats.people || people.length, training_rows: decided },
      tree,
      edges: [],
      agents: null,
      windowed: Boolean(w.window && w.window.truncated),
    };
  }

  /** "Open on GitHub" for a node (/app): the folder or file in the repository's default branch. */
  function githubLink(v, n) {
    if (!v.url || !n) return '';
    const p = String(n.path).replace(/\/$/, '').split('/').map(encodeURIComponent).join('/');
    const u = BB.safeUrl(`${v.url}/${n.children ? 'tree' : 'blob'}/HEAD/${p}`);
    return u ? `<p class="memory-onward"><a href="${esc(u)}" target="_blank" rel="noopener">Open on GitHub ↗</a></p>` : '';
  }

  function appView() {
    const w = ws();
    const url = BB.safeUrl(w && w.workspace.vault_url);
    const m = String(url || '').match(/^https:\/\/github\.com\/([^/]+\/[^/?#]+)/);
    const name = m ? m[1] : null;
    const body = w && w.calls.length
      ? `<p>The map of your repository isn't shown in this workspace yet. Every file is in ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name || 'your repository')} on GitHub</a>` : 'your repository'}.</p><p>${BB.managed()}</p>`
      : '<p>Files appear here after your first call.</p>';
    show('Company memory', BB.emptyState(body), {
      eyebrow: name ? esc(`${name} · GitHub`.toUpperCase()) : '',
      lede: esc(LEDE),
    });
  }

  function view(v, query) {
    ensureModel(v);
    // The selection follows the URL (?node=…); clicks keep the URL in step.
    const node = query.node || null;
    const fresh = node !== lastQueryNode;
    if (fresh) { selected = null; selectFromQuery(node); lastQueryNode = node; }
    const c = v.counts || {};
    const counts = [plural(c.calls || 0, 'call file'), plural(c.raw_transcripts || 0, 'transcript'), plural(c.tasks_files || 0, 'tasks file'),
      plural(c.profiles || 0, 'profile'), TASKS_DONE(c.training_rows || 0)].join(' · ');
    const ch = v.partial ? null : pickChain(v);
    const chainReady = ch && BB.cached(`call:${ch.callId}`) && BB.cached(`call:${ch.laterId}`);
    const chainCall = ch ? BB.cached(`call:${ch.callId}`) : null;
    const askId = v.partial ? null : askCallId(ch);
    const askCall = askId ? BB.cached(`call:${askId}`) : null;
    const sel = selected ? model.byPath.get(selected) : null;
    const html = `
      ${askCall ? askHtml(askCall) : ''}
      <div class="memory-layout">
        <section class="panel memory-tree" aria-labelledby="h-inside">
          <div class="panel-head"><h2 id="h-inside">What's inside</h2>${c.files ? `<span class="mono small muted">${esc(plural(c.files, 'file'))}</span>` : ''}</div>
          <ul class="tree" data-tree>${treeHtml(model.roots)}</ul>
        </section>
        <aside class="panel memory-detail" aria-labelledby="h-detail" data-detail>${detailHtml(v, sel, false)}</aside>
      </div>
      ${chainReady ? `<section class="memory-section" aria-labelledby="h-chain">
        <h2 class="memory-h" id="h-chain">How one call links up</h2>
        <p class="memory-sub">${esc(chainCall.topic)}, ${esc(BB.fmtDay(chainCall.date))}. Each file names the next in plain text, so a person or an agent can follow the trail. Pick a link to see the lines that make it.</p>
        <div class="panel memory-chain">
          <ol class="chain" data-chain-list aria-label="Files linked from ${esc(chainCall.topic)}">${chainListHtml(ch)}</ol>
          <div data-excerpt>${excerptHtml(ch)}</div>
          <p class="sr-only" role="status" data-chain-status></p>
        </div>
      </section>` : ''}
      ${engineersHtml(v)}`;
    show('Company memory', html, {
      eyebrow: esc([v.repo || 'repository', v.partial ? '' : v.branch || 'main', 'GitHub'].filter(Boolean).join(' · ').toUpperCase()),
      lede: `<p>${esc(LEDE)}</p><p class="memory-counts">${esc(counts)}</p>${localChanges()}`,
      focus: node && selected ? () => $(`[data-node="${CSS.escape(selected)}"]`) : null,
    });
    wire(v, ch && chainReady ? ch : null);
    revealMark($('[data-excerpt]'));
    // Arriving on a call file ("Show the file"): its row at the top, the file right under it.
    if (fresh && sel && kindOf(sel) === 'call') {
      const b = $(`[data-node="${CSS.escape(selected)}"]`);
      if (b) b.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    ensureFile(v, sel);
  }

  /** A call file picked in the tree whose call isn't loaded yet: load it, then show the file. */
  function ensureFile(v, n) {
    if (!n || kindOf(n) !== 'call' || !n.call_id) return;
    const id = n.call_id;
    if (BB.cached(`call:${id}`) !== undefined || failed.has(id)) return;
    loadCall(id).then(() => {
      const tree = $('[data-tree]');
      if (!tree || selected !== n.path || BB.current.prefix !== 'memory') return;
      const hadFocus = tree.contains(document.activeElement);
      tree.innerHTML = treeHtml(model.roots);
      const again = $(`[data-node="${CSS.escape(n.path)}"]`, tree);
      if (again && hadFocus) again.focus({ preventScroll: true });
    });
  }

  function wire(v, ch) {
    const root = $('[data-memory]');
    const tree = $('[data-tree]');
    const detail = $('[data-detail]');
    const eng = $('[data-eng]');
    if (eng) eng.addEventListener('toggle', () => { engOpen = eng.open; });
    if (root) {
      // Links to "For engineers" open it first; the core then moves focus to its summary.
      root.addEventListener('click', (e) => {
        if (!e.target.closest('[data-open-eng]') || !eng) return;
        eng.open = true;
        engOpen = true;
      });
    }
    if (tree) {
      tree.addEventListener('click', (e) => {
        const b = e.target.closest('[data-node]');
        if (!b) return;
        const path = b.dataset.node;
        const n = model.byPath.get(path);
        if (!n) return;
        if (n.children) { if (expanded.has(path)) expanded.delete(path); else expanded.add(path); }
        selected = path;
        const h = href('memory', { node: path });
        if (location.hash !== h) { history.replaceState(null, '', h); BB.current.hash = h; BB.current.query = { node: path }; }
        lastQueryNode = path;
        tree.innerHTML = treeHtml(model.roots);
        detail.innerHTML = detailHtml(v, n, false);
        const again = $(`[data-node="${CSS.escape(path)}"]`, tree);
        if (again) again.focus();
        ensureFile(v, n);
      });
    }
    if (!ch) return;
    const list = $('[data-chain-list]');
    const box = $('[data-excerpt]');
    const status = $('[data-chain-status]');
    const paint = (focusNext) => {
      list.innerHTML = chainListHtml(ch);
      box.innerHTML = excerptHtml(ch);
      revealMark(box);
      const n = chainNodes(ch)[chainAt];
      status.textContent = `Link ${String(chainAt + 1).padStart(2, '0')} of 05: ${n.kind}, ${n.title}.`;
      const f = focusNext ? $('[data-chain-next]', box) : $(`[data-chain="${chainAt}"]`, list);
      if (f) f.focus();
    };
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-chain]');
      if (!b) return;
      chainAt = Number(b.dataset.chain);
      paint(false);
    });
    box.addEventListener('click', (e) => {
      const go = e.target.closest('[data-chain-go]');
      if (go) { chainAt = Number(go.dataset.chainGo); paint(false); return; }
      if (!e.target.closest('[data-chain-next]')) return;
      chainAt = (chainAt + 1) % 5;
      paint(true);
    });
  }

  BB.route('memory', async (parts, query, ctx) => {
    const v = BB.cached('vault') || (BB.isDemo ? null : synthVault());
    if (!v) { appView(); return; }
    ensureModel(v);
    // Everything the first screen shows loads with the page: the chain's two calls, the
    // call the example question answers from, and a call file picked by ?node=.
    const ch = v.partial ? null : pickChain(v);
    const ids = new Set();
    if (ch) { ids.add(ch.callId); ids.add(ch.laterId); }
    const ask = v.partial ? null : askCallId(ch);
    if (ask) ids.add(ask);
    const picked = callIdOfPath(query.node);
    if (picked) ids.add(picked);
    const missing = [...ids].filter((id) => BB.cached(`call:${id}`) === undefined && !failed.has(id));
    if (missing.length) {
      await Promise.all(missing.map(loadCall));
      if (ctx.stale()) return;
    }
    view(v, query);
  }, { nav: 'memory', title: 'Company memory', needs: ['workspace', 'vault', 'people?', 'settings?'], loading: 'repository map' });

  BB.on('reset', () => { chainAt = 0; });
})();
