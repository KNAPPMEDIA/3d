// Video-Feedback: nimmt die 3D-Ansicht samt Mikrofon auf, damit Kunden am Handy beim Drehen
// des Modells einfach sprechen können. Ergebnis ist eine Videodatei zum Teilen (WhatsApp) oder Speichern.

const MIMES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const MAX_SECONDS = 180;

export function canRecord() {
  return !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia && HTMLCanvasElement.prototype.captureStream);
}

export class FeedbackRecorder {
  constructor(viewer, title) {
    this.viewer = viewer; this.title = title;
  }

  /** Fragt das Mikrofon an und startet. Wirft einen Fehler mit verständlichem Text, wenn es nicht geht. */
  async start() {
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      throw new Error(e?.name === 'NotAllowedError'
        ? 'Mikrofon ist blockiert. Bitte in den Einstellungen bzw. über das „aA“-Menü in Safari das Mikrofon für diese Seite erlauben.'
        : 'Kein Mikrofon gefunden.');
    }
    const src = this.viewer.renderer.domElement;
    // Ausgabe max. 1280 px an der langen Seite, gerade Maße (manche Encoder verlangen das)
    const k = Math.min(1, 1280 / Math.max(src.width, src.height));
    const w = Math.round(src.width * k / 2) * 2, h = Math.round(src.height * k / 2) * 2;
    this.canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.ctx = this.canvas.getContext('2d');
    this.t0 = performance.now();
    // Direkt nach jedem Rendern abzeichnen, solange das WebGL-Bild noch im Puffer liegt
    this.viewer.afterRender = () => this.draw();
    this.draw();

    const stream = new MediaStream([...this.canvas.captureStream(30).getVideoTracks(), ...this.mic.getAudioTracks()]);
    this.mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) || '';
    this.rec = new MediaRecorder(stream, { ...(this.mime && { mimeType: this.mime }), videoBitsPerSecond: 4_000_000 });
    this.chunks = [];
    this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.rec.start(1000);
  }

  elapsed() { return (performance.now() - this.t0) / 1000; }

  draw() {
    const { ctx, canvas: c } = this, w = c.width, h = c.height, s = Math.max(w, h) / 1000;
    ctx.drawImage(this.viewer.renderer.domElement, 0, 0, w, h);
    // Kopfzeile, damit man im Chat sofort sieht, um welches Modell es geht
    const g = ctx.createLinearGradient(0, 0, 0, 120 * s);
    g.addColorStop(0, 'rgba(0,0,0,.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, 120 * s);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
    ctx.font = `700 ${Math.round(30 * s)}px Archivo, system-ui, sans-serif`;
    ctx.fillText(this.title, 24 * s, 22 * s, w - 48 * s);
    ctx.font = `500 ${Math.round(15 * s)}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.globalAlpha = .85;
    ctx.fillText(`3D-FEEDBACK · ${new Date().toLocaleDateString('de-DE')} · KNAPP MEDIA`, 24 * s, 62 * s, w - 48 * s);
    ctx.globalAlpha = 1;
  }

  /** Beendet die Aufnahme und liefert die Videodatei. */
  stop() {
    return new Promise(res => {
      this.rec.onstop = () => {
        this.viewer.afterRender = null;
        this.mic.getTracks().forEach(t => t.stop());
        const type = (this.rec.mimeType || this.mime || 'video/mp4').split(';')[0];
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const d = new Date(), p2 = n => String(n).padStart(2, '0');   // Ortszeit, nicht UTC
        const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}`;
        const name = `Feedback_${this.title.replace(/[^\wäöüÄÖÜß-]+/g, '_')}_${stamp}.${ext}`;
        res(new File(this.chunks, name, { type }));
      };
      this.rec.stop();
    });
  }

  cancel() {
    if (this.rec?.state === 'recording') this.rec.stop();
    this.viewer.afterRender = null;
    this.mic?.getTracks().forEach(t => t.stop());
  }
}
