/* ==========================================================================
 * ROCKET RACER — game.js
 * Simulation: ship physics, gravity, collisions, checkpoints and laps,
 * pickups, weapons, rival AI, particles, camera and the game-state machine.
 * Also the hangar (ships, stats, unlocks) and the two combat modes.
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
    // combat modes
    CANNON_COOL: 0.2, KILL_CREDIT: 5, // built-in blaster; seconds a hit still counts towards a kill
    KILL_TARGET: 5, DOGFIGHT_TIME: 180,
    ZONE_GRACE: 12, ZONE_SHRINK: 110, ZONE_DMG: 14, // battle royale: the zone closes to nothing
    ROYALE_DMG: 0.6, // ...and with one life each, weapons hit softer so it is not over in seconds
    // capture the flag: touch reach, the capture zone round a base, how long a dropped flag lies, the win, the clock
    FLAG_R: 30, BASE_R: 100, FLAG_RETURN: 25, CTF_CAPS: 3, CTF_TIME: 300,
    CTF_RESPAWN: 4, // ...and a wreck takes longer to come back than in a dogfight, so a cleared base stays clear for a moment
    REFLAG_MAX: 1, // ...and one Replace Flag in the whole match: lying on the map, or held by one pilot
  });

  const ITEMS = (RR.ITEMS = {
    nitro: { name: 'NITRO', color: PAL.yellow },
    shield: { name: 'SHIELD', color: PAL.cyan },
    repair: { name: 'REPAIR', color: PAL.lime },
    blaster: { name: 'BLASTER', color: PAL.cyan, ammo: 10 },
    missile: { name: 'MISSILE', color: PAL.orange, ammo: 2 },
    mine: { name: 'MINE', color: PAL.alarm, ammo: 3 },
    emp: { name: 'EMP', color: PAL.violet, ammo: 1 },
    defer: { name: 'DEFERRAL', color: PAL.violet }, // gate deferral: the gate ahead counts as passed
    reflag: { name: 'REPLACE FLAG', color: PAL.gold }, // capture the flag: your flag home, wherever it is
  });
  const ROLL = {
    P: [['nitro', 38], ['shield', 26], ['repair', 22], ['defer', 14]],
    W: [['blaster', 35], ['missile', 30], ['mine', 20], ['emp', 15]],
    N: [['nitro', 1]], // a course's nitro strip
    // combat modes: every ship already has a cannon, and there are no gates to defer
    CP: [['nitro', 30], ['shield', 35], ['repair', 35]],
    CW: [['missile', 45], ['mine', 25], ['emp', 30]],
    // capture the flag: the race's powerups, with Replace Flag where the deferral was
    FP: [['nitro', 38], ['shield', 26], ['repair', 22], ['reflag', 14]],
    FW: [['blaster', 35], ['missile', 30], ['mine', 20], ['emp', 15]],
  };

  const MODES = (RR.MODES = [
    { id: 'race', name: 'GRAND PRIX', go: 'RACE' },
    { id: 'dogfight', name: 'DOGFIGHT', go: 'FIGHT', rule: 'FIRST TO 5 KILLS - 3:00 LIMIT' },
    { id: 'royale', name: 'BATTLE ROYALE', go: 'FIGHT', rule: 'ONE LIFE - THE ZONE CLOSES IN' },
    { id: 'ctf', name: 'CAPTURE THE FLAG', go: 'FIGHT', rule: 'RED V BLUE - BRING THEIR FLAG HOME' },
  ]);
  // capture the flag's teams, one per base on the map (two or three): ship i flies for side i % teams
  const SIDES = (RR.SIDES = [
    { name: 'RED', color: '#e5404f', light: '#ff9d8f' },
    { name: 'BLUE', color: '#3b82f6', light: '#9bd8ff' },
    { name: 'GREEN', color: '#3fbf5a', light: '#cdf7a0' },
  ]);

  /*
   * The hangar. Every stat is a level; level 3 is the baseline (x1.0) and each
   * level above or below moves it by `step`. A ship starts at `base` and stat
   * points can raise each stat as far as its `cap` - better ships, unlocked by
   * winning, have higher ceilings.
   */
  /*
   * Powerup upgrades, handled like stat points. Credits buy upgrade points
   * (UPGRADE_PRICE each). A point raises one powerup a level, up to level 3,
   * and can be taken back and put on another at any time. Upgrades are kept
   * for good and make every pick-up of that powerup stronger, in every event
   * (rivals stay at level 1). Points can only be bought while some powerup
   * still has room for them, so none are ever unspendable.
   * `lv` is what each level gives.
   */
  const POWER = (RR.POWER = [
    { id: 'nitro', lv: [1, 1.5, 2] }, // boost length, times the usual
    { id: 'shield', lv: [1, 1.5, 2] }, // shield length, times the usual
    { id: 'repair', lv: [50, 75, 100] }, // hull put back
    { id: 'blaster', lv: [10, 20, 30] }, // shots
    { id: 'missile', lv: [2, 3, 5] },
    { id: 'mine', lv: [3, 5, 8] },
    { id: 'emp', lv: [1, 2, 3] },
    { id: 'defer', lv: [1, 2, 3] }, // gate deferrals held
  ]);
  const UPGRADE_PRICE = (RR.UPGRADE_PRICE = 150), POWER_MAX = 3;
  const powerOf = function (id) { return POWER.filter(function (p) { return p.id === id; })[0] || null; };
  /** What powerup `id` gives at level `lv`, in a few words. */
  RR.powerDoes = function (id, lv) {
    const k = powerOf(id).lv[lv - 1], n = function (x) { return String(+x.toFixed(1)); };
    if (id === 'nitro') return 'BOOST ' + n(C.NITRO_TIME * k) + 'S';
    if (id === 'shield') return 'SHIELD ' + n(C.SHIELD_TIME * k) + 'S';
    if (id === 'repair') return '+' + k + ' HULL';
    if (id === 'defer') return k + (k === 1 ? ' GATE' : ' GATES');
    const unit = { blaster: ['SHOT', 'SHOTS'], missile: ['MISSILE', 'MISSILES'], mine: ['MINE', 'MINES'], emp: ['EMP', 'EMPS'] }[id];
    return k + ' ' + unit[k === 1 ? 0 : 1];
  };
  const PAY = [100, 70, 50, 40, 30, 30], PAY_MULT = [1, 1.5, 2]; // credits by finishing place, times the rival level

  const STAT_MID = 3;
  const STATS = (RR.STATS = [
    { name: 'ACCEL', step: 0.04 },
    { name: 'TOP SPEED', step: 0.02 },
    { name: 'HANDLING', step: 0.035 },
    { name: 'HULL', step: 0.12 },
    { name: 'FIREPOWER', step: 0.08 },
  ]);
  const HULLS = (RR.HULLS = [
    { id: 'sparrow', name: 'SPARROW', design: 0, wins: 0, blurb: 'AN HONEST ALL-ROUNDER', base: [3, 3, 3, 3, 3], cap: [6, 6, 6, 6, 6] },
    { id: 'dart', name: 'DART', design: 1, wins: 2, blurb: 'QUICK, NIMBLE, FRAGILE', base: [4, 4, 4, 2, 3], cap: [8, 9, 8, 5, 6] },
    { id: 'hammer', name: 'HAMMER', design: 2, wins: 5, blurb: 'THICK ARMOUR, BIG GUNS', base: [3, 3, 3, 5, 5], cap: [6, 7, 6, 10, 10] },
    { id: 'phoenix', name: 'PHOENIX', design: 3, wins: 9, blurb: 'THE BEST OF EVERYTHING', base: [5, 5, 5, 5, 5], cap: [10, 10, 10, 10, 10] },
  ]);

  const RACERS = [
    { name: 'YOU', team: 0, design: 0 },
    { name: 'NOVA', team: 1, design: 1 },
    { name: 'BLITZ', team: 2, design: 2 },
    { name: 'COMET', team: 3, design: 0 },
    { name: 'VEGA', team: 4, design: 1 },
    { name: 'ORION', team: 5, design: 2 },
  ];

  /*
   * No stat point is ever unspendable. Each ship sees only as many points as
   * it has room for (the gap between its own levels and its ceilings: 15 for
   * the Sparrow up to 25 for the Phoenix), and points stop at the room of the
   * best ship you have unlocked, so none pile up for a ship you cannot fly.
   */
  const room = (RR.shipRoom = function (i) {
    const h = HULLS[i];
    return h.cap.reduce(function (a, c, k) { return a + c - h.base[k]; }, 0);
  });

  const DIFFS = (RR.DIFFS = [
    { name: 'ROOKIE', speed: 0.83, spread: 0.05, aggro: 0.45, rubber: 0.07, dmg: 0.7 },
    { name: 'PILOT', speed: 0.92, spread: 0.05, aggro: 1.0, rubber: 0.05, dmg: 0.85 },
    { name: 'ACE', speed: 1.0, spread: 0.04, aggro: 1.6, rubber: 0.02, dmg: 1 },
  ]); // `dmg` scales rival weapons in the combat modes only
  const DEMO_DIFF = { name: 'DEMO', speed: 0.95, spread: 0.06, aggro: 1.2, rubber: 0, dmg: 1 };

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
    modeIdx: 0, arenaIdx: 0, mode: 'race', combat: false, royale: false,
    zone: null, over: false, feed: [], spec: null, reward: null,
    prog: { wins: 0, points: 0, ship: 0, up: {}, credits: 0, upts: 0, pup: {} }, // unlocks, stat upgrades, credits, powerup upgrade points and levels
    hangarPage: 'ship',
    hangarRow: 0, hangarShip: 0,
    ships: [], order: [], rocks: [], pickups: [], shots: [], mines: [], waves: [],
    parts: [], rings: [], texts: [],
    cam: { x: 0, y: 0 }, shake: 0, flash: 0, msg: null, ui: [],
    best: {}, crt: true, newRecord: false,
    autoFull: true, wantFull: false, // full screen on phones (see G.fullscreen)
    // touch controls the player has moved: { land|port: { fire|brake|defer: {x, y} } },
    // as fractions of the screen so they survive other screen sizes (see RR.touchLayout)
    controls: {},
    name: '', pid: '', // pilot name + anonymous id for the online leaderboard
    humansOnly: false, // online: rooms the player opens or quick-matches into race people only, no bots
    hist: null, // the player's history: games played, wins, 1st / 2nd / 3rd places, by event (see records.js)
    inset: { l: 0, t: 0, r: 0, b: 0 }, // notch / rounded-corner margins, in game pixels
    // The world layer can zoom; the HUD layer (W x H) keeps its pixel size.
    vw: 640, vh: 360, // size of the world view in world pixels
    baseScale: 2, zoomOffset: 0, zoomScale: 1, toast: null,
  });

  /* ------------------------------------------------------- persistence */

  const STORE = 'rocketracer.v1';
  const CONTROLS_V = 2; // the touch layout's version (see load)
  function load() {
    try {
      const s = JSON.parse(window.localStorage.getItem(STORE) || '{}');
      G.best = s.best || {};
      G.crt = s.crt !== false;
      G.autoFull = s.autoFull !== false;
      G.controls = cleanControls(s.controls);
      // layout 2 put GAS above the fire stick and BRAKE beside it, following the stick: spots saved for the
      // buttons before then are dropped (moved sticks keep theirs)
      if (s.controlsV !== CONTROLS_V) for (const o in G.controls) ['brake', 'gas', 'defer'].forEach(function (n) { delete G.controls[o][n]; });
      RR.input.steerSlide = s.steerSlide === true || s.steerButtons === true; // the steer stick swapped for the slider (it was < and > buttons)
      RR.audio.muted = !!s.muted;
      if (s.diff >= 0 && s.diff < DIFFS.length) G.diffIdx = s.diff;
      if (s.track >= 0 && s.track < RR.TRACKS.length) G.trackIdx = s.track;
      if (Number.isInteger(s.zoom) && Math.abs(s.zoom) <= 2) G.zoomOffset = s.zoom;
      G.name = RR.net.cleanName(s.name);
      if (typeof s.pid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s.pid)) G.pid = s.pid;
      if (s.mode >= 0 && s.mode < MODES.length) G.modeIdx = s.mode;
      if (s.arena >= 0 && s.arena < RR.ARENAS.length) G.arenaIdx = s.arena;
      G.humansOnly = s.humansOnly === true;
      loadProgress(s.prog);
      G.hist = RR.records.cleanHistory(s.hist);
    } catch (e) { /* storage unavailable: play without saved records */ }
    if (!G.hist) G.hist = RR.records.emptyHistory();
    if (!G.name) G.name = RR.net.randomName();
    if (!G.pid) G.pid = RR.net.randomId();
  }
  G.saveSettings = function () { save(); };
  function save() {
    try {
      window.localStorage.setItem(STORE, JSON.stringify({
        best: G.best, crt: G.crt, muted: RR.audio.muted, autoFull: G.autoFull, controls: G.controls, diff: G.diffIdx, track: G.trackIdx,
        name: G.name, pid: G.pid, zoom: G.zoomOffset,
        mode: G.modeIdx, arena: G.arenaIdx, prog: G.prog, steerSlide: RR.input.steerSlide, controlsV: CONTROLS_V, hist: G.hist,
        humansOnly: G.humansOnly,
      }));
    } catch (e) { /* ignore */ }
  }
  G.save = save;

  function applyCrt() {
    document.body.classList.toggle('nocrt', !G.crt);
  }

  /* ------------------------------------------------------------- hangar */

  function count(v) { return Number.isInteger(v) && v > 0 ? v : 0; }
  const RENAMED = { defer: 'rewind' }; // the gate deferral took the do-over's place: its upgrades and button spot carry over

  /** Saved progress is only trusted as far as the rules allow. */
  function loadProgress(p) {
    const pr = G.prog;
    if (!p || typeof p !== 'object') return;
    pr.wins = count(p.wins);
    pr.points = Math.min(count(p.points), G.pointCap()); // (the wins, just above, set the cap)
    pr.credits = count(p.credits);
    // powerup levels 1-3 (only those above 1 are kept), and no more unspent points than they have room for
    pr.pup = {};
    let levelsLeft = 0;
    POWER.forEach(function (pw) {
      const v = p.pup && (pw.id in p.pup ? p.pup[pw.id] : p.pup[RENAMED[pw.id]]);
      const lv = Number.isInteger(v) ? clamp(v, 1, POWER_MAX) : 1;
      if (lv > 1) pr.pup[pw.id] = lv;
      levelsLeft += POWER_MAX - lv;
    });
    pr.upts = Math.min(count(p.upts), levelsLeft);
    HULLS.forEach(function (h, i) {
      const saved = p.up && p.up[h.id], up = upgrades(i);
      let spent = 0;
      for (let k = 0; k < STATS.length; k++) {
        up[k] = Math.min(count(Array.isArray(saved) ? saved[k] : 0), h.cap[k] - h.base[k]);
        spent += up[k];
      }
      if (spent > Math.min(pr.points, room(i))) up.fill(0);
    });
    pr.ship = p.ship >= 0 && p.ship < HULLS.length && pr.wins >= HULLS[p.ship].wins ? p.ship : 0;
  }

  /** Points spent on ship `i`, one count per stat. */
  function upgrades(i) {
    const id = HULLS[i].id;
    return G.prog.up[id] || (G.prog.up[id] = STATS.map(function () { return 0; }));
  }
  G.shipUnlocked = function (i) { return this.prog.wins >= HULLS[i].wins; };
  /** The most stat points you can hold: what the roomiest unlocked ship can use. */
  G.pointCap = function () {
    let m = 0;
    for (let i = 0; i < HULLS.length; i++) if (this.shipUnlocked(i)) m = Math.max(m, room(i));
    return m;
  };
  /** The points ship `i` can use: all you have, up to its room. */
  G.shipPoints = function (i) { return Math.min(this.prog.points, room(i)); };
  G.statLevel = function (i, k) { return HULLS[i].base[k] + upgrades(i)[k]; };
  /** Every ship can spend every point you have earned (up to its room), so a new ship never starts from nothing. */
  G.pointsLeft = function (i) {
    return this.shipPoints(i) - upgrades(i).reduce(function (a, b) { return a + b; }, 0);
  };
  /** Put a point into stat `k` of ship `i` (d = 1) or take one back (d = -1). */
  G.spend = function (i, k, d) {
    const up = upgrades(i), h = HULLS[i];
    const ok = this.shipUnlocked(i) && (d > 0 ? this.pointsLeft(i) > 0 && h.base[k] + up[k] < h.cap[k] : up[k] > 0);
    if (!ok) { RR.audio.sfx('deny'); return false; }
    up[k] += d;
    RR.audio.sfx(d > 0 ? 'power' : 'select');
    save();
    return true;
  };
  G.powerLevel = function (id) { return this.prog.pup[id] || 1; };
  /** Upgrade levels still to take, across every powerup. */
  G.powerRoom = function () {
    const g = this;
    return POWER.reduce(function (a, p) { return a + POWER_MAX - g.powerLevel(p.id); }, 0);
  };
  /** One upgrade point for UPGRADE_PRICE credits, while the points in hand are fewer than the room left. */
  G.canBuyUpgrade = function () { return this.prog.credits >= UPGRADE_PRICE && this.prog.upts < this.powerRoom(); };
  G.buyUpgrade = function () {
    if (!this.canBuyUpgrade()) { RR.audio.sfx('deny'); return false; }
    this.prog.credits -= UPGRADE_PRICE;
    this.prog.upts++;
    RR.audio.sfx('power');
    save();
    return true;
  };
  /** Put an upgrade point into powerup `id` (d = 1) or take one back (d = -1), like stat points. */
  G.powerSpend = function (id, d) {
    const pr = this.prog, lv = this.powerLevel(id);
    const ok = !!powerOf(id) && (d > 0 ? pr.upts > 0 && lv < POWER_MAX : lv > 1);
    if (!ok) { RR.audio.sfx('deny'); return false; }
    pr.upts -= d;
    if (lv + d > 1) pr.pup[id] = lv + d; else delete pr.pup[id];
    RR.audio.sfx(d > 0 ? 'power' : 'select');
    save();
    return true;
  };

  /** What the stat levels of ship `i` come to in the simulation. */
  function loadout(i) {
    return loadoutOf(STATS.map(function (st, k) { return G.statLevel(i, k); }));
  }
  /** What a list of five stat levels comes to in the simulation. */
  function loadoutOf(levels) {
    const m = STATS.map(function (st, k) { return 1 + st.step * (levels[k] - STAT_MID); });
    // top speed is thrust / drag, so more speed at the same acceleration means less drag
    return { accK: m[0], dragK: m[0] / m[1], turnK: m[2], maxHp: Math.round(C.MAXHP * m[3]), dmg: m[4] };
  }
  RR.loadout = loadout;
  RR.loadoutOf = loadoutOf;
  const STOCK = { accK: 1, dragK: 1, turnK: 1, maxHp: C.MAXHP, dmg: 1 };

  G.openHangar = function () {
    if (this.state !== 'title') return;
    this.state = 'hangar';
    this.hangarRow = 0;
    this.hangarPage = 'ship';
    this.hangarShip = this.prog.ship;
    RR.audio.sfx('select');
  };
  G.closeHangar = function () {
    if (this.state !== 'hangar') return;
    RR.audio.sfx('confirm');
    this.startRace(true); // the attract mode flies the ship you picked
  };
  /** The hangar's two pages: 'ship' (the ship and its stats) and 'power' (powerup upgrades). */
  G.hangarTab = function (page) {
    if (this.state !== 'hangar' || this.hangarPage === page) return;
    this.hangarPage = page;
    this.hangarRow = page === 'ship' ? 0 : STATS.length + 1;
    RR.audio.sfx('select');
  };
  /** Look at the next ship; an unlocked one becomes the ship you fly. */
  G.hangarBrowse = function (d) {
    const n = HULLS.length;
    this.hangarShip = (this.hangarShip + d + n) % n;
    if (this.shipUnlocked(this.hangarShip)) { this.prog.ship = this.hangarShip; save(); }
    RR.audio.sfx('select');
  };

  /**
   * A finished event in the player's history (kept with their progress).
   * Offline it goes to their history on the server too; online, the
   * multiplayer server, which saw it, records it there itself.
   */
  function recordGame(g, mode, place, win, online) {
    RR.records.addGame(g.hist, mode, place, win);
    save();
    if (!online) RR.net.game(mode, place, win);
  }

  /** Stat points and wins for a finished event; new ships unlock on wins. */
  function award(g, place) {
    const pr = g.prog, had = HULLS.map(function (h, i) { return g.shipUnlocked(i); });
    const earned = Math.max(0, 4 - place) + (place === 1 ? g.diffIdx : 0);
    if (place === 1) pr.wins++; // first, so a ship this win unlocks raises the cap straight away
    const pts = Math.max(0, Math.min(earned, g.pointCap() - pr.points)); // stat points stop at the cap
    const credits = Math.round(PAY[place - 1] * PAY_MULT[g.diffIdx]);
    pr.points += pts;
    pr.credits += credits;
    g.reward = {
      pts: pts, capped: pts < earned, credits: credits,
      unlocked: HULLS.filter(function (h, i) { return !had[i] && g.shipUnlocked(i); }).map(function (h) { return h.name; }),
    };
    save();
  }

  /* ------------------------------------------------------------- set-up */

  function makeAI(diff) {
    return {
      skill: diff.speed + (Math.random() * 2 - 1) * diff.spread,
      aggro: diff.aggro, rubber: diff.rubber, margin: Math.random() * 14,
      ox: 0, oy: 0, cpFor: -1, pick: null, pickT: 0,
      stuck: 0, stuckN: 0, rev: 0, revTurn: 1, fireT: 1.5 + Math.random() * 2,
      tgt: null, tgtT: 0, wobble: (1.02 - diff.speed) * 0.8, // combat: who to chase, how shaky the aim
    };
  }

  function makeShip(i, racer, slot, lo) {
    return {
      accK: lo.accK, dragK: lo.dragK, turnK: lo.turnK, maxHp: lo.maxHp, dmg: lo.dmg,
      kills: 0, deaths: 0, gone: false, elim: 0, hitBy: null, hitT: 0, zoned: false,
      idx: i, name: racer.name, team: racer.team, design: racer.design,
      sprite: Art.ship(racer.design, racer.team), white: Art.shipWhite(racer.design),
      ghost: Art.tint(Art.ship(racer.design, racer.team), '#a98bff'),
      ports: Art.shipPorts(racer.design), colors: Art.TEAMS[racer.team],
      x: slot.x, y: slot.y, vx: 0, vy: 0, angle: slot.a, angVel: 0,
      spawn: { x: slot.x, y: slot.y, a: slot.a },
      hp: lo.maxHp, shield: 0, nitro: 0, stun: 0, spinRate: 0, emp: 0, invuln: 0, dead: 0,
      weapon: null, ammo: 0, cool: 0, prevFire: false, stickHeld: false, stickAim: null, launch: null,
      used: {}, fresh: false, // powerups picked up and used this race (for the leaderboard), and a weapon pick-up not yet fired
      plv: {}, // powerup levels: the player's upgrades (rivals and the attract mode stay at level 1)
      nextCp: 0, cpCount: 0, lap: 0, lapStart: 0, lapTimes: [], bestLap: 0,
      finished: false, finishTime: 0, place: i + 1, progress: 0,
      input: { turn: 0, thrust: 0, brake: 0, fire: false },
      ai: null, speedMult: 1, thrusting: 0, exh: 0, smk: 0, hitFlash: 0, out: false, wrong: 0,
      defer: 0, // gate deferrals held
      side: 0, flag: null, caps: 0, reflag: 0, returns: 0, // capture the flag: team, the flag carried, captures, Replace Flags held, flags touched home
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

  /** What a pick-up spot holds next. `noReflag`: anything but a Replace Flag (the map has its share). */
  function roll(kind, g, noReflag) {
    let table = ROLL[(g.ctf ? 'F' : g.combat ? 'C' : '') + kind] || ROLL[kind];
    if (noReflag) table = table.filter(function (t) { return t[0] !== 'reflag'; });
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
    G.wantFull = RR.input.touchMode && G.autoFull; // phones: the first tap goes full screen
    save();
    applyCrt();
    Art.init();
    RR.net.init();
    RR.audio.music({ on: true, tempo: 0.9, lead: true });
    G.startRace(true);
  };

  /** How many teams fly on a map: one per base (capture the flag), else none. */
  function teamsOf(tr) { return tr.bases ? tr.bases.length : 0; }

  /**
   * Capture the flag: every ship's side (i % teams: red, blue, and green on
   * a three-team map), the AI's jobs (the last of each team guards the base,
   * the rest go for a flag), and every flag standing on its base.
   * Elsewhere: no flags.
   */
  function setupTeams(g) {
    const n = g.ctf ? teamsOf(g.track) : 2;
    g.teams = n;
    g.caps = [];
    for (let k = 0; k < n; k++) g.caps.push(0);
    g.flags = null;
    g.plan = null; // (the AI's team plans: see ctfPlan)
    if (!g.ctf) return;
    for (const s of g.ships) {
      s.side = s.idx % n;
      if (s.ai) s.ai.role = s.idx >= g.ships.length - n ? 'defend' : 'attack';
    }
    g.flags = g.track.bases.map(function (b, side) {
      return { side: side, home: b, x: b.x, y: b.y, state: 'home', carrier: null, dropT: 0 };
    });
  }

  /** Reset the world. `demo` runs an all-AI race behind the title screen. */
  G.startRace = function (demo) {
    const g = this;
    RR.input.aimDir = null; // the guns point straight ahead unless A or D is held
    RR.input.gasLatch = false; // and GAS starts off
    g.mode = MODES[g.modeIdx].id;
    g.combat = g.mode !== 'race';
    g.ctf = g.mode === 'ctf';
    g.royale = g.mode === 'royale' && !demo; // the attract mode just brawls on, with respawns
    const tr = (g.track = RR.getMap(g.mode, g.combat ? g.arenaIdx : g.trackIdx));
    const diff = demo ? DEMO_DIFF : DIFFS[g.diffIdx];
    const hull = HULLS[g.prog.ship], turn = Math.floor(Math.random() * 6);
    g.demo = demo;
    g.online = false; g.server = false; g.events = [];
    g.laps = demo ? 1e9 : tr.laps;
    g.ships = RACERS.map(function (r, i) {
      // racing, the player starts at the back; in an arena everyone gets a random spawn point
      // (capture the flag: each team beside its own base, in its own colours)
      const slot = tr.grid[g.ctf ? i : g.combat ? (i + turn) % 6 : i === 0 ? 5 : i - 1];
      const team = g.ctf ? i % teamsOf(tr) : r.team;
      const s = i === 0 ? makeShip(i, { name: r.name, team: team, design: hull.design }, slot, loadout(g.prog.ship))
        : makeShip(i, { name: r.name, team: team, design: r.design }, slot, STOCK);
      if (demo || i > 0) s.ai = makeAI(diff);
      if (g.combat && i > 0) s.dmg = diff.dmg;
      if (g.royale) s.dmg *= C.ROYALE_DMG;
      return s;
    });
    g.player = g.ships[0];
    setupTeams(g);
    // what the player is flying, for the leaderboard (the hangar cannot change it mid-race)
    g.player.setup = {
      ship: hull.id, stats: STATS.map(function (st, k) { return G.statLevel(g.prog.ship, k); }),
      levels: Object.assign({}, g.prog.pup),
    };
    if (!demo) g.player.plv = Object.assign({}, g.prog.pup); // upgrades make the player's pick-ups stronger
    g.order = g.ships.slice();
    g.rocks = tr.rocks.map(makeRock);
    g.pickups = tr.pickups.map(function (p, i) {
      return { x: p.x, y: p.y, kind: p.kind, type: roll(p.kind, g), on: true, timer: 0, ph: i * 1.7 };
    });
    capReflags(g);
    g.shots = []; g.mines = []; g.waves = []; g.parts = []; g.rings = []; g.texts = [];
    g.raceTime = 0;
    g.phase = demo ? 'race' : 'countdown';
    g.count = 3.9;
    g.cam.x = g.player.x; g.cam.y = g.player.y;
    g.shake = 0; g.flash = 0; g.msg = null;
    g.playerDone = false; g.doneT = 0; g.newRecord = false;
    g.zone = g.royale ? { r: tr.radius * 1.42, r0: tr.radius * 1.42 } : null; // starts around the whole arena
    g.over = false; g.elimN = 0; g.feed = []; g.spec = null; g.reward = null; g.fightScore = null;
    g.state = demo ? 'title' : 'play';
  };

  /*
   * An online race or fight. The multiplayer server runs it headless (with
   * `server` set: every human ship takes its controls from `netInput`, and
   * effects become `events` for the players' screens); each player's game
   * builds the same world with `me` = their own seat, to draw and predict.
   *   opts: { mode, track, diff, me, server,
   *           seats: [{ name, team, design, hull, human, stats, levels }] }
   * `track` is a course index for a Grand Prix, an arena index for a fight.
   */
  G.startOnline = function (opts) {
    const g = this, seats = opts.seats, turn = opts.turn || 0;
    if (!opts.server) { RR.input.aimDir = null; RR.input.gasLatch = false; }
    g.modeIdx = Math.max(0, MODES.findIndex(function (m) { return m.id === opts.mode; }));
    g.mode = MODES[g.modeIdx].id;
    g.combat = g.mode !== 'race';
    g.ctf = g.mode === 'ctf';
    g.royale = g.mode === 'royale';
    if (g.combat) g.arenaIdx = opts.track; else g.trackIdx = opts.track;
    const tr = (g.track = RR.getMap(g.mode, opts.track));
    const diff = DIFFS[opts.diff] || DIFFS[1];
    g.diffIdx = DIFFS.indexOf(diff);
    g.demo = false;
    g.online = true;
    g.server = !!opts.server;
    g.events = [];
    g.laps = tr.laps;
    g.ships = seats.map(function (seat, i) {
      const slot = tr.grid[g.ctf ? i : (i + turn) % tr.grid.length];
      const s = makeShip(i, { name: seat.name, team: g.ctf ? i % teamsOf(tr) : seat.team, design: seat.design }, slot,
        seat.human ? loadoutOf(seat.stats) : STOCK);
      s.human = !!seat.human;
      if (s.human) {
        s.plv = Object.assign({}, seat.levels);
        s.setup = { ship: seat.hull, stats: seat.stats.slice(), levels: Object.assign({}, seat.levels) };
        s.netInput = { turn: 0, thrust: 0, brake: 0, fire: false, aim: null, stick: false };
      } else {
        s.ai = makeAI(diff);
        if (g.combat) s.dmg = diff.dmg;
      }
      if (g.royale) s.dmg *= C.ROYALE_DMG;
      return s;
    });
    // the server has no player of its own: a stand-in nobody is ever compared equal to
    g.player = g.server ? { x: tr.center ? tr.center.x : 0, y: tr.center ? tr.center.y : 0, progress: 0, gone: false, dead: 0, side: -1 }
      : g.ships[opts.me];
    setupTeams(g);
    g.order = g.ships.slice();
    g.rocks = tr.rocks.map(makeRock);
    g.pickups = tr.pickups.map(function (p, i) {
      return { x: p.x, y: p.y, kind: p.kind, type: roll(p.kind, g), on: true, timer: 0, ph: i * 1.7 };
    });
    capReflags(g);
    g.shots = []; g.mines = []; g.waves = []; g.parts = []; g.rings = []; g.texts = [];
    g.raceTime = 0;
    g.phase = 'countdown';
    g.count = 3.9;
    g.cam.x = g.player.x; g.cam.y = g.player.y;
    g.shake = 0; g.flash = 0; g.msg = null;
    g.playerDone = false; g.doneT = 0; g.newRecord = false;
    g.zone = g.royale ? { r: tr.radius * 1.42, r0: tr.radius * 1.42 } : null;
    g.over = false; g.elimN = 0; g.feed = []; g.spec = null; g.reward = null; g.fightScore = null;
    g.state = 'play';
  };

  /* ------------------------------------------------- online, on a player's screen */

  /**
   * One 1/120 s step of an online game on a player's screen. Only the
   * player's own ship is simulated here (see G.predictShip); the rest of
   * the world comes from the server's snapshots (RR.mp).
   */
  G.onlineStep = function (dt) {
    const g = this, p = g.player;
    g.t += dt;
    if (g.flash > 0) g.flash -= dt * 2;
    if (g.msg) { g.msg.t += dt; if (g.msg.t >= g.msg.dur) g.msg = null; }
    for (let i = g.feed.length - 1; i >= 0; i--) {
      g.feed[i].t += dt;
      if (g.feed[i].t > 5) g.feed.splice(i, 1);
    }
    for (const a of g.rocks) a.rot += a.rs * dt; // asteroids tumble here; the server only moves them
    // a hit flashes a ship white for a moment: snapshots start the flash, this ends it (every ship, own included)
    for (const s of g.ships) if (s.hitFlash > 0) s.hitFlash -= dt;
    if (!g.combat && g.phase === 'race' && p.dead <= 0 && !p.finished) { // "wrong way"
      const cp = g.track.cps[p.nextCp], dx = cp.x - p.x, dy = cp.y - p.y;
      const sp = Math.hypot(p.vx, p.vy), d = Math.hypot(dx, dy) || 1;
      if (sp > 90 && (p.vx * dx + p.vy * dy) / (sp * d) < -0.45) p.wrong += dt;
      else p.wrong = Math.max(0, p.wrong - dt * 3);
    }
    if (p.gone && (!g.spec || g.spec.gone)) g.spec = g.order.find(function (s) { return !s.gone; }) || null;
    updateFx(g, dt);
    updateCamera(g, dt);
  };

  /**
   * Fly ship `s` one step with these controls: the player's own ship,
   * predicted so it answers at once, and replayed on top of each snapshot.
   * Replays (`quiet`) make no exhaust; nothing here does damage.
   */
  G.predictShip = function (s, inp, dt, quiet) {
    const g = this, i = s.input;
    i.turn = inp.turn; i.thrust = inp.thrust; i.brake = inp.brake; i.fire = inp.fire; i.aim = inp.aim; i.stick = inp.stick; i.keyAim = !!inp.keyAim;
    g.predicting = true;
    const parts = g.parts.length, flash = s.hitFlash; // (the hit flash runs on real time, in onlineStep, not per replayed step)
    updateShip(s, g, dt, true);
    s.hitFlash = flash;
    if (quiet) g.parts.length = parts;
    g.predicting = false;
  };

  /** Online: what the player earned in a race or fight that just ended (once). */
  G.awardOnline = function (place, win) {
    award(this, place);
    recordGame(this, this.mode, place, !!win, true);
    return this.reward;
  };

  /** Online: back to the room's lobby (the attract race plays behind it). */
  G.toOnlineLobby = function () {
    this.startRace(true);
    this.state = 'online';
  };

  /** Online: a bot flies ship `s` while its player is away (on), or hands it back when they return (off). */
  G.botTakeover = function (s, on) {
    if (on) { if (!s.ai) { s.ai = makeAI(DIFFS[this.diffIdx] || DIFFS[1]); s.botFlown = !s.finished; } return; }
    if (s.finished || !s.human) return; // a finished ship stays on autopilot
    s.ai = null;
    s.netInput = { turn: 0, thrust: 0, brake: 0, fire: false, aim: null, stick: false };
  };

  G.begin = function () {
    if (RR.input.touchMode && this.autoFull) this.wantFull = true;
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
  /**
   * The world's high score tables, in the order LEFT and RIGHT go through
   * them: each course's race times, each fight mode's points, then the
   * pilots with the most wins.
   */
  G.boards = function () { return RR.TRACKS.map(function (t) { return t.id; }).concat(RR.records.FIGHTS, ['pilots']); };
  /** The tables, opening on the one for the event (and course) on the menu. */
  G.showBoard = function () {
    if (this.state !== 'title' || !RR.net.online) return;
    const mode = MODES[this.modeIdx].id;
    this.boardId = mode === 'race' ? RR.TRACKS[this.trackIdx].id : mode;
    this.loadBoard();
    RR.audio.sfx('select');
    this.state = 'board';
    this.boardSel = -1; this.boardCard = null;
  };
  G.loadBoard = function () {
    if (this.boardId === 'pilots') RR.net.loadPilots('all');
    else RR.net.load(this.boardId);
  };
  /** The next table (d = 1) or the one before (d = -1). */
  G.turnBoard = function (d) {
    if (this.state !== 'board') return;
    const list = this.boards(), i = Math.max(0, list.indexOf(this.boardId));
    this.boardId = list[(i + d + list.length) % list.length];
    this.boardSel = -1; this.boardCard = null;
    this.loadBoard();
    RR.audio.sfx('select');
  };
  /** The player's own history: games played, wins and podium places in each event (Y on the menu). */
  G.showHistory = function () {
    if (this.state !== 'title') return;
    RR.net.loadPilots('all'); // (for the world rank by wins)
    RR.audio.sfx('select');
    this.state = 'history';
  };
  G.closeHistory = function () {
    if (this.state === 'history') { this.state = 'title'; RR.audio.sfx('select'); }
  };
  G.closeBoard = function () {
    if (this.state === 'board') { this.state = 'title'; this.boardCard = null; RR.audio.sfx('select'); }
  };
  /** A pilot's card: their rocket, its stat levels and the powerups they used. `row` is { e, rank }. */
  G.openCard = function (row) {
    if (this.state !== 'board' || !row || !row.e) return;
    this.boardCard = row;
    RR.audio.sfx('confirm');
  };
  G.closeCard = function () {
    if (this.boardCard) { this.boardCard = null; RR.audio.sfx('select'); }
  };
  /** Sound on/off (M key, or the SOUND button on touch screens). Remembered between visits. */
  G.toggleSound = function () {
    RR.audio.setMuted(!RR.audio.muted);
    save();
    if (!RR.audio.muted) RR.audio.sfx('select'); // so turning it on is audible straight away
  };

  /*
   * Full screen on phones. Browsers only allow it from inside a tap, and the
   * moment every browser accepts is the finger lifting. A tap is acted on as
   * the finger lands, so code here only *asks* (wantFull) and input.js grants
   * it on the next finger-lift (G.onGestureEnd).
   *
   * Phones go full screen on the first tap and at the start of each race,
   * unless the player turned it off with the button (remembered).
   *
   * Not iPhones and iPads (every browser on them is Safari underneath). An
   * iPhone only lets videos go full screen, and an iPad drops out of full
   * screen on any downward swipe, which steering makes all the time (WebKit
   * keeps that gesture on purpose; a page cannot switch it off). Both get an
   * "Add to Home Screen" tip instead, which opens the game in its own window,
   * without Safari's bars and without the swipe.
   */
  function appleTouch() {
    const ua = navigator.userAgent || '';
    // iPadOS asks for desktop sites as a Mac; a Mac has no touch screen
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }
  function fsEnabled() { const d = document; return !appleTouch() && !!(d.fullscreenEnabled || d.webkitFullscreenEnabled); }
  function isFull() { const d = document; return !!(d.fullscreenElement || d.webkitFullscreenElement); }
  function enterFull() {
    if (isFull() || !fsEnabled()) return;
    const el = document.documentElement;
    try {
      const r = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen();
      if (r && r.catch) r.catch(function () { /* refused: the next finger-lift can try again */ });
    } catch (e) { /* not available here */ }
  }
  function exitFull() {
    const d = document;
    try {
      const r = (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      if (r && r.catch) r.catch(function () {});
    } catch (e) { /* ignore */ }
  }
  G.canFullscreen = fsEnabled;
  G.isFullscreen = isFull;


  /* ------------------------------------------------- moving the controls */

  const CONTROL_NAMES = ['steer', 'fire', 'brake', 'gas', 'defer']; // (steering by a drag anywhere else needs no spot)

  /** Keep only well-formed saved positions (fractions of the screen). */
  function cleanControls(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    ['land', 'port'].forEach(function (o) {
      const src = raw[o];
      if (!src || typeof src !== 'object') return;
      CONTROL_NAMES.forEach(function (n) {
        const p = src[n] || src[RENAMED[n]];
        if (p && isFinite(p.x) && isFinite(p.y)) (out[o] = out[o] || {})[n] = { x: clamp(+p.x, 0, 1), y: clamp(+p.y, 0, 1) };
      });
    });
    return out;
  }

  /** Layouts are kept separately for a phone held sideways and upright. */
  G.orientation = function () { return this.W >= this.H ? 'land' : 'port'; };

  /** Pause > MOVE CONTROLS: drag the sticks and buttons where you want them. */
  G.editControls = function () {
    if (this.state !== 'paused') return;
    this.state = 'layout';
    RR.audio.sfx('select');
  };
  G.closeControls = function () {
    if (this.state !== 'layout') return;
    this.state = 'paused';
    save();
    RR.audio.sfx('confirm');
  };
  /** Back to the standard spots, for the way the phone is held now. */
  G.resetControls = function () {
    delete this.controls[this.orientation()];
    save();
    RR.audio.sfx('select');
  };

  /** While moving controls: each finger that lands on a control drags it. */
  function dragControls(g) {
    const L = RR.touchLayout(g.W, g.H, g.inset), I = RR.input, o = g.orientation();
    for (const id in I.pointers) {
      const p = I.pointers[id];
      if (p.drag === undefined) {
        p.drag = null;
        for (const n of CONTROL_NAMES) {
          const c = L.centre[n], reach = n === 'fire' || n === 'steer' ? L[n].grab : 30;
          if (Math.hypot(p.sx - c.x, p.sy - c.y) <= reach) { p.drag = n; p.ox = c.x - p.sx; p.oy = c.y - p.sy; break; }
        }
      }
      if (!p.drag) continue;
      const spots = g.controls[o] || (g.controls[o] = {});
      spots[p.drag] = { x: clamp((p.x + p.ox) / g.W, 0, 1), y: clamp((p.y + p.oy) / g.H, 0, 1) };
    }
  }

  /** True on an iPhone or iPad in the browser: the way to full screen there is Add to Home Screen. */
  G.homeScreenTip = function () {
    if (!RR.input.touchMode || !appleTouch()) return false;
    const mm = function (q) { try { return window.matchMedia(q).matches; } catch (e) { return false; } };
    const installed = navigator.standalone === true || mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)');
    return !installed;
  };

  /** Called by input.js on every finger-lift: the moment browsers allow full screen. */
  G.onGestureEnd = function () {
    if (!this.wantFull) return;
    this.wantFull = false;
    enterFull();
  };

  /** The FULLSCREEN / EXIT FULL button and the F key. The choice is remembered. */
  G.fullscreen = function () {
    if (isFull()) { this.autoFull = false; this.wantFull = false; exitFull(); }
    else if (appleTouch()) { toast(this, 'SHARE > ADD TO HOME SCREEN'); return; } // F on an iPad keyboard
    else {
      this.autoFull = true;
      this.wantFull = true; // a tap: granted as the finger lifts
      if (!RR.input.touchMode) enterFull(); // a key press (F) can go straight away
    }
    save();
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
    RR.input.focus(); // keys back to the game
  };
  G.pause = function () {
    if (this.online) { this.mpMenu = !this.mpMenu; return; } // online the race goes on: a menu instead
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
  G.setMode = function (d) {
    this.modeIdx = (this.modeIdx + d + MODES.length) % MODES.length;
    RR.audio.sfx('select');
    this.startRace(true);
    save();
  };
  /** Where the event on the menu is held: its course, arena or flag map (an index into RR.mapsFor(mode)). */
  G.mapIdx = function () {
    const mode = MODES[this.modeIdx].id, n = RR.mapsFor(mode).length;
    return (mode === 'race' ? this.trackIdx : this.arenaIdx) % n;
  };
  /** Next course, or next arena (or flag map) in the combat modes. */
  G.setTrack = function (d) {
    if (this.modeIdx !== 0) {
      const m = RR.mapsFor(MODES[this.modeIdx].id).length;
      this.arenaIdx = (this.mapIdx() + d + m) % m;
    } else {
      const n = RR.TRACKS.length;
      this.trackIdx = (this.trackIdx + d + n) % n;
    }
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
    if (g.online && !g.server && !g.replaying) return; // online, sounds arrive as the server's events
    if (g.server) { g.events.push(['s', name, Math.round(x || 0), Math.round(y || 0), v === undefined ? 1 : +v.toFixed(2)]); return; }
    let vol = v === undefined ? 1 : v;
    if (x !== undefined) vol *= clamp(1.2 - Math.hypot(x - g.cam.x, y - g.cam.y) / 460, 0, 1);
    if (vol > 0.03) RR.audio.sfx(name, vol);
  }

  function part(g, x, y, vx, vy, life, size, ramp, drag, layer) {
    if (g.server || g.parts.length > 1500) return;
    g.parts.push({ x: x, y: y, vx: vx, vy: vy, life: life, max: life, size: size, ramp: ramp, drag: drag || 0, layer: layer || 0 });
  }

  function burst(g, x, y, n, speed, ramp, life, size) {
    if (g.predicting || !near(g, x, y, 120)) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, v = speed * (0.25 + Math.random() * 0.75);
      // size 0 = start chunky and shrink with age (see drawParts)
      part(g, x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.5 + Math.random() * 0.5),
        size === undefined ? (Math.random() < 0.35 ? 2 : 1) : size, ramp, 2.5, 1);
    }
  }

  function ringFx(g, x, y, r0, r1, dur, color) {
    if (g.server) return;
    g.rings.push({ x: x, y: y, r0: r0, r1: r1, t: 0, dur: dur, color: color });
  }

  function boom(g, x, y, k) {
    if (g.server) { g.events.push(['b', Math.round(x), Math.round(y), +k.toFixed(2)]); return; }
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
    if (g.server) return;
    g.texts.push({ x: x, y: y, text: text, color: color, t: 0, dur: 1 });
  }

  /* ----------------------------------------------------- damage + death */

  /** Capture the flag: the ship holding the Replace Flag, if any does. */
  function reflagHolder(g) {
    for (const s of g.ships) if (s.reflag > 0 && !s.gone) return s;
    return null;
  }
  G.reflagHolder = function () { return this.ctf ? reflagHolder(this) : null; };
  /**
   * Capture the flag: is there room for another Replace Flag on the map (not
   * counting spot `except`)? There are only ever REFLAG_MAX of them in the
   * match, lying on the map or held: none appears while a pilot holds one.
   */
  function reflagRoom(g, except) {
    let n = reflagHolder(g) ? 1 : 0;
    for (const q of g.pickups) if (q !== except && q.on && q.type === 'reflag') n++;
    return n < C.REFLAG_MAX;
  }
  /** At the start: any Replace Flags past REFLAG_MAX become something else. */
  function capReflags(g) {
    if (!g.ctf) return;
    let n = 0;
    for (const p of g.pickups) if (p.type === 'reflag' && ++n > C.REFLAG_MAX) p.type = roll(p.kind, g, true);
  }

  /** Capture the flag: are a and b on the same team? (Never outside it.) */
  function ally(g, a, b) { return !!(g.ctf && a && b && a.side === b.side); }

  function hurt(s, g, dmg, by) {
    if (g.online && !g.server) return; // online, the server decides every hit
    if (s.dead > 0 || s.invuln > 0 || s.shield > 0) return;
    if (by && by !== s) { s.hitBy = by; s.hitT = g.t; }
    s.hp -= dmg;
    s.hitFlash = 0.12;
    if (s.hp <= 0) destroy(s, g);
  }

  /** A weapon hit: impulse, optional spin-out, damage. Shields soak it up. */
  function zap(s, g, dmg, stun, ix, iy, by) {
    if (s.dead > 0 || s.invuln > 0) return;
    if (by && by !== s && ally(g, s, by)) return; // no friendly fire
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
    hurt(s, g, dmg, by);
  }

  function destroy(s, g) {
    dropFlag(g, s);
    if (s.reflag > 0 && g.ctf) { s.reflag = 0; flagNews(g, 'rlost', s.side, s); } // the Replace Flag is lost with its holder
    boom(g, s.x, s.y, 1.6);
    s.hp = 0; s.dead = g.ctf ? C.CTF_RESPAWN : 2; s.vx = s.vy = 0;
    s.weapon = null; s.ammo = 0; s.nitro = 0; s.shield = 0; s.stun = 0; s.emp = 0; s.thrusting = 0;
    if (s === g.player && !g.demo && !g.playerDone) {
      g.shake = 12; g.flash = 0.6;
      banner(g, 'WRECKED!', PAL.alarm, 1.5, 3);
      RR.input.buzz(160);
    }
    // whoever landed a hit in the last few seconds gets the kill, even if a planet finished the job
    const by = s.hitBy && g.t - s.hitT < C.KILL_CREDIT ? s.hitBy : null;
    s.hitBy = null;
    if (g.combat && !g.over) score(g, s, by);
  }

  /** Combat modes: count the kill, and in a battle royale take the loser out for good. */
  function score(g, victim, killer) {
    victim.deaths++;
    if (killer) killer.kills++;
    g.feed.push({ a: killer ? killer.name : '', b: victim.name, zone: !killer && victim.zoned, t: 0 });
    if (g.server) g.events.push(['k', killer ? killer.idx : -1, victim.idx, !killer && victim.zoned ? 1 : 0]);
    if (g.feed.length > 3) g.feed.shift();
    if (killer === g.player && !g.demo && !g.playerDone) {
      banner(g, 'WRECKED ' + victim.name + '!', PAL.yellow, 1.3, 3);
      RR.audio.sfx('power');
    }
    if (!g.royale) return;
    victim.gone = true;
    victim.dead = 1e9;
    victim.elim = ++g.elimN;
    if (victim === g.player) {
      g.spec = killer; // watch the rest of it from the winner's side
      playerResult(g);
    }
  }

  /** Where to come back in an arena: the spawn point furthest from trouble. */
  function arenaSpawn(s, g) {
    let best = g.track.grid[g.ctf ? s.side : 0], bd = -1;
    for (const sp of g.track.grid) {
      if (g.ctf && sp.side !== s.side) continue; // capture the flag: back beside your own base
      let d = 1e9;
      for (const o of g.ships) if (o !== s && o.dead <= 0 && !ally(g, o, s)) d = Math.min(d, Math.hypot(o.x - sp.x, o.y - sp.y));
      if (d > bd) { bd = d; best = sp; }
    }
    return best;
  }

  function respawn(s, g) {
    const cps = g.track.cps, N = cps.length;
    if (g.combat) {
      const sp = arenaSpawn(s, g);
      s.x = sp.x; s.y = sp.y; s.angle = sp.a;
    } else if (s.cpCount > 0) {
      const c = cps[(s.nextCp + N - 1) % N], n = cps[s.nextCp];
      s.x = c.x; s.y = c.y; s.angle = Math.atan2(n.y - c.y, n.x - c.x);
    } else {
      s.x = s.spawn.x; s.y = s.spawn.y; s.angle = s.spawn.a;
    }
    s.vx = s.vy = 0; s.angVel = 0; s.dead = 0; s.hp = s.maxHp; s.invuln = 2.5;
    if (s.ai) { s.ai.stuck = 0; s.ai.stuckN = 0; s.ai.rev = 0; s.ai.esc = 0; s.ai.route = null; }
    ringFx(g, s.x, s.y, 30, 6, 0.3, PAL.cyan);
  }

  /* ------------------------------------------------------ gate deferral */

  RR.fx = {
    snd: function (name, x, y, v) { G.replaying = true; snd(G, name, x, y, v); G.replaying = false; },
    boom: function (x, y, k) { boom(G, x, y, k); },
    burst: function (x, y, n, speed, kind, life, size) { burst(G, x, y, n, speed, FX[kind] || FX.spark, life, size); },
    ring: function (x, y, r0, r1, dur, color) { ringFx(G, x, y, r0, r1, dur, color); },
    text: function (x, y, text, color) { floatText(G, x, y, text, color); },
    banner: function (text, color, dur, scale) { banner(G, text, color, dur, scale); },
  };

  /**
   * Can ship `p` defer the gate it is heading for now? It needs a deferral,
   * a race under way, to be flying, and a gate that is not the start/finish
   * line: every lap is still flown over the line.
   */
  function canDefer(g, p) {
    return !g.combat && p.defer > 0 && g.phase === 'race' && !p.finished && p.dead <= 0 && !p.gone &&
      !g.track.cps[p.nextCp].finish;
  }
  G.canDefer = function (who) { return canDefer(this, who || this.player); };

  /**
   * Spend a gate deferral: the gate the ship is heading for counts as passed
   * (as if it had flown through it), and it goes straight on to the next.
   */
  G.tryDefer = function (who) {
    const g = this, p = who || g.player, me = p === g.player && !g.server;
    if (g.demo || g.state !== 'play' || (me && g.playerDone)) return false;
    if (!canDefer(g, p)) {
      // the one refusal worth explaining: the line itself
      if (me && p.defer > 0 && g.phase === 'race' && !g.combat && g.track.cps[p.nextCp].finish) {
        floatText(g, p.x, p.y - 16, 'FLY THE LINE', PAL.silver);
        RR.audio.sfx('deny');
      }
      return false;
    }
    if (g.online && !g.server) { RR.mp.defer(); return false; } // the server takes it
    const gate = p.nextCp, cp = g.track.cps[gate];
    p.defer--; // an upgraded pick-up holds more than one
    tally(p, 'defer');
    passCp(p, g, cp);
    if (g.server) { g.events.push(['d', p.idx, gate]); return true; }
    if (me) deferFx(g, p, cp);
    else floatText(g, p.x, p.y - 16, 'DEFERRED', PAL.violet);
    return true;
  };

  /* ------------------------------------------------ capture the flag */

  /**
   * Can ship `p` use a Replace Flag now? It needs one, a fight under way,
   * and its own flag away from home - lying where it was dropped, or in an
   * enemy's hands: it goes home either way.
   */
  function canReflag(g, p) {
    return !!(g.ctf && g.flags && p && p.reflag > 0 && g.phase === 'race' && !g.over && p.dead <= 0 && g.flags[p.side].state !== 'home');
  }
  G.canReflag = function (who) { return canReflag(this, who || this.player); };

  /** Spend a Replace Flag: your team's flag is back on its base at once. `who`: a ship the AI or server plays. */
  G.tryReflag = function (who) {
    const g = this, p = who || g.player;
    if (!who && (g.demo || g.state !== 'play' || g.playerDone)) return false;
    if (!canReflag(g, p)) {
      if (!who && p.reflag > 0 && g.ctf && g.phase === 'race' && g.flags[p.side].state === 'home') {
        floatText(g, p.x, p.y - 16, 'YOUR FLAG IS HOME', PAL.silver);
        RR.audio.sfx('deny');
      }
      return false;
    }
    if (g.online && !g.server) { RR.mp.defer(); return false; } // the server takes it (the same button as a deferral)
    p.reflag--;
    tally(p, 'reflag');
    flagHome(g, g.flags[p.side], 'replace', p);
    return true;
  };

  /** A flag back on its base; `kind` says why ('return', 'replace', 'score'), `by` who did it. */
  function flagHome(g, f, kind, by) {
    if (f.carrier) f.carrier.flag = null;
    if (kind === 'return' && by) by.returns++;
    f.state = 'home'; f.carrier = null; f.x = f.home.x; f.y = f.home.y; f.dropT = 0;
    if (kind) flagNews(g, kind, f.side, by);
  }

  /** A carrier wrecked: the flag falls where they were. */
  function dropFlag(g, s) {
    const f = s.flag;
    if (!f) return;
    s.flag = null;
    f.carrier = null; f.state = 'dropped'; f.x = s.x; f.y = s.y; f.dropT = 0;
    flagNews(g, 'drop', f.side, s);
  }

  /**
   * What just happened to `side`'s flag ('take', 'drop', 'return',
   * 'replace', 'score') or to the Replace Flag ('rtake', 'rlost'), and which
   * ship did it: a line in the feed naming the teams (the one that did it,
   * and the flag's), and the player's banners and sounds, which name the
   * flag's team too. The server sends it to the players instead.
   */
  function flagNews(g, kind, side, s) {
    if (g.server) { g.events.push(['f', kind, side, s ? s.idx : -1]); return; }
    const F = SIDES[side].name, team = s ? SIDES[s.side].name : '', by = team + ' TEAM';
    const line = kind === 'rtake' ? by + ' HAS THE REPLACE FLAG'
      : kind === 'rlost' ? by + ' LOST THE REPLACE FLAG'
        : kind === 'take' ? by + ' TOOK THE ' + F + ' FLAG'
          : kind === 'drop' ? by + ' DROPPED THE ' + F + ' FLAG'
            : kind === 'return' ? (s ? by + ' RETURNED THE ' + F + ' FLAG' : 'THE ' + F + ' FLAG WENT HOME')
              : kind === 'replace' ? by + ' REPLACED THE ' + F + ' FLAG'
                : by + ' CAPTURED THE ' + F + ' FLAG!';
    // in the colours of the team it is good news for: the taker's or scorer's, else the flag's own
    const col = (kind === 'take' || kind === 'score') && s ? s.side : side;
    g.feed.push({ text: line, col: SIDES[col].light, t: 0 });
    if (g.feed.length > 3) g.feed.shift();
    if (g.demo || kind === 'rtake' || kind === 'rlost') return;
    const p = g.player, ours = side === p.side;
    if (kind === 'take') {
      if (s === p) banner(g, 'GOT THE ' + F + ' FLAG!', PAL.yellow, 1.8, 3);
      else if (ours) banner(g, F + ' FLAG TAKEN BY ' + team + '!', PAL.alarm, 1.6, 2);
      RR.audio.sfx(ours ? 'deny' : 'power');
    } else if (kind === 'score') {
      const won = s && s.side === p.side;
      banner(g, won ? 'CAPTURED THE ' + F + ' FLAG!' : team + ' CAPTURED THE ' + F + ' FLAG', won ? PAL.yellow : PAL.alarm, 2, won ? 4 : 3);
      RR.audio.sfx(won ? 'finish' : 'lose');
    } else if ((kind === 'return' || kind === 'replace') && ours) {
      banner(g, F + (kind === 'replace' ? ' FLAG REPLACED!' : ' FLAG HOME'), PAL.cyan, 1.4, 2);
      RR.audio.sfx('power');
    } else if (kind === 'drop' && s === p) banner(g, F + ' FLAG DROPPED!', PAL.alarm, 1.4, 2);
  }
  RR.fx.flag = function (kind, side, idx) { flagNews(G, kind, side, G.ships[idx] || null); }; // online: the server's word

  /**
   * Each step of a capture the flag fight: carried flags ride behind their
   * carriers; a dropped flag goes home after FLAG_RETURN seconds, or at once
   * when one of its own team touches it; an enemy touching a flag on its
   * base or on the ground takes it; and an enemy flag brought to a base
   * whose own flag is home is a capture. First to CTF_CAPS, or the most
   * when CTF_TIME runs out. (The attract mode just plays on.)
   */
  function updateCTF(g, dt) {
    if (g.phase !== 'race' || g.over) return;
    const reach = C.FLAG_R + C.SHIP_R;
    for (const f of g.flags) {
      if (f.state === 'carried') {
        const c = f.carrier;
        f.x = c.x - Math.cos(c.angle) * 12; f.y = c.y - Math.sin(c.angle) * 12;
        continue;
      }
      if (f.state === 'dropped' && (f.dropT += dt) >= C.FLAG_RETURN) { flagHome(g, f, 'return', null); continue; }
      for (const s of g.ships) {
        if (s.dead > 0 || s.gone || Math.hypot(s.x - f.x, s.y - f.y) > reach) continue;
        if (s.side === f.side) {
          if (f.state === 'dropped') { flagHome(g, f, 'return', s); break; }
        } else if (!s.flag) {
          f.state = 'carried'; f.carrier = s; f.dropT = 0; s.flag = f;
          flagNews(g, 'take', f.side, s);
          break;
        }
      }
    }
    for (const s of g.ships) {
      if (!s.flag || s.dead > 0) continue;
      const own = g.flags[s.side];
      if (own.state !== 'home' || Math.hypot(s.x - own.home.x, s.y - own.home.y) > C.BASE_R) continue;
      g.caps[s.side]++; s.caps++;
      flagHome(g, s.flag, 'score', s);
      if (g.caps[s.side] >= C.CTF_CAPS) {
        if (g.demo) g.caps = [0, 0];
        else { endMatch(g); return; }
      }
    }
    if (!g.demo && g.raceTime >= C.CTF_TIME) endMatch(g);
  }

  /** What the player sees and hears when their own deferral goes through. */
  function deferFx(g, p, cp) {
    ringFx(g, cp.x, cp.y, Art.DONUT_RC + 26, Art.DONUT_RC - 12, 0.4, PAL.violet);
    ringFx(g, p.x, p.y, 8, 40, 0.35, PAL.violet);
    burst(g, p.x, p.y, 16, 150, FX.ion, 0.5);
    banner(g, 'GATE DEFERRED!', PAL.violet, 1.2, 3);
    RR.audio.sfx('defer');
    RR.input.buzz(40);
  }
  RR.fx.deferred = function (idx, gate) { // online: the server's word that a deferral went through
    const p = G.ships[idx], cp = G.track && G.track.cps[gate];
    if (!p || !cp) return;
    if (p === G.player) deferFx(G, p, cp);
    else floatText(G, p.x, p.y - 16, 'DEFERRED', PAL.violet);
  };

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

  /** The rival a missile should chase: close, and near the line it is launched along. */
  RR.pickTarget = function (s, g, ang) { return pickTarget(s, g, ang); }; // (the HUD marks the lock while aiming)
  function pickTarget(s, g, ang) {
    const a = ang === undefined ? s.angle : ang;
    const ca = Math.cos(a), sa = Math.sin(a);
    let best = null, score = 1e9;
    for (const o of g.ships) {
      if (o === s || o.dead > 0 || ally(g, o, s)) continue;
      const dx = o.x - s.x, dy = o.y - s.y, d = Math.hypot(dx, dy) || 1;
      if (d > 760) continue;
      const off = Math.acos(clamp((dx * ca + dy * sa) / d, -1, 1));
      if (off > 1.05) continue;
      const sc = d * (1 + off * 1.6);
      if (sc < score) { score = sc; best = o; }
    }
    return best;
  }

  /**
   * Weapons. The blaster (and the combat cannon) is automatic: it fires all
   * the time the trigger is held, straight ahead, or the way the fire stick is
   * pushed. Missiles from the touch fire stick are aimed: hold the stick, push
   * it the way to fire, and let go to launch (straight ahead if it was not
   * pushed). Let go while the launcher is still reloading and the missile goes
   * as soon as it is ready. Everything else fires once per press: missiles
   * from a key or gamepad straight ahead, mines behind, EMP all round.
   */
  function tryFire(s, g) {
    const inp = s.input, fire = inp.fire, edge = fire && !s.prevFire;
    s.prevFire = fire;
    const w = s.weapon || (g.combat ? 'blaster' : null); // in combat every ship has a cannon
    // the touch fire stick: remember where it last pointed, so letting go launches that way
    const letGo = s.stickHeld && !inp.stick;
    if (inp.stick) s.stickAim = inp.aim;
    s.stickHeld = !!inp.stick;
    if (w === 'missile' && letGo) s.launch = { aim: s.stickAim };
    if (s.launch && (w !== 'missile' || s.dead > 0 || s.stun > 0 || s.emp > 0)) s.launch = null;
    if (!w || s.cool > 0 || s.dead > 0 || s.stun > 0 || s.emp > 0) return;

    let aim;
    if (s.launch) { aim = s.launch.aim; s.launch = null; } // an aimed missile, let go
    else if (w === 'blaster' ? fire : edge && !(w === 'missile' && inp.stick)) aim = inp.aim;
    else return;
    if (aim == null) aim = s.angle; // straight ahead
    const ca = Math.cos(aim), sa = Math.sin(aim);

    if (w === 'blaster') {
      g.shots.push({
        type: 'bolt', owner: s, x: s.x + ca * 12, y: s.y + sa * 12,
        vx: ca * C.BOLT_SPEED + s.vx * 0.5, vy: sa * C.BOLT_SPEED + s.vy * 0.5,
        life: C.BOLT_LIFE, color: s.colors.i, dmg: C.BOLT_DMG * s.dmg,
      });
      s.cool = s.weapon ? 0.13 : C.CANNON_COOL;
      snd(g, 'laser', s.x, s.y, 0.8);
    } else if (w === 'missile') {
      g.shots.push({
        type: 'missile', owner: s, x: s.x + ca * 12, y: s.y + sa * 12, vx: 0, vy: 0,
        angle: aim, speed: Math.max(220, s.vx * ca + s.vy * sa + 110),
        life: C.MISSILE_LIFE, target: pickTarget(s, g, aim), smk: 0,
      });
      s.cool = 0.45;
      snd(g, 'missile', s.x, s.y);
    } else if (w === 'mine') {
      // mines always drop behind the ship, whatever the aim
      const bx = Math.cos(s.angle), by = Math.sin(s.angle);
      g.mines.push({ owner: s, x: s.x - bx * 16, y: s.y - by * 16, vx: s.vx * 0.25, vy: s.vy * 0.25, t: 0, ph: Math.random() });
      s.cool = 0.35;
      snd(g, 'mine', s.x, s.y);
    } else if (w === 'emp') {
      g.waves.push({ owner: s, x: s.x, y: s.y, r: 8, hit: [] });
      s.cool = 0.5;
      snd(g, 'emp', s.x, s.y);
      if (s === g.player && !g.demo) g.flash = 0.35;
    }
    if (s.weapon && s.fresh) { tally(s, s.weapon); s.fresh = false; } // a weapon pick-up counts once, at its first shot
    if (s.weapon && --s.ammo <= 0) { s.weapon = null; s.ammo = 0; }
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
        zap(s, g, dmg * k, stun, (dx / m) * 170 * k, (dy / m) * 170 * k, owner);
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
          if (s === b.owner || s.dead > 0 || ally(g, s, b.owner)) continue; // (shots pass through teammates)
          const dx = b.x - s.x, dy = b.y - s.y, rr = C.SHIP_R + 4;
          if (dx * dx + dy * dy < rr * rr) { dead = true; hitShip = s; break; }
        }
      }
      if (!dead && b.type === 'bolt') {
        for (let m = g.mines.length - 1; m >= 0; m--) {
          const mn = g.mines[m];
          if (Math.hypot(b.x - mn.x, b.y - mn.y) < 9) {
            g.mines.splice(m, 1);
            explode(g, mn.x, mn.y, 48, C.MINE_DMG * mn.owner.dmg, 1, mn.owner, true);
            dead = true;
            break;
          }
        }
      }
      if (!dead) continue;

      shots.splice(i, 1);
      if (b.type === 'missile') {
        explode(g, b.x, b.y, 44, C.MISSILE_DMG * b.owner.dmg, 1.1, b.owner, false);
      } else if (b.life > 0) {
        if (hitShip) { zap(hitShip, g, b.dmg, 0, b.vx * 0.1, b.vy * 0.1, b.owner); snd(g, 'hit', b.x, b.y); }
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
          // (capture the flag: a mine never goes off for its own team, the ship that laid it included)
          if (s.dead > 0 || (s === m.owner && m.t < 1.6) || ally(g, s, m.owner)) continue;
          if (Math.hypot(s.x - m.x, s.y - m.y) < 20) { trip = true; break; }
        }
      }
      if (trip) {
        g.mines.splice(i, 1);
        explode(g, m.x, m.y, 48, C.MINE_DMG * m.owner.dmg, 1, m.owner, true);
      }
    }
  }

  function updateWaves(g, dt) {
    for (let i = g.waves.length - 1; i >= 0; i--) {
      const w = g.waves[i];
      w.r += 520 * dt;
      for (const s of g.ships) {
        if (s === w.owner || s.dead > 0 || w.hit.indexOf(s) >= 0 || ally(g, s, w.owner)) continue;
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

  /** What powerup `id` gives ship `s`, at its level. */
  function powerFor(s, id) { return powerOf(id).lv[(s.plv[id] || 1) - 1]; }

  /** One more use of powerup `type` by ship `s` this race. */
  function tally(s, type) { s.used[type] = (s.used[type] || 0) + 1; }

  function collect(s, p, g) {
    p.on = false;
    p.timer = C.PICK_RESPAWN;
    if (g.server) g.events.push(['p', g.pickups.indexOf(p), s.idx, p.type]);
    const T = ITEMS[p.type], isP = s === g.player && !g.demo, k = powerFor(s, p.type === 'reflag' ? 'defer' : p.type); // (Replace Flag: the deferral's upgrade)
    if (T.ammo) {
      // the same weapon again tops it up, to twice a pick-up at most, and never takes ammo away
      if (s.weapon === p.type) s.ammo = Math.max(s.ammo, Math.min(k * 2, s.ammo + k));
      else { s.weapon = p.type; s.ammo = k; }
      s.fresh = true; // counted as used once it is fired
      if (isP) RR.audio.sfx('weapon');
    } else if (p.type === 'nitro') {
      s.nitro = C.NITRO_TIME * k;
      s.vx += Math.cos(s.angle) * 90; s.vy += Math.sin(s.angle) * 90;
      snd(g, 'nitro', s.x, s.y, isP ? 1 : 0.5);
    } else if (p.type === 'shield') {
      s.shield = C.SHIELD_TIME * k;
      snd(g, 'shield', s.x, s.y, isP ? 1 : 0.5);
    } else if (p.type === 'repair') {
      s.hp = Math.min(s.maxHp, s.hp + k);
      if (isP) RR.audio.sfx('power');
    } else if (p.type === 'defer') {
      s.defer = k; // counted as used when a gate is deferred
      if (isP) { RR.audio.sfx('power'); banner(g, 'DEFERRAL READY', PAL.violet, 1.6, 3); }
    } else if (p.type === 'reflag') {
      s.reflag = k; // counted as used when a flag is replaced
      if (isP) { RR.audio.sfx('power'); banner(g, 'REPLACE FLAG READY', PAL.gold, 1.6, 2); }
      flagNews(g, 'rtake', s.side, s);
    }
    if (!T.ammo && p.type !== 'defer' && p.type !== 'reflag') tally(s, p.type); // nitro, shield and repair act at once
    burst(g, p.x, p.y, 12, 120, T.ammo ? FX.fire : p.type === 'defer' || p.type === 'reflag' ? FX.ion : FX.shield, 0.45);
    ringFx(g, p.x, p.y, 6, 20, 0.22, T.color);
    if (isP) floatText(g, p.x, p.y - 12, T.name, T.color);
  }

  function updatePickups(g, dt) {
    const rr = C.PICK_R * C.PICK_R;
    for (const p of g.pickups) {
      if (!p.on) {
        p.timer -= dt;
        if (p.timer <= 0) { p.on = true; p.type = roll(p.kind, g, g.ctf && !reflagRoom(g, p)); ringFx(g, p.x, p.y, 16, 4, 0.2, PAL.white); }
        continue;
      }
      for (const s of g.ships) {
        if (s.dead > 0) continue;
        // only humans defer gates, and one pick-up at a time: otherwise leave it for later
        if (p.type === 'defer' && (s.ai || s.defer > 0)) continue;
        if (p.type === 'reflag' && reflagHolder(g)) continue; // (one pilot holds it at a time)
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
    if (s.gone) return; // knocked out of a battle royale
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
      s.angVel += (turn * C.TURN * s.turnK - s.angVel) * Math.min(1, 16 * dt);
      s.angle += s.angVel * dt;
    }
    const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
    const boost = s.nitro > 0 ? C.NITRO_MULT : 1;
    const acc = C.THRUST * s.accK * (thrust * boost * s.speedMult - C.REVERSE * brake);
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
    const drag = C.DRAG * s.dragK;
    const vf = (s.vx * ca + s.vy * sa) * Math.exp(-drag * dt);
    const vl = (-s.vx * sa + s.vy * ca) * Math.exp(-(drag + grip * s.turnK) * dt);
    s.vx = ca * vf - sa * vl; s.vy = sa * vf + ca * vl;
    s.x += s.vx * dt; s.y += s.vy * dt;

    // leash: a soft wall well outside the course (a round arena's is a circle)
    const b = g.track.bounds, rw = g.track.wall;
    s.out = false;
    if (rw) {
      const wx = s.x - rw.x, wy = s.y - rw.y, wd = Math.hypot(wx, wy);
      if (wd > rw.r) { const k = (wd - rw.r) * 5 * dt / wd; s.vx -= wx * k; s.vy -= wy * k; s.out = true; }
    } else {
      if (s.x < b.x0) { s.vx += (b.x0 - s.x) * 5 * dt; s.out = true; }
      else if (s.x > b.x1) { s.vx -= (s.x - b.x1) * 5 * dt; s.out = true; }
      if (s.y < b.y0) { s.vy += (b.y0 - s.y) * 5 * dt; s.out = true; }
      else if (s.y > b.y1) { s.vy -= (s.y - b.y1) * 5 * dt; s.out = true; }
    }

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
    if (g.online && !g.server) return;
    if (g.server) { // autopilot takes the victory lap; the room reads the time
      if (s.human) s.ai = makeAI(DEMO_DIFF);
      g.events.push(['F', s.idx]);
      return;
    }
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
    award(g, s.place); // (saves)
    recordGame(g, 'race', s.place, s.place === 1, false);
    RR.net.submit(id, {
      name: g.name, pid: g.pid, time: s.finishTime, lap: s.bestLap, diff: g.diffIdx, place: s.place,
      setup: { ship: s.setup.ship, stats: s.setup.stats.slice(), items: Object.assign({}, s.used), levels: s.setup.levels },
    });
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
    const cps = g.track.cps, r = g.track.cpR || C.CP_R, rr = r * r; // (some courses count a brush with the donut)
    for (const s of g.ships) {
      if (s.dead > 0) continue;
      const cp = cps[s.nextCp], dx = s.x - cp.x, dy = s.y - cp.y;
      if (dx * dx + dy * dy < rr) passCp(s, g, cp);
    }
  }

  function rank(g) {
    const cps = g.track.cps;
    for (const s of g.ships) {
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

  /* -------------------------------------------------------- combat modes */

  /** Dogfight: most kills, then fewest deaths. Battle royale: survivors first, then last one out. */
  function rankCombat(g) {
    if (g.over) return; // the final table stands
    const caps = g.caps;
    g.order.sort(g.ctf ? function (a, b) { // the winning team first; then captures, kills, fewest losses
      return caps[b.side] - caps[a.side] || b.caps - a.caps || b.kills - a.kills || a.deaths - b.deaths || a.idx - b.idx;
    } : g.royale ? function (a, b) {
      if (!a.elim !== !b.elim) return a.elim ? 1 : -1;
      return a.elim ? b.elim - a.elim : b.kills - a.kills || a.idx - b.idx;
    } : function (a, b) {
      return b.kills - a.kills || a.deaths - b.deaths || a.idx - b.idx;
    });
    for (let i = 0; i < g.order.length; i++) g.order[i].place = i + 1;
  }

  /** Capture the flag: the team with the most captures, or -1 while two or more share the most. */
  function leader(g) { return RR.records.leader(g.caps); }
  G.ctfLeader = function () { return this.ctf ? leader(this) : -1; };

  /** The player's part in a combat event is settled: either it ended, or they are out of a battle royale. */
  function playerResult(g) {
    const p = g.player;
    if (g.demo || g.server || g.playerDone) return;
    g.playerDone = true;
    g.doneT = 0;
    rankCombat(g);
    const win = p.place === 1;
    if (g.ctf) {
      const top = leader(g);
      banner(g, top === p.side ? 'YOUR TEAM WINS!' : top >= 0 ? SIDES[top].name + ' TEAM WINS' : 'A DRAW',
        top === p.side ? PAL.yellow : PAL.white, 2.2, 3);
    } else if (g.royale) banner(g, win ? 'LAST SHIP FLYING!' : 'ELIMINATED!', win ? PAL.yellow : PAL.alarm, 2.2, 4);
    else banner(g, win ? 'VICTORY!' : 'MATCH OVER', win ? PAL.yellow : PAL.white, 2.2, 5);
    RR.audio.sfx(p.place <= 3 ? 'finish' : 'lose');
    RR.audio.music({ tempo: 0.9 });
    if (!p.gone) p.ai = makeAI(DEMO_DIFF); // autopilot while the results are up
    award(g, p.place);
    // the history (a win: 1st place, or your team's in capture the flag), and the points for the mode's high score table
    const won = g.ctf ? leader(g) === p.side : p.place === 1;
    recordGame(g, g.mode, p.place, won, false);
    const result = { place: p.place, win: won, kills: p.kills, deaths: p.deaths };
    if (g.mode === 'dogfight') result.left = won && p.kills >= C.KILL_TARGET ? clamp(Math.floor(C.DOGFIGHT_TIME - g.endT), 0, C.DOGFIGHT_TIME) : 0;
    if (g.ctf) { result.caps = p.caps; result.returns = p.returns; }
    g.fightScore = RR.records.score(g.mode, result, g.diffIdx);
    RR.net.submit(g.mode, {
      name: g.name, pid: g.pid, diff: g.diffIdx, map: g.track.def.id, result: result,
      setup: { ship: p.setup.ship, stats: p.setup.stats.slice(), items: Object.assign({}, p.used), levels: p.setup.levels },
    });
  }

  function endMatch(g) {
    rankCombat(g);
    g.over = true;
    g.endT = g.raceTime;
    if (g.player.gone) g.spec = g.order[0];
    playerResult(g);
  }

  function updateCombat(g, dt) {
    for (let i = g.feed.length - 1; i >= 0; i--) {
      g.feed[i].t += dt;
      if (g.feed[i].t > 5) g.feed.splice(i, 1);
    }
    if (g.ctf) { updateCTF(g, dt); rankCombat(g); return; }
    if (g.phase !== 'race' || g.demo || g.over) { rankCombat(g); return; }

    if (g.royale) {
      // the zone closes on the middle of the arena; outside it hulls burn, shield or no shield
      const z = g.zone, c = g.track.center;
      z.r = z.r0 * (1 - clamp((g.raceTime - C.ZONE_GRACE) / C.ZONE_SHRINK, 0, 1));
      let alive = 0;
      for (const s of g.ships) {
        if (s.gone) continue;
        if (s.dead <= 0) {
          s.zoned = Math.hypot(s.x - c.x, s.y - c.y) > z.r;
          if (s.zoned) {
            s.hp -= C.ZONE_DMG * dt;
            if (s.hp <= 0) destroy(s, g);
          }
        }
        if (!s.gone) alive++;
      }
      if (alive <= 1) endMatch(g);
      else if (g.player.gone && (!g.spec || g.spec.gone)) {
        g.spec = g.ships.find(function (s) { return !s.gone; }) || null;
      }
    } else if (g.raceTime >= C.DOGFIGHT_TIME || g.ships.some(function (s) { return s.kills >= C.KILL_TARGET; })) {
      endMatch(g);
    }
    rankCombat(g);
  }

  /* ------------------------------------------------------------------ AI */

  function choosePickup(s, g, ux, uy, dist) {
    let best = null, bestLat = 48;
    for (const p of g.pickups) {
      if (!p.on) continue;
      if (p.kind === 'W' ? !!s.weapon : p.type === 'defer' || (p.type === 'repair' && s.hp > 80) || (p.type === 'shield' && s.shield > 0)) continue;
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

  /**
   * Bend a desired heading (ux, uy) around the planets, asteroids and mines
   * within `dist`. The result is left in `steer`; returns true if it changed.
   */
  function dodge(s, g, ux, uy, dist, margin) {
    const speed = Math.hypot(s.vx, s.vy);
    let bent = false;
    // steer around planets that sit between us and the target
    for (const p of g.track.planets) {
      const pd = Math.hypot(p.x - s.x, p.y - s.y);
      if (pd - p.r > dist) continue;
      if (avoid(s, p.x, p.y, p.r + 30 + margin, ux, uy)) { ux = steer.x; uy = steer.y; bent = true; }
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
      if (ally(g, m.owner, s)) continue; // (our own team's are harmless)
      const ax = m.x - s.x, ay = m.y - s.y, along = ax * ux + ay * uy;
      if (along < 0 || along > reach) continue;
      if (Math.abs(ax * uy - ay * ux) < 24) { block = m; blockR = 28; reach = along; }
    }
    if (block && avoid(s, block.x, block.y, blockR, ux, uy)) { ux = steer.x; uy = steer.y; bent = true; }
    steer.x = ux; steer.y = uy;
    return bent;
  }

  /** Pull the trigger when somebody is where the weapon in hand can reach them. */
  function aiFire(s, g, dt) {
    const ai = s.ai, w = s.weapon || (g.combat ? 'blaster' : null);
    ai.fireT -= dt;
    if (!w || ai.fireT > 0 || s.stun > 0 || s.emp > 0) return;
    const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
    let fire = false;
    for (const o of g.ships) {
      if (o === s || o.dead > 0 || o.invuln > 0 || ally(g, o, s)) continue;
      const ox = o.x - s.x, oy = o.y - s.y, od = Math.hypot(ox, oy) || 1, fwd = (ox * ca + oy * sa) / od;
      if (w === 'blaster') fire = od < 380 && fwd > 0.985;
      else if (w === 'missile') fire = od < 620 && od > 70 && fwd > 0.72;
      else if (w === 'mine') fire = od < 190 && fwd < -0.5;
      else if (w === 'emp') fire = od < C.EMP_RANGE * 0.7;
      if (fire) break;
    }
    if (fire) {
      s.input.fire = true;
      ai.fireT = w === 'blaster' ? 0.15 / Math.min(1, ai.aggro) : (0.7 + Math.random() * 1.6) / ai.aggro;
    }
  }

  /** A pickup worth a detour in a fight: a weapon when empty-handed, a repair when hurt, a shield. */
  function combatPickup(s, g) {
    const c = g.track.center;
    let best = null, bd = 340;
    for (const p of g.pickups) {
      if (!p.on) continue;
      if (p.kind === 'W' ? !!s.weapon : p.type === 'nitro' || (p.type === 'repair' && s.hp > s.maxHp * 0.7) || (p.type === 'shield' && s.shield > 0)) continue;
      if (g.zone && Math.hypot(p.x - c.x, p.y - c.y) > g.zone.r - 20) continue;
      const d = Math.hypot(p.x - s.x, p.y - s.y) * (p.type === 'repair' && s.hp < s.maxHp * 0.4 ? 0.4 : 1);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** Combat brain: stay in the arena (and the zone), grab what helps, otherwise hunt the nearest ship. */
  function thinkCombat(s, g, dt) {
    const ai = s.ai, inp = s.input, tr = g.track, c = tr.center;
    s.speedMult = ai.skill;

    ai.tgtT = (ai.tgtT || 0) - dt;
    if (ai.tgtT <= 0 || (ai.tgt && ai.tgt.dead > 0)) {
      ai.tgtT = 0.5 + Math.random() * 0.7;
      let best = null, score = 1e9;
      for (const o of g.ships) {
        if (o === s || o.dead > 0) continue;
        // nearest first; stick with the current target, finish off the wounded, leave the untouchable
        const sc = Math.hypot(o.x - s.x, o.y - s.y) * (o === ai.tgt ? 0.7 : 1) * (o.invuln > 0 ? 2.5 : 1) * (0.6 + 0.4 * o.hp / o.maxHp);
        if (sc < score) { score = sc; best = o; }
      }
      ai.tgt = best;
      ai.pick = combatPickup(s, g);
    }

    const o = ai.tgt, cd = Math.hypot(c.x - s.x, c.y - s.y);
    const limit = Math.min(tr.radius - 50, g.zone ? g.zone.r - 45 : 1e9);
    let tx = c.x, ty = c.y, chase = false, idle = false;
    if (cd > limit) { /* head back in */ }
    else if (ai.pick && ai.pick.on) { tx = ai.pick.x; ty = ai.pick.y; }
    else if (o) {
      // lead the shot: bolts leave with half of our own velocity
      const lead = Math.min(0.7, Math.hypot(o.x - s.x, o.y - s.y) / C.BOLT_SPEED);
      tx = o.x + (o.vx - s.vx * 0.5) * lead; ty = o.y + (o.vy - s.vy * 0.5) * lead;
      chase = true;
    } else idle = cd < 90;
    flyAt(s, g, dt, tx, ty, chase, idle);
  }

  /* ------------------------------------- capture the flag: finding the way */

  /*
   * A flag map is too big and too cluttered to fly at a target in a straight
   * line: the giant in the middle and the asteroid walls sit right across
   * it. So the AI plans its route over a coarse grid of the map (NAV_CELL
   * squares), each square costing more the worse it is to fly through:
   * planets most, then the strong pull close to them, then asteroids. A*
   * finds the cheapest way; the ship flies at the furthest point along it
   * that it can see in a clear straight line, and plans again as things move.
   */
  const NAV_CELL = 100, NAV_PULL = 110; // (a pull weaker than NAV_PULL is no worry)

  /** The map's grid of costs, worked out once per map. */
  function navGrid(g) {
    const tr = g.track;
    if (tr.nav) return tr.nav;
    const b = tr.bounds, cs = NAV_CELL, W = Math.ceil((b.x1 - b.x0) / cs), H = Math.ceil((b.y1 - b.y0) / cs);
    const cost = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = b.x0 + (i + 0.5) * cs, y = b.y0 + (j + 0.5) * cs;
        let c = 1;
        const wall = tr.wall ? tr.wall.r - Math.hypot(x - tr.wall.x, y - tr.wall.y) : Math.min(x - b.x0, b.x1 - x, y - b.y0, b.y1 - y);
        if (wall < 40) c += 50; // (outside a round arena: as good as solid)
        else if (wall < 110) c += 0.5; // hugging the wall
        for (const p of tr.planets) {
          const d = Math.hypot(x - p.x, y - p.y), solid = p.r + 50, safe = Math.max(p.r + 90, p.r * Math.sqrt(p.g / NAV_PULL));
          if (d < solid) c += 50;
          else if (d < safe) c += 0.6 + 3.4 * (safe - d) / (safe - solid);
        }
        for (const a of tr.rocks) if (!a.orbit && Math.hypot(x - a.x, y - a.y) < a.r + 80) c += 1.6;
        cost[j * W + i] = Math.min(c, 60);
      }
    }
    const n = W * H;
    return (tr.nav = {
      W: W, H: H, cs: cs, x0: b.x0, y0: b.y0, cost: cost, cx: tr.center.x, cy: tr.center.y,
      gs: new Float32Array(n), from: new Int32Array(n), seen: new Uint32Array(n), done: new Uint32Array(n), stamp: 0,
      hf: new Float32Array(n * 8), hi: new Int32Array(n * 8),
    });
  }
  function navCell(N, x, y) {
    return clamp(Math.floor((y - N.y0) / N.cs), 0, N.H - 1) * N.W + clamp(Math.floor((x - N.x0) / N.cs), 0, N.W - 1);
  }
  /** Is the straight line from (x0, y0) to (x1, y1) clear: nothing on it worse than where it starts? */
  function navClear(N, x0, y0, x1, y1) {
    const lim = Math.max(1.55, N.cost[navCell(N, x0, y0)] + 0.05);
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 45);
    for (let k = 1; k <= n; k++) {
      if (N.cost[navCell(N, x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n)] > lim) return false;
    }
    return true;
  }

  /**
   * The cheapest route from (sx, sy) to (tx, ty), as a list of points.
   * `opt.avoid`: ships to give a wide berth (a carrier, round its hunters);
   * `opt.lane`: -1 or 1, which side of the straight line to keep to along
   * the middle of the way (on the Great Divide: the north or south way).
   */
  function navPath(g, sx, sy, tx, ty, opt) {
    const N = navGrid(g), W = N.W, H = N.H, cs = N.cs, cost = N.cost, gs = N.gs, from = N.from, seen = N.seen, done = N.done;
    const hf = N.hf, hi = N.hi, avoid = opt.avoid, lane = opt.lane || 0;
    const stamp = ++N.stamp, start = navCell(N, sx, sy), goal = navCell(N, tx, ty), gi = goal % W, gj = (goal / W) | 0;
    const ll = Math.hypot(tx - sx, ty - sy) || 1, lx = (tx - sx) / ll, ly = (ty - sy) / ll; // (the straight line, for the lane)
    let hn = 0;
    const push = function (f, c) { // a binary heap on f
      let k = hn++;
      while (k > 0) { const up = (k - 1) >> 1; if (hf[up] <= f) break; hf[k] = hf[up]; hi[k] = hi[up]; k = up; }
      hf[k] = f; hi[k] = c;
    };
    const pop = function () {
      const top = hi[0], f = hf[--hn], c = hi[hn];
      let k = 0;
      for (;;) {
        let ch = 2 * k + 1;
        if (ch >= hn) break;
        if (ch + 1 < hn && hf[ch + 1] < hf[ch]) ch++;
        if (hf[ch] >= f) break;
        hf[k] = hf[ch]; hi[k] = hi[ch]; k = ch;
      }
      hf[k] = f; hi[k] = c;
      return top;
    };
    const extra = function (c) { // what moving things and the lane add to a square
      const x = N.x0 + ((c % W) + 0.5) * cs, y = N.y0 + (((c / W) | 0) + 0.5) * cs;
      let e = 0;
      if (lane) {
        const rx = x - sx, ry = y - sy, along = (rx * lx + ry * ly) / ll;
        if (along > 0.15 && along < 0.85 && (lx * ry - ly * rx) * lane < -150) e += 1.5; // the other side of the line
      }
      if (avoid) {
        for (const o of avoid) {
          const d = Math.hypot(x - o.x, y - o.y);
          if (d < 450) e += 6 * (1 - d / 450);
        }
      }
      return e;
    };
    const heur = function (c) {
      const dx = Math.abs((c % W) - gi), dy = Math.abs(((c / W) | 0) - gj);
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
    };
    seen[start] = stamp; gs[start] = 0; from[start] = -1;
    push(heur(start), start);
    while (hn > 0 && hn < hf.length - 8) {
      const c = pop();
      if (done[c] === stamp) continue;
      done[c] = stamp;
      if (c === goal) break;
      const ci = c % W, cj = (c / W) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
          const nc = nj * W + ni;
          if (done[nc] === stamp) continue;
          const step = (di && dj ? 1.414 : 1) * ((cost[c] + cost[nc]) / 2 + extra(nc));
          const ng = gs[c] + step;
          if (seen[nc] === stamp && gs[nc] <= ng) continue;
          seen[nc] = stamp; gs[nc] = ng; from[nc] = c;
          push(ng + heur(nc), nc);
        }
      }
    }
    const pts = [{ x: tx, y: ty }];
    if (done[goal] !== stamp) return pts; // (cannot happen on a grid with no walls in it, but just in case: straight there)
    for (let c = from[goal]; c >= 0 && c !== start; c = from[c]) pts.push({ x: N.x0 + ((c % W) + 0.5) * cs, y: N.y0 + (((c / W) | 0) + 0.5) * cs });
    return pts.reverse();
  }

  /**
   * Where ship `s` should fly next on its way to (tx, ty): straight there
   * when the way is clear, otherwise the furthest point of its route in
   * clear sight. The route is planned again every second or so, or at once
   * when the target moves off it. Left in `steerTo`.
   */
  const steerTo = { x: 0, y: 0 };
  function routeTo(s, g, dt, tx, ty, opt) {
    const ai = s.ai, N = navGrid(g);
    steerTo.x = tx; steerTo.y = ty;
    if (Math.hypot(tx - s.x, ty - s.y) < 240) { ai.route = null; ai.direct = true; return steerTo; }
    let r = ai.route;
    if (r) r.t -= dt;
    const look = (ai.lookT = (ai.lookT || 0) - dt) <= 0; // (the lines of sight, a few times a second)
    if (look) { ai.lookT = 0.12; ai.direct = navClear(N, s.x, s.y, tx, ty); }
    if (ai.direct) { ai.route = null; return steerTo; }
    if (!r || r.t <= 0 || Math.hypot(r.tx - tx, r.ty - ty) > 220) {
      r = ai.route = { pts: navPath(g, s.x, s.y, tx, ty, opt || {}), i: 0, t: 0.8 + Math.random() * 0.5, tx: tx, ty: ty };
    }
    const pts = r.pts;
    while (r.i < pts.length - 1 && Math.hypot(pts[r.i].x - s.x, pts[r.i].y - s.y) < 110) r.i++;
    if (look) { // the furthest point ahead in clear sight
      for (let j = Math.min(pts.length - 1, r.i + 12); j > r.i; j--) {
        if (navClear(N, s.x, s.y, pts[j].x, pts[j].y)) { r.i = j; break; }
      }
    }
    steerTo.x = pts[r.i].x; steerTo.y = pts[r.i].y;
    return steerTo;
  }

  /** (x, y) brought `pad` inside the map's walls: a rectangle's, or a round arena's circle. Left in `inPt`. */
  const inPt = { x: 0, y: 0 };
  function insideWalls(g, x, y, pad) {
    const tr = g.track, w = tr.wall, b = tr.bounds;
    if (w) {
      const dx = x - w.x, dy = y - w.y, d = Math.hypot(dx, dy), r = w.r - pad;
      if (d > r) { x = w.x + (dx / d) * r; y = w.y + (dy / d) * r; }
    } else {
      x = clamp(x, b.x0 + pad, b.x1 - pad); y = clamp(y, b.y0 + pad, b.y1 - pad);
    }
    inPt.x = x; inPt.y = y;
    return inPt;
  }

  /** The pull of the planets at (x, y), as updateShip works it out. Left in `pull`. */
  const pull = { x: 0, y: 0 };
  function pullAt(g, x, y) {
    pull.x = pull.y = 0;
    for (const p of g.track.planets) {
      const dx = p.x - x, dy = p.y - y, d2 = dx * dx + dy * dy;
      if (d2 > p.range * p.range) continue;
      const d = Math.sqrt(d2) || 1, a = p.g * (p.r / d) * (p.r / d) * Math.min(1, (1 - d / p.range) * 3);
      pull.x += (dx / d) * a; pull.y += (dy / d) * a;
    }
    return pull;
  }

  /* --------------------------------------- capture the flag: the brains */

  /** Nearest enemy (capture the flag) within `range` of point `at`. */
  function nearestEnemy(s, g, at, range) {
    let best = null, bd = range;
    for (const o of g.ships) {
      if (o.dead > 0 || o.gone || o.side === s.side) continue;
      const d = Math.hypot(o.x - at.x, o.y - at.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /**
   * Each team's game plan: every AI ship gets a job (ai.job, and ai.mark,
   * the ship the job is about), thought out again twice a second, and at
   * once whenever a flag changes hands.
   *   carry   - has their flag: home, steering clear of the enemy
   *   hunt    - our flag is in enemy hands: the two nearest go after the thief
   *   recover - our flag lies loose: the nearest touches it home
   *   escort  - a teammate (or the player) has their flag: fly cover for them
   *   defend  - one ship (ai.role 'defend') stays by our flag
   *   attack  - the rest go for their flag, one by the north way, one by the south
   */
  function ctfPlan(g) {
    let key = '';
    for (const f of g.flags) key += f.state + (f.carrier ? f.carrier.idx : '') + ',';
    if (g.plan && g.plan.key === key && g.raceTime < g.plan.t) return;
    g.plan = { key: key, t: g.raceTime + 0.5 };
    for (let side = 0; side < g.teams; side++) {
      const mine = g.flags[side];
      const free = g.ships.filter(function (s) { return s.side === side && s.ai && !s.gone && s.dead <= 0 && !s.flag; });
      const give = function (job, mark, at) { // the free ship nearest `at` takes the job
        let best = -1, bd = 1e9;
        free.forEach(function (s, k) { const d = Math.hypot(s.x - at.x, s.y - at.y); if (d < bd) { bd = d; best = k; } });
        if (best < 0) return null;
        const s = free.splice(best, 1)[0];
        s.ai.job = job; s.ai.mark = mark;
        return s;
      };
      const guard = function () { // the ship whose role is to guard; or, with none, the nearest home of two or more
        let d = free.find(function (s) { return s.ai.role === 'defend'; });
        if (!d && free.length >= 2 && !g.ships.some(function (s) { return s.side === side && s.ai && s.ai.role === 'defend' && !s.gone; })) {
          d = free.reduce(function (a, s) { return Math.hypot(s.x - mine.home.x, s.y - mine.home.y) < Math.hypot(a.x - mine.home.x, a.y - mine.home.y) ? s : a; });
        }
        if (d) { free.splice(free.indexOf(d), 1); d.ai.job = 'defend'; d.ai.mark = null; }
      };
      for (const s of g.ships) if (s.side === side && s.ai && s.flag) { s.ai.job = 'carry'; s.ai.mark = null; }
      if (mine.state === 'carried') { give('hunt', mine.carrier, mine.carrier); give('hunt', mine.carrier, mine.carrier); }
      else if (mine.state === 'dropped') give('recover', null, mine);
      // a teammate (a bot, or the player) with an enemy flag: cover them; all of us, unless one is wanted at home,
      // or (three teams) there is another enemy flag to raid
      const c = g.ships.find(function (o) { return o.side === side && o.flag && !o.gone && o.dead <= 0; });
      if (c) {
        give('escort', c, c);
        if (mine.state === 'home') guard();
        if (g.teams < 3) { while (free.length) give('escort', c, c); continue; }
      } else if (mine.state === 'home') guard();
      // the rest attack: an enemy flag each (see targetFlag), split between the two ways round anything in between
      let lane = 0;
      for (const s of free) {
        s.ai.job = 'attack'; s.ai.mark = null;
        s.ai.tflag = targetFlag(s, g, s.ai.tflag);
        if (!s.ai.lane) s.ai.lane = Math.random() < 0.5 ? -1 : 1;
        if (lane && s.ai.lane === lane) s.ai.lane = -lane;
        lane = s.ai.lane;
      }
    }
  }

  /**
   * The enemy flag ship `s` should raid: the nearest of those not in
   * anyone's hands, the more so one lying loose or the leading team's (it
   * stops them scoring), and the one it was already after; null when every
   * enemy flag is being carried.
   */
  function targetFlag(s, g, prev) {
    const lead = leader(g);
    let best = null, bc = 1e9;
    for (const f of g.flags) {
      if (f.side === s.side || f.state === 'carried') continue;
      const c = Math.hypot(f.x - s.x, f.y - s.y) * (f.state === 'dropped' ? 0.6 : 1) * (f.side === lead ? 0.8 : 1) * (f === prev ? 0.85 : 1);
      if (c < bc) { bc = c; best = f; }
    }
    return best;
  }

  /**
   * Capture the flag: where the edge arrow leads pilot `p`, as { at, hostile }:
   * home with an enemy flag; after the thief who has ours; to a teammate
   * carrying one; else to the enemy flag to raid (see targetFlag), or, with
   * every enemy flag in someone's hands, the nearest enemy carrying one.
   */
  G.flagGoal = function (p) {
    const g = this, mine = g.flags[p.side];
    if (p.flag) return { at: mine.home, hostile: false };
    if (mine.state === 'carried' && mine.carrier) return { at: mine.carrier, hostile: true };
    let near = null, bd = 1e9;
    for (const o of g.ships) {
      if (o === p || !o.flag || o.dead > 0 || o.gone) continue;
      if (o.side === p.side) return { at: o, hostile: false };
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < bd) { bd = d; near = o; }
    }
    const f = (g.arrowFlag = targetFlag(p, g, g.arrowFlag));
    return f ? { at: f, hostile: false } : { at: near, hostile: !!near };
  };

  /**
   * Replace Flag, as a sharp pilot plays it: kept for the moment it
   * matters, and then used at once (give or take a moment's reaction) - a
   * teammate waits at home with their flag, or the thief is nearly home
   * with ours. A flag lying loose goes home after a while anyway; that is
   * only worth one if nobody has touched it back in some seconds.
   */
  function aiReflag(s, g, dt) {
    const ai = s.ai, mine = g.flags[s.side];
    if (!(s.reflag > 0) || mine.state === 'home') { ai.flagWait = null; ai.flagUrgent = false; return; }
    if (ai.flagWait == null) ai.flagWait = mine.state === 'dropped' ? 8 + Math.random() * 6 : 1e9; // (a loose flag: not for ever)
    const home = mine.home, thief = mine.carrier;
    const waiting = g.ships.some(function (o) { return o.flag && o.side === s.side && Math.hypot(o.x - home.x, o.y - home.y) < 450; });
    const scoring = thief && Math.hypot(thief.x - g.flags[thief.side].home.x, thief.y - g.flags[thief.side].home.y) < 1300;
    if ((waiting || scoring) && !ai.flagUrgent) { ai.flagUrgent = true; ai.flagWait = Math.min(ai.flagWait, 0.3 + Math.random() * 0.9 / ai.aggro); }
    if ((ai.flagWait -= dt) <= 0) { ai.flagWait = null; ai.flagUrgent = false; G.tryReflag(s); }
  }

  /**
   * A pick-up worth a detour on this job, within `reach`. The Replace Flag
   * too, a short way off the route: there is only one, and while we hold it
   * nobody else can.
   */
  function ctfPickup(s, g, reach, far) {
    let best = null, bd = reach;
    const wantFlag = !reflagHolder(g);
    for (const p of g.pickups) {
      if (!p.on) continue;
      const t = p.type;
      if (p.kind === 'W' ? !!s.weapon : t === 'reflag' ? !wantFlag : t === 'nitro' ? !far
        : t === 'repair' ? s.hp > s.maxHp * 0.7 : t === 'shield' ? s.shield > 0 : true) continue;
      const d = Math.hypot(p.x - s.x, p.y - s.y) * (t === 'repair' && s.hp < s.maxHp * 0.4 ? 0.5 : t === 'reflag' ? 1.6 : 1); // (a Replace Flag: only a short way off the route)
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /**
   * Capture the flag gunnery. The cannon (or the weapon in hand) is aimed,
   * as a player aims with the fire stick: at the thief with our flag or the
   * enemy carrying theirs if in reach, else the nearest enemy, leading the
   * shot, with a hand as steady as the pilot's skill - but only within
   * GUN_ARC of the nose, so a ship has to be pointed roughly at you to hit
   * you. Mines go behind; a defender also drops them round its own flag.
   */
  const GUN_ARC = 0.7;
  function aiGunner(s, g, dt) {
    const ai = s.ai, inp = s.input, w = s.weapon || 'blaster';
    ai.fireT -= dt;
    if (ai.fireT > 0 || s.stun > 0 || s.emp > 0) return;
    const range = w === 'missile' ? 640 : w === 'emp' ? C.EMP_RANGE * 0.7 : w === 'mine' ? 190 : 470;
    let o = null, bs = 1e9;
    for (const e of g.ships) {
      if (e.dead > 0 || e.gone || e.side === s.side || e.invuln > 0) continue;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d > range) continue;
      const sc = d * (e.flag || e === ai.mark ? 0.45 : 1);
      if (sc < bs) { bs = sc; o = e; }
    }
    if (w === 'mine') { // behind us, or (defending) round our flag
      const home = g.flags[s.side].home;
      let lay = !!o && ((o.x - s.x) * Math.cos(s.angle) + (o.y - s.y) * Math.sin(s.angle)) < -0.5 * Math.hypot(o.x - s.x, o.y - s.y);
      if (!lay && ai.job === 'defend' && Math.hypot(s.x - home.x, s.y - home.y) < 230 && Math.hypot(s.x - home.x, s.y - home.y) > 70) {
        let n = 0;
        for (const m of g.mines) if (m.owner.side === s.side && Math.hypot(m.x - s.x, m.y - s.y) < 90) n++;
        lay = n === 0;
      }
      if (lay) { inp.fire = true; ai.fireT = 0.8 + Math.random() * 1.2; }
      return;
    }
    if (!o) return;
    if (w === 'emp') { inp.fire = true; ai.fireT = 1; return; }
    // lead the shot (a bolt leaves at BOLT_SPEED plus half our own velocity), misjudging the target's
    // speed a little, the more so the less skilled: so jinking about beats a rookie and troubles an ace
    const sp = w === 'missile' ? C.MISSILE_SPEED : C.BOLT_SPEED;
    if ((ai.leadT = (ai.leadT || 0) - dt) <= 0) { ai.leadT = 0.4 + Math.random() * 0.4; ai.leadK = 1 + (Math.random() * 2 - 1) * ai.wobble * 6; }
    let px = o.x, py = o.y;
    for (let k = 0; k < 2; k++) {
      const t = Math.hypot(px - s.x, py - s.y) / sp;
      px = o.x + (o.vx * ai.leadK - s.vx * 0.5) * t; py = o.y + (o.vy * ai.leadK - s.vy * 0.5) * t;
    }
    const a = Math.atan2(py - s.y, px - s.x) + (Math.random() - 0.5) * 1.6 * ai.wobble + Math.sin(g.t * 2.1 + ai.margin) * ai.wobble * 0.5;
    if (Math.abs(angDiff(a, s.angle)) > GUN_ARC) return;
    inp.aim = a; inp.fire = true;
    ai.fireT = w === 'blaster' ? 0.15 / Math.min(1, ai.aggro) : (0.6 + Math.random() * 1.2) / ai.aggro;
  }

  /**
   * Capture the flag brain: the job the team plan gave it (see ctfPlan),
   * flown by route round planets and asteroid fields, with pick-ups on the
   * way, the guns on whoever matters most, and Replace Flag at the right time.
   */
  function thinkCTF(s, g, dt) {
    const ai = s.ai, me = s.side, mine = g.flags[me], home = mine.home;
    s.speedMult = ai.skill;
    ctfPlan(g);
    aiReflag(s, g, dt);
    const job = s.flag ? 'carry' : ai.job || 'attack', mark = ai.mark && ai.mark.dead <= 0 && !ai.mark.gone ? ai.mark : null;
    let tx = home.x, ty = home.y, opt = null, chase = null, idle = 0, far = false;

    if (job === 'carry') {
      // home, steering round the enemy ahead (those already on our tail are outrun, not steered round);
      // with our flag away, wait there, or fetch it if it lies close
      const foes = g.ships.filter(function (o) { return o.side !== me && o.dead <= 0 && !o.gone && Math.hypot(o.x - s.x, o.y - s.y) > 500; });
      opt = { avoid: foes };
      if (mine.state === 'dropped' && Math.hypot(mine.x - s.x, mine.y - s.y) < 700) { tx = mine.x; ty = mine.y; opt = null; }
      else if (mine.state !== 'home') idle = 60;
      far = Math.hypot(tx - s.x, ty - s.y) > 900;
    } else if (job === 'hunt' && mark && mark.flag) {
      // after the thief; from far behind, cut them off at their own base instead
      const base = g.flags[mark.side].home, dm = Math.hypot(mark.x - s.x, mark.y - s.y);
      if (dm > 1000 && Math.hypot(s.x - base.x, s.y - base.y) < Math.hypot(mark.x - base.x, mark.y - base.y)) {
        const k = Math.hypot(mark.x - base.x, mark.y - base.y) || 1;
        tx = base.x + (mark.x - base.x) / k * 220; ty = base.y + (mark.y - base.y) / k * 220;
      } else chase = mark;
      far = dm > 900;
    } else if (job === 'recover' && mine.state === 'dropped') {
      tx = mine.x; ty = mine.y; far = Math.hypot(tx - s.x, ty - s.y) > 900;
    } else if (job === 'escort' && mark && mark.flag) {
      // ahead of the carrier, taking on whoever comes near them
      const foe = nearestEnemy(s, g, mark, 600);
      if (foe) chase = foe;
      else { tx = mark.x + mark.vx * 0.6; ty = mark.y + mark.vy * 0.6; idle = 50; }
    } else if (job === 'defend') {
      // between our flag and the nearest raider; out to meet them, but never far from home
      const foe = nearestEnemy(s, g, home, 1300);
      if (foe && Math.hypot(foe.x - home.x, foe.y - home.y) < 950 && Math.hypot(s.x - home.x, s.y - home.y) < 1500) chase = foe;
      else {
        const at = foe || g.track.center, k = Math.hypot(at.x - home.x, at.y - home.y) || 1;
        tx = home.x + (at.x - home.x) / k * 200; ty = home.y + (at.y - home.y) / k * 200; idle = 45;
      }
    } else {
      // attack: an enemy flag (see targetFlag), by this ship's way round whatever is in between;
      // with every enemy flag in someone's hands, the nearest enemy carrying one (wrecked, they drop it)
      if (!ai.tflag || ai.tflag.state === 'carried') ai.tflag = targetFlag(s, g, null);
      const f = ai.tflag;
      if (f) {
        tx = f.x; ty = f.y;
        opt = { lane: ai.lane };
        far = Math.hypot(tx - s.x, ty - s.y) > 900;
      } else {
        let bd = 1e9;
        for (const o of g.ships) {
          const d = Math.hypot(o.x - s.x, o.y - s.y);
          if (o.side !== me && o.flag && o.dead <= 0 && d < bd) { bd = d; chase = o; }
        }
        if (!chase) idle = 45; // (nothing to raid: hold at home)
      }
    }

    // a pick-up on the way, if it is close and worth it on this job
    ai.pickT = (ai.pickT || 0) - dt;
    if (ai.pickT <= 0) {
      ai.pickT = 0.3;
      ai.pick = ctfPickup(s, g, job === 'carry' || job === 'hunt' ? 170 : job === 'defend' ? 320 : 260, far);
    }
    if (ai.pick && ai.pick.on && !(chase && Math.hypot(chase.x - s.x, chase.y - s.y) < 300)) { tx = ai.pick.x; ty = ai.pick.y; chase = null; idle = 0; }
    else if (chase) {
      const d = Math.hypot(chase.x - s.x, chase.y - s.y), lead = Math.min(0.6, d / 700);
      tx = chase.x + chase.vx * lead; ty = chase.y + chase.vy * lead;
    }
    const inside = insideWalls(g, tx, ty, 80);
    tx = inside.x; ty = inside.y;
    const near = Math.hypot(tx - s.x, ty - s.y);
    const at = routeTo(s, g, dt, tx, ty, opt);
    flyAt(s, g, dt, at.x, at.y, !!chase && near < 300, idle > 0 && near < idle);
  }

  /**
   * Fly towards (tx, ty) round planets and rocks (`chase`: a ship close by, aimed at; `idle`: stay put), and shoot.
   * Capture the flag also leans against the planets' pull, climbs straight off a planet it is scraping, and aims its guns.
   */
  function flyAt(s, g, dt, tx, ty, chase, idle) {
    const ai = s.ai, inp = s.input;
    const dx = tx - s.x, dy = ty - s.y, dist = Math.hypot(dx, dy) || 1;
    const bent = dodge(s, g, dx / dist, dy / dist, dist, ai.margin);
    let want, ux = steer.x, uy = steer.y, gx = 0, gy = 0, low = null;
    if (g.ctf) {
      pullAt(g, s.x, s.y);
      gx = pull.x * 0.6; gy = pull.y * 0.6;
      for (const p of g.track.planets) {
        const gap = Math.hypot(s.x - p.x, s.y - p.y) - p.r;
        if (gap < 60 && (!low || gap < low.gap)) low = { p: p, gap: gap };
      }
      if (low && low.gap < 30) { // scraping a planet: mostly straight up and away
        const p = low.p, d = Math.hypot(s.x - p.x, s.y - p.y) || 1;
        ux = ux * 0.5 + (s.x - p.x) / d; uy = uy * 0.5 + (s.y - p.y) / d;
      }
    }
    if (chase && !bent && dist < 300) want = Math.atan2(dy, dx) + Math.sin(g.t * 2.3 + ai.margin) * (ai.wobble || 0);
    else want = Math.atan2(uy * 330 - s.vy * 0.45 - gy, ux * 330 - s.vx * 0.45 - gx); // against our own drift (and the pull)
    const diff = angDiff(want, s.angle), ad = Math.abs(diff);
    inp.turn = clamp(diff * 6, -1, 1);
    inp.thrust = idle ? 0 : ad > 1.7 ? 0 : ad > 1 ? 0.45 : chase && dist < 110 ? 0.5 : 1; // ease off rather than ram

    const speed = Math.hypot(s.vx, s.vy);
    if (speed < 24 && s.stun <= 0 && inp.thrust > 0.4) ai.stuck += dt; else ai.stuck = Math.max(0, ai.stuck - dt * 2);
    if (ai.stuck > 1.2) {
      ai.stuck = 0;
      if (low) { ai.esc = 1; ai.escP = low.p; } // pinned to a planet: climb away from it
      else { ai.rev = 0.7; ai.revTurn = Math.random() < 0.5 ? -1 : 1; }
    }
    if (ai.esc > 0) {
      ai.esc -= dt;
      const p = ai.escP;
      inp.turn = clamp(angDiff(Math.atan2(s.y - p.y, s.x - p.x), s.angle) * 6, -1, 1);
      inp.thrust = 1; inp.brake = 0;
    } else if (ai.rev > 0) { ai.rev -= dt; inp.thrust = 0; inp.brake = 1; inp.turn = ai.revTurn; }

    if (g.ctf) aiGunner(s, g, dt); else aiFire(s, g, dt);
  }

  /** Online: the human furthest round the course, still racing (the rivals pace themselves on them). */
  function leadHuman(g) {
    let best = null;
    for (const s of g.ships) if (s.human && !s.finished && (!best || s.progress > best.progress)) best = s;
    return best;
  }

  function think(s, g, dt) {
    const ai = s.ai, inp = s.input, tr = g.track, cps = tr.cps, N = cps.length;
    inp.turn = 0; inp.thrust = 0; inp.brake = 0; inp.fire = false; inp.aim = null;
    if (g.phase !== 'race' || s.dead > 0) return;
    if (g.ctf) { thinkCTF(s, g, dt); return; }
    if (g.combat) { thinkCombat(s, g, dt); return; }

    // rubber band: ease off when well ahead of the player, push when behind
    const ref = g.server ? leadHuman(g) : g.player;
    if (!g.demo && !g.playerDone && ref && s !== ref && !s.human) {
      s.speedMult = ai.skill * (1 - ai.rubber * clamp((s.progress - ref.progress) / 1.5, -1, 1));
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

    dodge(s, g, ux, uy, dist, ai.margin);
    ux = steer.x; uy = steer.y;

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

    aiFire(s, g, dt);
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
    if (g.server) return;
    const f = g.player.gone && g.spec ? g.spec : g.player; // out of a battle royale: watch a survivor
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
      else if (s.remote) continue; // online: another player's ship, drawn from the server's snapshots
      else {
        const inp = s.netInput || RR.input.read(s);
        s.input.turn = inp.turn; s.input.thrust = inp.thrust; s.input.brake = inp.brake; s.input.fire = inp.fire;
        s.input.aim = inp.aim; s.input.stick = inp.stick; s.input.keyAim = !!inp.keyAim;
      }
      if (racing) tryFire(s, g);
      updateShip(s, g, dt, racing);
    }
    collideShips(g);
    if (!g.combat) updateCheckpoints(g);
    updatePickups(g, dt);
    updateShots(g, dt);
    updateMines(g, dt);
    updateWaves(g, dt);
    updateRocks(g, dt);
    updateFx(g, dt);
    if (g.combat) updateCombat(g, dt);
    else rank(g);

    if (g.server) return;
    // "wrong way" when the player keeps flying away from the next gate
    const p = g.player;
    if (!g.demo && !g.combat && racing && p.dead <= 0) {
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
    if (g.state === 'paused' || g.state === 'layout') return;
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
    if (g.state !== 'play') { if (hit.aimL) hit.left = true; if (hit.aimR) hit.right = true; } // A / D aim in a race; elsewhere, left / right
    if (hit.mute) g.toggleSound();
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
      if (hit.up || hit.down) { g.menuRow = (g.menuRow + (hit.up ? 2 : 1)) % 3; RR.audio.sfx('select'); }
      const d = hit.left ? -1 : hit.right ? 1 : 0;
      if (d) { if (g.menuRow === 0) g.setMode(d); else if (g.menuRow === 1) g.setTrack(d); else g.setDiff(d); }
      if (hit.ok || hit.fire) g.begin();
      else if (hit.name) g.editName();
      else if (hit.board) g.showBoard();
      else if (hit.history) g.showHistory();
      else if (hit.hangar) g.openHangar();
      else if (hit.online && RR.mp.available()) RR.mp.open();
    } else if (g.state === 'hangar') {
      // row 0 is the ship, rows 1.. its stats; then (on the powerups page) BUY, and a row per powerup
      const buy = STATS.length + 1, rows = buy + 1 + POWER.length;
      if (hit.up || hit.down) {
        g.hangarRow = (g.hangarRow + (hit.up ? rows - 1 : 1)) % rows;
        g.hangarPage = g.hangarRow < buy ? 'ship' : 'power';
        RR.audio.sfx('select');
      }
      const d = hit.left ? -1 : hit.right ? 1 : 0, row = g.hangarRow;
      if (d) {
        if (row === 0) g.hangarBrowse(d);
        else if (row < buy) g.spend(g.hangarShip, row - 1, d);
        else if (row === buy) { if (d > 0) g.buyUpgrade(); else RR.audio.sfx('deny'); }
        else g.powerSpend(POWER[row - buy - 1].id, d);
      }
      if (hit.ok || hit.pause || hit.hangar) g.closeHangar();
    } else if (g.state === 'board') {
      const rows = g.boardRows || [], n = rows.length;
      if (g.boardCard) {
        if (hit.ok || hit.pause || hit.board || hit.fire) g.closeCard();
      } else if (hit.left || hit.right) g.turnBoard(hit.left ? -1 : 1); // the next table
      else if ((hit.up || hit.down) && n) {
        // arrows pick a row, Enter opens it; with nothing picked, Enter closes the board as before
        g.boardSel = hit.up ? (g.boardSel <= 0 ? n - 1 : g.boardSel - 1) : (g.boardSel + 1) % n;
        RR.audio.sfx('select');
      } else if (hit.ok && rows[g.boardSel]) g.openCard(rows[g.boardSel]);
      else if (hit.ok || hit.pause || hit.board || hit.fire) g.closeBoard();
    } else if (g.state === 'history') {
      if (hit.ok || hit.pause || hit.history || hit.fire) g.closeHistory();
    } else if (g.state === 'play' && g.online) {
      if (hit.pause) g.mpMenu = !g.mpMenu; // the world goes on: a menu, not a pause
      else if (hit.quit && g.mpMenu) RR.mp.leave();
      else if (hit.defer) { if (g.ctf) g.tryReflag(); else g.tryDefer(); }
    } else if (g.state === 'online') {
      RR.mp.keys(hit);
    } else if (g.state === 'mpresults') {
      if (hit.ok || hit.pause) RR.mp.backToRoom();
    } else if (g.state === 'play') {
      if (hit.pause) g.pause();
      else if (hit.defer) { if (g.ctf) g.tryReflag(); else g.tryDefer(); }
    } else if (g.state === 'layout') {
      if (hit.pause || hit.ok) g.closeControls();
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
    I.updateTouch(g.state === 'play' && I.touchMode ? RR.touchLayout(g.W, g.H, g.inset) : null, g.ui);
    if (g.state === 'play') I.updateAim(dt, g.player);
    if (g.state === 'layout') dragControls(g);
    if (!I.typing) { I.pollPad(); handleUI(g); }
    if (g.toast) { g.toast.t += dt; if (g.toast.t >= g.toast.dur) g.toast = null; }

    if (g.online) RR.mp.frame(dt); // online: the server runs the world; this screen predicts and draws it
    else {
      g.acc += dt;
      let n = 0;
      while (g.acc >= C.STEP) {
        g.acc -= C.STEP;
        if (++n > 14) { g.acc = 0; break; } // never spiral after a long stall
        g.step(C.STEP);
      }
    }

    const p = g.player;
    const live = g.state === 'play' && g.phase === 'race' && !g.playerDone && p.dead <= 0;
    RR.audio.engine(live, live ? p.thrusting : 0, live ? Math.hypot(p.vx, p.vy) : 0);
    I.endFrame();
  };
})();
