/* ==========================================================================
 * ROCKET RACER — render.js
 * Draws everything to the low-resolution game canvas: parallax space,
 * the world, particles, the HUD, touch controls and the menu overlays.
 * All drawing is integer-aligned sprites and rectangles — no anti-aliasing.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR, Art = RR.Art, PAL = RR.PAL, G = RR.game, C = RR.CFG;
  const text = RR.text, clamp = RR.clamp, fmt = RR.fmtTime;

  const ORD = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH'];
  const PLACE_COL = [PAL.gold, PAL.white, PAL.orange, PAL.silver, PAL.silver, PAL.silver];

  /* ------------------------------------------------------------ helpers */

  function tile(ctx, img, ox, oy, W, H) {
    const tw = img.width, th = img.height;
    const x0 = -(((Math.floor(ox) % tw) + tw) % tw), y0 = -(((Math.floor(oy) % th) + th) % th);
    for (let y = y0; y < H; y += th) for (let x = x0; x < W; x += tw) ctx.drawImage(img, x, y);
    return [x0, y0];
  }

  function panel(ctx, x, y, w, h, border) {
    x = Math.round(x); y = Math.round(y);
    ctx.fillStyle = 'rgba(7,7,26,0.66)';
    ctx.fillRect(x + 1, y, w - 2, h);
    ctx.fillRect(x, y + 1, 1, h - 2);
    ctx.fillRect(x + w - 1, y + 1, 1, h - 2);
    ctx.fillStyle = border || PAL.slate;
    ctx.fillRect(x + 1, y, w - 2, 1);
    ctx.fillRect(x + 1, y + h - 1, w - 2, 1);
    ctx.fillRect(x, y + 1, 1, h - 2);
    ctx.fillRect(x + w - 1, y + 1, 1, h - 2);
  }

  function bar(ctx, x, y, n, frac, color) {
    const lit = Math.ceil(clamp(frac, 0, 1) * n - 0.001);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i < lit ? color : PAL.dusk;
      ctx.fillRect(x + i * 5, y, 4, 6);
    }
  }

  function glow(ctx, x, y, r, color, alpha) {
    const gl = Art.glow(r, color);
    ctx.globalCompositeOperation = 'lighter';
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    ctx.drawImage(gl, Math.round(x) - r, Math.round(y) - r);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function button(g, ctx, label, x, y, w, h, act, color) {
    panel(ctx, x, y, w, h, color || PAL.steel);
    text(ctx, label, x + w / 2, y + Math.floor((h - 7) / 2), color || PAL.white, 1, 'center', PAL.ink);
    g.ui.push({ x: x, y: y, w: w, h: h, act: act, label: label }); // label: lets tests find a button
  }

  const NO_INSET = { l: 0, t: 0, r: 0, b: 0 };

  /**
   * Touch controls with a place on screen, in game pixels: the fire stick,
   * BRAKE, and the DO-OVER button (shown only while one is held). Steering has
   * no place: it is a drag that can start anywhere else (see input.js). Each
   * control has a standard spot; the player can move them (Pause > Move
   * controls). Moved spots are kept as fractions of the screen, separately for
   * sideways and upright, and are always pulled back inside the screen and
   * clear of notches.
   */
  RR.touchLayout = function (W, H, ins) {
    ins = ins || NO_INSET;
    const R = 34, grab = R + 24; // a thumb landing within `grab` of a stick's centre takes it
    const def = { fire: { x: W - ins.r - 66, y: H - ins.b - 66 } };
    if (W - ins.l - ins.r < 360) { // narrow (upright phone): stack BRAKE and DO-OVER above the fire stick
      def.brake = { x: def.fire.x, y: def.fire.y - 80 };
      def.rewind = { x: def.fire.x, y: def.brake.y - 54 };
    } else {
      def.brake = { x: def.fire.x - 82, y: H - ins.b - 31 };
      def.rewind = { x: def.fire.x, y: def.fire.y - 74 };
    }
    const g = RR.game, saved = (g && g.controls && g.controls[W >= H ? 'land' : 'port']) || {};
    const half = { fire: R + 2, brake: 21, rewind: 22 }, centre = {};
    for (const n in def) {
      const sp = saved[n], h = half[n];
      centre[n] = {
        x: Math.round(clamp(sp ? sp.x * W : def[n].x, ins.l + h + 2, W - ins.r - h - 2)),
        y: Math.round(clamp(sp ? sp.y * H : def[n].y, ins.t + h + 2, H - ins.b - h - 2)),
      };
    }
    const box = function (c, w, h) { return { x: c.x - w / 2, y: c.y - h / 2, w: w, h: h }; };
    return {
      stickR: R,
      fire: { x: centre.fire.x, y: centre.fire.y, r: R, grab: grab },
      brake: box(centre.brake, 42, 42),
      rewind: box(centre.rewind, 44, 44),
      centre: centre,
    };
  };

  /* -------------------------------------------------------------- world */

  function drawParts(g, ctx, cx, cy, W, H, layer) {
    const parts = g.parts;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.layer !== layer) continue;
      const sx = Math.round(p.x - cx), sy = Math.round(p.y - cy);
      if (sx < -4 || sy < -4 || sx > W + 4 || sy > H + 4) continue;
      const r = p.ramp, k = Math.min(r.length - 1, Math.floor((1 - p.life / p.max) * r.length));
      const sz = p.size || (k < 2 ? 3 : k < 4 ? 2 : 1); // size 0 = shrink as it cools
      ctx.fillStyle = r[k];
      ctx.fillRect(sx - (sz >> 1), sy - (sz >> 1), sz, sz);
    }
  }

  /** The player's ghost during a do-over: dotted path still to unwind, echoes, a ringed silhouette. */
  function drawRewindGhost(g, ctx, s, cx, cy, W, H) {
    const r = s.rw, pts = r.pts, n = pts.length, f = r.f;
    ctx.fillStyle = PAL.violet;
    for (let i = Math.ceil(f); i < n; i++) {
      const x = Math.round(pts[i].x - cx), y = Math.round(pts[i].y - cy);
      if (x > -4 && y > -4 && x < W + 4 && y < H + 4) ctx.fillRect(x - 1, y - 1, 2, 2);
    }
    for (let e = 3; e >= 1; e--) { // echoes trailing back towards the present
      const at = RR.pathAt(pts, Math.min(n - 1, f + e * 1.8));
      ctx.globalAlpha = 0.14 * (4 - e);
      RR.drawRot(ctx, s.ghost, at.x - cx, at.y - cy, at.angle + Math.PI / 2);
    }
    glow(ctx, s.x - cx, s.y - cy, 16, '#a98bff'); // (resets the alpha)
    ctx.globalAlpha = 0.9;
    RR.drawRot(ctx, s.ghost, s.x - cx, s.y - cy, s.angle + Math.PI / 2);
    ctx.globalAlpha = 1;
    RR.ring(ctx, s.x - cx, s.y - cy, 15, PAL.cyan, 8, -g.t * 12);
  }

  /** Worn-tape look for the whole world while rewinding: torn bands, violet wash, scanlines. */
  function drawRewindOverlay(g, ctx, W, H) {
    for (let i = 0; i < 5; i++) {
      const y = Math.floor(Math.random() * H), h = 1 + Math.floor(Math.random() * 5);
      const dx = Math.round((Math.random() - 0.5) * 18);
      ctx.drawImage(ctx.canvas, 0, y, W, h, dx, y, W, h);
    }
    ctx.fillStyle = 'rgba(110,70,255,0.16)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    for (let y = Math.floor(g.t * 40) % 3; y < H; y += 3) ctx.fillRect(0, y, W, 1);
  }

  function drawWorld(g, ctx, W, H) {
    const tr = g.track, p = g.player;
    const shx = g.shake > 0.4 ? (Math.random() - 0.5) * 2 * g.shake : 0;
    const shy = g.shake > 0.4 ? (Math.random() - 0.5) * 2 * g.shake : 0;
    const cx = Math.round(g.cam.x - W / 2 + shx), cy = Math.round(g.cam.y - H / 2 + shy);
    const vis = function (x, y, pad) { return x > -pad && y > -pad && x < W + pad && y < H + pad; };

    /* deep space: nebula and three parallax star layers */
    ctx.fillStyle = PAL.void;
    ctx.fillRect(0, 0, W, H);
    tile(ctx, tr.nebula, cx * 0.06, cy * 0.06, W, H);
    tile(ctx, Art.stars[0], cx * 0.1, cy * 0.1, W, H);
    tile(ctx, Art.stars[1], cx * 0.22, cy * 0.22, W, H);
    const st = Art.stars[2], off = tile(ctx, st, cx * 0.4, cy * 0.4, W, H);
    ctx.fillStyle = '#ffffff';
    for (let y = off[1]; y < H; y += st.height) {
      for (let x = off[0]; x < W; x += st.width) {
        for (let i = 0; i < st.twinks.length; i++) {
          const k = st.twinks[i], v = Math.sin(g.t * k[3] + k[2]);
          if (v < 0.5) continue;
          ctx.fillRect(x + k[0] - 1, y + k[1], 3, 1);
          ctx.fillRect(x + k[0], y + k[1] - 1, 1, 3);
          if (v > 0.9) { ctx.fillRect(x + k[0] - 2, y + k[1], 5, 1); ctx.fillRect(x + k[0], y + k[1] - 2, 1, 5); }
        }
      }
    }

    /* warp streaks when really moving */
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 350 && !g.demo && g.state !== 'paused') {
      const n = Math.min(16, Math.floor((sp - 330) / 10)), ux = -p.vx / sp, uy = -p.vy / sp;
      for (let i = 0; i < n; i++) {
        const x = Math.random() * W, y = Math.random() * H, len = 6 + Math.random() * 16;
        RR.line(ctx, x, y, x + ux * len, y + uy * len, i & 1 ? PAL.blue : PAL.cyan);
      }
    }

    /* planets */
    for (const pl of tr.planets) {
      const sx = pl.x - cx, sy = pl.y - cy;
      if (vis(sx, sy, pl.ext)) ctx.drawImage(pl.sprite, sx - pl.ext, sy - pl.ext);
    }

    /* donut gates — the next one glows and gets a marching halo */
    const half = Art.donut.half, D = Art.donut;
    for (const d of tr.donuts) {
      const sx = d.x - cx, sy = d.y - cy;
      if (!vis(sx, sy, 84)) continue;
      const active = !g.demo && !g.playerDone && d.ids.indexOf(p.nextCp) >= 0;
      const bright = active || g.demo;
      if (active) glow(ctx, sx, sy, 78, d.finish ? '#fff1a8' : '#ff6fb5', 0.62 + 0.38 * Math.sin(g.t * 7));
      ctx.drawImage(d.finish ? (bright ? D.finFull : D.finDim) : (bright ? D.full : D.dim), sx - half, sy - half);
      if (active) {
        RR.ring(ctx, sx, sy, 60 + Math.round(Math.sin(g.t * 7) * 2), PAL.yellow, 14, g.t * 9);
        RR.ring(ctx, sx, sy, 28, PAL.white, 8, -g.t * 6);
      }
    }

    /* arena wall (dashed) and, in a battle royale, the closing zone */
    if (g.combat) {
      const b = tr.bounds;
      ctx.fillStyle = PAL.steel;
      for (let wx = Math.ceil(Math.max(b.x0, cx) / 8) * 8; wx <= Math.min(b.x1, cx + W); wx += 8) {
        ctx.fillRect(wx - cx, b.y0 - cy, 4, 1);
        ctx.fillRect(wx - cx, b.y1 - cy, 4, 1);
      }
      for (let wy = Math.ceil(Math.max(b.y0, cy) / 8) * 8; wy <= Math.min(b.y1, cy + H); wy += 8) {
        ctx.fillRect(b.x0 - cx, wy - cy, 1, 4);
        ctx.fillRect(b.x1 - cx, wy - cy, 1, 4);
      }
    }
    if (g.zone && g.zone.r > 2) {
      const z = g.zone, zx = tr.center.x - cx, zy = tr.center.y - cy;
      const n = Math.max(16, Math.floor(z.r * RR.TAU / 6)), spin = (g.t * 18) / z.r;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * RR.TAU + spin, x = Math.round(zx + Math.cos(a) * z.r), y = Math.round(zy + Math.sin(a) * z.r);
        if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
        ctx.fillStyle = i & 1 ? PAL.alarm : PAL.orange;
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }

    /* pickups */
    for (const pk of g.pickups) {
      if (!pk.on) continue;
      const sx = Math.round(pk.x - cx), sy = Math.round(pk.y - cy + Math.sin(g.t * 3 + pk.ph) * 2);
      if (!vis(sx, sy, 20)) continue;
      glow(ctx, sx, sy, 17, pk.kind === 'W' ? '#e5404f' : pk.type === 'rewind' ? '#a855f7' : '#38b764');
      ctx.drawImage(Art.pickups[pk.type], sx - 8, sy - 8);
    }

    /* while holding a do-over: a faint ghost where it would put you back */
    if (!g.demo && p.rewind > 0 && !p.rw && p.dead <= 0 && !g.playerDone && p.hist.length > 10) {
      const t = p.hist[0], sx = t.x - cx, sy = t.y - cy;
      if (vis(sx, sy, 24)) {
        ctx.globalAlpha = 0.3 + 0.12 * Math.sin(g.t * 6);
        RR.drawRot(ctx, p.ghost, sx, sy, t.angle + Math.PI / 2);
        ctx.globalAlpha = 1;
        RR.ring(ctx, sx, sy, 15, PAL.violet, 8, g.t * 5);
      }
    }

    /* mines */
    for (const m of g.mines) {
      const sx = Math.round(m.x - cx), sy = Math.round(m.y - cy);
      if (!vis(sx, sy, 12)) continue;
      const on = m.t > 0.6 && (g.t * 5 + m.ph) % 1 < 0.5;
      if (on) glow(ctx, sx, sy, 10, '#ff3b3b');
      ctx.drawImage(Art.mine[on ? 1 : 0], sx - 4, sy - 4);
    }

    /* asteroids (rotation snapped to steps so pixels don't crawl) */
    for (const a of g.rocks) {
      if (a.dead) continue;
      const sx = a.x - cx, sy = a.y - cy;
      if (vis(sx, sy, a.r + 4)) RR.drawRot(ctx, a.sprite, sx, sy, Math.round(a.rot * 6.4) / 6.4);
    }

    drawParts(g, ctx, cx, cy, W, H, 0);

    /* shots */
    for (const b of g.shots) {
      const sx = b.x - cx, sy = b.y - cy;
      if (!vis(sx, sy, 12)) continue;
      if (b.type === 'missile') {
        glow(ctx, sx - Math.cos(b.angle) * 6, sy - Math.sin(b.angle) * 6, 8, '#ef7d57');
        RR.drawRot(ctx, Art.missile, sx, sy, b.angle + Math.PI / 2);
      } else {
        const m = Math.hypot(b.vx, b.vy) || 1, ux = b.vx / m, uy = b.vy / m;
        glow(ctx, sx, sy, 7, b.color);
        for (let k = 3; k >= 0; k--) {
          ctx.fillStyle = k === 0 ? '#ffffff' : b.color;
          ctx.fillRect(Math.round(sx - ux * k * 2.4) - 1, Math.round(sy - uy * k * 2.4) - 1, 2, 2);
        }
      }
    }

    /* ships */
    for (const s of g.ships) {
      if (s.rw) { drawRewindGhost(g, ctx, s, cx, cy, W, H); continue; }
      if (s.dead > 0) continue;
      const sx = s.x - cx, sy = s.y - cy;
      if (!vis(sx, sy, 30)) continue;
      if (s.invuln > 0 && Math.floor(g.t * 16) & 1) continue;
      if (s.thrusting > 0.05) {
        const boost = s.nitro > 0;
        glow(ctx, sx - Math.cos(s.angle) * 14, sy - Math.sin(s.angle) * 14, boost ? 17 : 11, boost ? '#41a6f6' : '#ef7d57');
      }
      RR.drawRot(ctx, s.hitFlash > 0 ? s.white : s.sprite, sx, sy, s.angle + Math.PI / 2);
      // where the fire stick is aiming (for the weapons that go where they're aimed)
      const aimW = s.weapon || (g.combat ? 'blaster' : null);
      if (s === p && !g.demo && g.state === 'play' && s.input.aim != null && (aimW === 'blaster' || aimW === 'missile')) {
        const ax = Math.cos(s.input.aim), ay = Math.sin(s.input.aim);
        RR.line(ctx, sx + ax * 16, sy + ay * 16, sx + ax * 54, sy + ay * 54, PAL.yellow, 3);
        RR.ring(ctx, sx + ax * 60, sy + ay * 60, 4, PAL.yellow);
      }
      if (s.shield > 0 && (s.shield > 1.5 || Math.floor(g.t * 12) & 1)) {
        RR.ring(ctx, sx, sy, 16, PAL.cyan, 8, g.t * 10);
        RR.ring(ctx, sx, sy, 14, PAL.sky, 8, -g.t * 10);
      }
      // in a fight, show how much hull a damaged rival has left
      if (g.combat && !g.demo && s !== p && s.hp < s.maxHp) {
        const f = clamp(s.hp / s.maxHp, 0, 1), bx = Math.round(sx) - 6, by = Math.round(sy) - 18;
        ctx.fillStyle = PAL.ink;
        ctx.fillRect(bx - 1, by - 1, 15, 4);
        ctx.fillStyle = f > 0.55 ? PAL.lime : f > 0.3 ? PAL.yellow : PAL.alarm;
        ctx.fillRect(bx, by, Math.max(1, Math.round(13 * f)), 2);
      }
    }

    drawParts(g, ctx, cx, cy, W, H, 1);

    /* shockwaves and impact rings */
    for (const r of g.rings) {
      const k = r.t / r.dur, sx = r.x - cx, sy = r.y - cy;
      if (vis(sx, sy, 90)) RR.ring(ctx, sx, sy, r.r0 + (r.r1 - r.r0) * k, r.color, k > 0.55 ? 10 : 0, 0);
    }
    for (const w of g.waves) {
      const sx = w.x - cx, sy = w.y - cy;
      if (!vis(sx, sy, w.r + 4)) continue;
      RR.ring(ctx, sx, sy, w.r, PAL.violet);
      if (w.r > 5) RR.ring(ctx, sx, sy, w.r - 3, '#e6c0ff', 22, g.t * 24);
      if (w.r > 10) RR.ring(ctx, sx, sy, w.r - 8, '#5b21b6', 16, -g.t * 16);
    }

    for (const t of g.texts) {
      if (t.t > t.dur - 0.25 && Math.floor(g.t * 20) & 1) continue;
      text(ctx, t.text, t.x - cx, t.y - cy, t.color, 1, 'center', PAL.ink);
    }

    if (g.demo) return;

    /* "that's you" marker on the grid */
    if (g.phase === 'countdown' && p.dead <= 0) {
      const sx = p.x - cx, sy = p.y - cy - 24 + Math.round(Math.sin(g.t * 6) * 2);
      text(ctx, 'YOU', sx, sy, PAL.yellow, 1, 'center', PAL.ink);
      ctx.fillStyle = PAL.yellow;
      ctx.fillRect(Math.round(sx) - 2, sy + 9, 5, 1);
      ctx.fillRect(Math.round(sx) - 1, sy + 10, 3, 1);
      ctx.fillRect(Math.round(sx), sy + 11, 1, 1);
    }

    /* edge arrow towards the next gate when it is off-screen; in a fight it
     * points at the nearest rival, or back into the zone when you are outside it */
    let aim = null, hostile = false;
    if (!g.playerDone && !g.combat) aim = tr.cps[p.nextCp];
    else if (!g.playerDone && p.dead <= 0) {
      if (p.zoned) aim = tr.center;
      else {
        let bd = 1e9;
        for (const o of g.ships) {
          const d = Math.hypot(o.x - p.x, o.y - p.y);
          if (o !== p && o.dead <= 0 && d < bd) { bd = d; aim = o; hostile = true; }
        }
      }
    }
    if (aim) {
      const sx = aim.x - cx, sy = aim.y - cy;
      if (!vis(sx, sy, -10)) {
        // launch from just beside the ship, glide out towards the gate, then
        // hold at the screen edge for a while before starting over
        const SCALE = 2, R = 20, M = R + 4; // arrow drawn 2x; halo radius; edge margin
        const TRAVEL = 1.5, HOLD = 1.8;     // seconds
        const px = p.x - cx, py = p.y - cy;
        const ang = Math.atan2(sy - py, sx - px), c = Math.cos(ang), s = Math.sin(ang);
        const kx = c > 1e-6 ? (W - M - px) / c : c < -1e-6 ? (px - M) / -c : Infinity;
        const ky = s > 1e-6 ? (H - M - py) / s : s < -1e-6 ? (py - M) / -s : Infinity;
        const r0 = 36, r1 = Math.max(r0, Math.min(kx, ky));
        const u = Math.min(1, (g.t % (TRAVEL + HOLD)) / TRAVEL);
        const d = r0 + (r1 - r0) * u * u * (3 - 2 * u); // ease in and out: a gentle glide
        const ax = px + c * d, ay = py + s * d;
        // dark halo so it reads over bright nebula and planets, then a white blink
        RR.disc(ctx, ax, ay, R, 'rgba(7,7,26,0.55)');
        RR.ring(ctx, ax, ay, R, hostile ? PAL.alarm : PAL.yellow, 10, g.t * 10);
        const img = (g.t * 5) % 1 < 0.25 ? Art.arrowFlash : Art.arrow;
        ctx.setTransform(SCALE, 0, 0, SCALE, Math.round(ax), Math.round(ay));
        ctx.rotate(ang);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }

    if (p.rw) drawRewindOverlay(g, ctx, W, H);
    if (g.flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.6, g.flash).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ----------------------------------------------------------------- HUD */

  function drawMinimap(g, ctx, mx, my) {
    const mm = g.track.mini, p = g.player;
    panel(ctx, mx - 2, my - 2, mm.w + 4, mm.h + 4);
    ctx.drawImage(mm.cv, mx, my);
    const blink = Math.floor(g.t * 6) & 1;
    if (g.zone && g.zone.r * mm.s >= 1) {
      const c = g.track.center;
      ctx.save();
      ctx.beginPath();
      ctx.rect(mx, my, mm.w, mm.h);
      ctx.clip();
      RR.ring(ctx, mx + c.x * mm.s + mm.ox, my + c.y * mm.s + mm.oy, g.zone.r * mm.s, PAL.alarm);
      ctx.restore();
    }
    for (const c of g.track.cps) {
      const next = c.i === p.nextCp && !g.playerDone;
      const x = Math.round(mx + c.x * mm.s + mm.ox), y = Math.round(my + c.y * mm.s + mm.oy);
      if (next) { ctx.fillStyle = blink ? PAL.yellow : PAL.white; ctx.fillRect(x - 1, y - 1, 3, 3); }
      else { ctx.fillStyle = c.finish ? PAL.white : PAL.hot; ctx.fillRect(x, y, 1, 1); }
    }
    for (let i = g.ships.length - 1; i >= 0; i--) {
      const s = g.ships[i];
      if (s.dead > 0 && !s.rw) continue;
      const x = Math.round(mx + s.x * mm.s + mm.ox), y = Math.round(my + s.y * mm.s + mm.oy);
      if (i === 0) { ctx.fillStyle = PAL.white; ctx.fillRect(x - 2, y - 2, 5, 5); }
      ctx.fillStyle = s.colors.a;
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
  }

  function drawHUD(g, ctx, W, H) {
    const p = g.player, touch = RR.input.touchMode, T = g.t, ins = g.inset, mm = g.track.mini;
    const L = 4 + ins.l, Tp = 4 + ins.t, Rr = W - 4 - ins.r, B = H - 4 - ins.b;
    const narrow = Rr - L < 330; // phones held upright

    /* lap + position, or the score in a fight */
    panel(ctx, L, Tp, 104, 34);
    if (g.royale) {
      let alive = 0;
      for (const s of g.ships) if (!s.gone) alive++;
      text(ctx, 'ALIVE', L + 6, Tp + 5, PAL.silver);
      text(ctx, alive + '/' + g.ships.length, L + 6, Tp + 15, PAL.white, 2);
      text(ctx, 'KILLS', L + 56, Tp + 5, PAL.silver);
      text(ctx, String(p.kills), L + 56, Tp + 15, PAL.yellow, 2);
    } else {
      text(ctx, g.combat ? 'KILLS' : 'LAP', L + 6, Tp + 5, PAL.silver);
      text(ctx, g.combat ? p.kills + '/' + C.KILL_TARGET : Math.min(g.laps, Math.max(1, p.lap)) + '/' + g.laps, L + 6, Tp + 15, PAL.white, 2);
      text(ctx, 'POS', L + 56, Tp + 5, PAL.silver);
      text(ctx, ORD[p.place - 1], L + 56, Tp + 15, PLACE_COL[p.place - 1], 2);
    }

    drawMinimap(g, ctx, Rr - mm.w - 2, Tp + 2);

    /* clocks: top centre, or tucked under the minimap when there is no room */
    const cx = narrow ? Rr - 1 : W / 2, cy = narrow ? Tp + mm.h + 9 : Tp + 3, al = narrow ? 'right' : 'center';
    if (g.combat) {
      const now = g.over ? g.endT : g.raceTime;
      if (g.royale) {
        const wait = C.ZONE_GRACE - now;
        text(ctx, fmt(now), cx, cy, PAL.white, 2, al, PAL.ink);
        if (wait > 0) text(ctx, 'ZONE CLOSES IN ' + Math.ceil(wait), cx, cy + 18, PAL.silver, 1, al, PAL.ink);
        else if (!g.over) text(ctx, 'THE ZONE IS CLOSING', cx, cy + 18, Math.floor(T * 3) & 1 ? PAL.alarm : PAL.orange, 1, al, PAL.ink);
      } else {
        const left = Math.max(0, C.DOGFIGHT_TIME - now);
        text(ctx, fmt(left), cx, cy, left < 20 && Math.floor(T * 4) & 1 ? PAL.alarm : PAL.white, 2, al, PAL.ink);
        text(ctx, 'FIRST TO ' + C.KILL_TARGET + ' KILLS', cx, cy + 18, PAL.silver, 1, al, PAL.ink);
      }
    } else {
      const total = p.finished ? p.finishTime : g.raceTime;
      text(ctx, fmt(total), cx, cy, PAL.white, 2, al, PAL.ink);
      if (!p.finished) text(ctx, 'LAP ' + fmt(g.raceTime - p.lapStart), cx, cy + 18, PAL.silver, 1, al, PAL.ink);
      if (p.bestLap) text(ctx, 'BEST ' + fmt(p.bestLap), cx, cy + 27, PAL.yellow, 1, al, PAL.ink);
    }

    /* hull + speed */
    const hx = L, hy = touch ? Tp + 38 : B - 28;
    panel(ctx, hx, hy, 104, 28);
    const hull = p.dead > 0 && !p.rw ? 0 : p.hp / p.maxHp;
    const low = hull < 0.3 && Math.floor(T * 8) & 1;
    text(ctx, 'HULL', hx + 6, hy + 5, low ? PAL.alarm : PAL.silver);
    bar(ctx, hx + 33, hy + 5, 13, hull, hull > 0.55 ? PAL.lime : hull > 0.3 ? PAL.yellow : PAL.alarm);
    text(ctx, 'SPD', hx + 6, hy + 16, PAL.silver);
    bar(ctx, hx + 33, hy + 16, 13, Math.hypot(p.vx, p.vy) / 500, p.nitro > 0 ? PAL.yellow : PAL.cyan);

    /* who wrecked whom */
    if (g.combat) {
      let fy = touch ? Tp + 98 : Tp + 40;
      for (const f of g.feed) {
        if (f.t > 4.2 && Math.floor(T * 12) & 1) continue;
        const line = f.a ? f.a + ' WRECKED ' + f.b : f.b + (f.zone ? ' LOST TO THE ZONE' : ' CRASHED');
        text(ctx, line, L + 2, fy, f.a === p.name ? PAL.yellow : f.b === p.name ? PAL.alarm : PAL.silver, 1, 'left', PAL.ink);
        fy += 9;
      }
    }

    /* weapon slot (keyboard play; on touch the FIRE button shows it) */
    if (!touch) {
      const rx = Rr - 72, ry = B - 34, held = p.rewind > 0;
      if (!g.combat) { // no do-overs in a fight
        panel(ctx, rx, ry, 34, 34, held ? (Math.floor(T * 4) & 1 ? PAL.white : PAL.violet) : PAL.slate);
        if (!held) ctx.globalAlpha = 0.3;
        ctx.drawImage(Art.icons.rewind, rx + 8, ry + 4, 18, 18);
        ctx.globalAlpha = 1;
        text(ctx, 'E', rx + 17, ry + 25, held ? PAL.white : PAL.steel, 1, 'center');
        if (held) text(ctx, 'DO-OVER', rx + 33, ry - 10, PAL.violet, 1, 'right', PAL.ink);
      }
      const wx = Rr - 34, wy = B - 34;
      panel(ctx, wx, wy, 34, 34, p.weapon ? RR.ITEMS[p.weapon].color : g.combat ? PAL.cyan : PAL.slate);
      if (p.weapon) {
        ctx.drawImage(Art.icons[p.weapon], wx + 8, wy + 4, 18, 18);
        text(ctx, 'X' + p.ammo, wx + 17, wy + 24, PAL.white, 1, 'center');
        text(ctx, RR.ITEMS[p.weapon].name, wx + 33, wy - 10, RR.ITEMS[p.weapon].color, 1, 'right', PAL.ink);
      } else if (g.combat) { // the built-in cannon never runs dry
        ctx.drawImage(Art.icons.blaster, wx + 8, wy + 4, 18, 18);
        text(ctx, 'CANNON', wx + 33, wy - 10, PAL.cyan, 1, 'right', PAL.ink);
      } else {
        text(ctx, 'NO', wx + 17, wy + 9, PAL.steel, 1, 'center');
        text(ctx, 'WPN', wx + 17, wy + 18, PAL.steel, 1, 'center');
      }
    }

    /* active power-up timers */
    let ey = touch ? hy + 33 : B - 58;
    const ex = touch ? L + 2 : Rr - 100;
    if (p.shield > 0) {
      ctx.drawImage(Art.icons.shield, ex, ey - 1);
      bar(ctx, ex + 13, ey, 9, p.shield / C.SHIELD_TIME, PAL.cyan);
      ey += touch ? 12 : -12;
    }
    if (p.nitro > 0) {
      ctx.drawImage(Art.icons.nitro, ex, ey - 1);
      bar(ctx, ex + 13, ey, 9, p.nitro / C.NITRO_TIME, PAL.yellow);
    }

    /* big centre messages */
    const my = Math.round(H * (narrow ? 0.3 : 0.24));
    if (p.rw) {
      const sc = W < 300 ? 2 : 3;
      if (Math.floor(T * 8) & 1) text(ctx, '<< REWIND <<', W / 2, my, PAL.violet, sc, 'center', PAL.ink);
      text(ctx, '-' + (p.rw.span * (1 - p.rw.u)).toFixed(1) + 'S', W / 2, my + sc * 9 + 4, PAL.cyan, 2, 'center', PAL.ink);
    } else if (g.phase === 'countdown') {
      const n = Math.ceil(g.count);
      if (n > 3) text(ctx, 'READY', W / 2, my + 8, PAL.white, 4, 'center', PAL.ink);
      else text(ctx, String(n), W / 2, my - 6, [PAL.lime, PAL.lime, PAL.yellow, PAL.alarm][n], 8, 'center', PAL.ink);
      // how-to-fly reminder while the lights count down
      const hy2 = Math.round(H * (touch ? 0.56 : 0.62));
      if (touch) {
        text(ctx, 'DRAG ANYWHERE: FLY THAT WAY', W / 2, hy2, PAL.cyan, 1, 'center', PAL.ink);
        text(ctx, 'DRAG FARTHER: MORE POWER', W / 2, hy2 + 10, PAL.cyan, 1, 'center', PAL.ink);
        text(ctx, 'FIRE STICK: SHOOT THAT WAY', W / 2, hy2 + 20, PAL.cyan, 1, 'center', PAL.ink);
      } else {
        text(ctx, 'ARROWS / WASD TO FLY - SPACE TO FIRE', W / 2, hy2, PAL.cyan, 1, 'center', PAL.ink);
      }
      text(ctx, g.royale ? 'LAST SHIP FLYING WINS' : g.combat ? 'WRECK THEM - FIRST TO ' + C.KILL_TARGET + ' KILLS' : 'FLY THROUGH THE GLOWING DONUT',
        W / 2, hy2 + (touch ? 34 : 12), PAL.pink, 1, 'center', PAL.ink);
    } else if (g.msg) {
      const m = g.msg;
      const sc = Math.max(1, Math.min(m.scale, Math.floor((W - 12) / (m.text.length * 6))));
      if (m.t < m.dur - 0.3 || Math.floor(T * 16) & 1) text(ctx, m.text, W / 2, my, m.color, sc, 'center', PAL.ink);
    }
    if (g.state === 'play' && !g.playerDone && Math.floor(T * 5) & 1) {
      if (p.zoned && p.dead <= 0) text(ctx, 'OUTSIDE THE ZONE!', W / 2, H * 0.64, PAL.alarm, 2, 'center', PAL.ink);
      else if (p.out) text(ctx, g.combat ? 'ARENA WALL - TURN BACK!' : 'RETURN TO THE COURSE!', W / 2, H * 0.64, PAL.alarm, 1, 'center', PAL.ink);
      else if (p.wrong > 1.1) text(ctx, 'WRONG WAY!', W / 2, H * 0.64, PAL.alarm, 2, 'center', PAL.ink);
    }
    if (p.dead > 0 && !p.rw && !p.gone && g.state === 'play') text(ctx, 'RESPAWNING', W / 2, H * 0.5, PAL.silver, 1, 'center', PAL.ink);

    if (touch && g.state === 'play') {
      const by = narrow ? cy + 40 : Tp + mm.h + 8;
      button(g, ctx, 'II', Rr - 26, by, 26, 18, function () { g.pause(); });
      button(g, ctx, 'ZOOM', Rr - 64, by, 34, 18, function () { g.zoomCycle(); }, PAL.cyan);
    }
  }

  /** One fixed thumb-stick: base ring, and a knob pushed out to where the thumb is. */
  function drawStick(ctx, c, st, col, idleCol) {
    const on = !!st;
    ctx.globalAlpha = on ? 0.32 : 0.18;
    RR.disc(ctx, c.x, c.y, c.r, PAL.navy);
    ctx.globalAlpha = on ? 0.95 : 0.6;
    RR.ring(ctx, c.x, c.y, c.r, on ? PAL.white : idleCol);
    const kx = c.x + (st ? st.dx : 0), ky = c.y + (st ? st.dy : 0);
    RR.disc(ctx, kx, ky, 12, on ? col : PAL.slate);
    ctx.globalAlpha = 1;
    RR.ring(ctx, kx, ky, 12, on ? PAL.white : idleCol);
    return { x: kx, y: ky };
  }

  /** A label under a stick, or over it when the stick sits at the bottom edge. */
  function stickLabel(ctx, c, str, col, H, ins) {
    const below = c.y + c.r + 5;
    text(ctx, str, c.x, below + 7 <= H - ins.b - 1 ? below : c.y - c.r - 12, col, 1, 'center', PAL.ink);
  }

  /**
   * The steering drag: a dot where the touch began, a line to the thumb, and a
   * power meter above it (below, near the top of the screen) that fills as the
   * drag lengthens and flashes MAX at full power. Nothing else is drawn round
   * the touch, so the view of the race stays clear.
   */
  function drawDrag(ctx, dr, W, H, ins, T) {
    const pw = dr.power, full = pw >= 0.999, blink = Math.floor(T * 8) & 1;
    const col = pw < 0.6 ? PAL.lime : pw < 0.8 ? PAL.yellow : PAL.orange;
    const hot = blink ? PAL.white : PAL.orange;
    const ex = dr.x + dr.dx, ey = dr.y + dr.dy;

    // no ring or disc round the touch: just where it began and the way it points
    if (dr.dist > 2) RR.line(ctx, dr.x, dr.y, ex, ey, col, 2);
    RR.disc(ctx, dr.x, dr.y, 2, PAL.white);

    // the meter: ten segments, green to orange, well clear of the thumb
    const n = 10, mw = n * 6 - 1 + 8, mh = 22;
    const lit = pw <= 0 ? 0 : Math.max(1, Math.round(pw * n));
    const mx = Math.round(clamp(dr.x - mw / 2, ins.l + 2, W - ins.r - mw - 2));
    let my = Math.round(dr.y - dr.max - mh - 20);
    if (my < ins.t + 2) my = Math.round(Math.min(dr.y + dr.max + 20, H - ins.b - mh - 2));
    panel(ctx, mx, my, mw, mh, full ? hot : PAL.slate);
    text(ctx, 'POWER', mx + 4, my + 3, PAL.silver);
    text(ctx, full ? 'MAX' : Math.round(pw * 100) + '%', mx + mw - 4, my + 3, full ? hot : col, 1, 'right');
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i >= lit ? PAL.dusk : i < 6 ? PAL.lime : i < 8 ? PAL.yellow : PAL.orange;
      ctx.fillRect(mx + 4 + i * 6, my + 13, 5, 6);
    }
    // what was drawn and where (the tests read this)
    return { x: mx, y: my, w: mw, h: mh, lit: lit, of: n, full: full, segX: mx + 4, segY: my + 13, segStep: 6 };
  }

  function drawTouch(g, ctx, W, H) {
    const L = RR.touchLayout(W, H, g.inset), t = RR.input.touch, p = g.player, ins = g.inset;

    /* steering: a drag from anywhere; until the first one, say so */
    g.meter = t.drag ? drawDrag(ctx, t.drag, W, H, ins, g.t) : null;
    if (t.drag) {
      if (t.drag.power > 0) p.dragged = true;
    } else if (!p.dragged && g.phase === 'race' && Math.floor(g.t * 2) & 1) {
      text(ctx, 'DRAG ANYWHERE TO FLY', ins.l + 8, H - ins.b - 26, PAL.silver, 1, 'left', PAL.ink);
      text(ctx, 'FARTHER = MORE POWER', ins.l + 8, H - ins.b - 16, PAL.silver, 1, 'left', PAL.ink);
    }

    /* fire stick: push to aim and fire that way, hold the middle to fire ahead */
    const w = p.weapon || (g.combat ? 'blaster' : null);
    const wc = p.weapon ? RR.ITEMS[p.weapon].color : g.combat ? PAL.cyan : PAL.steel;
    const knob = drawStick(ctx, L.fire, t.aimStick, wc, w ? wc : PAL.steel);
    if (w) ctx.drawImage(Art.icons[w], knob.x - 4, knob.y - 4);
    const what = p.weapon ? RR.ITEMS[p.weapon].name + ' X' + p.ammo : g.combat ? 'CANNON' : 'NO WEAPON';
    stickLabel(ctx, L.fire, t.aimStick ? 'AIM' : what, t.aimStick ? PAL.white : wc, H, ins);

    const key = function (r, on, col) {
      panel(ctx, r.x, r.y, r.w, r.h, on ? PAL.white : col);
      if (on) { ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2); }
    };
    key(L.brake, t.brake, PAL.steel);
    text(ctx, 'BRAKE', L.brake.x + L.brake.w / 2, L.brake.y + 18, PAL.silver, 1, 'center');

    if (p.rewind > 0 && !p.rw) {
      const r = L.rewind;
      panel(ctx, r.x, r.y, r.w, r.h, Math.floor(g.t * 4) & 1 ? PAL.white : PAL.violet);
      ctx.drawImage(Art.icons.rewind, r.x + 13, r.y + 6, 18, 18);
      text(ctx, 'DO-OVER', r.x + r.w / 2, r.y + 31, PAL.violet, 1, 'center');
      g.ui.push({ x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8, act: function () { g.tryRewind(); } });
    }
  }

  /** Pause > MOVE CONTROLS: every control shown with its name, ready to be dragged. */
  function drawLayout(g, ctx, W, H) {
    const L = RR.touchLayout(W, H, g.inset), ins = g.inset, top = 8 + ins.t;
    ctx.fillStyle = 'rgba(7,7,26,0.78)';
    ctx.fillRect(0, 0, W, H);
    text(ctx, 'MOVE CONTROLS', W / 2, top, PAL.white, 2, 'center', PAL.plum);
    text(ctx, 'DRAG EACH ONE WHERE YOUR THUMB LIKES IT', W / 2, top + 20, PAL.silver, 1, 'center', PAL.ink);
    text(ctx, (g.orientation() === 'land' ? 'SIDEWAYS' : 'UPRIGHT') + ' LAYOUT, SAVED SEPARATELY', W / 2, top + 30, PAL.steel, 1, 'center', PAL.ink);
    const bw = 64;
    button(g, ctx, 'DONE', Math.round(W / 2 - bw - 4), top + 43, bw, 18, function () { g.closeControls(); }, PAL.lime);
    button(g, ctx, 'RESET', Math.round(W / 2 + 4), top + 43, bw, 18, function () { g.resetControls(); }, PAL.orange);

    const held = {};
    for (const id in RR.input.pointers) { const d = RR.input.pointers[id].drag; if (d) held[d] = true; }
    const ring = function (c, n) { RR.ring(ctx, c.x, c.y, c.r, held[n] ? PAL.white : PAL.yellow, held[n] ? 0 : 12, g.t * 2); };
    drawStick(ctx, L.fire, null, PAL.cyan, PAL.silver); ring(L.fire, 'fire');
    stickLabel(ctx, L.fire, 'AIM + FIRE', PAL.yellow, H, ins);
    panel(ctx, L.brake.x, L.brake.y, L.brake.w, L.brake.h, held.brake ? PAL.white : PAL.yellow);
    text(ctx, 'BRAKE', L.brake.x + L.brake.w / 2, L.brake.y + 18, PAL.yellow, 1, 'center');
    const r = L.rewind;
    panel(ctx, r.x, r.y, r.w, r.h, held.rewind ? PAL.white : PAL.yellow);
    ctx.drawImage(Art.icons.rewind, r.x + 13, r.y + 6, 18, 18);
    text(ctx, 'DO-OVER', r.x + r.w / 2, r.y + 31, PAL.yellow, 1, 'center');
  }

  /* ------------------------------------------------------------ overlays */

  let logoA = null, logoB = null;
  const DIFF_TAG = ['R', 'P', 'A'], DIFF_COL = [PAL.lime, PAL.yellow, PAL.alarm];

  function canFullscreen() {
    const d = document;
    return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
  }

  function drawTitle(g, ctx, W, H) {
    const T = g.t, touch = RR.input.touchMode, net = RR.net, ins = g.inset;
    ctx.fillStyle = 'rgba(7,7,26,0.5)';
    ctx.fillRect(0, 0, W, H);
    if (!logoA) {
      logoA = Art.logo('ROCKET', ['#ffffff', '#fff1a8', '#ffcd75', '#ffb04a', '#ef7d57', '#e5404f', '#c93f6a']);
      logoB = Art.logo('RACER', ['#ffffff', '#c8f6ff', '#73eff7', '#41a6f6', '#3b82f6', '#3b5dc9', '#4a3fb0']);
    }
    const compact = H < 300, tall = H > W * 1.2;
    const bob = Math.round(Math.sin(T * 2) * 2);
    let y = Math.round(H * (tall ? 0.09 : 0.05)) + ins.t;
    if (W >= H * 1.35) {
      // one line: ROCKET RACER
      const lw = logoA.width + logoB.width + 4;
      const s = clamp(Math.min(Math.floor((W - 16) / lw), Math.floor(H / 80)), 1, 5);
      const x = Math.round((W - lw * s) / 2);
      ctx.drawImage(logoA, x, y + bob, logoA.width * s, logoA.height * s);
      ctx.drawImage(logoB, x + (logoA.width + 4) * s, y + bob, logoB.width * s, logoB.height * s);
      y += logoA.height * s + 5;
    } else {
      // stacked for tall screens
      const s = clamp(Math.min(Math.floor((W - 12) / (logoA.width + 6)), Math.floor(H / 110)), 1, 5);
      const x = Math.round((W - (logoA.width + 6) * s) / 2);
      ctx.drawImage(logoA, x, y + bob, logoA.width * s, logoA.height * s);
      ctx.drawImage(logoB, x + 12 * s, y + bob + (logoA.height - 2) * s, logoB.width * s, logoB.height * s);
      y += (logoA.height * 2 - 2) * s + 5;
    }
    text(ctx, 'GALACTIC DONUT GRAND PRIX', W / 2, y, PAL.pink, 1, 'center', PAL.ink);

    // which deployment this is: a loud badge anywhere but production, and a quiet build id
    if (net.online && net.env && net.env !== 'production') {
      const label = net.env.toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 12) + ' BUILD';
      const lw = RR.textW(label) + 10;
      panel(ctx, 4 + ins.l, 4 + ins.t, lw, 13, PAL.alarm);
      text(ctx, label, 9 + ins.l, 7 + ins.t, Math.floor(T * 2) & 1 ? PAL.alarm : PAL.yellow);
    }
    // touch screens have no M key: a speaker switch in the corner, kept out of the menu card
    // so the card still fits a phone held sideways
    if (touch) {
      const off = RR.audio.muted, bw = 22, bh = 16, bx = W - 4 - ins.r - bw, by = 4 + ins.t;
      panel(ctx, bx, by, bw, bh, off ? PAL.steel : PAL.lime);
      ctx.drawImage(Art.icons[off ? 'speakerOff' : 'speaker'], bx + 6, by + 4);
      // a finger-sized hit area around the small button
      g.ui.push({ x: bx - 8, y: by - 4, w: bw + 12, h: bh + 12, act: function () { g.toggleSound(); }, label: off ? 'SOUND OFF' : 'SOUND ON' });
    }
    if (net.online && /^[0-9a-f]{7,40}$/.test(net.version)) {
      text(ctx, net.version.slice(0, 7), W - 4 - ins.r - (touch ? 26 : 0), 4 + ins.t, PAL.slate, 1, 'right');
    }
    y += compact ? 13 : 18;

    /* menu card */
    const gap = compact ? 3 : 6;
    const pw = Math.min(W - 8, 300), px = Math.round((W - pw) / 2);
    const mode = RR.MODES[g.modeIdx], fight = g.modeIdx !== 0;

    // small buttons under PRESS ENTER, wrapped onto as many lines as they need
    const spare = g.pointsLeft(g.prog.ship), items = [];
    items.push(['HANGAR' + (touch ? '' : ' (H)') + (spare > 0 ? ' +' + spare : ''), function () { g.openHangar(); },
      spare > 0 && Math.floor(T * 3) & 1 ? PAL.white : PAL.yellow]);
    if (net.online) {
      items.push(['PILOT ' + g.name + (touch ? '' : ' (N)'), function () { g.editName(); }, PAL.cyan]);
      if (!fight) items.push(['TOP 10' + (touch ? '' : ' (T)'), function () { g.showBoard(); }, PAL.pink]);
    }
    if (touch && canFullscreen()) items.push([g.isFullscreen() ? 'EXIT FULL' : 'FULLSCREEN', function () { g.fullscreen(); }, PAL.silver]);
    const lines = [[]];
    let lineW = 0;
    items.forEach(function (it) {
      it.w = RR.textW(it[0]) + 10;
      if (lineW && lineW + 4 + it.w > pw - 8) { lines.push([]); lineW = 0; }
      lineW += (lineW ? 4 : 0) + it.w;
      lines[lines.length - 1].push(it);
    });

    const ph = 5 + 27 + gap + 27 + 10 + 10 + gap + 27 + gap + 21 + gap + 2 + lines.length * 18 - 2 + 6;
    panel(ctx, px, y - 5, pw, ph, PAL.navy);

    const row = function (idx, label, value, onL, onR) {
      const sel = g.menuRow === idx && !touch;
      text(ctx, label, W / 2, y, sel ? PAL.yellow : PAL.silver, 1, 'center', PAL.ink);
      text(ctx, value, W / 2, y + 10, PAL.white, 2, 'center', PAL.ink);
      const ax = Math.min(pw / 2 - 12, 112), nud = sel ? Math.round(Math.sin(T * 8) * 1.5) : 0;
      const col = sel || touch ? PAL.yellow : PAL.steel;
      text(ctx, '<', W / 2 - ax - nud, y + 10, col, 2, 'center', PAL.ink);
      text(ctx, '>', W / 2 + ax + nud, y + 10, col, 2, 'center', PAL.ink);
      g.ui.push({ x: W / 2 - ax - 24, y: y - 3, w: 48, h: 31, act: onL });
      g.ui.push({ x: W / 2 + ax - 24, y: y - 3, w: 48, h: 31, act: onR });
    };

    row(0, 'EVENT', mode.name, function () { g.setMode(-1); }, function () { g.setMode(1); });
    y += 27 + gap;
    const list = fight ? RR.ARENAS : RR.TRACKS, at = fight ? g.arenaIdx : g.trackIdx;
    const def = list[at], rec = g.best[def.id], board = net.boards[def.id];
    row(1, (fight ? 'ARENA ' : 'COURSE ') + (at + 1) + '/' + list.length, def.name,
      function () { g.setTrack(-1); }, function () { g.setTrack(1); });
    y += 27;
    text(ctx, def.blurb, W / 2, y, PAL.sky, 1, 'center', PAL.ink);
    y += 10;
    if (fight) text(ctx, mode.rule, W / 2, y, PAL.silver, 1, 'center', PAL.ink);
    else {
      let line = rec && rec.race ? 'YOU ' + fmt(rec.race) : def.laps + ' LAPS';
      if (net.online) line += '   WORLD ' + (board && board.length ? fmt(board[0].time) + ' ' + board[0].name : '-:--.--');
      else if (!(rec && rec.race)) line += ' - NO RECORD YET';
      text(ctx, line, W / 2, y, rec && rec.race ? PAL.yellow : PAL.silver, 1, 'center', PAL.ink);
    }
    y += 10 + gap;
    row(2, 'RIVALS', RR.DIFFS[g.diffIdx].name, function () { g.setDiff(-1); }, function () { g.setDiff(1); });
    y += 27 + gap;

    const bw = Math.min(150, pw - 20), bx = Math.round(W / 2 - bw / 2), hot = Math.floor(T * 3) & 1;
    panel(ctx, bx, y, bw, 21, hot ? PAL.yellow : PAL.orange);
    text(ctx, touch ? 'TAP TO ' + mode.go : 'PRESS ENTER', W / 2, y + 4, hot ? PAL.yellow : PAL.orange, 2, 'center', PAL.ink);
    g.ui.push({ x: bx, y: y - 2, w: bw, h: 25, act: function () { g.begin(); } });
    y += 21 + gap + 2;

    lines.forEach(function (ln) {
      let tw = (ln.length - 1) * 4;
      ln.forEach(function (it) { tw += it.w; });
      let ix = Math.round(W / 2 - tw / 2);
      ln.forEach(function (it) {
        button(g, ctx, it[0], ix, y, it.w, 16, it[1], it[2]);
        ix += it.w + 4;
      });
      y += 18;
    });
    y -= 2;

    const fy = H - 22 - ins.b;
    if (y + 8 > fy) return; // no room for the help lines on very short screens
    if (touch) {
      let ty = fy - 16;
      if (tall && y + 30 < ty) { text(ctx, 'TIP: TURN YOUR PHONE SIDEWAYS', W / 2, ty, PAL.yellow, 1, 'center', PAL.ink); ty -= 12; }
      if (g.homeScreenTip() && y + 30 < ty) { // iPhones can't go full screen from a web page
        text(ctx, 'FULL SCREEN: SHARE > ADD TO HOME SCREEN', W / 2, ty, PAL.cyan, 1, 'center', PAL.ink);
      }
      text(ctx, fight ? 'WIN EVENTS TO EARN STAT POINTS' : 'FLY THROUGH EVERY DONUT IN ORDER', W / 2, fy, PAL.silver, 1, 'center', PAL.ink);
      text(ctx, fight ? 'AND UNLOCK BETTER SHIPS' : 'GRAB POWER-UPS - BLAST YOUR RIVALS', W / 2, fy + 10, PAL.silver, 1, 'center', PAL.ink);
    } else if (W >= 440) {
      text(ctx, 'ARROWS / WASD  FLY    SPACE  FIRE    E  DO-OVER    P  PAUSE', W / 2, fy, PAL.silver, 1, 'center', PAL.ink);
      text(ctx, 'H  HANGAR    Z OR WHEEL  ZOOM    M  MUTE    C  CRT    F  FULLSCREEN', W / 2, fy + 10, PAL.steel, 1, 'center', PAL.ink);
    } else {
      text(ctx, 'ARROWS/WASD FLY - SPACE FIRE - E REWIND', W / 2, fy, PAL.silver, 1, 'center', PAL.ink);
      text(ctx, 'H HANGAR - Z ZOOM - P PAUSE - M MUTE', W / 2, fy + 10, PAL.steel, 1, 'center', PAL.ink);
    }
  }

  /**
   * World top 10 for the selected course. Each row shows where that pilot
   * finished in the race that set the time; below the list comes your own row
   * and world rank when you are not in the top 10.
   */
  function drawBoard(g, ctx, W, H) {
    const def = RR.TRACKS[g.trackIdx], net = RR.net, list = net.boards[def.id], mine = net.me[def.id], rec = g.best[def.id];
    ctx.fillStyle = 'rgba(7,7,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 240), ph = 206;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    const cPlace = x + pw - 92, cDiff = x + pw - 62, cTime = x + pw - 10;
    panel(ctx, x, y, pw, ph, PAL.pink);
    text(ctx, 'WORLD TOP 10', W / 2, y + 7, PAL.pink, 2, 'center', PAL.plum);
    text(ctx, def.name, W / 2, y + 25, PAL.sky, 1, 'center');

    const row = function (ry, rank, e, col) {
      text(ctx, String(rank), x + 22, ry, col, 1, 'right');
      text(ctx, e.name, x + 30, ry, col);
      // finishing place in that race; older rows were saved without one
      if (e.place >= 1 && e.place <= 6) text(ctx, ORD[e.place - 1], cPlace, ry, col === PAL.yellow ? col : PLACE_COL[e.place - 1]);
      else text(ctx, '-', cPlace + 6, ry, PAL.steel);
      text(ctx, DIFF_TAG[e.diff] || '', cDiff, ry, DIFF_COL[e.diff] || PAL.steel);
      text(ctx, fmt(e.time), cTime, ry, col, 1, 'right');
    };
    const isMine = function (e) {
      if (mine) return e.name === mine.name && e.time === mine.time;
      return e.name === g.name && rec && Math.abs(rec.race - e.time) < 0.011; // before our own row has loaded
    };

    let ry = y + 48;
    if (!list) {
      text(ctx, net.failed[def.id] ? 'LEADERBOARD UNAVAILABLE' : 'LOADING...', W / 2, ry + 40, PAL.silver, 1, 'center');
    } else if (!list.length) {
      text(ctx, 'NO TIMES YET', W / 2, ry + 34, PAL.silver, 1, 'center');
      text(ctx, 'BE THE FIRST!', W / 2, ry + 46, PAL.yellow, 1, 'center');
    } else {
      text(ctx, '#', x + 22, y + 37, PAL.steel, 1, 'right');
      text(ctx, 'PILOT', x + 30, y + 37, PAL.steel);
      text(ctx, 'RACE', cPlace - 3, y + 37, PAL.steel);
      text(ctx, 'TIME', cTime, y + 37, PAL.steel, 1, 'right');
      let shown = false;
      for (let i = 0; i < list.length && i < 10; i++) {
        const e = list[i], me = isMine(e);
        if (me) { shown = true; ctx.fillStyle = 'rgba(255,205,117,0.16)'; ctx.fillRect(x + 5, ry - 2, pw - 10, 11); }
        row(ry, i + 1, e, me ? PAL.yellow : i === 0 ? PAL.gold : PAL.white);
        ry += 11;
      }
      // your own standing, when it is not already highlighted above
      const my = y + 161;
      if (mine && !shown) {
        RR.line(ctx, x + 8, my - 5, x + pw - 9, my - 5, PAL.steel, 3);
        ctx.fillStyle = 'rgba(255,205,117,0.16)';
        ctx.fillRect(x + 5, my - 2, pw - 10, 11);
        row(my, mine.rank > 999 ? '999+' : mine.rank, mine, PAL.yellow);
      } else if (mine === null) {
        text(ctx, 'FINISH A RACE HERE TO JOIN THE BOARD', W / 2, my, PAL.steel, 1, 'center');
      }
    }
    text(ctx, 'R ROOKIE  P PILOT  A ACE', W / 2, y + ph - 34, PAL.steel, 1, 'center');
    const bw = 90;
    button(g, ctx, RR.input.touchMode ? 'CLOSE' : 'CLOSE (ENTER)', Math.round(W / 2 - bw / 2), y + ph - 23, bw, 17,
      function () { g.closeBoard(); }, PAL.lime);
  }

  /**
   * The hangar: pick a ship and spend stat points on it. Each bar shows the
   * ship's own level (grey), points you have put in (yellow) and room left up
   * to that ship's ceiling; the dots past the end are out of its reach.
   */
  function drawHangar(g, ctx, W, H) {
    const T = g.t, touch = RR.input.touchMode, ST = RR.STATS;
    const i = g.hangarShip, h = RR.HULLS[i], open = g.shipUnlocked(i), left = g.pointsLeft(i);
    ctx.fillStyle = 'rgba(7,7,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 250), ph = 216;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    panel(ctx, x, y, pw, ph, PAL.yellow);
    text(ctx, 'HANGAR', W / 2, y + 7, PAL.yellow, 2, 'center', PAL.plum);
    text(ctx, 'WINS ' + g.prog.wins + '    STAT POINTS ' + g.prog.points, W / 2, y + 25, PAL.silver, 1, 'center');
    const mark = function (ry, hh) { ctx.fillStyle = 'rgba(255,205,117,0.16)'; ctx.fillRect(x + 5, ry, pw - 10, hh); };

    /* the ship */
    const sy = y + 38, sel = g.hangarRow === 0 && !touch;
    if (sel) mark(sy - 3, 48);
    const spr = Art.ship(h.design, 0);
    if (!open) ctx.globalAlpha = 0.3;
    ctx.drawImage(spr, x + 30, sy, spr.width * 2, spr.height * 2);
    ctx.globalAlpha = 1;
    text(ctx, h.name, x + 70, sy + 3, open ? PAL.white : PAL.steel, 2, 'left', PAL.ink);
    text(ctx, h.blurb, x + 70, sy + 21, PAL.sky);
    const need = h.wins - g.prog.wins;
    text(ctx, open ? 'YOUR SHIP' : 'LOCKED - ' + need + ' MORE WIN' + (need > 1 ? 'S' : ''), x + 70, sy + 32, open ? PAL.lime : PAL.alarm);
    const nud = sel ? Math.round(Math.sin(T * 8) * 1.5) : 0, acol = sel || touch ? PAL.yellow : PAL.steel;
    text(ctx, '<', x + 14 - nud, sy + 14, acol, 2, 'center', PAL.ink);
    text(ctx, '>', x + pw - 14 + nud, sy + 14, acol, 2, 'center', PAL.ink);
    g.ui.push({ x: x, y: sy - 3, w: 28, h: 48, act: function () { g.hangarBrowse(-1); } });
    g.ui.push({ x: x + pw - 28, y: sy - 3, w: 28, h: 48, act: function () { g.hangarBrowse(1); } });

    /* its stats */
    let ry = y + 92;
    const bx = x + 70;
    ST.forEach(function (st, k) {
      const lv = g.statLevel(i, k), base = h.base[k], cap = h.cap[k], on = g.hangarRow === k + 1 && !touch;
      if (on) mark(ry - 4, 15);
      text(ctx, st.name, x + 10, ry, on ? PAL.yellow : PAL.silver);
      for (let c = 0; c < 10; c++) {
        if (c >= cap) { ctx.fillStyle = PAL.slate; ctx.fillRect(bx + c * 5 + 1, ry + 3, 2, 1); continue; }
        ctx.fillStyle = c < base ? PAL.silver : c < lv ? PAL.yellow : PAL.dusk;
        ctx.fillRect(bx + c * 5, ry, 4, 7);
      }
      text(ctx, lv + '/' + cap, bx + 54, ry, lv >= cap ? PAL.lime : PAL.white);
      const less = open && lv > base, more = open && left > 0 && lv < cap;
      button(g, ctx, '-', x + pw - 52, ry - 4, 22, 15, function () { g.spend(i, k, -1); }, less ? PAL.white : PAL.slate);
      button(g, ctx, '+', x + pw - 27, ry - 4, 22, 15, function () { g.spend(i, k, 1); }, more ? PAL.yellow : PAL.slate);
      ry += 17;
    });
    text(ctx, open ? 'POINTS LEFT FOR THIS SHIP: ' + left : 'WIN RACES AND FIGHTS TO UNLOCK', W / 2, ry + 1,
      open && left > 0 ? PAL.yellow : PAL.steel, 1, 'center');

    const bw = 96;
    button(g, ctx, touch ? 'DONE' : 'DONE (ENTER)', Math.round(W / 2 - bw / 2), y + ph - 23, bw, 17,
      function () { g.closeHangar(); }, PAL.lime);
  }

  function drawPause(g, ctx, W, H) {
    ctx.fillStyle = 'rgba(7,7,26,0.6)';
    ctx.fillRect(0, 0, W, H);
    const y = Math.round(H / 2 - 56), touch = RR.input.touchMode;
    text(ctx, 'PAUSED', W / 2, y, PAL.white, 4, 'center', PAL.plum);
    const bw = 130, bx = Math.round(W / 2 - bw / 2);
    button(g, ctx, touch ? 'RESUME' : 'RESUME  (P)', bx, y + 42, bw, 20, function () { g.resume(); }, PAL.lime);
    button(g, ctx, touch ? 'RESTART' : 'RESTART  (R)', bx, y + 66, bw, 20, function () { g.begin(); }, PAL.yellow);
    button(g, ctx, touch ? 'QUIT TO MENU' : 'QUIT  (Q)', bx, y + 90, bw, 20, function () { g.toTitle(); }, PAL.orange);
    const snd = (RR.audio.muted ? 'SOUND OFF' : 'SOUND ON') + (touch ? '' : '  (M)');
    button(g, ctx, snd, bx, y + 114, bw, 20, function () { g.toggleSound(); }, RR.audio.muted ? PAL.steel : PAL.lime);
    if (touch) button(g, ctx, 'MOVE CONTROLS', bx, y + 138, bw, 20, function () { g.editControls(); }, PAL.cyan);
  }

  function drawResults(g, ctx, W, H) {
    const p = g.player, T = g.t, net = RR.net, touch = RR.input.touchMode;
    ctx.fillStyle = 'rgba(7,7,26,0.5)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 236), ph = 206;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    panel(ctx, x, y, pw, ph, PLACE_COL[p.place - 1]);
    text(ctx, g.track.name, W / 2, y + 8, PAL.sky, 1, 'center');
    const win = p.place === 1;
    text(ctx, ORD[p.place - 1] + ' PLACE' + (win ? '!' : ''), W / 2, y + 20,
      win && Math.floor(T * 6) & 1 ? PAL.white : PLACE_COL[p.place - 1], 3, 'center', PAL.plum);

    let ry = y + 52;
    for (let i = 0; i < g.order.length; i++) {
      const s = g.order[i], me = s === p;
      if (me) { ctx.fillStyle = 'rgba(255,205,117,0.16)'; ctx.fillRect(x + 6, ry - 3, pw - 12, 13); }
      const col = me ? PAL.yellow : PAL.white;
      text(ctx, String(i + 1), x + 14, ry, col);
      ctx.fillStyle = s.colors.a;
      ctx.fillRect(x + 28, ry, 7, 7);
      text(ctx, me ? g.name : s.name, x + 42, ry, col);
      if (g.royale) {
        text(ctx, s.kills + ' KILL' + (s.kills === 1 ? '' : 'S'), x + pw - 62, ry, col, 1, 'right');
        text(ctx, s.gone ? 'OUT' : g.over ? 'WINNER' : 'ALIVE', x + pw - 14, ry, s.gone ? PAL.steel : PAL.lime, 1, 'right');
      } else if (g.combat) {
        text(ctx, s.kills + ' KILL' + (s.kills === 1 ? '' : 'S'), x + pw - 62, ry, col, 1, 'right');
        text(ctx, s.deaths + ' LOST', x + pw - 14, ry, PAL.steel, 1, 'right');
      } else {
        text(ctx, s.finished ? fmt(s.finishTime) : 'RACING' + '...'.slice(0, 1 + (Math.floor(T * 3) % 3)),
          x + pw - 14, ry, s.finished ? col : PAL.steel, 1, 'right');
      }
      ry += 14;
    }
    ry += 3;
    if (g.combat) text(ctx, g.royale && !g.over ? 'THE FIGHT GOES ON WITHOUT YOU' : RR.DIFFS[g.diffIdx].name + ' RIVALS', W / 2, ry, PAL.cyan, 1, 'center');
    else {
      text(ctx, 'BEST LAP ' + fmt(p.bestLap) + (g.newRecord ? '   NEW RECORD!' : ''), W / 2, ry,
        g.newRecord && Math.floor(T * 4) & 1 ? PAL.yellow : PAL.cyan, 1, 'center');
    }
    // what it earned: stat points, and any ship the win unlocked
    const rw = g.reward;
    if (rw) {
      const fresh = rw.unlocked.length && Math.floor(T) & 1;
      text(ctx, fresh ? 'NEW SHIP IN THE HANGAR: ' + rw.unlocked.join(' ')
        : rw.pts ? '+' + rw.pts + ' STAT POINT' + (rw.pts > 1 ? 'S' : '') + ' FOR THE HANGAR' : 'TOP 3 EARNS STAT POINTS',
        W / 2, ry + 24, fresh ? PAL.lime : rw.pts ? PAL.yellow : PAL.steel, 1, 'center');
    }
    if (net.online && !g.combat) {
      const r = net.result;
      let msg = 'POSTING YOUR TIME...', col = PAL.silver;
      if (r && r.track === g.track.def.id) {
        if (r.error) { msg = 'LEADERBOARD UNAVAILABLE'; col = PAL.steel; }
        else { msg = 'WORLD RANK #' + r.rank + (r.improved ? '' : '  (YOUR BEST STANDS)'); col = r.rank <= 3 ? PAL.gold : PAL.pink; }
      }
      text(ctx, msg, W / 2, ry + 12, col, 1, 'center');
    }

    const bw = Math.floor((pw - 30) / 2), by = y + ph - 26;
    button(g, ctx, touch ? 'MENU' : 'MENU  (ENTER)', x + 10, by, bw, 19, function () { g.toTitle(); }, PAL.lime);
    button(g, ctx, touch ? 'RACE AGAIN' : 'RETRY  (R)', x + pw - 10 - bw, by, bw, 19, function () { g.begin(); }, PAL.yellow);
  }

  /* ---------------------------------------------------------------- frame */

  G.render = function (wctx, hctx) {
    const g = this, W = g.W, H = g.H;
    g.ui.length = 0;
    [wctx, hctx].forEach(function (c) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.imageSmoothingEnabled = false;
    });

    drawWorld(g, wctx, g.vw, g.vh); // zoomable layer underneath
    const ctx = hctx; // HUD layer on top: same pixel size at every zoom
    ctx.clearRect(0, 0, W, H);
    if (g.state === 'title') drawTitle(g, ctx, W, H);
    else if (g.state === 'board') drawBoard(g, ctx, W, H);
    else if (g.state === 'hangar') drawHangar(g, ctx, W, H);
    else {
      drawHUD(g, ctx, W, H);
      if (RR.input.touchMode && g.state === 'play') drawTouch(g, ctx, W, H);
      if (g.state === 'paused') drawPause(g, ctx, W, H);
      else if (g.state === 'layout') drawLayout(g, ctx, W, H);
      else if (g.state === 'results') drawResults(g, ctx, W, H);
    }
    if (g.toast && (g.toast.t < g.toast.dur - 0.3 || Math.floor(g.t * 16) & 1)) {
      // on touch screens the bottom corners belong to the buttons, so float it higher
      const ty = RR.input.touchMode ? Math.round(H * 0.7) : H - 40 - g.inset.b;
      text(ctx, g.toast.text, W / 2, ty, PAL.cyan, 2, 'center', PAL.ink);
    }
    if (RR.audio.muted && g.state !== 'play') text(ctx, 'SOUND OFF', W / 2, H - 9 - g.inset.b, PAL.steel, 1, 'center', PAL.ink);
  };
})();
