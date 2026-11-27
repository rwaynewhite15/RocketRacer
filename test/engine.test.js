'use strict';

/*
 * The game engine running headless on the server (lib/engine.js): the same
 * simulation as the browser, started with seats for online players.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createEngine } = require('../lib/engine');

const seat = (i, human, extra) => Object.assign({
  name: 'P' + i, team: i, design: i % 3, hull: 'sparrow', human: !!human, stats: [3, 3, 3, 3, 3], levels: {},
}, extra);
const STEP = 1 / 120;
const run = (G, sec, each) => { for (let i = 0; i < Math.round(sec * 120); i++) { G.step(STEP); if (each) each(); } };

test('engine: an online race runs headless; bots race, humans fly on network input', () => {
  const { G } = createEngine();
  G.startOnline({ server: true, mode: 'race', track: 0, diff: 1, seats: [seat(0, true), seat(1, true), seat(2), seat(3), seat(4), seat(5)] });
  assert.deepStrictEqual([G.state, G.phase, G.ships.length, G.server, G.online], ['play', 'countdown', 6, true, true]);
  assert.deepStrictEqual(G.ships.map((s) => s.human), [true, true, false, false, false, false]);
  assert.ok(G.ships[0].netInput && !G.ships[0].ai && G.ships[2].ai, 'humans steer by network input, bots by AI');

  const start = { x: G.ships[0].x, y: G.ships[0].y };
  run(G, 4); // countdown
  assert.strictEqual(G.phase, 'race');
  G.ships[0].netInput.thrust = 1;
  run(G, 2);
  assert.ok(Math.hypot(G.ships[0].x - start.x, G.ships[0].y - start.y) > 150, 'a human with the throttle open moves');

  let k = 0;
  while (!G.ships.slice(2).every((s) => s.finished) && k++ < 120 * 300) G.step(STEP);
  assert.ok(G.ships.slice(2).every((s) => s.finished && s.finishTime > 0), 'every bot finishes');
  assert.ok(G.events.some((e) => e[0] === 'F'), 'finishes are reported as events');
  assert.ok(G.events.some((e) => e[0] === 's'), 'sounds become events for the players');
  assert.strictEqual(G.parts.length, 0, 'no particles on a server');
});

test('engine: a human who finishes is flown home by autopilot; a gate deferral works for any human', () => {
  const { G } = createEngine();
  G.startOnline({ server: true, mode: 'race', track: 0, diff: 1, seats: [seat(0, true), seat(1, true, { levels: { defer: 2 } }), seat(2), seat(3), seat(4), seat(5)] });
  run(G, 4.2);
  const h = G.ships[1];
  h.lap = 1; h.nextCp = 1; h.cpCount = 1; // over the line and on the way to gate 1
  h.defer = 2;
  assert.strictEqual(G.tryDefer(h), true, 'the second human defers a gate');
  assert.deepStrictEqual([h.nextCp, h.cpCount, h.defer, h.used.defer], [2, 2, 1, 1], 'gate 1 counts as passed; on to gate 2');
  assert.ok(G.events.some((e) => e[0] === 'd' && e[1] === 1 && e[2] === 1), 'the players hear of it');
  G.ships[2].defer = 1; G.ships[2].nextCp = 1;
  assert.strictEqual(G.tryDefer(G.ships[2]), true, 'the server takes one from any ship that holds one (only humans pick them up)');
  G.ships[3].nextCp = 1;
  assert.strictEqual(G.tryDefer(G.ships[3]), false, 'none held, none taken');

  // a human crossing the line for the last time: the server keeps it flying
  const p = G.ships[0];
  p.lap = G.laps; p.nextCp = 0; p.cpCount = G.track.cps.length * G.laps;
  p.x = G.track.cps[0].x; p.y = G.track.cps[0].y;
  G.step(STEP);
  assert.ok(p.finished && p.ai, 'finished, with the autopilot taking over');
});

test('engine: the Indy-Galactic 500 is a walled oval - three giant donuts (the far two beyond their worlds), rock walls that keep everyone in and stop shots, three lanes', () => {
  const { RR } = createEngine();
  const idx = RR.TRACKS.findIndex((t) => t.id === 'indy'), lunar = RR.TRACKS.findIndex((t) => t.id === 'lunar');
  const tr = RR.getTrack(idx), cps = tr.cps, L = tr.lane;
  assert.deepStrictEqual([tr.name, tr.laps, cps.length], ['INDY-GALACTIC 500', 5, 3], 'just three donuts');
  assert.ok(L && L.w === 280 && L.gap === 85, 'a lane 280 across, its three lanes 85 apart');
  // the lane's map is exact: a point s round the lap and d out comes back as just that
  for (let k = 0; k < 60; k++) {
    const s0 = (k / 60) * L.lap, d0 = ((k % 5) - 2) * 60, p = L.point(s0, d0), a = L.at(p.x, p.y);
    assert.ok(Math.abs(a.d - d0) < 1e-6 && Math.min(Math.abs(a.s - s0), L.lap - Math.abs(a.s - s0)) < 1e-6, 'round trip at ' + k);
  }
  // the gates: the line on the racing line, and one on the far side of each end's world, as seen from the middle
  assert.deepStrictEqual(Array.from(cps, (c) => Math.round(L.at(c.x, c.y).d)), [0, 0, 0]); // (the engine's arrays are its own context's)
  const mid = { x: L.cx, y: L.cy };
  for (const c of cps.slice(1)) {
    const w = tr.planets.find((p) => p.r < 100 && Math.hypot(p.x - c.x, p.y - c.y) < 500);
    assert.ok(w, 'a world beside the gate');
    const toW = Math.hypot(w.x - mid.x, w.y - mid.y), toC = Math.hypot(c.x - mid.x, c.y - mid.y);
    const line = Math.abs((w.x - mid.x) * (c.y - mid.y) - (w.y - mid.y) * (c.x - mid.x)) / toC; // the world's distance off the middle-to-gate line
    assert.ok(toC > toW + w.r + 100 && line < 1, 'the gate is beyond its world');
  }
  // giant donuts as wide as the lane: any lane goes through them
  assert.deepStrictEqual([tr.donut, tr.donutR, tr.cpR], [2.5, 110, 141]);
  assert.ok(tr.cpR >= L.w / 2 - 8, 'a ship anywhere in the lane passes through');
  // rocks along both walls, all outside the lane; no loose asteroids; the worlds are in the infield
  assert.ok(tr.walls.length > 400);
  for (const w of tr.walls) assert.ok(Math.abs(L.at(w.x, w.y).d) > L.w / 2, 'a wall rock inside the lane');
  for (const side of [-1, 1]) assert.ok(tr.walls.some((w) => Math.sign(L.at(w.x, w.y).d) === side), 'rocks on both walls');
  assert.strictEqual(tr.rocks.length, 0);
  for (const p of tr.planets) assert.ok(L.at(p.x, p.y).d + p.r < -L.w / 2, 'a world in the infield');
  // pickups sit on the three lanes; weapons are off until switched on
  assert.ok(tr.pickups.every((p) => [-85, 0, 85].includes(Math.round(L.at(p.x, p.y).d))));
  assert.strictEqual(tr.def.weapons, false);
  const usual = RR.getTrack(lunar);
  assert.deepStrictEqual([usual.donut, usual.cpR, usual.lane, usual.walls.length], [1, 0, null, 0], 'other courses as they were');

  const { G } = createEngine();
  const seats = [0, 1, 2, 3, 4, 5].map((i) => seat(i, i === 0));
  G.startOnline({ server: true, mode: 'race', track: idx, diff: 1, seats });
  assert.ok(G.pickups.length && G.pickups.every((p) => p.kind !== 'W'), 'unless switched on, no weapon crates');
  for (const sl of tr.grid) assert.ok(Math.hypot(sl.x - cps[0].x, sl.y - cps[0].y) > tr.cpR + 40 && Math.abs(L.at(sl.x, sl.y).d) < 40, 'a grid slot in the lane, clear of the line');
  run(G, 4);
  for (const x of G.ships.slice(1)) x.ai = null; // (hands off: only the test moves ships)
  const s = G.ships[0];
  s.netInput.thrust = 0;

  // the walls keep a ship in: flown flat out at either wall it bounces off and stays in the lane, a hard knock dents it
  for (const side of [1, -1]) {
    const at = L.point(300, 0);
    s.x = at.x; s.y = at.y; s.vx = at.nx * side * 520; s.vy = at.ny * side * 520; s.angle = Math.atan2(s.vy, s.vx); // (nose first)
    s.angVel = 0; s.hp = s.maxHp; s.invuln = 0; s.shield = 0;
    let worst = 0;
    for (let k = 0; k < 120; k++) { G.step(STEP); worst = Math.max(worst, Math.abs(L.at(s.x, s.y).d)); }
    assert.ok(worst <= L.w / 2 - 8 + 0.01, (side > 0 ? 'outer' : 'inner') + ' wall: kept in (' + worst.toFixed(1) + ')');
    assert.ok(s.hp < s.maxHp && s.dead <= 0, 'a dent, not a wreck');
  }
  // ...and stops shots: a bolt fired across the infield dies at the wall
  const at = L.point(300, 0), away = L.point(2600, 0);
  s.x = away.x; s.y = away.y; s.vx = s.vy = 0; // (out of the bolt's way)
  G.shots.push({ type: 'bolt', owner: G.ships[1], x: at.x, y: at.y - 30, vx: 0, vy: -640, angle: 0, life: 3, dmg: 10, color: '#fff' });
  const bolt = G.shots[G.shots.length - 1];
  run(G, 0.5);
  assert.ok(!G.shots.includes(bolt), 'the bolt is gone');
  assert.ok(G.events.some((e) => e[0] === 's' && e[1] === 'rock'), 'with a crack of rock');

  // a wreck comes back on the lane where it was, facing the way round (not back at the last gate, a third of a lap behind)
  s.cpCount = 1; s.nextCp = 1; s.lap = 1;
  const wreck = L.point(1000, 120);
  s.x = wreck.x; s.y = wreck.y; s.vx = s.vy = 0;
  s.dead = 0.005; // (a wreck about to come back, out by the outer wall)
  G.step(STEP);
  const back = L.at(s.x, s.y);
  assert.ok(Math.abs(back.s - 1000) < 5 && Math.abs(back.d) <= L.gap + 0.01, 'back on the lane at the same place');
  assert.ok(Math.abs(RR.angDiff(s.angle, Math.atan2(back.ty, back.tx))) < 0.01, 'facing the way round');

  // fast and clean: the same bots get round quicker than on Lunar Loop, nobody wrecked or stuck
  const speed = (t) => {
    const e = createEngine();
    e.G.startOnline({ server: true, mode: 'race', track: t, diff: 1, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i)) });
    let k = 0, wrecks = 0;
    const was = e.G.ships.map(() => false);
    while (!e.G.ships.every((x) => x.finished) && k++ < 120 * 400) {
      e.G.step(STEP);
      e.G.ships.forEach((x, i) => { if (x.dead > 0 && !was[i]) wrecks++; was[i] = x.dead > 0; });
    }
    assert.ok(e.G.ships.every((x) => x.finished), e.G.track.name + ': every bot finishes');
    const trk = e.G.track, lap = trk.lane ? trk.lane.lap : trk.cps.reduce((m, c) => m + c.segLen, 0);
    const mean = e.G.ships.reduce((m, x) => m + x.finishTime, 0) / 6;
    return { v: (lap * e.G.laps) / mean, wrecks, stuck: e.G.ships.reduce((m, x) => m + x.ai.stuckN, 0) };
  };
  const fast = speed(idx), easy = speed(lunar);
  assert.ok(fast.v > easy.v * 1.15, 'average speed: ' + Math.round(fast.v) + ' here, ' + Math.round(easy.v) + ' on Lunar Loop');
  assert.deepStrictEqual([fast.wrecks, fast.stuck], [0, 0], 'nobody wrecked or stuck on the oval');
});

test('engine: in a Grand Prix the autopilot flies the player round any course - left and right change lane, one per push - while they fire and brake; a fight is flown by hand', () => {
  const human = { name: 'P', team: 0, design: 0, hull: 'sparrow', human: true, stats: [3, 3, 3, 3, 3], levels: {} };
  const race = (id, lanes) => {
    const { G, RR } = createEngine();
    G.startOnline({ server: true, mode: 'race', track: RR.TRACKS.findIndex((t) => t.id === id), diff: 1, seats: [human] });
    const s = G.ships[0], L = G.track.lane, seen = [];
    let k = 0, push = 0, touched = 0;
    while (!s.finished && k++ < 120 * 300) {
      // a push now and then (held for a moment, as a key is), cycling the lanes asked for
      const want = lanes[Math.floor(k / (120 * 8)) % lanes.length];
      push = s.pilot && s.pilot.lane !== want && (k % 60) < 20 ? Math.sign(want - s.pilot.lane) : 0;
      const inp = G.autopilotInput(s, { turn: push, thrust: 0, brake: 0, fire: true, aim: 1.25, stick: false }, STEP);
      if (G.phase === 'race' && !s.finished) {
        assert.ok(inp.fire && inp.aim === 1.25, 'firing and aiming stay the player\'s');
        if (s.pilot) seen.push(s.pilot.lane);
      }
      s.netInput = inp;
      G.step(STEP);
      if (L && Math.abs(L.at(s.x, s.y).d) > L.w / 2 - 9) touched++;
    }
    return { s, G, seen, touched, L };
  };
  // the walled oval, in every lane: round five laps, never touching a wall, and it keeps to the lane it is in
  const indy = race('indy', [0, -1, 1, 0]);
  assert.ok(indy.s.finished, 'finished');
  assert.deepStrictEqual([...new Set(indy.seen)].sort(), [-1, 0, 1], 'every lane flown');
  assert.strictEqual(indy.touched, 0, 'never touched a wall');
  // a course of gates: lanes too, and every gate still taken (it eases back to each gate's middle)
  const lunar = race('lunar', [1, -1]);
  assert.ok(lunar.s.finished, 'round Lunar Loop as well');

  // one lane per push, however long it is held; brake still brakes
  const { G, RR } = createEngine();
  G.startOnline({ server: true, mode: 'race', track: RR.TRACKS.findIndex((t) => t.id === 'indy'), diff: 1, seats: [human] });
  run(G, 4.2);
  const s = G.ships[0];
  for (let k = 0; k < 30; k++) G.autopilotInput(s, { turn: 1, thrust: 0, brake: 0 }, STEP);
  assert.strictEqual(s.pilot.lane, 1, 'held right: one lane over');
  for (let k = 0; k < 5; k++) G.autopilotInput(s, { turn: 1, thrust: 0, brake: 0 }, STEP);
  assert.strictEqual(s.pilot.lane, 1);
  G.autopilotInput(s, { turn: 0, thrust: 0, brake: 0 }, STEP);
  G.autopilotInput(s, { turn: -1, thrust: 0, brake: 0 }, STEP);
  G.autopilotInput(s, { turn: 0, thrust: 0, brake: 0 }, STEP);
  G.autopilotInput(s, { turn: -1, thrust: 0, brake: 0 }, STEP);
  G.autopilotInput(s, { turn: 0, thrust: 0, brake: 0 }, STEP);
  G.autopilotInput(s, { turn: -1, thrust: 0, brake: 0 }, STEP);
  assert.strictEqual(s.pilot.lane, -1, 'three pushes left: as far as the inside lane, no further');
  const braking = G.autopilotInput(s, { turn: 0, thrust: 1, brake: 1 }, STEP);
  assert.deepStrictEqual([braking.thrust, braking.brake], [0, 1]);
  // a fight has no course to follow: the controls are the player's own, turning and all
  const own = { turn: 0.3, thrust: 0.7, brake: 0, fire: false };
  const f = createEngine();
  f.G.startOnline({ server: true, mode: 'dogfight', track: 0, diff: 1, seats: [human] });
  run(f.G, 4.2);
  assert.strictEqual(f.G.autopilotInput(f.G.ships[0], own, STEP), own);
});

test('engine: every course\'s weapons switch on and off - off, its weapon crates stay away and nobody is armed; unsaid, as the course was made', () => {
  const { RR } = createEngine();
  for (let t = 0; t < RR.TRACKS.length; t++) {
    const id = RR.TRACKS[t].id, built = RR.getTrack(t).pickups.filter((p) => p.kind === 'W').length;
    assert.ok(built > 0, id + ': has weapon crates to put out');
    const crates = (weapons) => {
      const { G } = createEngine();
      G.startOnline({ server: true, mode: 'race', track: t, diff: 2, weapons, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i)) });
      return { n: G.pickups.filter((p) => p.kind === 'W').length, G };
    };
    assert.strictEqual(crates(true).n, built, id + ': on, every crate');
    const off = crates(false);
    assert.strictEqual(off.n, 0, id + ': off, none');
    assert.ok(off.G.pickups.length > 0, id + ': the power-ups stay');
    assert.strictEqual(crates(undefined).n, id === 'indy' ? 0 : built, id + ': unsaid, as made (the Indy-Galactic 500 without)');
    // off: a whole race of Ace bots, and nobody ever holds a weapon or fires
    if (id === 'lunar' || id === 'indy') {
      const G = off.G;
      let k = 0, armed = false;
      while (!G.ships.every((x) => x.finished) && k++ < 120 * 400) { G.step(STEP); if (G.ships.some((x) => x.weapon) || G.shots.length || G.mines.length) armed = true; }
      assert.ok(G.ships.every((x) => x.finished) && !armed, id + ': raced without a shot');
    }
  }
  // fights always have their weapons, whatever is asked
  const { G } = createEngine();
  G.startOnline({ server: true, mode: 'dogfight', track: 0, diff: 1, weapons: false, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i)) });
  assert.ok(G.weapons && G.pickups.some((p) => p.kind === 'W'));
});

test('engine: online fights end on their own; rooms do not share a world', () => {
  const a = createEngine(), b = createEngine();
  a.G.startOnline({ server: true, mode: 'dogfight', track: 0, diff: 2, seats: [seat(0, true), seat(1), seat(2), seat(3), seat(4), seat(5)] });
  b.G.startOnline({ server: true, mode: 'royale', track: 1, diff: 2, seats: [seat(0, true), seat(1, true), seat(2), seat(3), seat(4), seat(5)] });
  assert.notStrictEqual(a.G, b.G);
  assert.deepStrictEqual([a.G.mode, b.G.mode, a.G.ships[1].ai !== null], ['dogfight', 'royale', true]);
  let k = 0;
  while ((!a.G.over || !b.G.over) && k++ < 120 * 400) { a.G.step(STEP); b.G.step(STEP); }
  assert.ok(a.G.over, 'the dogfight ends (five kills or the clock)');
  assert.ok(b.G.over, 'the battle royale ends (one ship left)');
  assert.ok(a.G.events.some((e) => e[0] === 'k'), 'kills are reported for the feed');
});

/* ---------------------------------------------------- capture the flag */

