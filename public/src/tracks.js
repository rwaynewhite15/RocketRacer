/* ==========================================================================
 * ROCKET RACER — tracks.js
 * Course definitions and the builder that turns one into runtime data:
 * donut checkpoints, planets (with sprites), asteroid spawn points, pickup
 * rows, the starting grid, world bounds and a minimap.
 *
 * A course is a closed loop of checkpoints flown in order. Planets, asteroid
 * fields and pickups are laid out around that loop by hand.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR, Art = RR.Art, PAL = RR.PAL, TAU = RR.TAU;

  /*
   * cps      [x, y] donut gates in race order; the first is start/finish
   * planets  { x, y, r, type, seed, ring }
   * fields   elliptical asteroid fields { x, y, rx, ry, n, rot, max }
   * orbiters asteroids circling a planet { planet, dist, n, speed, size }
   * pickups  rows across the racing line { seg, t, n, kind } — `seg` is the
   *          index of the checkpoint the leg starts at, `t` how far along it,
   *          kind 'P' = power-ups, 'W' = weapons
   */
  const TRACKS = (RR.TRACKS = [
    {
      id: 'lunar', name: 'LUNAR LOOP', blurb: 'A BREEZY LAP AROUND TWIN WORLDS', laps: 3, seed: 11,
      nebula: ['#110e38', '#1a1454', '#28196e', '#0d2148', '#11305e', '#164274'],
      cps: [[1400, 2100], [2300, 2100], [3000, 2010], [3410, 1600], [3000, 1190], [1950, 900], [900, 1240], [490, 1650], [900, 2060]],
      planets: [
        { x: 3000, y: 1600, r: 190, type: 'terra', seed: 3 },
        { x: 900, y: 1650, r: 150, type: 'desert', seed: 8 },
        { x: 2450, y: 1040, r: 70, type: 'moon', seed: 5 },
        { x: 1850, y: 1850, r: 96, type: 'gasBlue', seed: 2, ring: true },
      ],
      fields: [
        { x: 1420, y: 1060, rx: 340, ry: 150, n: 12, rot: -0.3 },
        { x: 2660, y: 2290, rx: 240, ry: 70, n: 5, max: 2 },
      ],
      pickups: [
        { seg: 0, t: 0.5, n: 3, kind: 'W' },
        { seg: 1, t: 0.55, n: 2, kind: 'P' },
        { seg: 3, t: 0.5, n: 2, kind: 'P' },
        { seg: 4, t: 0.24, n: 3, kind: 'W' },
        { seg: 5, t: 0.5, n: 3, kind: 'P' },
        { seg: 7, t: 0.5, n: 2, kind: 'W' },
      ],
    },
    {
      id: 'eight', name: 'DONUT DRIFT', blurb: 'A FIGURE-EIGHT THROUGH THE BELT', laps: 3, seed: 23,
      nebula: ['#2a0f2e', '#431447', '#5e1a56', '#101c46', '#16295e', '#1d3a78'],
      cps: [[2200, 1300], [3400, 850], [3860, 1300], [3400, 1750], [2200, 1300], [1000, 880], [580, 1300], [1000, 1720]],
      planets: [
        { x: 3400, y: 1300, r: 210, type: 'gas', seed: 4, ring: true },
        { x: 1000, y: 1300, r: 170, type: 'lava', seed: 9 },
        { x: 2200, y: 760, r: 84, type: 'ice', seed: 6 },
        { x: 2200, y: 1900, r: 62, type: 'moon', seed: 12 },
      ],
      fields: [
        { x: 2200, y: 1300, rx: 520, ry: 240, n: 22 },
        { x: 3980, y: 880, rx: 150, ry: 130, n: 5, max: 3 },
      ],
      orbiters: [{ planet: 1, dist: 292, n: 5, speed: 0.22, size: 2 }],
      pickups: [
        { seg: 0, t: 0.48, n: 3, kind: 'W' },
        { seg: 1, t: 0.5, n: 2, kind: 'P' },
        { seg: 3, t: 0.5, n: 3, kind: 'P' },
        { seg: 4, t: 0.5, n: 3, kind: 'W' },
        { seg: 6, t: 0.5, n: 2, kind: 'P' },
        { seg: 7, t: 0.42, n: 3, kind: 'W' },
      ],
    },
    {
      id: 'gauntlet', name: 'GRAVITY GAUNTLET', blurb: 'PLANET SLALOM AND A WALL OF ROCK', laps: 3, seed: 37,
      nebula: ['#0c2a30', '#0f3d44', '#14555a', '#2b1238', '#431a52', '#5c2168'],
      cps: [[950, 850], [1400, 640], [2100, 1380], [2800, 640], [3500, 1390], [4300, 1250], [4750, 1700],
        [4300, 2150], [3300, 2320], [2300, 2220], [1600, 2330], [900, 2230], [470, 1800], [900, 1370]],
      planets: [
        { x: 1400, y: 1000, r: 130, type: 'ice', seed: 21 },
        { x: 2100, y: 1000, r: 150, type: 'toxic', seed: 22 },
        { x: 2800, y: 1000, r: 130, type: 'desert', seed: 23 },
        { x: 3500, y: 1000, r: 160, type: 'gasBlue', seed: 24, ring: true },
        { x: 4300, y: 1700, r: 230, type: 'lava', seed: 25 },
        { x: 900, y: 1800, r: 200, type: 'terra', seed: 26 },
        { x: 2700, y: 1800, r: 86, type: 'moon', seed: 27 },
      ],
      fields: [
        { x: 2450, y: 2270, rx: 950, ry: 150, n: 34 },
        { x: 1750, y: 1010, rx: 46, ry: 170, n: 3, max: 2 },
        { x: 3150, y: 1010, rx: 46, ry: 170, n: 3, max: 2 },
      ],
      orbiters: [
        { planet: 4, dist: 326, n: 6, speed: -0.18, size: 2 },
        { planet: 5, dist: 300, n: 4, speed: 0.2, size: 1 },
      ],
      pickups: [
        { seg: 0, t: 0.5, n: 2, kind: 'P' },
        { seg: 1, t: 0.5, n: 3, kind: 'W' },
        { seg: 3, t: 0.5, n: 3, kind: 'P' },
        { seg: 4, t: 0.5, n: 3, kind: 'W' },
        { seg: 7, t: 0.5, n: 3, kind: 'P' },
        { seg: 9, t: 0.5, n: 3, kind: 'W' },
        { seg: 10, t: 0.5, n: 2, kind: 'P' },
        { seg: 13, t: 0.3, n: 2, kind: 'W' },
      ],
    },
  ]);

  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = RR.clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  function build(def) {
    const rnd = RR.rng(def.seed * 9973 + 1);
    const N = def.cps.length;

    /* checkpoints ------------------------------------------------------- */
    const cps = def.cps.map(function (p, i) { return { i: i, x: p[0], y: p[1], finish: i === 0 }; });
    cps.forEach(function (c, i) {
      const prev = cps[(i + N - 1) % N];
      c.segLen = Math.hypot(c.x - prev.x, c.y - prev.y); // length of the leg arriving here
    });
    // one visible donut per unique position (a figure-eight reuses a gate)
    const donuts = [];
    cps.forEach(function (c) {
      let d = null;
      for (let k = 0; k < donuts.length; k++) if (Math.hypot(donuts[k].x - c.x, donuts[k].y - c.y) < 2) d = donuts[k];
      if (!d) { d = { x: c.x, y: c.y, ids: [], finish: false }; donuts.push(d); }
      d.ids.push(c.i);
      if (c.finish) d.finish = true;
    });

    /* planets ----------------------------------------------------------- */
    const planets = def.planets.map(function (p) {
      const art = Art.planet(p);
      return {
        x: p.x, y: p.y, r: p.r, type: p.type, sprite: art.cv, ext: art.ext,
        g: 260 + p.r * 0.8, range: p.r * 3.4, map: Art.PTYPES[p.type].map,
      };
    });

    /* starting grid: staggered pairs behind the start gate --------------- */
    const c0 = cps[0], cl = cps[N - 1];
    const gl = Math.hypot(c0.x - cl.x, c0.y - cl.y);
    const ux = (c0.x - cl.x) / gl, uy = (c0.y - cl.y) / gl;
    const grid = [];
    for (let i = 0; i < 6; i++) {
      const back = 112 + (i >> 1) * 46 + (i & 1) * 18, side = i & 1 ? 1 : -1;
      grid.push({ x: c0.x - ux * back - uy * side * 22, y: c0.y - uy * back + ux * side * 22, a: Math.atan2(uy, ux) });
    }
    const laneEnd = { x: c0.x - ux * 290, y: c0.y - uy * 290 };

    /* pickups ----------------------------------------------------------- */
    const pickups = [];
    (def.pickups || []).forEach(function (row) {
      const a = cps[row.seg], b = cps[(row.seg + 1) % N];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      const mx = a.x + dx * row.t, my = a.y + dy * row.t, gap = row.gap || 36;
      for (let k = 0; k < row.n; k++) {
        const off = (k - (row.n - 1) / 2) * gap;
        let x = mx - (dy / l) * off, y = my + (dx / l) * off;
        // never bury a pickup in a planet
        planets.forEach(function (p) {
          const d = Math.hypot(x - p.x, y - p.y), min = p.r + 46;
          if (d < min) { x = p.x + ((x - p.x) / (d || 1)) * min; y = p.y + ((y - p.y) / (d || 1)) * min; }
        });
        pickups.push({ x: x, y: y, kind: row.kind });
      }
    });

    /* asteroids --------------------------------------------------------- */
    const rocks = [];
    function clear(x, y, r) {
      for (let k = 0; k < cps.length; k++) if (Math.hypot(x - cps[k].x, y - cps[k].y) < 104 + r) return false;
      for (let k = 0; k < planets.length; k++) if (Math.hypot(x - planets[k].x, y - planets[k].y) < planets[k].r + 26 + r) return false;
      for (let k = 0; k < pickups.length; k++) if (Math.hypot(x - pickups[k].x, y - pickups[k].y) < 30 + r) return false;
      for (let k = 0; k < rocks.length; k++) if (Math.hypot(x - rocks[k].x, y - rocks[k].y) < r + rocks[k].r + 16) return false;
      if (segDist(x, y, laneEnd.x, laneEnd.y, c0.x + ux * 120, c0.y + uy * 120) < 74 + r) return false;
      return true;
    }
    (def.fields || []).forEach(function (f) {
      const cr = Math.cos(f.rot || 0), sr = Math.sin(f.rot || 0);
      const max = f.max === undefined ? 4 : f.max;
      let made = 0, tries = 0;
      while (made < f.n && tries++ < f.n * 40) {
        const a = rnd() * TAU, m = Math.sqrt(rnd());
        const ex = Math.cos(a) * m * f.rx, ey = Math.sin(a) * m * f.ry;
        const x = f.x + ex * cr - ey * sr, y = f.y + ex * sr + ey * cr;
        const size = Math.min(max, Math.floor(rnd() * rnd() * 5.2));
        const r = Art.ROCK_SIZES[size];
        if (!clear(x, y, r)) continue;
        rocks.push({ x: x, y: y, r: r, size: size, variant: Math.floor(rnd() * 4) });
        made++;
      }
    });
    (def.orbiters || []).forEach(function (o) {
      const p = planets[o.planet];
      for (let k = 0; k < o.n; k++) {
        const size = Math.max(0, (o.size || 1) - (k & 1));
        rocks.push({
          x: p.x, y: p.y, r: Art.ROCK_SIZES[size], size: size, variant: k % 4,
          orbit: { p: p, d: o.dist + (rnd() - 0.5) * 30, a: (k / o.n) * TAU + rnd() * 0.5, s: o.speed },
        });
      }
    });

    /* bounds + minimap --------------------------------------------------- */
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    cps.forEach(function (c) {
      x0 = Math.min(x0, c.x - 80); y0 = Math.min(y0, c.y - 80);
      x1 = Math.max(x1, c.x + 80); y1 = Math.max(y1, c.y + 80);
    });
    planets.forEach(function (p) {
      x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r);
      x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r);
    });
    const bounds = { x0: x0 - 420, y0: y0 - 420, x1: x1 + 420, y1: y1 + 420 };

    const MW = 90, MH = 62, pad = 4;
    const ms = Math.min((MW - pad * 2) / (x1 - x0), (MH - pad * 2) / (y1 - y0));
    const mox = (MW - (x1 - x0) * ms) / 2 - x0 * ms, moy = (MH - (y1 - y0) * ms) / 2 - y0 * ms;
    const mini = RR.canvas(MW, MH);
    for (let i = 0; i < N; i++) {
      const a = cps[i], b = cps[(i + 1) % N];
      RR.line(mini.g, a.x * ms + mox, a.y * ms + moy, b.x * ms + mox, b.y * ms + moy, PAL.steel, 2);
    }
    planets.forEach(function (p) {
      RR.disc(mini.g, p.x * ms + mox, p.y * ms + moy, Math.max(1, p.r * ms), p.map);
    });

    return {
      def: def, name: def.name, laps: def.laps,
      cps: cps, donuts: donuts, planets: planets, grid: grid, pickups: pickups, rocks: rocks,
      bounds: bounds,
      mini: { cv: mini, w: MW, h: MH, s: ms, ox: mox, oy: moy },
      nebula: Art.nebula(def.seed, def.nebula),
    };
  }

  const built = {};
  RR.getTrack = function (idx) {
    if (!built[idx]) built[idx] = build(TRACKS[idx]);
    return built[idx];
  };
})();
