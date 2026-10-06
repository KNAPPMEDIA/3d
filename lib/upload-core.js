// Schreibt Modelle direkt per GitHub-API ins Repo (ein Commit pro Modell).
export const OWNER = 'KNAPPMEDIA', REPO = '3d', BRANCH = 'main';
export const PAGES = 'https://knappmedia.github.io/3d/';

function api(token) {
  return async (path, opts = {}) => {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!r.ok) {
      const msg = (await r.json().catch(() => ({}))).message || r.statusText;
      const err = new Error(r.status === 401 ? 'Token ungültig oder abgelaufen.' : r.status === 403 || r.status === 404 ? `Kein Schreibzugriff auf ${OWNER}/${REPO} (${msg}).` : msg);
      err.status = r.status; throw err;
    }
    return r.status === 204 ? null : r.json();
  };
}

export async function checkToken(token) {
  const repo = await api(token)('');
  if (!repo.permissions?.push) throw new Error(`Token darf nicht in ${OWNER}/${REPO} schreiben.`);
  return true;
}

export function makeSlug(title) {
  const readable = title.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30).replace(/-$/, '');
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => abc[b % abc.length]).join('');
  return readable ? `${readable}-${rnd}` : rnd;
}

export function titleFromFile(name) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Eine Änderung am Baum als Commit auf main schreiben; bei Wettlauf (422) einmal neu aufsetzen.
async function commitTree(gh, entries, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh(`/git/ref/heads/${BRANCH}`);
    const parent = await gh(`/git/commits/${ref.object.sha}`);
    const tree = await gh('/git/trees', { method: 'POST', body: { base_tree: parent.tree.sha, tree: entries } });
    const commit = await gh('/git/commits', { method: 'POST', body: { message, tree: tree.sha, parents: [ref.object.sha] } });
    try {
      await gh(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha } });
      return commit.sha;
    } catch (e) { if (e.status !== 422) throw e; }
  }
  throw new Error('GitHub hat den Commit mehrfach abgelehnt. Bitte nochmal versuchen.');
}

/** base64 = GLB-Inhalt als Base64; info = { title, client, ... } */
export async function uploadModel(token, base64, info) {
  const gh = api(token);
  const slug = makeSlug(info.title);
  const blob = await gh('/git/blobs', { method: 'POST', body: { content: base64, encoding: 'base64' } });
  const now = new Date();
  const json = JSON.stringify({ ...info, date: now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }), created: now.toISOString() }, null, 2) + '\n';
  await commitTree(gh, [
    { path: `m/${slug}/model.glb`, mode: '100644', type: 'blob', sha: blob.sha },
    { path: `m/${slug}/info.json`, mode: '100644', type: 'blob', content: json },
  ], `Modell: ${info.title}`);
  return { slug, link: `${PAGES}?m=${slug}` };
}

export async function deleteModel(token, slug) {
  const gh = api(token);
  const dir = await gh(`/contents/m/${slug}?ref=${BRANCH}`);
  await commitTree(gh, dir.map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: null })), `Modell entfernt: ${slug}`);
}

export async function listModels(token) {
  const gh = api(token);
  const ref = await gh(`/git/ref/heads/${BRANCH}`);
  const tree = await gh(`/git/trees/${ref.object.sha}?recursive=1`);
  const infos = tree.tree.filter(t => /^m\/[^/]+\/info\.json$/.test(t.path));
  const sizes = Object.fromEntries(tree.tree.filter(t => t.path.endsWith('.glb')).map(t => [t.path.split('/')[1], t.size]));
  const list = await Promise.all(infos.map(async t => {
    const slug = t.path.split('/')[1];
    const b = await gh(`/git/blobs/${t.sha}`);
    const bytes = Uint8Array.from(atob(b.content.replace(/\n/g, '')), c => c.charCodeAt(0));
    let info = {}; try { info = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
    return { slug, link: `${PAGES}?m=${slug}`, size: sizes[slug] || 0, ...info };
  }));
  return list.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

/** Prüft, ob GitHub Pages das Modell schon ausliefert. */
export async function isLive(slug) {
  try { return (await fetch(`${PAGES}m/${slug}/info.json?t=${Date.now()}`, { cache: 'no-store' })).ok; } catch { return false; }
}