/** A capture the flag match on the server, past the countdown, with the bots' hands off (so only the test moves ships). */
function ctfMatch() {
  const { G, RR } = createEngine();
  G.startOnline({ server: true, mode: 'ctf', track: 0, diff: 1, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i, i < 2)) });
  run(G, 4.2);
  for (const s of G.ships) { s.ai = null; s.netInput = { turn: 0, thrust: 0, brake: 0, fire: false, aim: null, stick: false }; s.shield = 0; s.invuln = 0; }
  const park = (s, x, y) => { s.x = x; s.y = y; s.vx = s.vy = 0; s.angVel = 0; };
  // everyone out of the way, in open space near the middle line
  G.ships.forEach((s, i) => park(s, 3000 + i * 60, 600));
  G.events.length = 0;
  // (as plain arrays: the engine's own belong to its sandbox, which strict comparison tells apart)
  const news = () => Array.from(G.events.filter((e) => e[0] === 'f'), (e) => Array.from(e).slice(1).join(' '));
  const bolt = (from, to, dmg) => G.shots.push({ type: 'bolt', owner: from, x: to.x, y: to.y, vx: 0, vy: 0, life: 0.5, color: '#fff', dmg: dmg });
  return { G, RR, park, news, bolt };
}

test('engine: capture the flag - two teams on a huge map, the race\'s powerups with Replace Flag for the deferral', () => {
  const { G, RR } = ctfMatch();
  const b = G.track.bounds;
  assert.ok(b.x1 - b.x0 >= 6000 && b.y1 - b.y0 >= 3000, 'huge: ' + (b.x1 - b.x0) + ' x ' + (b.y1 - b.y0));
  const arena = RR.getArena(0).bounds;
  assert.ok((b.x1 - b.x0) * (b.y1 - b.y0) > 8 * (arena.x1 - arena.x0) * (arena.y1 - arena.y0), 'many times an arena');
  assert.deepStrictEqual(G.ships.map((s) => s.side), [0, 1, 0, 1, 0, 1], 'red, blue, red, blue...');
  assert.deepStrictEqual(G.ships.map((s) => s.team), [0, 1, 0, 1, 0, 1], 'painted in their team\'s colours');
  assert.deepStrictEqual(G.flags.map((f) => [f.state, f.x, f.y]), G.track.bases.map((h) => ['home', h.x, h.y]), 'each flag on its base');
  assert.ok(G.track.bases[0].x < G.track.bases[1].x - 5000, 'the bases far apart');
  // the powerups: the race's, with Replace Flag where the deferral was - and never more than REFLAG_MAX of those on the map
  const MAX = RR.CFG.REFLAG_MAX, onMap = () => G.pickups.filter((p) => p.on && p.type === 'reflag').length;
  assert.ok(MAX >= 1 && MAX <= 3, 'a limited number: ' + MAX);
  assert.ok(onMap() <= MAX, 'at the start: ' + onMap());
  const seen = new Set();
  let most = 0, full = 0;
  for (let i = 0; i < 400; i++) {
    for (const p of G.pickups) { p.on = false; p.timer = 0; }
    G.step(STEP);
    for (const p of G.pickups) seen.add(p.kind + ':' + p.type);
    most = Math.max(most, onMap());
    if (onMap() === MAX) full++;
  }
  assert.deepStrictEqual([...seen].sort(), ['P:nitro', 'P:reflag', 'P:repair', 'P:shield', 'W:blaster', 'W:emp', 'W:mine', 'W:missile']);
  assert.strictEqual(most, MAX, 'never more than ' + MAX + ' Replace Flags on the map at once');
  assert.ok(full > 100, 'and the limit is often reached (so it is what holds them back): ' + full);
  // the start of a match holds to it too, however the spots roll
  for (let k = 0; k < 20; k++) {
    const e = createEngine();
    e.G.startOnline({ server: true, mode: 'ctf', track: 0, diff: 1, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i)) });
    assert.ok(e.G.pickups.filter((p) => p.type === 'reflag').length <= MAX);
  }
});

