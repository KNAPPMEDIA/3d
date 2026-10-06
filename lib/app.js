import { Viewer } from './viewer.js';
import { loadAny, groupFiles, filesFromDrop, ext } from './loaders.js';

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
  $('stamp').textContent = info.date ? 'Stand ' + info.date : '';
  document.title = (info.title || 'Modell') + ' · Knapp Media';
  if (info.background && !params.get('bg')) setBg(info.background);
}

async function open(info, getFile, resources, remoteUrl) {
  showChrome(info);
  $('load').hidden = false; $('load').classList.remove('done'); progress(0);
  try {
    const file = await getFile();
    $('loadTxt').textContent = 'Modell wird aufbereitet';
    const loaded = await loadAny(file, resources, { renderer: viewer.renderer });
    viewer.setModel(loaded);
    if (info.exposure) viewer.renderer.toneMappingExposure = info.exposure;
    const rot = info.autoRotate !== false && !loaded.animations.length;
    viewer.controls.autoRotate = rot; $('bRotate').setAttribute('aria-pressed', rot);
    $('load').classList.add('done');
    afterLoad(loaded);
    if (info.download && remoteUrl) { $('bDl').hidden = false; $('bDl').href = remoteUrl; }
    if (remoteUrl) setupAR(remoteUrl);
    if (loaded.notes.length) $('meta').textContent = [$('meta').textContent, ...loaded.notes].filter(Boolean).join(' — ');
  } catch (e) {
    console.error(e);
    fail('Modell konnte nicht geladen werden', e.message === '404'
      ? 'Dieser Link ist ungültig oder das Modell wurde entfernt. Bitte frag bei Knapp Media nach einem neuen Link.'
      : 'Die Datei ist beschädigt oder das Format wird nicht unterstützt. ' + (e.message || ''));
  }
}

if (slug) {
  fetch(`m/${slug}/info.json`, { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('404')))
    .then(info => {
      const url = `m/${slug}/${info.file || 'model.glb'}`;
      return open(info, () => fetchFile(url, 'model.glb'), new Map(), url);
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
$('single').onchange = e => viewer.setSingleSided(e.target.checked);
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

/* ---------- AR (nur Handy/Tablet) ---------- */
function setupAR(url) {
  if (!matchMedia('(pointer: coarse)').matches) return;
  const s = document.createElement('script');
  s.type = 'module'; s.src = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js';
  document.head.append(s);
  const mv = document.createElement('model-viewer');
  mv.setAttribute('src', url); mv.setAttribute('ar', ''); mv.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
  mv.setAttribute('ar-scale', 'auto');
  mv.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px';
  document.body.append(mv);
  mv.addEventListener('load', () => { if (mv.canActivateAR) $('bAr').hidden = false; });
  $('bAr').onclick = () => mv.activateAR();
}
