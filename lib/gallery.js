// Ordnerseite für Kunden: Logo + alle Modelle als Kacheln.
const $ = id => document.getElementById(id);
const slug = (new URLSearchParams(location.search).get('f') || '').replace(/[^a-z0-9-]/gi, '');
const stage = $('stage');
if (matchMedia('(pointer: coarse)').matches) document.querySelector('.gfoot').textContent = 'Tippe auf ein Modell, um es in 3D zu drehen und von allen Seiten anzusehen – auf dem Handy auch im eigenen Raum (AR).';
// Auf schmalen Handys (2 Spalten) die kurze Fassung
const narrow = matchMedia('(max-width: 560px)').matches;
const STATUS = narrow ? { ok: 'Bestätigt', no: 'Nicht bestätigt', unsure: 'Noch unsicher' }
  : { ok: 'Bestätigt, passt', no: 'Nicht bestätigt, passt nicht', unsure: 'Noch unsicher' };

function fail(head, txt) {
  stage.hidden = false;
  for (const id of ['head', 'bar', 'hud', 'hint', 'insp', 'drop', 'load']) $(id).hidden = true;
  $('err').classList.add('on'); $('errHead').textContent = head; $('errTxt').textContent = txt;
}

async function getJSON(url, tries = 1) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
    if (r?.ok) return r.json();
    if (i < tries - 1) await new Promise(res => setTimeout(res, 5000));
  }
  return null;
}

stage.hidden = true;
const gal = $('gallery');
gal.hidden = false;
$('gName').textContent = ' ';

// Frisch angelegte Ordner brauchen ca. 1 Minute, bis GitHub sie ausliefert
const folder = await getJSON(`f/${slug}/folder.json`, slug ? 24 : 0);
if (!folder) {
  gal.hidden = true;
  fail('Ordner nicht gefunden', 'Dieser Link ist ungültig oder der Ordner wurde entfernt. Bitte frag bei Knapp Media nach einem neuen Link.');
} else {
  document.title = `${folder.name} · 3D-Modelle · Knapp Media`;
  $('gName').textContent = folder.name;
  if (folder.logo) {
    const img = $('gLogo');
    img.src = `f/${slug}/${folder.logo}?v=${encodeURIComponent(folder.created || '')}`;
    img.alt = folder.name; img.hidden = false;
    img.onload = () => gal.classList.add('has-logo');
  }
  const infos = (await Promise.all((folder.models || []).map(async s => ({ slug: s, ...(await getJSON(`m/${s}/info.json`) || { missing: true }) }))))
    .filter(m => !m.missing);
  $('gCount').textContent = infos.length === 1 ? '1 Modell' : `${infos.length} Modelle`;
  const grid = $('gGrid');
  if (!infos.length) {
    const p = document.createElement('p'); p.className = 'gempty'; p.textContent = 'Hier erscheinen bald die 3D-Modelle.'; grid.append(p);
  }
  infos.forEach((m, i) => {
    const a = document.createElement('a');
    a.className = 'gcard'; a.href = `?m=${m.slug}`; a.style.setProperty('--i', i);
    a.innerHTML = `<div class="gthumb"><span class="g3d"></span></div><div class="gmeta"><h2></h2><p></p></div>`;
    const s = STATUS[m.status] ? m.status : 'unsure';
    a.querySelector('.g3d').dataset.s = s;
    a.querySelector('.g3d').textContent = STATUS[s];
    if (m.thumb) {
      const img = new Image(); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      img.src = `m/${m.slug}/${m.thumb}?v=${encodeURIComponent(m.created || '')}`;
      a.querySelector('.gthumb').prepend(img);
    } else a.querySelector('.gthumb').classList.add('nothumb');
    a.querySelector('h2').textContent = m.title || m.slug;
    a.querySelector('p').textContent = m.date ? `Stand ${m.date}` : '';
    grid.append(a);
  });
}
