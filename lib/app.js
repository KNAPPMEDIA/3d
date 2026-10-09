import { Viewer } from './viewer.js';
import { loadAny, groupFiles, filesFromDrop, ext } from './loaders.js';
import { FeedbackRecorder, canRecord, MAX_SECONDS } from './recorder.js';

const $ = id => document.getElementById(id);
document.body.classList.add('viewer');
const params = new URLSearchParams(location.search);
const slug = (params.get('m') || '').replace(/[^a-z0-9-]/gi, '');
const src = params.get('src');
const stage = $('stage');
const viewer = new Viewer($('view3d'));
window.viewer = viewer;   // für die Browser-Konsole

/* ---------- Hintergrund ---------- */
function setBg(mode) {
  document.documentElement.dataset.bg = mode;
  $('bBgLbl').textContent = mode === 'dark' ? 'Hell' : 'Dunkel';
  viewer.setBackground(mode);
  if (stage.dataset.view !== '3d') draw2D();
}
setBg(params.get('bg') === 'dark' ? 'dark' : 'light');

/* ---------- Laden ---------- */
function fail(head, txt) {
  $('err').classList.add('on');
  $('load').hidden = true;
  for (const id of ['bar', 'hud', 'hint', 'insp']) $(id).hidden = true;
  if (head) $('errHead').textContent = head;
  if (txt) $('errTxt').textContent = txt;
}

function progress(p) {
  const l = $('load');
  if (p == null) { l.classList.add('indet'); $('loadTxt').textContent = 'Modell lädt'; return; }
  l.classList.remove('indet');
  $('fill').style.width = (p * 100).toFixed(0) + '%';
  $('loadTxt').textContent = 'Modell lädt ' + (p * 100).toFixed(0) + ' %';
}

async function fetchFile(url, name) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('404');
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total) { progress(null); return new File([await r.blob()], name); }
  const reader = r.body.getReader(), chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length; progress(Math.min(got / total, 1));
  }
  return new File(chunks, name);
}

function showChrome(info) {
  $('head').hidden = $('bar').hidden = $('hud').hidden = $('hint').hidden = false;
  $('title').textContent = info.title || 'Modell';
  $('meta').textContent = [info.client, info.note].filter(Boolean).join(' — ');
  const STATUS = { ok: 'Bestätigt', no: 'Nicht bestätigt', unsure: 'Noch unsicher' };
  $('stamp').textContent = [info.date && 'Stand ' + info.date, info.folder && STATUS[info.status || 'unsure']].filter(Boolean).join(' · ');
  if (info.folder) $('stamp').dataset.s = STATUS[info.status] ? info.status : 'unsure';
  document.title = (info.title || 'Modell') + ' · Knapp Media';
  if (info.background && !params.get('bg')) setBg(info.background);
  if (info.folder) showFolderLink(info.folder);
}

// Modell gehört zu einem Kundenordner: Logo + Weg zurück zur Übersicht
async function showFolderLink(fslug) {
  const r = await fetch(`f/${fslug}/folder.json?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
  if (!r?.ok) return;
  const f = await r.json();
  const a = document.createElement('a');
  a.href = `?f=${fslug}`;
  if (f.logo) {
    const img = new Image(); img.alt = f.name;
    img.src = `f/${fslug}/${f.logo}?v=${encodeURIComponent(f.created || '')}`;
    a.append(img);
  }
  a.append(document.createTextNode(`← Alle Modelle${f.logo ? '' : ' · ' + f.name}`));
  $('brand').replaceChildren(a);
}

async function open(info, getFile, resources, remoteUrl, arUrl) {
  showChrome(info);
  $('load').hidden = false; $('load').classList.remove('done'); progress(0);
  try {
    const file = await getFile();
    $('loadTxt').textContent = 'Modell wird aufbereitet';
    const loaded = await loadAny(file, resources, { renderer: viewer.renderer });
    viewer.setModel(loaded);
    viewer.setLight(params.get('light') || info.light || 'standard');
    if (info.exposure) viewer.renderer.toneMappingExposure = info.exposure;
    // Standard: steht still. Drehen nur per Knopf oder mit ?rotate=1 im Link
    const rot = params.get('rotate') === '1' && !loaded.animations.length;
    viewer.controls.autoRotate = rot; $('bRotate').setAttribute('aria-pressed', rot);
    $('load').classList.add('done');
    afterLoad(loaded);
    if (info.download && remoteUrl) { $('bDl').hidden = false; $('bDl').href = remoteUrl; }
    if (remoteUrl) setupAR(remoteUrl, arUrl);
    setupRec(info.title || 'Modell');
    if (loaded.notes.length) $('meta').textContent = [$('meta').textContent, ...loaded.notes].filter(Boolean).join(' — ');
  } catch (e) {
    console.error(e);
    fail('Modell konnte nicht geladen werden', e.message === '404'
      ? 'Dieser Link ist ungültig oder das Modell wurde entfernt. Bitte frag bei Knapp Media nach einem neuen Link.'
      : 'Die Datei ist beschädigt oder das Format wird nicht unterstützt. ' + (e.message || ''));
  }
}

// Frisch hochgeladene Modelle brauchen ca. 1 Minute, bis GitHub sie ausliefert: so lange geduldig nachfragen
async function fetchInfo() {
  for (let i = 0; i < 36; i++) {
    const r = await fetch(`m/${slug}/info.json?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
    if (r?.ok) return r.json();
    if (i === 0) { $('load').hidden = false; $('load').classList.add('indet'); $('loadTxt').textContent = 'Modell wird gerade veröffentlicht …'; }
    await new Promise(res => setTimeout(res, 5000));
  }
  throw new Error('404');
}

