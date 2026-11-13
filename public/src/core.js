/* ==========================================================================
 * ROCKET RACER — core.js
 * Shared helpers: math, seeded RNG, value noise, palette, pixel primitives
 * and the built-in 5x7 bitmap font. Everything hangs off the global `RR`.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = (window.RR = {});
  const TAU = Math.PI * 2;
  RR.TAU = TAU;

  /* ---------------------------------------------------------------- math */

  RR.clamp = function (v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  };
  RR.lerp = function (a, b, t) {
    return a + (b - a) * t;
  };
  RR.smooth = function (a, b, x) {
    const t = RR.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  /** Signed shortest difference a - b, wrapped to [-PI, PI]. */
  RR.angDiff = function (a, b) {
    let d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    return d;
  };
  /** Small, fast seeded PRNG (mulberry32). Returns a function -> [0, 1). */
  RR.rng = function (seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  RR.fmtTime = function (t) {
    if (!(t >= 0)) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const c = Math.floor((t * 100) % 100);
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + (c < 10 ? '0' : '') + c;
  };

  /* --------------------------------------------------------------- noise */

  function hash(x, y, z, s) {
    let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ Math.imul(s, 0x85ebca6b)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  /** 3D value noise in [0, 1]. */
  RR.noise3 = function (x, y, z, s) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let fx = x - xi, fy = y - yi, fz = z - zi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    fz = fz * fz * (3 - 2 * fz);
    const a = hash(xi, yi, zi, s), b = hash(xi + 1, yi, zi, s);
    const c = hash(xi, yi + 1, zi, s), d = hash(xi + 1, yi + 1, zi, s);
    const e = hash(xi, yi, zi + 1, s), f = hash(xi + 1, yi, zi + 1, s);
    const g = hash(xi, yi + 1, zi + 1, s), h = hash(xi + 1, yi + 1, zi + 1, s);
    const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
    const ef = e + (f - e) * fx, gh = g + (h - g) * fx;
    const lo = ab + (cd - ab) * fy, hi = ef + (gh - ef) * fy;
    return lo + (hi - lo) * fz;
  };

  /** Fractal 3D value noise in [0, 1]. */
  RR.fbm3 = function (x, y, z, s, oct) {
    let amp = 0.5, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * RR.noise3(x, y, z, s + i * 17);
      norm += amp;
      x *= 2.03; y *= 2.03; z *= 2.03;
      amp *= 0.5;
    }
    return sum / norm;
  };

  /** Tileable fractal 2D value noise in [0, 1]; (x, y) repeat every `period`. */
  RR.pfbm2 = function (x, y, period, s, oct) {
    let amp = 0.5, sum = 0, norm = 0, p = period;
    for (let i = 0; i < oct; i++) {
      const xi = Math.floor(x), yi = Math.floor(y);
      let fx = x - xi, fy = y - yi;
      fx = fx * fx * (3 - 2 * fx);
      fy = fy * fy * (3 - 2 * fy);
      const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p;
      const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
      const a = hash(x0, y0, i, s), b = hash(x1, y0, i, s);
      const c = hash(x0, y1, i, s), d = hash(x1, y1, i, s);
      const top = a + (b - a) * fx, bot = c + (d - c) * fx;
      sum += amp * (top + (bot - top) * fy);
      norm += amp;
      x *= 2; y *= 2; p *= 2;
      amp *= 0.5;
    }
    return sum / norm;
  };

  /* 4x4 ordered-dither matrix, returns (0, 1). */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  RR.bayer = function (x, y) {
    return (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16;
  };

  /* ------------------------------------------------------------- palette */

  RR.PAL = {
    void: '#07071a', ink: '#1a1c2c', plum: '#5d275d', red: '#b13e53', orange: '#ef7d57',
    yellow: '#ffcd75', lime: '#a7f070', green: '#38b764', teal: '#257179', navy: '#29366f',
    blue: '#3b5dc9', sky: '#41a6f6', cyan: '#73eff7', white: '#f4f4f4', silver: '#94b0c2',
    steel: '#566c86', slate: '#333c57', pink: '#ff6fb5', hot: '#e43b8f', violet: '#a98bff',
    alarm: '#ff3b3b', gold: '#ffe08a', dusk: '#2a2e44',
  };

  RR.hex = function (h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  };

  /* -------------------------------------------------------------- canvas */

  /** Off-screen canvas with nearest-neighbour sampling; context is at `.g`. */
  RR.canvas = function (w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    c.g = c.getContext('2d');
    c.g.imageSmoothingEnabled = false;
    return c;
  };

  /** One-pixel ring (midpoint circle). `segs` > 0 draws it dashed. */
  RR.ring = function (ctx, cx, cy, r, color, segs, phase) {
    cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
    ctx.fillStyle = color;
    if (r < 1) { ctx.fillRect(cx, cy, 1, 1); return; }
    const k = segs ? segs * 2 : 0, ph = phase || 0;
    const put = function (px, py) {
      if (k && !(Math.floor((Math.atan2(py, px) / TAU + 1) * k + ph) & 1)) return;
      ctx.fillRect(cx + px, cy + py, 1, 1);
    };
    let x = r, y = 0, err = 1 - r;
    while (x >= y) {
      put(x, y); put(y, x); put(-y, x); put(-x, y);
      put(-x, -y); put(-y, -x); put(y, -x); put(x, -y);
      y++;
      if (err < 0) err += 2 * y + 1;
      else { x--; err += 2 * (y - x) + 1; }
    }
  };

  /** Filled pixel disc. */
  RR.disc = function (ctx, cx, cy, r, color) {
    cx = Math.round(cx); cy = Math.round(cy);
    ctx.fillStyle = color;
    if (r < 1) { ctx.fillRect(cx, cy, 1, 1); return; }
    for (let dy = -Math.floor(r); dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      ctx.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
    }
  };

  /**
   * Pixel line (Bresenham). With `dot`, only every `dot`th pixel is drawn
   * (dotted); with `on` as well, `on` pixels in every `dot` are drawn (dashed:
   * dot 7, on 4 gives dashes of 4 with gaps of 3).
   */
  RR.line = function (ctx, x0, y0, x1, y1, color, dot, on) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    ctx.fillStyle = color;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, n = 0;
    for (;;) {
      if (!dot || n % dot < (on || 1)) ctx.fillRect(x0, y0, 1, 1);
      n++;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };

  /** Draw an image rotated about its centre, keeping pixels crisp. */
  RR.drawRot = function (ctx, img, x, y, ang) {
    const w = img.width, h = img.height;
    ctx.setTransform(1, 0, 0, 1, Math.round(x) + (w & 1) * 0.5, Math.round(y) + (h & 1) * 0.5);
    ctx.rotate(ang);
    ctx.drawImage(img, -w / 2, -h / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  /* --------------------------------------------------------- bitmap font */

  // Classic 5x7 glyphs. Each row is 5 bits, most significant bit on the left.
  const GLYPHS = {
    ' ': [0, 0, 0, 0, 0, 0, 0],
    A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
    C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
    E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
    G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
    I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
    K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
    M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
    O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
    Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
    S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
    W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
    Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
    0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], 1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
    2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], 3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
    4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], 5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
    6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], 7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], 9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
    '.': [0, 0, 0, 0, 0, 0x0c, 0x0c], ',': [0, 0, 0, 0, 0x0c, 0x04, 0x08],
    ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0], '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04],
    '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0, 0x04], '-': [0, 0, 0, 0x1f, 0, 0, 0],
    '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0], '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
    "'": [0x04, 0x04, 0x08, 0, 0, 0, 0], '"': [0x0a, 0x0a, 0, 0, 0, 0, 0],
    '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
    '%': [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03], '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
    '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08], '=': [0, 0, 0x1f, 0, 0x1f, 0, 0],
    '*': [0, 0x04, 0x15, 0x0e, 0x15, 0x04, 0], '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
    '_': [0, 0, 0, 0, 0, 0, 0x1f],
  };
  RR.GLYPHS = GLYPHS;
  const CHARS = Object.keys(GLYPHS);
  const INDEX = {};
  CHARS.forEach(function (ch, i) { INDEX[ch] = i; });

  const atlases = {};
  function atlas(color) {
    let a = atlases[color];
    if (a) return a;
    a = RR.canvas(CHARS.length * 6, 7);
    a.g.fillStyle = color;
    CHARS.forEach(function (ch, i) {
      const rows = GLYPHS[ch];
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 5; x++) {
          if (rows[y] & (16 >> x)) a.g.fillRect(i * 6 + x, y, 1, 1);
        }
      }
    });
    atlases[color] = a;
    return a;
  }

  function blit(ctx, a, str, x, y, scale) {
    for (let i = 0; i < str.length; i++) {
      const idx = INDEX[str[i]];
      if (idx === undefined || str[i] === ' ') continue;
      ctx.drawImage(a, idx * 6, 0, 5, 7, x + i * 6 * scale, y, 5 * scale, 7 * scale);
    }
  }

  RR.textW = function (str, scale) {
    return (String(str).length * 6 - 1) * (scale || 1);
  };

  /**
   * Draw pixel text. `align` is 'left' | 'center' | 'right'; `shadow` is an
   * optional colour drawn one (scaled) pixel down-right for legibility.
   */
  RR.text = function (ctx, str, x, y, color, scale, align, shadow) {
    str = String(str).toUpperCase();
    scale = scale || 1;
    const w = RR.textW(str, scale);
    if (align === 'center') x -= w / 2;
    else if (align === 'right') x -= w;
    x = Math.round(x); y = Math.round(y);
    if (shadow) blit(ctx, atlas(shadow), str, x + scale, y + scale, scale);
    blit(ctx, atlas(color), str, x, y, scale);
    return w;
  };
})();
