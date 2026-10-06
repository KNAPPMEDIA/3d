// Schreibt Modelle und Ordner direkt per GitHub-API ins Repo (ein Commit pro Änderung).
// Aufbau:  m/<slug>/model.glb, info.json, thumb.webp      f/<slug>/folder.json, logo.png
// folder.json enthält die Liste seiner Modelle, weil GitHub Pages keine Ordner auflisten kann.
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
      const err = new Error(r.status === 401 ? 'Token ungültig oder abgelaufen.' : r.status === 403 ? `Kein Schreibzugriff auf ${OWNER}/${REPO} (${msg}).` : msg);
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

const today = d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fileEntry = (path, content) => ({ path, mode: '100644', type: 'blob', content: JSON.stringify(content, null, 2) + '\n' });
const blobEntry = (path, sha) => ({ path, mode: '100644', type: 'blob', sha });
const decode = b64 => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0))));

async function readJSON(gh, path, ref) {
  try { return decode((await gh(`/contents/${path}?ref=${ref}`)).content); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

/**
 * Commit auf main. build(ref) liefert die Baum-Einträge und darf dabei den aktuellen Stand lesen;
 * bei einem Wettlauf mit einem anderen Upload (422) wird neu gelesen und neu gebaut.
 */
async function commit(gh, build, message) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await gh(`/git/ref/heads/${BRANCH}`);
    const parent = await gh(`/git/commits/${ref.object.sha}`);
    const entries = await build(ref.object.sha);
    const tree = await gh('/git/trees', { method: 'POST', body: { base_tree: parent.tree.sha, tree: entries } });
    const c = await gh('/git/commits', { method: 'POST', body: { message, tree: tree.sha, parents: [ref.object.sha] } });
    try { await gh(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: c.sha } }); return c.sha; }
    catch (e) { if (e.status !== 422) throw e; }
  }
  throw new Error('GitHub hat den Commit mehrfach abgelehnt. Bitte nochmal versuchen.');
}

const blob = (gh, base64) => gh('/git/blobs', { method: 'POST', body: { content: base64, encoding: 'base64' } });

// Modell-Slug in folder.json ein- oder austragen
async function folderEntries(gh, ref, { add, remove }) {
  const touched = new Map();
  const get = async slug => {
    if (!touched.has(slug)) touched.set(slug, await readJSON(gh, `f/${slug}/folder.json`, ref));
    const f = touched.get(slug); if (f) f.models ||= [];
    return f;
  };
  if (remove?.folder) { const f = await get(remove.folder); if (f) f.models = f.models.filter(s => s !== remove.slug); }
  if (add?.folder) { const f = await get(add.folder); if (f) f.models = [add.slug, ...f.models.filter(s => s !== add.slug)]; }
  return [...touched].filter(([, f]) => f).map(([slug, f]) => fileEntry(`f/${slug}/folder.json`, f));
}

/** base64 = GLB; thumb = WebP-Vorschaubild als Base64 (optional); info = { title, client, folder, ... } */
export async function uploadModel(token, base64, info, thumb) {
  const gh = api(token);
  const slug = makeSlug(info.title);
  const [glb, img] = await Promise.all([blob(gh, base64), thumb ? blob(gh, thumb) : null]);
  const now = new Date();
  const data = { ...info, date: today(now), created: now.toISOString(), thumb: img ? 'thumb.webp' : undefined };
  await commit(gh, async ref => [
    blobEntry(`m/${slug}/model.glb`, glb.sha),
    ...(img ? [blobEntry(`m/${slug}/thumb.webp`, img.sha)] : []),
    fileEntry(`m/${slug}/info.json`, data),
    ...await folderEntries(gh, ref, { add: info.folder && { folder: info.folder, slug } }),
  ], `Modell: ${info.title}`);
  return { slug, link: `${PAGES}?m=${slug}` };
}

/**
 * Neue Version unter gleichem Link: Modelldatei und/oder Vorschaubild ersetzen, alte Version ist weg.
 * patch = Felder für info.json, z. B. { source: 'neu.obj' }.
 */
export async function replaceModel(token, slug, base64, thumb, patch = {}) {
  const gh = api(token);
  const [glb, img] = await Promise.all([base64 ? blob(gh, base64) : null, thumb ? blob(gh, thumb) : null]);
  let created;
  await commit(gh, async ref => {
    const data = await readJSON(gh, `m/${slug}/info.json`, ref);
    if (!data) throw new Error('Modell nicht gefunden.');
    const now = new Date();
    created = now.toISOString();
    Object.assign(data, patch);
    data.created = created;   // neuer Wert = Browser lädt die neue Datei statt der zwischengespeicherten
    if (glb) { data.date = today(now); data.version = (data.version || 1) + 1; }
    if (img) data.thumb = 'thumb.webp';
    return [
      ...(glb ? [blobEntry(`m/${slug}/model.glb`, glb.sha)] : []),
      ...(img ? [blobEntry(`m/${slug}/thumb.webp`, img.sha)] : []),
      fileEntry(`m/${slug}/info.json`, data),
    ];
  }, `Neue Version: ${slug}`);
  return { slug, link: `${PAGES}?m=${slug}`, created };
}

