// SPDX-License-Identifier: MIT
/*
 * workspace.js — onboard a beta workspace (hand-held onboarding).
 *
 * Prints the KV entries and the exact wrangler commands that register a
 * workspace and its members, plus the secret to set for the vault read token.
 * It changes nothing by itself: you review the output and run it.
 *
 * Usage:
 *   node scripts/workspace.js --id acme --name "Acme" --repo acme/company-vault \
 *     [--branch main] [--root ""] --member maria@acme.com --member ivan@acme.com \
 *     [--tracker-url "https://linear.app/acme/issue/{ref}"] [--integrations zoom,slack,linear] \
 *     [--namespace-id <CABINET KV id>] [--project <pages project name>]
 */
const args = process.argv.slice(2);
const one = (name, def) => { const i = args.indexOf(`--${name}`); return i > -1 ? args[i + 1] : def; };
const many = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

if (args.includes('-h') || args.includes('--help') || !args.length) {
  console.log(process.argv.slice(1, 2).join(' ').split('/').pop() + ' — see the header of this file for usage.');
  process.exit(0);
}

const id = one('id');
const name = one('name');
const repo = one('repo');
const members = many('member').map((m) => String(m).trim().toLowerCase());
const errors = [];
if (!id || !/^[a-z0-9][a-z0-9-]{1,38}$/.test(id)) errors.push('--id: lowercase letters, digits and dashes (2–39 chars)');
if (!name) errors.push('--name is required');
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) errors.push('--repo owner/name is required');
if (!members.length) errors.push('at least one --member email is required');
for (const m of members) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) errors.push(`--member ${m}: not an email address`);
const trackerUrl = one('tracker-url', null);
if (trackerUrl && !trackerUrl.includes('{ref}')) errors.push('--tracker-url must contain {ref}');
if (errors.length) {
  console.error(errors.map((e) => `✖ ${e}`).join('\n'));
  process.exit(1);
}

const [owner, repoName] = repo.split('/');
const integrations = Object.fromEntries((one('integrations', 'zoom,slack,linear')).split(',').filter(Boolean).map((k) => [k.trim(), true]));
const cfg = {
  id,
  name,
  members,
  vault: { owner, repo: repoName, branch: one('branch', 'main'), root: one('root', '') },
  tracker_url: trackerUrl,
  integrations,
};
const ns = one('namespace-id', '<CABINET namespace id>');
const project = one('project', '<pages project>');
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const secret = `VAULT_TOKEN_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

console.log(`# Workspace "${name}" (${id}) → vault ${repo}@${cfg.vault.branch}${cfg.vault.root ? `/${cfg.vault.root}` : ''}`);
console.log(`npx wrangler kv key put --namespace-id=${ns} ${q(`workspace:${id}`)} ${q(JSON.stringify(cfg))}`);
for (const m of members) console.log(`npx wrangler kv key put --namespace-id=${ns} ${q(`member:${m}`)} ${q(id)}`);
console.log(`\n# Vault read token: a fine-grained PAT, repository ${repo} only, permission Contents: Read-only.`);
console.log(`npx wrangler pages secret put ${secret} --project-name=${project}`);
console.log(`\n# Remove a member later: delete member:<email> and drop it from "members" in workspace:${id}.`);