test('engine: capture the flag - take, drop, return (by touch and by time), capture only with your own flag home, Replace Flag, no friendly fire, first to 3', () => {
  const { G, RR, park, news, bolt } = ctfMatch();
  const red = G.ships[0], blue = G.ships[1], red2 = G.ships[2], blue2 = G.ships[3];
  const [rf, bf] = G.flags, rh = rf.home, bh = bf.home;

  // blue takes red's flag
  park(blue, rh.x, rh.y); G.step(STEP);
  assert.deepStrictEqual([rf.state, rf.carrier === blue, blue.flag === rf], ['carried', true, true]);
  assert.deepStrictEqual(news(), ['take 0 1']);
  // red takes blue's: now both are away; blue home with red's flag cannot score while its own is gone
  park(red, bh.x, bh.y); G.step(STEP);
  assert.strictEqual(bf.state, 'carried');
  park(blue, bh.x, bh.y); run(G, 0.2, () => park(blue, bh.x, bh.y));
  assert.deepStrictEqual([[...G.caps], rf.state], [[0, 0], 'carried'], 'no capture while your own flag is away');
  park(blue, 5600, 1400); // (off the base for now)

  // red's carrier is wrecked (by a blue shot) at mid-field: blue's flag drops there
  park(red, 3500, 2900); red.hp = 5; bolt(blue2, red, 50); G.step(STEP);
  assert.deepStrictEqual([red.dead > 0, bf.state, Math.round(bf.x), Math.round(bf.y), red.flag], [true, 'dropped', 3500, 2900, null]);
  // a blue ship touches it: home at once
  park(blue2, 3500, 2900); G.step(STEP);
  assert.deepStrictEqual([bf.state, bf.x, bf.y], ['home', bh.x, bh.y], 'returned by a teammate\'s touch');
  // now blue's own flag is home: blue (holding red's) scores
  G.events.length = 0;
  park(blue, bh.x, bh.y); G.step(STEP);
  assert.deepStrictEqual([[...G.caps], rf.state, blue.flag, blue.caps], [[0, 1], 'home', null, 1], 'captured');
  assert.ok(news().includes('score 0 1'));

  // dropped and left alone: home by itself after FLAG_RETURN seconds
  park(blue, rh.x, rh.y); G.step(STEP);
  park(blue, 5200, 600); blue.hp = 5; bolt(red2, blue, 50); G.step(STEP);
  assert.strictEqual(rf.state, 'dropped');
  run(G, 10);
  assert.strictEqual(rf.state, 'dropped', 'still lying there after 10 s');
  run(G, 16);
  assert.strictEqual(rf.state, 'home', 'home after ' + RR.CFG.FLAG_RETURN + ' s');

  // Replace Flag: red's flag goes home even from the hands of a flying carrier
  run(G, 3); // (blue respawned)
  park(blue, rh.x, rh.y); G.step(STEP); park(blue, 4500, 600);
  assert.strictEqual(rf.state, 'carried');
  red2.reflag = 1;
  assert.strictEqual(G.tryReflag(red2), true);
  assert.deepStrictEqual([rf.state, rf.x, rf.y, blue.flag, red2.reflag, red2.used.reflag], ['home', rh.x, rh.y, null, 0, 1]);
  assert.strictEqual(G.tryReflag(red2), false, 'none left');
  red2.reflag = 1;
  assert.strictEqual(G.tryReflag(red2), false, 'and none needed while it is home');
  assert.strictEqual(red2.reflag, 1, 'kept for later');

  // no friendly fire: a red bolt flies straight through a red ship to the blue one behind it
  park(red2, 3000, 1500); park(blue2, 3060, 1500); red2.hp = blue2.hp = 100;
  G.shots.push({ type: 'bolt', owner: red, x: 2990, y: 1500, vx: 640, vy: 0, life: 0.5, color: '#fff', dmg: 20 });
  run(G, 0.15, () => { park(red2, 3000, 1500); park(blue2, 3060, 1500); });
  assert.deepStrictEqual([red2.hp, blue2.hp < 100], [100, true], 'through the teammate, into the enemy');
  // and a red missile's blast hurts the blue ship it hits, not the red one beside it
  red2.hp = blue2.hp = 100;
  park(red2, 3030, 1500); park(blue2, 3060, 1500);
  G.shots.push({ type: 'missile', owner: red, x: 3060, y: 1500, vx: 0, vy: 0, angle: 0, speed: 0, life: 1, target: null, smk: 0 });
  run(G, 0.05, () => { park(red2, 3030, 1500); park(blue2, 3060, 1500); });
  assert.ok(blue2.hp < 100, 'the blast hurts the enemy');
  assert.strictEqual(red2.hp, 100, 'not the teammate beside it');

  // first to 3: two more for blue ends it
  for (let k = 0; k < 2 && !G.over; k++) { park(blue, rh.x, rh.y); G.step(STEP); park(blue, bh.x, bh.y); G.step(STEP); }
  assert.deepStrictEqual([[...G.caps], G.over], [[0, 3], true]);
  assert.deepStrictEqual(Array.from(G.order.slice(0, 3), (s) => s.side), [1, 1, 1], 'the winning team first');
  assert.strictEqual(G.order[0], blue, 'and its best scorer on top');
});

