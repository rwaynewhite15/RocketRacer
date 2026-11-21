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

test('engine: a human who finishes is flown home by autopilot; a do-over works for any human', () => {
  const { G } = createEngine();
  G.startOnline({ server: true, mode: 'race', track: 0, diff: 1, seats: [seat(0, true), seat(1, true, { levels: { rewind: 2 } }), seat(2), seat(3), seat(4), seat(5)] });
  run(G, 4.2);
  const h = G.ships[1];
  h.netInput.thrust = 1;
  run(G, 2);
  h.rewind = 2;
  assert.strictEqual(G.tryRewind(h), true, 'the second human takes a do-over');
  assert.ok(h.rw && h.rewind === 1);
  assert.ok(G.events.some((e) => e[0] === 'r' && e[1] === 1));
  run(G, 1.5);
  assert.ok(!h.rw && G.events.some((e) => e[0] === 'R' && e[1] === 1), 'and lands');
  assert.strictEqual(G.tryRewind(G.ships[2]), false, 'a bot has none');

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
