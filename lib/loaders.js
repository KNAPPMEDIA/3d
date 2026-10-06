// Lädt beliebige 3D-Formate in three.js. Begleitdateien (Texturen, .mtl, .bin)
// werden über den Dateinamen zugeordnet, egal in welchem Unterordner sie lagen.
import * as THREE from 'three';

const ADDONS = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/';

export const MODEL_EXT = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', '3ds', '3mf', 'usdz'];
export const NEEDS_DESKTOP = { c4d: 'C4D: Datei auf „C4D-zu-GLB.bat“ ziehen, danach die .glb hier reinziehen.',
  blend: 'Blender: Datei > Exportieren > glTF 2.0 (.glb).', max: '3ds Max: als FBX oder glTF exportieren.',
  ma: 'Maya: als FBX exportieren.', mb: 'Maya: als FBX exportieren.', skp: 'SketchUp: als OBJ/FBX/DAE exportieren.',
  usd: 'USD: bitte als .usdz paketieren oder als glTF exportieren.', usda: 'USD: als .usdz oder glTF exportieren.', usdc: 'USD: als .usdz oder glTF exportieren.' };

export const ext = name => (name.split('.').pop() || '').toLowerCase();
const base = p => decodeURIComponent(String(p).split('?')[0].split(/[\\/]/).pop()).toLowerCase();

/** Dateien in Modelle, Begleitdateien und nicht unterstützte Formate aufteilen. */
export function groupFiles(files) {
  const models = [], resources = new Map(), unsupported = [];
  for (const f of files) {
    const e = ext(f.name);
    if (MODEL_EXT.includes(e)) models.push(f);
    else if (NEEDS_DESKTOP[e]) unsupported.push({ file: f, hint: NEEDS_DESKTOP[e] });
    resources.set(f.name.toLowerCase(), f);   // auch Modelle (.gltf + .bin etc.)
  }
  return { models, resources, unsupported };
}