test('engine: capture the flag - bots play whole matches: they take flags, use Replace Flag, and finish by the clock or the score', () => {
  let takes = 0, replaces = 0, caps = 0;
  for (let k = 0; k < 4 && !(k >= 1 && takes >= 4 && replaces + caps >= 1); k++) { // (matches vary: up to four, until we have seen enough)
    const { G, RR } = createEngine();
    G.startOnline({ server: true, mode: 'ctf', track: 0, diff: 1, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i)) });
    while (!G.over && G.raceTime < 400) {
      G.step(STEP);
      for (const e of G.events) if (e[0] === 'f') { if (e[1] === 'take') takes++; if (e[1] === 'replace') replaces++; }
      G.events.length = 0;
    }
    assert.ok(G.over && G.raceTime <= RR.CFG.CTF_TIME + 0.01, 'over by the time limit at the latest: ' + G.raceTime);
    caps += G.caps[0] + G.caps[1];
  }
  assert.ok(takes >= 4, 'flags are taken: ' + takes);
  assert.ok(replaces + caps >= 1, 'and replaced or captured: ' + replaces + ' ' + caps);
});

/** A capture the flag match of bots only, past the countdown. `diff`: their skill; `idle`: seat 0 is a player who never touches the controls. */
function botMatch(diff, idle) {
  const { G, RR } = createEngine();
  G.startOnline({ server: true, mode: 'ctf', track: 0, diff: diff == null ? 1 : diff, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i, idle && i === 0)) });
  run(G, 4.2);
  return { G, RR };
}
/** Only `keep` thinks for itself; everyone else is parked out of the way, hands off. */
function solo(G, keep) {
  const corners = [[800, 600], [7200, 3400], [800, 3400], [7200, 600], [1500, 600], [6500, 3400]];
  G.ships.forEach((s, i) => {
    if (keep.includes(s)) return;
    s.ai = null; s.netInput = { turn: 0, thrust: 0, brake: 0, fire: false, aim: null, stick: false };
    s.x = corners[i][0]; s.y = corners[i][1]; s.vx = s.vy = 0;
  });
}
const parkAt = (s, x, y, angle) => { s.x = x; s.y = y; s.vx = s.vy = 0; s.angVel = 0; if (angle !== undefined) s.angle = angle; };