if (slug) {
  fetchInfo()
    .then(info => {
      // Gleiche URL wie für AR, damit AR das Modell aus dem Browser-Cache nimmt statt es neu zu laden
      const v = '?v=' + encodeURIComponent(info.created || '');
      const url = `m/${slug}/${info.file || 'model.glb'}${v}`;
      return open(info, () => fetchFile(url, 'model.glb'), new Map(), url, info.ar && `m/${slug}/${info.ar}${v}`);
    })
    .catch(() => fail());
} else if (src) {
  const name = decodeURIComponent(src.split('?')[0].split('/').pop()) || 'model.glb';
  open({ title: params.get('t') || name.replace(/\.[^.]+$/, '') }, () => fetchFile(src, name), new Map(), ext(name) === 'glb' ? src : null);
} else {
  $('drop').hidden = false;
}

/* ---------- Lokale Vorschau ---------- */
function openLocal(files) {
  const { models, resources, unsupported } = groupFiles(files);
  if (!models.length) {
    if (unsupported.length) alert(unsupported[0].hint);
    return;
  }
  const f = models.find(m => ext(m.name) === 'glb') || models[0];
  $('drop').hidden = true;
  open({ title: f.name.replace(/\.[^.]+$/, ''), note: 'Lokale Vorschau – nur auf diesem Rechner' }, async () => f, resources, null);
}
$('file').addEventListener('change', e => openLocal([...e.target.files]));
addEventListener('dragover', e => { e.preventDefault(); if (!slug && !src) document.body.classList.add('dragging'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', async e => {
  e.preventDefault(); document.body.classList.remove('dragging');
  if (!slug && !src) openLocal(await filesFromDrop(e.dataTransfer));
});

/* ---------- Nach dem Laden ---------- */
const fmtLen = v => v >= 1 ? v.toFixed(2) + ' m' : v >= 0.01 ? (v * 100).toFixed(1) + ' cm' : (v * 1000).toFixed(1) + ' mm';
const fmtNum = n => n.toLocaleString('de-DE');

function afterLoad(loaded) {
  const s = viewer.stats();
  $('hDim').textContent = `${fmtLen(s.size.x)} × ${fmtLen(s.size.y)} × ${fmtLen(s.size.z)}`;
  $('stats').innerHTML = '';
  const add = (dt, dd, wide) => {
    const d = document.createElement('div'); if (wide) d.className = 'wide';
    d.innerHTML = '<dt></dt><dd></dd>'; d.firstChild.textContent = dt; d.lastChild.textContent = dd; $('stats').append(d);
  };
  add('Dreiecke', fmtNum(s.tris)); add('Vertices', fmtNum(s.verts));
  add('Materialien', fmtNum(s.mats)); add('Texturen', fmtNum(s.texs));
  add('Größe (B × H × T)', `${fmtLen(s.size.x)} × ${fmtLen(s.size.y)} × ${fmtLen(s.size.z)}`, true);

  // Texturliste für 2D
  texList = viewer.textureList();
  $('texSel').innerHTML = '';
  texList.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = t.label; $('texSel').append(o); });

  // Animationen
  const clips = loaded.animations;
  $('animSec').hidden = !clips.length;
  $('clipSel').innerHTML = '';
  clips.forEach((c, i) => { const o = document.createElement('option'); o.value = i; o.textContent = c.name || `Animation ${i + 1}`; $('clipSel').append(o); });
}

