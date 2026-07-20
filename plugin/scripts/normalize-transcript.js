#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * normalize-transcript.js — Backbrief A1/A3/B7: detect the transcript format
 * (.vtt / Zoom export / Fireflies export / .txt / .md) and emit normalized
 * segments JSON.
 *
 * Kit script conventions (02 §3): Node >= 18, zero npm dependencies, `--help`,
 * exit codes: 0 ok / 1 check failed / 2 operational error. This script only
 * reads — DRY_RUN is a no-op.
 *
 * Output (stdout, JSON):
 *   {
 *     format:            "vtt" | "zoom-txt" | "sbv" | "fireflies" |
 *                        "timestamped-txt" | "meet-docs" | "dialogue" | "md",
 *     source_guess:      "zoom" | "meet" | "fireflies" | "manual" | "other",
 *     detected_language: "en" | "ru" | ...   (best effort, ISO 639-1)
 *     title:             string | null       (inferred, never guessed hard)
 *     date:              "YYYY-MM-DD" | null (content first; else the Zoom
 *                        "GMT<YYYYMMDD>-<HHMMSS>_*" filename prefix)
 *     time_utc:          "HH:MM" | null      (from the GMT filename prefix
 *                        ONLY — Zoom names files in UTC, not local time)
 *     duration_min:      int | null
 *     timing:            true | false        (false => no per-segment anchors)
 *     segments:          [{speaker, ts_mmss, text}]   (ts_mmss "MM:SS" or null)
 *   }
 *
 * NONZERO EXIT = LLM FALLBACK SIGNAL: exit 1 means "format not recognized —
 * the agent may parse by reading, and must SAY it is doing so" (01 §1.6).
 * EXCEPTION: binary input (NUL bytes / mostly non-printable) exits 2 — an LLM
 * parse of junk bytes is nonsense, so it is NOT the fallback signal.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HELP = `normalize-transcript.js — transcript format detect + normalized segments JSON (A1/A3/B7)

Usage:
  node normalize-transcript.js <file>       parse a transcript file
  node normalize-transcript.js -            read the transcript from stdin (pasted text)
  node normalize-transcript.js --selftest   run the built-in self-test (inline fixtures)

Recognized formats (detection order):
  md               a .md file — frontmatter (if any) is read for title/date, body re-detected
  vtt              WebVTT (Zoom "Audio Transcript" .vtt and compatible)
  zoom-txt         VTT-shaped cue blocks without the WEBVTT header (Zoom .txt export)
  sbv              Google Meet .sbv captions ("H:MM:SS.mmm,H:MM:SS.mmm" pair line, then text)
  fireflies        "Speaker Name (MM:SS):" blocks (Fireflies/Otter-style export)
  timestamped-txt  "HH:MM:SS Speaker: text" / "[MM:SS] Speaker: text" lines
  meet-docs        Google Meet Docs export — timestamp on its OWN line, then "Speaker: text" lines
  dialogue         "Speaker: text" lines, no timestamps (timing: false)

Filename fallback:
  a Zoom download name "GMT<YYYYMMDD>-<HHMMSS>_*" fills date + time_utc when
  the content yields no date (the GMT prefix is UTC wall-clock, not local time)

Options:
  -h, --help    this text

Exit codes:
  0  parsed — JSON on stdout
  1  format not recognized (or no usable segments) — the caller falls back to
     LLM parsing and announces it
  2  operational error (file missing/unreadable/empty, or binary input — never
     LLM-fallback territory)`;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const MAX_MERGED_CHARS = 600; // merge consecutive same-speaker cues up to this

function toMmss(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// "HH:MM:SS.mmm" | "MM:SS.mmm" | "HH:MM:SS" | "MM:SS" -> seconds (or null)
function clockToSeconds(str) {
  const m = String(str).trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] !== undefined ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  if (sec > 59) return null;
  return h * 3600 + min * 60 + sec;
}

