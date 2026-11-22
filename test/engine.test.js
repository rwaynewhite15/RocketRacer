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
  // the powerups: the race's, with Replace Flag where the deferral was
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    for (const p of G.pickups) { p.on = false; p.timer = 0; }
    G.step(STEP);
    for (const p of G.pickups) seen.add(p.kind + ':' + p.type);
  }
  assert.deepStrictEqual([...seen].sort(), ['P:nitro', 'P:reflag', 'P:repair', 'P:shield', 'W:blaster', 'W:emp', 'W:mine', 'W:missile']);
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