/* ---------- HUD ---------- */
let lastHud = '';
viewer.onFrame = () => {
  if (!viewer.model) return;
  const o = viewer.orbit();
  const key = `${o.az.toFixed(0)}|${o.el.toFixed(0)}|${o.r.toFixed(2)}`;
  if (key === lastHud) return; lastHud = key;
  $('hAz').textContent = o.az.toFixed(0).padStart(3, ' ') + '°';
  $('hEl').textContent = o.el.toFixed(0) + '°';
  $('hR').textContent = fmtLen(o.r);
};
viewer.onUserInteract = () => $('hint').classList.add('gone');
const touch = matchMedia('(pointer: coarse)').matches;
if (touch) $('hint').textContent = '1 Finger drehen · 2 Finger zoomen und verschieben';
// iPhones können keine Webseite in Vollbild schalten
if (!document.fullscreenEnabled) $('bFs').hidden = true;
setTimeout(() => $('hint').classList.add('gone'), 8000);

/* ---------- Leiste ---------- */
$('bRotate').onclick = () => {
  viewer.controls.autoRotate = !viewer.controls.autoRotate;
  $('bRotate').setAttribute('aria-pressed', viewer.controls.autoRotate);
};
$('bReset').onclick = () => viewer.model && viewer.resetView();
$('bBg').onclick = () => setBg(document.documentElement.dataset.bg === 'dark' ? 'light' : 'dark');
$('bFs').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();

function toggleInsp(force) {
  const open = force ?? $('insp').hidden;
  $('insp').hidden = !open;
  document.body.classList.toggle('insp-open', open);
  $('bInsp').setAttribute('aria-pressed', open);
}
$('bInsp').onclick = () => toggleInsp();
$('inspClose').onclick = () => toggleInsp(false);
addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea') || !viewer.model) return;
  if (e.key === 'i' || e.key === 'I') toggleInsp();
  if (e.key === 'Escape') toggleInsp(false);
});

/* ---------- Inspektor ---------- */
function radio(group, attr, fn) {
  group.addEventListener('click', e => {
    const b = e.target.closest('[role="radio"]'); if (!b) return;
    group.querySelectorAll('[role="radio"]').forEach(x => x.setAttribute('aria-checked', x === b));
    fn(b.dataset[attr]);
  });
}
radio($('modes'), 'm', m => viewer.setMode(m));
radio($('swatches'), 'c', c => { viewer.setWire(c || null); if (stage.dataset.view !== '3d') draw2D(); });
$('wireOp').oninput = e => { $('wireVal').textContent = e.target.value + ' %'; viewer.setWire(undefined, e.target.value / 100); };
radio($('topoSeg'), 't', t => viewer.setQuads(t === 'quads'));
$('single').onchange =e => viewer.setSingleSided(e.target.checked);
radio($('viewSeg'), 'v', v => { stage.dataset.view = v; if (v !== '3d') draw2D(); });
$('texSel').onchange = draw2D;
$('clipSel').onchange = e => { viewer.playClip(+e.target.value); setPlay(true); };
function setPlay(on) { viewer.setPaused(!on); $('animPlay').textContent = on ? 'Pause' : 'Abspielen'; $('animPlay').setAttribute('aria-pressed', on); }
$('animPlay').onclick = () => setPlay($('animPlay').getAttribute('aria-pressed') !== 'true');

let texList = [];
function draw2D() {
  const entry = texList[+$('texSel').value || 0];
  const color = viewer.wire.color || getComputedStyle(document.documentElement).getPropertyValue('--select').trim() || '#F08A24';
  $('v2note').textContent = entry ? viewer.draw2D($('uvCanvas'), entry, color) : 'Keine UVs vorhanden';
}

/* ---------- Video-Feedback mit Mikrofon ---------- */
function setupRec(title) {
  if (!canRecord() || setupRec.done) return;
  setupRec.done = true;
  $('bRec').hidden = false;
  let rec = null, timer = 0, file = null, url = '';
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const note = t => { $('hint').textContent = t; $('hint').classList.remove('gone'); setTimeout(() => $('hint').classList.add('gone'), 7000); };

  $('bRec').onclick = async () => {
    if (rec) return;
    rec = new FeedbackRecorder(viewer, title);
    try { await rec.start(); }
    catch (e) { rec = null; note(e.message); return; }
    $('recPill').hidden = false; $('bRec').classList.add('on'); $('recTime').textContent = '0:00';
    timer = setInterval(() => {
      const s = rec.elapsed();
      $('recTime').textContent = fmt(s);
      if (s >= MAX_SECONDS) $('recStop').click();   // Obergrenze, damit die Datei WhatsApp-tauglich bleibt
    }, 250);
  };

  $('recStop').onclick = async () => {
    if (!rec) return;
    clearInterval(timer);
    $('recPill').hidden = true; $('bRec').classList.remove('on');
    file = await rec.stop(); rec = null;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(file);
    $('recVideo').src = url;
    // Erstes Bild als Vorschau zeigen statt schwarzer Fläche
    $('recVideo').onloadedmetadata = () => { $('recVideo').currentTime = 0.1; };
    $('recSave').href = url; $('recSave').download = file.name;
    const share = navigator.canShare?.({ files: [file] });
    $('recShare').hidden = !share;
    $('recNote').textContent = share
      ? '„Teilen“ öffnet das Teilen-Menü – dort WhatsApp wählen und an Knapp Media schicken.'
      : '„Laden“ speichert das Video. Danach in WhatsApp über die Büroklammer als Datei anhängen.';
    $('recDlg').hidden = false;
  };

  $('recShare').onclick = async () => {
    try { await navigator.share({ files: [file], title: `Feedback: ${title}` }); }
    catch (e) { if (e.name !== 'AbortError') note('Teilen ging nicht – bitte „Laden“ nutzen.'); }
  };
  $('recDiscard').onclick = () => {
    $('recDlg').hidden = true; $('recVideo').removeAttribute('src'); $('recVideo').load();
  };
  // Schließen durch Tippen neben das Fenster
  $('recDlg').onclick = e => { if (e.target === $('recDlg')) $('recDlg').hidden = true; };
  addEventListener('pagehide', () => rec?.cancel());
}

