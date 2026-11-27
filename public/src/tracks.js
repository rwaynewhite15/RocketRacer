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
   * planets  { x, y, r, type, seed, ring, g } (g: its pull, when not the usual for its size)
   * fields   elliptical asteroid fields { x, y, rx, ry, n, rot, max }
   * orbiters asteroids circling a planet { planet, dist, n, speed, size }
   * pickups  rows across the racing line { seg, t, n, kind } — `seg` is the
   *          index of the checkpoint the leg starts at, `t` how far along it,
   *          kind 'P' = power-ups, 'W' = weapons, 'N' = nitro and nothing else
   * donut    how many times the usual size its donuts are (bigger gates are
   *          easier to fly through); on such a course anywhere on the donut,
   *          its tube too, counts as through it (usually: the hole, CFG.CP_R)
   * weapons  false: a course made without weapons, so its weapon crates ('W'
   *          rows) are only out once the player switches weapons on. Every
   *          course can be switched either way on the menu (G.weaponsOn).
   * lane     a walled lane round an oval { cx, cy, len, r, w, gap } (see
   *          makeLane): rock walls `w / 2` either side of the racing line keep
   *          every ship in (and stop shots), and the lanes `gap` apart are the
   *          ones the autopilot and the rivals keep to. Its pickups are rows
   *          across the lane { s, lanes, kind }: `s` how far round the lap
   *          from the line, `lanes` which of the lanes (-1 inside, 0 middle,
   *          1 outside) hold one.
   */

  /**
   * A walled lane round an oval: the racing line is two straights `len` long
   * joined by half circles of radius `r` round (cx - len/2, cy) and
   * (cx + len/2, cy), flown anticlockwise on screen (east along the bottom
   * straight first), and the walls run `w / 2` either side of it.
   *   at(x, y)    -> { s, d, nx, ny, tx, ty }: how far round the lap from the
   *                  line (s, the middle of the bottom straight), how far out
   *                  from the racing line (d: + outside, - inside), the
   *                  outward normal there and the way round
   *   point(s, d) -> { x, y, nx, ny, tx, ty }: the point s round the lap, d out
   * The way round (t) is the outward normal turned a quarter: going round,
   * the outside is always on the right, so a lane to the right is further out.
   */
  function makeLane(L) {
    const h = L.len / 2, r = L.r, arc = Math.PI * r, lap = 4 * h + 2 * arc, cx = L.cx, cy = L.cy;
    const wrap = function (s) { return ((s % lap) + lap) % lap; };
    const out = function (x, y, nx, ny, s, d) { return { x: x, y: y, nx: nx, ny: ny, tx: ny, ty: -nx, s: s, d: d }; };
    return {
      cx: cx, cy: cy, len: L.len, r: r, w: L.w, gap: L.gap, lap: lap,
      at: function (x, y) {
        const qx = Math.max(cx - h, Math.min(cx + h, x)), dx = x - qx, dy = y - cy, dist = Math.hypot(dx, dy) || 1e-6;
        const nx = dx / dist, ny = dy / dist, d = dist - r;
        let s;
        if (x >= cx - h && x <= cx + h) s = dy >= 0 ? wrap(x - cx) : h + arc + (cx + h - x); // beside a straight
        else if (x > cx) s = h + (Math.PI / 2 - Math.atan2(dy, dx)) * r; // round the east end
        else { const a = Math.atan2(dy, dx); s = 3 * h + arc + (1.5 * Math.PI - (a < 0 ? a + 2 * Math.PI : a)) * r; } // the west end
        return out(x, y, nx, ny, s, d);
      },
      point: function (s, d) {
        s = wrap(s); d = d || 0;
        if (s < h) return out(cx + s, cy + r + d, 0, 1, s, d);
        if (s < h + arc) { const a = Math.PI / 2 - (s - h) / r, c = Math.cos(a), n = Math.sin(a); return out(cx + h + c * (r + d), cy + n * (r + d), c, n, s, d); }
        if (s < 3 * h + arc) return out(cx + h - (s - h - arc), cy - r - d, 0, -1, s, d);
        if (s < 3 * h + 2 * arc) { const a = 1.5 * Math.PI - (s - 3 * h - arc) / r, c = Math.cos(a), n = Math.sin(a); return out(cx - h + c * (r + d), cy + n * (r + d), c, n, s, d); }
        return out(cx - h + (s - 3 * h - 2 * arc), cy + r + d, 0, 1, s, d);
      },
    };
  }

  // the Indy-Galactic 500's oval: how far round the lap its straights and ends are (for its gates and pickups)
  const IH = 700, IR = 420, IARC = Math.PI * IR;

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
    {
      // the easiest and fastest course: a big oval flown flat out between rock walls that keep everyone in (and
      // stop shots), three lanes to keep to, nitro on both straights, no weapons unless they are switched on,
      // and just three giant donuts (two and a half times the usual, counting anywhere on them, as wide as the
      // lane): the line, and one on the far side of each end's world. The infield's worlds pull only lightly
      id: 'indy', name: 'INDY-GALACTIC 500', blurb: 'FLAT OUT ROUND THE WALLED OVAL', laps: 5, seed: 43, donut: 2.5, weapons: false,
      nebula: ['#26100a', '#3c1a0e', '#542612', '#0e1a3a', '#142a5a', '#1a3a72'],
      lane: { cx: 2000, cy: 1300, len: 2 * IH, r: IR, w: 280, gap: 85 },
      cps: [[2000, 1300 + IR], [2000 + IH + IR, 1300], [2000 - IH - IR, 1300]],
      planets: [
        { x: 2000, y: 1300, r: 150, type: 'gas', seed: 44, ring: true, g: 150 },
        { x: 2000 + IH, y: 1300, r: 66, type: 'moon', seed: 45 },
        { x: 2000 - IH, y: 1300, r: 66, type: 'ice', seed: 46 },
      ],
      // nitro across the lane on each half of both straights (one boost runs into the next, and the last carries
      // you round the end); power-ups in the outer lanes going into each end, and (weapons on) crates in every
      // lane coming out of it
      pickups: [
        { s: IH / 2, lanes: [-1, 0, 1], kind: 'N' },
        { s: IH + IARC * 0.22, lanes: [-1, 1], kind: 'P' },
        { s: IH + IARC * 0.78, lanes: [-1, 0, 1], kind: 'W' },
        { s: IH + IARC + IH / 2, lanes: [-1, 0, 1], kind: 'N' },
        { s: IH + IARC + IH * 1.5, lanes: [-1, 0, 1], kind: 'N' },
        { s: 3 * IH + IARC * 1.22, lanes: [-1, 1], kind: 'P' },
        { s: 3 * IH + IARC * 1.78, lanes: [-1, 0, 1], kind: 'W' },
        { s: 3 * IH + 2 * IARC + IH / 2, lanes: [-1, 0, 1], kind: 'N' },
      ],
    },
  ]);

  /*
   * Arenas for the combat modes: no gates, just a walled square of space
   * `radius` out from (cx, cy). The middle is kept clear, because that is
   * where a battle royale ends up.
   *
   * rings    pickups spaced around the centre { d, n, kind, a }
   */
  RR.ARENAS = [
    {
      id: 'crucible', name: 'THE CRUCIBLE', blurb: 'THREE WORLDS AND OPEN SKY', arena: true, seed: 53,
      nebula: ['#2e0f1c', '#4a1424', '#6a1c2c', '#1c1038', '#2a1654', '#3a1e70'],
      cx: 1500, cy: 1500, radius: 720, spawnA: 0.35,
      planets: [
        { x: 1130, y: 1350, r: 110, type: 'lava', seed: 31 },
        { x: 1850, y: 1720, r: 92, type: 'ice', seed: 32 },
        { x: 1640, y: 1010, r: 56, type: 'moon', seed: 33 },
      ],
      fields: [
        { x: 1260, y: 1880, rx: 230, ry: 120, n: 9, max: 2 },
        { x: 1990, y: 1240, rx: 140, ry: 200, n: 8, max: 2 },
      ],
      rings: [
        { d: 150, n: 3, kind: 'W', a: 0.5 },
        { d: 400, n: 5, kind: 'P', a: 1.1 },
        { d: 590, n: 4, kind: 'W', a: 0.1 },
      ],
    },
    {
      id: 'garden', name: 'ROCK GARDEN', blurb: 'A BRAWL IN THE THICK OF THE BELT', arena: true, seed: 67,
      nebula: ['#0e2a1c', '#12402a', '#185a36', '#101c46', '#16295e', '#1d3a78'],
      cx: 1500, cy: 1500, radius: 760, spawnA: 0,
      planets: [
        { x: 960, y: 1960, r: 150, type: 'gas', seed: 41, ring: true },
        { x: 1890, y: 1160, r: 64, type: 'moon', seed: 42 },
      ],
      fields: [{ x: 1500, y: 1500, rx: 660, ry: 620, n: 44, max: 3 }],
      orbiters: [{ planet: 1, dist: 150, n: 3, speed: 0.4, size: 1 }],
      rings: [
        { d: 170, n: 4, kind: 'W', a: 0.8 },
        { d: 420, n: 5, kind: 'P', a: 0.3 },
        { d: 620, n: 4, kind: 'W', a: 1.3 },
      ],
    },
  ];

  /*
   * Capture the Flag maps. A flag map has `flags: true`, `bases` (one per
   * team, two or three: each team's flag stands on its base and it spawns
   * beside it) and `spots`: pickups placed by hand { x, y, kind }. Its walls
   * are a rectangle (half sizes `w` and `h` round (cx, cy)) or, with
   * `round: true`, a circle of `radius`. `rule` is the line the menu shows.
   * Every map is fair: two teams' halves are each other turned half way round
   * the middle (`mirror`), three teams' thirds each other turned a third of
   * the way (`turn3`), so no team's side is better.
   */
  const turned = function (o, cx, cy, a, k) { // o turned by angle a round (cx, cy); copy k gets its own art
    const c = Math.cos(a), sn = Math.sin(a), dx = o.x - cx, dy = o.y - cy;
    const t = Object.assign({}, o, { x: Math.round(cx + dx * c - dy * sn), y: Math.round(cy + dx * sn + dy * c) });
    if (o.seed) t.seed = o.seed + 50 * k;
    if (o.rx && Math.abs(a - Math.PI) > 1e-9) t.rot = (o.rot || 0) + a; // (a half turn leaves an ellipse as it was)
    return t;
  };
  const mirror = function (list, cx, cy) { // each item, and its twin turned half way round (cx, cy)
    const out = [];
    list.forEach(function (o) { out.push(o, turned(o, cx, cy, Math.PI, 1)); });
    return out;
  };
  const turn3 = function (list, cx, cy) { // each item, and two copies turned a third and two thirds of the way round (cx, cy)
    const out = [];
    list.forEach(function (o) { out.push(o, turned(o, cx, cy, TAU / 3, 1), turned(o, cx, cy, (2 * TAU) / 3, 2)); });
    return out;
  };
  /** The point `r` from (cx, cy), `deg` degrees round from east (90: south), with `more` fields added. */
  const polar = function (cx, cy, r, deg, more) {
    const a = (deg * Math.PI) / 180;
    return Object.assign({ x: Math.round(cx + Math.cos(a) * r), y: Math.round(cy + Math.sin(a) * r) }, more);
  };
  const TRI = function (cx, cy, r) { return [polar(cx, cy, r, -90), polar(cx, cy, r, 30), polar(cx, cy, r, 150)]; }; // three bases, a third of the way round from each other

  RR.FLAG_MAPS = [
    {
      id: 'divide', name: 'THE GREAT DIVIDE', blurb: 'TWO BASES AND A VAST GULF OF SPACE', arena: true, flags: true, seed: 79,
      rule: '3 V 3 - BRING THEIR FLAG HOME',
      nebula: ['#0c1a3a', '#12285a', '#1a3a7a', '#3a0f22', '#5a1630', '#7a1e3c'],
      cx: 4000, cy: 2000, w: 3300, h: 1500, // 6600 x 3000: about nine arenas
      bases: [{ x: 1100, y: 2000 }, { x: 6900, y: 2000 }],
      // the giant in the middle is vast but light: at the usual pull for its size (468) it would hold a ship
      // that touched it for good, as no rocket's thrust (357 to 430) beats that at its surface
      planets: [{ x: 4000, y: 2000, r: 260, type: 'gas', seed: 71, ring: true, g: 290 }].concat(mirror([
        { x: 2650, y: 1150, r: 125, type: 'lava', seed: 72 },
        { x: 2600, y: 2950, r: 92, type: 'ice', seed: 73 },
        { x: 1750, y: 1250, r: 62, type: 'moon', seed: 74 },
        { x: 1800, y: 2800, r: 74, type: 'desert', seed: 75 },
        { x: 3350, y: 3150, r: 58, type: 'moon', seed: 76 },
      ], 4000, 2000)),
      fields: mirror([
        { x: 3250, y: 2000, rx: 170, ry: 560, n: 18, max: 3 },
        { x: 4000, y: 850, rx: 520, ry: 160, n: 14, max: 2 },
        { x: 2150, y: 2000, rx: 120, ry: 300, n: 7, max: 2 },
      ], 4000, 2000),
      spots: mirror([
        { x: 1550, y: 1700, kind: 'P' }, { x: 1550, y: 2300, kind: 'P' }, { x: 1950, y: 2000, kind: 'W' },
        { x: 2700, y: 1650, kind: 'W' }, { x: 2750, y: 2400, kind: 'P' },
        { x: 3300, y: 1150, kind: 'P' }, { x: 3200, y: 2900, kind: 'W' },
        { x: 4000, y: 1350, kind: 'W' }, { x: 3700, y: 1550, kind: 'P' },
      ], 4000, 2000),
    },
    {
      // small and quick: a slanting asteroid wall across the middle, a narrow gap at each end beside a planet
      id: 'crossing', name: 'THE CROSSING', blurb: 'A SHORT HOP AND A SLANTING ROCK WALL', arena: true, flags: true, seed: 83,
      rule: '3 V 3 - BRING THEIR FLAG HOME',
      nebula: ['#0e1f2e', '#13304a', '#1a4566', '#2a1036', '#3d1650', '#521e6a'],
      cx: 3000, cy: 1700, w: 2300, h: 1200, // 4600 x 2400
      bases: [{ x: 1150, y: 1700 }, { x: 4850, y: 1700 }],
      planets: mirror([
        { x: 2300, y: 1150, r: 150, type: 'terra', seed: 84 },
        { x: 1700, y: 2450, r: 70, type: 'moon', seed: 85 },
      ], 3000, 1700),
      fields: [{ x: 3000, y: 1700, rx: 600, ry: 120, rot: 1.05, n: 24, max: 3 }].concat(mirror([
        { x: 2000, y: 1150, rx: 220, ry: 90, rot: 0.3, n: 6, max: 2 },
      ], 3000, 1700)),
      spots: mirror([
        { x: 1550, y: 1450, kind: 'P' }, { x: 1550, y: 1950, kind: 'P' }, { x: 1900, y: 1700, kind: 'W' },
        { x: 2500, y: 2150, kind: 'W' }, { x: 2900, y: 900, kind: 'P' }, { x: 2600, y: 1750, kind: 'P' },
      ], 3000, 1700),
    },
    {
      // corner bases on a long diagonal: a rock belt across it, and a sun beyond each end of the belt to swing round
      id: 'suns', name: 'TWIN SUNS', blurb: 'CORNER BASES - SWING ROUND THE SUNS', arena: true, flags: true, seed: 87,
      rule: '3 V 3 - BRING THEIR FLAG HOME',
      nebula: ['#2a0e0a', '#44160e', '#5e2010', '#1a1030', '#241848', '#30205e'],
      cx: 3700, cy: 2300, w: 2900, h: 1800, // 5800 x 3600
      bases: [{ x: 1550, y: 1200 }, { x: 5850, y: 3400 }],
      planets: mirror([
        { x: 3150, y: 3250, r: 185, type: 'lava', seed: 88, g: 320 },
        { x: 2350, y: 2650, r: 80, type: 'ice', seed: 89 },
        { x: 1500, y: 2300, r: 60, type: 'moon', seed: 90 },
      ], 3700, 2300),
      fields: [{ x: 3700, y: 2300, rx: 660, ry: 130, rot: 2.03, n: 26, max: 3 }].concat(mirror([
        { x: 2500, y: 1400, rx: 260, ry: 100, rot: 0.5, n: 8, max: 2 },
      ], 3700, 2300)),
      spots: mirror([
        { x: 2050, y: 950, kind: 'P' }, { x: 1500, y: 1700, kind: 'P' }, { x: 2150, y: 1550, kind: 'W' },
        { x: 2800, y: 2000, kind: 'W' }, { x: 2700, y: 3050, kind: 'P' }, { x: 3500, y: 1500, kind: 'P' },
      ], 3700, 2300),
    },
    {
      // three teams: bases a third of the way round from each other, a ringed giant in the middle with rocks
      // circling it, and across the straight way between each pair of bases a rock wall: squeeze past it on the
      // inside, by the giant, or go the long way round the outside
      id: 'triad', name: 'THE TRIAD', blurb: 'THREE BASES ROUND A RINGED GIANT', arena: true, flags: true, round: true, seed: 91,
      rule: '2 V 2 V 2 - BRING ANY FLAG HOME',
      nebula: ['#0a1e1a', '#0e2e28', '#144038', '#10183a', '#162256', '#1e2e72'],
      cx: 3000, cy: 3000, radius: 2500,
      bases: TRI(3000, 3000, 1750),
      planets: [{ x: 3000, y: 3000, r: 210, type: 'gasBlue', seed: 92, ring: true, g: 270 }].concat(turn3([
        polar(3000, 3000, 1520, -48, { r: 64, type: 'moon', seed: 93 }),
      ], 3000, 3000)),
      orbiters: [{ planet: 0, dist: 360, n: 6, speed: 0.22, size: 1 }],
      fields: turn3([
        polar(3000, 3000, 880, -30, { rx: 340, ry: 120, rot: -Math.PI / 6, n: 16, max: 3 }),
      ], 3000, 3000),
      spots: turn3([
        polar(3000, 3000, 1480, -112, { kind: 'P' }), polar(3000, 3000, 1480, -68, { kind: 'P' }), polar(3000, 3000, 1180, -90, { kind: 'W' }),
        polar(3000, 3000, 1550, -30, { kind: 'W' }), polar(3000, 3000, 470, -30, { kind: 'P' }),
      ], 3000, 3000),
    },
    {
      // three teams round a broken moon (a ball of rocks); a world sits on the straight way between each pair of bases
      id: 'crown', name: 'TRIPLE CROWN', blurb: 'THREE WORLDS GUARD A BROKEN MOON', arena: true, flags: true, round: true, seed: 95,
      rule: '2 V 2 V 2 - BRING ANY FLAG HOME',
      nebula: ['#22102e', '#331648', '#461e62', '#0e2430', '#123448', '#164660'],
      cx: 3200, cy: 3200, radius: 2700,
      bases: TRI(3200, 3200, 1900),
      planets: turn3([
        polar(3200, 3200, 1080, -30, { r: 150, type: 'lava', seed: 96, g: 300 }),
        polar(3200, 3200, 1950, -132, { r: 70, type: 'ice', seed: 97 }),
      ], 3200, 3200),
      fields: [{ x: 3200, y: 3200, rx: 380, ry: 380, n: 24, max: 3 }].concat(turn3([
        polar(3200, 3200, 1500, -62, { rx: 170, ry: 90, rot: 0.6, n: 6, max: 2 }),
      ], 3200, 3200)),
      spots: turn3([
        polar(3200, 3200, 1600, -110, { kind: 'P' }), polar(3200, 3200, 1600, -70, { kind: 'P' }), polar(3200, 3200, 1300, -90, { kind: 'W' }),
        polar(3200, 3200, 1750, -30, { kind: 'W' }), polar(3200, 3200, 640, -30, { kind: 'P' }),
      ], 3200, 3200),
    },
  ];

  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = RR.clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  function build(def) {
    const rnd = RR.rng(def.seed * 9973 + 1);
    const arena = !!def.arena;
    const N = arena ? 0 : def.cps.length;
    // the donuts' size: their tube's centre-line and outer edge, and how near a gate's middle counts as through it
    const big = def.donut || 1, donutR = Art.DONUT_RC * big, outer = (Art.DONUT_RC + Art.DONUT_RT) * big;
    const cpR = def.donut ? Math.round(outer) + 3 : 0; // (a course of bigger donuts: anywhere on one; else the hole)
    const lane = def.lane ? makeLane(def.lane) : null;

    /* checkpoints ------------------------------------------------------- */
    const cps = (def.cps || []).map(function (p, i) { return { i: i, x: p[0], y: p[1], finish: i === 0 }; });
    if (lane) cps.forEach(function (c) { c.s = lane.at(c.x, c.y).s; }); // (how far round the lane each gate is)
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
        g: p.g || 260 + p.r * 0.8, range: p.r * 3.4, map: Art.PTYPES[p.type].map, // (`g`: a pull of its own)
      };
    });

    /** Nudge a point out of any planet it landed in (or too near). */
    function offPlanets(pt, pad) {
      planets.forEach(function (p) {
        const d = Math.hypot(pt.x - p.x, pt.y - p.y), min = p.r + pad;
        if (d < min) { pt.x = p.x + ((pt.x - p.x) / (d || 1)) * min; pt.y = p.y + ((pt.y - p.y) / (d || 1)) * min; }
      });
      return pt;
    }

    /* starting grid: staggered pairs behind the start gate, or (arenas) a
     * circle of spawn points facing the middle ---------------------------- */
    const grid = [];
    let c0 = null, ux = 0, uy = 0, laneEnd = null;
    if (def.flags) {
      // spawn points in a line beside each base, on its side towards the middle, facing it;
      // ship i spawns on side i % (number of bases)
      const nb = def.bases.length, per = Math.ceil(6 / nb);
      for (let i = 0; i < 6; i++) {
        const side = i % nb, j = Math.floor(i / nb), b = def.bases[side];
        const d = Math.hypot(def.cx - b.x, def.cy - b.y) || 1, ex = (def.cx - b.x) / d, ey = (def.cy - b.y) / d;
        const off = (j - (per - 1) / 2) * 170;
        const pt = offPlanets({ x: b.x + ex * 260 - ey * off, y: b.y + ey * 260 + ex * off }, 80);
        grid.push({ x: pt.x, y: pt.y, a: Math.atan2(ey, ex), side: side });
      }
    } else if (arena) {
      for (let i = 0; i < 6; i++) {
        const a = (def.spawnA || 0) + (i / 6) * TAU;
        const pt = offPlanets({ x: def.cx + Math.cos(a) * def.radius * 0.6, y: def.cy + Math.sin(a) * def.radius * 0.6 }, 80);
        grid.push({ x: pt.x, y: pt.y, a: Math.atan2(def.cy - pt.y, def.cx - pt.x) });
      }
    } else {
      c0 = cps[0];
      if (lane) { const t0 = lane.at(c0.x, c0.y); ux = t0.tx; uy = t0.ty; } // (a walled lane: lined up along it)
      else {
        const cl = cps[N - 1];
        const gl = Math.hypot(c0.x - cl.x, c0.y - cl.y);
        ux = (c0.x - cl.x) / gl; uy = (c0.y - cl.y) / gl;
      }
      const front = Math.round(outer) + 57; // the front row, well clear of the start donut (112 behind the usual one)
      for (let i = 0; i < 6; i++) {
        const back = front + (i >> 1) * 46 + (i & 1) * 18, side = i & 1 ? 1 : -1;
        grid.push({ x: c0.x - ux * back - uy * side * 22, y: c0.y - uy * back + ux * side * 22, a: Math.atan2(uy, ux) });
      }
      laneEnd = { x: c0.x - ux * (front + 178), y: c0.y - uy * (front + 178) };
    }

    /* pickups ----------------------------------------------------------- */
    const pickups = [];
    (def.pickups || []).forEach(function (row) {
      if (lane && row.s != null) { // a walled lane: one in each of the row's lanes
        row.lanes.forEach(function (l) { const pt = lane.point(row.s, l * lane.gap); pickups.push({ x: pt.x, y: pt.y, kind: row.kind }); });
        return;
      }
      const a = cps[row.seg], b = cps[(row.seg + 1) % N];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      const mx = a.x + dx * row.t, my = a.y + dy * row.t, gap = row.gap || 36;
      for (let k = 0; k < row.n; k++) {
        const off = (k - (row.n - 1) / 2) * gap;
        // never bury a pickup in a planet
        const pt = offPlanets({ x: mx - (dy / l) * off, y: my + (dx / l) * off }, 46);
        pickups.push({ x: pt.x, y: pt.y, kind: row.kind });
      }
    });
    (def.spots || []).forEach(function (o) {
      const pt = offPlanets({ x: o.x, y: o.y }, 46);
      pickups.push({ x: pt.x, y: pt.y, kind: o.kind });
    });
    (def.rings || []).forEach(function (ring) {
      for (let k = 0; k < ring.n; k++) {
        const a = (ring.a || 0) + (k / ring.n) * TAU;
        const pt = offPlanets({ x: def.cx + Math.cos(a) * ring.d, y: def.cy + Math.sin(a) * ring.d }, 46);
        pickups.push({ x: pt.x, y: pt.y, kind: ring.kind });
      }
    });

    /* asteroids --------------------------------------------------------- */
    const rocks = [];
    function clear(x, y, r) {
      for (let k = 0; k < cps.length; k++) if (Math.hypot(x - cps[k].x, y - cps[k].y) < outer + 49 + r) return false; // (104 round the usual donut)
      for (let k = 0; k < planets.length; k++) if (Math.hypot(x - planets[k].x, y - planets[k].y) < planets[k].r + 26 + r) return false;
      for (let k = 0; k < pickups.length; k++) if (Math.hypot(x - pickups[k].x, y - pickups[k].y) < 30 + r) return false;
      for (let k = 0; k < rocks.length; k++) if (Math.hypot(x - rocks[k].x, y - rocks[k].y) < r + rocks[k].r + 16) return false;
      if (laneEnd && segDist(x, y, laneEnd.x, laneEnd.y, c0.x + ux * 120, c0.y + uy * 120) < 74 + r) return false;
      if (arena) {
        for (let k = 0; k < grid.length; k++) if (Math.hypot(x - grid[k].x, y - grid[k].y) < 70 + r) return false;
        if (def.flags) {
          if (def.round ? Math.hypot(x - def.cx, y - def.cy) > def.radius - r - 20
            : Math.abs(x - def.cx) > def.w - r - 20 || Math.abs(y - def.cy) > def.h - r - 20) return false;
          for (let k = 0; k < def.bases.length; k++) if (Math.hypot(x - def.bases[k].x, y - def.bases[k].y) < 300 + r) return false;
        } else if (Math.hypot(x - def.cx, y - def.cy) > def.radius - r - 20) return false;
      }
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

    /* a walled lane: rocks along both walls, with a looser row behind (scenery: the walls themselves are the
     * lane's edges, exactly, in game.js; these stay put, so online they are never sent) ------------------ */
    const walls = [];
    if (lane) {
      const wr = RR.rng(def.seed * 7919 + 3), hl = lane.len / 2, arc = Math.PI * lane.r;
      const onEnd = function (s) { return (s >= hl && s < hl + arc) || (s >= 3 * hl + arc && s < 3 * hl + 2 * arc); };
      [-1, 1].forEach(function (side) {
        [0, 1].forEach(function (back) { // the wall's face, then rubble behind it
          for (let s = wr() * 20; s < lane.lap;) {
            const size = back ? 1 + Math.floor(wr() * 3) : 2 + Math.floor(wr() * 3), r = Art.ROCK_SIZES[size];
            const d = side * (lane.w / 2 + r * 0.75 + (back ? 26 + wr() * 22 : 0)), p = lane.point(s, d);
            walls.push({ x: p.x, y: p.y, r: r, size: size, variant: Math.floor(wr() * 4), rot: Math.round(wr() * 40) / 6.4 });
            const step = r * (back ? 2.6 : 1.25) * (0.85 + wr() * 0.3); // (round an end, step the wall's own length)
            s += onEnd(s) ? (step * lane.r) / Math.max(40, lane.r + d) : step;
          }
        });
      });
    }

    /* bounds + minimap --------------------------------------------------- */
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    if (lane) { // the whole lane and its walls
      const ex = lane.len / 2 + lane.r + lane.w / 2 + 60, ey = lane.r + lane.w / 2 + 60;
      x0 = lane.cx - ex; x1 = lane.cx + ex; y0 = lane.cy - ey; y1 = lane.cy + ey;
    }
    cps.forEach(function (c) {
      x0 = Math.min(x0, c.x - 80); y0 = Math.min(y0, c.y - 80);
      x1 = Math.max(x1, c.x + 80); y1 = Math.max(y1, c.y + 80);
    });
    planets.forEach(function (p) {
      x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r);
      x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r);
    });
    let bounds = { x0: x0 - 420, y0: y0 - 420, x1: x1 + 420, y1: y1 + 420 };
    if (arena) {
      const box = def.flags && !def.round, hw = box ? def.w : def.radius, hh = box ? def.h : def.radius;
      x0 = def.cx - hw; y0 = def.cy - hh; x1 = def.cx + hw; y1 = def.cy + hh;
      bounds = { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    const MW = 90, MH = 62, pad = 4;
    const ms = Math.min((MW - pad * 2) / (x1 - x0), (MH - pad * 2) / (y1 - y0));
    const mox = (MW - (x1 - x0) * ms) / 2 - x0 * ms, moy = (MH - (y1 - y0) * ms) / 2 - y0 * ms;
    const mini = RR.canvas(MW, MH);
    if (lane) { // a walled lane: its two walls
      [-1, 1].forEach(function (side) {
        for (let k = 0; k < 96; k++) {
          const a = lane.point((k / 96) * lane.lap, (side * lane.w) / 2), b = lane.point(((k + 1) / 96) * lane.lap, (side * lane.w) / 2);
          RR.line(mini.g, a.x * ms + mox, a.y * ms + moy, b.x * ms + mox, b.y * ms + moy, PAL.steel, 1);
        }
      });
    } else {
      for (let i = 0; i < N; i++) {
        const a = cps[i], b = cps[(i + 1) % N];
        RR.line(mini.g, a.x * ms + mox, a.y * ms + moy, b.x * ms + mox, b.y * ms + moy, PAL.steel, 2);
      }
    }
    planets.forEach(function (p) {
      RR.disc(mini.g, p.x * ms + mox, p.y * ms + moy, Math.max(1, p.r * ms), p.map);
    });
    if (def.round) RR.ring(mini.g, def.cx * ms + mox, def.cy * ms + moy, def.radius * ms, PAL.slate); // a round arena's wall

    return {
      def: def, name: def.name, laps: def.laps,
      cps: cps, cpR: cpR, donut: big, donutR: donutR, donuts: donuts, lane: lane, walls: walls, planets: planets, grid: grid, pickups: pickups, rocks: rocks,
      bounds: bounds, arena: arena,
      center: arena ? { x: def.cx, y: def.cy } : null, radius: arena ? def.radius || Math.max(def.w, def.h) : 0,
      bases: def.bases ? def.bases.map(function (b) { return { x: b.x, y: b.y }; }) : null, flags: !!def.flags,
      wall: def.round ? { x: def.cx, y: def.cy, r: def.radius } : null, // a round arena's wall (else: the bounds)
      mini: { cv: mini, w: MW, h: MH, s: ms, ox: mox, oy: moy },
      nebula: Art.nebula(def.seed, def.nebula),
    };
  }

  const built = {};
  RR.getTrack = function (idx) {
    if (!built[idx]) built[idx] = build(TRACKS[idx]);
    return built[idx];
  };
  RR.getArena = function (idx) {
    const key = 'a' + idx;
    if (!built[key]) built[key] = build(RR.ARENAS[idx]);
    return built[key];
  };
  RR.getFlagMap = function (idx) {
    const key = 'f' + idx;
    if (!built[key]) built[key] = build(RR.FLAG_MAPS[idx]);
    return built[key];
  };
  /** The courses, arenas or flag maps an event is held on. */
  RR.mapsFor = function (mode) { return mode === 'race' ? TRACKS : mode === 'ctf' ? RR.FLAG_MAPS : RR.ARENAS; };
  RR.getMap = function (mode, idx) {
    const n = RR.mapsFor(mode).length, i = ((idx % n) + n) % n;
    return mode === 'race' ? RR.getTrack(i) : mode === 'ctf' ? RR.getFlagMap(i) : RR.getArena(i);
  };
})();
