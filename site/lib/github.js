// SPDX-License-Identifier: MIT
/*
 * github.js — read a customer's vault from GitHub: one tree request lists the
 * files, then individual files are fetched raw. File bodies are cached by blob
 * SHA (content-addressed, so a cached body can never go stale) and the tree for
 * a minute, through the Workers Cache API when it exists.
 *
 * Auth: a fine-grained personal access token with read-only "Contents"
 * permission on the vault repository only, the same scope shape the pipeline
 * already uses for writing (docs/github-setup.md).
 */

const TREE_TTL = 60;
const BLOB_TTL = 86400;

const cacheStore = () => (typeof caches !== 'undefined' && caches.default ? caches.default : null);

async function cached(key, ttl, load) {
  const store = cacheStore();
  const req = new Request(`https://cabinet-cache.internal/${key}`);
  if (store) {
    const hit = await store.match(req);
    if (hit) return hit.text();
  }
  const body = await load();
  if (store) {
    await store.put(req, new Response(body, { headers: { 'cache-control': `max-age=${ttl}` } }));
  }
  return body;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

export function githubSource(env, vault, token, cacheScope = 'default') {
  const api = (env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const { owner, repo } = vault;
  const branch = vault.branch || 'main';
  const root = (vault.root || '').replace(/^\/+|\/+$/g, '');
  const headers = {
    'user-agent': 'backbrief-cabinet',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  async function get(url, accept) {
    const res = await fetch(url, { headers: { ...headers, accept } });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status} for ${url.replace(api, '')}`);
      err.status = res.status;
      throw err;
    }
    return res.text();
  }

  return {
    root,
    /** [{path (vault-relative), sha}] for every file under the vault root. */
    async tree() {
      const body = await cached(`tree/${cacheScope}/${owner}/${repo}/${branch}`, TREE_TTL, () =>
        get(`${api}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, 'application/vnd.github+json'));
      const data = JSON.parse(body);
      const prefix = root ? `${root}/` : '';
      const files = (data.tree || [])
        .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
        .map((e) => ({ path: e.path.slice(prefix.length), sha: e.sha }));
      return { files, truncated: Boolean(data.truncated) };
    },
    /** Raw text of one vault-relative file. */
    async read(rel, sha) {
      const full = root ? `${root}/${rel}` : rel;
      const load = () => get(`${api}/repos/${owner}/${repo}/contents/${encodePath(full)}?ref=${encodeURIComponent(branch)}`, 'application/vnd.github.raw');
      return sha ? cached(`blob/${sha}`, BLOB_TTL, load) : load();
    },
    /** Browser URL of a vault file, for "open in vault" links. */
    url(rel) {
      const full = root ? `${root}/${rel}` : rel;
      return `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${encodePath(full)}`;
    },
  };
}
