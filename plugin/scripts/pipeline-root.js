#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * pipeline-root.js — locate the kit's pipeline/ tree across install layouts.
 *
 * Layouts:
 *   - full kit checkout (git clone): <kit>/plugin/scripts -> ../../pipeline
 *   - plugin-only marketplace cache: absent. `claude plugin install` copies
 *     ONLY the `source: "./plugin"` subtree into the plugin cache; paths that
 *     traverse outside the plugin root are not copied (documented Claude Code
 *     plugin-caching behavior).
 *
 * Phase-B tooling (render, deploy, drift, history import) calls
 * requirePipeline() and gets a loud, honest exit 2 on a plugin-only install,
 * pointing at the full-checkout path. status.js uses findPipelineDir() to
 * degrade its pipeline sections gracefully instead of dying at require time.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  path.join(__dirname, '..', '..', 'pipeline'), // full kit checkout
  path.join(__dirname, '..', 'pipeline'),       // pipeline inside plugin/ (future layout)
];

function findPipelineDir() {
  for (const p of CANDIDATES) {
    if (fs.existsSync(path.join(p, 'tenant-render.js'))) return p;
  }
  return null;
}

function requirePipeline(scriptName) {
  const dir = findPipelineDir();
  if (!dir) {
    console.error(
      `${scriptName}: the kit's pipeline/ tree is not present next to this plugin.\n` +
      'A marketplace install carries only plugin/ (the plugin cache cannot reach\n' +
      'sibling directories) — Phase B tooling needs the full kit checkout:\n' +
      '  git clone https://github.com/EvgenSmith/backbrief && cd backbrief\n' +
      `  node plugin/scripts/${scriptName} ...\n` +
      'Phase A skills (start / profiles / tasks) work fine from the plugin cache.');
    process.exit(2);
  }
  return { PIPELINE_DIR: dir, RENDER: require(path.join(dir, 'tenant-render.js')) };
}

module.exports = { findPipelineDir, requirePipeline };