test('engine: capture the flag - the giant in the middle holds nobody: its pull is weaker than any rocket\'s thrust, and a bot pressed against it flies round it to the flag, and home', () => {
  const { G, RR } = botMatch(0);
  const C = RR.CFG, giant = G.track.planets[0], [rf, bf] = G.flags;
  assert.ok(giant.r >= 250 && Math.abs(giant.x - 4000) < 1 && Math.abs(giant.y - 2000) < 1, 'the giant, right between the bases');
  // the slowest rival there is (a rookie at the bottom of its spread) still out-thrusts the pull at the surface, and by a margin
  const rookie = RR.DIFFS[0].speed - RR.DIFFS[0].spread;
  const surface = giant.g * (giant.r / (giant.r + C.SHIP_R)) ** 2;
  assert.ok(surface < C.THRUST * rookie * 0.85, 'pull ' + surface.toFixed(0) + ' against thrust ' + (C.THRUST * rookie).toFixed(0));

  // a red bot nose-first against the giant's near side, the blue flag straight through it: it goes round and takes the flag
  const red = G.ships[2];
  solo(G, [red]);
  parkAt(red, giant.x - giant.r - C.SHIP_R, giant.y, 0);
  let clear = 0, t = 0;
  while (bf.state === 'home' && t++ < 120 * 45) {
    G.step(STEP);
    if (!clear && Math.hypot(red.x - giant.x, red.y - giant.y) - giant.r > 150) clear = t / 120;
  }
  assert.ok(clear > 0 && clear < 9, 'it climbs clear of the giant (from a standstill, nose in): ' + clear.toFixed(1) + ' s'); // (4 to 7 s, as a rule)
  assert.strictEqual(bf.carrier, red, 'and takes the blue flag, after ' + (t / 120).toFixed(1) + ' s');

  // and with the flag, from the giant's far side, round it again and home: a capture
  parkAt(red, giant.x + giant.r + C.SHIP_R, giant.y, Math.PI);
  t = 0;
  while (!G.caps[0] && t++ < 120 * 45) G.step(STEP);
  assert.deepStrictEqual([[...G.caps], red.caps, rf.state], [[1, 0], 1, 'home'], 'captured, after ' + (t / 120).toFixed(1) + ' s');
});

