// 3D-Viewer mit Modell-Inspektor (three.js).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

const BACKDROP = {
  light: { top: '#F1F2F4', floor: '#D3D6DB', ink: '#1D2024' },
  dark:  { top: '#2B2F35', floor: '#111316', ink: '#ECEDEF' },
};
const isCoarse = matchMedia('(pointer: coarse)').matches;

/* ---------- Hilfstexturen ---------- */
function canvasTex(size, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function backdropTex(mode) {
  const b = BACKDROP[mode];
  return canvasTex(512, (g, s) => {
    const lin = g.createLinearGradient(0, 0, 0, s);
    lin.addColorStop(0, b.top); lin.addColorStop(0.38, b.top); lin.addColorStop(1, b.floor);
    g.fillStyle = lin; g.fillRect(0, 0, s, s);
    const rad = g.createRadialGradient(s / 2, s * 1.08, 0, s / 2, s * 1.08, s * 0.7);
    rad.addColorStop(0, 'rgba(0,0,0,.10)'); rad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rad; g.fillRect(0, 0, s, s);
  });
}
const matcapTex = () => canvasTex(256, (g, s) => {
  g.fillStyle = '#2a2c30'; g.fillRect(0, 0, s, s);
  const r = g.createRadialGradient(s * .36, s * .32, s * .02, s * .5, s * .5, s * .52);
  r.addColorStop(0, '#fbf7f2'); r.addColorStop(.35, '#cfc6bb'); r.addColorStop(.75, '#7d756d'); r.addColorStop(1, '#2f2b28');
  g.fillStyle = r; g.beginPath(); g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); g.fill();
});
const checkerTex = () => {
  const t = canvasTex(1024, (g, s) => {
    const n = 8, c = s / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const hue = (x / n) * 300;
      g.fillStyle = (x + y) % 2 ? `hsl(${hue},55%,62%)` : `hsl(${hue},45%,84%)`;
      g.fillRect(x * c, y * c, c, c);
      g.fillStyle = 'rgba(0,0,0,.72)'; g.font = `600 ${c * .32}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String.fromCharCode(65 + x) + (n - y), x * c + c / 2, y * c + c / 2);
    }
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 2;
    for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * c, 0); g.lineTo(i * c, s); g.moveTo(0, i * c); g.lineTo(s, i * c); g.stroke(); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
};

/* ---------- Kontaktschatten: Tiefe von unten gerendert und weichgezeichnet (wie Studio-Fotos) ---------- */
class ContactShadow {
  constructor(renderer) {
    this.renderer = renderer;
    this.group = new THREE.Group(); this.group.userData.helper = true;
    const rt = () => { const t = new THREE.WebGLRenderTarget(512, 512); t.texture.generateMipmaps = false; return t; };
    this.rt = rt(); this.rtBlur = rt();
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
    this.plane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.rt.texture, transparent: true, depthWrite: false, opacity: 0.9 }));
    this.plane.renderOrder = -1; this.plane.scale.y = -1;
    this.blurPlane = new THREE.Mesh(geo); this.blurPlane.visible = false;
    this.cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1); this.cam.rotation.x = Math.PI / 2;
    this.group.add(this.plane, this.blurPlane, this.cam);
    this.depth = new THREE.MeshDepthMaterial({ depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.depth.onBeforeCompile = s => {
      s.uniforms.darkness = { value: 2.2 };
      s.fragmentShader = 'uniform float darkness;\n' + s.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );');
    };
    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader); this.hBlur.depthTest = false;
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader); this.vBlur.depthTest = false;
  }
  fit(size, r) {
    const w = Math.max(size.x, size.z) * 1.9 + r * 0.6;
    this.plane.scale.set(w, -w, w); this.blurPlane.scale.set(w, w, w);
    this.cam.left = this.cam.bottom = -w / 2; this.cam.right = this.cam.top = w / 2;
    // Kamera knapp unter dem Boden, damit flache Unterseiten (Würfel, Dosen) mit im Bild sind
    const below = r * 0.01;
    this.cam.position.y = -below;
    this.cam.far = Math.max(size.y * 0.4, r * 0.2) + below; this.cam.updateProjectionMatrix();
    this.group.position.y = r * 0.0005;
  }
  blur(amount) {
    const R = this.renderer;
    this.blurPlane.visible = true;
    this.blurPlane.material = this.hBlur; this.hBlur.uniforms.tDiffuse.value = this.rt.texture; this.hBlur.uniforms.h.value = amount / 256;
    R.setRenderTarget(this.rtBlur); R.render(this.blurPlane, this.cam);
    this.blurPlane.material = this.vBlur; this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture; this.vBlur.uniforms.v.value = amount / 256;
    R.setRenderTarget(this.rt); R.render(this.blurPlane, this.cam);
    this.blurPlane.visible = false;
  }
  render(scene) {
    const R = this.renderer, bg = scene.background, alpha = R.getClearAlpha(), tm = R.toneMapping;
    const hidden = [];
    scene.traverse(o => { if (o.userData.helper && o !== this.group && o.visible) { o.visible = false; hidden.push(o); } });
    this.plane.visible = false; scene.background = null; scene.overrideMaterial = this.depth;
    R.setClearAlpha(0); R.toneMapping = THREE.NoToneMapping;
    R.setRenderTarget(this.rt); R.clear(); R.render(scene, this.cam);
    scene.overrideMaterial = null;
    this.blur(3.2); this.blur(1.2);
    R.setRenderTarget(null); R.setClearAlpha(alpha); R.toneMapping = tm;
    scene.background = bg; this.plane.visible = true;
    hidden.forEach(o => (o.visible = true));
  }
}

const TEX_SLOTS =[['map', 'Basisfarbe'], ['normalMap', 'Normal'], ['roughnessMap', 'Rauheit'], ['metalnessMap', 'Metall'],
  ['aoMap', 'Occlusion'], ['emissiveMap', 'Emission'], ['alphaMap', 'Deckkraft'], ['bumpMap', 'Bump']];

/* ---------- Viewer ---------- */
export class Viewer {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 1.35;
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 1.2;
    this.controls.addEventListener('start', () => this.onUserInteract?.());

    this.key = new THREE.DirectionalLight(0xffffff, 0.9);
    this.scene.add(this.key, this.key.target);
    this.contact = new ContactShadow(this.renderer);
    this.ground = this.contact.group;
    this.scene.add(this.ground);

    // Final Render = Ambient Occlusion (N8AO). Nur auf Desktop, auf Handys spart das Akku.
    this.usePost = false;
    if (!isCoarse) import('n8ao').then(({ N8AOPass }) => {
      this.composer = new EffectComposer(this.renderer);
      this.ao = new N8AOPass(this.scene, this.camera, 1, 1);
      Object.assign(this.ao.configuration, { gammaCorrection: false, intensity: 2.2, aoSamples: 16, denoiseSamples: 8, denoiseRadius: 12 });
      this.composer.addPass(this.ao);
      this.composer.addPass(new OutputPass());
      this.usePost = true; this.resize(); this.fitAO();
    }).catch(e => console.warn('Ambient Occlusion nicht verfügbar', e));

    this.clock = new THREE.Clock();
    this.mode = 'final';
    this.singleSided = false;
    this.wire = { color: null, opacity: 0.6 };
    this.overrides = new Map();
    this.setBackground('light');
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setBackground(mode) {
    this.bgMode = mode;
    this.scene.background?.dispose?.();
    this.scene.background = backdropTex(mode);
    if (this.mode === 'wireframe') this.applyMode();
  }

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  frame() {
    const dt = this.clock.getDelta();
    this.mixer?.update(dt);
    if (this.mixer && this.model) this.contact.render(this.scene);   // Schatten folgt der Animation
    this.controls.update();
    if (this.usePost && this.mode === 'final') this.composer.render(); else this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  }

  setModel({ scene, animations = [] }) {
    if (this.model) { this.scene.remove(this.model); }
    this.model = scene; this.overrides.clear(); this.wireMeshes = null;
    this.meshes = [];
    scene.traverse(o => {
      if (o.isMesh) { o.userData.orig = o.material; this.meshes.push(o); }
    });
    // Auf den Boden stellen und mittig ausrichten
    const box = new THREE.Box3().setFromObject(scene);
    const c = box.getCenter(new THREE.Vector3());
    scene.position.x -= c.x; scene.position.z -= c.z; scene.position.y -= box.min.y;
    this.scene.add(scene);
    this.box = new THREE.Box3().setFromObject(scene);
    this.size = this.box.getSize(new THREE.Vector3());
    this.radius = Math.max(this.box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);

    const r = this.radius;
    this.key.position.set(r * 1.2, r * 3, r * 1.5);
    this.camera.near = r / 200; this.camera.far = r * 200; this.camera.updateProjectionMatrix();
    this.controls.minDistance = r * 0.25; this.controls.maxDistance = r * 12;
    this.fitAO();
    this.resetView(true);

    this.mixer = null; this.animations = animations;
    if (animations.length) { this.mixer = new THREE.AnimationMixer(scene); this.playClip(0); }
    this.applyMode(); this.applySide(); this.applyWire();
    this.contact.fit(this.size, r);
    this.contact.render(this.scene);
  }

  fitAO() {
    if (!this.ao || !this.radius) return;
    this.ao.configuration.aoRadius = this.radius * 0.18;
    this.ao.configuration.distanceFalloff = 1.0;
  }

  resetView(instant) {
    const r = this.radius, target = new THREE.Vector3(0, this.size.y / 2, 0);
    // Im Hochformat begrenzt die Breite, nicht die Höhe
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const half = Math.min(vHalf, Math.atan(Math.tan(vHalf) * this.camera.aspect));
    const dist = r / Math.sin(half) * 1.05;
    const az = THREE.MathUtils.degToRad(35), el = THREE.MathUtils.degToRad(18);
    const pos = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist).add(target);
    if (instant || !this.model) { this.camera.position.copy(pos); this.controls.target.copy(target); this.controls.update(); return; }
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone(), start = performance.now();
    const step = now => {
      const k = Math.min((now - start) / 600, 1), e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(p0, pos, e); this.controls.target.lerpVectors(t0, target, e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  orbit() {
    const o = this.camera.position.clone().sub(this.controls.target), r = o.length();
    return { az: (THREE.MathUtils.radToDeg(Math.atan2(o.x, o.z)) + 360) % 360, el: THREE.MathUtils.radToDeg(Math.asin(o.y / r)), r };
  }

  stats() {
    let tris = 0, verts = 0; const mats = new Set(), texs = new Set();
    for (const m of this.meshes) {
      const g = m.geometry; verts += g.attributes.position.count;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      [].concat(m.userData.orig).forEach(mt => { mats.add(mt); TEX_SLOTS.forEach(([k]) => mt[k] && texs.add(mt[k])); });
    }
    return { tris: Math.round(tris), verts, mats: mats.size, texs: texs.size, size: this.size };
  }

  /* ----- Darstellungsmodi ----- */
  override(orig) {
    const key = this.mode + ':' + orig.uuid;
    if (this.overrides.has(key)) return this.overrides.get(key);
    let m;
    const side = orig.side;
    switch (this.mode) {
      case 'basecolor':
        m = new THREE.MeshBasicMaterial({ map: orig.map || null, color: orig.color ? orig.color.clone() : 0xffffff, vertexColors: orig.vertexColors, side });
        break;
      case 'opacity':
        m = new THREE.MeshBasicMaterial({ map: orig.map || null, alphaMap: orig.alphaMap || null, opacity: orig.opacity ?? 1, side });
        m.onBeforeCompile = s => { s.fragmentShader = s.fragmentShader.replace('#include <opaque_fragment>', 'gl_FragColor = vec4(vec3(diffuseColor.a), 1.0);'); };
        m.customProgramCacheKey = () => 'opacity-view';
        break;
      case 'matcap':
        this.matcap ??= matcapTex();
        m = new THREE.MeshMatcapMaterial({ matcap: this.matcap, normalMap: orig.normalMap || null, side });
        break;
      case 'wireframe':
        m = new THREE.MeshBasicMaterial({ color: BACKDROP[this.bgMode].ink, wireframe: true, side });
        break;
      case 'normals':
        m = new THREE.MeshNormalMaterial({ normalMap: orig.normalMap || null, side });
        break;
      case 'uv':
        this.checker ??= checkerTex();
        m = new THREE.MeshBasicMaterial({ map: this.checker, side });
        break;
    }
    m.userData.side0 = side;
    this.overrides.set(key, m);
    return m;
  }

  setMode(mode) { this.mode = mode; this.applyMode(); }
  applyMode() {
    if (!this.meshes) return;
    const orig = this.mode === 'final' || this.mode === 'nopost';
    if (this.mode === 'wireframe') for (const [k, m] of this.overrides) if (k.startsWith('wireframe:')) m.color.set(BACKDROP[this.bgMode].ink);
    for (const mesh of this.meshes) {
      const o = mesh.userData.orig;
      mesh.material = orig ? o : Array.isArray(o) ? o.map(x => this.override(x)) : this.override(o);
    }
    this.ground.visible = this.mode !== 'wireframe' && this.mode !== 'uv';
    this.applySide();
  }

  setSingleSided(on) { this.singleSided = on; this.applySide(); }
  applySide() {
    if (!this.meshes) return;
    for (const mesh of this.meshes) for (const m of [].concat(mesh.material)) {
      if (m.userData.side0 === undefined) m.userData.side0 = m.side;
      const want = this.singleSided ? THREE.FrontSide : m.userData.side0;
      if (m.side !== want) { m.side = want; m.needsUpdate = true; }
    }
  }

  setWire(color, opacity) {
    if (color !== undefined) this.wire.color = color;
    if (opacity !== undefined) this.wire.opacity = opacity;
    this.applyWire();
  }
  applyWire() {
    if (!this.meshes) return;
    const on = !!this.wire.color;
    if (on && !this.wireMeshes) {
      this.wireMat = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth });
      this.wireMeshes = this.meshes.map(mesh => {
        const w = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, this.wireMat) : new THREE.Mesh(mesh.geometry, this.wireMat);
        if (mesh.isSkinnedMesh) w.bind(mesh.skeleton, mesh.bindMatrix);
        w.morphTargetInfluences = mesh.morphTargetInfluences; w.morphTargetDictionary = mesh.morphTargetDictionary;
        w.renderOrder = 10; w.userData.helper = true;
        mesh.add(w); return w;
      });
    }
    if (this.wireMeshes) {
      this.wireMeshes.forEach(w => (w.visible = on));
      if (on) { this.wireMat.color.set(this.wire.color); this.wireMat.opacity = this.wire.opacity; }
    }
  }

  /* ----- Animation ----- */
  playClip(i) {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    this.action = this.mixer.clipAction(this.animations[i]); this.action.play();
  }
  setPaused(p) { if (this.action) this.action.paused = p; }

  /* ----- 2D: Texturen und UV-Layout ----- */
  textureList() {
    const list = [], seen = new Set();
    for (const mesh of this.meshes || []) for (const m of [].concat(mesh.userData.orig)) {
      if (seen.has(m)) continue; seen.add(m);
      const name = m.name || 'Material';
      let any = false;
      for (const [k, label] of TEX_SLOTS) if (m[k]) { list.push({ mat: m, tex: m[k], label: `${name} · ${label}` }); any = true; }
      if (!any) list.push({ mat: m, tex: null, label: `${name} · nur UVs` });
    }
    return list;
  }

  draw2D(canvas, entry, lineColor) {
    const s = canvas.width, g = canvas.getContext('2d');
    g.clearRect(0, 0, s, s);
    // Schachbrett als Hintergrund für Transparenz
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { g.fillStyle = (x + y) % 2 ? '#c9ccd1' : '#e6e7e9'; g.fillRect(x * s / 16, y * s / 16, s / 16, s / 16); }
    let flipY = true, note = '';
    if (entry?.tex) {
      const img = entry.tex.image; flipY = entry.tex.flipY;
      try {
        if (img?.data && img.width) {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const d = new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4), img.width, img.height);
          c.getContext('2d').putImageData(d, 0, 0);
          g.save(); if (flipY) { g.translate(0, s); g.scale(1, -1); } g.drawImage(c, 0, 0, s, s); g.restore();
        } else if (img && (img.width || img.videoWidth)) g.drawImage(img, 0, 0, s, s);
        else note = 'Komprimierte Textur – Vorschau nicht möglich';
      } catch { note = 'Textur kann nicht angezeigt werden'; }
    }
    // UV-Kanten der Meshes mit diesem Material
    g.strokeStyle = lineColor; g.lineWidth = Math.max(1, s / 1024); g.globalAlpha = 0.85; g.beginPath();
    let budget = 250000;
    for (const mesh of this.meshes || []) {
      const mats = [].concat(mesh.userData.orig), slot = mats.indexOf(entry?.mat);
      if (slot < 0) continue;
      const geo = mesh.geometry, uv = geo.attributes.uv; if (!uv) continue;
      const idx = geo.index, n = idx ? idx.count : uv.count;
      const ranges = Array.isArray(mesh.userData.orig) && geo.groups.length ? geo.groups.filter(gr => gr.materialIndex === slot) : [{ start: 0, count: n }];
      const Y = v => (flipY ? 1 - v : v) * s;
      for (const r of ranges) for (let i = r.start; i < r.start + r.count - 2 && budget > 0; i += 3, budget--) {
        const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
        g.moveTo(uv.getX(a) * s, Y(uv.getY(a))); g.lineTo(uv.getX(b) * s, Y(uv.getY(b)));
        g.lineTo(uv.getX(c) * s, Y(uv.getY(c))); g.closePath();
      }
    }
    g.stroke(); g.globalAlpha = 1;
    return budget <= 0 ? 'UV-Layout gekürzt (sehr viele Polygone)' : note;
  }
}
