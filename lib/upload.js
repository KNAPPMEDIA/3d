import { groupFiles, filesFromDrop, loadAny, exportGLB, ext } from './loaders.js';
import { checkToken, uploadModel, deleteModel, listModels, isLive, titleFromFile } from './upload-core.js';

const $ = id => document.getElementById(id);
const KEY = 'km3d-token';
const store = {
  get: () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } },
  set: v => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} },
};
let token = store.get();
const MAX_MB = 95;

function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 1800); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Link kopiert'); } catch { prompt('Link kopieren:', text); } }
const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace('.', ',') + ' MB';

/* ---------- Schlüssel ---------- */
function setConnected(on) {
  $('setup').hidden = on; $('who').hidden = !on; $('zone').classList.toggle('off', !on);
  if (on) refreshAll();
  else $('all').innerHTML = '<p class="empty">Erst den Schlüssel hinterlegen.</p>';
}
$('tokenSave').onclick = async () => {
  const t = $('tokenIn').value.trim();
  if (!t) return;
  $('tokenMsg').className = 'msg'; $('tokenMsg').textContent = 'Prüfe Schlüssel …';
  try { await checkToken(t); token = t; store.set(t); $('tokenIn').value = ''; $('tokenMsg').textContent = ''; setConnected(true); toast('Verbunden'); }
  catch (e) { $('tokenMsg').className = 'msg bad'; $('tokenMsg').textContent = e.message; }
};
$('tokenIn').onkeydown = e => { if (e.key === 'Enter') $('tokenSave').click(); };
$('logout').onclick = () => { store.set(''); token = ''; setConnected(false); };
setConnected(!!token);

/* ---------- Zeilen ---------- */
function row(list, { title, status = '', progress = false }) {
  const el = document.createElement('div'); el.className = 'item';
  el.innerHTML = `<div class="t"></div><div class="a"></div><div class="s"></div>${progress ? '<div class="bar2"><i></i></div>' : ''}`;
  el.querySelector('.t').textContent = title;
  const api = {
    el,
    status(t, cls = '') { const s = el.querySelector('.s'); s.textContent = t; s.className = 's ' + cls; },
    progress(p) { const i = el.querySelector('.bar2 i'); if (i) i.style.width = Math.round(p * 100) + '%'; },
    done() { el.querySelector('.bar2')?.remove(); },
    actions(link, onDelete) {
      const a = el.querySelector('.a'); a.innerHTML = '';
      const b = (txt, fn, cls = '') => { const x = document.createElement('button'); x.className = 'btn2 ' + cls; x.textContent = txt; x.onclick = fn; a.append(x); return x; };
      b('Link kopieren', () => copy(link));
      const o = document.createElement('a'); o.className = 'btn2'; o.textContent = 'Öffnen'; o.href = link; o.target = '_blank'; o.rel = 'noopener'; a.append(o);
      if (onDelete) b('Löschen', onDelete, 'del');
    },
  };
  api.status(status);
  list.prepend(el);
  return api;
}

/* ---------- Upload ---------- */
const base64 = buf => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.slice(r.result.indexOf(',') + 1));
  r.onerror = rej;
  r.readAsDataURL(new Blob([buf]));
});

const queue = [];
let busy = false;
const links = [];

async function handle(files) {
  if (!token) return;
  const { models, resources, unsupported } = groupFiles(files);
  $('jobsHead').hidden = false;
  for (const u of unsupported) row($('jobs'), { title: u.file.name }).status(u.hint, 'bad');
  // .bin/.mtl/Texturen allein sind kein Modell
  if (!models.length && !unsupported.length) row($('jobs'), { title: files[0]?.name || 'Datei' }).status('Keine 3D-Datei erkannt.', 'bad');
  for (const f of models) queue.push({ f, resources, r: row($('jobs'), { title: titleFromFile(f.name), status: 'Wartet …', progress: true }) });
  if (!busy) run();
}

async function run() {
  busy = true;
  while (queue.length) {
    const { f, resources, r } = queue.shift();
    try {
      let glb;
      if (ext(f.name) === 'glb') { glb = await f.arrayBuffer(); r.progress(0.3); }
      else {
        r.status(`Wandle ${ext(f.name).toUpperCase()} in GLB um …`); r.progress(0.1);
        const loaded = await loadAny(f, resources);
        glb = await exportGLB(loaded.scene, loaded.animations);
        if (loaded.notes.length) r.el.dataset.notes = loaded.notes.join(' ');
        r.progress(0.3);
      }
      if (glb.byteLength > MAX_MB * 1048576) throw new Error(`${mb(glb.byteLength)} – zu groß (max. ${MAX_MB} MB). Texturen verkleinern oder mit Draco exportieren.`);
      r.status(`Lade hoch (${mb(glb.byteLength)}) …`);
      const info = {
        title: titleFromFile(f.name), client: $('client').value.trim() || undefined,
        background: $('optDark').checked ? 'dark' : 'light', autoRotate: true, download: $('optDl').checked,
        source: f.name,
      };
      const { slug, link } = await uploadModel(token, await base64(glb), info);
      links.push(link);
      r.progress(0.85); r.actions(link, () => remove(slug, r.el, info.title));
      r.status(`${link} · wird veröffentlicht (ca. 1 Min.)${r.el.dataset.notes ? ' · ' + r.el.dataset.notes : ''}`);
      waitLive(slug, link, r);
    } catch (e) {
      console.error(e); r.done();
      r.status(e.message || 'Fehler beim Hochladen', 'bad');
    }
  }
  busy = false;
  refreshAll();
}

async function waitLive(slug, link, r) {
  for (let i = 0; i < 60; i++) {
    if (await isLive(slug)) { r.progress(1); r.done(); r.status(`${link} · live`, 'ok'); return; }
    await new Promise(res => setTimeout(res, 5000));
  }
  r.done(); r.status(`${link} · noch nicht live – GitHub braucht heute länger, der Link funktioniert gleich.`);
}

$('copyAll').onclick = () => links.length && copy(links.join('\n'));

/* ---------- Drag & Drop ---------- */
$('pick').onchange = e => { handle([...e.target.files]); e.target.value = ''; };
addEventListener('dragover', e => { e.preventDefault(); if (token) document.body.classList.add('dragging'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', async e => { e.preventDefault(); document.body.classList.remove('dragging'); handle(await filesFromDrop(e.dataTransfer)); });

/* ---------- Alle Modelle ---------- */
async function remove(slug, el, title) {
  if (!confirm(`„${title}“ löschen? Der Link funktioniert danach nicht mehr.`)) return;
  try { await deleteModel(token, slug); el.remove(); toast('Gelöscht'); refreshAll(); }
  catch (e) { alert('Löschen fehlgeschlagen: ' + e.message); }
}

async function refreshAll() {
  if (!token) return;
  const box = $('all');
  try {
    const list = await listModels(token);
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<p class="empty">Noch keine Modelle.</p>'; return; }
    for (const m of [...list].reverse()) {
      const r = row(box, { title: m.title || m.slug });
      r.status([m.client, m.date, m.size ? mb(m.size) : '', m.source].filter(Boolean).join(' · '));
      r.actions(m.link, () => remove(m.slug, r.el, m.title || m.slug));
    }
  } catch (e) {
    box.innerHTML = '';
    const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Liste konnte nicht geladen werden: ' + e.message; box.append(p);
    if (e.status === 401) setConnected(false);
  }
}
$('reload').onclick = refreshAll;