/* ---------- AR (nur Handy/Tablet) ---------- */
// url = normales Modell (liegt schon im Browser-Cache), arUrl = eigene AR-Fassung mit Innenseiten (größer, erst bei Bedarf laden)
function setupAR(url, arUrl) {
  if (!matchMedia('(pointer: coarse)').matches) return;
  // Knopf sofort zeigen; AR übernimmt Googles model-viewer (Quick Look auf iPhone, Scene Viewer auf Android)
  $('bAr').hidden = false;
  const s = document.createElement('script');
  s.type = 'module'; s.src = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js';
  document.head.append(s);
  const mv = document.createElement('model-viewer');
  const abs = u => new URL(u, location.href).href;
  if (!arUrl) mv.setAttribute('src', abs(url));
  mv.setAttribute('ar', ''); mv.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
  mv.setAttribute('ar-scale', 'auto');   // startet in echter Größe, mit zwei Fingern frei skalierbar
  mv.setAttribute('loading', 'eager'); mv.setAttribute('reveal', 'auto');
  // Muss im sichtbaren Bereich liegen, sonst lädt model-viewer das Modell nie (lädt erst bei Sichtbarkeit)
  mv.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.append(mv);
  let ready = false;
  mv.addEventListener('load', () => { ready = true; });
  const lbl = $('bAr').querySelector('.lbl'), lblText = lbl.textContent;
  const note = t => { $('hint').textContent = t; $('hint').classList.remove('gone'); setTimeout(() => $('hint').classList.add('gone'), 6000); };
  // Auswahl: echte Größe oder 5× für Details. Jeder Knopf ist ein eigenes Tippen, das erlaubt den AR-Start.
  const pick = document.createElement('div');
  pick.className = 'arpick'; pick.hidden = true;
  pick.innerHTML = '<button data-s="1"><b>Echte Größe</b><span>100 % – mit 2 Fingern zoomen</span></button>'
    + '<button data-s="5"><b>5× größer</b><span>500 % – Nähte und Details</span></button>';
  document.getElementById('stage').append(pick);
  pick.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = +b.dataset.s;
    mv.scale = `${k} ${k} ${k}`;   // gilt für iPhone (Quick Look) und Android-WebXR
    pick.hidden = true; $('bAr').classList.remove('pulse');
    mv.activateAR();
  };
  addEventListener('pointerdown', e => { if (!pick.hidden && !e.target.closest('.arpick, #bAr')) pick.hidden = true; });
  const go = () => {
    if (mv.canActivateAR) { pick.hidden = !pick.hidden; return; }
    note(/iPhone|iPad/.test(navigator.userAgent)
      ? 'AR geht nur in Safari: Link oben rechts über „…“ → „In Safari öffnen“.'
      : 'AR geht in diesem Browser nicht. Bitte den Link in Chrome öffnen.');
  };
  $('bAr').onclick = async () => {
    if (ready) return go();
    if (arUrl && !mv.getAttribute('src')) mv.setAttribute('src', abs(arUrl));   // erst jetzt die große AR-Datei laden
    lbl.textContent = 'AR lädt …'; $('bAr').disabled = true;
    await new Promise(res => { mv.addEventListener('load', res, { once: true }); setTimeout(res, 45000); });
    $('bAr').disabled = false;
    // Apple/Google erlauben AR nur direkt nach einem Tippen: Auswahl zeigen, die Wahl ist das zweite Tippen
    lbl.textContent = lblText;
    if (ready) { $('bAr').classList.add('pulse'); go(); }
    else note('Modell für AR konnte nicht geladen werden. Bitte nochmal tippen.');
  };
}
