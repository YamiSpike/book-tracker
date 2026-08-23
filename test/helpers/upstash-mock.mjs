// Winziger Upstash-REST-Server: spricht dasselbe Protokoll wie die echte DB,
// damit die Handler UNVERAENDERT gegen @upstash/redis getestet werden koennen.
import http from 'node:http';

export function startMock() {
  const db = new Map();          // key -> { typ:'string'|'hash', val }
  const log = [];                // alle ausgefuehrten Befehle (fuer Zusicherungen)

  function run(args) {
    const cmd = String(args[0]).toLowerCase();
    log.push(cmd);
    const k = args[1];
    switch (cmd) {
      case 'get': { const e = db.get(k); return e && e.typ === 'string' ? e.val : null; }
      case 'set': { db.set(k, { typ: 'string', val: String(args[2]) }); return 'OK'; }
      case 'del': { let n = 0; for (const key of args.slice(1)) if (db.delete(key)) n++; return n; }
      case 'type': { const e = db.get(k); return e ? e.typ : 'none'; }
      case 'incr': { const e = db.get(k); const n = (e ? Number(e.val) : 0) + 1; db.set(k, { typ: 'string', val: String(n) }); return n; }
      case 'expire': return 1;
      case 'hset': {
        const e = db.get(k); const h = (e && e.typ === 'hash') ? e.val : {};
        for (let i = 2; i < args.length; i += 2) h[args[i]] = String(args[i + 1]);
        db.set(k, { typ: 'hash', val: h }); return 1;
      }
      case 'hdel': {
        const e = db.get(k); if (!e || e.typ !== 'hash') return 0;
        let n = 0; for (const f of args.slice(2)) if (delete e.val[f]) n++; return n;
      }
      case 'hgetall': {
        const e = db.get(k); if (!e || e.typ !== 'hash') return [];
        const out = []; for (const [f, v] of Object.entries(e.val)) out.push(f, v); return out;
      }
      case 'hkeys': { const e = db.get(k); return e && e.typ === 'hash' ? Object.keys(e.val) : []; }
      default: throw new Error('Mock kennt Befehl nicht: ' + cmd);
    }
  }

  // Antwort so kodieren, wie der Client sie erwartet (Upstash-Encoding: base64)
  function enc(v, b64) {
    if (!b64) return v;
    if (v === 'OK' || v === null || typeof v === 'number') return v;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? Buffer.from(x, 'utf8').toString('base64') : x));
    if (typeof v === 'string') return Buffer.from(v, 'utf8').toString('base64');
    return v;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const b64 = String(req.headers['upstash-encoding'] || '') === 'base64';
      let out;
      try {
        const body = JSON.parse(raw || '[]');
        out = Array.isArray(body[0])
          ? body.map((a) => ({ result: enc(run(a), b64) }))     // Pipeline
          : { result: enc(run(body), b64) };
      } catch (e) { out = { error: String(e.message) }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: 'http://127.0.0.1:' + server.address().port, db, log, close: () => server.close() });
    });
  });
}
