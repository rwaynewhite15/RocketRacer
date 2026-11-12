/* ==========================================================================
 * ROCKET RACER — art.js
 * Every sprite in the game is generated here at start-up: hand-plotted pixel
 * maps for ships and icons, and per-pixel procedural shading (with ordered
 * dithering) for planets, asteroids, donut gates, nebulae and starfields.
 * No image files are loaded.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR, PAL = RR.PAL, TAU = RR.TAU, hex = RR.hex;
  const Art = (RR.Art = {});

  /* Single-character colour codes used by the pixel maps below. */
  const CMAP = {
    k: PAL.ink, p: PAL.plum, r: PAL.red, o: PAL.orange, y: PAL.yellow, l: PAL.lime, g: PAL.green,
    t: PAL.teal, n: PAL.navy, b: PAL.blue, s: PAL.sky, c: PAL.cyan, w: PAL.white, v: PAL.silver,
    e: PAL.steel, d: PAL.slate, P: PAL.pink, H: PAL.hot, V: PAL.violet, R: PAL.alarm, Y: '#fff1a8',
    D: '#5a1420',
  };

  function sprite(rows, extra) {
    const h = rows.length, w = rows[0].length;
    const cv = RR.canvas(w, h), g = cv.g;
    for (let y = 0; y < h; y++) {
      const row = rows[y];
      for (let x = 0; x < w; x++) {
        const ch = row[x];
        const col = (extra && extra[ch]) || CMAP[ch];
        if (!col) continue;
        g.fillStyle = col;
        g.fillRect(x, y, 1, 1);
      }
    }
    return cv;
  }

  /** Flat-colour silhouette of a sprite. */
  Art.tint = function (cv, color) {
    const out = RR.canvas(cv.width, cv.height), g = out.g;
    g.drawImage(cv, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, cv.width, cv.height);
    g.globalCompositeOperation = 'source-over';
    return out;
  };

  /* --------------------------------------------------------------- ships */

  // Drawn nose-up. i/a/A = team colour (light / mid / dark).
  const SHIPS = [
    { // classic rocket
      ports: [[0, 11]],
      rows: [
        '.......k.......',
        '......kik......',
        '......kak......',
        '.....kiaAk.....',
        '.....kaaAk.....',
        '....kiaaAAk....',
        '....kaaaAAk....',
        '....kwwvvek....',
        '....kwccsek....',
        '....kwcsbek....',
        '....kwsbbek....',
        '....kwwvvek....',
        '....kwwvvek....',
        '...kkwwvvekk...',
        '..kikwwvvekAk..',
        '.kiakwwvvekaAk.',
        '.kaakwwvvekaAk.',
        'kiaAkwwvvekaAAk',
        'kaAAkkeeekkAAAk',
        'kAAk.kdddk.kAAk',
        'kkk..kkkkk..kkk',
      ],
    },
    { // delta-wing dart
      ports: [[0, 11]],
      rows: [
        '.......k.......',
        '......kwk......',
        '......kwk......',
        '.....kwwek.....',
        '.....kwvek.....',
        '.....kcsbk.....',
        '....kkcsbkk....',
        '...kiawveaAk...',
        '..kiaawveaAAk..',
        '.kiaaawveaaAAk.',
        'kiaaaawveaaaAAk',
        'kaaaaAwveaaAAAk',
        'kaaAAkwvekAAAAk',
        'kAkk.kwvek.kkAk',
        'kkk..kwvek..kkk',
        '.....kwvek.....',
        '.....kwvek.....',
        '....kkeeekk....',
        '....kdeeedk....',
        '....kkdddkk....',
        '.....kkkkk.....',
      ],
    },
    { // twin-engine pod racer
      ports: [[-5, 11], [5, 11]],
      rows: [
        '..k.........k..',
        '.kik.......kAk.',
        '.kak.......kAk.',
        '.kak.......kAk.',
        '.kak..kkk..kAk.',
        '.kak.kwwek.kAk.',
        '.kakkwccsekkAk.',
        '.kaakwcsbekAAk.',
        '.kaakwsbbekAAk.',
        '.kaakwwvvekAAk.',
        '.kakkwwvvekkAk.',
        '.kak.kwvek.kAk.',
        '.kak.kwvek.kAk.',
        '.kak..kkk..kAk.',
        'kiaak.....kaAAk',
        'kiaak.....kaAAk',
        'kaaAk.....kaAAk',
        'kaAAk.....kAAAk',
        'kkeek.....keekk',
        '.kddk.....kddk.',
        '.kkkk.....kkkk.',
      ],
    },
    { // swept-wing interceptor
      ports: [[0, 11]],
      rows: [
        '.......k.......',
        '......kik......',
        '.....kiaAk.....',
        '.....kwvek.....',
        '....kwcsbek....',
        '.k..kwcsbek..k.',
        '.k..kwsbbek..k.',
        'kik.kwwvvek.kAk',
        'kakkiwwvveAkkAk',
        'kakiawwvveaAkAk',
        'kaiaawwvveaaAAk',
        'kaaaawwvveaaAAk',
        'kaaaAkwvekaAAAk',
        'kaaAkkwvekkAAAk',
        'kaAk.kwvek.kAAk',
        'kAk.kkwvekk.kAk',
        'kkk.kiwveAk.kkk',
        '....kaeeeAk....',
        '....kdeeedk....',
        '....kkdddkk....',
        '.....kkkkk.....',
      ],
    },
  ];

  Art.TEAMS = [
    { i: '#ff9d8f', a: '#e5404f', A: '#8c1d3c' },
    { i: '#9bd8ff', a: '#3b82f6', A: '#1e3a8a' },
    { i: '#cdf7a0', a: '#3fbf5a', A: '#17643a' },
    { i: '#fff3b0', a: '#f5b82e', A: '#a05a12' },
    { i: '#e6c0ff', a: '#a855f7', A: '#5b21b6' },
    { i: '#b5fff2', a: '#1fc7b9', A: '#0d6470' },
  ];

  const shipCache = {};
  Art.ship = function (design, team) {
    const key = design + ':' + team;
    if (!shipCache[key]) shipCache[key] = sprite(SHIPS[design].rows, Art.TEAMS[team]);
    return shipCache[key];
  };
  Art.shipWhite = function (design) {
    const key = 'w' + design;
    if (!shipCache[key]) shipCache[key] = Art.tint(Art.ship(design, 0), '#ffffff');
    return shipCache[key];
  };
  Art.shipPorts = function (design) {
    return SHIPS[design].ports;
  };

  /* ---------------------------------------------------- icons and pickups */

  const ICONS = {
    nitro: [
      '.....wy..',
      '....wyy..',
      '...wyy...',
      '..wyyyyy.',
      '....yyo..',
      '...yyo...',
      '..yyo....',
      '..yo.....',
      '.........',
    ],
    shield: [
      'sssssssss',
      'scccsbbbs',
      'scwcsbbbs',
      'scccsbbbs',
      'scccsbbbs',
      '.sccsbbs.',
      '.sccsbbs.',
      '..scsbs..',
      '...sss...',
    ],
    repair: [
      '...www...',
      '...wll...',
      '...wll...',
      'wwwwllggg',
      'wlllllllg',
      'wllllgggg',
      '...llg...',
      '...llg...',
      '...ggg...',
    ],
    blaster: [
      '.........',
      'sccccw...',
      '.........',
      '...sccccw',
      '.........',
      'sccccw...',
      '.........',
      '...sccccw',
      '.........',
    ],
    missile: [
      '......RR.',
      '.....RwwR',
      '....vwwwR',
      '...vwwwv.',
      '..vwwwv..',
      '.ovwwv...',
      'yoovv....',
      '.yo......',
      'y.y......',
    ],
    mine: [
      'v...v...v',
      '.v.vvv.v.',
      '..vedev..',
      '.veeeeev.',
      'vveeReevv',
      '.veeeeev.',
      '..vedev..',
      '.v.vvv.v.',
      'v...v...v',
    ],
    emp: [
      '...VVV...',
      '.VV...VV.',
      '.V..c..V.',
      'V..ccc..V',
      'V.ccwcc.V',
      'V..ccc..V',
      '.V..c..V.',
      '.VV...VV.',
      '...VVV...',
    ],
    rewind: [ // the "rewind" double arrow: light on top, violet below
      '....c...c',
      '...cc..cc',
      '..ccc.ccc',
      '.cccccccc',
      'wwwwwwwww',
      '.VVVVVVVV',
      '..VVV.VVV',
      '...VV..VV',
      '....V...V',
    ],
  };

  function pickupSprite(icon, light, mid, dark) {
    const S = 17, cv = RR.canvas(S, S), g = cv.g;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const qx = Math.max(0, Math.abs(x - 8) - 5), qy = Math.max(0, Math.abs(y - 8) - 5);
        const dd = Math.hypot(qx, qy);
        if (dd > 3.3) continue;
        g.fillStyle = dd > 2.45 ? PAL.ink : dd > 1.45 ? (x + y < 16 ? light : mid) : dark;
        g.fillRect(x, y, 1, 1);
      }
    }
    g.drawImage(icon, 4, 4);
    return cv;
  }

  /* ------------------------------------------------------ shaded surfaces */

  // Light direction (towards the light): up-left and out of the screen.
  const L3 = (function () {
    const v = [-0.5, -0.62, 0.6], m = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / m, v[1] / m, v[2] / m];
  })();

  function R(list) { return list.map(hex); }

  const RAMP = {
    deep: R(['#0a1440', '#102468', '#17399a', '#2456c8', '#3b7be8']),
    sea: R(['#0d2a66', '#15499c', '#2271cc', '#3d9be8', '#7cc8ff']),
    grass: R(['#0c3524', '#17603a', '#2b8f47', '#59bd55', '#a3e06c']),
    hill: R(['#33261a', '#59432c', '#866540', '#b38f5c', '#dcc088']),
    cloud: R(['#59688a', '#8c9fbe', '#bfcfe4', '#e6eef9', '#ffffff']),
    snow: R(['#4a6a9c', '#7fa9d6', '#b5dcf5', '#e2f6ff', '#ffffff']),
    sand: R(['#4a1c1a', '#7c2f24', '#b04a2c', '#d9743a', '#f5a85a']),
    dune: R(['#351419', '#5c2222', '#873428', '#ad4e2e', '#cf7440']),
    cream: R(['#5c3a22', '#96643a', '#c99a5e', '#ecc88c', '#fff0c8']),
    rust: R(['#3d1a12', '#6e2e1a', '#a34a24', '#cf7436', '#f0a458']),
    umber: R(['#2a1410', '#4a2418', '#703a22', '#96562e', '#b87a44']),
    azure: R(['#0c1f52', '#143a86', '#1f5cbc', '#3a8ae0', '#74c0ff']),
    aqua: R(['#0b3a4a', '#12607a', '#1c8ea8', '#3cc0d0', '#8ceef0']),
    indigo: R(['#12103c', '#201a66', '#342a96', '#5144c4', '#8070ea']),
    rock: R(['#17192b', '#2e3248', '#4d546e', '#7a8299', '#aeb5c6']),
    basalt: R(['#0e0a12', '#1e141c', '#33202a', '#4f2f36', '#6e4444']),
    acid: R(['#10341c', '#1f5c26', '#3f8f2e', '#7cc23c', '#c6ee6a']),
    grape: R(['#220f3a', '#3d1a66', '#632a96', '#9344c4', '#c878ea']),
    icy: R(['#28508c', '#4f86c4', '#8cc0ea', '#c8ecff', '#ffffff']),
    frost: R(['#1c3a70', '#3466a8', '#5c98d6', '#98ccf2', '#d8f4ff']),
    stone: R(['#231a26', '#42323d', '#6a5150', '#927468', '#c0a48e']),
    dough: R(['#5a2e14', '#8a4a20', '#b8722f', '#dc9a4a', '#f4c57a']),
    icing: R(['#8f2a5c', '#c93f84', '#f062a8', '#ff8fc6', '#ffc4e2']),
    chalk: R(['#8a94a8', '#b8c2d2', '#dfe6f0', '#f4f7fb', '#ffffff']),
    coal: R(['#0c0c16', '#1a1c2c', '#2a2e44', '#3c4260', '#5a6282']),
  };
  const LAVA = R(['#c2331c', '#ff7a1a', '#ffe066']);

  /** Pick a ramp shade for a light level, dithering between neighbours. */
  function pick(rmp, light, px, py, amp) {
    const n = rmp.length;
    const i = Math.floor(light * n + (RR.bayer(px, py) - 0.5) * (amp === undefined ? 0.75 : amp));
    return rmp[i < 0 ? 0 : i >= n ? n - 1 : i];
  }

  function put(d, i, c, a) {
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a === undefined ? 255 : a;
  }

  /* ------------------------------------------------------------- planets */

  const SURFACE = {
    terra: function (n, light, px, py, s) {
      const h = RR.fbm3(n[0] * 1.7 + 3.1, n[1] * 1.7 + 7.7, n[2] * 1.7 + 1.3, s, 5);
      const cl = RR.fbm3(n[0] * 2.2 + 31, n[1] * 4.6 + 17, n[2] * 2.2 + 9, s + 91, 4);
      if (cl > 0.62) return pick(RAMP.cloud, light + 0.12, px, py);
      if (Math.abs(n[1]) > 0.86 - (h - 0.5) * 0.5) return pick(RAMP.snow, light + 0.05, px, py);
      if (h > 0.6) return pick(RAMP.hill, light, px, py);
      if (h > 0.5) return pick(RAMP.grass, light, px, py);
      if (h > 0.45) return pick(RAMP.sea, light, px, py);
      return pick(RAMP.deep, light, px, py);
    },
    desert: function (n, light, px, py, s) {
      const h = RR.fbm3(n[0] * 2.1 + 2, n[1] * 2.1 + 5, n[2] * 2.1 + 8, s, 5);
      const f = RR.fbm3(n[0] * 6, n[1] * 6, n[2] * 6, s + 3, 3);
      if (Math.abs(n[1]) > 0.9 - (h - 0.5) * 0.4) return pick(RAMP.snow, light, px, py);
      return pick(h > 0.55 ? RAMP.dune : RAMP.sand, light + (f - 0.5) * 0.3, px, py);
    },
    gas: function (n, light, px, py, s, o) {
      const turb = RR.fbm3(n[0] * 2.4 + 5, n[1] * 2.4 + 1, n[2] * 2.4 + 9, s, 4);
      const b = Math.sin(n[1] * 9 + (turb - 0.5) * 3.4 + o.phase);
      const sx = (n[0] - o.sx) / 0.27, sy = (n[1] - o.sy) / 0.13, spot = sx * sx + sy * sy;
      if (spot < 1) return pick(o.ramps[3], light + (spot < 0.35 ? 0.12 : 0), px, py);
      const fine = Math.sin(n[1] * 31 + turb * 6) * 0.07;
      return pick(b > 0.4 ? o.ramps[0] : b > -0.35 ? o.ramps[1] : o.ramps[2], light + fine, px, py);
    },
    moon: function (n, light, px, py, s, o) {
      const v = RR.fbm3(n[0] * 3.1, n[1] * 3.1, n[2] * 3.1, s, 4);
      let l = light + (v - 0.5) * 0.5;
      for (let i = 0; i < o.craters.length; i++) {
        const c = o.craters[i];
        const dot = n[0] * c[0] + n[1] * c[1] + n[2] * c[2];
        if (dot > c[4]) {
          const ang = Math.acos(Math.min(1, dot)) / c[3];
          if (ang > 0.7) {
            const dx = n[0] - c[0], dy = n[1] - c[1], m = Math.hypot(dx, dy) || 1;
            l -= 0.34 * ((dx * L3[0] + dy * L3[1]) / m);
          } else l -= 0.15;
          break;
        }
      }
      return pick(o.ramps[0], l, px, py);
    },
    lava: function (n, light, px, py, s) {
      const v = RR.fbm3(n[0] * 2.3, n[1] * 2.3, n[2] * 2.3, s, 4);
      const c = Math.abs(RR.fbm3(n[0] * 3.2 + 20, n[1] * 3.2 + 4, n[2] * 3.2 + 8, s + 5, 4) - 0.5);
      if (c < 0.011) return LAVA[2];
      if (c < 0.024) return LAVA[1];
      if (c < 0.038) return LAVA[0];
      return pick(RAMP.basalt, light + (v - 0.5) * 0.55, px, py);
    },
    ice: function (n, light, px, py, s) {
      const v = RR.fbm3(n[0] * 2.6, n[1] * 2.6, n[2] * 2.6, s, 4);
      const c = Math.abs(RR.fbm3(n[0] * 4.6 + 7, n[1] * 4.6 + 3, n[2] * 4.6 + 1, s + 9, 3) - 0.5);
      if (c < 0.014) return pick(RAMP.frost, light - 0.3, px, py);
      return pick(v > 0.54 ? RAMP.icy : RAMP.frost, light + 0.1, px, py);
    },
  };

  const PTYPES = (Art.PTYPES = {
    terra: { surf: 'terra', atmo: '#7cc8ff', map: '#3d9be8' },
    desert: { surf: 'desert', atmo: '#ffb27a', map: '#d9743a' },
    gas: { surf: 'gas', ramps: ['cream', 'rust', 'umber', 'sand'], atmo: '#ffe2b0', map: '#ecc88c',
      ring: ['#fff0c8', '#ecc88c', '#c99a5e', '#96643a'] },
    gasBlue: { surf: 'gas', ramps: ['aqua', 'azure', 'indigo', 'snow'], atmo: '#9fe0ff', map: '#3a8ae0',
      ring: ['#d8f4ff', '#98ccf2', '#5c98d6', '#3466a8'] },
    toxic: { surf: 'gas', ramps: ['acid', 'grape', 'indigo', 'cream'], atmo: '#c6ee6a', map: '#7cc23c',
      ring: ['#e6c0ff', '#c878ea', '#9344c4', '#632a96'] },
    moon: { surf: 'moon', ramps: ['rock'], map: '#7a8299' },
    lava: { surf: 'lava', atmo: '#ff7a1a', map: '#c2331c' },
    ice: { surf: 'ice', atmo: '#d8f4ff', map: '#98ccf2' },
  });

  const RING_IN = 1.36, RING_OUT = 1.9, RING_Q = 0.3, RING_TILT = -0.32;
  const RING_BANDS = [1, 0, 0, 1, -1, 2, 1, 0, 2, 3]; // -1 = gap

  const planetCache = {};
  /** spec: { r, type, seed, ring } -> { cv, ext } (ext = centre offset in px). */
  Art.planet = function (spec) {
    const key = spec.type + ':' + spec.r + ':' + spec.seed + ':' + (spec.ring ? 1 : 0);
    if (planetCache[key]) return planetCache[key];

    const T = PTYPES[spec.type], Rr = spec.r, seed = spec.seed | 0;
    const rnd = RR.rng(seed * 7919 + 13);
    const ext = spec.ring ? Math.ceil(Rr * RING_OUT) + 2 : Rr + 5;
    const size = ext * 2 + 1;
    const cv = RR.canvas(size, size);
    const img = cv.g.createImageData(size, size), d = img.data;
    const surf = SURFACE[T.surf];
    const opt = {
      ramps: (T.ramps || []).map(function (k) { return RAMP[k]; }),
      phase: rnd() * TAU, sx: (rnd() - 0.5) * 0.7, sy: (rnd() - 0.5) * 0.8, craters: [],
    };
    if (T.surf === 'moon') {
      const nc = 7 + Math.floor(Rr / 9);
      for (let i = 0; i < nc; i++) {
        const a = rnd() * TAU, m = Math.sqrt(rnd()) * 0.92;
        const cx = Math.cos(a) * m, cy = Math.sin(a) * m, cz = Math.sqrt(Math.max(0, 1 - cx * cx - cy * cy));
        const cr = 0.07 + rnd() * rnd() * 0.3;
        opt.craters.push([cx, cy, cz, cr, Math.cos(cr)]);
      }
      opt.craters.sort(function (p, q) { return p[3] - q[3]; });
    }
    const atmo = T.atmo ? hex(T.atmo) : null;
    const ringCols = spec.ring && T.ring ? T.ring.map(hex) : null;
    const ct = Math.cos(RING_TILT), st = Math.sin(RING_TILT);
    const n = [0, 0, 0];

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = px - ext, dy = py - ext, d2 = dx * dx + dy * dy;
        const i = (py * size + px) * 4;
        let done = false;

        if (ringCols) {
          const ex = dx * ct + dy * st, ey = -dx * st + dy * ct;
          const rr = Math.hypot(ex, ey / RING_Q) / Rr;
          if (rr >= RING_IN && rr <= RING_OUT && (ey > 0 || d2 > Rr * Rr)) {
            const band = RING_BANDS[Math.min(9, Math.floor(((rr - RING_IN) / (RING_OUT - RING_IN)) * 10))];
            if (band >= 0) {
              // far side of the ring sits in shade, near side catches the light
              const shade = band + (ey > 0 ? 0 : 1) + (RR.bayer(px, py) > 0.72 ? 1 : 0);
              put(d, i, ringCols[Math.min(3, shade)]);
              done = true;
            }
          }
        }
        if (done) continue;

        if (d2 <= Rr * Rr) {
          n[0] = dx / Rr; n[1] = dy / Rr; n[2] = Math.sqrt(Math.max(0, 1 - n[0] * n[0] - n[1] * n[1]));
          let light = (n[0] * L3[0] + n[1] * L3[1] + n[2] * L3[2]) * 0.9 + 0.16;
          // darken the limb a touch so the sphere reads as round
          light -= (1 - n[2]) * 0.12;
          put(d, i, surf(n, light, px, py, seed, opt));
        } else if (atmo && d2 <= (Rr + 3) * (Rr + 3)) {
          const dd = Math.sqrt(d2), k = dd - Rr;
          const lit = (dx * L3[0] + dy * L3[1]) / dd;
          const th = (k < 1 ? 0.8 : k < 2 ? 0.5 : 0.24) * RR.clamp(lit * 1.4 + 0.75, 0, 1);
          if (RR.bayer(px, py) < th) put(d, i, atmo, 230);
        }
      }
    }
    cv.g.putImageData(img, 0, 0);
    planetCache[key] = { cv: cv, ext: ext };
    return planetCache[key];
  };

  /* ----------------------------------------------------------- asteroids */

  Art.ROCK_SIZES = [7, 10, 14, 19, 25];

  function makeRock(r, seed, rmp) {
    const rnd = RR.rng(seed), ext = r + 2, size = ext * 2 + 1;
    const cv = RR.canvas(size, size);
    const img = cv.g.createImageData(size, size), d = img.data;
    const k = [rnd() * TAU, rnd() * TAU, rnd() * TAU];
    const edge = function (th) {
      return r * (0.82 + 0.1 * Math.sin(2 * th + k[0]) + 0.06 * Math.sin(3 * th + k[1]) + 0.04 * Math.sin(5 * th + k[2]));
    };
    const craters = [];
    for (let i = 0, nc = 1 + Math.floor(r / 5); i < nc; i++) {
      craters.push([(rnd() - 0.5) * r * 1.1, (rnd() - 0.5) * r * 1.1, 1.4 + rnd() * r * 0.22]);
    }
    const outline = hex('#120f1e');
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = px - ext, dy = py - ext, dd = Math.hypot(dx, dy);
        const e = edge(Math.atan2(dy, dx));
        if (dd > e) continue;
        const t = dd / e, nz = Math.sqrt(1 - t * t * 0.9);
        let l = ((dx / e) * L3[0] + (dy / e) * L3[1] + nz * L3[2]) * 0.85 + 0.2;
        l += (RR.fbm3(px * 0.42, py * 0.42, 0.5, seed, 3) - 0.5) * 0.5;
        for (let c = 0; c < craters.length; c++) {
          const cx = dx - craters[c][0], cy = dy - craters[c][1], cd = Math.hypot(cx, cy);
          if (cd < craters[c][2]) {
            l -= cd > craters[c][2] * 0.55 ? 0.3 * ((cx * L3[0] + cy * L3[1]) / (cd || 1)) : 0.2;
            break;
          }
        }
        put(d, (py * size + px) * 4, dd > e - 1.1 ? outline : pick(rmp, l, px, py, 0.6));
      }
    }
    cv.g.putImageData(img, 0, 0);
    return cv;
  }

  /* -------------------------------------------------------- donut gates */

  Art.DONUT_RC = 44; // radius of the tube centre-line
  Art.DONUT_RT = 11; // tube radius

  function makeDonut(finish) {
    const RC = Art.DONUT_RC, RT = Art.DONUT_RT, ext = RC + RT + 1, size = ext * 2 + 1;
    const cv = RR.canvas(size, size);
    const img = cv.g.createImageData(size, size), d = img.data;
    const outline = hex('#2a1410');
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = px - ext, dy = py - ext, dd = Math.hypot(dx, dy);
        const t = (dd - RC) / RT;
        if (t < -1 || t > 1) continue;
        const th = Math.atan2(dy, dx), ct = Math.cos(th), sn = Math.sin(th);
        const nz = Math.sqrt(1 - t * t);
        const light = (t * ct * L3[0] + t * sn * L3[1] + nz * L3[2]) * 0.8 + 0.26;
        const drip = 0.58 + 0.15 * Math.sin(th * 6 + 0.7) + 0.07 * Math.sin(th * 11 + 2);
        let c;
        if (Math.abs(t) > 0.9) c = outline;
        else if (Math.abs(t - 0.03) < drip) {
          if (finish) {
            const cell = Math.floor(((th + Math.PI) / TAU) * 24) + (t > 0.03 ? 1 : 0);
            c = pick(cell & 1 ? RAMP.chalk : RAMP.coal, light + 0.08, px, py, 0.5);
          } else c = pick(RAMP.icing, light + 0.08, px, py, 0.5);
        } else c = pick(RAMP.dough, light, px, py, 0.6);
        put(d, (py * size + px) * 4, c);
      }
    }
    cv.g.putImageData(img, 0, 0);

    // sprinkles
    if (!finish) {
      const rnd = RR.rng(77), cols = ['#fff275', '#7df9ff', '#b6ff6e', '#ffffff', '#ffa35c', '#b79bff'];
      for (let i = 0; i < 54; i++) {
        const th = (i / 54) * TAU + rnd() * 0.08, t = (rnd() - 0.5) * 0.72;
        const x = Math.round(ext + Math.cos(th) * (RC + t * RT)), y = Math.round(ext + Math.sin(th) * (RC + t * RT));
        const a = rnd() * Math.PI;
        cv.g.fillStyle = cols[i % cols.length];
        for (let k = 0; k < 3; k++) cv.g.fillRect(x + Math.round(Math.cos(a) * k), y + Math.round(Math.sin(a) * k), 1, 1);
      }
    }
    return cv;
  }

  /** Darkened, slightly blue copy used for gates that are not up next. */
  function dim(cv, mul, tint, mix) {
    const out = RR.canvas(cv.width, cv.height);
    out.g.drawImage(cv, 0, 0);
    const img = out.g.getImageData(0, 0, cv.width, cv.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      d[i] = d[i] * mul * (1 - mix) + tint[0] * mix;
      d[i + 1] = d[i + 1] * mul * (1 - mix) + tint[1] * mix;
      d[i + 2] = d[i + 2] * mul * (1 - mix) + tint[2] * mix;
    }
    out.g.putImageData(img, 0, 0);
    return out;
  }

  /* --------------------------------------------------------------- glows */

  const glowCache = {};
  /** Banded, dithered additive glow — draw with globalCompositeOperation 'lighter'. */
  Art.glow = function (r, color) {
    const key = r + color;
    if (glowCache[key]) return glowCache[key];
    const size = r * 2 + 1, cv = RR.canvas(size, size);
    const img = cv.g.createImageData(size, size), d = img.data, c = hex(color);
    const LEVELS = [0, 0.07, 0.14, 0.24, 0.38, 0.55];
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const t = Math.hypot(px - r, py - r) / r;
        if (t >= 1) continue;
        const v = (1 - t) * (1 - t) * 5 + (RR.bayer(px, py) - 0.5) * 0.9;
        const a = LEVELS[RR.clamp(Math.floor(v + 0.5), 0, 5)];
        if (a > 0) put(d, (py * size + px) * 4, c, Math.round(a * 255));
      }
    }
    cv.g.putImageData(img, 0, 0);
    glowCache[key] = cv;
    return cv;
  };

  /* --------------------------------------------------- stars and nebulae */

  function makeStars(size, count, seed, cols, big) {
    const cv = RR.canvas(size, size), g = cv.g, rnd = RR.rng(seed), twinks = [];
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rnd() * size), y = Math.floor(rnd() * size);
      g.fillStyle = cols[Math.floor(rnd() * cols.length)];
      g.fillRect(x, y, 1, 1);
      if (big && rnd() < big && x > 2 && y > 2 && x < size - 3 && y < size - 3) {
        twinks.push([x, y, rnd() * TAU, 1.5 + rnd() * 2.5]);
      }
    }
    cv.twinks = twinks;
    return cv;
  }

  const nebCache = {};
  /** Tileable dithered gas cloud. `cols` = 3 shades for hue A then 3 for hue B. */
  Art.nebula = function (seed, cols) {
    const key = seed + cols.join('');
    if (nebCache[key]) return nebCache[key];
    const S = 512, cv = RR.canvas(S, S);
    const img = cv.g.createImageData(S, S), d = img.data;
    const A = cols.slice(0, 3).map(hex), B = cols.slice(3, 6).map(hex);
    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        const u = (px / S) * 4, v = (py / S) * 4;
        const den = RR.pfbm2(u, v, 4, seed, 5);
        const hue = RR.pfbm2(u + 1.7, v + 9.2, 4, seed + 31, 3);
        const lvl = Math.floor(RR.smooth(0.47, 0.76, den) * 3.6 + (RR.bayer(px, py) - 0.5) * 0.95);
        if (lvl <= 0) continue;
        put(d, (py * S + px) * 4, (hue + (RR.bayer(px + 2, py + 1) - 0.5) * 0.12 > 0.5 ? A : B)[Math.min(2, lvl - 1)]);
      }
    }
    cv.g.putImageData(img, 0, 0);
    nebCache[key] = cv;
    return cv;
  };

  /* ---------------------------------------------------------------- logo */

  /**
   * Title lettering: the 5x7 font drawn double-size, shaded top-to-bottom
   * with `cols` (one colour per glyph row), with an ink outline and a
   * hard drop shadow.
   */
  Art.logo = function (str, cols) {
    const w = str.length * 12 - 2, h = 14;
    const base = RR.canvas(w, h), g = base.g;
    for (let i = 0; i < str.length; i++) {
      const rows = RR.GLYPHS[str[i]];
      if (!rows) continue;
      for (let y = 0; y < 7; y++) {
        g.fillStyle = cols[y];
        for (let x = 0; x < 5; x++) {
          if (rows[y] & (16 >> x)) g.fillRect(i * 12 + x * 2, y * 2, 2, 2);
        }
      }
    }
    const ink = Art.tint(base, PAL.ink), sh = Art.tint(base, '#5b2a86');
    const out = RR.canvas(w + 4, h + 4), og = out.g;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) og.drawImage(ink, 3 + dx, 3 + dy);
    og.drawImage(sh, 3, 3);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) og.drawImage(ink, 1 + dx, 1 + dy);
    og.drawImage(base, 1, 1);
    return out;
  };

  /* ---------------------------------------------------------------- init */

  Art.init = function () {
    Art.icons = {};
    Art.pickups = {};
    Object.keys(ICONS).forEach(function (k) {
      Art.icons[k] = sprite(ICONS[k]);
      const power = k === 'nitro' || k === 'shield' || k === 'repair';
      Art.pickups[k] = k === 'rewind'
        ? pickupSprite(Art.icons[k], '#e6c0ff', '#a855f7', '#1d0f3d')
        : power
          ? pickupSprite(Art.icons[k], '#c8f58a', '#38b764', '#0f2a1c')
          : pickupSprite(Art.icons[k], '#ffb38a', '#e5404f', '#2e1019');
    });

    Art.mine = [
      sprite(ICONS.mine, { R: '#5a1420' }),
      sprite(ICONS.mine, { R: '#ff3b3b' }),
    ];
    Art.missile = sprite([
      '..k..',
      '.kRk.',
      '.kRk.',
      '.kwk.',
      '.kwk.',
      '.kvk.',
      'kkvkk',
      'kRvRk',
      'kkekk',
      '.kdk.',
      '.....',
    ]);
    Art.arrow = sprite([
      '.......kk.......',
      '.......kYk......',
      '.......kYyk.....',
      'kkkkkkkkYyyk....',
      'kYYYYYYYYyyyk...',
      'kYyyyyyyyyyyyk..',
      'kyyyyyyyyyyyyyk.',
      'kyyyyyyyyyyyyk..',
      'koooooooooyyk...',
      'kkkkkkkkoyyk....',
      '.......koyk.....',
      '.......kok......',
      '.......kk.......',
    ]);
    Art.arrowFlash = Art.tint(Art.arrow, PAL.white);
    Art.chevron = sprite([
      'kkk....',
      'kwwk...',
      '.kwwk..',
      '..kwwk.',
      '.kwwk..',
      'kwwk...',
      'kkk....',
    ]);

    const rampsForRocks = [RAMP.stone, RAMP.rock];
    Art.rocks = Art.ROCK_SIZES.map(function (r, ri) {
      const list = [];
      for (let v = 0; v < 4; v++) list.push(makeRock(r, 100 + ri * 10 + v, rampsForRocks[v & 1]));
      return list;
    });

    const full = makeDonut(false), fin = makeDonut(true);
    Art.donut = {
      full: full, dim: dim(full, 0.62, [22, 26, 70], 0.22),
      finFull: fin, finDim: dim(fin, 0.62, [22, 26, 70], 0.22),
      half: (full.width - 1) / 2,
    };

    Art.stars = [
      makeStars(256, 110, 5, ['#23284a', '#2f3560', '#3b4274'], 0),
      makeStars(320, 46, 9, ['#5a648f', '#7884b0', '#7a6cc0', '#4f7a9c'], 0),
      makeStars(400, 26, 14, ['#f4f4f4', '#ffe08a', '#9fe8ff', '#ffc4e2'], 0.4),
    ];
  };
})();
