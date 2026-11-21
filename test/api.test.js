'use strict';

// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp, cleanName, validateScore, cleanSetup } = require('../server');
const { memoryStore } = require('../lib/store');

function start() {
  const server = http.createServer(createApp(memoryStore()));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
  }));
}
const post = (base, body, raw) => fetch(base + '/api/scores', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ? body : JSON.stringify(body),
});
const run = (over) => Object.assign({ track: 'lunar', pid: 'pilot-aaaaaaaa', name: 'Ada', time: 75.5, lap: 24.2, diff: 1, place: 2 }, over);
const board = async (base, track, pid) => (await fetch(base + '/api/scores?track=' + track, pid ? { headers: { 'X-Pilot-Id': pid } } : {})).json();

test('serves the game and hides everything else', async () => {
  const { server, base } = await start();
  try {
    const home = await fetch(base + '/');
    assert.strictEqual(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(await home.text(), /Rocket Racer/);
    assert.strictEqual((await fetch(base + '/src/game.js')).status, 200);
    assert.strictEqual((await fetch(base + '/manifest.webmanifest')).status, 200);
    assert.strictEqual((await fetch(base + '/server.js')).status, 404);
    assert.strictEqual((await fetch(base + '/package.json')).status, 404);
    // conditional requests revalidate cheaply
    const again = await fetch(base + '/', { headers: { 'If-None-Match': home.headers.get('etag') } });
    assert.strictEqual(again.status, 304);
  } finally { server.close(); }
});

test('leaderboard keeps one best time per pilot, fastest first', async () => {
  const { server, base } = await start();
  try {
    assert.deepStrictEqual(await (await fetch(base + '/api/health')).json(), { ok: true, store: 'memory', env: 'production', version: 'dev' });
    assert.deepStrictEqual((await (await fetch(base + '/api/scores?track=lunar')).json()).scores, []);

    let r = await (await post(base, run())).json();
    assert.strictEqual(r.rank, 1);
    assert.strictEqual(r.improved, true);
    assert.strictEqual(r.scores[0].name, 'ADA');

    r = await (await post(base, run({ pid: 'pilot-bbbbbbbb', name: 'grace!', time: 70.25, lap: 22 }))).json();
    assert.strictEqual(r.rank, 1);
    assert.deepStrictEqual(r.scores.map((s) => s.name), ['GRACE!', 'ADA']);

    // a slower run does not replace the pilot's best, but a rename sticks
    r = await (await post(base, run({ time: 90, lap: 28, name: 'Ada L' }))).json();
    assert.strictEqual(r.improved, false);
    assert.strictEqual(r.rank, 2);
    assert.strictEqual(r.best.time, 75.5);
    assert.strictEqual(r.scores[1].name, 'ADA L');

    // a faster one does
    r = await (await post(base, run({ time: 66.666, lap: 21 }))).json();
    assert.strictEqual(r.improved, true);
    assert.strictEqual(r.rank, 1);
    assert.strictEqual(r.scores[0].time, 66.66); // truncated like the in-game clock
    assert.strictEqual(r.scores.length, 2);

    // boards are per course, and never leak the pilot id
    assert.deepStrictEqual((await (await fetch(base + '/api/scores?track=eight')).json()).scores, []);
    assert.strictEqual(JSON.stringify(r).includes('pilot-aaaaaaaa'), false);
  } finally { server.close(); }
});

test('rejects forged or malformed submissions', async () => {
  const { server, base } = await start();
  try {
    const bad = [
      run({ track: 'nope' }), run({ track: 'constructor' }), run({ time: 5 }), run({ time: 1e9 }),
      run({ time: '75' }), run({ lap: 1 }), run({ lap: 80 }), run({ time: 50, lap: 30 }),
      run({ pid: 'x' }), run({ pid: 'has/slash/chars' }), run({ diff: 7 }), [], null,
      run({ place: 0 }), run({ place: 7 }), run({ place: 1.5 }), run({ place: '1' }),
    ];
    for (const b of bad) assert.strictEqual((await post(base, b)).status, 400, JSON.stringify(b));
    assert.strictEqual((await post(base, '{not json', true)).status, 400);
    assert.strictEqual((await post(base, JSON.stringify(run({ name: 'x'.repeat(5000) })), true)).status, 413);
    assert.strictEqual((await fetch(base + '/api/scores?track=nope')).status, 400);
    assert.strictEqual((await fetch(base + '/api/nothing')).status, 404);
    assert.deepStrictEqual((await (await fetch(base + '/api/scores?track=lunar')).json()).scores, []);
  } finally { server.close(); }
});

test('rows carry the finishing place, and a pilot can look up their own row and rank', async () => {
  const { server, base } = await start();
  try {
    // twelve pilots: the board shows ten, so two are off the bottom
    for (let i = 0; i < 12; i++) {
      const r = await post(base, run({ pid: 'pilot-' + String(i).padStart(8, '0'), name: 'P' + i, time: 60 + i, lap: 19, place: (i % 6) + 1 }));
      assert.strictEqual(r.status, 200);
    }
    const anon = await board(base, 'lunar');
    assert.strictEqual(anon.scores.length, 10);
    assert.deepStrictEqual(anon.scores.slice(0, 3).map((s) => [s.name, s.place]), [['P0', 1], ['P1', 2], ['P2', 3]]);
    assert.strictEqual(anon.me, null, 'no id sent, no personal row');

    // someone in the top ten, and someone below it
    const third = await board(base, 'lunar', 'pilot-00000002');
    assert.deepStrictEqual([third.me.rank, third.me.name, third.me.time, third.me.place], [3, 'P2', 62, 3]);
    const last = await board(base, 'lunar', 'pilot-00000011');
    assert.deepStrictEqual([last.me.rank, last.me.name, last.me.place], [12, 'P11', 6]);
    assert.strictEqual(last.scores.some((s) => s.name === 'P11'), false, 'not in the top ten list itself');

    // unknown or malformed ids just get no personal row
    assert.strictEqual((await board(base, 'lunar', 'pilot-nobody00')).me, null);
    assert.strictEqual((await board(base, 'lunar', 'bad id!')).me, null);
    assert.strictEqual((await board(base, 'eight', 'pilot-00000002')).me, null, 'rows are per course');

    // the place belongs to the run that set the time: a slower win does not change it, a faster run does
    let r = await (await post(base, run({ pid: 'pilot-00000011', name: 'P11', time: 90, lap: 19, place: 1 }))).json();
    assert.deepStrictEqual([r.improved, r.best.place, r.rank], [false, 6, 12]);
    r = await (await post(base, run({ pid: 'pilot-00000011', name: 'P11', time: 59, lap: 19, place: 4 }))).json();
    assert.deepStrictEqual([r.improved, r.best.place, r.rank, r.scores[0].name, r.scores[0].place], [true, 4, 1, 'P11', 4]);

    // a page loaded before this feature existed sends no place: still accepted, stored as null
    const old = run({ pid: 'pilot-oldclient', name: 'OLD', time: 58, lap: 19 });
    delete old.place;
    r = await (await post(base, old)).json();
    assert.deepStrictEqual([r.rank, r.best.place, r.scores[0].place], [1, null, null]);
    assert.strictEqual(JSON.stringify(r).includes('pilot-'), false, 'ids never come back');
  } finally { server.close(); }
});

test('each time keeps the setup it was set with: rocket, stat levels and powerups used', async () => {
  const { server, base } = await start();
  try {
    const setup = { ship: 'dart', stats: [6, 7, 5, 3, 4], items: { nitro: 2, missile: 1, mine: 0 }, bought: { rewind: 1, emp: 0 } };
    let r = await (await post(base, run({ pid: 'pilot-setup001', name: 'ZIP', time: 76, setup }))).json();
    const stored = { ship: 'dart', stats: [6, 7, 5, 3, 4], items: { nitro: 2, missile: 1 }, bought: { rewind: 1 } }; // zero counts dropped
    assert.deepStrictEqual(r.best.setup, stored);
    assert.deepStrictEqual(r.scores[0].setup, stored);
    assert.deepStrictEqual((await board(base, 'lunar', 'pilot-setup001')).me.setup, stored, 'in your own row too');
    assert.deepStrictEqual((await board(base, 'lunar')).scores[0].setup, stored, 'and for everyone else');

    // the setup belongs to the record run: a slower race does not change it, a faster one does
    const other = { ship: 'phoenix', stats: [9, 9, 9, 9, 9], items: { shield: 3 }, bought: {} };
    r = await (await post(base, run({ pid: 'pilot-setup001', name: 'ZIP', time: 85, setup: other }))).json();
    assert.deepStrictEqual([r.improved, r.best.setup], [false, stored]);
    r = await (await post(base, run({ pid: 'pilot-setup001', name: 'ZIP', time: 74, setup: other }))).json();
    assert.deepStrictEqual([r.improved, r.best.setup], [true, other]);

    // a clean run (no powerups) keeps an empty list; a page from before setups sends none: null
    r = await (await post(base, run({ pid: 'pilot-setup002', name: 'CLEAN', time: 77, setup: { ship: 'sparrow', stats: [3, 3, 3, 3, 3] } }))).json();
    assert.deepStrictEqual(r.best.setup, { ship: 'sparrow', stats: [3, 3, 3, 3, 3], items: {}, bought: {} });
    r = await (await post(base, run({ pid: 'pilot-setup003', name: 'OLD', time: 78 }))).json();
    assert.strictEqual(r.best.setup, null);
    assert.deepStrictEqual((await board(base, 'lunar')).scores.map((e) => e.name), ['ZIP', 'CLEAN', 'OLD']);

  } finally { server.close(); }
});

test('setups that are not a known rocket, five stat levels and known powerup counts are turned away', async () => {
  const { server, base } = await start(); // its own server: this is more posts than the rate limit allows one test
  try {
    const bad = [
      'dart', [], { ship: 'xwing', stats: [3, 3, 3, 3, 3] }, { ship: 'dart' }, { ship: 'dart', stats: [3, 3, 3, 3] },
      { ship: 'dart', stats: [3, 3, 3, 3, 11] }, { ship: 'dart', stats: [3, 3, 3, 3, 0] }, { ship: 'dart', stats: [3, 3, 3, 3, 2.5] },
      { ship: 'dart', stats: [3, 3, 3, 3, '3'] }, { ship: 'dart', stats: [3, 3, 3, 3, 3], items: [1] },
      { ship: 'dart', stats: [3, 3, 3, 3, 3], items: { laser: 1 } }, { ship: 'dart', stats: [3, 3, 3, 3, 3], items: { nitro: -1 } },
      { ship: 'dart', stats: [3, 3, 3, 3, 3], items: { nitro: 100 } }, { ship: 'dart', stats: [3, 3, 3, 3, 3], items: { nitro: 1.5 } },
      { ship: 'dart', stats: [3, 3, 3, 3, 3], items: { constructor: 1 } },
      { ship: 'dart', stats: [3, 3, 3, 3, 3], bought: [1] }, { ship: 'dart', stats: [3, 3, 3, 3, 3], bought: { laser: 1 } },
      { ship: 'dart', stats: [3, 3, 3, 3, 3], bought: { missile: -1 } }, { ship: 'dart', stats: [3, 3, 3, 3, 3], bought: { missile: 4 } },
    ];
    for (const b of bad) assert.strictEqual((await post(base, run({ pid: 'pilot-setup009', setup: b }))).status, 400, JSON.stringify(b));
    const proto = '{"track":"lunar","pid":"pilot-setup009","name":"X","time":75.5,"lap":24.2,"diff":1,"place":2,' +
      '"setup":{"ship":"dart","stats":[3,3,3,3,3],"items":{"__proto__":{"nitro":1}}}}';
    assert.strictEqual((await post(base, proto, true)).status, 400, '__proto__ is not an item');
    assert.strictEqual((await board(base, 'lunar', 'pilot-setup009')).me, null, 'none of them was stored');
    assert.deepStrictEqual(cleanSetup({ ship: 'hammer', stats: [1, 2, 3, 4, 5], items: { emp: 2, rewind: 0 }, bought: { nitro: 1 } }),
      { ship: 'hammer', stats: [1, 2, 3, 4, 5], items: { emp: 2 }, bought: { nitro: 1 } });
  } finally { server.close(); }
});

test('rate-limits a flood of submissions', async () => {
  const { server, base } = await start();
  try {
    const codes = [];
    for (let i = 0; i < 24; i++) codes.push((await post(base, run({ pid: 'pilot-' + String(i).padStart(8, '0') }))).status);
    assert.strictEqual(codes.filter((c) => c === 200).length, 20);
    assert.strictEqual(codes.filter((c) => c === 429).length, 4);
  } finally { server.close(); }
});

test('name and score validation helpers', () => {
  assert.strictEqual(cleanName('  <b>zip  py</b> 42 extra'), 'BZIP PYB 4');
  assert.strictEqual(cleanName('abcdefghi jkl'), 'ABCDEFGHI');
  assert.strictEqual(cleanName(''), 'PILOT');
  assert.strictEqual(cleanName(null), 'PILOT');
  assert.strictEqual(cleanName('señor-ñ_1.!'), 'SEOR-_1.!');
  assert.strictEqual(validateScore(run()), null);
  assert.strictEqual(validateScore(run({ track: 'gauntlet', time: 150, lap: 45 })), null);
  for (let p = 1; p <= 6; p++) assert.strictEqual(validateScore(run({ place: p })), null);

  // staging keeps its scores in a different collection
  const { collectionName } = require('../lib/store');
  assert.strictEqual(collectionName({}), 'rocketracer');
  assert.strictEqual(collectionName({ LEADERBOARD_COLLECTION: 'rocketracer-staging' }), 'rocketracer-staging');
  assert.throws(() => collectionName({ LEADERBOARD_COLLECTION: 'a/b' }));
});