/** Rekursiv Dateien aus Drag & Drop holen, auch ganze Ordner. */
export async function filesFromDrop(dt) {
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async entry => {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do { batch = await new Promise((res, rej) => reader.readEntries(res, rej)); for (const e of batch) await walk(e); } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

function makeManager(resources) {
  const manager = new THREE.LoadingManager();
  const urls = new Map();
  let pending = 0;
  manager.setURLModifier(url => {
    if (/^(data|blob):/.test(url)) return url;
    const f = resources.get(base(url));
    if (!f) return url;
    if (!urls.has(f)) urls.set(f, URL.createObjectURL(f));
    return urls.get(f);
  });
  const s = manager.itemStart.bind(manager), e = manager.itemEnd.bind(manager);
  manager.itemStart = u => { pending++; s(u); };
  manager.itemEnd = u => { pending--; e(u); };
  manager.idle = () => new Promise(res => {
    const t0 = performance.now();
    const tick = () => (pending <= 0 && performance.now() - t0 > 150) || performance.now() - t0 > 30000 ? res() : setTimeout(tick, 50);
    tick();
  });
  manager.dispose = () => urls.forEach(u => URL.revokeObjectURL(u));
  return manager;
}

let gltfLoaderCache;
export async function gltfLoader(manager, renderer) {
  const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }, { KTX2Loader }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'), import('three/addons/loaders/DRACOLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'), import('three/addons/loaders/KTX2Loader.js')]);
  const loader = new GLTFLoader(manager);
  gltfLoaderCache ??= {
    draco: new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/'),
    ktx2: new KTX2Loader().setTranscoderPath(ADDONS + 'libs/basis/'),
  };
  if (renderer && !gltfLoaderCache.ktxReady) { gltfLoaderCache.ktx2.detectSupport(renderer); gltfLoaderCache.ktxReady = true; }
  loader.setDRACOLoader(gltfLoaderCache.draco).setMeshoptDecoder(MeshoptDecoder);
  if (gltfLoaderCache.ktxReady) loader.setKTX2Loader(gltfLoaderCache.ktx2);
  return loader;
}

const neutral = () => new THREE.MeshStandardMaterial({ color: 0xb9bdc4, roughness: 0.55, metalness: 0 });

function geometryMesh(geom) {
  if (!geom.attributes.normal) geom.computeVertexNormals();
  const mat = neutral();
  if (geom.attributes.color) mat.vertexColors = true;
  return new THREE.Mesh(geom, mat);
}

/** Phong/Lambert (FBX, OBJ, DAE, 3DS) in PBR-Material umwandeln, damit alles gleich beleuchtet wird. */
function toStandard(m) {
  if (!m || m.isMeshStandardMaterial || m.isMeshBasicMaterial || m.isShaderMaterial || m.isPointsMaterial || m.isLineBasicMaterial) return m;
  const s = new THREE.MeshStandardMaterial({
    name: m.name, color: m.color, map: m.map, normalMap: m.normalMap, alphaMap: m.alphaMap, aoMap: m.aoMap,
    emissive: m.emissive, emissiveMap: m.emissiveMap, emissiveIntensity: m.emissiveIntensity ?? 1,
    bumpMap: m.bumpMap, bumpScale: m.bumpScale ?? 1, opacity: m.opacity, transparent: m.transparent,
    alphaTest: m.alphaTest, side: m.side, vertexColors: m.vertexColors, flatShading: m.flatShading,
    roughness: m.shininess !== undefined ? THREE.MathUtils.clamp(Math.sqrt(2 / (m.shininess + 2)), 0.08, 1) : 0.85,
    metalness: 0,
  });
  if (m.normalScale) s.normalScale.copy(m.normalScale);
  m.dispose();
  return s;
}

/**
 * Lädt eine Modelldatei. resources: Map(dateiname klein → File).
 * Gibt { scene, animations, notes } zurück.
 */
export async function loadAny(file, resources = new Map(), { renderer } = {}) {
  const e = ext(file.name);
  const manager = makeManager(resources);
  const notes = [];
  let scene, animations = [];
  const buf = () => file.arrayBuffer();
  const txt = () => file.text();

  switch (e) {
    case 'glb': case 'gltf': {
      const loader = await gltfLoader(manager, renderer);
      const gltf = await loader.parseAsync(e === 'gltf' ? await txt() : await buf(), '');
      scene = gltf.scene; animations = gltf.animations; break;
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
      manager.addHandler(/\.tga$/i, new TGALoader(manager));
      scene = new FBXLoader(manager).parse(await buf(), ''); animations = scene.animations || []; break;
    }
    case 'obj': {
      const [{ OBJLoader }, { MTLLoader }] = await Promise.all([import('three/addons/loaders/OBJLoader.js'), import('three/addons/loaders/MTLLoader.js')]);
      const text = await txt();
      const lib = text.match(/^mtllib\s+(.+?)\s*$/m);
      const mtl = (lib && resources.get(base(lib[1]))) || resources.get(file.name.replace(/\.obj$/i, '.mtl').toLowerCase());
      const loader = new OBJLoader(manager);
      if (mtl) { const mats = new MTLLoader(manager).parse(await mtl.text(), ''); mats.preload(); loader.setMaterials(mats); }
      else if (lib) notes.push(`Materialdatei ${lib[1]} fehlt – Modell wird grau angezeigt. Leg die .mtl und die Texturen mit dazu.`);
      scene = loader.parse(text); break;
    }
    case 'stl': {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      scene = geometryMesh(new STLLoader().parse(await buf()));
      scene.rotation.x = -Math.PI / 2;   // STL ist fast immer Z-oben
      break;
    }
    case 'ply': {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      const geom = new PLYLoader().parse(await buf());
      // Ohne Flächen ist es eine Punktwolke (z. B. Scan)
      scene = geom.index ? geometryMesh(geom)
        : new THREE.Points(geom, new THREE.PointsMaterial({ size: 0.01, sizeAttenuation: true, vertexColors: !!geom.attributes.color }));
      break;
    }
    case 'dae': {
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      const c = new ColladaLoader(manager).parse(await txt(), '');
      scene = c.scene; animations = c.scene.animations || []; break;
    }
    case '3ds': {
      const { TDSLoader } = await import('three/addons/loaders/TDSLoader.js');
      scene = new TDSLoader(manager).parse(await buf(), ''); scene.rotation.x = -Math.PI / 2; break;
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
      scene = new ThreeMFLoader(manager).parse(await buf()); scene.rotation.x = -Math.PI / 2; break;
    }
    case 'usdz': {
      const { USDZLoader } = await import('three/addons/loaders/USDZLoader.js');
      scene = new USDZLoader(manager).parse(await buf()); break;
    }
    default:
      throw new Error(NEEDS_DESKTOP[e] || `Format .${e} wird nicht unterstützt.`);
  }

  await manager.idle();

  if (e !== 'glb' && e !== 'gltf') {
    scene.traverse(o => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map(toStandard) : toStandard(o.material);
    });
    // Einheiten: riesige Modelle stammen meist aus cm- oder mm-Szenen (C4D, Max, CAD)
    const size = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3());
    const max = Math.max(size.x, size.y, size.z);
    const wrapper = new THREE.Group(); wrapper.name = file.name.replace(/\.[^.]+$/, ''); wrapper.add(scene);
    // Über 10 Einheiten = fast sicher cm (Produkte, Figuren); echte Meter-Szenen dieser Größe sind selten
    if (max > 5000) { wrapper.scale.setScalar(0.001); notes.push('Einheiten als Millimeter erkannt und in Meter umgerechnet.'); }
    else if (max > 10) { wrapper.scale.setScalar(0.01); notes.push('Einheiten als Zentimeter erkannt und in Meter umgerechnet.'); }
    scene = wrapper;
  }
  if (scene.isMesh || scene.isPoints) { const g = new THREE.Group(); g.add(scene); scene = g; }
  // Blob-URLs bewusst nicht freigeben: Texturen brauchen sie noch für Anzeige und Export
  return { scene, animations, notes };
}

