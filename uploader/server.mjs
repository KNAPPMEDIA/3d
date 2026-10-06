// Lokaler Uploader: liefert die Upload-Seite aus und lädt über den GitHub-Login dieses PCs hoch
// (gh auth token) – kein Schlüssel im Browser nötig. Konvertiert außerdem .c4d über c4dpy.
import http from 'node:http';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { execFile, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = 8795;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C4DPY = 'C:\\Program Files\\Maxon Cinema 4D 2026\\c4dpy.exe';
const core = await import(pathToFileURL(path.join(ROOT, 'lib', 'upload-core.js')));
const CALLS = ['uploadModel', 'replaceModel', 'moveModel', 'setInfo', 'deleteModel', 'createFolder', 'setFolderLogo', 'deleteFolder', 'listAll'];

function token() {
  try { return execSync('gh auth token', { encoding: 'utf8', windowsHide: true }).trim(); }
  catch { throw new Error('GitHub-Login fehlt. Im Terminal einmal „gh auth login“ ausführen.'); }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.png': 'image/png' };

const body = req => new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); });
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };

async function convertC4D(buf, name) {
  const dir = await mkdtemp(path.join(tmpdir(), 'c4d-'));
  try {
    const src = path.join(dir, name.replace(/[^\w.\- ]/g, '_'));
    await writeFile(src, buf);
    const out = await new Promise(resolve => execFile(C4DPY, [path.join(ROOT, 'c4d', 'c4d_zu_glb.py'), src],
      { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(String(stdout || ''))));
    const glb = src.replace(/\.c4d$/i, '.glb');
    try { await stat(glb); } catch { throw new Error('C4D-Export fehlgeschlagen. ' + (out.match(/FEHLER.*/)?.[0] || '')); }
    const note = out.match(/(\d+) Octane-Material/)?.[1];
    return { glb: await readFile(glb), note: note && note !== '0' ? `${note} Octane-Material(ien) in Standardmaterial umgewandelt` : '' };
  } finally { rm(dir, { recursive: true, force: true }); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/status') return json(res, 200, { ok: !!token(), c4d: await stat(C4DPY).then(() => true, () => false) });
    // Ein Aufruf für alle Repo-Funktionen: { fn, args } → core[fn](token, ...args)
    if (url.pathname === '/api/call' && req.method === 'POST') {
      const { fn, args = [] } = JSON.parse((await body(req)).toString('utf8'));
      if (!CALLS.includes(fn)) return json(res, 400, { error: 'Unbekannte Funktion' });
      return json(res, 200, (await core[fn](token(), ...args)) ?? { ok: true });
    }
    if (url.pathname === '/api/c4d' && req.method === 'POST') {
      const { glb, note } = await convertC4D(await body(req), url.searchParams.get('name') || 'szene.c4d');
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'X-Note': encodeURIComponent(note) }); return res.end(glb);
    }
    // Statische Dateien aus dem Repo
    let p = decodeURIComponent(url.pathname); if (p === '/') p = '/upload.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || /[\\/](\.git|uploader)[\\/]/.test(file)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('Nicht gefunden'); }
    console.error(e); json(res, 500, { error: e.message });
  }
}).on('error', e => {
  // Läuft schon: nur die Seite öffnen
  if (e.code === 'EADDRINUSE') { openBrowser(); setTimeout(() => process.exit(0), 500); } else throw e;
}).listen(PORT, '127.0.0.1', () => {
  console.log(`3D-Upload läuft: http://localhost:${PORT}  (Fenster offen lassen)`);
  openBrowser();
});

function openBrowser() {
  if (process.argv.includes('--open')) execFile('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { windowsHide: true });
}
