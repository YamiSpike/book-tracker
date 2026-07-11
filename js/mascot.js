/* Hon 本 · Maskottchen „Fuku" die Bücher-Eule — schwebt, gibt Lese-Tipps & Empfehlungen,
   ein-/ausblendbar. Muster aus der Otaku-App (Mochi), angepasst an die Bibliotheks-Optik. */
(function () {
  'use strict';
  var STORAGE = 'bk_mascot_hidden';
  var el, bubbleEl, showBtn, moveTimer, bubbleTimer, idleTimer, hopTimer, idleHopTimer;
  var hidden = false;
  try { hidden = localStorage.getItem(STORAGE) === '1'; } catch (e) { /**/ }

  // Eule „Fuku" — hochwertiges Canva-AI-Sticker-Artwork (identisch zum Maskottchen-Stil der Nihongo-App).
  // Freigestelltes PNG (512×512, transparenter Hintergrund) statt selbstgezeichnetem SVG.
  var SVG = '<img class="mascot-img" src="img/fuku.png" alt="" width="92" height="92" draggable="false" />';

  function clampPlace() {
    if (!el) return;
    var w = window.innerWidth, h = window.innerHeight, size = 92;
    var minX = 8, maxX = Math.max(8, w - size - 8);
    var minY = 70, maxY = Math.max(76, h - size - 96);
    var x = Math.round(minX + Math.random() * (maxX - minX));
    var y = Math.round(minY + Math.random() * (maxY - minY));
    // Bewegung über transform (GPU) statt left/top (Layout) — sonst ruckelt es
    el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
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

  function hop() {
    if (!el || hidden) return;
    el.classList.remove('happy');
    // Reflow erzwingen, damit die Animation auch bei schnellem Wiederholen neu startet
    void el.offsetWidth;
    el.classList.add('happy');
    clearTimeout(hopTimer);
    hopTimer = setTimeout(function () { if (el) el.classList.remove('happy'); }, 650);
  }
  function scheduleIdleHop() {
    clearTimeout(idleHopTimer);
    idleHopTimer = setTimeout(function () {
      if (!hidden && document.visibilityState === 'visible') hop();
      scheduleIdleHop();
    }, 12000 + Math.random() * 12000);
  }

  function onTap() {
    hop();
    speakRecommendation();
    try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) { /**/ }
  }

  function hide(ev) {
    if (ev) ev.stopPropagation();
    hidden = true;
    try { localStorage.setItem(STORAGE, '1'); } catch (e) { /**/ }
    if (el) { el.style.display = 'none'; el.classList.remove('happy'); }
    if (bubbleEl) bubbleEl.hidden = true;
    if (showBtn) showBtn.hidden = false;
    clearTimeout(moveTimer); clearTimeout(idleTimer); clearTimeout(bubbleTimer);
    clearTimeout(hopTimer); clearTimeout(idleHopTimer);
  }

  function reveal() {
    hidden = false;
    try { localStorage.setItem(STORAGE, '0'); } catch (e) { /**/ }
    if (el) el.style.display = '';
    if (showBtn) showBtn.hidden = true;
    clampPlace();
    scheduleMove();
    scheduleIdleTip();
    scheduleIdleHop();
    hop();
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
      scheduleIdleHop();
    }
    window.addEventListener('resize', function () { if (!hidden) clampPlace(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