/** Modell in einen Ordner verschieben (folder = null: aus allen Ordnern nehmen). */
export async function moveModel(token, slug, folder) {
  const gh = api(token);
  await commit(gh, async ref => {
    const data = await readJSON(gh, `m/${slug}/info.json`, ref);
    if (!data) throw new Error('Modell nicht gefunden.');
    const old = data.folder;
    if (folder) data.folder = folder; else delete data.folder;
    return [fileEntry(`m/${slug}/info.json`, data),
      ...await folderEntries(gh, ref, { remove: old && { folder: old, slug }, add: folder && { folder, slug } })];
  }, `Modell verschoben: ${slug} → ${folder || 'ohne Ordner'}`);
}

export async function deleteModel(token, slug) {
  const gh = api(token);
  await commit(gh, async ref => {
    const dir = await gh(`/contents/m/${slug}?ref=${ref}`);
    const data = await readJSON(gh, `m/${slug}/info.json`, ref);
    return [...dir.map(f => blobEntry(f.path, null)),
      ...await folderEntries(gh, ref, { remove: data?.folder && { folder: data.folder, slug } })];
  }, `Modell entfernt: ${slug}`);
}

/* ---------- Ordner ---------- */
export async function createFolder(token, name, logoBase64) {
  const gh = api(token);
  const slug = makeSlug(name);
  const logo = logoBase64 ? await blob(gh, logoBase64) : null;
  const now = new Date();
  await commit(gh, async () => [
    fileEntry(`f/${slug}/folder.json`, { name, logo: logo ? 'logo.png' : undefined, date: today(now), created: now.toISOString(), models: [] }),
    ...(logo ? [blobEntry(`f/${slug}/logo.png`, logo.sha)] : []),
  ], `Ordner: ${name}`);
  return { slug, link: `${PAGES}?f=${slug}` };
}

export async function setFolderLogo(token, slug, logoBase64) {
  const gh = api(token);
  const logo = await blob(gh, logoBase64);
  await commit(gh, async ref => {
    const f = await readJSON(gh, `f/${slug}/folder.json`, ref);
    f.logo = 'logo.png'; f.created = new Date().toISOString();
    return [blobEntry(`f/${slug}/logo.png`, logo.sha), fileEntry(`f/${slug}/folder.json`, f)];
  }, `Ordner-Logo: ${slug}`);
}

/** Ordner löschen. Die Modelle bleiben erhalten (ohne Ordner). */
export async function deleteFolder(token, slug) {
  const gh = api(token);
  await commit(gh, async ref => {
    const f = await readJSON(gh, `f/${slug}/folder.json`, ref);
    const dir = await gh(`/contents/f/${slug}?ref=${ref}`);
    const models = [];
    for (const m of f?.models || []) {
      const data = await readJSON(gh, `m/${m}/info.json`, ref);
      if (data) { delete data.folder; models.push(fileEntry(`m/${m}/info.json`, data)); }
    }
    return [...dir.map(x => blobEntry(x.path, null)), ...models];
  }, `Ordner entfernt: ${slug}`);
}

/** Alles auf einmal lesen: { models, folders } */
export async function listAll(token) {
  const gh = api(token);
  const ref = await gh(`/git/ref/heads/${BRANCH}`);
  const tree = await gh(`/git/trees/${ref.object.sha}?recursive=1`);
  const sizes = Object.fromEntries(tree.tree.filter(t => /^m\/[^/]+\/model\.glb$/.test(t.path)).map(t => [t.path.split('/')[1], t.size]));
  const read = async t => { try { return decode((await gh(`/git/blobs/${t.sha}`)).content); } catch { return {}; } };
  const [models, folders] = await Promise.all([
    Promise.all(tree.tree.filter(t => /^m\/[^/]+\/info\.json$/.test(t.path)).map(async t => {
      const slug = t.path.split('/')[1];
      return { slug, link: `${PAGES}?m=${slug}`, size: sizes[slug] || 0, ...await read(t) };
    })),
    Promise.all(tree.tree.filter(t => /^f\/[^/]+\/folder\.json$/.test(t.path)).map(async t => {
      const slug = t.path.split('/')[1];
      return { slug, link: `${PAGES}?f=${slug}`, ...await read(t) };
    })),
  ]);
  const byDate = (a, b) => (b.created || '').localeCompare(a.created || '');
  return { models: models.sort(byDate), folders: folders.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'de')) };
}

/** Prüft, ob GitHub Pages das Modell (bzw. genau diese Version) schon ausliefert. */
export async function isLive(slug, created) {
  try {
    const r = await fetch(`${PAGES}m/${slug}/info.json?t=${Date.now()}`, { cache: 'no-store' });
    return r.ok && (!created || (await r.json()).created === created);
  } catch { return false; }
}
