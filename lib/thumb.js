// Vorschaubild (WebP, Base64) im selben Look wie der Viewer – für die Kachel auf der Ordnerseite.
import { Viewer } from './viewer.js';

export async function makeThumb(loaded, size = 720) {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-${size * 2}px;top:0;width:${size}px;height:${size}px;pointer-events:none`;
  document.body.append(host);
  const v = new Viewer(host, { post: false });
  try {
    v.renderer.setPixelRatio(1); v.resize();
    v.controls.autoRotate = false;
    v.setModel(loaded);
    v.frame();
    // toBlob kopiert das Bild sofort, deshalb direkt nach dem Rendern aufrufen
    const blob = await new Promise(res => v.renderer.domElement.toBlob(res, 'image/webp', 0.86));
    const url = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    return url.slice(url.indexOf(',') + 1);
  } finally {
    v.renderer.setAnimationLoop(null);
    v.renderer.dispose(); v.renderer.forceContextLoss();
    host.remove();
  }
}
