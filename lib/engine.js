'use strict';

/*
 * The game engine, headless. The multiplayer server runs the very same
 * simulation as the browser (public/src/core.js, records.js, art.js,
 * tracks.js, game.js), so a race online plays by exactly the rules it does offline.
 *
 * Each room gets its own copy in its own V8 context: the engine keeps its
 * world in one object (RR.game), and separate contexts keep rooms apart.
 * The scripts are compiled once and run in each new context.
 *
 * The browser bits are stood in for: canvases draw nothing, there is no
 * sound or keyboard, and the art (planet and nebula pictures, sprites) is
 * never painted - only its numbers (sizes, ship engine ports) are kept.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'public', 'src');
const FILES = ['core.js', 'records.js', 'art.js', 'tracks.js', 'game.js'];
let scripts = null;

function compile() {
  if (!scripts) {
    scripts = FILES.map((f) => new vm.Script(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: 'public/src/' + f }));
  }
  return scripts;
}

/** A 2D context that accepts every call and draws nothing. */
function fakeContext(canvas) {
  const target = {
    canvas,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
  };
  const noop = () => {};
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}

function fakeCanvas() {
  const c = { width: 1, height: 1, style: {} };
  c.getContext = () => c.ctx || (c.ctx = fakeContext(c));
  return c;
}

/** Everything the engine reaches for in a browser, standing in for it. */
function browserStandIns() {
  const el = () => ({ style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {} });
  return {
    document: { createElement: fakeCanvas, getElementById: () => null, documentElement: el(), body: el() },
    navigator: { userAgent: 'node', vibrate() {} },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
    console,
  };
}

/** The bits of the browser game the engine calls that have no meaning on a server. */
function serverModules(RR) {
  RR.audio = { muted: true, init() {}, sfx() {}, music() {}, engine() {}, setMuted() {}, state: () => 'none' };
  RR.input = {
    touchMode: false, typing: false, down: {}, hit: {}, taps: [], touch: {},
    read: () => ({ turn: 0, thrust: 0, brake: 0, fire: false, aim: null, stick: false }),
    buzz() {}, endFrame() {}, updateTouch() {}, pollPad() {},
  };
  RR.net = {
    online: false, boards: {}, me: {}, env: 'server', version: '',
    init() {}, load() {}, submit() {},
    cleanName: (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9 _.!-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10).trim(),
    randomName: () => 'PILOT', randomId: () => 'server',
  };
}

/**
 * A fresh, isolated engine. Returns { RR, G }: G is the world (RR.game);
 * start one with G.startOnline({ server: true, ... }) and advance it with
 * G.step(RR.CFG.STEP).
 */
function createEngine() {
  const sandbox = browserStandIns();
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  const [core, records, art, tracks, game] = compile();
  core.runInContext(ctx);
  const RR = sandbox.RR;
  records.runInContext(ctx);
  art.runInContext(ctx);
  // no pictures on a server: the course builder and the ships get blank canvases
  const Art = RR.Art;
  Art.planet = () => fakeCanvas();
  Art.nebula = () => fakeCanvas();
  Art.ship = () => fakeCanvas();
  Art.shipWhite = () => fakeCanvas();
  Art.tint = () => fakeCanvas();
  Art.rocks = Art.ROCK_SIZES.map(() => [0, 1, 2, 3].map(fakeCanvas));
  serverModules(RR);
  tracks.runInContext(ctx);
  game.runInContext(ctx);
  return { RR, G: RR.game };
}

module.exports = { createEngine };