test('engine: capture the flag - the bots play as a team: two attack by opposite ways and one guards; a thief is hunted by two, a loose flag fetched, a carrier covered', () => {
  const { G } = botMatch(1);
  const jobs = () => G.ships.map((s) => s.ai.job);
  G.step(STEP);
  assert.deepStrictEqual(jobs(), ['attack', 'attack', 'attack', 'attack', 'defend', 'defend'], 'two attack and one guards, on each side');
  assert.deepStrictEqual([G.ships[0].ai.lane * G.ships[2].ai.lane, G.ships[1].ai.lane * G.ships[3].ai.lane], [-1, -1], 'by the north way and the south');

  // blue (1) takes red's flag: the two red ships nearest the thief hunt it; red's third keeps attacking; blue covers its carrier, its guard stays
  const [rf] = G.flags, thief = G.ships[1];
  parkAt(G.ships[0], 2600, 1400); parkAt(G.ships[2], 6000, 1400); parkAt(G.ships[4], 1500, 2100); // (red: near, far, near)
  parkAt(G.ships[3], 1900, 2600); parkAt(G.ships[5], 6600, 2000);
  parkAt(thief, rf.x, rf.y); G.step(STEP);
  assert.strictEqual(rf.carrier, thief);
  G.step(STEP); // (the ships think before the flags move: the plan follows on the next step)
  assert.deepStrictEqual(jobs(), ['hunt', 'carry', 'attack', 'escort', 'hunt', 'defend']);
  assert.ok(G.ships[0].ai.mark === thief && G.ships[4].ai.mark === thief && G.ships[3].ai.mark === thief, 'all about the thief');

  // the thief is wrecked: the red ship nearest the flag fetches it
  parkAt(thief, 2500, 2000); thief.invuln = 0; thief.shield = 0; thief.hp = 1;
  G.shots.push({ type: 'bolt', owner: G.ships[2], x: thief.x, y: thief.y, vx: 0, vy: 0, life: 0.5, color: '#fff', dmg: 50 });
  parkAt(G.ships[0], 2650, 1900); // (the nearest red now)
  G.step(STEP);
  assert.strictEqual(rf.state, 'dropped');
  G.step(STEP);
  assert.strictEqual(G.ships[0].ai.job, 'recover', 'the nearest fetches the flag');
  solo(G, [G.ships[0], G.ships[2], G.ships[4]]); // (blue out of the way: the race for the flag is not what this is about)
  const left = Math.hypot(G.ships[0].x - rf.x, G.ships[0].y - rf.y);
  let t = 0;
  while (rf.state === 'dropped' && t++ < 120 * 8) G.step(STEP);
  assert.strictEqual(rf.state, 'home', 'and touched it home, ' + left.toFixed(0) + ' px away, in ' + (t / 120).toFixed(1) + ' s');
});

test('engine: capture the flag - a bot keeps its Replace Flag until it decides the point: the thief nearly home, or a teammate waiting at home with theirs', () => {
  const { G } = botMatch(1);
  const [rf, bf] = G.flags, red = G.ships[2], thief = G.ships[1];
  solo(G, [red]);
  parkAt(thief, rf.x, rf.y); G.step(STEP);
  assert.strictEqual(rf.carrier, thief);
  // the thief far from home: the Replace Flag is kept
  red.reflag = 1;
  const hold = () => { thief.invuln = 9; parkAt(thief, thief.x, thief.y); };
  parkAt(thief, 2500, 600); run(G, 6, hold);
  assert.deepStrictEqual([rf.state, red.reflag], ['carried', 1], 'kept while the thief is far from home');
  // the thief nearly home: used, within a moment
  parkAt(thief, bf.home.x - 900, bf.home.y - 600); // (1080 px out)
  let t = 0;
  while (red.reflag && t++ < 120 * 3) { G.step(STEP); hold(); }
  assert.deepStrictEqual([rf.state, red.reflag, thief.flag], ['home', 0, null], 'used as the thief nears home, after ' + (t / 120).toFixed(1) + ' s');

  // a red teammate home with the blue flag while red's own is away: used at once, and that is a capture
  const mate = G.ships[0];
  parkAt(thief, rf.x, rf.y); G.step(STEP);
  parkAt(thief, 2500, 600);
  parkAt(mate, bf.x, bf.y); G.step(STEP);
  assert.deepStrictEqual([rf.state, bf.carrier], ['carried', mate]);
  parkAt(mate, rf.home.x, rf.home.y);
  red.reflag = 1;
  t = 0;
  while (!G.caps[0] && t++ < 120 * 3) { G.step(STEP); hold(); parkAt(mate, rf.home.x, rf.home.y); }
  assert.deepStrictEqual([[...G.caps], red.reflag], [[1, 0], 0], 'replaced, and so captured, after ' + (t / 120).toFixed(1) + ' s');
});

