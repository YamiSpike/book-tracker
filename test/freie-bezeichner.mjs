// Sucht in js/*.js Bezeichner, die benutzt, aber nirgends deklariert werden —
// und die auch kein bekannter Browser-Globalname sind. Unter 'use strict' ist so
// etwas ein ReferenceError, und zwar erst beim Aufruf der betroffenen Funktion.
//
// Genau das ist das Restrisiko der Modul-Aufteilung aus v3.6: eine verschobene
// Funktion ruft etwas, das im Kern zurueckgeblieben ist und im Kopf des Teilmoduls
// fehlt. Der Bindungs-Test sieht nur H.-Zugriffe; hier schaut ein echter Parser hin.
//
// Bewusst grob bei Gueltigkeitsbereichen: es zaehlt, ob ein Name IRGENDWO in der
// Datei deklariert wird. Verschattung wird also nicht bewertet — dafuer gibt es
// keine falschen Alarme, und der Fall, auf den es ankommt (Name kommt in der Datei
// ueberhaupt nicht vor), wird sicher gefunden.
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';

let ok = 0, bad = 0;
const pruefe = (n, b, i) => b ? (ok++, console.log('  [ok] ' + n))
                              : (bad++, console.log('  [FEHLER] ' + n + (i ? '  -> ' + i : '')));

// Was der Browser bereitstellt. Fehlt hier etwas, meldet der Test es als Fund —
// dann gehoert der Name ergaenzt, nicht der Test abgeschaltet.
const GLOBAL = new Set([
  // Sprache
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'Promise', 'Map',
  'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Function', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'undefined',
  'NaN', 'Infinity', 'globalThis', 'arguments', 'console', 'Intl', 'ArrayBuffer', 'Uint8Array',
  'structuredClone', 'queueMicrotask',
  // Browser
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'localStorage',
  'sessionStorage', 'indexedDB', 'fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FormData', 'Image', 'Audio', 'Option', 'DOMParser', 'XMLSerializer',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'alert', 'confirm', 'prompt', 'atob', 'btoa',
  'crypto', 'performance', 'matchMedia', 'getComputedStyle', 'scrollTo', 'open', 'close',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'CustomEvent', 'Event', 'KeyboardEvent',
  'MouseEvent', 'AbortController', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver',
  'Notification', 'BarcodeDetector', 'caches', 'self', 'innerWidth', 'innerHeight', 'scrollY', 'scrollX',
  'devicePixelRatio', 'Node', 'Element', 'HTMLElement', 'NodeList', 'DocumentFragment', 'TextDecoder',
  'TextEncoder', 'WebSocket', 'Worker', 'MessageChannel', 'ServiceWorkerRegistration',
  // Von der App selbst gesetzt bzw. mitgeliefert
  'LZString', 'ZXing', 'HonStore', 'HonApp', 'HonIntern', 'BKCloud', 'BKCloudOnChange', 'WhatsNew',
  'APP_VERSION',
]);

function analysiere(datei) {
  const quelle = fs.readFileSync(datei, 'utf8');
  const baum = acorn.parse(quelle, { ecmaVersion: 2022, sourceType: 'script', locations: true });

  const deklariert = new Set();
  const benutzt = new Map();      // name -> erste Zeile

  function muster(node) {         // Deklarations-Ziele, auch destrukturierend
    if (!node) return;
    switch (node.type) {
      case 'Identifier': deklariert.add(node.name); break;
      case 'ObjectPattern': node.properties.forEach((p) => muster(p.value || p.argument)); break;
      case 'ArrayPattern': node.elements.forEach(muster); break;
      case 'AssignmentPattern': muster(node.left); break;
      case 'RestElement': muster(node.argument); break;
      default: break;
    }
  }

  (function lauf(node, eltern) {
    if (!node || typeof node.type !== 'string') return;

    switch (node.type) {
      case 'VariableDeclarator': muster(node.id); break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) deklariert.add(node.id.name);
        node.params.forEach(muster);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) deklariert.add(node.id.name);
        break;
      case 'CatchClause': muster(node.param); break;
      case 'LabeledStatement': deklariert.add(node.label.name); break;
      default: break;
    }

    if (node.type === 'Identifier') {
      const e = eltern[eltern.length - 1];
      const istEigenschaft = e && e.type === 'MemberExpression' && e.property === node && !e.computed;
      const istSchluessel = e && (e.type === 'Property' || e.type === 'PropertyDefinition') && e.key === node && !e.computed;
      const istLabel = e && (e.type === 'LabeledStatement' || e.type === 'BreakStatement' || e.type === 'ContinueStatement');
      if (!istEigenschaft && !istSchluessel && !istLabel && !benutzt.has(node.name)) {
        benutzt.set(node.name, node.loc.start.line);
      }
    }

    eltern.push(node);
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const w = node[k];
      if (Array.isArray(w)) w.forEach((c) => lauf(c, eltern));
      else if (w && typeof w.type === 'string') lauf(w, eltern);
    }
    eltern.pop();
  })(baum, []);

  const frei = [...benutzt.entries()]
    .filter(([n]) => !deklariert.has(n) && !GLOBAL.has(n))
    .map(([n, z]) => n + ' (Z. ' + z + ')');
  return { frei, benutzt: benutzt.size, deklariert: deklariert.size };
}

console.log('');
console.log('-- Freie Bezeichner (waeren ReferenceError) --------------');

const dateien = fs.readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => 'js/' + f).concat(['sw.js']);
for (const f of dateien) {
  let r;
  try { r = analysiere(f); }
  catch (e) { pruefe(path.basename(f) + ' ist parsebar', false, e.message); continue; }
  pruefe(path.basename(f) + ' hat keine freien Bezeichner (' + r.deklariert + ' deklariert)',
    r.frei.length === 0, r.frei.join(', '));
}

console.log('');
console.log((bad === 0 ? 'BESTANDEN' : 'FEHLGESCHLAGEN') + ': ' + ok + ' ok, ' + bad + ' fehlerhaft');
console.log('');
process.exit(bad === 0 ? 0 : 1);
