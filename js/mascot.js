/* Hon 本 · Maskottchen „Fuku" die Bücher-Eule — schwebt, gibt Lese-Tipps & Empfehlungen,
   ein-/ausblendbar. Muster aus der Otaku-App (Mochi), angepasst an die Bibliotheks-Optik. */
(function () {
  'use strict';
  var STORAGE = 'bk_mascot_hidden';
  var el, bubbleEl, showBtn, moveTimer, bubbleTimer, idleTimer;
  var hidden = false;
  try { hidden = localStorage.getItem(STORAGE) === '1'; } catch (e) { /**/ }

  // Chibi-Eule mit Buch (Bernstein/Creme-Palette der App)
  var SVG = '' +
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<ellipse cx="50" cy="93" rx="22" ry="4.5" fill="rgba(0,0,0,.28)"/>' +
      // Ohrbüschel
      '<path d="M28 22 L22 8 L38 16 Z" fill="#8a5a2b" stroke="#4a3018" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M72 22 L78 8 L62 16 Z" fill="#8a5a2b" stroke="#4a3018" stroke-width="1.5" stroke-linejoin="round"/>' +
      // Körper
      '<ellipse cx="50" cy="52" rx="32" ry="34" fill="#a9713a" stroke="#4a3018" stroke-width="1.5"/>' +
      // Bauch
      '<ellipse cx="50" cy="60" rx="22" ry="23" fill="#f3e4c2"/>' +
      '<path d="M38 52 q4 5 8 0 M54 52 q4 5 8 0 M42 62 q4 5 8 0 M50 62 q4 5 8 0" fill="none" stroke="#d9c49a" stroke-width="1.4" stroke-linecap="round"/>' +
      // Flügel
      '<path d="M18 46 Q14 62 26 72 Q30 60 28 46 Z" fill="#8a5a2b" stroke="#4a3018" stroke-width="1.2"/>' +
      '<path d="M82 46 Q86 62 74 72 Q70 60 72 46 Z" fill="#8a5a2b" stroke="#4a3018" stroke-width="1.2"/>' +
      // Brille (Lese-Eule!)
      '<circle cx="38" cy="40" r="11" fill="rgba(253,246,227,.35)" stroke="#f5c96b" stroke-width="2"/>' +
      '<circle cx="62" cy="40" r="11" fill="rgba(253,246,227,.35)" stroke="#f5c96b" stroke-width="2"/>' +
      '<line x1="49" y1="40" x2="51" y2="40" stroke="#f5c96b" stroke-width="2"/>' +
      // Augen (blinzeln via .eye)
      '<g class="eye"><circle cx="38" cy="40" r="6" fill="#241a12"/><circle cx="36" cy="37.5" r="2" fill="#fff"/></g>' +
      '<g class="eye"><circle cx="62" cy="40" r="6" fill="#241a12"/><circle cx="60" cy="37.5" r="2" fill="#fff"/></g>' +
      // Schnabel
      '<path d="M46 49 L54 49 L50 56 Z" fill="#e8a33d" stroke="#4a3018" stroke-width="1.2" stroke-linejoin="round"/>' +
      // Buch in den Krallen
      '<g>' +
        '<path d="M30 80 Q40 74 50 78 L50 90 Q40 86 30 92 Z" fill="#fdf6e3" stroke="#4a3018" stroke-width="1.2"/>' +
        '<path d="M70 80 Q60 74 50 78 L50 90 Q60 86 70 92 Z" fill="#f3e4c2" stroke="#4a3018" stroke-width="1.2"/>' +
        '<path d="M35 81 L45 79 M35 85 L45 83 M55 79 L65 81 M55 83 L65 85" stroke="#b39868" stroke-width="1.1" stroke-linecap="round"/>' +
      '</g>' +
      // Funkel-Stern
      '<path class="spark" d="M85 24 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6 Z" fill="#f5c96b"/>' +
    '</svg>';

  function clampPlace() {
    if (!el) return;
    var w = window.innerWidth, h = window.innerHeight, size = 92;
    var minX = 8, maxX = Math.max(8, w - size - 8);
    var minY = 70, maxY = Math.max(76, h - size - 96);
    var x = Math.round(minX + Math.random() * (maxX - minX));
    var y = Math.round(minY + Math.random() * (maxY - minY));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.classList.toggle('flip', x > w / 2);
  }

  function scheduleMove() {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(function () {
      if (!hidden) clampPlace();
      scheduleMove();
    }, 10000 + Math.random() * 8000);
  }

  function speak(msg) {
    if (!bubbleEl) return;
    var rec = msg || { text: '…' };
    bubbleEl.innerHTML = '';
    var p = document.createElement('div');
    p.className = 'mascot-bubble-text';
    p.textContent = rec.text;
    bubbleEl.appendChild(p);
    if (rec.id) {
      var b = document.createElement('button');
      b.className = 'mascot-bubble-go';
      b.textContent = 'Ansehen →';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (window.HonApp && window.HonApp.openById) window.HonApp.openById(rec.id, rec.kind);
      });
      bubbleEl.appendChild(b);
    }
    bubbleEl.hidden = false;
    el.classList.add('talking');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () {
      if (bubbleEl) { bubbleEl.hidden = true; el.classList.remove('talking'); }
    }, rec.id ? 9000 : 6000);
  }

  function speakRecommendation() {
    var msg = (window.HonApp && window.HonApp.getMascotMessage)
      ? window.HonApp.getMascotMessage() : { text: 'Huhu! Ich bin Fuku 🦉' };
    speak(msg);
  }

  function scheduleIdleTip() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!hidden && document.visibilityState === 'visible') speakRecommendation();
      scheduleIdleTip();
    }, 55000 + Math.random() * 40000);
  }

  function onTap() {
    speakRecommendation();
    try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) { /**/ }
  }

  function hide(ev) {
    if (ev) ev.stopPropagation();
    hidden = true;
    try { localStorage.setItem(STORAGE, '1'); } catch (e) { /**/ }
    if (el) el.style.display = 'none';
    if (bubbleEl) bubbleEl.hidden = true;
    if (showBtn) showBtn.hidden = false;
    clearTimeout(moveTimer); clearTimeout(idleTimer); clearTimeout(bubbleTimer);
  }

  function reveal() {
    hidden = false;
    try { localStorage.setItem(STORAGE, '0'); } catch (e) { /**/ }
    if (el) el.style.display = '';
    if (showBtn) showBtn.hidden = true;
    clampPlace();
    scheduleMove();
    scheduleIdleTip();
    speak({ text: 'Wieder da! Tipp mich für Buch-Tipps 🦉' });
  }

  function build() {
    el = document.createElement('div');
    el.id = 'mascot';
    el.className = 'mascot';
    el.innerHTML =
      '<div class="mascot-bubble" id="mascotBubble" hidden></div>' +
      '<button class="mascot-body" id="mascotBody" aria-label="Fuku — Lese-Tipp anzeigen">' + SVG + '</button>' +
      '<button class="mascot-hide" id="mascotHide" aria-label="Maskottchen ausblenden">×</button>';
    document.body.appendChild(el);

    showBtn = document.createElement('button');
    showBtn.id = 'mascotShow';
    showBtn.className = 'mascot-show';
    showBtn.setAttribute('aria-label', 'Maskottchen Fuku einblenden');
    showBtn.textContent = '🦉';
    showBtn.hidden = true;
    showBtn.addEventListener('click', reveal);
    document.body.appendChild(showBtn);

    bubbleEl = document.getElementById('mascotBubble');
    document.getElementById('mascotBody').addEventListener('click', onTap);
    document.getElementById('mascotHide').addEventListener('click', hide);

    if (hidden) {
      el.style.display = 'none';
      showBtn.hidden = false;
    } else {
      clampPlace();
      scheduleMove();
      scheduleIdleTip();
    }
    window.addEventListener('resize', function () { if (!hidden) clampPlace(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
