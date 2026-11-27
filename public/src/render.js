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
  /** Capture the flag's score as a line: RED 1 - 0 BLUE, or with three teams RED 1  BLUE 0  GREEN 2. */
  RR.scoreLine = function (caps) {
    const S = RR.SIDES;
    if (caps.length === 2) return S[0].name + ' ' + caps[0] + ' - ' + caps[1] + ' ' + S[1].name;
    return caps.map(function (c, k) { return S[k].name + ' ' + c; }).join('  ');
  };
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
   * GAS just above it, BRAKE to the left of GAS, and the DEFER button above
   * GAS (shown only while a gate deferral is held); those buttons follow the
   * fire stick wherever it is moved; and the FLY stick bottom left (steering
   * can also be a drag that starts anywhere else, see input.js). Each
   * control has a standard spot; the player can move them (Pause > Move
   * controls). Moved spots are kept as fractions of the screen, separately for
   * sideways and upright, and are always pulled back inside the screen and
   * clear of notches.
   */
  RR.touchLayout = function (W, H, ins) {
    ins = ins || NO_INSET;
    const R = 34, grab = R + 24; // a thumb landing within `grab` of a stick's centre takes it
    const g = RR.game, saved = (g && g.controls && g.controls[W >= H ? 'land' : 'port']) || {};
    const half = { steer: R + 2, fire: R + 2, brake: 21, gas: 21, defer: 22 }, centre = {};
    const place = function (n, d) { // a control's spot: where the player put it, else `d`; always on screen
      const sp = saved[n], h = half[n];
      centre[n] = {
        x: Math.round(clamp(sp ? sp.x * W : d.x, ins.l + h + 2, W - ins.r - h - 2)),
        y: Math.round(clamp(sp ? sp.y * H : d.y, ins.t + h + 2, H - ins.b - h - 2)),
      };
    };
    place('fire', { x: W - ins.r - 66, y: H - ins.b - 66 });
    place('steer', { x: ins.l + 66, y: H - ins.b - 66 }); // bottom left: the fire stick's mirror image
    // GAS just above the fire stick (wherever it has been moved), BRAKE beside it on the left, DEFER above GAS
    // (below the stick instead, if it sits too near the top for them to fit above)
    const f = centre.fire, way = f.y - 80 - 21 >= ins.t + 2 ? -1 : 1;
    place('gas', { x: f.x, y: f.y + way * 80 });
    place('brake', { x: f.x - 50, y: f.y + way * 80 });
    place('defer', { x: f.x, y: f.y + way * 134 });
    const box = function (c, w, h) { return { x: c.x - w / 2, y: c.y - h / 2, w: w, h: h }; };
    const sc = centre.steer;
    return {
      stickR: R,
      steer: { x: sc.x, y: sc.y, r: R, grab: grab },
      // the steer stick's other form (a tap on it): a turning slider, and a STICK tab above it to swap back
      slide: box(sc, 108, 30),
      tab: box({ x: sc.x, y: sc.y - 38 }, 46, 18),
      fire: { x: centre.fire.x, y: centre.fire.y, r: R, grab: grab },
      brake: box(centre.brake, 42, 42),
      gas: box(centre.gas, 42, 42),
      defer: box(centre.defer, 44, 44),
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

  /** A team's flag: a white pole standing at (x, y), its cloth waving in the team's colour. */
  function drawFlag(ctx, x, y, side, t) {
    const S = RR.SIDES[side], X = Math.round(x), Y = Math.round(y);
    ctx.fillStyle = PAL.ink; ctx.fillRect(X - 1, Y - 20, 3, 22);
    ctx.fillStyle = PAL.white; ctx.fillRect(X, Y - 19, 1, 20);
    for (let c = 0; c < 10; c++) {
      const dy = Math.round(Math.sin(t * 6 - c * 0.7) * 1.3 * (c / 9));
      ctx.fillStyle = PAL.ink; ctx.fillRect(X + 1 + c, Y - 20 + dy, 1, 9);
      ctx.fillStyle = c < 2 ? S.light : S.color; ctx.fillRect(X + 1 + c, Y - 19 + dy, 1, 7);
    }
  }

  const TAG_HOLD = 2; // seconds a human pilot's name stays over their ship
  RR.TAG_HOLD = TAG_HOLD;

  /** A ship flown by a person: online, any player's (even while a bot stands in); offline, yours. */
  function humanPilot(g, s) { return g.online ? !!s.human : s === g.player; }

  /**
   * Names over human pilots' ships, on the HUD layer so they stay readable at
   * every zoom: everyone's through the countdown and the first TAG_HOLD
   * seconds of the race, then a pilot's for TAG_HOLD seconds each time their
   * ship comes into view. `g.tagsShown` lists them, for the tests.
   */
  function drawTags(g, ctx) {
    g.tagsShown = [];
    if (g.demo || g.state !== 'play' || !g.view) return;
    const start = g.phase !== 'race' || g.raceTime < TAG_HOLD, z = g.zoomScale;
    for (const s of g.ships) {
      if (!s.inView || !humanPilot(g, s)) continue;
      const left = start ? TAG_HOLD : (s.tagUntil || 0) - g.t;
      if (left <= 0) continue;
      g.tagsShown.push(!g.online && s === g.player ? g.name : s.name);
      if (left < 0.3 && Math.floor(g.t * 16) & 1) continue; // blinks out
      const x = Math.round((s.x - g.view.cx) * z), y = Math.round((s.y - g.view.cy - 14) * z) - 10;
      text(ctx, !g.online && s === g.player ? g.name : s.name, x, y, s.colors.i, 1, 'center', PAL.ink); // (offline, your ship is "YOU")
    }
  }

  function drawWorld(g, ctx, W, H) {
    const tr = g.track, p = g.player;
    const shx = g.shake > 0.4 ? (Math.random() - 0.5) * 2 * g.shake : 0;
    const shy = g.shake > 0.4 ? (Math.random() - 0.5) * 2 * g.shake : 0;
    const cx = Math.round(g.cam.x - W / 2 + shx), cy = Math.round(g.cam.y - H / 2 + shy);
    const vis = function (x, y, pad) { return x > -pad && y > -pad && x < W + pad && y < H + pad; };
    g.view = { cx: cx, cy: cy }; // where the world layer looks, for the name tags on the HUD

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

    /* donut gates — the next one glows and gets a marching halo (all sized to the course's donuts) */
    const D = Art.donuts(tr.donut), half = D.half, k = tr.donut || 1;
    for (const d of tr.donuts) {
      const sx = d.x - cx, sy = d.y - cy;
      if (!vis(sx, sy, half + 28)) continue;
      const active = !g.demo && !g.playerDone && d.ids.indexOf(p.nextCp) >= 0;
      const bright = active || g.demo;
      if (active) glow(ctx, sx, sy, Math.round(78 * k), d.finish ? '#fff1a8' : '#ff6fb5', 0.62 + 0.38 * Math.sin(g.t * 7));
      ctx.drawImage(d.finish ? (bright ? D.finFull : D.finDim) : (bright ? D.full : D.dim), sx - half, sy - half);
      if (active) {
        RR.ring(ctx, sx, sy, D.rc + D.rt + 5 + Math.round(Math.sin(g.t * 7) * 2), PAL.yellow, Math.round(14 * k), g.t * 9);
        RR.ring(ctx, sx, sy, D.rc - D.rt - 5, PAL.white, Math.round(8 * k), -g.t * 6);
      }
    }

    /* arena wall (dashed) and, in a battle royale, the closing zone */
    if (g.combat) {
      const b = tr.bounds, rw = tr.wall;
      ctx.fillStyle = PAL.steel;
      if (rw) { // a round arena: a dash every 8 pixels round the circle, where it is on screen
        const n = Math.floor((rw.r * RR.TAU) / 8);
        if (Math.abs(Math.hypot(rw.x - g.cam.x, rw.y - g.cam.y) - rw.r) < W + H) {
          for (let i = 0; i < n; i++) {
            const a = (i / n) * RR.TAU, x = Math.round(rw.x + Math.cos(a) * rw.r - cx), y = Math.round(rw.y + Math.sin(a) * rw.r - cy);
            if (x > -3 && y > -3 && x < W + 3 && y < H + 3) ctx.fillRect(x - 1, y - 1, 2, 2);
          }
        }
      } else {
        for (let wx = Math.ceil(Math.max(b.x0, cx) / 8) * 8; wx <= Math.min(b.x1, cx + W); wx += 8) {
          ctx.fillRect(wx - cx, b.y0 - cy, 4, 1);
          ctx.fillRect(wx - cx, b.y1 - cy, 4, 1);
        }
        for (let wy = Math.ceil(Math.max(b.y0, cy) / 8) * 8; wy <= Math.min(b.y1, cy + H); wy += 8) {
          ctx.fillRect(b.x0 - cx, wy - cy, 1, 4);
          ctx.fillRect(b.x1 - cx, wy - cy, 1, 4);
        }
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
      glow(ctx, sx, sy, 17, pk.kind === 'W' ? '#e5404f' : pk.type === 'defer' ? '#a855f7' : pk.type === 'reflag' ? '#f5b82e' : '#38b764');
      ctx.drawImage(Art.pickups[pk.type], sx - 8, sy - 8);
    }

    /* while holding a gate deferral: the gate it would defer, ringed in violet */
    if (!g.demo && g.state === 'play' && g.canDefer(p)) {
      const cp = tr.cps[p.nextCp], sx = cp.x - cx, sy = cp.y - cy;
      if (vis(sx, sy, D.rc + D.rt + 30)) {
        RR.ring(ctx, sx, sy, D.rc + D.rt + 11, PAL.violet, Math.round(10 * k), g.t * 3);
        RR.ring(ctx, sx, sy, D.rc + D.rt + 14, '#5b21b6', Math.round(10 * k), -g.t * 3);
      }
    }

    /* capture the flag: the bases, and the flags standing on them or lying where they fell */
    if (g.ctf && g.flags) {
      for (const f of g.flags) {
        const S = RR.SIDES[f.side], bx = f.home.x - cx, by = f.home.y - cy;
        if (vis(bx, by, C.BASE_R + 10)) {
          RR.ring(ctx, bx, by, C.BASE_R, S.color, 10, g.t * (f.side ? -1.5 : 1.5));
          RR.ring(ctx, bx, by, 30, S.light);
        }
        if (f.state !== 'carried' && vis(f.x - cx, f.y - cy, 30)) {
          glow(ctx, f.x - cx, f.y - cy, 16, S.color);
          if (f.state !== 'dropped' || f.dropT < C.FLAG_RETURN - 4 || Math.floor(g.t * 8) & 1) drawFlag(ctx, f.x - cx, f.y - cy, f.side, g.t);
        }
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

    /* a walled lane's rocks (they never move: the walls are the lane's edges, see tracks.js) */
    if (tr.walls) {
      for (const w of tr.walls) {
        const sx = w.x - cx, sy = w.y - cy;
        if (vis(sx, sy, w.r + 4)) RR.drawRot(ctx, Art.rocks[w.size][w.variant], sx, sy, w.rot);
      }
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
    const tagging = !g.demo && g.state === 'play';
    for (const s of g.ships) {
      const sx = s.x - cx, sy = s.y - cy;
      // a human pilot's name goes up for TAG_HOLD seconds as their ship comes into view (see drawTags)
      const inView = s.dead <= 0 && !s.gone && vis(sx, sy, -6);
      if (inView && !s.inView && tagging && s !== p && humanPilot(g, s)) s.tagUntil = g.t + TAG_HOLD;
      s.inView = inView;
      if (s.dead > 0) continue;
      if (!vis(sx, sy, 30)) continue;
      if (s.invuln > 0 && Math.floor(g.t * 16) & 1) continue;
      if (s.thrusting > 0.05) {
        const boost = s.nitro > 0;
        glow(ctx, sx - Math.cos(s.angle) * 14, sy - Math.sin(s.angle) * 14, boost ? 17 : 11, boost ? '#41a6f6' : '#ef7d57');
      }
      RR.drawRot(ctx, s.hitFlash > 0 ? s.white : s.sprite, sx, sy, s.angle + Math.PI / 2);
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

    /* carried flags, flying behind their carriers */
    if (g.ctf && g.flags) {
      for (const f of g.flags) {
        const c = f.carrier;
        if (f.state !== 'carried' || !c || c.dead > 0) continue;
        const fx = c.x - Math.cos(c.angle) * 12 - cx, fy = c.y - Math.sin(c.angle) * 12 - cy;
        if (vis(fx, fy, 30)) drawFlag(ctx, fx, fy + 6, f.side, g.t);
      }
    }

    /* where the fire stick is aiming */
    g.aimShown = null;
    if (!g.demo && g.state === 'play' && p.dead <= 0) drawAim(g, ctx, p, cx, cy);

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
    if (!g.playerDone && !g.combat && tr.lane) { // a walled lane: along it, never across the infield (the gate once it is near)
      const L = tr.lane, here = L.at(p.x, p.y), to = ((tr.cps[p.nextCp].s - here.s) % L.lap + L.lap) % L.lap;
      aim = to < 500 ? tr.cps[p.nextCp] : L.point(here.s + 500, 0);
    } else if (!g.playerDone && !g.combat) aim = tr.cps[p.nextCp];
    else if (!g.playerDone && p.dead <= 0 && g.ctf && g.flags) {
      // capture the flag: home with a flag; after whoever has ours; to a teammate with one; else to a flag to raid
      const goal = g.flagGoal(p);
      aim = goal.at; hostile = goal.hostile;
    } else if (!g.playerDone && p.dead <= 0) {
      if (p.zoned) aim = tr.center;
      else {
        let bd = 1e9;
        for (const o of g.ships) {
          const d = Math.hypot(o.x - p.x, o.y - p.y);
          if (o !== p && o.dead <= 0 && d < bd) { bd = d; aim = o; hostile = true; }
        }
      }
    }
    g.arrowTo = aim; // (what the edge arrow leads to, for the tests)
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
    if (g.ctf && g.flags) { // the bases, and the flags (blinking while away from home)
      for (const f of g.flags) {
        const S = RR.SIDES[f.side], hx = Math.round(mx + f.home.x * mm.s + mm.ox), hy = Math.round(my + f.home.y * mm.s + mm.oy);
        ctx.fillStyle = S.color; ctx.fillRect(hx - 2, hy - 2, 5, 5);
        ctx.fillStyle = PAL.ink; ctx.fillRect(hx - 1, hy - 1, 3, 3);
        if (f.state !== 'home' && !blink) continue;
        const fx = Math.round(mx + f.x * mm.s + mm.ox), fy = Math.round(my + f.y * mm.s + mm.oy);
        ctx.fillStyle = S.light; ctx.fillRect(fx, fy - 3, 1, 4); ctx.fillRect(fx + 1, fy - 3, 2, 2);
      }
    }
    for (let i = g.ships.length - 1; i >= 0; i--) {
      const s = g.ships[i];
      if (s.dead > 0) continue;
      const x = Math.round(mx + s.x * mm.s + mm.ox), y = Math.round(my + s.y * mm.s + mm.oy);
      if (s === p) { ctx.fillStyle = PAL.white; ctx.fillRect(x - 2, y - 2, 5, 5); }
      ctx.fillStyle = s.colors.a;
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
  }

  function drawHUD(g, ctx, W, H) {
    const p = g.player, touch = RR.input.touchMode, T = g.t, ins = g.inset, mm = g.track.mini;
    const L = 4 + ins.l, Tp = 4 + ins.t, Rr = W - 4 - ins.r, B = H - 4 - ins.b;
    const narrow = Rr - L < 330; // phones held upright

    /* lap + position, or the score in a fight */
    const teams = g.ctf ? g.caps.length : 0;
    panel(ctx, L, Tp, teams > 2 ? 146 : 104, 34);
    if (g.ctf) { // capture the flag: each team's captures, yours first
      const sides = [p.side];
      for (let sd = 0; sd < teams; sd++) if (sd !== p.side) sides.push(sd);
      sides.forEach(function (sd, k) {
        const S = RR.SIDES[sd], x = L + 6 + k * (teams > 2 ? 46 : 50);
        text(ctx, S.name + (k === 0 ? '*' : ''), x, Tp + 5, S.light);
        text(ctx, String(g.caps[sd]), x, Tp + 15, k === 0 ? PAL.white : PAL.silver, 2);
      });
    } else if (g.royale) {
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
      if (g.ctf) {
        const left = Math.max(0, C.CTF_TIME - now), holder = g.reflagHolder();
        text(ctx, fmt(left), cx, cy, left < 20 && Math.floor(T * 4) & 1 ? PAL.alarm : PAL.white, 2, al, PAL.ink);
        text(ctx, 'FIRST TO ' + C.CTF_CAPS + ' FLAGS', cx, cy + 18, PAL.silver, 1, al, PAL.ink);
        // who has the Replace Flag: their team, never the pilot
        g.reflagShown = holder ? 'REPLACE FLAG: ' + RR.SIDES[holder.side].name + ' TEAM' : null;
        if (holder) text(ctx, g.reflagShown, cx, cy + 27, RR.SIDES[holder.side].light, 1, al, PAL.ink);
      } else if (g.royale) {
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
    const hull = p.dead > 0 ? 0 : p.hp / p.maxHp;
    const low = hull < 0.3 && Math.floor(T * 8) & 1;
    text(ctx, 'HULL', hx + 6, hy + 5, low ? PAL.alarm : PAL.silver);
    bar(ctx, hx + 33, hy + 5, 13, hull, hull > 0.55 ? PAL.lime : hull > 0.3 ? PAL.yellow : PAL.alarm);
    text(ctx, 'SPD', hx + 6, hy + 16, PAL.silver);
    bar(ctx, hx + 33, hy + 16, 13, Math.hypot(p.vx, p.vy) / 500, p.nitro > 0 ? PAL.yellow : PAL.cyan);

    /* the autopilot: on, and which lane it keeps to (inside, middle, outside, as the ship goes) */
    if (g.autoOn() && !p.finished) {
      const ay = touch ? hy + 31 : hy - 21, lane = p.pilot ? p.pilot.lane : 0;
      panel(ctx, hx, ay, 104, 18, PAL.lime);
      text(ctx, 'AUTOPILOT', hx + 6, ay + 6, PAL.lime);
      for (let k = -1; k <= 1; k++) {
        const bx = hx + 70 + (k + 1) * 10;
        ctx.fillStyle = k === lane ? PAL.lime : PAL.dusk;
        ctx.fillRect(bx, ay + 5, 7, 8);
      }
      g.autoShown = lane; // (for the tests)
    } else g.autoShown = null;

    /* who wrecked whom */
    if (g.combat) {
      let fy = touch ? Tp + 98 : Tp + 40;
      if (g.ctf && g.flags && !g.playerDone) { // where the flags are, for the player
        const mine = g.flags[p.side];
        const line = p.flag ? 'YOU HAVE THE ' + RR.SIDES[p.flag.side].name + ' FLAG - TAKE IT HOME'
          : mine.state === 'carried' ? 'YOUR FLAG IS TAKEN' + (mine.carrier ? ' BY ' + RR.SIDES[mine.carrier.side].name : '') + '!'
            : mine.state === 'dropped' ? 'YOUR FLAG IS DOWN - TOUCH IT HOME' : '';
        if (line) text(ctx, line, L + 2, fy, p.flag ? PAL.yellow : Math.floor(T * 3) & 1 ? PAL.alarm : PAL.orange, 1, 'left', PAL.ink);
        if (p.flag && mine.state !== 'home') text(ctx, '(YOUR OWN FLAG MUST BE HOME TO SCORE)', L + 2, fy + 9, PAL.silver, 1, 'left', PAL.ink);
        fy += 20;
      }
      for (const f of g.feed) {
        if (f.t > 4.2 && Math.floor(T * 12) & 1) continue;
        const line = f.text || (f.a ? f.a + ' WRECKED ' + f.b : f.b + (f.zone ? ' LOST TO THE ZONE' : ' CRASHED'));
        text(ctx, line, L + 2, fy, f.col || (f.a === p.name ? PAL.yellow : f.b === p.name ? PAL.alarm : PAL.silver), 1, 'left', PAL.ink);
        fy += 9;
      }
    }

    /* weapon slot (keyboard play; on touch the FIRE button shows it) */
    if (!touch) {
      const rx = Rr - 72, ry = B - 34, held = p.defer > 0, ready = g.canDefer(p);
      if (g.ctf) { // capture the flag: Replace Flag's slot (lit while it can be used: your flag away from home)
        const has = p.reflag > 0, go = g.canReflag(p);
        panel(ctx, rx, ry, 34, 34, go ? (Math.floor(T * 4) & 1 ? PAL.white : PAL.gold) : has ? PAL.gold : PAL.slate);
        if (!go) ctx.globalAlpha = has ? 0.55 : 0.3;
        ctx.drawImage(Art.icons.reflag, rx + 8, ry + 4, 18, 18);
        ctx.globalAlpha = 1;
        text(ctx, 'E', rx + 17, ry + 25, has ? PAL.white : PAL.steel, 1, 'center');
        if (has) text(ctx, p.reflag > 1 ? 'FLAG X' + p.reflag : 'FLAG', rx + 33, ry - 10, PAL.gold, 1, 'right', PAL.ink);
      } else if (!g.combat) { // no gates to defer in a fight
        // blinks while it can be used; steady (and dim) while the next gate is the line, which can't be deferred
        panel(ctx, rx, ry, 34, 34, ready ? (Math.floor(T * 4) & 1 ? PAL.white : PAL.violet) : held ? PAL.violet : PAL.slate);
        if (!ready) ctx.globalAlpha = held ? 0.55 : 0.3;
        ctx.drawImage(Art.icons.defer, rx + 8, ry + 4, 18, 18);
        ctx.globalAlpha = 1;
        text(ctx, 'E', rx + 17, ry + 25, held ? PAL.white : PAL.steel, 1, 'center');
        if (held) text(ctx, p.defer > 1 ? 'DEFER X' + p.defer : 'DEFER', rx + 33, ry - 10, PAL.violet, 1, 'right', PAL.ink);
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
    let ey = touch ? hy + (g.autoOn() && !p.finished ? 53 : 33) : B - 58; // (touch: under the hull bar, and the AUTOPILOT panel when it shows)
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
    if (g.phase === 'countdown') {
      const n = Math.ceil(g.count);
      if (n > 3) text(ctx, 'READY', W / 2, my + 8, PAL.white, 4, 'center', PAL.ink);
      else text(ctx, String(n), W / 2, my - 6, [PAL.lime, PAL.lime, PAL.yellow, PAL.alarm][n], 8, 'center', PAL.ink);
      // how-to-fly reminder while the lights count down
      const hy2 = Math.round(H * (touch ? 0.56 : 0.62));
      if (g.autoOn()) { // the autopilot flies: the player changes lanes and fights
        text(ctx, 'AUTOPILOT: IT FLIES, YOU FIGHT', W / 2, hy2, PAL.lime, 1, 'center', PAL.ink);
        if (touch) {
          text(ctx, 'FLY STICK LEFT / RIGHT: CHANGE LANE', W / 2, hy2 + 10, PAL.cyan, 1, 'center', PAL.ink);
          text(ctx, 'FIRE STICK: SHOOT THAT WAY', W / 2, hy2 + 20, PAL.cyan, 1, 'center', PAL.ink);
        } else text(ctx, 'LEFT / RIGHT: CHANGE LANE - SPACE: FIRE - G: FLY IT YOURSELF', W / 2, hy2 + 10, PAL.cyan, 1, 'center', PAL.ink);
      } else if (touch) {
        text(ctx, 'DRAG ANYWHERE: FLY THAT WAY', W / 2, hy2, PAL.cyan, 1, 'center', PAL.ink);
        text(ctx, 'DRAG FARTHER: MORE POWER', W / 2, hy2 + 10, PAL.cyan, 1, 'center', PAL.ink);
        text(ctx, 'FIRE STICK: SHOOT THAT WAY', W / 2, hy2 + 20, PAL.cyan, 1, 'center', PAL.ink);
      } else {
        text(ctx, 'ARROWS TO FLY - A / D TO AIM - SPACE TO FIRE', W / 2, hy2, PAL.cyan, 1, 'center', PAL.ink);
      }
      text(ctx, g.ctf ? 'BRING ' + (g.caps.length > 2 ? 'ANY' : 'THEIR') + ' FLAG TO YOUR BASE - FIRST TO ' + C.CTF_CAPS : g.royale ? 'LAST SHIP FLYING WINS' : g.combat ? 'WRECK THEM - FIRST TO ' + C.KILL_TARGET + ' KILLS' : 'FLY THROUGH THE GLOWING DONUT',
        W / 2, hy2 + (touch ? 34 : g.autoOn() ? 22 : 12), PAL.pink, 1, 'center', PAL.ink);
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
    if (p.dead > 0 && !p.gone && g.state === 'play') text(ctx, 'RESPAWNING', W / 2, H * 0.5, PAL.silver, 1, 'center', PAL.ink);

    if (touch && g.state === 'play') {
      const by = narrow ? cy + 40 : Tp + mm.h + 8;
      button(g, ctx, 'II', Rr - 26, by, 26, 18, function () { g.pause(); });
      button(g, ctx, 'ZOOM', Rr - 64, by, 34, 18, function () { g.zoomCycle(); }, PAL.cyan);
      if (!g.combat) button(g, ctx, 'AUTO', Rr - 102, by, 34, 18, function () { g.toggleAutopilot(); }, g.autopilot ? PAL.lime : PAL.steel);
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

  /**
   * The fire stick's aim (or the guns' swung with A / D), kept faint so it
   * never hides the race: a dashed line out from the rocket while the blaster
   * is pushed one way, or while a missile is held ready to launch (straight
   * ahead until the stick is pushed), plus
   * corner brackets on the rival that missile would lock onto.
   * g.aimShown records what was drawn (the tests read it).
   */
  function drawAim(g, ctx, s, cx, cy) {
    const w = s.weapon || (g.combat ? 'blaster' : null), inp = s.input;
    if (!(inp.stick || inp.keyAim) || !(w === 'missile' || (w === 'blaster' && inp.aim != null))) return;
    const ang = inp.aim != null ? inp.aim : s.angle, ax = Math.cos(ang), ay = Math.sin(ang);
    const col = s.weapon ? RR.ITEMS[s.weapon].color : PAL.cyan, x = s.x - cx, y = s.y - cy;
    ctx.globalAlpha = 0.7;
    RR.line(ctx, x + ax * 14, y + ay * 14, x + ax * 80, y + ay * 80, col, 7, 4); // dashes of 4, gaps of 3
    const lock = w === 'missile' ? RR.pickTarget(s, g, ang) : null;
    if (lock) brackets(ctx, lock.x - cx, lock.y - cy, 11, col);
    ctx.globalAlpha = 1;
    g.aimShown = { ang: ang, weapon: w, lock: lock ? g.ships.indexOf(lock) : -1 };
  }

  /** Four small corner marks round a point. */
  function brackets(ctx, x, y, r, col) {
    x = Math.round(x); y = Math.round(y);
    ctx.fillStyle = col;
    for (const k of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = x + k[0] * r, py = y + k[1] * r;
      ctx.fillRect(k[0] < 0 ? px : px - 3, py, 4, 1);
      ctx.fillRect(px, k[1] < 0 ? py : py - 3, 1, 4);
    }
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

    // no ring or disc round the touch: just where it began and the way it points (the stick's knob shows its own)
    if (!dr.stick) {
      if (dr.dist > 2) RR.line(ctx, dr.x, dr.y, ex, ey, col, 2);
      RR.disc(ctx, dr.x, dr.y, 2, PAL.white);
    }

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

    const key = function (r, on, col) {
      panel(ctx, r.x, r.y, r.w, r.h, on ? PAL.white : col);
      if (on) { ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2); }
    };

    /* steering: the stick bottom left (a tap swaps it for a turning slider), or a drag from anywhere else */
    const slideMode = RR.input.steerSlide;
    if (slideMode) {
      const r = L.slide, mid = r.x + r.w / 2, on = !!t.slide, kx = on ? t.slide.x : mid;
      panel(ctx, r.x, r.y, r.w, r.h, on ? PAL.white : PAL.steel);
      ctx.fillStyle = PAL.slate; ctx.fillRect(r.x + 6, r.y + r.h / 2 - 1, r.w - 12, 2); // the groove
      ctx.fillRect(Math.round(mid), r.y + 4, 1, r.h - 8); // straight ahead
      text(ctx, '<', r.x + 5, r.y + r.h / 2 - 3, PAL.steel, 1, 'left');
      text(ctx, '>', r.x + r.w - 5, r.y + r.h / 2 - 3, PAL.steel, 1, 'right');
      const kw = 22, kh = r.h + 6, kxL = Math.round(kx - kw / 2), kyT = r.y - 3;
      ctx.fillStyle = on ? PAL.lime : '#2a6b3a';
      ctx.fillRect(kxL, kyT, kw, kh);
      ctx.fillStyle = on ? PAL.white : PAL.lime;
      for (let k = -1; k <= 1; k++) ctx.fillRect(Math.round(kx) + k * 4, kyT + 8, 1, kh - 16); // grip lines
      panel(ctx, L.tab.x, L.tab.y, L.tab.w, L.tab.h, PAL.steel);
      text(ctx, 'STICK', L.tab.x + L.tab.w / 2, L.tab.y + 5, PAL.silver, 1, 'center');
      stickLabel(ctx, { x: L.steer.x, y: L.steer.y, r: r.h / 2 + 4 }, 'SLIDE TO TURN', on ? PAL.white : PAL.silver, H, ins);
    } else {
      const steering = t.drag && t.drag.stick ? t.drag : null;
      drawStick(ctx, L.steer, steering && steering.stick, PAL.lime, PAL.steel);
      stickLabel(ctx, L.steer, 'FLY', steering ? PAL.white : PAL.silver, H, ins);
    }
    g.meter = t.drag ? drawDrag(ctx, t.gas ? Object.assign({}, t.drag, { power: 1 }) : t.drag, W, H, ins, g.t) : null; // (GAS: full power)
    if (t.drag || t.slide || t.gas) {
      if (!t.drag || t.drag.power > 0) p.dragged = true;
    } else if (!p.dragged && g.phase === 'race' && Math.floor(g.t * 2) & 1) {
      const hy = (slideMode ? L.tab.y - 6 : L.steer.y - L.steer.r) - 24;
      const auto = g.autoOn(); // (the autopilot flies: the stick only changes lane)
      text(ctx, auto ? 'LEFT / RIGHT' : slideMode ? 'SLIDE TO TURN' : 'PUSH THE STICK', L.steer.x, hy, PAL.silver, 1, 'center', PAL.ink);
      text(ctx, auto ? 'CHANGES LANE' : slideMode ? 'AND GAS TO GO' : 'OR DRAG ANYWHERE', L.steer.x, hy + 10, PAL.silver, 1, 'center', PAL.ink);
    }

    /* fire stick: the blaster fires while held (ahead, or the way it is pushed); missiles go on letting go */
    const w = p.weapon || (g.combat ? 'blaster' : null);
    const wc = p.weapon ? RR.ITEMS[p.weapon].color : g.combat ? PAL.cyan : PAL.steel;
    const knob = drawStick(ctx, L.fire, t.aimStick, wc, w ? wc : PAL.steel);
    if (w) ctx.drawImage(Art.icons[w], knob.x - 4, knob.y - 4);
    const what = p.weapon ? RR.ITEMS[p.weapon].name + ' X' + p.ammo : g.combat ? 'CANNON' : 'NO WEAPON';
    const held = w === 'missile' ? 'LET GO TO FIRE' : w === 'blaster' ? 'AIM' : null;
    stickLabel(ctx, L.fire, t.aimStick && held ? held : what, t.aimStick && held ? PAL.white : wc, H, ins);

    key(L.brake, t.brake, PAL.steel);
    text(ctx, 'BRAKE', L.brake.x + L.brake.w / 2, L.brake.y + 18, PAL.silver, 1, 'center');
    if (RR.input.gasLatch) { // tapped on: lit green until tapped again
      panel(ctx, L.gas.x, L.gas.y, L.gas.w, L.gas.h, PAL.lime);
      ctx.fillStyle = 'rgba(99,199,77,0.35)'; ctx.fillRect(L.gas.x + 1, L.gas.y + 1, L.gas.w - 2, L.gas.h - 2);
      text(ctx, 'GAS', L.gas.x + L.gas.w / 2, L.gas.y + 13, PAL.white, 1, 'center');
      text(ctx, 'ON', L.gas.x + L.gas.w / 2, L.gas.y + 24, PAL.lime, 1, 'center', PAL.ink);
    } else {
      key(L.gas, t.gas, PAL.lime);
      text(ctx, 'GAS', L.gas.x + L.gas.w / 2, L.gas.y + 18, t.gas ? PAL.white : PAL.lime, 1, 'center');
    }

    if (g.ctf && p.reflag > 0) { // capture the flag: Replace Flag, in the deferral's spot
      const r = L.defer, ready = g.canReflag(p); // (not while your flag is home: a tap says so)
      panel(ctx, r.x, r.y, r.w, r.h, ready && Math.floor(g.t * 4) & 1 ? PAL.white : PAL.gold);
      if (!ready) ctx.globalAlpha = 0.55;
      ctx.drawImage(Art.icons.reflag, r.x + 13, r.y + 6, 18, 18);
      ctx.globalAlpha = 1;
      text(ctx, 'FLAG', r.x + r.w / 2, r.y + 31, PAL.gold, 1, 'center');
      if (p.reflag > 1) text(ctx, 'X' + p.reflag, r.x + r.w - 2, r.y + 2, PAL.white, 1, 'right', PAL.ink);
      g.ui.push({ x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8, label: 'REPLACE FLAG', act: function () { g.tryReflag(); } });
    }
    if (p.defer > 0 && !g.combat) {
      const r = L.defer, ready = g.canDefer(p); // (not while the next gate is the line: a tap says so)
      panel(ctx, r.x, r.y, r.w, r.h, ready && Math.floor(g.t * 4) & 1 ? PAL.white : PAL.violet);
      if (!ready) ctx.globalAlpha = 0.55;
      ctx.drawImage(Art.icons.defer, r.x + 13, r.y + 6, 18, 18);
      ctx.globalAlpha = 1;
      text(ctx, 'DEFER', r.x + r.w / 2, r.y + 31, PAL.violet, 1, 'center');
      if (p.defer > 1) text(ctx, 'X' + p.defer, r.x + r.w - 2, r.y + 2, PAL.white, 1, 'right', PAL.ink);
      g.ui.push({ x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8, label: 'DEFER', act: function () { g.tryDefer(); } });
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
    drawStick(ctx, L.steer, null, PAL.lime, PAL.silver); ring(L.steer, 'steer');
    stickLabel(ctx, L.steer, 'FLY', PAL.yellow, H, ins);
    drawStick(ctx, L.fire, null, PAL.cyan, PAL.silver); ring(L.fire, 'fire');
    stickLabel(ctx, L.fire, 'AIM + FIRE', PAL.yellow, H, ins);
    panel(ctx, L.brake.x, L.brake.y, L.brake.w, L.brake.h, held.brake ? PAL.white : PAL.yellow);
    text(ctx, 'BRAKE', L.brake.x + L.brake.w / 2, L.brake.y + 18, PAL.yellow, 1, 'center');
    panel(ctx, L.gas.x, L.gas.y, L.gas.w, L.gas.h, held.gas ? PAL.white : PAL.yellow);
    text(ctx, 'GAS', L.gas.x + L.gas.w / 2, L.gas.y + 18, PAL.yellow, 1, 'center');
    const r = L.defer;
    panel(ctx, r.x, r.y, r.w, r.h, held.defer ? PAL.white : PAL.yellow);
    ctx.drawImage(Art.icons.defer, r.x + 13, r.y + 6, 18, 18);
    text(ctx, 'DEFER', r.x + r.w / 2, r.y + 31, PAL.yellow, 1, 'center');
  }

  /* ------------------------------------------------------------ overlays */

  let logoA = null, logoB = null;
  const DIFF_TAG = ['R', 'P', 'A'], DIFF_COL = [PAL.lime, PAL.yellow, PAL.alarm];

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
    const spare = g.pointsLeft(g.prog.ship) + g.prog.upts, items = []; // stat and upgrade points waiting to be spent
    items.push(['HANGAR' + (touch ? '' : ' (H)') + (spare > 0 ? ' +' + spare : ''), function () { g.openHangar(); },
      spare > 0 && Math.floor(T * 3) & 1 ? PAL.white : PAL.yellow]);
    if (RR.mp.available()) items.push(['ONLINE' + (touch ? '' : ' (O)'), function () { RR.mp.open(); }, PAL.lime]);
    if (net.online) {
      items.push(['PILOT ' + g.name + (touch ? '' : ' (N)'), function () { g.editName(); }, PAL.cyan]);
      items.push(['TOP 10' + (touch ? '' : ' (T)'), function () { g.showBoard(); }, PAL.pink]);
    }
    items.push(['HISTORY' + (touch ? '' : ' (Y)'), function () { g.showHistory(); }, PAL.sky]);
    if (touch && g.canFullscreen()) items.push([g.isFullscreen() ? 'EXIT FULL' : 'FULLSCREEN', function () { g.fullscreen(); }, PAL.silver]);
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

    // a menu row: its label, its value between < and >; `half`: one of two sharing a line, centred on `cx`
    const row = function (idx, label, value, onL, onR, half, cx) {
      cx = half ? cx : W / 2;
      const sel = g.menuRow === idx && !touch;
      text(ctx, label, cx, y, sel ? PAL.yellow : PAL.silver, 1, 'center', PAL.ink);
      text(ctx, value, cx, y + 10, PAL.white, 2, 'center', PAL.ink);
      const ax = half ? Math.min(pw / 4 - 8, 56) : Math.min(pw / 2 - 12, 112), nud = sel ? Math.round(Math.sin(T * 8) * 1.5) : 0;
      const col = sel || touch ? PAL.yellow : PAL.steel, hw = half ? 36 : 48; // (half rows' arrows sit closer: smaller hit areas)
      text(ctx, '<', cx - ax - nud, y + 10, col, 2, 'center', PAL.ink);
      text(ctx, '>', cx + ax + nud, y + 10, col, 2, 'center', PAL.ink);
      g.ui.push({ x: cx - ax - hw / 2, y: y - 3, w: hw, h: 31, act: onL });
      g.ui.push({ x: cx + ax - hw / 2, y: y - 3, w: hw, h: 31, act: onR });
    };

    row(0, 'EVENT', mode.name, function () { g.setMode(-1); }, function () { g.setMode(1); });
    y += 27 + gap;
    const list = RR.mapsFor(mode.id), at = g.mapIdx();
    const def = list[at], rec = g.best[def.id], board = net.boards[def.id];
    row(1, (mode.id === 'ctf' ? 'MAP ' : fight ? 'ARENA ' : 'COURSE ') + (at + 1) + '/' + list.length, def.name,
      function () { g.setTrack(-1); }, function () { g.setTrack(1); });
    y += 27;
    text(ctx, def.blurb, W / 2, y, PAL.sky, 1, 'center', PAL.ink);
    y += 10;
    if (fight) text(ctx, def.rule || mode.rule, W / 2, y, PAL.silver, 1, 'center', PAL.ink);
    else {
      let line = rec && rec.race ? 'YOU ' + fmt(rec.race) : def.laps + ' LAPS';
      if (net.online) line += '   WORLD ' + (board && board.length ? fmt(board[0].time) + ' ' + board[0].name : '-:--.--');
      else if (!(rec && rec.race)) line += ' - NO RECORD YET';
      text(ctx, line, W / 2, y, rec && rec.race ? PAL.yellow : PAL.silver, 1, 'center', PAL.ink);
    }
    y += 10 + gap;
    if (fight) row(2, 'RIVALS', RR.DIFFS[g.diffIdx].name, function () { g.setDiff(-1); }, function () { g.setDiff(1); });
    else { // a Grand Prix: the rivals, and the course's weapons on or off, side by side
      const q = Math.round(pw / 4), arm = function () { g.toggleWeapons(); };
      row(2, 'RIVALS', RR.DIFFS[g.diffIdx].name, function () { g.setDiff(-1); }, function () { g.setDiff(1); }, true, W / 2 - q);
      row(3, 'WEAPONS', g.weaponsOn(g.trackIdx) ? 'ON' : 'OFF', arm, arm, true, W / 2 + q);
      g.ui.push({ x: W / 2 + q - 24, y: y + 7, w: 48, h: 20, act: arm, label: 'WEAPONS' }); // (a tap on ON / OFF switches it too)
    }
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
      if (g.homeScreenTip() && y + 30 < ty) { // iPhones and iPads: full screen comes from the home screen
        text(ctx, 'FULL SCREEN: SHARE > ADD TO HOME SCREEN', W / 2, ty, PAL.cyan, 1, 'center', PAL.ink);
      }
      text(ctx, fight ? 'WIN EVENTS TO EARN STAT POINTS' : 'FLY THROUGH EVERY DONUT IN ORDER', W / 2, fy, PAL.silver, 1, 'center', PAL.ink);
      text(ctx, fight ? 'AND UNLOCK BETTER SHIPS' : 'GRAB POWER-UPS - BLAST YOUR RIVALS', W / 2, fy + 10, PAL.silver, 1, 'center', PAL.ink);
    } else if (W >= 440) {
      text(ctx, 'ARROWS  FLY    A / D  AIM    SPACE  FIRE    E  DEFER GATE    G  AUTOPILOT', W / 2, fy, PAL.silver, 1, 'center', PAL.ink);
      text(ctx, 'P  PAUSE    H  HANGAR    Z  ZOOM    M  MUTE    C  CRT    F  FULLSCREEN', W / 2, fy + 10, PAL.steel, 1, 'center', PAL.ink);
    } else {
      text(ctx, 'ARROWS FLY - A/D AIM - SPACE FIRE', W / 2, fy, PAL.silver, 1, 'center', PAL.ink);
      text(ctx, 'H HANGAR - Z ZOOM - P PAUSE - M MUTE - G AUTO', W / 2, fy + 10, PAL.steel, 1, 'center', PAL.ink);
    }
  }

  /**
   * World top 10 for the selected course. Each row shows where that pilot
   * finished in the race that set the time; below the list comes your own row
   * and world rank when you are not in the top 10.
   */
  /* 3 x 5 digits, for the level of an upgraded powerup beside its icon */
  const TINY = ['###1#1#1#1###', '.#.1##.1.#.1.#.1###', '##.1..#1.#.1#..1###', '##.1..#1.#.1..#1##.', '#.#1#.#1###1..#1..#',
    '###1#..1##.1..#1##.', '.##1#..1###1#.#1###', '###1..#1.#.1.#.1.#.', '###1#.#1###1#.#1###', '###1#.#1###1..#1##.'];
  /** Draw number `n` in the tiny digits with its top-left at (x, y); returns the width. */
  function tinyNum(ctx, n, x, y, col) {
    const str = String(n);
    for (let c = 0; c < str.length; c++) {
      const rows = TINY[+str[c]].split('1');
      for (let r = 0; r < 5; r++) {
        for (let k = 0; k < 3; k++) {
          if (rows[r][k] !== '#') continue;
          ctx.fillStyle = PAL.ink; ctx.fillRect(x + c * 4 + k + 1, y + r + 1, 1, 1);
          ctx.fillStyle = col; ctx.fillRect(x + c * 4 + k, y + r, 1, 1);
        }
      }
    }
    return str.length * 4;
  }

  const hullOf = function (id) { return RR.HULLS.filter(function (h) { return h.id === id; })[0] || null; };

  /** Powerups in one of a setup's lists, most first: [[type, count], ...] in RR.ITEMS order on ties. */
  function usedList(su, which) {
    const order = Object.keys(RR.ITEMS), items = (su && su[which || 'items']) || {};
    return order.filter(function (k) { return items[k] > 0; })
      .map(function (k) { return [k, items[k]]; })
      .sort(function (a, b) { return b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]); });
  }

  /**
   * A leaderboard row's setup in a few pixels: the rocket, small, then up to
   * three of the powerups the pilot used, most used first (+ when there were
   * more), with a small 2 or 3 beside one they had upgraded. Rows from before
   * setups were recorded get a dash. Returns what it drew, for the tests.
   */
  function setupStrip(ctx, su, x, y) {
    const hull = su && hullOf(su.ship);
    if (!hull) { text(ctx, '-', x + 2, y, PAL.steel); return null; }
    ctx.drawImage(Art.shipMini(hull.design, 0), x, y - 2);
    const used = usedList(su), shown = used.slice(0, used.length > 3 ? 2 : 3), levels = su.levels || {};
    const out = { ship: hull.id, icons: [], numbers: [], more: used.length - shown.length };
    let ix = x + 11;
    shown.forEach(function (u) {
      ctx.drawImage(Art.icons[u[0]], ix, y - 1);
      ix += 10;
      out.icons.push(u[0]);
      const lv = levels[u[0]];
      if (lv > 1) { ix += tinyNum(ctx, lv, ix - 1, y + 3, PAL.gold); out.numbers.push([u[0], lv]); }
    });
    if (out.more) text(ctx, '+', ix + 1, y, PAL.silver);
    return out;
  }

  /** A fight row's result in a few words: kills and losses, flags, as its mode counts them. */
  function fightLine(mode, r) {
    if (!r) return '';
    const k = r.kills + ' KILL' + (r.kills === 1 ? '' : 'S');
    if (mode === 'ctf') return r.caps + ' FLAG' + (r.caps === 1 ? '' : 'S') + '  ' + r.returns + ' RETURNED  ' + k;
    return mode === 'royale' ? k : k + '  ' + r.deaths + ' LOST';
  }
  const mapName = function (id) {
    const m = RR.ARENAS.concat(RR.FLAG_MAPS).filter(function (d) { return d.id === id; })[0];
    return m ? m.name : '';
  };

  /** The table's name over a panel, with < and > to the tables either side of it (LEFT / RIGHT). */
  function boardHeader(g, ctx, W, x, y, pw, title, name, col, shade) {
    text(ctx, title, W / 2, y + 7, col, 2, 'center', shade);
    text(ctx, name, W / 2, y + 25, PAL.sky, 1, 'center');
    const nud = Math.round(Math.sin(g.t * 6) * 1.2);
    text(ctx, '<', x + 12 - nud, y + 10, PAL.yellow, 2, 'center', PAL.ink);
    text(ctx, '>', x + pw - 12 + nud, y + 10, PAL.yellow, 2, 'center', PAL.ink);
    g.ui.push({ x: x, y: y, w: 32, h: 34, label: 'PREVIOUS TABLE', act: function () { g.turnBoard(-1); } });
    g.ui.push({ x: x + pw - 32, y: y, w: 32, h: 34, label: 'NEXT TABLE', act: function () { g.turnBoard(1); } });
  }

  /**
   * The world's high score tables: a course's top 10 race times, a fight
   * mode's top 10 scores, or the pilots with the most wins; LEFT and RIGHT
   * (or < and >) go from one to the next. On a course or fight table each
   * row shows the pilot's rocket and powerups; tap a row (or pick it with
   * the arrows and press Enter) for that pilot's card.
   */
  function drawBoard(g, ctx, W, H) {
    if (g.boardCard) { drawCard(g, ctx, W, H); return; }
    const id = g.boardId || RR.TRACKS[g.trackIdx].id;
    if (id === 'pilots') { drawPilots(g, ctx, W, H); return; }
    const REC = RR.records, fight = REC.FIGHTS.indexOf(id) >= 0;
    const def = fight ? null : RR.TRACKS.filter(function (t) { return t.id === id; })[0];
    const net = RR.net, list = net.boards[id], mine = net.me[id], rec = fight ? null : g.best[id];
    const touch = RR.input.touchMode;
    ctx.fillStyle = 'rgba(7,7,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 240), ph = fight ? 272 : 232, rowH = 12;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    const cSetup = x + 94, cPlace = x + pw - 92, cDiff = x + pw - 62, cTime = x + pw - 10;
    panel(ctx, x, y, pw, ph, PAL.pink);
    boardHeader(g, ctx, W, x, y, pw, 'WORLD TOP 10', fight ? REC.NAMES[id] : def.name, PAL.pink, PAL.plum);
    g.boardShown = { id: id, fight: fight, rows: [], lent: [] }; // (what is on screen, for the tests)

    const rows = (g.boardRows = []); // what the arrows can pick, in order
    const row = function (ry, rank, e, col) {
      const n = rows.length, r = { e: e, rank: rank, board: id };
      rows.push(r);
      if (g.boardSel === n && !touch) { // picked with the arrows
        ctx.fillStyle = PAL.white;
        ctx.fillRect(x + 5, ry - 3, pw - 10, 1); ctx.fillRect(x + 5, ry + rowH - 4, pw - 10, 1);
        ctx.fillRect(x + 5, ry - 3, 1, rowH); ctx.fillRect(x + pw - 6, ry - 3, 1, rowH);
      }
      text(ctx, String(rank), x + 22, ry, col, 1, 'right');
      if (e.lent) { text(ctx, '*', x + 24, ry, PAL.gold); g.boardShown.lent.push(rank); } // in a rocket an invite lent
      text(ctx, e.name, x + 30, ry, col);
      r.strip = setupStrip(ctx, e.setup, cSetup, ry);
      r.at = [cSetup, ry];
      // finishing place in that race or fight; older race rows were saved without one
      if (e.place >= 1 && e.place <= 6) text(ctx, ORD[e.place - 1], cPlace, ry, col === PAL.yellow ? col : PLACE_COL[e.place - 1]);
      else text(ctx, '-', cPlace + 6, ry, PAL.steel);
      text(ctx, DIFF_TAG[e.diff] || '', cDiff, ry, DIFF_COL[e.diff] || PAL.steel);
      const val = fight ? String(e.score) : fmt(e.time);
      text(ctx, val, cTime, ry, col, 1, 'right');
      g.boardShown.rows.push([rank, e.name, val]);
      g.ui.push({ x: x + 5, y: ry - 3, w: pw - 10, h: rowH, label: 'PILOT ' + rank, act: function () { g.boardSel = n; g.openCard(r); } });
    };
    const isMine = function (e) {
      if (mine) return e.name === mine.name && (fight ? e.score === mine.score : e.time === mine.time);
      return !fight && e.name === g.name && rec && Math.abs(rec.race - e.time) < 0.011; // before our own row has loaded
    };

    let ry = y + 48;
    if (!list) {
      text(ctx, net.failed[id] ? 'LEADERBOARD UNAVAILABLE' : 'LOADING...', W / 2, ry + 40, PAL.silver, 1, 'center');
    } else if (!list.length) {
      text(ctx, fight ? 'NO SCORES YET' : 'NO TIMES YET', W / 2, ry + 34, PAL.silver, 1, 'center');
      text(ctx, 'BE THE FIRST!', W / 2, ry + 46, PAL.yellow, 1, 'center');
    } else {
      text(ctx, '#', x + 22, y + 37, PAL.steel, 1, 'right');
      text(ctx, 'PILOT', x + 30, y + 37, PAL.steel);
      text(ctx, 'SETUP', cSetup, y + 37, PAL.steel);
      text(ctx, fight ? 'PLACE' : 'RACE', cPlace - 3, y + 37, PAL.steel);
      text(ctx, fight ? 'SCORE' : 'TIME', cTime, y + 37, PAL.steel, 1, 'right');
      let shown = false;
      for (let i = 0; i < list.length && i < 10; i++) {
        const e = list[i], me = isMine(e);
        if (me) { shown = true; ctx.fillStyle = 'rgba(255,205,117,0.16)'; ctx.fillRect(x + 5, ry - 3, pw - 10, rowH); }
        row(ry, i + 1, e, me ? PAL.yellow : i === 0 ? PAL.gold : PAL.white);
        ry += rowH;
      }
      // your own standing, when it is not already highlighted above
      const my = y + 175;
      if (mine && !shown) {
        RR.line(ctx, x + 8, my - 6, x + pw - 9, my - 6, PAL.steel, 3);
        ctx.fillStyle = 'rgba(255,205,117,0.16)';
        ctx.fillRect(x + 5, my - 3, pw - 10, rowH);
        row(my, mine.rank > 999 ? '999+' : mine.rank, mine, PAL.yellow);
      } else if (mine === null) {
        text(ctx, fight ? 'FINISH A FIGHT TO JOIN THE TABLE' : 'FINISH A RACE HERE TO JOIN THE BOARD', W / 2, my, PAL.steel, 1, 'center');
      }
      text(ctx, touch ? 'TAP A PILOT TO SEE THEIR ROCKET' : 'ARROWS + ENTER: SEE A PILOT\'S ROCKET', W / 2, y + ph - 34, PAL.sky, 1, 'center');
    }
    if (g.boardSel >= rows.length) g.boardSel = -1;
    if (fight) { // how the points are made
      REC.explain(id).forEach(function (ln, k) { text(ctx, ln, W / 2, y + 190 + k * 9, PAL.silver, 1, 'center'); });
    }
    const KEY = 'R ROOKIE  P PILOT  A ACE', anyLent = g.boardShown.lent.length > 0;
    text(ctx, KEY + (anyLent ? '  * LENT ROCKET' : ''), W / 2, y + ph - 45, PAL.steel, 1, 'center');
    if (anyLent) text(ctx, '*', W / 2 - RR.textW(KEY + '  * LENT ROCKET') / 2 + RR.textW(KEY + '  ') + 1, y + ph - 45, PAL.gold); // (the key's star, gold too)
    const bw = 90;
    button(g, ctx, touch ? 'CLOSE' : 'CLOSE (ENTER)', Math.round(W / 2 - bw / 2), y + ph - 22, bw, 17,
      function () { g.closeBoard(); }, PAL.lime);
  }

  /**
   * The pilots with the most wins, in all events: games played, wins, and
   * 1st, 2nd and 3rd places, with your own row below when you are not in the
   * top 10.
   */
  function drawPilots(g, ctx, W, H) {
    const net = RR.net, list = net.pilots.all, me = net.history, touch = RR.input.touchMode;
    g.boardRows = [];
    ctx.fillStyle = 'rgba(7,7,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 240), ph = 232, rowH = 12;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    const cols = [x + pw - 112, x + pw - 82, x + pw - 58, x + pw - 34, x + pw - 10]; // right edges: played, wins, 1st, 2nd, 3rd
    panel(ctx, x, y, pw, ph, PAL.sky);
    boardHeader(g, ctx, W, x, y, pw, 'TOP PILOTS', 'MOST WINS - ALL EVENTS', PAL.sky, PAL.navy);
    g.boardShown = { id: 'pilots', rows: [] };
    const row = function (ry, rank, e, col) {
      text(ctx, String(rank), x + 22, ry, col, 1, 'right');
      text(ctx, e.name, x + 30, ry, col);
      const vals = [e.played, e.wins, e.p1, e.p2, e.p3];
      vals.forEach(function (v, k) { text(ctx, String(v), cols[k], ry, k === 1 ? (col === PAL.white ? PAL.gold : col) : col, 1, 'right'); });
      g.boardShown.rows.push([rank, e.name].concat(vals));
    };
    let ry = y + 48;
    if (!list) {
      text(ctx, net.failed['pilots:all'] ? 'LEADERBOARD UNAVAILABLE' : 'LOADING...', W / 2, ry + 40, PAL.silver, 1, 'center');
    } else if (!list.length) {
      text(ctx, 'NO PILOTS YET', W / 2, ry + 34, PAL.silver, 1, 'center');
      text(ctx, 'FINISH AN EVENT TO JOIN', W / 2, ry + 46, PAL.yellow, 1, 'center');
    } else {
      text(ctx, '#', x + 22, y + 37, PAL.steel, 1, 'right');
      text(ctx, 'PILOT', x + 30, y + 37, PAL.steel);
      ['GAMES', 'WINS', '1ST', '2ND', '3RD'].forEach(function (h, k) { text(ctx, h, cols[k], y + 37, PAL.steel, 1, 'right'); });
      let shown = false;
      for (let i = 0; i < list.length && i < 10; i++) {
        const e = list[i], mine = me && e.name === me.name && e.wins === me.all.wins && e.played === me.all.played;
        if (mine) { shown = true; ctx.fillStyle = 'rgba(255,205,117,0.16)'; ctx.fillRect(x + 5, ry - 3, pw - 10, rowH); }
        row(ry, i + 1, e, mine ? PAL.yellow : PAL.white);
        ry += rowH;
      }
      const my = y + 175;
      if (me && !shown) {
        RR.line(ctx, x + 8, my - 6, x + pw - 9, my - 6, PAL.steel, 3);
        ctx.fillStyle = 'rgba(255,205,117,0.16)';
        ctx.fillRect(x + 5, my - 3, pw - 10, rowH);
        row(my, me.rank > 999 ? '999+' : me.rank, Object.assign({ name: me.name }, me.all), PAL.yellow);
      }
    }
    text(ctx, 'A WIN: 1ST PLACE - OR IN CAPTURE', W / 2, y + ph - 45, PAL.steel, 1, 'center');
    text(ctx, 'THE FLAG, YOUR TEAM WINNING', W / 2, y + ph - 35, PAL.steel, 1, 'center');
    const bw = 90;
    button(g, ctx, touch ? 'CLOSE' : 'CLOSE (ENTER)', Math.round(W / 2 - bw / 2), y + ph - 22, bw, 17,
      function () { g.closeBoard(); }, PAL.lime);
  }

  /**
   * One pilot's card from a high score table: the rocket they flew, its stat
   * levels (grey: the ship's own, yellow: points they put in), and every
   * powerup they used, with the race time or the fight's score.
   */
  function drawCard(g, ctx, W, H) {
    const c = g.boardCard, e = c.e, su = e.setup, hull = su && hullOf(su.ship), id = c.board || RR.TRACKS[g.trackIdx].id;
    const fight = RR.records.FIGHTS.indexOf(id) >= 0, def = fight ? null : RR.TRACKS.filter(function (t) { return t.id === id; })[0];
    const touch = RR.input.touchMode;
    ctx.fillStyle = 'rgba(7,7,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 240), ph = 244;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    panel(ctx, x, y, pw, ph, PAL.pink);
    text(ctx, e.name, W / 2, y + 7, c.rank === 1 ? PAL.gold : PAL.white, 2, 'center', PAL.plum);
    text(ctx, '#' + c.rank + ' ON ' + (fight ? RR.records.NAMES[id] : def.name), W / 2, y + 25, PAL.sky, 1, 'center');

    /* the rocket and the race (or the fight) */
    const tx = hull ? x + 56 : x + 14;
    if (hull) {
      const spr = Art.ship(hull.design, 0);
      ctx.drawImage(spr, x + 14, y + 38, spr.width * 2, spr.height * 2);
      text(ctx, hull.name, tx, y + 40, PAL.white, 2, 'left', PAL.ink);
      if (e.lent) text(ctx, 'LENT', tx + RR.textW(hull.name, 2) + 6, y + 44, PAL.gold); // an invite link lent it (see lib/mp.js)
    }
    const place = e.place >= 1 && e.place <= 6 ? ORD[e.place - 1] : '-';
    const vs = place + ' VS ' + ((RR.DIFFS[e.diff] && RR.DIFFS[e.diff].name) || '?') + ' RIVALS';
    if (fight) {
      text(ctx, 'SCORE ' + e.score, tx, y + 58, PAL.white);
      text(ctx, fightLine(id, e.result), tx, y + 68, PAL.silver);
      text(ctx, vs + (id === 'ctf' && e.result && e.result.win ? ' - TEAM WON' : ''), tx, y + 78, DIFF_COL[e.diff] || PAL.silver);
      if (e.map && !hull) text(ctx, mapName(e.map), tx, y + 88, PAL.steel);
    } else {
      text(ctx, 'TIME ' + fmt(e.time), tx, y + 58, PAL.white);
      text(ctx, 'BEST LAP ' + fmt(e.lap), tx, y + 68, PAL.silver);
      text(ctx, vs, tx, y + 78, DIFF_COL[e.diff] || PAL.silver);
    }
    const shown = { ship: hull ? hull.id : null, lent: !!e.lent, stats: null, items: [], numbers: [] };
    g.cardShown = shown;

    if (!hull) {
      text(ctx, 'NO SETUP ON RECORD', W / 2, y + 118, PAL.silver, 1, 'center');
      text(ctx, 'THIS TIME WAS SET BEFORE THE', W / 2, y + 134, PAL.steel, 1, 'center');
      text(ctx, 'LEADERBOARD SAVED ROCKETS', W / 2, y + 144, PAL.steel, 1, 'center');
    } else {
      /* stats */
      const tuned = su.stats.reduce(function (a, lv, k) { return a + Math.max(0, lv - hull.base[k]); }, 0);
      text(ctx, fight && e.map ? mapName(e.map) : 'STATS', x + 14, y + 88, PAL.steel);
      text(ctx, e.lent ? 'LENT, MAXED OUT' : tuned ? '+' + tuned + ' POINTS PUT IN' : 'STOCK', x + pw - 14, y + 88, e.lent ? PAL.gold : tuned ? PAL.yellow : PAL.steel, 1, 'right');
      shown.stats = su.stats.slice();
      RR.STATS.forEach(function (st, k) {
        const ry = y + 98 + k * 10, lv = su.stats[k], base = hull.base[k], cap = hull.cap[k], bx = x + 86;
        text(ctx, st.name, x + 14, ry, PAL.silver);
        for (let n = 0; n < 10; n++) {
          if (n >= cap) { ctx.fillStyle = PAL.slate; ctx.fillRect(bx + n * 5 + 1, ry + 3, 2, 1); continue; }
          ctx.fillStyle = n < Math.min(base, lv) ? PAL.silver : n < lv ? PAL.yellow : PAL.dusk;
          ctx.fillRect(bx + n * 5, ry, 4, 7);
        }
        text(ctx, String(lv), bx + 56, ry, lv > base ? PAL.yellow : PAL.white);
      });

      /* powerups used, with a small 2 or 3 beside an upgraded one */
      const used = usedList(su), levels = su.levels || {};
      text(ctx, 'POWERUPS USED', x + 14, y + 158, PAL.steel);
      if (!used.length) text(ctx, 'NONE - A CLEAN RUN', x + 14, y + 172, PAL.lime);
      const colW = Math.floor((pw - 28) / 2);
      used.forEach(function (u, k) {
        const cx = x + 14 + (k % 2) * colW, ry = y + 171 + Math.floor(k / 2) * 11, T = RR.ITEMS[u[0]], lv = levels[u[0]];
        ctx.drawImage(Art.icons[u[0]], cx, ry - 1);
        const lw = lv > 1 ? tinyNum(ctx, lv, cx + 9, ry + 3, PAL.gold) : 0;
        if (lw) shown.numbers.push([u[0], lv]);
        text(ctx, T.name, cx + 12 + lw, ry, T.color);
        text(ctx, 'X' + u[1], cx + colW - 8, ry, PAL.white, 1, 'right');
        shown.items.push(u);
      });
    }

    const bw = 90;
    button(g, ctx, touch ? 'BACK' : 'BACK (ENTER)', Math.round(W / 2 - bw / 2), y + ph - 22, bw, 17,
      function () { g.closeCard(); }, PAL.lime);
  }

  /**
   * The player's own history (Y on the menu): for each event and in all,
   * games played, wins, and 1st, 2nd and 3rd places; online, their world
   * rank by wins too.
   */
  function drawHistory(g, ctx, W, H) {
    const REC = RR.records, h = g.hist, net = RR.net, touch = RR.input.touchMode;
    ctx.fillStyle = 'rgba(7,7,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 272), ph = 184, rowH = 14;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    const cols = [x + pw - 118, x + pw - 88, x + pw - 62, x + pw - 36, x + pw - 10];
    panel(ctx, x, y, pw, ph, PAL.sky);
    text(ctx, 'PILOT HISTORY', W / 2, y + 7, PAL.sky, 2, 'center', PAL.navy);
    text(ctx, g.name, W / 2, y + 25, PAL.yellow, 1, 'center');
    ['GAMES', 'WINS', '1ST', '2ND', '3RD'].forEach(function (t, k) { text(ctx, t, cols[k], y + 40, PAL.steel, 1, 'right'); });
    g.historyShown = [];
    REC.MODES.concat('all').forEach(function (m, i) {
      const ry = y + 53 + i * rowH + (m === 'all' ? 4 : 0), c = h[m], all = m === 'all';
      if (all) RR.line(ctx, x + 8, ry - 5, x + pw - 9, ry - 5, PAL.steel, 3);
      const col = all ? PAL.white : c.played ? PAL.silver : PAL.steel;
      text(ctx, REC.NAMES[m], x + 10, ry, all ? PAL.yellow : col);
      const vals = [c.played, c.wins, c.p1, c.p2, c.p3];
      vals.forEach(function (v, k) { text(ctx, String(v), cols[k], ry, k === 1 && v ? PAL.gold : col, 1, 'right'); });
      g.historyShown.push([m].concat(vals));
    });
    const me = net.history;
    let line = '', col = PAL.steel;
    if (net.online) {
      if (me) { line = 'WORLD RANK #' + (me.rank > 999 ? '999+' : me.rank) + ' BY WINS'; col = me.rank <= 3 ? PAL.gold : PAL.pink; }
      else line = net.failed['pilots:all'] ? '' : h.all.played ? 'LOADING YOUR WORLD RANK...' : 'FINISH AN EVENT FOR A WORLD RANK';
    }
    if (line) text(ctx, line, W / 2, y + ph - 45, col, 1, 'center');
    text(ctx, 'A WIN: 1ST PLACE, OR YOUR TEAM\'S IN CTF', W / 2, y + ph - 34, PAL.steel, 1, 'center');
    const bw = 90;
    button(g, ctx, touch ? 'CLOSE' : 'CLOSE (ENTER)', Math.round(W / 2 - bw / 2), y + ph - 22, bw, 17,
      function () { g.closeHistory(); }, PAL.lime);
  }

  /**
   * The hangar: pick a ship and spend stat points on it. Each bar shows the
   * ship's own level (grey), points you have put in (yellow) and room left up
   * to that ship's ceiling; the dots past the end are out of its reach.
   */
  function drawHangar(g, ctx, W, H) {
    const T = g.t, touch = RR.input.touchMode, ST = RR.STATS, pr = g.prog, power = g.hangarPage === 'power';
    const i = g.hangarShip, h = RR.HULLS[i], open = g.shipUnlocked(i), left = g.pointsLeft(i);
    ctx.fillStyle = 'rgba(7,7,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 250), ph = 250;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    panel(ctx, x, y, pw, ph, PAL.yellow);
    text(ctx, 'HANGAR', W / 2, y + 7, PAL.yellow, 2, 'center', PAL.plum);
    const pts = g.shipPoints(i), maxed = pts >= RR.shipRoom(i); // this ship's points: never more than it can use
    text(ctx, power ? 'CREDITS ' + pr.credits + '   UPGRADE POINTS ' + pr.upts
      : 'WINS ' + pr.wins + '  POINTS ' + pts + (maxed ? ' MAX' : '') + '  CREDITS ' + pr.credits,
      W / 2, y + 25, PAL.silver, 1, 'center');
    const mark = function (ry, hh) { ctx.fillStyle = 'rgba(255,205,117,0.16)'; ctx.fillRect(x + 5, ry, pw - 10, hh); };

    /* two pages: the ship and its stats, and powerup upgrades */
    const tw = 74;
    button(g, ctx, 'SHIP', Math.round(W / 2 - tw - 3), y + 36, tw, 14, function () { g.hangarTab('ship'); }, power ? PAL.slate : PAL.yellow);
    button(g, ctx, 'POWERUPS', Math.round(W / 2 + 3), y + 36, tw, 14, function () { g.hangarTab('power'); }, power ? PAL.yellow : PAL.slate);

    if (!power) {
      /* the ship */
      const sy = y + 58, sel = g.hangarRow === 0 && !touch;
      if (sel) mark(sy - 3, 48);
      const spr = Art.ship(h.design, 0);
      if (!open) ctx.globalAlpha = 0.3;
      ctx.drawImage(spr, x + 30, sy, spr.width * 2, spr.height * 2);
      ctx.globalAlpha = 1;
      text(ctx, h.name, x + 70, sy + 3, open ? PAL.white : PAL.steel, 2, 'left', PAL.ink);
      text(ctx, h.blurb, x + 70, sy + 21, PAL.sky);
      const need = h.wins - pr.wins;
      text(ctx, open ? 'YOUR SHIP' : 'LOCKED - ' + need + ' MORE WIN' + (need > 1 ? 'S' : ''), x + 70, sy + 32, open ? PAL.lime : PAL.alarm);
      const nud = sel ? Math.round(Math.sin(T * 8) * 1.5) : 0, acol = sel || touch ? PAL.yellow : PAL.steel;
      text(ctx, '<', x + 14 - nud, sy + 14, acol, 2, 'center', PAL.ink);
      text(ctx, '>', x + pw - 14 + nud, sy + 14, acol, 2, 'center', PAL.ink);
      g.ui.push({ x: x, y: sy - 3, w: 28, h: 48, act: function () { g.hangarBrowse(-1); } });
      g.ui.push({ x: x + pw - 28, y: sy - 3, w: 28, h: 48, act: function () { g.hangarBrowse(1); } });

      /* its stats */
      let ry = y + 112;
      const bx = x + 70;
      ST.forEach(function (st, k) {
        const lv = g.statLevel(i, k), base = h.base[k], cap = h.cap[k], on = g.hangarRow === k + 1 && !touch;
        if (on) mark(ry - 4, 14);
        text(ctx, st.name, x + 10, ry, on ? PAL.yellow : PAL.silver);
        for (let c = 0; c < 10; c++) {
          if (c >= cap) { ctx.fillStyle = PAL.slate; ctx.fillRect(bx + c * 5 + 1, ry + 3, 2, 1); continue; }
          ctx.fillStyle = c < base ? PAL.silver : c < lv ? PAL.yellow : PAL.dusk;
          ctx.fillRect(bx + c * 5, ry, 4, 7);
        }
        text(ctx, lv + '/' + cap, bx + 54, ry, lv >= cap ? PAL.lime : PAL.white);
        const less = open && lv > base, more = open && left > 0 && lv < cap;
        button(g, ctx, '-', x + pw - 52, ry - 4, 22, 14, function () { g.spend(i, k, -1); }, less ? PAL.white : PAL.slate);
        button(g, ctx, '+', x + pw - 27, ry - 4, 22, 14, function () { g.spend(i, k, 1); }, more ? PAL.yellow : PAL.slate);
        ry += 15;
      });
      text(ctx, open ? 'POINTS LEFT FOR THIS SHIP: ' + left : 'WIN RACES AND FIGHTS TO UNLOCK', W / 2, ry + 3,
        open && left > 0 ? PAL.yellow : PAL.steel, 1, 'center');
    } else {
      /* powerup upgrades: credits buy points, points raise a powerup's level (1-3) */
      const buyRow = ST.length + 1, by = y + 60, room = g.powerRoom(), full = pr.upts >= room;
      if (g.hangarRow === buyRow && !touch) mark(by - 5, 17);
      text(ctx, full ? (room ? 'POINTS FOR EVERY LEVEL LEFT' : 'EVERY POWERUP IS MAXED') : 'UPGRADE POINT', x + 10, by,
        full ? PAL.lime : PAL.silver);
      if (!full) {
        button(g, ctx, 'BUY ' + RR.UPGRADE_PRICE + ' CR', x + pw - 98, by - 4, 88, 15, function () { g.buyUpgrade(); },
          g.canBuyUpgrade() ? PAL.yellow : PAL.slate);
      }
      g.powerShown = [];
      RR.POWER.forEach(function (pw2, k) {
        const id = pw2.id, lv = g.powerLevel(id), ry = y + 80 + k * 15, on = g.hangarRow === buyRow + 1 + k && !touch;
        if (on) mark(ry - 4, 14);
        ctx.drawImage(Art.icons[id], x + 10, ry - 1);
        text(ctx, RR.ITEMS[id].name, x + 22, ry, on ? PAL.yellow : RR.ITEMS[id].color);
        for (let c = 0; c < 3; c++) {
          ctx.fillStyle = c === 0 ? PAL.silver : c < lv ? PAL.yellow : PAL.dusk;
          ctx.fillRect(x + 70 + c * 7, ry, 6, 7);
        }
        text(ctx, RR.powerDoes(id, lv), x + 96, ry, lv > 1 ? PAL.yellow : PAL.white);
        button(g, ctx, '-', x + pw - 52, ry - 4, 22, 14, function () { g.powerSpend(id, -1); }, lv > 1 ? PAL.white : PAL.slate);
        button(g, ctx, '+', x + pw - 27, ry - 4, 22, 14, function () { g.powerSpend(id, 1); }, pr.upts > 0 && lv < 3 ? PAL.yellow : PAL.slate);
        g.ui.push({ x: x + pw - 27, y: ry - 4, w: 22, h: 14, label: 'UP ' + id, act: function () { g.powerSpend(id, 1); } });
        g.powerShown.push([id, lv]);
      });
      text(ctx, 'UPGRADES MAKE EVERY PICK-UP STRONGER', W / 2, y + 204, PAL.steel, 1, 'center');
    }

    const bw = 96;
    button(g, ctx, touch ? 'DONE' : 'DONE (ENTER)', Math.round(W / 2 - bw / 2), y + ph - 23, bw, 17,
      function () { g.closeHangar(); }, PAL.lime);
  }

  /* -------------------------------------------------------------- online */

  const modeName = function (mode) { return (RR.MODES.find(function (m) { return m.id === mode; }) || RR.MODES[0]).name; };
  const placeName = function (mode, track) { const list = RR.mapsFor(mode); return (list[track] || list[0]).name; };
  /** What a room plays: a fight and its arena (or flag map); a race, its course and whether its weapons are out. */
  const roomLine = function (mode, track, weapons) {
    return mode === 'race' ? placeName(mode, track) + ' - WEAPONS ' + (weapons ? 'ON' : 'OFF') : modeName(mode) + ' - ' + placeName(mode, track);
  };

  /** The ONLINE screen: find or make a room, then wait in its lobby until everyone is READY. */
  function drawOnline(g, ctx, W, H) {
    const M = RR.mp, touch = RR.input.touchMode, room = M.room, T = g.t;
    ctx.fillStyle = 'rgba(7,7,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 250), ph = 232;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    panel(ctx, x, y, pw, ph, PAL.lime);
    text(ctx, 'ONLINE', W / 2, y + 7, PAL.lime, 2, 'center', PAL.plum);
    const status = M.error || M.notice || (M.status === 'connecting' ? 'CONNECTING...' : M.status === 'online' ? '' : M.status === 'lost' ? 'CONNECTION LOST' : '');
    if (status) text(ctx, status, W / 2, y + 25, M.error ? PAL.alarm : PAL.silver, 1, 'center');
    const bw = Math.min(150, pw - 40), bx = Math.round(W / 2 - bw / 2);

    if (!room) {
      const mode = RR.MODES[g.modeIdx].id, track = g.mapIdx(), only = g.humansOnly;
      text(ctx, roomLine(mode, track, g.weaponsOn(track)), W / 2, y + 44, PAL.white, 1, 'center');
      // who takes the empty seats: bots at the menu's rival level, or nobody (LEFT / RIGHT, or tap, to switch)
      const sw = Math.min(pw - 24, 210), sx = Math.round(W / 2 - sw / 2);
      button(g, ctx, '< ' + (only ? 'HUMANS ONLY - NO BOTS' : RR.DIFFS[g.diffIdx].name + ' BOTS IN EMPTY SEATS') + ' >', sx, y + 56, sw, 16,
        function () { M.toggleBots(); }, only ? PAL.gold : PAL.steel);
      button(g, ctx, touch ? 'QUICK MATCH' : 'QUICK MATCH (ENTER)', bx, y + 80, bw, 20, function () { M.quick(); }, PAL.lime);
      button(g, ctx, 'CREATE ROOM', bx, y + 104, bw, 20, function () { M.create(); }, PAL.yellow);
      button(g, ctx, 'JOIN ROOM', bx, y + 128, bw, 20, function () { M.askCode(); }, PAL.cyan);
      text(ctx, 'QUICK MATCH: RACE ANYONE IN A ROOM', W / 2, y + 158, PAL.steel, 1, 'center');
      text(ctx, 'CREATE ROOM: A CODE FOR YOUR FRIENDS', W / 2, y + 169, PAL.steel, 1, 'center');
      text(ctx, 'PICK THE MODE AND COURSE ON THE MENU', W / 2, y + 180, PAL.steel, 1, 'center');
      text(ctx, only ? 'HUMANS ONLY: NEEDS 2 PILOTS OR MORE' : touch ? 'TAP THE BOTS LINE FOR HUMANS ONLY' : 'LEFT / RIGHT: HUMANS ONLY',
        W / 2, y + 191, only ? PAL.gold : PAL.steel, 1, 'center');
    } else {
      // the room: its code, what it races, who is in it
      const only = room.bots === false, mine = room.humans[M.you];
      const lent = mine && mine.loan && RR.HULLS.find(function (h) { return h.design === mine.design; }); // flying a rocket an invite lent
      if (room.priv) {
        text(ctx, 'ROOM ' + room.code, W / 2, y + 38, PAL.gold, 2, 'center', PAL.plum);
        if (lent) text(ctx, 'LENT TO YOU: A MAXED-OUT ' + lent.name, W / 2, y + 56, PAL.gold, 1, 'center');
        else text(ctx, only ? 'HUMANS ONLY - JOIN WITH THIS CODE' : 'FRIENDS JOIN WITH THIS CODE', W / 2, y + 56, only ? PAL.gold : PAL.steel, 1, 'center');
      } else {
        text(ctx, 'QUICK MATCH', W / 2, y + (only ? 36 : 42), PAL.gold, 2, 'center', PAL.plum);
        if (only) text(ctx, 'HUMANS ONLY - NO BOTS', W / 2, y + 55, PAL.gold, 1, 'center');
      }
      text(ctx, roomLine(room.mode, room.track, room.weapons !== false), W / 2, y + 68, PAL.white, 1, 'center');
      const shown = [];
      for (let k = 0; k < 6; k++) {
        const h = room.humans[k], ry = y + 82 + k * 12;
        if (!h) { text(ctx, (k + 1) + '  ' + (only ? 'OPEN SEAT' : 'BOT (' + RR.DIFFS[room.diff].name + ')'), x + 24, ry, PAL.slate); continue; }
        const you = k === M.you;
        if (you) { ctx.fillStyle = 'rgba(255,205,117,0.16)'; ctx.fillRect(x + 8, ry - 2, pw - 16, 11); }
        text(ctx, String(k + 1), x + 24, ry, you ? PAL.yellow : PAL.silver);
        ctx.drawImage(Art.shipMini(h.design, h.team), x + 36, ry - 2);
        text(ctx, h.name + (you ? ' (YOU)' : ''), x + 50, ry, you ? PAL.yellow : PAL.white);
        const tag = !h.connected ? 'AWAY' : h.waiting ? 'NEXT RACE' : h.ready ? 'READY' : '...';
        text(ctx, tag, x + pw - 14, ry, h.ready ? PAL.lime : !h.connected ? PAL.alarm : PAL.steel, 1, 'right');
        if (h.loan) text(ctx, 'LENT', x + pw - 72, ry, PAL.gold, 1, 'right'); // a maxed-out rocket, lent by an invite
        shown.push([h.name, tag]);
      }
      g.onlineShown = shown;
      const racing = room.state !== 'lobby';
      const alone = only && room.humans.filter(function (h) { return h.connected; }).length < 2; // humans only: nobody to race yet
      text(ctx, room.state === 'race' ? 'A RACE IS ON - YOU ARE IN THE NEXT ONE' : racing ? 'NEXT RACE IN A MOMENT' : alone ? 'WAITING FOR ANOTHER PILOT' : 'STARTS WHEN EVERYONE IS READY',
        W / 2, y + 158, room.state === 'race' || alone ? PAL.orange : PAL.steel, 1, 'center');
      const ready = M.isReady();
      if (!racing) {
        button(g, ctx, ready ? 'NOT READY' : touch ? 'READY' : 'READY (ENTER)', bx, y + 172, bw, 20, function () { M.ready(!ready); },
          ready ? PAL.steel : Math.floor(T * 2) & 1 ? PAL.white : PAL.lime);
      }
    }
    const lw = 80;
    if (room && room.code) { // a private room: its invite link beside BACK
      const iw = 100, ix = Math.round(W / 2 - (iw + 8 + lw) / 2);
      button(g, ctx, touch ? 'INVITE LINK' : 'INVITE LINK (L)', ix, y + ph - 23, iw, 17, function () { M.openLink(); }, PAL.cyan);
      button(g, ctx, touch ? 'BACK' : 'BACK (ESC)', ix + iw + 8, y + ph - 23, lw, 17, function () { M.leave(); }, PAL.orange);
    } else button(g, ctx, touch ? 'BACK' : 'BACK (ESC)', Math.round(W / 2 - lw / 2), y + ph - 23, lw, 17, function () { M.leave(); }, PAL.orange);
  }

  /** Over an online race: the connection, and the menu (the race goes on behind it). */
  function drawOnlineRace(g, ctx, W, H) {
    const M = RR.mp, touch = RR.input.touchMode;
    if (M.notice || M.status === 'lost') text(ctx, M.notice || 'CONNECTION LOST', W / 2, H * 0.3, PAL.alarm, 1, 'center', PAL.ink);
    if (!touch && g.state === 'play') text(ctx, M.rtt + ' MS', W - 6 - g.inset.r, H - 10 - g.inset.b, M.rtt > 150 ? PAL.orange : PAL.steel, 1, 'right', PAL.ink);
    if (!g.mpMenu || g.state !== 'play') return;
    ctx.fillStyle = 'rgba(7,7,26,0.6)';
    ctx.fillRect(0, 0, W, H);
    const y = Math.round(H / 2 - 50), bw = 140, bx = Math.round(W / 2 - bw / 2);
    text(ctx, 'ONLINE', W / 2, y, PAL.white, 3, 'center', PAL.plum);
    text(ctx, 'THE RACE GOES ON', W / 2, y + 26, PAL.silver, 1, 'center', PAL.ink);
    button(g, ctx, touch ? 'BACK TO THE RACE' : 'BACK TO THE RACE (P)', bx, y + 42, bw, 20, function () { g.mpMenu = false; }, PAL.lime);
    const snd = (RR.audio.muted ? 'SOUND OFF' : 'SOUND ON') + (touch ? '' : '  (M)');
    button(g, ctx, snd, bx, y + 66, bw, 20, function () { g.toggleSound(); }, RR.audio.muted ? PAL.steel : PAL.lime);
    button(g, ctx, touch ? 'LEAVE THE ROOM' : 'LEAVE THE ROOM (Q)', bx, y + 90, bw, 20, function () { M.leave(); }, PAL.orange);
  }

  /** The results of an online race or fight, then back to the room. */
  function drawOnlineResults(g, ctx, W, H) {
    const M = RR.mp, list = M.results || [], touch = RR.input.touchMode, fight = g.combat;
    ctx.fillStyle = 'rgba(7,7,26,0.6)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(W - 8, 240), ph = 64 + list.length * 12 + 44;
    const x = Math.round((W - pw) / 2), y = Math.max(2, Math.round((H - ph) / 2));
    const mine = list.find(function (r) { return r.you; });
    panel(ctx, x, y, pw, ph, mine ? PLACE_COL[mine.place - 1] : PAL.white);
    text(ctx, mine ? ORD[mine.place - 1] + ' PLACE' : 'RESULTS', W / 2, y + 7, mine ? PLACE_COL[mine.place - 1] : PAL.white, 2, 'center', PAL.plum);
    if (g.ctf && M.score) text(ctx, RR.scoreLine(M.score), x + 12, y + 30, PAL.cyan);
    text(ctx, g.ctf ? 'FLAGS  KILLS' : fight ? 'KILLS  DEATHS' : 'TIME', x + pw - 12, y + 30, PAL.steel, 1, 'right');
    list.forEach(function (r, k) {
      const ry = y + 42 + k * 12, col = r.you ? PAL.yellow : r.human ? PAL.white : PAL.silver;
      if (r.you) { ctx.fillStyle = 'rgba(255,205,117,0.16)'; ctx.fillRect(x + 6, ry - 2, pw - 12, 11); }
      text(ctx, ORD[r.place - 1] || String(r.place), x + 12, ry, PLACE_COL[r.place - 1] || PAL.silver);
      text(ctx, r.name + (!r.human ? ' (BOT)' : r.lent ? ' (LENT)' : ''), x + 40, ry, col);
      text(ctx, g.ctf ? (r.caps || 0) + '      ' + r.kills : fight ? r.kills + '      ' + r.deaths : r.time != null ? fmt(r.time) : 'DNF', x + pw - 12, ry, col, 1, 'right');
    });
    const rw = M.reward, by = y + 46 + list.length * 12;
    if (rw) {
      text(ctx, (rw.pts ? '+' + rw.pts + ' STAT POINT' + (rw.pts > 1 ? 'S' : '') + '  ' : rw.capped ? 'STAT POINTS MAXED  ' : '') + '+' + rw.credits + ' CREDITS',
        W / 2, by, rw.pts ? PAL.yellow : PAL.gold, 1, 'center');
    }
    const bw = Math.floor((pw - 30) / 2);
    button(g, ctx, touch ? 'NEXT RACE' : 'NEXT RACE (ENTER)', x + 10, y + ph - 26, bw, 19, function () { M.backToRoom(); }, PAL.lime);
    button(g, ctx, 'LEAVE', x + 20 + bw, y + ph - 26, bw, 19, function () { M.leave(); }, PAL.orange);
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
      if (g.ctf) {
        text(ctx, s.caps + ' FLAG' + (s.caps === 1 ? '' : 'S'), x + pw - 62, ry, s.caps ? PAL.gold : col, 1, 'right');
        text(ctx, s.kills + ' KILL' + (s.kills === 1 ? '' : 'S'), x + pw - 14, ry, PAL.steel, 1, 'right');
      } else if (g.royale) {
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
    if (g.ctf) text(ctx, RR.scoreLine(g.caps), W / 2, ry, g.ctfLeader() === p.side ? PAL.gold : PAL.cyan, 1, 'center');
    else if (g.combat) text(ctx, g.royale && !g.over ? 'THE FIGHT GOES ON WITHOUT YOU' : RR.DIFFS[g.diffIdx].name + ' RIVALS', W / 2, ry, PAL.cyan, 1, 'center');
    else {
      text(ctx, 'BEST LAP ' + fmt(p.bestLap) + (g.newRecord ? '   NEW RECORD!' : ''), W / 2, ry,
        g.newRecord && Math.floor(T * 4) & 1 ? PAL.yellow : PAL.cyan, 1, 'center');
    }
    // what it earned: stat points, and any ship the win unlocked
    const rw = g.reward;
    if (rw) {
      const fresh = rw.unlocked.length && Math.floor(T) & 1;
      text(ctx, fresh ? 'NEW SHIP IN THE HANGAR: ' + rw.unlocked.join(' ')
        : (rw.pts ? '+' + rw.pts + ' STAT POINT' + (rw.pts > 1 ? 'S' : '') + '  ' : rw.capped ? 'STAT POINTS MAXED  ' : '') + '+' + rw.credits + ' CREDITS',
        W / 2, ry + 24, fresh ? PAL.lime : rw.pts ? PAL.yellow : PAL.gold, 1, 'center');
    }
    if (g.combat && g.fightScore != null) {
      let msg = 'SCORE ' + g.fightScore, col = PAL.white;
      if (net.online) {
        const r = net.result;
        if (!r || r.track !== g.mode) msg += '  POSTING...';
        else if (r.error) msg += '  (TABLE UNAVAILABLE)';
        else { msg += '  WORLD #' + r.rank + (r.improved ? '' : ' (BEST STANDS)'); col = r.rank <= 3 ? PAL.gold : PAL.pink; }
      }
      text(ctx, msg, W / 2, ry + 12, col, 1, 'center');
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
    else if (g.state === 'history') drawHistory(g, ctx, W, H);
    else if (g.state === 'hangar') drawHangar(g, ctx, W, H);
    else if (g.state === 'online') drawOnline(g, ctx, W, H);
    else {
      drawTags(g, ctx);
      drawHUD(g, ctx, W, H);
      if (RR.input.touchMode && g.state === 'play') drawTouch(g, ctx, W, H);
      if (g.online) drawOnlineRace(g, ctx, W, H);
      if (g.state === 'paused') drawPause(g, ctx, W, H);
      else if (g.state === 'mpresults') drawOnlineResults(g, ctx, W, H);
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