test('engine: capture the flag - bots aim their guns: ahead of them, never behind; a team\'s mines never go off for it; a wreck takes ' + 4 + ' s to come back', () => {
  const { G, RR } = botMatch(1);
  const red = G.ships[2], blue = G.ships[3];
  solo(G, [red]);
  const bolts = () => G.shots.filter((b) => b.owner === red && b.type === 'bolt');
  // an enemy off to one side of the nose, in reach: a bolt goes its way
  parkAt(red, 3000, 900, 0); parkAt(blue, 3260, 1020); red.ai.fireT = 0;
  G.step(STEP);
  assert.strictEqual(bolts().length, 1, 'fired');
  const b = bolts()[0], want = Math.atan2(blue.y - 900, blue.x - 3000);
  assert.ok(Math.abs(Math.atan2(b.vy, b.vx) - want) < 0.25, 'at the enemy, not straight ahead: ' + Math.atan2(b.vy, b.vx).toFixed(2) + ' v ' + want.toFixed(2));
  // the same enemy behind: no shot
  G.shots.length = 0;
  parkAt(red, 3000, 900, 0); parkAt(blue, 2740, 900); red.ai.fireT = 0;
  G.step(STEP);
  assert.strictEqual(bolts().length, 0, 'not behind');

  // a red mine: red ships fly over it (the one that laid it too), a blue one sets it off
  G.shots.length = 0;
  parkAt(blue, 5000, 3000);
  G.mines.push({ owner: red, x: 3500, y: 3000, vx: 0, vy: 0, t: 5, ph: 0 });
  for (const s of [red, G.ships[4]]) { parkAt(s, 3500, 3000); G.step(STEP); }
  assert.strictEqual(G.mines.length, 1, 'still there');
  parkAt(G.ships[4], 3000, 3300); parkAt(red, 3000, 3200); parkAt(blue, 3500, 3000); G.step(STEP);
  assert.strictEqual(G.mines.length, 0, 'gone off under the blue ship');

  // wrecked: back after CTF_RESPAWN, beside its own base
  assert.strictEqual(RR.CFG.CTF_RESPAWN, 4);
  blue.shield = 0; blue.invuln = 0; blue.hp = 1; parkAt(blue, 5000, 3000);
  G.shots.push({ type: 'bolt', owner: red, x: blue.x, y: blue.y, vx: 0, vy: 0, life: 0.5, color: '#fff', dmg: 50 });
  G.step(STEP);
  assert.ok(blue.dead > 0, 'wrecked');
  run(G, 3.8);
  assert.ok(blue.dead > 0, 'still out after 3.8 s');
  run(G, 0.4);
  assert.ok(blue.dead <= 0 && Math.hypot(blue.x - G.flags[1].home.x, blue.y - G.flags[1].home.y) < 450, 'back by its base after 4 s');
});

test('engine: capture the flag - the bots go for the flag and bring it home: whole matches see flags taken by both teams and captures made, and three bots beat a team a pilot short', () => {
  // bots only: every match, both teams raid; captures are made
  let caps = 0;
  for (let k = 0; k < 3 && !(k >= 1 && caps >= 2); k++) { // (matches vary: until we have seen enough)
    const { G } = botMatch(1);
    const takes = [0, 0];
    while (!G.over) {
      G.step(STEP);
      for (const e of G.events) if (e[0] === 'f' && e[1] === 'take') takes[1 - e[2]]++;
      G.events.length = 0;
    }
    assert.ok(takes[0] >= 3 && takes[1] >= 3, 'both teams raid, again and again: ' + takes);
    caps += G.caps[0] + G.caps[1];
  }
  assert.ok(caps >= 2, 'and score: ' + caps);

  // seat 0 a player who never moves: blue's three bots beat red's two
  let won = false;
  for (let k = 0; k < 3 && !won; k++) {
    const { G } = botMatch(1, true);
    while (!G.over) { G.step(STEP); G.events.length = 0; }
    won = G.caps[1] > G.caps[0];
  }
  assert.ok(won, 'blue beats a red team flying a pilot short');
});

test('engine: capture the flag - one Replace Flag in the whole match: never on the map while a pilot holds it, nobody else can take one, and a wrecked holder loses it', () => {
  const { G, RR, park, news, bolt } = ctfMatch();
  assert.strictEqual(RR.CFG.REFLAG_MAX, 1);
  const onMap = () => G.pickups.filter((p) => p.on && p.type === 'reflag');
  const reroll = () => { for (const p of G.pickups) { p.on = false; p.timer = 0; } }; // (every spot comes back at once, freshly rolled)
  // one lying on the map: blue takes it, and it is gone from the map
  for (const p of G.pickups) if (p.type === 'reflag') p.type = 'nitro';
  const spot = G.pickups.find((p) => p.kind === 'P');
  spot.type = 'reflag'; spot.on = true;
  const blue = G.ships[1], red = G.ships[0];
  G.events.length = 0;
  park(blue, spot.x, spot.y); G.step(STEP);
  assert.deepStrictEqual([blue.reflag, onMap().length, G.reflagHolder() === blue], [1, 0, true]);
  assert.ok(news().includes('rtake 1 1'), 'news of the team that has it: ' + news());
  park(blue, 3000, 600);
  // while blue holds it the map never offers another, however often the spots roll
  let seen = 0;
  for (let i = 0; i < 300; i++) { reroll(); G.step(STEP); seen += onMap().length; }
  assert.strictEqual(seen, 0, 'none on the map while one is held');
  // nor can anyone else pick one up (should one be lying there all the same)
  spot.type = 'reflag'; spot.on = true;
  park(red, spot.x, spot.y); G.step(STEP);
  assert.deepStrictEqual([red.reflag, spot.on], [0, true], 'red cannot take a second one');
  spot.type = 'nitro';
  park(red, 3300, 3000);
  // blue is wrecked: the Replace Flag is lost with it, and the map can offer one again
  G.events.length = 0;
  blue.shield = 0; blue.invuln = 0; blue.hp = 1; bolt(red, blue, 50); G.step(STEP);
  assert.deepStrictEqual([blue.dead > 0, blue.reflag, G.reflagHolder()], [true, 0, null]);
  assert.ok(news().includes('rlost 1 1'), 'news that the team lost it: ' + news());
  let back = false;
  for (let i = 0; i < 400 && !back; i++) { reroll(); G.step(STEP); back = onMap().length === 1; }
  assert.ok(back, 'back on the map');
});

/** The index of a flag map by its id. */
function flagMap(RR, id) { return RR.FLAG_MAPS.findIndex((m) => m.id === id); }

