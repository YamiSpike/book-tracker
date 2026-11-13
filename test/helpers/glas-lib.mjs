/**
 * glas-lib.mjs — Bild-Hilfen fuer scripts/glas-check.mjs (aus Japan Navigator, scripts/nav-glas-lib.mjs): PNG-Leser, Kontrast an echten
 * Pixeln, Pixelvergleich und die Kontrollprobe, ob eine Engine backdrop-filter ueberhaupt zeichnet.
 */
import zlib from 'node:zlib';

export const warte = ms => new Promise(r => setTimeout(r, ms));

// Minimaler PNG-Leser (8 Bit, RGB/RGBA, nicht verschachtelt)
export function png(buf) {
  let o = 8, w, h, ct; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), typ = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (typ === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (typ === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), st = w * bpp, out = Buffer.alloc(h * st);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (st + 1)], src = raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1));
    for (let x = 0; x < st; x++) {
      const a = x >= bpp ? out[y * st + x - bpp] : 0, b = y > 0 ? out[(y - 1) * st + x] : 0, c = x >= bpp && y > 0 ? out[(y - 1) * st + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * st + x] = v & 255;
    }
  }
  return { w, h, bpp, d: out };
}
const lum = (r, g, b) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };

// Hintergrund = haeufigste (grob gerasterte) Farbe, Schrift = Pixel am 90. Perzentil der Abstaende
// zum Hintergrund (nicht der einzelne Extremwert: ein heller Kantenpixel soll nicht reichen)
export function kontrast(buf) {
  const im = png(buf), zaehl = new Map();
  for (let i = 0; i < im.d.length; i += im.bpp) { const k = (im.d[i] >> 4) << 8 | (im.d[i + 1] >> 4) << 4 | im.d[i + 2] >> 4; zaehl.set(k, (zaehl.get(k) || 0) + 1); }
  let bk = 0, bn = 0; for (const [k, n] of zaehl) if (n > bn) { bn = n; bk = k; }
  const bg = [(bk >> 8 & 15) * 17, (bk >> 4 & 15) * 17, (bk & 15) * 17];
  const ab = [];
  for (let i = 0; i < im.d.length; i += im.bpp) {
    const dd = Math.abs(im.d[i] - bg[0]) + Math.abs(im.d[i + 1] - bg[1]) + Math.abs(im.d[i + 2] - bg[2]);
    if (dd > 30) ab.push([dd, im.d[i], im.d[i + 1], im.d[i + 2]]);
  }
  ab.sort((a, b) => a[0] - b[0]);
  const pick = ab.length ? ab[Math.floor(ab.length * .9)] : null;
  if (!pick) return 0;   // kein Text gefunden: als Fehler werten, nicht als Erfolg
  const l1 = lum(pick[1], pick[2], pick[3]), l2 = lum(...bg);
  return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
}
export async function kontrastPruefen(p, lbl, wo, fehler) {
  for (let i = 0; i < lbl.length; i++) {
    const buf = await p.screenshot({ clip: lbl[i] }), c = kontrast(buf);
    if (process.env.GLAS_DUMP && c < 4.5) { const fs = await import('node:fs'); fs.writeFileSync(process.env.GLAS_DUMP + wo.replace(/\W+/g, '_') + '-' + i + '.png', buf); fs.writeFileSync(process.env.GLAS_DUMP + wo.replace(/\W+/g, '_') + '-ganz.png', await p.screenshot()); }
    if (c < 4.5) fehler.push('[' + wo + '] Kontrast Knopf ' + i + ': ' + c.toFixed(2) + ' : 1 (< 4.5)');
  }
}

// Mittlere Abweichung (0 bis 255) zweier gleich grosser Aufnahmen
export function diffMittel(a, b) {
  const A = png(a), B = png(b);
  if (A.w !== B.w || A.h !== B.h) return 999;
  let s = 0, n = 0;
  for (let i = 0; i < A.d.length; i += A.bpp) { s += (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2])) / 3; n++; }
  return s / n;
}

// Kontrollprobe: zeichnet diese Engine backdrop-filter? (Playwright-WebKit unter Windows nicht.)
export async function blurProbe(p) {
  await p.evaluate(() => {
    const d = document.createElement('div'); d.id = 'x-probe';
    d.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:80px;z-index:2147483647;background:repeating-linear-gradient(90deg,#fff 0 6px,#000 6px 12px)';
    const g = document.createElement('div'); g.id = 'x-probe-g';
    g.style.cssText = 'position:absolute;inset:20px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)';
    d.appendChild(g); document.body.appendChild(d);
  });
  await warte(300);
  const clip = { x: 20, y: 20, width: 80, height: 40 };
  const mit = await p.screenshot({ clip });
  await p.evaluate(() => { const g = document.getElementById('x-probe-g'); g.style.setProperty('-webkit-backdrop-filter', 'none'); g.style.setProperty('backdrop-filter', 'none'); });
  await warte(300);
  const ohne = await p.screenshot({ clip });
  await p.evaluate(() => document.getElementById('x-probe')?.remove());
  return diffMittel(mit, ohne) > 20;
}
