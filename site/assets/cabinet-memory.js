// SPDX-License-Identifier: MIT
/*
 * cabinet-memory.js — Company memory (spec §3.9): what the repository holds
 * (a tree with plain-English descriptions and who writes each part), how one
 * call links up (a clickable chain with an excerpt of each file, the linking
 * lines marked), and how AI agents read it (AGENTS.md and an example).
 * Reads vault.json (tree, edges, counts, agents), the chain call's detail and
 * people.json. Styles live in cabinet-people.css. API: the BB block at the
 * top of cabinet.js.
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

  // ------------------------------------------------------------ what each part is
  // The vault's own descriptions are written for engineers; these are for everyone.
  // Team folders keep the vault's `about` (the tenant's team descriptions).
  const WHO = { bb: 'Backbrief', you: 'You', both: 'Backbrief and your team' };
  const KIND = {
    'team-folder': { by: WHO.bb },
    calls: { about: () => 'One file per call: the digest, plus its transcript (.vtt).', by: WHO.bb },
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
    training: { about: () => "Decisions and corrections, kept as your team's training data.", by: WHO.both },
    'training-log': { about: (n) => `${plural(n.rows || 0, 'decision')}, one line each.`, by: WHO.both },
    agents: { about: () => 'Instructions any AI agent reads first.', by: WHO.bb },
    'tenant.yaml': { about: () => 'Teams, people and connections. No passwords or keys.', by: WHO.both },
  };
  const kindOf = (n) => (n.path === 'tenant.yaml' ? 'tenant.yaml' : n.kind);
  const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
  const HIDDEN = new Set(['readme', 'roadmap', 'transcript', 'machine']);

  // ------------------------------------------------------------ the tree

  let model = null; // {roots, byPath, parent, vtt, ids} for the loaded vault
  let selected = null;
  const expanded = new Set();
  let chainAt = 0;
  let lastQueryNode = null;

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
      facts.push(['Holds', [plural(c.calls || 0, 'call'), plural(c.raw_transcripts || 0, 'transcript')].join(' · ')]);
      if (n.last_call) facts.push(['Last call', BB.fmtDay(n.last_call)]);
      onward = { href: href('calls', { team }), label: `All ${team} calls` };
    } else if (k === 'call') {
      const t = model.vtt.get(n.call_id);
      about = `The digest of ${n.topic || 'this call'}${n.date ? `, ${BB.fmtDay(n.date)}` : ''}: what was decided and agreed, who owns what next, and links to earlier calls.`;
      facts.push(['Holds', 'Digest and frontmatter']);
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
      facts.push(['Holds', plural(c.rows || 0, 'logged decision')]);
      onward = { href: '#/tasks/history', label: 'Open Review history' };
    } else if (k === 'training-log') {
      onward = { href: '#/tasks/history', label: 'Open Review history' };
    } else if (k === 'agents') {
      onward = { href: '#memory-agents', label: 'How AI agents read it', jump: true };
    } else if (k === 'tenant.yaml') {
      onward = { href: '#/sources', label: 'Go to Sources' };
    }
    return { about, by: (KIND[k] && KIND[k].by) || WHO.bb, facts, onward, folder: Boolean(n.children) };
  }

  function rootDetails(v) {
    const c = v.counts || {};
    if (v.partial) {
      return {
        about: `Your calls, tasks files and profiles${v.repo ? ` in ${v.repo}` : ''}${v.windowed ? ', for the latest calls' : ''}. Pick a folder or a file to see what it holds, who writes it and where it leads.`,
        by: WHO.both,
        facts: [['Holds', [plural(c.calls || 0, 'call'), plural(c.tasks_files || 0, 'tasks file'), plural(c.profiles || 0, 'profile')].join(' · ')]],
        onward: null,
        folder: true,
      };
    }
    return {
      about: `Everything Backbrief writes, in one repository on GitHub. Pick a folder or a file to see what it holds, who writes it and where it leads.`,
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
    return `<p class="k">${n ? (d.folder ? 'Folder' : 'File') : 'Repository'}</p>
      <${H} class="memory-detail-title"${inline ? '' : ' id="h-detail"'}>${esc(title)}</${H}>
      <p class="memory-detail-about">${esc(d.about)}</p>
      <dl class="memory-facts">${facts.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join('')}</dl>
      ${d.onward ? `<p class="memory-onward"><a href="${esc(d.onward.href)}">${esc(d.onward.label)} ${d.onward.jump ? '↓' : '→'}</a></p>` : ''}
      ${v.partial ? githubLink(v, n || { path: '', children: true }) : ''}`;
  }

  function treeHtml(nodes) {
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
        ${sel ? `<div class="memory-inline">${detailHtml(BB.cached('vault'), n, true)}</div>` : ''}
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

  // An excerpt line: a string, {t, mark}, or an array of those (a line marked in part).
  const seg = (s) => (typeof s === 'string' ? esc(s) : s.mark ? `<mark>${esc(s.t)}</mark>` : esc(s.t));
  const lineHtml = (l) => (Array.isArray(l) ? l.map(seg).join('') : seg(l));
  const yamlScalar = (v) => (/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(v)) ? String(v) : JSON.stringify(String(v)));
  const yamlList = (a) => `[${(a || []).map(yamlScalar).join(', ')}]`;

  function excerptFor(ch, at) {
    const c = BB.cached(`call:${ch.callId}`);
    const later = BB.cached(`call:${ch.laterId}`);
    const people = BB.effectivePeople().people;
    const ai = c && (c.action_items || [])[ch.item];
    const owner = ai ? ai.owner : String(ch.profilePath).replace(/^team\/|\.md$/g, '');
    const ts = ai && ai.ts;
    const tlink = ts ? BB.ts(ch.callId, ts) : '';
    if (at === 0) {
      const lines = ['---', 'type: transcript', `team: ${c.team}`, `topic: ${JSON.stringify(c.topic)}`, `date: ${c.date}`, `time: "${c.time}"`,
        `participants: ${yamlList(c.participants)}`, '…', 'action_items:'];
      (c.action_items || []).slice(0, ch.item).forEach(() => lines.push('  - …'));
      lines.push(`  - title: ${JSON.stringify(ai.title)}`, { t: `    owner: ${ai.owner}`, mark: true }, `    helpers: ${yamlList(ai.helpers)}`,
        `    status: ${ai.status}`, `    priority: ${ai.priority}`, `    ts: "${ai.ts}"`, { t: `    tracker_ref: ${ai.tracker_ref}`, mark: true });
      if ((c.action_items || []).length > ch.item + 1) lines.push('  - …');
      lines.push('---', '', `# ${c.topic} — ${c.date}`, '…');
      return {
        app: 'GitHub', path: ch.callPath, lines,
        text: `${esc(c.topic)} is a plain file. Its action item names the owner, <span class="mono">owner: ${esc(owner)}</span>, and the issue it became, <span class="mono">${esc(ch.ref)}</span>. Its tasks file has the same file name, ending in <span class="mono">.tasks.md</span>.`,
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
      const st = BB.cached('settings');
      const lin = st && st.sources ? st.sources.find((s) => s.id === 'linear') : null;
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
      { kind: 'Call file', title: c ? c.topic : ch.callPath, via: '<span class="sr-only">Links to </span>02: same file name' },
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
    return `<figure class="memory-excerpt">
        <div class="win">
          <div class="win-bar"><span class="win-app">${esc(x.app)}</span><span class="win-path">${esc(x.path)}</span></div>
          <div class="win-body"><pre class="code">${x.lines.map(lineHtml).join('\n')}</pre></div>
        </div>
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

  // ------------------------------------------------------------ AI agents

  function agentsHtml(v, ch) {
    const a = v.agents;
    if (!a) return '';
    const rows = (a.recipes || []).map((r) => `<tr><td>${esc(r.want)}</td><td>${BB.inline(r.do)}</td></tr>`).join('');
    const c = ch ? BB.cached(`call:${ch.callId}`) : null;
    const dec = c && c.digest && (c.digest.decisions || [])[0];
    let example = '';
    if (c && dec) {
      const file = `<a href="${esc(href('memory', { node: c.path }))}">a link to the file</a>`;
      example = /\$19\b/.test(dec.title)
        ? `Asked “Why did we pick $19 for self-serve?”, an agent on Claude or GPT reads AGENTS.md, searches the call files and answers from the Decisions section of ${esc(c.topic)} (${esc(BB.fmtDay(c.date))}, ${BB.ts(c.id, dec.ts)}), with ${file}.`
        : `Asked why the team decided “${esc(dec.title)}”, an agent on Claude or GPT reads AGENTS.md, searches the call files and answers from the Decisions section of ${esc(c.topic)} (${esc(BB.fmtDay(c.date))}, ${BB.ts(c.id, dec.ts)}), with ${file}.`;
    }
    return `<section class="memory-section" id="memory-agents" tabindex="-1" aria-labelledby="h-agents">
      <h2 class="memory-h" id="h-agents">How AI agents read it</h2>
      <p class="memory-sub">Any agent your team runs, on Claude or GPT, opens ${esc(a.path || 'AGENTS.md')} first. It says what the repository holds and how to find things in it.</p>
      <div class="memory-agents">
        <div class="win">
          <div class="win-bar"><span class="win-app">GitHub</span><span class="win-path">${esc(a.path || 'AGENTS.md')}</span></div>
          <div class="win-body memory-agents-body">
            <p class="memory-agents-intro">${esc(a.intro || '')}</p>
            ${rows ? `<p class="memory-agents-h">How to find things</p>
            <table class="memory-recipes"><thead><tr><th scope="col">You want</th><th scope="col">Do</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
          </div>
        </div>
        ${example ? `<div class="panel memory-example"><p class="k">Example</p><p>${example}</p></div>` : ''}
      </div>
    </section>`;
  }

  // ------------------------------------------------------------ the page

  function localChanges() {
    if (!BB.isDemo) return '';
    const decided = BB.effectiveProposals().reduce((n, e) => n + e.proposals.filter((p) => p.by === 'you').length, 0);
    const added = BB.effectivePeople().people.filter((p) => p.added).length;
    const edits = Object.keys(BB.state.zone_reviews || {}).length;
    const parts = [decided && plural(decided, 'decision'), added && plural(added, 'new profile'), edits && plural(edits, 'profile change')].filter(Boolean);
    if (!parts.length) return '';
    return `<p class="memory-local"><span class="memory-local-dot" aria-hidden="true"></span>+${esc(BB.joinAnd(parts))} in this browser, not in ${esc(BB.cached('vault').repo || 'the repository')}.</p>`;
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
    const repo = m ? m[1] : null;
    const body = w && w.calls.length
      ? `<p>The map of your repository isn't shown in this workspace yet. Every file is in ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(repo || 'your repository')} on GitHub</a>` : 'your repository'}.</p><p>${BB.managed()}</p>`
      : '<p>Files appear here after your first call.</p>';
    BB.render('Company memory', BB.emptyState(body), 'memory', {
      eyebrow: repo ? esc(`${repo} · GitHub`.toUpperCase()) : '',
      lede: esc(LEDE),
    });
  }

  function view(v, query) {
    if (!model || model.v !== v) { model = buildModel(v); model.v = v; }
    // The selection follows the URL (?node=…); clicks keep the URL in step.
    const node = query.node || null;
    if (node !== lastQueryNode) { selected = null; selectFromQuery(node); lastQueryNode = node; }
    const c = v.counts || {};
    const counts = [plural(c.calls || 0, 'call'), plural(c.raw_transcripts || 0, 'transcript'), plural(c.tasks_files || 0, 'tasks file'),
      plural(c.profiles || 0, 'profile'), plural(c.training_rows || 0, 'logged decision')].join(' · ');
    const ch = v.partial ? null : pickChain(v);
    const chainReady = ch && BB.cached(`call:${ch.callId}`) && BB.cached(`call:${ch.laterId}`);
    const chainCall = ch ? BB.cached(`call:${ch.callId}`) : null;
    const sel = selected ? model.byPath.get(selected) : null;
    const html = `
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
      ${agentsHtml(v, chainReady ? ch : null)}`;
    BB.render('Company memory', html, 'memory', {
      eyebrow: esc([v.repo || 'repository', v.partial ? '' : v.branch || 'main', 'GitHub'].filter(Boolean).join(' · ').toUpperCase()),
      lede: `<p>${esc(LEDE)}</p><p class="memory-counts">${esc(counts)}</p>${localChanges()}`,
      focus: node && selected ? () => $(`[data-node="${CSS.escape(selected)}"]`) : null,
    });
    wire(v, ch && chainReady ? ch : null);
  }

  function wire(v, ch) {
    const tree = $('[data-tree]');
    const detail = $('[data-detail]');
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
      });
    }
    if (!ch) return;
    const list = $('[data-chain-list]');
    const box = $('[data-excerpt]');
    const status = $('[data-chain-status]');
    const paint = (focusNext) => {
      list.innerHTML = chainListHtml(ch);
      box.innerHTML = excerptHtml(ch);
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
      if (!e.target.closest('[data-chain-next]')) return;
      chainAt = (chainAt + 1) % 5;
      paint(true);
    });
  }

  BB.route('memory', async (parts, query, ctx) => {
    const v = BB.cached('vault') || (BB.isDemo ? null : synthVault());
    if (!v) { appView(); return; }
    if (!model || model.v !== v) { model = buildModel(v); model.v = v; }
    const ch = v.partial ? null : pickChain(v);
    if (ch) {
      const missing = [ch.callId, ch.laterId].filter((id) => BB.cached(`call:${id}`) === undefined);
      if (missing.length) {
        await Promise.all(missing.map((id) => BB.load(`call:${id}`).catch(() => null)));
        if (ctx.stale()) return;
      }
    }
    view(v, query);
  }, { nav: 'memory', title: 'Company memory', needs: ['workspace', 'vault', 'people?', 'settings?'], loading: 'repository map' });

  BB.on('reset', () => { chainAt = 0; });
})();
