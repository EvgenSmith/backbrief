#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * check-telemetry-contract.js — client↔gateway wire-contract parity guard.
 *
 * gateway/schema.md promises the telemetry allowlist is enforced identically on
 * both sides — the gateway (gateway/worker.js) and the client
 * (plugin/scripts/telemetry.js) each carry their own copy. This script makes
 * that promise testable: it extracts the six contract constants from each file
 * and exits non-zero on ANY drift between them. Wired as a CI job in
 * .github/workflows/ci.yml so a divergent commit fails the build.
 *
 * Why two copies exist (by design): each side must enforce the allowlist
 * independently — the client so nothing outside the vocabulary ever leaves the
 * machine, the server so a stale/forged client can't smuggle content. The risk
 * of two copies is drift; this check is the mitigation.
 *
 * Extraction:
 *   - telemetry.js is a CommonJS library that exports its contract constants —
 *     we require() it and read them off module.exports.
 *   - worker.js is a Cloudflare ES-module worker whose only export is its fetch
 *     handler, so the constants aren't exported. We evaluate just its
 *     constant-declaration prefix (everything above `export default`, which is
 *     pure top-level `const`s with no imports or side effects) in a throwaway
 *     vm sandbox and read the constants back out.
 *
 * Node >= 18, zero npm dependencies. Run: node plugin/scripts/check-telemetry-contract.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const KIT_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(KIT_ROOT, 'gateway', 'worker.js');
const CLIENT = path.join(KIT_ROOT, 'plugin', 'scripts', 'telemetry.js');

// The wire pieces both sides must agree on (arrays are compared as sets; the
// two object maps are compared key-by-key, each value as a set).
const ARRAY_CONTRACT = ['EVENTS', 'STEPS', 'INTERESTS', 'ERROR_CLASSES'];
const OBJECT_CONTRACT = ['PROPS_BY_EVENT', 'ENUM_PROPS'];
const CONTRACT = [...ARRAY_CONTRACT, ...OBJECT_CONTRACT];

const HELP = `check-telemetry-contract.js — telemetry client<->gateway wire-contract parity guard

Usage:
  node plugin/scripts/check-telemetry-contract.js

Verifies that plugin/scripts/telemetry.js (the client) and gateway/worker.js
(the gateway) carry one identical wire allowlist. Compares, as sets: EVENTS,
STEPS, INTERESTS, ERROR_CLASSES, and — key-by-key — PROPS_BY_EVENT, ENUM_PROPS.
Any divergence fails. Takes no arguments; wired as the telemetry-contract CI job
(.github/workflows/ci.yml).

Options:
  -h, --help   this text

Exit codes: 0 in sync / 1 contract drift / 2 could not load a side`;

// Read the named constants from worker.js by evaluating only the code above
// `export default` (the constant prefix) in an isolated context.
function fromWorker(names) {
  const src = fs.readFileSync(WORKER, 'utf8');
  const cut = src.indexOf('export default');
  if (cut < 0) throw new Error('worker.js: no `export default` marker — cannot isolate the constant prefix');
  const prefix = src.slice(0, cut);
  const sandbox = { __out: {} };
  vm.createContext(sandbox);
  const capture = '\n' + names.map((n) => `__out.${n} = (typeof ${n} !== 'undefined') ? ${n} : undefined;`).join('\n');
  vm.runInContext(prefix + capture, sandbox, { filename: 'worker.js(prefix)' });
  return sandbox.__out;
}

// Read the named constants from telemetry.js via its module exports.
function fromClient(names) {
  const mod = require(CLIENT);
  const out = {};
  for (const n of names) out[n] = mod[n];
  return out;
}

function diffSet(label, clientArr, workerArr, errs) {
  if (!Array.isArray(clientArr)) { errs.push(`${label}: not an array on the client side`); return; }
  if (!Array.isArray(workerArr)) { errs.push(`${label}: not an array on the gateway side`); return; }
  const inWorker = new Set(workerArr);
  const inClient = new Set(clientArr);
  const onlyClient = clientArr.filter((x) => !inWorker.has(x));
  const onlyWorker = workerArr.filter((x) => !inClient.has(x));
  if (onlyClient.length) errs.push(`${label}: present in telemetry.js but missing from worker.js → ${JSON.stringify(onlyClient)}`);
  if (onlyWorker.length) errs.push(`${label}: present in worker.js but missing from telemetry.js → ${JSON.stringify(onlyWorker)}`);
}

function diffMap(label, clientObj, workerObj, errs) {
  if (!clientObj || typeof clientObj !== 'object') { errs.push(`${label}: not an object on the client side`); return; }
  if (!workerObj || typeof workerObj !== 'object') { errs.push(`${label}: not an object on the gateway side`); return; }
  diffSet(`${label} (keys)`, Object.keys(clientObj), Object.keys(workerObj), errs);
  for (const k of Object.keys(clientObj)) {
    if (!(k in workerObj)) continue; // key-set mismatch already reported
    diffSet(`${label}.${k}`, clientObj[k], workerObj[k], errs);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) { console.log(HELP); process.exit(0); }
  const unknown = argv.filter((a) => a.startsWith('-'));
  if (unknown.length) { console.error(`unknown option: ${unknown.join(' ')} (this check takes no arguments — see --help)`); process.exit(2); }

  let client;
  let worker;
  try {
    client = fromClient(CONTRACT);
  } catch (e) {
    console.error(`could not load client contract from telemetry.js: ${e.message}`);
    process.exit(2);
  }
  try {
    worker = fromWorker(CONTRACT);
  } catch (e) {
    console.error(`could not load gateway contract from worker.js: ${e.message}`);
    process.exit(2);
  }

  const errs = [];
  for (const name of CONTRACT) {
    if (client[name] === undefined) { errs.push(`${name}: not exported by telemetry.js`); continue; }
    if (worker[name] === undefined) { errs.push(`${name}: not defined in worker.js`); continue; }
    if (ARRAY_CONTRACT.includes(name)) diffSet(name, client[name], worker[name], errs);
    else diffMap(name, client[name], worker[name], errs);
  }

  if (errs.length) {
    console.error('telemetry contract DRIFT — client (telemetry.js) and gateway (worker.js) disagree:');
    for (const e of errs) console.error(`  - ${e}`);
    console.error('\nFix: bring both allowlists (and gateway/schema.md) back in sync in the same commit.');
    process.exit(1);
  }

  console.log(`telemetry contract OK — worker.js and telemetry.js agree on ${CONTRACT.join(', ')}`);
}

main();