function detectLanguage(text) {
  const cyr = (text.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  if (cyr + lat === 0) return 'en';
  return cyr / (cyr + lat) > 0.25 ? 'ru' : 'en';
}

// Merge consecutive segments from the same speaker (keeps the first anchor).
function mergeSegments(segments) {
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === seg.speaker
        && (last.text.length + seg.text.length) <= MAX_MERGED_CHARS) {
      last.text += ` ${seg.text}`;
      if (seg.end_s !== undefined) last.end_s = seg.end_s;
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

function findDate(text) {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];
  m = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) {
    const monthIdx = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3)));
    if (monthIdx >= 0) {
      return `${m[3]}-${String(monthIdx + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Format parsers — each returns { segments, timing } or null           */
/* Segments carry start_s/end_s (seconds) internally; ts_mmss rendered  */
/* at output time.                                                      */
/* ------------------------------------------------------------------ */

// VTT-style cue blocks: [optional id line] / timeline "a --> b" / text lines.
function parseCues(lines) {
  const segments = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '' || line === 'WEBVTT' || line.startsWith('WEBVTT ')
        || line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
      i++;
      continue;
    }
    let timelineIdx = -1;
    if (line.includes('-->')) timelineIdx = i;
    else if (lines[i + 1] && lines[i + 1].includes('-->')) timelineIdx = i + 1; // cue id line
    if (timelineIdx < 0) { i++; continue; }
    const tm = lines[timelineIdx].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!tm) { i = timelineIdx + 1; continue; }
    const start = clockToSeconds(tm[1]);
    const end = clockToSeconds(tm[2]);
    i = timelineIdx + 1;
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i].trim());
      i++;
    }
    if (!textLines.length || start === null) continue;
    let speaker = null;
    let text = textLines.join(' ');
    const voice = text.match(/^<v\s+([^>]+)>\s*(.*?)(?:<\/v>)?$/);
    if (voice) { speaker = voice[1].trim(); text = voice[2].trim(); }
    else {
      const colon = text.match(/^([^:]{1,60}):\s+(.*)$/);
      if (colon && !/^\d+$/.test(colon[1].trim())) {
        speaker = colon[1].trim();
        text = colon[2].trim();
      }
    }
    text = text.replace(/<[^>]+>/g, '').trim(); // strip remaining cue markup
    if (text) segments.push({ speaker, start_s: start, end_s: end, text });
  }
  return segments.length ? { segments, timing: true } : null;
}

// Google Meet .sbv captions (SubViewer): a start,end pair line
// "H:MM:SS.mmm,H:MM:SS.mmm", then caption text lines, blank line between cues.
const SBV_PAIR = /^(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*,\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})$/;

function parseSbv(lines) {
  const segments = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].trim().match(SBV_PAIR);
    if (!m) { i++; continue; }
    const start = clockToSeconds(m[1]);
    const end = clockToSeconds(m[2]);
    i++;
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '' && !SBV_PAIR.test(lines[i].trim())) {
      textLines.push(lines[i].trim());
      i++;
    }
    if (!textLines.length || start === null) continue;
    let speaker = null;
    let text = textLines.join(' ');
    const colon = text.match(/^([^:]{1,60}):\s+(.*)$/);
    if (colon && !/^\d+$/.test(colon[1].trim())) {
      speaker = colon[1].trim();
      text = colon[2].trim();
    }
    if (text) segments.push({ speaker, start_s: start, end_s: end, text });
  }
  return segments.length ? { segments, timing: true } : null;
}

// Fireflies-style blocks: "Speaker Name (12:34):" then text lines.
const FIREFLIES_HEAD = /^(.{1,60}?)\s*\(((?:\d{1,2}:)?\d{1,3}:\d{2})\)\s*:?\s*(.*)$/;

function parseFireflies(lines) {
  const segments = [];
  let current = null;
  let headers = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(FIREFLIES_HEAD);
    if (m && clockToSeconds(m[2]) !== null && !/https?:\/\//.test(m[1])) {
      headers++;
      if (current && current.text) segments.push(current);
      current = { speaker: m[1].trim(), start_s: clockToSeconds(m[2]), text: (m[3] || '').trim() };
      continue;
    }
    if (current) current.text = current.text ? `${current.text} ${line}` : line;
  }
  if (current && current.text) segments.push(current);
  if (headers < 3 || !segments.length) return null;
  return { segments, timing: true };
}

// "00:01:23 Speaker Name: text" / "[12:03] Speaker: text" lines.
const TS_LINE = /^\[?((?:\d{1,2}:)?\d{1,3}:\d{2})\]?\s+([^:]{1,60}):\s+(.+)$/;

function parseTimestampedLines(lines) {
  const segments = [];
  let hits = 0;
  let nonEmpty = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    nonEmpty++;
    const m = line.match(TS_LINE);
    if (m && clockToSeconds(m[1]) !== null) {
      hits++;
      segments.push({ speaker: m[2].trim(), start_s: clockToSeconds(m[1]), text: m[3].trim() });
    } else if (segments.length) {
      segments[segments.length - 1].text += ` ${line}`; // continuation line
    }
  }
  if (!segments.length || hits < 3 || hits / nonEmpty < 0.2) return null;
  return { segments, timing: true };
}

// Plain "Speaker: text" dialogue with no timestamps.
const DIALOGUE_LINE = /^([A-Za-zЀ-ӿ][\w'Ѐ-ӿ.-]*(?:\s+[\w'Ѐ-ӿ.-]+){0,3}):\s+(.+)$/;

// Google Meet Docs-export shape: the timestamp sits on its OWN line
// ("00:02:10"), and the "Speaker: text" lines after it inherit it as their
// anchor until the next timestamp line.
const MEET_TS_LINE = /^(\d{1,2}:\d{2}:\d{2})$/;

function parseMeetDocs(lines) {
  const segments = [];
  let currentTs = null;
  let tsLines = 0;
  let hits = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const ts = line.match(MEET_TS_LINE);
    if (ts && clockToSeconds(ts[1]) !== null) {
      tsLines++;
      currentTs = clockToSeconds(ts[1]);
      continue; // timing anchor — never text debris
    }
    const m = line.match(DIALOGUE_LINE);
    if (m && !/^(https?|note|warning)$/i.test(m[1])) {
      hits++;
      segments.push({ speaker: m[1].trim(), start_s: currentTs, text: m[2].trim() });
    } else if (segments.length) {
      segments[segments.length - 1].text += ` ${line}`;
    }
  }
  if (tsLines < 2 || hits < 3 || !segments.length) return null;
  return { segments, timing: true };
}

function parseDialogue(lines) {
  const segments = [];
  let hits = 0;
  let nonEmpty = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // A lone Meet-style clock line is never dialogue text — skip it instead
    // of gluing timing debris onto the previous segment.
    if (MEET_TS_LINE.test(line)) continue;
    nonEmpty++;
    const m = line.match(DIALOGUE_LINE);
    if (m && !/^(https?|note|warning)$/i.test(m[1])) {
      hits++;
      segments.push({ speaker: m[1].trim(), start_s: null, text: m[2].trim() });
    } else if (segments.length) {
      segments[segments.length - 1].text += ` ${line}`;
    }
  }
  if (!segments.length || hits < 3 || hits / nonEmpty < 0.3) return null;
  return { segments, timing: false };
}

/* ------------------------------------------------------------------ */
/* Markdown frontmatter (title/date salvage for .md inputs)            */
/* ------------------------------------------------------------------ */

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const head = text.slice(3, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const meta = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.+?)\s*$/);
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body };
}

/* ------------------------------------------------------------------ */
/* Detection cascade                                                   */
/* ------------------------------------------------------------------ */

function detect(text, ext) {
  const lines = text.split(/\r?\n/);
  const isVttHeader = /^﻿?WEBVTT/.test(text);

  if (isVttHeader || ext === '.vtt') {
    const parsed = parseCues(lines);
    if (parsed) return { format: 'vtt', source_guess: 'zoom', ...parsed };
  }
  // Zoom .txt export: VTT-shaped cue blocks, no WEBVTT header.
  if (text.includes('-->')) {
    const parsed = parseCues(lines);
    if (parsed) return { format: 'zoom-txt', source_guess: 'zoom', ...parsed };
  }
  // Google Meet .sbv captions: no header line — key on the extension or a
  // "start,end" pair among the first non-empty lines.
  const head = lines.map((l) => l.trim()).filter(Boolean).slice(0, 3);
  if (ext === '.sbv' || head.some((l) => SBV_PAIR.test(l))) {
    const sbv = parseSbv(lines);
    if (sbv) return { format: 'sbv', source_guess: 'meet', ...sbv };
  }
  const ff = parseFireflies(lines);
  if (ff) {
    const branded = /fireflies/i.test(text.slice(0, 2000));
    return { format: 'fireflies', source_guess: branded ? 'fireflies' : 'other', ...ff };
  }
  const tsl = parseTimestampedLines(lines);
  if (tsl) return { format: 'timestamped-txt', source_guess: 'other', ...tsl };
  // Meet Docs export must run BEFORE plain dialogue: dialogue matches the
  // speaker lines but degrades to timing:false and used to glue the bare
  // timestamp lines onto the previous segment's text.
  const meet = parseMeetDocs(lines);
  if (meet) return { format: 'meet-docs', source_guess: 'meet', ...meet };
  const dlg = parseDialogue(lines);
  if (dlg) return { format: 'dialogue', source_guess: 'manual', ...dlg };
  return null;
}

function inferTitle(text, parsed) {
  // First non-empty line before any segment content, if it is not itself a
  // cue/speaker/timeline line and looks like a heading. Never guess hard.
  for (const raw of text.split(/\r?\n/).slice(0, 8)) {
    const line = raw.trim().replace(/^#+\s*/, '');
    if (!line) continue;
    if (/^WEBVTT/.test(line) || line.includes('-->') || /^\d+$/.test(line)) return null;
    if (MEET_TS_LINE.test(line) || SBV_PAIR.test(line)) return null; // timing lines are never a title
    if (FIREFLIES_HEAD.test(line) || TS_LINE.test(line) || DIALOGUE_LINE.test(line)) return null;
    if (line.length > 120) return null;
    return line;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Filename fallback + binary sniff                                    */
/* ------------------------------------------------------------------ */

// Zoom's standard download filename encodes the recording datetime:
// "GMT20260716-140002_Meeting Topic.vtt". Deterministic date/time fallback
// when the content itself yields no date. The GMT prefix is UTC wall-clock
// (Zoom names files in GMT, not the host's local time) — hence time_utc.
function parseGmtFilename(name) {
  const m = path.basename(String(name))
    .match(/^GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:[_.\s-]|$)/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) return null;
  return { date: `${y}-${mo}-${d}`, time_utc: `${h}:${mi}` };
}

// Cheap binary sniff: NUL bytes anywhere, or a high ratio of non-printable /
// U+FFFD replacement characters in the head. Binary input is an operational
// error (exit 2), never the exit-1 LLM-fallback signal — an LLM parse of junk
// bytes is nonsense.
function looksBinary(text) {
  const s = String(text);
  if (s.includes('\u0000')) return true;
  const sample = s.slice(0, 4096);
  let bad = 0;
  let total = 0;
  for (const ch of sample) {
    total++;
    const c = ch.codePointAt(0);
    if (c === 0xFFFD || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  return total > 0 && bad / total > 0.1;
}

/* ------------------------------------------------------------------ */
/* Core — pure(ish) normalize, shared by the CLI and the selftest      */
/* ------------------------------------------------------------------ */

// Returns { code: 0, out } on success, { code: 1|2, message } otherwise —
// mirrors the CLI exit-code contract exactly.
function run(text, ext, filename) {
  if (!String(text).trim()) return { code: 2, message: 'input is empty' };
  if (looksBinary(text)) {
    return { code: 2, message: 'input looks binary (NUL bytes / mostly non-printable) — ' +
      'not a transcript; nothing to parse (this is NOT LLM-fallback territory)' };
  }

  let meta = {};
  let body = text;
  let mdWrapped = false;
  if (ext === '.md' || text.startsWith('---')) {
    const split = splitFrontmatter(text);
    if (Object.keys(split.meta).length) { meta = split.meta; body = split.body; mdWrapped = true; }
  }

  const parsed = detect(body, ext);
  if (!parsed) {
    return { code: 1, message: 'format not recognized (not vtt / zoom-txt / sbv / fireflies / ' +
      'timestamped / meet-docs / dialogue) — fall back to LLM parsing and say so' };
  }

  const merged = mergeSegments(parsed.segments);
  const segments = merged.map((s) => ({
    speaker: s.speaker || null,
    ts_mmss: parsed.timing && s.start_s !== null && s.start_s !== undefined ? toMmss(s.start_s) : null,
    text: s.text,
  }));

  let durationMin = null;
  if (parsed.timing) {
    const last = merged[merged.length - 1];
    const endS = last.end_s !== undefined && last.end_s !== null ? last.end_s : last.start_s;
    if (endS) durationMin = Math.max(1, Math.ceil(endS / 60));
  }
  if (meta.duration_min && /^\d+$/.test(meta.duration_min)) durationMin = parseInt(meta.duration_min, 10);

  const gmt = filename ? parseGmtFilename(filename) : null;
  const out = {
    format: mdWrapped ? 'md' : parsed.format,
    source_guess: meta.source || parsed.source_guess,
    detected_language: meta.language || detectLanguage(segments.map((s) => s.text).join(' ')),
    title: meta.topic || meta.title || inferTitle(body, parsed),
    date: meta.date || findDate(body.slice(0, 2000)) || (gmt && gmt.date) || null,
    time_utc: (gmt && gmt.time_utc) || null,
    duration_min: durationMin,
    timing: parsed.timing,
    segments,
  };
  return { code: 0, out };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    process.exit(argv.length ? 0 : 2);
  }
  if (argv[0] === '--selftest') { selftest(); return; }
  const input = argv[0];
  let text;
  let ext = '';
  try {
    if (input === '-') {
      text = fs.readFileSync(0, 'utf8');
    } else {
      text = fs.readFileSync(input, 'utf8');
      ext = path.extname(input).toLowerCase();
    }
  } catch (e) {
    console.error(`✖ cannot read ${input}: ${e.message}`);
    process.exit(2);
  }

  const res = run(text, ext, input === '-' ? null : input);
  if (res.code !== 0) {
    console.error(`✖ ${res.message}`);
    process.exit(res.code);
  }
  process.stdout.write(JSON.stringify(res.out, null, 2) + '\n');
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Self-test (--selftest) — inline fixtures for every recognized shape */
/* plus the failure modes; exit 0 green (same convention as state.js). */
/* ------------------------------------------------------------------ */

function selftest() {
  const failures = [];
  const check = (name, cond) => { if (!cond) failures.push(name); };

  // D1 — Google Meet Docs export: timestamp on its own line.
  const FIX_MEET_DOCS = [
    'Product Weekly Sync - 2026/07/15 10:02 CEST - Transcript',
    '',
    '00:00:00',
    "Elena Petrova: Okay let's start with the launch page status. Mark, where are we?",
    "Mark Chen: The landing draft is done, but I'm still blocked on the pricing copy from Sofia.",
    '00:02:10',
    "Sofia Ivanova: I'll send the pricing copy by Thursday, promise.",
    "Elena Petrova: Let's make that a task for Mark.",
    '00:05:45',
    'Mark Chen: Noted. The QA pass on the signup flow is scheduled for Friday.',
  ].join('\n');
  const meet = run(FIX_MEET_DOCS, '.txt', 'meet-docs-paste.txt');
  check('meet-docs parses', meet.code === 0);
  if (meet.code === 0) {
    check('meet-docs format tag', meet.out.format === 'meet-docs');
    check('meet-docs timing true', meet.out.timing === true);
    check('meet-docs source is meet', meet.out.source_guess === 'meet');
    check('meet-docs anchors 02:10', meet.out.segments.some((s) => s.ts_mmss === '02:10' && s.speaker === 'Sofia Ivanova'));
    check('meet-docs no timestamp debris in text', !meet.out.segments.some((s) => /\d{1,2}:\d{2}:\d{2}/.test(s.text)));
    check('meet-docs keeps the title line', meet.out.title === 'Product Weekly Sync - 2026/07/15 10:02 CEST - Transcript');
  }

  // D2 — Google Meet .sbv captions.
  const FIX_SBV = [
    '0:00:00.599,0:00:04.160',
    "Elena Petrova: Okay let's start with the launch page status.",
    '',
    '0:00:04.500,0:00:09.120',
    "Mark Chen: The landing draft is done, but I'm blocked on pricing copy.",
    '',
    '0:00:09.500,0:00:15.000',
    "Sofia Ivanova: I'll send the pricing copy by Thursday.",
  ].join('\n');
  const sbv = run(FIX_SBV, '.sbv', 'meet-captions.sbv');
  check('sbv parses', sbv.code === 0);
  if (sbv.code === 0) {
    check('sbv format tag', sbv.out.format === 'sbv');
    check('sbv timing true', sbv.out.timing === true);
    check('sbv pair line is not the title', sbv.out.title === null);
    check('sbv first speaker + anchor', sbv.out.segments[0]
      && sbv.out.segments[0].speaker === 'Elena Petrova' && sbv.out.segments[0].ts_mmss === '00:00');
    check('sbv no pair debris in text', !sbv.out.segments.some((s) => /\d{1,2}:\d{2}:\d{2}[.,]\d/.test(s.text)));
  }
  // Same content pasted via stdin (no .sbv extension) must still detect.
  const sbvStdin = run(FIX_SBV, '', null);
  check('sbv detected without extension', sbvStdin.code === 0 && sbvStdin.out.format === 'sbv');

  // D3 — Zoom GMT filename fallback (content carries no date; prefix is UTC).
  const FIX_GMT_VTT = [
    'WEBVTT',
    '',
    '1',
    '00:00:01.000 --> 00:00:04.000',
    'Elena Petrova: Quick sync on the launch.',
    '',
    '2',
    '00:00:04.500 --> 00:00:08.000',
    'Mark Chen: Landing page is ready for review.',
  ].join('\n');
  const gmt = run(FIX_GMT_VTT, '.vtt', 'GMT20260716-140002_Product Sync.vtt');
  check('gmt vtt parses', gmt.code === 0);
  if (gmt.code === 0) {
    check('gmt vtt format tag', gmt.out.format === 'vtt');
    check('gmt filename date fallback', gmt.out.date === '2026-07-16');
    check('gmt filename time is UTC HH:MM', gmt.out.time_utc === '14:00');
  }
  // A date in the CONTENT must still win over the filename.
  const dated = run(`${FIX_GMT_VTT}\nNOTE recorded 2026-05-01\n`, '.vtt', 'GMT20260716-140002_x.vtt');
  check('content date beats filename', dated.code === 0 && dated.out.date === '2026-05-01');

  // D4 — binary input: exit 2, never the exit-1 LLM-fallback signal.
  const FIX_BINARY = `PK\u0003\u0004${'\u0000'.repeat(24)}\u0001\u0002junk\u0007\u0008`;
  const bin = run(FIX_BINARY, '.bin', 'blob.bin');
  check('binary input exits 2', bin.code === 2);
  check('binary message says binary', bin.code === 2 && /binary/.test(bin.message));

  // Existing happy paths — vtt (covered above) + dialogue.
  const FIX_DIALOGUE = [
    'Alice: Morning, quick standup.',
    'Bob: Shipped the exporter yesterday.',
    'Alice: Great, next up is the importer.',
    'Bob: On it.',
  ].join('\n');
  const dlg = run(FIX_DIALOGUE, '.txt', null);
  check('dialogue parses', dlg.code === 0);
  if (dlg.code === 0) {
    check('dialogue format tag', dlg.out.format === 'dialogue');
    check('dialogue timing false', dlg.out.timing === false);
    check('dialogue speakers survive', dlg.out.segments.some((s) => s.speaker === 'Bob'));
  }

  // Unrecognized prose keeps the exit-1 LLM-fallback contract.
  const prose = run('Just three lines\nof plain prose\nwith no speakers at all.', '.txt', null);
  check('unrecognized prose exits 1', prose.code === 1);

  if (failures.length) {
    console.error(`✖ normalize-transcript.js selftest FAILED:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('✅ normalize-transcript.js selftest ok (meet-docs, sbv, GMT filename fallback, binary sniff, vtt, dialogue, exit-1 contract)');
  process.exit(0);
}

main();
