import { groupFiles, filesFromDrop, loadAny, exportGLB, ext } from './loaders.js';
import * as core from './upload-core.js';
import { makeThumb } from './thumb.js';

const $ = id => document.getElementById(id);
const KEY = 'km3d-token', FOLDER_KEY = 'km3d-folder';
const store = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
let token = store.get(KEY);
const MAX_MB = 95;
const STATUS = { ok: '🟢 Bestätigt', unsure: '🟡 Noch unsicher', no: '🔴 Nicht bestätigt' };
const PAGES = core.PAGES;
// Über „3D-Upload starten“ geöffnet: der lokale Server lädt mit dem GitHub-Login des PCs hoch
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '8795';

async function post(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Fehler ${r.status}`);
  return r;
}
/** Repo-Funktion aufrufen: lokal über den Server, sonst direkt mit dem Schlüssel. */
const call = (fn, ...args) => LOCAL
  ? post('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) }).then(r => r.json())
  : core[fn](token, ...args);
async function convertC4D(f) {
  const r = await post('/api/c4d?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
  return { glb: await r.arrayBuffer(), note: decodeURIComponent(r.headers.get('X-Note') || '') };
}

function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 1800); }
async function copy(text, what = 'Link') { try { await navigator.clipboard.writeText(text); toast(`${what} kopiert`); } catch { prompt('Kopieren:', text); } }
const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace('.', ',') + ' MB';
const base64 = data => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.slice(r.result.indexOf(',') + 1));
  r.onerror = rej;
  r.readAsDataURL(data instanceof Blob ? data : new Blob([data]));
});

/* ---------- Verbindung ---------- */
let state = { models: [], folders: [] };
function setConnected(on) {
  $('setup').hidden = on; $('who').hidden = !on; $('zone').classList.toggle('off', !on);
  if (on) refreshAll();
  else $('all').innerHTML = '<p class="empty">Erst den Schlüssel hinterlegen.</p>';
}
$('tokenSave').onclick = async () => {
  const t = $('tokenIn').value.trim(); if (!t) return;
  $('tokenMsg').className = 'msg'; $('tokenMsg').textContent = 'Prüfe Schlüssel …';
  try { await core.checkToken(t); token = t; store.set(KEY, t); $('tokenIn').value = ''; $('tokenMsg').textContent = ''; setConnected(true); toast('Verbunden'); }
  catch (e) { $('tokenMsg').className = 'msg bad'; $('tokenMsg').textContent = e.message; }
};
$('tokenIn').onkeydown = e => { if (e.key === 'Enter') $('tokenSave').click(); };
$('logout').onclick = () => { store.set(KEY, ''); token = ''; setConnected(false); };
if (LOCAL) {
  $('logout').hidden = true;
  $('whoTxt').textContent = 'Lokal · über deinen GitHub-Login';
  $('fmts').textContent = 'C4D · GLB · GLTF · FBX · OBJ+MTL · STL · PLY · DAE · 3DS · 3MF · USDZ';
  post('/api/status').then(() => setConnected(true)).catch(e => { $('all').innerHTML = ''; const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Uploader nicht bereit: ' + e.message; $('all').append(p); });
} else setConnected(!!token);

/* ---------- Ordner ---------- */
const currentFolder = () => state.folders.find(f => f.slug === $('folderSel').value);
const logoUrl = f => f?.logo ? `${PAGES}f/${f.slug}/${f.logo}?v=${encodeURIComponent(f.created || '')}` : '';

function renderFolderSelect() {
  const sel = $('folderSel'), keep = sel.value || store.get(FOLDER_KEY);
  sel.length = 1;
  for (const f of state.folders) { const o = document.createElement('option'); o.value = f.slug; o.textContent = `📁 ${f.name}`; sel.append(o); }
  sel.value = state.folders.some(f => f.slug === keep) ? keep : '';
  onFolderChange();
}
function onFolderChange() {
  const f = currentFolder();
  store.set(FOLDER_KEY, f?.slug || '');
  $('flink').hidden = !f;
  $('zoneTxt').innerHTML = f ? `Landet im Ordner <b></b>. Jedes Modell bekommt zusätzlich seinen eigenen Link.` : 'Jedes Modell bekommt seinen eigenen Link. Ganze Ordner mit Texturen gehen auch.';
  if (!f) return;
  $('zoneTxt').querySelector('b').textContent = f.name;
  $('flinkUrl').textContent = f.link; $('flinkOpen').href = f.link;
  $('flinkLogo').hidden = !f.logo; $('flinkLogo').style.visibility = '';
  $('flinkLogo').onerror = () => ($('flinkLogo').style.visibility = 'hidden');
  if (f.logo) $('flinkLogo').src = logoUrl(f);
  if (!$('client').value) $('client').placeholder = `Kunde (Standard: ${f.name})`;
}
$('folderSel').onchange = onFolderChange;
$('flinkCopy').onclick = () => copy(currentFolder()?.link, 'Ordner-Link');
$('newFolderBtn').onclick = () => { $('newFolder').hidden = !$('newFolder').hidden; if (!$('newFolder').hidden) $('nfName').focus(); };
$('nfLogo').onchange = e => { $('nfLogoBtn').firstChild.textContent = e.target.files[0] ? '✓ ' + e.target.files[0].name.slice(0, 18) : 'Logo wählen'; };

/** Logo als PNG aufbereiten: weißen Hintergrund entfernen, zuschneiden, max. 900 px breit. */
async function prepareLogo(file) {
  const img = await createImageBitmap(file).catch(async () => {
    const i = new Image(); i.src = URL.createObjectURL(file); await i.decode(); return i;
  });
  const scale = Math.min(1, 900 / img.width, 600 / img.height) || 1;
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h), p = d.data;
  const hasAlpha = p.some((v, i) => i % 4 === 3 && v < 250);
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let i = 0; i < p.length; i += 4) {
    if (!hasAlpha) {   // Weiß → transparent, mit weicher Kante
      const light = Math.min(p[i], p[i + 1], p[i + 2]);
      if (light > 235) p[i + 3] = 0; else if (light > 200) p[i + 3] = Math.round(255 * (235 - light) / 35);
    }
    if (p[i + 3] > 16) { const x = (i / 4) % w, y = Math.floor(i / 4 / w); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  g.putImageData(d, 0, 0);
  if (x1 < x0) return base64(await c.convertToBlob({ type: 'image/png' }));
  const t = new OffscreenCanvas(x1 - x0 + 1, y1 - y0 + 1);
  t.getContext('2d').drawImage(c, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
  return base64(await t.convertToBlob({ type: 'image/png' }));
}

$('nfCreate').onclick = async () => {
  const name = $('nfName').value.trim();
  if (!name) { $('nfName').focus(); return; }
  const btn = $('nfCreate'); btn.disabled = true; btn.textContent = 'Lege an …';
  try {
    const logoFile = $('nfLogo').files[0];
    const { slug } = await call('createFolder', name, logoFile ? await prepareLogo(logoFile) : null);
    store.set(FOLDER_KEY, slug); $('folderSel').value = '';
    $('nfName').value = ''; $('nfLogo').value = ''; $('nfLogoBtn').firstChild.textContent = 'Logo wählen'; $('newFolder').hidden = true;
    await refreshAll(); toast(`Ordner „${name}“ angelegt`);
  } catch (e) { alert('Ordner anlegen fehlgeschlagen: ' + e.message); }
  btn.disabled = false; btn.textContent = 'Ordner anlegen';
};
$('nfName').onkeydown = e => { if (e.key === 'Enter') $('nfCreate').click(); };
$('flinkLogoIn').onchange = async e => {
  const f = currentFolder(), file = e.target.files[0]; if (!f || !file) return;
  try { await call('setFolderLogo', f.slug, await prepareLogo(file)); toast('Logo gespeichert'); refreshAll(); }
  catch (err) { alert('Logo speichern fehlgeschlagen: ' + err.message); }
  e.target.value = '';
};

/* ---------- Zeilen ---------- */
function row(list, { title, status = '', progress = false, thumb = '' }, append = false) {
  const el = document.createElement('div'); el.className = 'item';
  el.innerHTML = `<div class="th"></div><div class="t"></div><div class="a"></div><div class="s"></div>${progress ? '<div class="bar2"><i></i></div>' : ''}`;
  el.querySelector('.t').textContent = title;
  if (thumb) el.querySelector('.th').style.backgroundImage = `url("${thumb}")`;
  const api = {
    el,
    status(t, cls = '') { const s = el.querySelector('.s'); s.textContent = t; s.className = 's ' + cls; },
    progress(p) { const i = el.querySelector('.bar2 i'); if (i) i.style.width = Math.round(p * 100) + '%'; },
    thumb(src) { el.querySelector('.th').style.backgroundImage = `url("${src}")`; },
    done() { el.querySelector('.bar2')?.remove(); },
    actions(m) {
      el.dataset.slug = m.slug;   // Zielfläche für neue Versionen
      el.title = 'Neue Datei hierauf ziehen = neue Version unter gleichem Link';
      const a = el.querySelector('.a'); a.innerHTML = '';
      const b = (txt, fn, cls = '') => { const x = document.createElement('button'); x.className = 'btn2 sm ' + cls; x.textContent = txt; x.onclick = fn; a.append(x); return x; };
      b('Link kopieren', () => copy(m.link));
      const o = document.createElement('a'); o.className = 'btn2 sm'; o.textContent = 'Öffnen'; o.href = m.link; o.target = '_blank'; o.rel = 'noopener'; a.append(o);
      // Freigabe-Status, sichtbar für den Kunden auf der Ordner- und Modellseite
      const st = document.createElement('select'); st.title = 'Status'; st.setAttribute('aria-label', 'Status');
      for (const [v, t] of Object.entries(STATUS)) { const op = document.createElement('option'); op.value = v; op.textContent = t; st.append(op); }
      st.value = m.status || 'unsure'; st.dataset.s = st.value;
      st.onchange = async () => {
        st.disabled = true; st.dataset.s = st.value;
        try { await call('setInfo', m.slug, { status: st.value }); m.status = st.value; toast(STATUS[st.value]); }
        catch (e) { alert('Status speichern fehlgeschlagen: ' + e.message); st.value = m.status || 'unsure'; st.dataset.s = st.value; }
        st.disabled = false;
      };
      a.append(st);
      if (state.folders.length) {
        const s = document.createElement('select'); s.title = 'In Ordner verschieben'; s.setAttribute('aria-label', 'Ordner');
        s.innerHTML = '<option value="">Kein Ordner</option>';
        for (const f of state.folders) { const op = document.createElement('option'); op.value = f.slug; op.textContent = '📁 ' + f.name; s.append(op); }
        s.value = m.folder || '';
        s.onchange = async () => {
          s.disabled = true;
          try { await call('moveModel', m.slug, s.value || null); toast('Verschoben'); refreshAll(); }
          catch (e) { alert('Verschieben fehlgeschlagen: ' + e.message); s.disabled = false; }
        };
        a.append(s);
      }
      b('Löschen', () => removeModel(m, el), 'del');
    },
  };
  api.status(status);
  append ? list.append(el) : list.prepend(el);
  return api;
}

/* ---------- Upload ---------- */
const queue = [];
let busy = false;
const links = [];

async function handle(files) {
  if (!token && !LOCAL) return;
  const { models, resources, unsupported: unsup } = groupFiles(files);
  // Lokal kann Cinema 4D selbst konvertieren
  const unsupported = LOCAL ? unsup.filter(u => ext(u.file.name) !== 'c4d') : unsup;
  if (LOCAL) models.push(...unsup.filter(u => ext(u.file.name) === 'c4d').map(u => u.file));
  $('jobsHead').hidden = false;
  for (const u of unsupported) row($('jobs'), { title: u.file.name }).status(u.hint, 'bad');
  if (!models.length && !unsupported.length) row($('jobs'), { title: files[0]?.name || 'Datei' }).status('Keine 3D-Datei erkannt.', 'bad');
  const folder = currentFolder();
  for (const f of models) queue.push({ f, resources, folder, r: row($('jobs'), { title: core.titleFromFile(f.name), status: folder ? `Wartet … → 📁 ${folder.name}` : 'Wartet …', progress: true }) });
  if (!busy) run();
}

/** Datei in GLB umwandeln und Vorschaubild erstellen. */
async function prepare(f, resources, r, notes) {
  let glb;
  const e = ext(f.name);
  if (e === 'glb') { glb = await f.arrayBuffer(); r.progress(0.2); }
  else if (e === 'c4d') {
    r.status('Cinema 4D wandelt um … (beim ersten Mal ca. 30 Sek.)'); r.progress(0.1);
    const c = await convertC4D(f); glb = c.glb; if (c.note) notes.push(c.note);
    r.progress(0.25);
  } else {
    r.status(`Wandle ${e.toUpperCase()} in GLB um …`); r.progress(0.1);
    const loaded = await loadAny(f, resources);
    notes.push(...loaded.notes);
    glb = await exportGLB(loaded.scene, loaded.animations);
    r.progress(0.25);
  }
  if (glb.byteLength > MAX_MB * 1048576) throw new Error(`${mb(glb.byteLength)} – zu groß (max. ${MAX_MB} MB). Texturen verkleinern oder mit Draco exportieren.`);
  // Vorschaubild aus der fertigen GLB, damit es genau zeigt, was der Kunde sieht
  r.status('Erstelle Vorschaubild …');
  let thumb = null;
  try {
    thumb = await makeThumb(await loadAny(new File([glb], 'model.glb'), new Map()));
    r.thumb('data:image/webp;base64,' + thumb);
  } catch (err) { console.warn('Vorschaubild fehlgeschlagen', err); }
  r.status(`Lade hoch (${mb(glb.byteLength)}) …`); r.progress(0.4);
  return { glb, thumb };
}

/** Neue Version über ein bestehendes Modell legen: gleicher Link, alte Datei wird ersetzt. */
async function replaceJob({ f, resources, target, r }) {
  const notes = [];
  try {
    const { glb, thumb } = await prepare(f, resources, r, notes);
    const { link, created } = await call('replaceModel', target.slug, await base64(glb), thumb, { source: f.name });
    r.progress(0.85);
    const extra = ['neue Version, gleicher Link', ...notes].join(' · ');
    r.status(`${link} · wird veröffentlicht … · ${extra}`);
    waitLive(target.slug, link, r, extra, created);
  } catch (e) {
    console.error(e); r.done(); r.status(e.message || 'Fehler beim Ersetzen', 'bad');
  }
}

async function run() {
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    if (job.target) { await replaceJob(job); continue; }
    const { f, resources, folder, r } = job;
    const notes = [];
    try {
      const { glb, thumb } = await prepare(f, resources, r, notes);
      const info = {
        title: core.titleFromFile(f.name), client: $('client').value.trim() || folder?.name || undefined,
        folder: folder?.slug, background: $('optDark').checked ? 'dark' : 'light', autoRotate: true, download: $('optDl').checked,
        source: f.name,
      };
      const { slug, link } = await call('uploadModel', await base64(glb), info, thumb);
      links.push(link);
      r.progress(0.85); r.actions({ slug, link, folder: info.folder, title: info.title });
      const extra = [folder && `📁 ${folder.name}`, ...notes].filter(Boolean).join(' · ');
      r.status(`${link} · wird veröffentlicht (ca. 1 Min.)${extra ? ' · ' + extra : ''}`);
      waitLive(slug, link, r, extra);
    } catch (e) {
      console.error(e); r.done();
      r.status(e.message || 'Fehler beim Hochladen', 'bad');
    }
  }
  busy = false;
  refreshAll();
}

async function waitLive(slug, link, r, extra, created) {
  for (let i = 0; i < 60; i++) {
    if (await core.isLive(slug, created)) { r.progress(1); r.done(); r.status(`${link} · live${extra ? ' · ' + extra : ''}`, 'ok'); return; }
    await new Promise(res => setTimeout(res, 5000));
  }
  r.done(); r.status(`${link} · noch nicht live – GitHub braucht heute länger, der Link funktioniert gleich.`);
}

$('copyAll').onclick = () => links.length && copy(links.join('\n'), 'Links');

/* ---------- Drag & Drop ---------- */
$('pick').onchange = e => { handle([...e.target.files]); e.target.value = ''; };
addEventListener('dragover', e => { e.preventDefault(); if (token || LOCAL) document.body.classList.add('dragging'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', async e => {
  e.preventDefault(); document.body.classList.remove('dragging');
  document.querySelectorAll('.item.dropover').forEach(x => x.classList.remove('dropover'));
  if (e.target.closest?.('#newFolder, #flink')) return;   // Logo-Felder nicht als Modell behandeln
  const target = e.target.closest?.('.item[data-slug]');
  const files = await filesFromDrop(e.dataTransfer);
  if (target) replaceWith(target, files); else handle(files);
});

// Datei auf ein bestehendes Modell gezogen: ohne Rückfrage neue Version drüberlegen
function replaceWith(el, files) {
  if (!token && !LOCAL) return;
  el.classList.remove('dropover');
  const { models, resources, unsupported } = groupFiles(files);
  if (LOCAL) models.push(...unsupported.filter(u => ext(u.file.name) === 'c4d').map(u => u.file));
  const f = models.find(m => ext(m.name) === 'glb') || models[0];
  const m = state.models.find(x => x.slug === el.dataset.slug) || { slug: el.dataset.slug, title: el.querySelector('.t').textContent };
  $('jobsHead').hidden = false;
  if (!f) { row($('jobs'), { title: m.title }).status(unsupported[0]?.hint || 'Keine 3D-Datei erkannt.', 'bad'); return; }
  const r = row($('jobs'), { title: `${m.title} – neue Version`, status: `Wartet … (${f.name})`, progress: true });
  r.actions(m);
  queue.push({ f, resources, target: m, r });
  if (!busy) run();
}
addEventListener('dragover', e => {
  document.querySelectorAll('.item.dropover').forEach(x => x.classList.remove('dropover'));
  e.target.closest?.('.item[data-slug]')?.classList.add('dropover');
});

/* ---------- Alle Modelle, nach Ordnern ---------- */
async function removeModel(m, el) {
  if (!confirm(`„${m.title || m.slug}“ löschen? Der Link funktioniert danach nicht mehr.`)) return;
  try { await call('deleteModel', m.slug); el.remove(); toast('Gelöscht'); refreshAll(); }
  catch (e) { alert('Löschen fehlgeschlagen: ' + e.message); }
}
async function removeFolder(f) {
  if (!confirm(`Ordner „${f.name}“ löschen?\nDie Modelle darin bleiben erhalten (ohne Ordner), nur der Ordner-Link funktioniert nicht mehr.`)) return;
  try { await call('deleteFolder', f.slug); toast('Ordner gelöscht'); refreshAll(); }
  catch (e) { alert('Löschen fehlgeschlagen: ' + e.message); }
}

function renderAll() {
  const box = $('all'); box.innerHTML = '';
  const thumbOf = m => m.thumb ? `${PAGES}m/${m.slug}/${m.thumb}?v=${encodeURIComponent(m.created || '')}` : '';
  const meta = m => [m.client, m.date, m.size ? mb(m.size) : '', m.source].filter(Boolean).join(' · ');
  const groups = [...state.folders.map(f => ({ f, items: state.models.filter(m => m.folder === f.slug) })),
    { f: null, items: state.models.filter(m => !m.folder || !state.folders.some(f => f.slug === m.folder)) }];
  for (const { f, items } of groups) {
    if (!f && !items.length) continue;
    const g = document.createElement('section'); g.className = 'group';
    const head = document.createElement('div'); head.className = 'ghead';
    if (f?.logo) {
      const im = document.createElement('img'); im.className = 'logo'; im.alt = '';
      im.onerror = () => (im.style.visibility = 'hidden');   // noch nicht veröffentlicht
      im.src = logoUrl(f); head.append(im);
    }
    const n = document.createElement('span'); n.className = 'name'; n.textContent = f ? f.name : 'Ohne Ordner'; head.append(n);
    const c = document.createElement('span'); c.className = 'cnt'; c.textContent = `${items.length} Modell${items.length === 1 ? '' : 'e'}`; head.append(c);
    if (f) {
      const b = (txt, fn, cls = '') => { const x = document.createElement('button'); x.className = 'btn2 sm ' + cls; x.textContent = txt; x.onclick = fn; head.append(x); };
      b('Ordner-Link kopieren', () => copy(f.link, 'Ordner-Link'));
      const o = document.createElement('a'); o.className = 'btn2 sm'; o.textContent = 'Öffnen'; o.href = f.link; o.target = '_blank'; o.rel = 'noopener'; head.append(o);
      b('Ordner löschen', () => removeFolder(f), 'del');
    }
    g.append(head);
    const list = document.createElement('div'); list.className = 'list'; g.append(list);
    if (!items.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Noch leer – Ordner oben auswählen und Dateien reinziehen.'; list.append(p); }
    for (const m of items) {
      const r = row(list, { title: m.title || m.slug, thumb: thumbOf(m) }, true);
      r.status(meta(m)); r.actions(m);
    }
    box.append(g);
  }
  if (!state.models.length && !state.folders.length) box.innerHTML = '<p class="empty">Noch keine Modelle.</p>';
}

async function refreshAll() {
  if (!token && !LOCAL) return;
  try {
    state = await call('listAll');
    renderFolderSelect(); renderAll();
  } catch (e) {
    $('all').innerHTML = '';
    const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Liste konnte nicht geladen werden: ' + e.message; $('all').append(p);
    if (e.status === 401) setConnected(false);
  }
}
$('reload').onclick = refreshAll;