/**
 * Meshes mit mehreren Materialien in je ein Mesh pro Material zerlegen und doppelte Vertices
 * zusammenführen. Sonst schreibt der Exporter die komplette Geometrie für jedes Material neu
 * (12 Materialien = 12-fache Dateigröße).
 */
async function optimize(scene) {
  const { mergeVertices } = await import('three/addons/utils/BufferGeometryUtils.js');
  const meshes = [];
  scene.traverse(o => { if (o.isMesh && !o.isSkinnedMesh && !o.morphTargetInfluences) meshes.push(o); });
  for (const mesh of meshes) {
    const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const mats = [].concat(mesh.material);
    const groups = Array.isArray(mesh.material) && src.groups.length ? src.groups : [{ start: 0, count: src.attributes.position.count, materialIndex: 0 }];
    const parts = groups.map(g => {
      const geo = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(src.attributes)) {
        const s = attr.itemSize;
        geo.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(g.start * s, (g.start + g.count) * s), s, attr.normalized));
      }
      return { geo: mergeVertices(geo), mat: mats[g.materialIndex] || mats[0] };
    }).filter(p => p.geo.attributes.position.count);
    if (parts.length === 1) { mesh.geometry = parts[0].geo; mesh.material = parts[0].mat; continue; }
    const group = new THREE.Group();
    group.name = mesh.name; group.position.copy(mesh.position); group.quaternion.copy(mesh.quaternion); group.scale.copy(mesh.scale);
    parts.forEach((p, i) => { const m = new THREE.Mesh(p.geo, p.mat); m.name = `${mesh.name || 'Mesh'}_${p.mat.name || i}`; group.add(m); });
    mesh.parent.add(group); mesh.removeFromParent();
  }
}

/** Szene als GLB (ArrayBuffer) exportieren. */
export async function exportGLB(scene, animations = []) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  if (!animations.length) await optimize(scene);
  scene.updateMatrixWorld(true);
  return new GLTFExporter().parseAsync(scene, { binary: true, animations, onlyVisible: true, maxTextureSize: 4096 });
}
