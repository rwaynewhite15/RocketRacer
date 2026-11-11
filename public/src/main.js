/* ==========================================================================
 * ROCKET RACER — main.js
 * Boot: size the canvas to whole-number pixel scaling, then run the loop.
 *
 * The game renders at a low "virtual" resolution and the browser scales it
 * up by an exact integer factor, so every game pixel is a crisp square block
 * on any display. Phones get chunkier pixels than desktops so the action
 * and the text stay readable on a small screen.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR, G = RR.game;
  const canvas = document.getElementById('screen');
  const probe = document.getElementById('probe');
  const ctx = canvas.getContext('2d', { alpha: false });

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = window.innerWidth, ch = window.innerHeight;
    const pw = Math.max(1, Math.floor(cw * dpr)), ph = Math.max(1, Math.floor(ch * dpr));
    // game pixels along the short side of the screen: ~270 on phones, ~380 otherwise
    const shortSide = Math.min(cw, ch) < 520 ? 270 : 380;
    const scale = Math.max(1, Math.round(Math.min(pw, ph) / shortSide));
    const W = Math.ceil(pw / scale), H = Math.ceil(ph / scale);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    canvas.style.width = (W * scale) / dpr + 'px';
    canvas.style.height = (H * scale) / dpr + 'px';
    ctx.imageSmoothingEnabled = false;
    G.W = W; G.H = H;

    // notch / home-indicator margins, measured through CSS env() on #probe
    if (probe) {
      const cs = window.getComputedStyle(probe), k = dpr / scale;
      const px = function (v) { return Math.ceil((parseFloat(v) || 0) * k); };
      G.inset.l = px(cs.paddingLeft); G.inset.t = px(cs.paddingTop);
      G.inset.r = px(cs.paddingRight); G.inset.b = px(cs.paddingBottom);
    }

    // scanline pitch follows the size of one game pixel
    document.documentElement.style.setProperty('--px', scale / dpr + 'px');
    document.body.classList.toggle('tinypx', scale < 2);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { window.setTimeout(resize, 120); });
  document.addEventListener('fullscreenchange', resize);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) G.pause();
  });

  /* pilot-name form (shown by G.editName) */
  const box = document.getElementById('namebox');
  if (box) {
    box.addEventListener('submit', function (e) { e.preventDefault(); G.closeName(true); });
    document.getElementById('namecancel').addEventListener('click', function () { G.closeName(false); });
    box.addEventListener('keydown', function (e) { if (e.key === 'Escape') G.closeName(false); });
  }

  resize();
  RR.input.attach(canvas);
  G.init();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    G.frame(dt);
    G.render(ctx);
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
})();
