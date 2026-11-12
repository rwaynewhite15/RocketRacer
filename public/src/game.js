/* ==========================================================================
 * ROCKET RACER — game.js
 * Simulation: ship physics, gravity, collisions, checkpoints and laps,
 * pickups, weapons, rival AI, particles, camera and the game-state machine.
 * Rendering lives in render.js.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR, Art = RR.Art, PAL = RR.PAL, TAU = RR.TAU;
  const clamp = RR.clamp, angDiff = RR.angDiff;

  /* Tuning. Distances are in virtual pixels, times in seconds. */
  const C = (RR.CFG = {
    STEP: 1 / 120,
    THRUST: 430, DRAG: 1.35, GRIP: 3.2, TURN: 3.7, REVERSE: 0.6,
    SHIP_R: 8, MAXHP: 100,
    NITRO_TIME: 2.6, NITRO_MULT: 1.55, SHIELD_TIME: 7,
    CP_R: 44, PICK_R: 18, PICK_RESPAWN: 5,
    BOLT_SPEED: 640, BOLT_LIFE: 0.85, BOLT_DMG: 11,
    MISSILE_SPEED: 560, MISSILE_TURN: 3.4, MISSILE_LIFE: 4.5, MISSILE_DMG: 34,
    MINE_DMG: 30, MINE_LIFE: 45,
    EMP_RANGE: 240, EMP_TIME: 2.4,
    // do-over: the ship is sampled HIST_DT apart and the last REWIND_SPAN seconds are kept
    REWIND_SPAN: 3, HIST_DT: 0.05, REWIND_DUR: 0.9, REWIND_MIN: 0.5, REWIND_INVULN: 2,
  });

  const ITEMS = (RR.ITEMS = {
    nitro: { name: 'NITRO', color: PAL.yellow },
    shield: { name: 'SHIELD', color: PAL.cyan },
    repair: { name: 'REPAIR', color: PAL.lime },
    blaster: { name: 'BLASTER', color: PAL.cyan, ammo: 10 },
    missile: { name: 'MISSILE', color: PAL.orange, ammo: 2 },
    mine: { name: 'MINE', color: PAL.alarm, ammo: 3 },
    emp: { name: 'EMP', color: PAL.violet, ammo: 1 },
    rewind: { name: 'DO-OVER', color: PAL.violet },
  });
  const ROLL = {
    P: [['nitro', 38], ['shield', 26], ['repair', 22], ['rewind', 14]],
    W: [['blaster', 35], ['missile', 30], ['mine', 20], ['emp', 15]],
  };

  const RACERS = [
    { name: 'YOU', team: 0, design: 0 },
    { name: 'NOVA', team: 1, design: 1 },
    { name: 'BLITZ', team: 2, design: 2 },
    { name: 'COMET', team: 3, design: 0 },
    { name: 'VEGA', team: 4, design: 1 },
    { name: 'ORION', team: 5, design: 2 },
  ];

  const DIFFS = (RR.DIFFS = [
    { name: 'ROOKIE', speed: 0.83, spread: 0.05, aggro: 0.45, rubber: 0.07 },
    { name: 'PILOT', speed: 0.92, spread: 0.05, aggro: 1.0, rubber: 0.05 },
    { name: 'ACE', speed: 1.0, spread: 0.04, aggro: 1.6, rubber: 0.02 },
  ]);
  const DEMO_DIFF = { name: 'DEMO', speed: 0.95, spread: 0.06, aggro: 1.2, rubber: 0 };

  const FX = (RR.FX = {
    fire: ['#ffffff', '#fff1a8', '#ffcd75', '#ef7d57', '#b13e53', '#5d275d'],
    nitro: ['#ffffff', '#c8f6ff', '#73eff7', '#41a6f6', '#3b5dc9', '#29366f'],
    smoke: ['#94b0c2', '#566c86', '#333c57', '#1a1c2c'],
    spark: ['#ffffff', '#fff1a8', '#ffcd75', '#ef7d57'],
    rock: ['#c0a48e', '#927468', '#6a5150', '#42323d'],
    ion: ['#ffffff', '#e6c0ff', '#a98bff', '#5b21b6'],
    shield: ['#ffffff', '#73eff7', '#41a6f6', '#29366f'],
    confetti: [['#fff275'], ['#7df9ff'], ['#b6ff6e'], ['#ffffff'], ['#ff8fc6'], ['#b79bff']],
  });

  const G = (RR.game = {
    W: 640, H: 360, t: 0, acc: 0,
    state: 'title', // title | play | paused | results
    phase: 'race', // countdown | race
    demo: true, trackIdx: 0, diffIdx: 1, menuRow: 0,
    ships: [], order: [], rocks: [], pickups: [], shots: [], mines: [], waves: [],
    parts: [], rings: [], texts: [],
    cam: { x: 0, y: 0 }, shake: 0, flash: 0, msg: null, ui: [],
    best: {}, crt: true, newRecord: false,
    name: '', pid: '', // pilot name + anonymous id for the online leaderboard
    inset: { l: 0, t: 0, r: 0, b: 0 }, // notch / rounded-corner margins, in game pixels
    // The world layer can zoom; the HUD layer (W x H) keeps its pixel size.
    vw: 640, vh: 360, // size of the world view in world pixels
    baseScale: 2, zoomOffset: 0, zoomScale: 1, toast: null,
  });

  /* ------------------------------------------------------- persistence */

  const STORE = 'rocketracer.v1';
  function load() {
    try {
      const s = JSON.parse(window.localStorage.getItem(STORE) || '{}');
      G.best = s.best || {};
      G.crt = s.crt !== false;
      RR.audio.muted = !!s.muted;
      if (s.diff >= 0 && s.diff < DIFFS.length) G.diffIdx = s.diff;
      if (s.track >= 0 && s.track < RR.TRACKS.length) G.trackIdx = s.track;
      if (Number.isInteger(s.zoom) && Math.abs(s.zoom) <= 2) G.zoomOffset = s.zoom;
      G.name = RR.net.cleanName(s.name);
      if (typeof s.pid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s.pid)) G.pid = s.pid;
    } catch (e) { /* storage unavailable: play without saved records */ }
    if (!G.name) G.name = RR.net.randomName();
    if (!G.pid) G.pid = RR.net.randomId();
  }
  function save() {
    try {
      window.localStorage.setItem(STORE, JSON.stringify({
        best: G.best, crt: G.crt, muted: RR.audio.muted, diff: G.diffIdx, track: G.trackIdx,
        name: G.name, pid: G.pid, zoom: G.zoomOffset,
      }));
    } catch (e) { /* ignore */ }
  }
  G.save = save;

  function applyCrt() {
    document.body.classList.toggle('nocrt', !G.crt);
  }

  /* ------------------------------------------------------------- set-up */

  function makeAI(diff) {
    return {
      skill: diff.speed + (Math.random() * 2 - 1) * diff.spread,
      aggro: diff.aggro, rubber: diff.rubber, margin: Math.random() * 14,
      ox: 0, oy: 0, cpFor: -1, pick: null, pickT: 0,
      stuck: 0, stuckN: 0, rev: 0, revTurn: 1, fireT: 1.5 + Math.random() * 2,
    };
  }

  function makeShip(i, racer, slot) {
    return {
      idx: i, name: racer.name, team: racer.team, design: racer.design,
      sprite: Art.ship(racer.design, racer.team), white: Art.shipWhite(racer.design),
      ghost: Art.tint(Art.ship(racer.design, racer.team), '#a98bff'),
      ports: Art.shipPorts(racer.design), colors: Art.TEAMS[racer.team],
      x: slot.x, y: slot.y, vx: 0, vy: 0, angle: slot.a, angVel: 0,
      spawn: { x: slot.x, y: slot.y, a: slot.a },
      hp: C.MAXHP, shield: 0, nitro: 0, stun: 0, spinRate: 0, emp: 0, invuln: 0, dead: 0,
      weapon: null, ammo: 0, cool: 0, prevFire: false,
      nextCp: 0, cpCount: 0, lap: 0, lapStart: 0, lapTimes: [], bestLap: 0,
      finished: false, finishTime: 0, place: i + 1, progress: 0,
      input: { turn: 0, thrust: 0, brake: 0, fire: false },
      ai: null, speedMult: 1, thrusting: 0, exh: 0, smk: 0, hitFlash: 0, out: false, wrong: 0,
      rewind: 0, rw: null, hist: [], histT: 0, // do-over charge, rewind in progress, state history
    };
  }

  function makeRock(def) {
    const cr = def.r * 0.86;
    const a = {
      x: def.x, y: def.y, hx: def.x, hy: def.y, vx: 0, vy: 0, r: def.r, cr: cr,
      mass: (cr / 8) * (cr / 8), maxHp: def.size < 1 ? 1 : def.size < 3 ? 2 : 4, hp: 0,
      sprite: Art.rocks[def.size][def.variant], rot: Math.random() * TAU, rs: (Math.random() - 0.5) * 1.4,
      dead: false, respawn: 0, orbit: null,
      wf: 0.2 + Math.random() * 0.3, wp: Math.random() * TAU, wr: 4 + Math.random() * 10,
    };
    a.hp = a.maxHp;
    if (def.orbit) {
      a.orbit = { p: def.orbit.p, d: def.orbit.d, a: def.orbit.a, s: def.orbit.s };
      a.x = a.orbit.p.x + Math.cos(a.orbit.a) * a.orbit.d;
      a.y = a.orbit.p.y + Math.sin(a.orbit.a) * a.orbit.d;
    }
    return a;
  }

  function roll(kind) {
    const table = ROLL[kind];
    let total = 0, i;
    for (i = 0; i < table.length; i++) total += table[i][1];
    let r = Math.random() * total;
    for (i = 0; i < table.length; i++) {
      r -= table[i][1];
      if (r <= 0) return table[i][0];
    }
    return table[0][0];
  }

  G.init = function () {
    load();
    save();
    applyCrt();
    Art.init();
    RR.net.init();
    RR.audio.music({ on: true, tempo: 0.9, lead: true });
    G.startRace(true);
  };

  /** Reset the world. `demo` runs an all-AI race behind the title screen. */
  G.startRace = function (demo) {
    const g = this;
    const tr = (g.track = RR.getTrack(g.trackIdx));
    const diff = DIFFS[g.diffIdx];
    g.demo = demo;
    g.laps = demo ? 1e9 : tr.laps;
    g.ships = RACERS.map(function (r, i) {
      const s = makeShip(i, r, tr.grid[i === 0 ? 5 : i - 1]); // the player starts at the back
      if (demo || i > 0) s.ai = makeAI(demo ? DEMO_DIFF : diff);
      return s;
    });
    g.player = g.ships[0];
    g.order = g.ships.slice();
    g.rocks = tr.rocks.map(makeRock);
    g.pickups = tr.pickups.map(function (p, i) {
      return { x: p.x, y: p.y, kind: p.kind, type: roll(p.kind), on: true, timer: 0, ph: i * 1.7 };
    });
    g.shots = []; g.mines = []; g.waves = []; g.parts = []; g.rings = []; g.texts = [];
    g.raceTime = 0;
    g.phase = demo ? 'race' : 'countdown';
    g.count = 3.9;
    g.cam.x = g.player.x; g.cam.y = g.player.y;
    g.shake = 0; g.flash = 0; g.msg = null;
    g.playerDone = false; g.doneT = 0; g.newRecord = false;
    g.state = demo ? 'title' : 'play';
  };

  G.begin = function () {
    RR.audio.sfx('confirm');
    RR.audio.music({ on: true, tempo: 1, lead: true, restart: true });
    this.startRace(false);
    save();
  };
  G.toTitle = function () {
    RR.audio.music({ on: true, tempo: 0.9, lead: true });
    this.startRace(true);
  };
  /** World top-10 for the selected course (only when the backend is reachable). */
  G.showBoard = function () {
    if (this.state !== 'title' || !RR.net.online) return;
    RR.net.load(RR.TRACKS[this.trackIdx].id);
    RR.audio.sfx('select');
    this.state = 'board';
  };
  G.closeBoard = function () {
    if (this.state === 'board') { this.state = 'title'; RR.audio.sfx('select'); }
  };
  G.fullscreen = function () {
    const d = document, el = d.documentElement;
    try {
      let r;
      if (d.fullscreenElement || d.webkitFullscreenElement) r = (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else {
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) r = req.call(el);
      }
      if (r && r.catch) r.catch(function () { /* refused, e.g. inside a frame */ });
    } catch (e) { /* fullscreen not available here */ }
  };

  /* Pilot name: a real HTML text field, so phones bring up their keyboard. */
  G.editName = function () {
    const box = document.getElementById('namebox'), field = document.getElementById('pilot');
    if (!box || !field || this.state !== 'title') return;
    field.value = this.name;
    box.hidden = false;
    RR.input.typing = true;
    RR.input.down = {};
    field.focus();
    field.select();
  };
  G.closeName = function (keep) {
    const box = document.getElementById('namebox'), field = document.getElementById('pilot');
    if (!box || box.hidden) return;
    if (keep) {
      const n = RR.net.cleanName(field.value);
      if (n) { this.name = n; save(); RR.audio.sfx('confirm'); }
    }
    field.blur();
    box.hidden = true;
    RR.input.typing = false;
  };
  G.pause = function () {
    if (this.state !== 'play') return;
    this.state = 'paused';
    RR.audio.music({ on: false });
    RR.audio.sfx('select');
  };
  G.resume = function () {
    if (this.state !== 'paused') return;
    this.state = 'play';
    RR.audio.music({ on: true });
  };
  G.setTrack = function (d) {
    const n = RR.TRACKS.length;
    this.trackIdx = (this.trackIdx + d + n) % n;
    RR.audio.sfx('select');
    this.startRace(true);
    save();
  };
  G.setDiff = function (d) {
    this.diffIdx = (this.diffIdx + d + DIFFS.length) % DIFFS.length;
    RR.audio.sfx('select');
    save();
  };

  /* ------------------------------------------------------------ effects */

  function near(g, x, y, pad) {
    pad = pad || 70;
    return Math.abs(x - g.cam.x) < g.vw / 2 + pad && Math.abs(y - g.cam.y) < g.vh / 2 + pad;
  }

  /** Positional sound: fades with distance from the camera; silent in demo. */
  function snd(g, name, x, y, v) {
    if (g.demo) return;
    let vol = v === undefined ? 1 : v;
    if (x !== undefined) vol *= clamp(1.2 - Math.hypot(x - g.cam.x, y - g.cam.y) / 460, 0, 1);
    if (vol > 0.03) RR.audio.sfx(name, vol);
  }

  function part(g, x, y, vx, vy, life, size, ramp, drag, layer) {
    if (g.parts.length > 1500) return;
    g.parts.push({ x: x, y: y, vx: vx, vy: vy, life: life, max: life, size: size, ramp: ramp, drag: drag || 0, layer: layer || 0 });
  }

  function burst(g, x, y, n, speed, ramp, life, size) {
    if (!near(g, x, y, 120)) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, v = speed * (0.25 + Math.random() * 0.75);
      // size 0 = start chunky and shrink with age (see drawParts)
      part(g, x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.5 + Math.random() * 0.5),
        size === undefined ? (Math.random() < 0.35 ? 2 : 1) : size, ramp, 2.5, 1);
    }
  }

  function ringFx(g, x, y, r0, r1, dur, color) {
    g.rings.push({ x: x, y: y, r0: r0, r1: r1, t: 0, dur: dur, color: color });
  }

  function boom(g, x, y, k) {
    burst(g, x, y, Math.round(30 * k), 210 * k, FX.fire, 0.75, 0);
    burst(g, x, y, Math.round(10 * k), 70 * k, FX.smoke, 1.1, 3);
    ringFx(g, x, y, 4, 36 * k, 0.32, PAL.white);
    ringFx(g, x, y, 2, 24 * k, 0.4, PAL.yellow);
    snd(g, 'boom', x, y, Math.min(1, 0.6 + k * 0.3));
    if (!g.demo) {
      const d = Math.hypot(x - g.cam.x, y - g.cam.y);
      g.shake = Math.max(g.shake, clamp(9 * k * (1 - d / 380), 0, 12));
    }
  }

  function banner(g, text, color, dur, scale) {
    g.msg = { text: text, color: color, dur: dur, scale: scale, t: 0 };
  }

  function floatText(g, x, y, text, color) {
    g.texts.push({ x: x, y: y, text: text, color: color, t: 0, dur: 1 });
  }

  /* ----------------------------------------------------- damage + death */

  function hurt(s, g, dmg) {
    if (s.dead > 0 || s.invuln > 0 || s.shield > 0) return;
    s.hp -= dmg;
    s.hitFlash = 0.12;
    if (s.hp <= 0) destroy(s, g);
  }

  /** A weapon hit: impulse, optional spin-out, damage. Shields soak it up. */
  function zap(s, g, dmg, stun, ix, iy) {
    if (s.dead > 0 || s.invuln > 0) return;
    if (s.shield > 0) {
      s.shield = Math.max(0.05, s.shield - 1.5);
      burst(g, s.x, s.y, 10, 120, FX.shield, 0.4);
      ringFx(g, s.x, s.y, 12, 22, 0.2, PAL.cyan);
      snd(g, 'shield', s.x, s.y, 0.7);
      return;
    }
    s.vx += ix; s.vy += iy;
    if (stun > 0) {
      // spin a whole number of turns so the ship ends up facing where it was
      if (s.stun <= 0) s.spinRate = (Math.random() < 0.5 ? -1 : 1) * TAU * 2 / stun;
      s.stun = Math.max(s.stun, stun);
    } else {
      s.vx *= 0.86; s.vy *= 0.86;
      s.angle += (Math.random() - 0.5) * 0.35;
    }
    if (s === g.player && !g.demo) { g.shake = Math.max(g.shake, 5); RR.input.buzz(40); }
    hurt(s, g, dmg);
  }

  function destroy(s, g) {
    boom(g, s.x, s.y, 1.6);
    s.hp = 0; s.dead = 2; s.vx = s.vy = 0;
    s.weapon = null; s.ammo = 0; s.nitro = 0; s.shield = 0; s.stun = 0; s.emp = 0; s.thrusting = 0;
    if (s === g.player && !g.demo && !g.playerDone) {
      g.shake = 12; g.flash = 0.6;
      banner(g, 'WRECKED!', PAL.alarm, 1.5, 3);
      RR.input.buzz(160);
    }
  }

  function respawn(s, g) {
    const cps = g.track.cps, N = cps.length;
    if (s.cpCount > 0) {
      const c = cps[(s.nextCp + N - 1) % N], n = cps[s.nextCp];
      s.x = c.x; s.y = c.y; s.angle = Math.atan2(n.y - c.y, n.x - c.x);
    } else {
      s.x = s.spawn.x; s.y = s.spawn.y; s.angle = s.spawn.a;
    }
    s.vx = s.vy = 0; s.angVel = 0; s.dead = 0; s.hp = C.MAXHP; s.invuln = 2.5;
    s.hist.length = 0; s.histT = 0;
    if (s.ai) { s.ai.stuck = 0; s.ai.stuckN = 0; s.ai.rev = 0; }
    ringFx(g, s.x, s.y, 30, 6, 0.3, PAL.cyan);
  }

  /* ------------------------------------------------------------- do-over */

  /** Sample the player's state every HIST_DT; only the last REWIND_SPAN seconds are kept. */
  function recordHistory(s, dt) {
    s.histT += dt;
    if (s.histT < C.HIST_DT - 1e-6) return;
    s.histT -= C.HIST_DT;
    const h = s.hist;
    h.push({
      x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angVel: s.angVel, hp: s.hp,
      nextCp: s.nextCp, cpCount: s.cpCount, lap: s.lap, lapStart: s.lapStart,
      nLaps: s.lapTimes.length, bestLap: s.bestLap,
    });
    if (h.length > Math.round(C.REWIND_SPAN / C.HIST_DT) + 1) h.shift();
  }

  /** Position and heading at a fractional index along a list of samples. */
  function pathAt(pts, f) {
    const n = pts.length, i = clamp(Math.floor(f), 0, n - 2), a = clamp(f - i, 0, 1);
    const P = pts[i], Q = pts[i + 1];
    return { x: P.x + (Q.x - P.x) * a, y: P.y + (Q.y - P.y) * a, angle: P.angle + angDiff(Q.angle, P.angle) * a };
  }
  RR.pathAt = pathAt;

  /**
   * Spend the do-over: the ship becomes a ghost that retraces its recorded
   * path backwards, then picks up flying from where it was 3 seconds ago.
   * The race clock and everyone else keep going, so it costs real time.
   */
  G.tryRewind = function () {
    const g = this, p = g.player;
    if (g.demo || g.state !== 'play' || g.phase !== 'race' || g.playerDone || p.rw || p.rewind <= 0) return;
    if (p.hist.length < Math.round(C.REWIND_MIN / C.HIST_DT) + 1) {
      floatText(g, p.x, p.y - 16, 'TOO SOON', PAL.silver);
      RR.audio.sfx('deny');
      return;
    }
    p.rewind = 0;
    const pts = p.hist.slice();
    pts.push({ x: p.x, y: p.y, angle: p.angle }); // the way back starts from where we are now
    p.rw = {
      t: 0, dur: C.REWIND_DUR, pts: pts, tgt: p.hist[0], u: 0, f: pts.length - 1,
      span: (p.hist.length - 1) * C.HIST_DT, hpWas: p.dead > 0 ? 0 : p.hp,
    };
    // `dead` makes every other system (collisions, pickups, gates, weapons) ignore the ghost
    p.dead = 1e9; p.vx = p.vy = 0; p.angVel = 0; p.thrusting = 0;
    g.flash = 0.3; g.msg = null;
    ringFx(g, p.x, p.y, 8, 40, 0.35, PAL.violet);
    RR.audio.sfx('rewind');
    RR.audio.music({ tempo: 0.5 });
    RR.input.buzz(60);
  };

  function stepRewind(s, g, dt) {
    const r = s.rw;
    r.t += dt;
    const k = clamp(r.t / r.dur, 0, 1);
    r.u = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease in and out: how far back, 0..1
    r.f = (1 - r.u) * (r.pts.length - 1);
    const at = pathAt(r.pts, r.f);
    s.x = at.x; s.y = at.y; s.angle = at.angle;
    if (Math.random() < 0.7) {
      part(g, s.x + (Math.random() - 0.5) * 8, s.y + (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, 0.35 + Math.random() * 0.3, 2, FX.ion, 1, 0);
    }
    if (k >= 1) finishRewind(s, g);
  }

  function finishRewind(s, g) {
    const r = s.rw, t = r.tgt;
    s.rw = null;
    s.x = t.x; s.y = t.y; s.vx = t.vx; s.vy = t.vy; s.angle = t.angle; s.angVel = t.angVel;
    s.hp = Math.max(t.hp, r.hpWas); // undo the damage, but never lose a repair picked up since
    s.nextCp = t.nextCp; s.cpCount = t.cpCount; s.lap = t.lap; s.lapStart = t.lapStart;
    s.lapTimes.length = t.nLaps; s.bestLap = t.bestLap; // gates and laps passed in the meantime don't count
    s.dead = 0; s.stun = 0; s.emp = 0; s.invuln = C.REWIND_INVULN;
    s.hist.length = 0; s.histT = 0;
    g.cam.x = s.x; g.cam.y = s.y;
    g.flash = 0.4;
    burst(g, s.x, s.y, 22, 160, FX.ion, 0.6);
    ringFx(g, s.x, s.y, 30, 6, 0.3, PAL.cyan);
    ringFx(g, s.x, s.y, 4, 34, 0.4, PAL.violet);
    banner(g, 'DO-OVER!', PAL.violet, 1.1, 4);
    RR.audio.sfx('rewound');
    RR.audio.music({ tempo: s.lap >= g.laps ? 1.12 : 1 });
    RR.input.buzz(40);
  }

  /* --------------------------------------------------------------- zoom */

  /**
   * The world is drawn at a whole-number pixel scale, so zoom steps are
   * whole-number changes from the base scale. Offsets are only offered while
   * the view stays between half and double the normal size.
   */
  G.zoomLevels = function () {
    const base = this.baseScale || 2, out = [];
    for (let d = -2; d <= 2; d++) {
      const sc = base + d, ratio = sc / base;
      if (sc >= 1 && ratio >= 0.5 && ratio <= 2) out.push(d);
    }
    return out;
  };
  /** The zoom offset actually in effect (the saved one, clamped to what this screen allows). */
  G.zoomEff = function () {
    let best = 0, bd = 1e9;
    for (const d of this.zoomLevels()) {
      const x = Math.abs(d - this.zoomOffset);
      if (x < bd) { bd = x; best = d; }
    }
    return best;
  };
  function toast(g, text) { g.toast = { text: text, t: 0, dur: 1.3 }; }
  G.setZoom = function (off) {
    if (off === this.zoomEff()) return false;
    this.zoomOffset = off;
    RR.resize();
    toast(this, 'ZOOM ' + +this.zoomScale.toFixed(2) + 'X');
    RR.audio.sfx('select');
    save();
    return true;
  };
  /** +1 = closer, -1 = wider. */
  G.zoomBy = function (d) {
    const lv = this.zoomLevels(), i = lv.indexOf(this.zoomEff()), j = clamp(i + d, 0, lv.length - 1);
    if (j !== i) this.setZoom(lv[j]);
    else toast(this, d > 0 ? 'MAX ZOOM' : 'WIDEST VIEW');
  };
  /** One-button zoom (Z key, touch button): normal -> wide -> close -> normal. */
  G.zoomCycle = function () {
    const ok = this.zoomLevels(), order = [0, -1, 1].filter(function (d) { return ok.indexOf(d) >= 0; });
    const i = order.indexOf(this.zoomEff());
    if (order.length > 1) this.setZoom(order[(i + 1) % order.length]);
  };

  /* ------------------------------------------------------------- weapons */

  function pickTarget(s, g) {
    const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
    let best = null, score = 1e9;
    for (const o of g.ships) {
      if (o === s || o.dead > 0) continue;
      const dx = o.x - s.x, dy = o.y - s.y, d = Math.hypot(dx, dy) || 1;
      if (d > 760) continue;
      const off = Math.acos(clamp((dx * ca + dy * sa) / d, -1, 1));
      if (off > 1.05) continue;
      const sc = d * (1 + off * 1.6);
      if (sc < score) { score = sc; best = o; }
    }
    return best;
  }

  function tryFire(s, g) {
    const fire = s.input.fire, edge = fire && !s.prevFire;
    s.prevFire = fire;
    if (!fire || !s.weapon || s.cool > 0 || s.dead > 0 || s.stun > 0 || s.emp > 0) return;
    const w = s.weapon;
    if (w !== 'blaster' && !edge) return;
    const ca = Math.cos(s.angle), sa = Math.sin(s.angle);

    if (w === 'blaster') {
      g.shots.push({
        type: 'bolt', owner: s, x: s.x + ca * 12, y: s.y + sa * 12,
        vx: ca * C.BOLT_SPEED + s.vx * 0.5, vy: sa * C.BOLT_SPEED + s.vy * 0.5,
        life: C.BOLT_LIFE, color: s.colors.i,
      });
      s.cool = 0.13;
      snd(g, 'laser', s.x, s.y, 0.8);
    } else if (w === 'missile') {
      g.shots.push({
        type: 'missile', owner: s, x: s.x + ca * 12, y: s.y + sa * 12, vx: 0, vy: 0,
        angle: s.angle, speed: Math.max(220, s.vx * ca + s.vy * sa + 110),
        life: C.MISSILE_LIFE, target: pickTarget(s, g), smk: 0,
      });
      s.cool = 0.45;
      snd(g, 'missile', s.x, s.y);
    } else if (w === 'mine') {
      g.mines.push({ owner: s, x: s.x - ca * 16, y: s.y - sa * 16, vx: s.vx * 0.25, vy: s.vy * 0.25, t: 0, ph: Math.random() });
      s.cool = 0.35;
      snd(g, 'mine', s.x, s.y);
    } else if (w === 'emp') {
      g.waves.push({ owner: s, x: s.x, y: s.y, r: 8, hit: [] });
      s.cool = 0.5;
      snd(g, 'emp', s.x, s.y);
      if (s === g.player && !g.demo) g.flash = 0.35;
    }
    if (--s.ammo <= 0) { s.weapon = null; s.ammo = 0; }
  }

  function damageRock(g, a, dmg) {
    if (a.dead) return;
    a.hp -= dmg;
    if (a.hp > 0) { burst(g, a.x, a.y, 5, 90, FX.rock, 0.4); return; }
    a.dead = true;
    a.respawn = 14 + Math.random() * 8;
    burst(g, a.x, a.y, 8 + a.r, 150, FX.rock, 0.8);
    burst(g, a.x, a.y, 6, 60, FX.smoke, 0.8, 2);
    ringFx(g, a.x, a.y, 3, a.r + 8, 0.25, '#c0a48e');
    snd(g, 'rock', a.x, a.y);
  }

  /** Area blast: hurts and spins out ships, shatters asteroids. */
  function explode(g, x, y, rad, dmg, stun, owner, hurtOwner) {
    for (const s of g.ships) {
      if (s.dead > 0 || (s === owner && !hurtOwner)) continue;
      const dx = s.x - x, dy = s.y - y, d = Math.hypot(dx, dy), reach = rad + C.SHIP_R;
      if (d < reach) {
        const k = 1 - 0.5 * (d / reach), m = d || 1;
        zap(s, g, dmg * k, stun, (dx / m) * 170 * k, (dy / m) * 170 * k);
      }
    }
    for (const a of g.rocks) {
      if (!a.dead && Math.hypot(a.x - x, a.y - y) < rad + a.cr) damageRock(g, a, 3);
    }
    boom(g, x, y, 1);
  }

  function updateShots(g, dt) {
    const shots = g.shots, planets = g.track.planets;
    for (let i = shots.length - 1; i >= 0; i--) {
      const b = shots[i];
      b.life -= dt;
      let dead = b.life <= 0, hitShip = null, hitRock = null;

      if (b.type === 'missile') {
        if (b.target && b.target.dead > 0) b.target = null;
        if (b.target) {
          const want = Math.atan2(b.target.y - b.y, b.target.x - b.x);
          b.angle += clamp(angDiff(want, b.angle), -C.MISSILE_TURN * dt, C.MISSILE_TURN * dt);
        }
        b.speed = Math.min(C.MISSILE_SPEED, b.speed + 700 * dt);
        b.vx = Math.cos(b.angle) * b.speed; b.vy = Math.sin(b.angle) * b.speed;
        b.smk += dt * 70;
        if (near(g, b.x, b.y)) {
          while (b.smk >= 1) {
            b.smk -= 1;
            part(g, b.x - Math.cos(b.angle) * 6, b.y - Math.sin(b.angle) * 6,
              (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, 0.3 + Math.random() * 0.3, 2, Math.random() < 0.5 ? FX.fire : FX.smoke, 1, 0);
          }
        } else b.smk = 0;
      }
      b.x += b.vx * dt; b.y += b.vy * dt;

      if (!dead) {
        for (const p of planets) {
          const dx = b.x - p.x, dy = b.y - p.y;
          if (dx * dx + dy * dy < p.r * p.r) { dead = true; break; }
        }
      }
      if (!dead) {
        for (const a of g.rocks) {
          if (a.dead) continue;
          const dx = b.x - a.x, dy = b.y - a.y, rr = a.cr + 3;
          if (dx * dx + dy * dy < rr * rr) { dead = true; hitRock = a; break; }
        }
      }
      if (!dead) {
        for (const s of g.ships) {
          if (s === b.owner || s.dead > 0) continue;
          const dx = b.x - s.x, dy = b.y - s.y, rr = C.SHIP_R + 4;
          if (dx * dx + dy * dy < rr * rr) { dead = true; hitShip = s; break; }
        }
      }
      if (!dead && b.type === 'bolt') {
        for (let m = g.mines.length - 1; m >= 0; m--) {
          const mn = g.mines[m];
          if (Math.hypot(b.x - mn.x, b.y - mn.y) < 9) {
            g.mines.splice(m, 1);
            explode(g, mn.x, mn.y, 48, C.MINE_DMG, 1, mn.owner, true);
            dead = true;
            break;
          }
        }
      }
      if (!dead) continue;

      shots.splice(i, 1);
      if (b.type === 'missile') {
        explode(g, b.x, b.y, 44, C.MISSILE_DMG, 1.1, b.owner, false);
      } else if (b.life > 0) {
        if (hitShip) { zap(hitShip, g, C.BOLT_DMG, 0, b.vx * 0.1, b.vy * 0.1); snd(g, 'hit', b.x, b.y); }
        else if (hitRock) damageRock(g, hitRock, 1);
        burst(g, b.x, b.y, 6, 110, FX.spark, 0.3);
      }
    }
  }

  function updateMines(g, dt) {
    const k = Math.exp(-3 * dt);
    for (let i = g.mines.length - 1; i >= 0; i--) {
      const m = g.mines[i];
      m.t += dt;
      m.x += m.vx * dt; m.y += m.vy * dt;
      m.vx *= k; m.vy *= k;
      let trip = m.t > C.MINE_LIFE;
      if (!trip && m.t > 0.6) {
        for (const s of g.ships) {
          if (s.dead > 0 || (s === m.owner && m.t < 1.6)) continue;
          if (Math.hypot(s.x - m.x, s.y - m.y) < 20) { trip = true; break; }
        }
      }
      if (trip) {
        g.mines.splice(i, 1);
        explode(g, m.x, m.y, 48, C.MINE_DMG, 1, m.owner, true);
      }
    }
  }

  function updateWaves(g, dt) {
    for (let i = g.waves.length - 1; i >= 0; i--) {
      const w = g.waves[i];
      w.r += 520 * dt;
      for (const s of g.ships) {
        if (s === w.owner || s.dead > 0 || w.hit.indexOf(s) >= 0) continue;
        if (Math.hypot(s.x - w.x, s.y - w.y) > w.r) continue;
        w.hit.push(s);
        if (s.invuln > 0) continue;
        if (s.shield > 0) {
          s.shield = Math.max(0.05, s.shield - 1.5);
          ringFx(g, s.x, s.y, 12, 22, 0.2, PAL.cyan);
          continue;
        }
        s.emp = C.EMP_TIME;
        s.vx *= 0.55; s.vy *= 0.55;
        burst(g, s.x, s.y, 14, 130, FX.ion, 0.5);
        snd(g, 'zap', s.x, s.y);
        if (s === g.player && !g.demo) { g.shake = Math.max(g.shake, 6); banner(g, 'ENGINES DOWN!', PAL.violet, 1.2, 2); }
      }
      for (let m = g.mines.length - 1; m >= 0; m--) {
        const mn = g.mines[m];
        if (Math.hypot(mn.x - w.x, mn.y - w.y) < w.r) {
          burst(g, mn.x, mn.y, 8, 80, FX.ion, 0.4);
          g.mines.splice(m, 1);
        }
      }
      if (w.r >= C.EMP_RANGE) g.waves.splice(i, 1);
    }
  }

  /* ------------------------------------------------------------ pickups */

  function collect(s, p, g) {
    p.on = false;
    p.timer = C.PICK_RESPAWN;
    const T = ITEMS[p.type], isP = s === g.player && !g.demo;
    if (T.ammo) {
      if (s.weapon === p.type) s.ammo = Math.min(T.ammo * 2, s.ammo + T.ammo);
      else { s.weapon = p.type; s.ammo = T.ammo; }
      if (isP) RR.audio.sfx('weapon');
    } else if (p.type === 'nitro') {
      s.nitro = C.NITRO_TIME;
      s.vx += Math.cos(s.angle) * 90; s.vy += Math.sin(s.angle) * 90;
      snd(g, 'nitro', s.x, s.y, isP ? 1 : 0.5);
    } else if (p.type === 'shield') {
      s.shield = C.SHIELD_TIME;
      snd(g, 'shield', s.x, s.y, isP ? 1 : 0.5);
    } else if (p.type === 'repair') {
      s.hp = Math.min(C.MAXHP, s.hp + 50);
      if (isP) RR.audio.sfx('power');
    } else if (p.type === 'rewind') {
      s.rewind = 1;
      if (isP) { RR.audio.sfx('power'); banner(g, 'DO-OVER READY', PAL.violet, 1.6, 3); }
    }
    burst(g, p.x, p.y, 12, 120, T.ammo ? FX.fire : p.type === 'rewind' ? FX.ion : FX.shield, 0.45);
    ringFx(g, p.x, p.y, 6, 20, 0.22, T.color);
    if (isP) floatText(g, p.x, p.y - 12, T.name, T.color);
  }

  function updatePickups(g, dt) {
    const rr = C.PICK_R * C.PICK_R;
    for (const p of g.pickups) {
      if (!p.on) {
        p.timer -= dt;
        if (p.timer <= 0) { p.on = true; p.type = roll(p.kind); ringFx(g, p.x, p.y, 16, 4, 0.2, PAL.white); }
        continue;
      }
      for (const s of g.ships) {
        if (s.dead > 0) continue;
        // only the human can use a do-over, and only one at a time: otherwise leave it for later
        if (p.type === 'rewind' && (s.ai || s.rewind > 0)) continue;
        const dx = s.x - p.x, dy = s.y - p.y;
        if (dx * dx + dy * dy < rr) { collect(s, p, g); break; }
      }
    }
  }

  /* ---------------------------------------------------------- asteroids */

  function updateRocks(g, dt) {
    const damp = Math.exp(-0.7 * dt), planets = g.track.planets;
    for (const a of g.rocks) {
      if (a.dead) {
        a.respawn -= dt;
        if (a.respawn <= 0) {
          const hx = a.orbit ? a.x : a.hx, hy = a.orbit ? a.y : a.hy;
          let free = true;
          for (const s of g.ships) if (Math.hypot(s.x - hx, s.y - hy) < 90) free = false;
          if (free) {
            a.dead = false; a.hp = a.maxHp;
            if (!a.orbit) { a.x = a.hx; a.y = a.hy; a.vx = a.vy = 0; }
            ringFx(g, a.x, a.y, a.r + 10, 2, 0.3, '#927468');
          }
        }
        if (!a.orbit) continue;
      }
      if (a.orbit) {
        const o = a.orbit;
        o.a += o.s * dt;
        a.x = o.p.x + Math.cos(o.a) * o.d; a.y = o.p.y + Math.sin(o.a) * o.d;
        a.vx = -Math.sin(o.a) * o.d * o.s; a.vy = Math.cos(o.a) * o.d * o.s;
        if (a.dead) continue;
      } else {
        // drift lazily around a home point so fields keep their shape
        const tx = a.hx + Math.cos(g.t * a.wf + a.wp) * a.wr, ty = a.hy + Math.sin(g.t * a.wf * 1.3 + a.wp) * a.wr;
        a.vx += (tx - a.x) * 0.6 * dt; a.vy += (ty - a.y) * 0.6 * dt;
        a.vx *= damp; a.vy *= damp;
        a.x += a.vx * dt; a.y += a.vy * dt;
        for (const p of planets) {
          const dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy), min = p.r + a.cr;
          if (d < min) { a.x = p.x + (dx / d) * min; a.y = p.y + (dy / d) * min; a.vx *= -0.4; a.vy *= -0.4; }
        }
      }
      a.rot += a.rs * dt;

      for (const s of g.ships) {
        if (s.dead > 0) continue;
        const dx = s.x - a.x, dy = s.y - a.y, min = a.cr + C.SHIP_R, d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.01, nx = dx / d, ny = dy / d;
        const ima = a.orbit ? 0 : 1 / a.mass, tot = 1 + ima, overlap = min - d;
        s.x += nx * overlap / tot; s.y += ny * overlap / tot;
        if (!a.orbit) { a.x -= nx * overlap * ima / tot; a.y -= ny * overlap * ima / tot; }
        const rv = (s.vx - a.vx) * nx + (s.vy - a.vy) * ny;
        if (rv >= 0) continue;
        const j = -(1 + 0.55) * rv / tot;
        s.vx += j * nx; s.vy += j * ny;
        if (!a.orbit) { a.vx -= j * ima * nx; a.vy -= j * ima * ny; }
        a.rs += (Math.random() - 0.5) * 2.5;
        const imp = -rv;
        if (imp > 45) {
          if (s.shield > 0) damageRock(g, a, 2); // shields plough straight through
          else hurt(s, g, (imp - 45) * 0.06 * clamp(a.mass, 0.5, 1.7));
          burst(g, s.x - nx * C.SHIP_R, s.y - ny * C.SHIP_R, 6, 100, FX.rock, 0.35);
          snd(g, 'bump', s.x, s.y, clamp(imp / 260, 0.3, 1));
          if (s === g.player && !g.demo) { g.shake = Math.max(g.shake, clamp(imp / 50, 1, 6)); RR.input.buzz(20); }
        }
      }
    }
  }

  /* --------------------------------------------------------------- ships */

  function updateShip(s, g, dt, racing) {
    if (s.rw) { stepRewind(s, g, dt); return; }
    if (s.dead > 0) {
      s.dead -= dt;
      if (s.dead <= 0) respawn(s, g);
      return;
    }
    if (s.shield > 0) s.shield -= dt;
    if (s.nitro > 0) s.nitro -= dt;
    if (s.emp > 0) s.emp -= dt;
    if (s.invuln > 0) s.invuln -= dt;
    if (s.cool > 0) s.cool -= dt;
    if (s.hitFlash > 0) s.hitFlash -= dt;
    if (!racing) { s.thrusting = 0; return; }

    const inp = s.input;
    let turn = inp.turn, thrust = inp.thrust, brake = inp.brake, grip = C.GRIP;
    if (s.stun > 0) {
      s.stun -= dt;
      s.angle += s.spinRate * dt;
      s.angVel = 0;
      turn = thrust = brake = 0;
      grip = 0;
    } else {
      if (s.emp > 0) { thrust = 0; turn *= 0.35; }
      s.angVel += (turn * C.TURN - s.angVel) * Math.min(1, 16 * dt);
      s.angle += s.angVel * dt;
    }
    const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
    const boost = s.nitro > 0 ? C.NITRO_MULT : 1;
    const acc = C.THRUST * (thrust * boost * s.speedMult - C.REVERSE * brake);
    s.vx += ca * acc * dt; s.vy += sa * acc * dt;
    s.thrusting = thrust * boost;

    // planetary gravity: inverse-square, faded out at the edge of its reach
    const planets = g.track.planets;
    for (const p of planets) {
      const dx = p.x - s.x, dy = p.y - s.y, d2 = dx * dx + dy * dy;
      if (d2 > p.range * p.range) continue;
      const d = Math.sqrt(d2) || 1;
      const a = p.g * (p.r / d) * (p.r / d) * Math.min(1, (1 - d / p.range) * 3);
      s.vx += (dx / d) * a * dt; s.vy += (dy / d) * a * dt;
    }

    // drag along the nose, extra "grip" sideways so the ship carves instead of drifting forever
    const vf = (s.vx * ca + s.vy * sa) * Math.exp(-C.DRAG * dt);
    const vl = (-s.vx * sa + s.vy * ca) * Math.exp(-(C.DRAG + grip) * dt);
    s.vx = ca * vf - sa * vl; s.vy = sa * vf + ca * vl;
    s.x += s.vx * dt; s.y += s.vy * dt;

    // leash: a soft wall well outside the course
    const b = g.track.bounds;
    s.out = false;
    if (s.x < b.x0) { s.vx += (b.x0 - s.x) * 5 * dt; s.out = true; }
    else if (s.x > b.x1) { s.vx -= (s.x - b.x1) * 5 * dt; s.out = true; }
    if (s.y < b.y0) { s.vy += (b.y0 - s.y) * 5 * dt; s.out = true; }
    else if (s.y > b.y1) { s.vy -= (s.y - b.y1) * 5 * dt; s.out = true; }

    // planets are solid
    for (const p of planets) {
      const dx = s.x - p.x, dy = s.y - p.y, min = p.r + C.SHIP_R, d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 0.01, nx = dx / d, ny = dy / d;
      s.x = p.x + nx * min; s.y = p.y + ny * min;
      const vn = s.vx * nx + s.vy * ny;
      if (vn < 0) {
        s.vx -= 1.45 * vn * nx; s.vy -= 1.45 * vn * ny;
        s.vx *= 0.92; s.vy *= 0.92;
        const imp = -vn;
        if (imp > 50) {
          hurt(s, g, (imp - 50) * 0.11);
          burst(g, s.x - nx * C.SHIP_R, s.y - ny * C.SHIP_R, 8, 120, FX.spark, 0.35);
          snd(g, 'bump', s.x, s.y, clamp(imp / 240, 0.3, 1));
          if (s === g.player && !g.demo) { g.shake = Math.max(g.shake, clamp(imp / 40, 1, 8)); RR.input.buzz(30); }
        }
      }
    }
    if (s.dead > 0) return;

    // exhaust + damage smoke
    if (near(g, s.x, s.y)) {
      if (thrust > 0.05) {
        s.exh += dt * (boost > 1 ? 120 : 62);
        const ramp = boost > 1 ? FX.nitro : FX.fire;
        while (s.exh >= 1) {
          s.exh -= 1;
          for (const pt of s.ports) {
            const sp = 90 + Math.random() * 90, j = (Math.random() - 0.5) * 56;
            part(g, s.x - sa * pt[0] - ca * pt[1], s.y + ca * pt[0] - sa * pt[1],
              s.vx - ca * sp - sa * j, s.vy - sa * sp + ca * j,
              0.16 + Math.random() * 0.24, boost > 1 || Math.random() < 0.4 ? 2 : 1, ramp, 1.5, 0);
          }
        }
      }
      if (s.hp < 35 || s.emp > 0) {
        s.smk += dt * (s.emp > 0 ? 24 : 12);
        while (s.smk >= 1) {
          s.smk -= 1;
          part(g, s.x + (Math.random() - 0.5) * 8, s.y + (Math.random() - 0.5) * 8,
            s.vx * 0.3 + (Math.random() - 0.5) * 30, s.vy * 0.3 + (Math.random() - 0.5) * 30,
            0.4 + Math.random() * 0.4, 2, s.emp > 0 ? FX.ion : FX.smoke, 1, 1);
        }
      }
    } else { s.exh = 0; s.smk = 0; }
  }

  function collideShips(g) {
    const ships = g.ships, min = C.SHIP_R * 2;
    for (let i = 0; i < ships.length; i++) {
      const a = ships[i];
      if (a.dead > 0) continue;
      for (let j = i + 1; j < ships.length; j++) {
        const b = ships[j];
        if (b.dead > 0) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.01, nx = dx / d, ny = dy / d, push = (min - d) / 2;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv >= 0) continue;
        const k = -1.6 * rv / 2;
        a.vx -= k * nx; a.vy -= k * ny; b.vx += k * nx; b.vy += k * ny;
        if (-rv > 55) {
          burst(g, (a.x + b.x) / 2, (a.y + b.y) / 2, 6, 110, FX.spark, 0.3);
          snd(g, 'bump', a.x, a.y, clamp(-rv / 300, 0.25, 0.8));
        }
      }
    }
  }

  /* ----------------------------------------------- checkpoints and laps */

  function finish(s, g) {
    s.finished = true;
    s.finishTime = g.raceTime;
    if (s !== g.player || g.demo) return;
    g.playerDone = true;
    g.doneT = 0;
    s.ai = makeAI(DEMO_DIFF); // autopilot takes the victory lap
    rank(g);
    const first = s.place === 1;
    banner(g, 'FINISH!', first ? PAL.yellow : PAL.white, 2.2, 5);
    RR.audio.sfx(s.place <= 3 ? 'finish' : 'lose');
    RR.audio.music({ tempo: 0.9 });
    const id = g.track.def.id, rec = g.best[id] || {};
    if (!rec.race || s.finishTime < rec.race) { rec.race = s.finishTime; g.newRecord = true; }
    if (s.bestLap && (!rec.lap || s.bestLap < rec.lap)) rec.lap = s.bestLap;
    g.best[id] = rec;
    save();
    RR.net.submit(id, { name: g.name, pid: g.pid, time: s.finishTime, lap: s.bestLap, diff: g.diffIdx });
  }

  function passCp(s, g, cp) {
    const N = g.track.cps.length, isP = s === g.player && !g.demo && !g.playerDone;
    s.nextCp = (s.nextCp + 1) % N;
    s.cpCount++;
    if (s.ai) s.ai.stuckN = 0;
    if (isP) {
      RR.audio.sfx('cp');
      ringFx(g, cp.x, cp.y, Art.DONUT_RC - 12, Art.DONUT_RC + 26, 0.35, PAL.yellow);
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * TAU, r = Art.DONUT_RC + (Math.random() - 0.5) * 10, v = 60 + Math.random() * 140;
        part(g, cp.x + Math.cos(a) * r, cp.y + Math.sin(a) * r, Math.cos(a) * v, Math.sin(a) * v,
          0.4 + Math.random() * 0.5, 2, FX.confetti[i % 6], 2, 1);
      }
    }
    if (!cp.finish) return;
    if (s.lap === 0) { s.lap = 1; return; } // first pass over the line starts lap 1
    if (s.finished) return;
    const lt = g.raceTime - s.lapStart;
    s.lapTimes.push(lt);
    if (!s.bestLap || lt < s.bestLap) s.bestLap = lt;
    s.lapStart = g.raceTime;
    if (s.lap >= g.laps) { finish(s, g); return; }
    s.lap++;
    if (isP) {
      const last = s.lap === g.laps;
      banner(g, last ? 'FINAL LAP!' : 'LAP ' + s.lap, last ? PAL.orange : PAL.cyan, 1.6, 4);
      RR.audio.sfx('lap');
      if (last) RR.audio.music({ tempo: 1.12 });
    }
  }

  function updateCheckpoints(g) {
    const cps = g.track.cps, rr = C.CP_R * C.CP_R;
    for (const s of g.ships) {
      if (s.dead > 0) continue;
      const cp = cps[s.nextCp], dx = s.x - cp.x, dy = s.y - cp.y;
      if (dx * dx + dy * dy < rr) passCp(s, g, cp);
    }
  }

  function rank(g) {
    const cps = g.track.cps;
    for (const s of g.ships) {
      if (s.rw) continue; // a ship being rewound keeps its place until it lands
      const cp = cps[s.nextCp];
      const seg = s.cpCount === 0 ? 420 : cp.segLen;
      s.progress = s.cpCount + (1 - clamp(Math.hypot(cp.x - s.x, cp.y - s.y) / seg, 0, 1)) * 0.999;
    }
    g.order.sort(function (a, b) {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    for (let i = 0; i < g.order.length; i++) g.order[i].place = i + 1;
  }

  /* ------------------------------------------------------------------ AI */

  function choosePickup(s, g, ux, uy, dist) {
    let best = null, bestLat = 48;
    for (const p of g.pickups) {
      if (!p.on) continue;
      if (p.kind === 'W' ? !!s.weapon : p.type === 'rewind' || (p.type === 'repair' && s.hp > 80) || (p.type === 'shield' && s.shield > 0)) continue;
      const px = p.x - s.x, py = p.y - s.y, along = px * ux + py * uy;
      if (along < 24 || along > Math.min(dist, 280)) continue;
      const lat = Math.abs(px * uy - py * ux);
      if (lat < bestLat) { bestLat = lat; best = p; }
    }
    return best;
  }

  /** Bend a desired heading (ux, uy) around a round obstacle. Returns true if bent. */
  const steer = { x: 0, y: 0 };
  function avoid(s, ox, oy, clear, ux, uy) {
    const px = ox - s.x, py = oy - s.y, pd = Math.hypot(px, py) || 1;
    const alpha = Math.asin(Math.min(1, clear / pd));
    const angTo = Math.atan2(py, px);
    const beta = angDiff(Math.atan2(uy, ux), angTo);
    if (Math.abs(beta) >= alpha) return false;
    const side = beta >= 0 ? 1 : -1;
    let na = angTo + side * (alpha + 0.07);
    if (pd < clear) na += side * 0.6 * (1 - pd / clear); // too close: peel outwards
    steer.x = Math.cos(na); steer.y = Math.sin(na);
    return true;
  }

  function think(s, g, dt) {
    const ai = s.ai, inp = s.input, tr = g.track, cps = tr.cps, N = cps.length;
    inp.turn = 0; inp.thrust = 0; inp.brake = 0; inp.fire = false;
    if (g.phase !== 'race' || s.dead > 0) return;

    // rubber band: ease off when well ahead of the player, push when behind
    if (!g.demo && !g.playerDone && s !== g.player) {
      s.speedMult = ai.skill * (1 - ai.rubber * clamp((s.progress - g.player.progress) / 1.5, -1, 1));
    } else s.speedMult = ai.skill;

    const cp = cps[s.nextCp];
    if (ai.cpFor !== s.cpCount) {
      ai.cpFor = s.cpCount;
      const a = Math.random() * TAU, m = Math.random() * 18;
      ai.ox = Math.cos(a) * m; ai.oy = Math.sin(a) * m;
    }
    const cdx = cp.x + ai.ox - s.x, cdy = cp.y + ai.oy - s.y, cdist = Math.hypot(cdx, cdy) || 1;
    let dx = cdx, dy = cdy, dist = cdist;

    // detour for a pickup that is nearly on the racing line
    ai.pickT -= dt;
    if (ai.pickT <= 0) {
      ai.pickT = 0.2;
      ai.pick = choosePickup(s, g, cdx / cdist, cdy / cdist, cdist);
    }
    if (ai.pick && ai.pick.on) {
      dx = ai.pick.x - s.x; dy = ai.pick.y - s.y; dist = Math.hypot(dx, dy) || 1;
    }
    let ux = dx / dist, uy = dy / dist;
    const speed = Math.hypot(s.vx, s.vy);

    // steer around planets that sit between us and the target
    for (const p of tr.planets) {
      const pd = Math.hypot(p.x - s.x, p.y - s.y);
      if (pd - p.r > dist) continue;
      if (avoid(s, p.x, p.y, p.r + 30 + ai.margin, ux, uy)) { ux = steer.x; uy = steer.y; }
    }
    // ...then around the nearest asteroid or mine in the way
    let block = null, blockR = 0, reach = Math.min(dist, 130 + speed * 0.3);
    for (const a of g.rocks) {
      if (a.dead) continue;
      const ax = a.x - s.x, ay = a.y - s.y, along = ax * ux + ay * uy;
      if (along < -6 || along > reach) continue;
      if (Math.abs(ax * uy - ay * ux) < a.cr + 15) { block = a; blockR = a.cr + 17; reach = along; }
    }
    for (const m of g.mines) {
      const ax = m.x - s.x, ay = m.y - s.y, along = ax * ux + ay * uy;
      if (along < 0 || along > reach) continue;
      if (Math.abs(ax * uy - ay * ux) < 24) { block = m; blockR = 28; reach = along; }
    }
    if (block && avoid(s, block.x, block.y, blockR, ux, uy)) { ux = steer.x; uy = steer.y; }

    // aim a little against our own sideways drift, then turn towards that
    const want = Math.atan2(uy * 330 - s.vy * 0.45, ux * 330 - s.vx * 0.45);
    const diff = angDiff(want, s.angle), ad = Math.abs(diff);
    inp.turn = clamp(diff * 6, -1, 1);
    inp.thrust = ad > 1.7 ? 0 : ad > 1 ? 0.45 : 1;

    // brake for sharp corners
    const nx = cps[(s.nextCp + 1) % N];
    const corner = Math.abs(angDiff(Math.atan2(nx.y - cp.y, nx.x - cp.x), Math.atan2(cdy, cdx)));
    if (corner > 0.9 && cdist < 70 + speed * 0.7) {
      const target = 300 - 130 * clamp((corner - 0.9) / 1.6, 0, 1);
      if (speed > target) { inp.thrust = 0; if (speed > target + 45) inp.brake = 1; }
    }

    // unstick: back off, and if that keeps failing, call for a tow
    if (speed < 24 && s.stun <= 0) ai.stuck += dt; else ai.stuck = Math.max(0, ai.stuck - dt * 2);
    if (ai.stuck > 1.2) {
      ai.stuck = 0; ai.rev = 0.7; ai.revTurn = Math.random() < 0.5 ? -1 : 1;
      if (++ai.stuckN > 4) { destroy(s, g); return; }
    }
    if (ai.rev > 0) { ai.rev -= dt; inp.thrust = 0; inp.brake = 1; inp.turn = ai.revTurn; }

    // weapons
    ai.fireT -= dt;
    if (!s.weapon || ai.fireT > 0 || s.stun > 0 || s.emp > 0) return;
    const ca = Math.cos(s.angle), sa = Math.sin(s.angle), w = s.weapon;
    let fire = false;
    for (const o of g.ships) {
      if (o === s || o.dead > 0 || o.invuln > 0) continue;
      const ox = o.x - s.x, oy = o.y - s.y, od = Math.hypot(ox, oy) || 1, fwd = (ox * ca + oy * sa) / od;
      if (w === 'blaster') fire = od < 380 && fwd > 0.985;
      else if (w === 'missile') fire = od < 620 && od > 70 && fwd > 0.72;
      else if (w === 'mine') fire = od < 190 && fwd < -0.5;
      else if (w === 'emp') fire = od < C.EMP_RANGE * 0.7;
      if (fire) break;
    }
    if (fire) {
      inp.fire = true;
      ai.fireT = w === 'blaster' ? 0.15 / Math.min(1, ai.aggro) : (0.7 + Math.random() * 1.6) / ai.aggro;
    }
  }

  /* --------------------------------------------------------- fx + camera */

  function updateFx(g, dt) {
    const parts = g.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      if (p.drag) { const k = 1 - p.drag * dt; p.vx *= k; p.vy *= k; }
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let i = g.rings.length - 1; i >= 0; i--) {
      g.rings[i].t += dt;
      if (g.rings[i].t >= g.rings[i].dur) g.rings.splice(i, 1);
    }
    for (let i = g.texts.length - 1; i >= 0; i--) {
      const t = g.texts[i];
      t.t += dt; t.y -= 22 * dt;
      if (t.t >= t.dur) g.texts.splice(i, 1);
    }
  }

  function updateCamera(g, dt) {
    const f = g.player;
    if (f.rw) { // the ghost moves too fast for a smoothed camera
      g.cam.x = f.x; g.cam.y = f.y;
      g.shake *= Math.exp(-9 * dt);
      return;
    }
    let lx = f.vx * 0.36, ly = f.vy * 0.36;
    const max = Math.min(g.vw, g.vh) * 0.27, m = Math.hypot(lx, ly);
    if (m > max) { lx *= max / m; ly *= max / m; }
    const k = 1 - Math.exp(-(f.dead > 0 ? 2 : 4.5) * dt);
    g.cam.x += (f.x + lx - g.cam.x) * k;
    g.cam.y += (f.y + ly - g.cam.y) * k;
    g.shake *= Math.exp(-9 * dt);
  }

  /* ------------------------------------------------------------ stepping */

  function simulate(g, dt) {
    const racing = g.phase === 'race';
    if (racing) g.raceTime += dt;
    for (const s of g.ships) {
      if (s.ai) think(s, g, dt);
      else {
        const inp = RR.input.read(s);
        s.input.turn = inp.turn; s.input.thrust = inp.thrust; s.input.brake = inp.brake; s.input.fire = inp.fire;
      }
      if (racing) tryFire(s, g);
      updateShip(s, g, dt, racing);
    }
    collideShips(g);
    updateCheckpoints(g);
    updatePickups(g, dt);
    updateShots(g, dt);
    updateMines(g, dt);
    updateWaves(g, dt);
    updateRocks(g, dt);
    updateFx(g, dt);
    rank(g);

    // "wrong way" when the player keeps flying away from the next gate
    const p = g.player;
    if (!g.demo && racing && !p.rw && p.dead <= 0 && !g.playerDone) recordHistory(p, dt);
    if (!g.demo && racing && p.dead <= 0) {
      const cp = g.track.cps[p.nextCp], dx = cp.x - p.x, dy = cp.y - p.y;
      const sp = Math.hypot(p.vx, p.vy), d = Math.hypot(dx, dy) || 1;
      if (sp > 90 && (p.vx * dx + p.vy * dy) / (sp * d) < -0.45) p.wrong += dt;
      else p.wrong = Math.max(0, p.wrong - dt * 3);
    }
    updateCamera(g, dt);
  }

  /** One fixed simulation step. */
  G.step = function (dt) {
    const g = this;
    g.t += dt;
    if (g.state === 'paused') return;
    if (g.flash > 0) g.flash -= dt * 2;
    if (g.msg) { g.msg.t += dt; if (g.msg.t >= g.msg.dur) g.msg = null; }
    if (g.phase === 'countdown') {
      const before = Math.ceil(g.count);
      g.count -= dt;
      const after = Math.ceil(g.count);
      if (after < before && after >= 1 && after <= 3) RR.audio.sfx('beep');
      if (g.count <= 0) {
        g.phase = 'race';
        RR.audio.sfx('go');
        banner(g, 'GO!', PAL.lime, 0.9, 6);
      }
    }
    simulate(g, dt);
    if (g.playerDone) {
      g.doneT += dt;
      if (g.state === 'play' && g.doneT > 2.6) g.state = 'results';
    }
  };

  function handleUI(g) {
    const I = RR.input, hit = I.hit;
    if (hit.mute) { RR.audio.setMuted(!RR.audio.muted); save(); }
    if (hit.crt) { g.crt = !g.crt; applyCrt(); save(); }
    if (hit.zoomIn) g.zoomBy(1);
    if (hit.zoomOut) g.zoomBy(-1);
    if (hit.zoom) g.zoomCycle();

    for (const tp of I.taps) {
      for (let k = g.ui.length - 1; k >= 0; k--) {
        const u = g.ui[k];
        if (tp.x >= u.x && tp.x < u.x + u.w && tp.y >= u.y && tp.y < u.y + u.h) { u.act(); break; }
      }
    }

    if (hit.full) g.fullscreen();
    if (g.state === 'title') {
      if (hit.up || hit.down) { g.menuRow = 1 - g.menuRow; RR.audio.sfx('select'); }
      const d = hit.left ? -1 : hit.right ? 1 : 0;
      if (d) { if (g.menuRow === 0) g.setTrack(d); else g.setDiff(d); }
      if (hit.ok || hit.fire) g.begin();
      else if (hit.name) g.editName();
      else if (hit.board) g.showBoard();
    } else if (g.state === 'board') {
      if (hit.ok || hit.pause || hit.board || hit.fire) g.closeBoard();
    } else if (g.state === 'play') {
      if (hit.pause) g.pause();
      else if (hit.rewind) g.tryRewind();
    } else if (g.state === 'paused') {
      if (hit.pause || hit.ok) g.resume();
      else if (hit.restart) g.begin();
      else if (hit.quit) g.toTitle();
    } else if (g.state === 'results') {
      if (hit.ok) g.toTitle();
      else if (hit.restart) g.begin();
    }
  }

  /** Called once per animation frame with the real elapsed time. */
  G.frame = function (dt) {
    const g = this, I = RR.input;
    I.updateTouch(g.state === 'play' && I.touchMode ? RR.touchLayout(g.W, g.H, g.inset) : null);
    if (!I.typing) { I.pollPad(); handleUI(g); }
    if (g.toast) { g.toast.t += dt; if (g.toast.t >= g.toast.dur) g.toast = null; }

    g.acc += dt;
    let n = 0;
    while (g.acc >= C.STEP) {
      g.acc -= C.STEP;
      if (++n > 14) { g.acc = 0; break; } // never spiral after a long stall
      g.step(C.STEP);
    }

    const p = g.player;
    const live = g.state === 'play' && g.phase === 'race' && !g.playerDone && p.dead <= 0;
    RR.audio.engine(live, live ? p.thrusting : 0, live ? Math.hypot(p.vx, p.vy) : 0);
    I.endFrame();
  };
})();
