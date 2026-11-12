/* ==========================================================================
 * ROCKET RACER — main.js
 * Boot: size the two canvas layers to whole-number pixel scaling, then run
 * the loop.
 *
 *   #screen  the world. Its pixel size changes with the zoom level.
 *   #hud     menus, HUD and touch controls. Always the base pixel size,
 *            so text stays readable however far you zoom.
 *
 * The base scale is chosen so the short side of the screen is about 380 game
 * pixels (270 on phones). Zooming moves the world layer to a neighbouring
 * whole-number scale, so every game pixel is still a crisp square block.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR, G = RR.game;
  const world = document.getElementById('screen');
  const hud = document.getElementById('hud');
  const probe = document.getElementById('probe');
  const wctx = world.getContext('2d', { alpha: false });
  const hctx = hud.getContext('2d');

  function fit(canvas, ctx, w, h, scale, dpr) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = (w * scale) / dpr + 'px';
    canvas.style.height = (h * scale) / dpr + 'px';
    ctx.imageSmoothingEnabled = false;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = window.innerWidth, ch = window.innerHeight;
    const pw = Math.max(1, Math.floor(cw * dpr)), ph = Math.max(1, Math.floor(ch * dpr));
    // game pixels along the short side of the screen: ~270 on phones, ~380 otherwise
    const shortSide = Math.min(cw, ch) < 520 ? 270 : 380;
    const base = Math.max(1, Math.round(Math.min(pw, ph) / shortSide));
    G.baseScale = base;
    const zoomed = base + G.zoomEff(); // world pixel scale at the current zoom level

    const W = Math.ceil(pw / base), H = Math.ceil(ph / base);
    const vw = Math.ceil(pw / zoomed), vh = Math.ceil(ph / zoomed);
    fit(hud, hctx, W, H, base, dpr);
    fit(world, wctx, vw, vh, zoomed, dpr);
    G.W = W; G.H = H; G.vw = vw; G.vh = vh; G.zoomScale = zoomed / base;

    // notch / home-indicator margins, measured through CSS env() on #probe
    if (probe) {
      const cs = window.getComputedStyle(probe), k = dpr / base;
      const px = function (v) { return Math.ceil((parseFloat(v) || 0) * k); };
      G.inset.l = px(cs.paddingLeft); G.inset.t = px(cs.paddingTop);
      G.inset.r = px(cs.paddingRight); G.inset.b = px(cs.paddingBottom);
    }

    // scanline pitch follows the size of one HUD pixel
    document.documentElement.style.setProperty('--px', base / dpr + 'px');
    document.body.classList.toggle('tinypx', base < 2);
  }
  RR.resize = resize;

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

  RR.input.attach(hud);
  G.init(); // loads the saved zoom level...
  resize(); // ...which sizes the layers

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    G.frame(dt);
    G.render(wctx, hctx);
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
})();