test('engine: capture the flag for three teams (2 v 2 v 2) - sides and colours, spawns, any enemy flag scores while your own is home, and the team with the most wins', () => {
  const { RR } = createEngine();
  const triad = flagMap(RR, 'triad');
  assert.ok(triad >= 0, 'a three-team map');
  // bots: two to a team, one raiding and one at home
  const bots = createEngine().G;
  bots.startOnline({ server: true, mode: 'ctf', track: triad, diff: 1, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i)) });
  assert.deepStrictEqual(bots.ships.map((s) => s.ai.role), ['attack', 'attack', 'attack', 'defend', 'defend', 'defend']);
  // everyone hands off from here on
  const { G } = createEngine();
  G.startOnline({ server: true, mode: 'ctf', track: triad, diff: 1, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i, true)) });
  assert.deepStrictEqual([G.teams, G.ships.map((s) => s.side), G.ships.map((s) => s.team), [...G.caps]], [3, [0, 1, 2, 0, 1, 2], [0, 1, 2, 0, 1, 2], [0, 0, 0]]);
  assert.deepStrictEqual(Array.from(RR.SIDES, (S) => S.name), ['RED', 'BLUE', 'GREEN']);
  const [rf, bf, gf] = G.flags;
  assert.deepStrictEqual(G.flags.map((f) => [f.side, f.state, f.x, f.y]), G.track.bases.map((b, k) => [k, 'home', b.x, b.y]));
  // each ship starts beside its own base, facing the middle
  const c = G.track.center;
  for (const s of G.ships) {
    const b = G.track.bases[s.side];
    assert.ok(Math.hypot(s.x - b.x, s.y - b.y) < 450, 'beside its base');
    assert.ok(Math.abs(RR.angDiff(s.angle, Math.atan2(c.y - s.y, c.x - s.x))) < 0.3, 'facing the middle');
  }
  // the three bases are a third of the way round from each other, the same distance from the middle
  const d = G.track.bases.map((b) => Math.hypot(b.x - c.x, b.y - c.y));
  assert.ok(Math.max(...d) - Math.min(...d) < 2, 'all as far from the middle');
  run(G, 4.2);
  const park = (s, x, y) => { s.x = x; s.y = y; s.vx = s.vy = 0; };
  const [red, blue, green, red2, blue2, green2] = G.ships;
  G.ships.forEach((s, i) => park(s, 2400 + i * 60, 3000 + (i % 2) * 400));
  // green takes red's flag and brings it home: a capture for green
  park(green, rf.x, rf.y); G.step(STEP);
  assert.strictEqual(rf.carrier, green);
  park(green, gf.home.x, gf.home.y); G.step(STEP);
  assert.deepStrictEqual([[...G.caps], rf.state, green.caps], [[0, 0, 1], 'home', 1]);
  assert.strictEqual(G.ctfLeader(), 2, 'green leads');
  // blue takes green's flag; then green, holding blue's, cannot score until its own is home again
  park(blue, gf.x, gf.y); G.step(STEP);
  park(blue, 3000, 4200);
  park(green2, bf.x, bf.y); G.step(STEP);
  assert.strictEqual(bf.carrier, green2);
  park(green2, gf.home.x, gf.home.y); run(G, 0.2, () => park(green2, gf.home.x, gf.home.y));
  assert.deepStrictEqual([...G.caps], [0, 0, 1], 'no capture while your own flag is away');
  park(green2, 3000, 2400); // (off the base for now)
  // blue is wrecked and drops green's flag; red takes it: any enemy flag will do
  blue.shield = 0; blue.invuln = 0; blue.hp = 1;
  G.shots.push({ type: 'bolt', owner: red2, x: blue.x, y: blue.y, vx: 0, vy: 0, life: 0.5, color: '#fff', dmg: 50 });
  G.step(STEP);
  assert.strictEqual(gf.state, 'dropped');
  park(red, gf.x, gf.y); G.step(STEP);
  assert.strictEqual(gf.carrier, red, 'red takes green\'s dropped flag');
  park(red, rf.home.x, rf.home.y); G.step(STEP);
  assert.deepStrictEqual([...G.caps], [1, 0, 1], 'red scores with green\'s');
  assert.strictEqual(G.ctfLeader(), -1, 'two teams share the most: nobody leads');
  // green's flag is home again: green2 (still holding blue's) scores; two more ends it with green on top
  park(green2, gf.home.x, gf.home.y); G.step(STEP);
  assert.deepStrictEqual([...G.caps], [1, 0, 2]);
  park(green, rf.x, rf.y); G.step(STEP); park(green, gf.home.x, gf.home.y); G.step(STEP);
  assert.deepStrictEqual([[...G.caps], G.over], [[1, 0, 3], true]);
  assert.deepStrictEqual(Array.from(G.order.slice(0, 2), (s) => s.side), [2, 2], 'the winning team first');
});

test('engine: capture the flag - a round arena\'s wall is a circle: a ship flying out is pulled back in', () => {
  const { G, RR } = createEngine();
  G.startOnline({ server: true, mode: 'ctf', track: flagMap(RR, 'crown'), diff: 1, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i, true)) });
  const w = G.track.wall;
  assert.ok(w && w.r > 2000, 'a round wall');
  run(G, 4.2);
  const s = G.ships[0];
  // straight out to the north-east (a corner of the square around the circle) at full throttle
  const a = -Math.PI / 4;
  s.x = w.x + Math.cos(a) * (w.r - 100); s.y = w.y + Math.sin(a) * (w.r - 100); s.angle = a; s.vx = Math.cos(a) * 300; s.vy = Math.sin(a) * 300;
  s.netInput.thrust = 1;
  let out = false, far = 0;
  run(G, 6, () => { s.angle = a; out = out || s.out; far = Math.max(far, Math.hypot(s.x - w.x, s.y - w.y) - w.r); });
  assert.ok(out, 'told it is outside');
  assert.ok(far < 260, 'held near the circle, not let out to the corner: ' + far.toFixed(0));
});

test('engine: capture the flag - every map plays: bots of every team raid, nobody sticks to a planet', () => {
  const { RR } = createEngine();
  for (let m = 0; m < RR.FLAG_MAPS.length; m++) {
    const id = RR.FLAG_MAPS[m].id;
    let ok = false, last = '';
    for (let k = 0; k < 2 && !ok; k++) { // (matches vary: a second go for a slow one)
      const { G } = createEngine();
      G.startOnline({ server: true, mode: 'ctf', track: m, diff: 1, seats: [0, 1, 2, 3, 4, 5].map((i) => seat(i)) });
      const takes = G.caps.map(() => 0);
      let stuck = 0;
      while (G.raceTime < 150 && !G.over) {
        G.step(STEP);
        for (const e of G.events) if (e[0] === 'f' && e[1] === 'take') takes[G.ships[e[3]].side]++;
        G.events.length = 0;
        if (G.phase !== 'race') continue;
        for (const s of G.ships) {
          if (s.dead > 0) continue;
          for (const p of G.track.planets) if (Math.hypot(s.x - p.x, s.y - p.y) - p.r < 40 && Math.hypot(s.vx, s.vy) < 40) stuck += STEP;
        }
      }
      last = id + ': takes ' + takes + ', stuck ' + stuck.toFixed(1) + ' s';
      ok = takes.every((t) => t >= 1) && stuck < 4;
    }
    assert.ok(ok, last);
  }
});
