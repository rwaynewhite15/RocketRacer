'use strict';

// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp, cleanName, validateScore, cleanSetup, onlineRecorder, onlineRecorders } = require('../server');
const R = require('../public/src/records');
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
    const setup = { ship: 'dart', stats: [6, 7, 5, 3, 4], items: { nitro: 2, missile: 1, mine: 0 }, levels: { missile: 3, emp: 1, nitro: 0 } };
    let r = await (await post(base, run({ pid: 'pilot-setup001', name: 'ZIP', time: 76, setup }))).json();
    const stored = { ship: 'dart', stats: [6, 7, 5, 3, 4], items: { nitro: 2, missile: 1 }, levels: { missile: 3 } }; // zero counts and level 1 dropped
    assert.deepStrictEqual(r.best.setup, stored);
    assert.deepStrictEqual(r.scores[0].setup, stored);
    assert.deepStrictEqual((await board(base, 'lunar', 'pilot-setup001')).me.setup, stored, 'in your own row too');
    assert.deepStrictEqual((await board(base, 'lunar')).scores[0].setup, stored, 'and for everyone else');

    // the setup belongs to the record run: a slower race does not change it, a faster one does
    const other = { ship: 'phoenix', stats: [9, 9, 9, 9, 9], items: { shield: 3 }, levels: { shield: 2 } };
    r = await (await post(base, run({ pid: 'pilot-setup001', name: 'ZIP', time: 85, setup: other }))).json();
    assert.deepStrictEqual([r.improved, r.best.setup], [false, stored]);
    r = await (await post(base, run({ pid: 'pilot-setup001', name: 'ZIP', time: 74, setup: other }))).json();
    assert.deepStrictEqual([r.improved, r.best.setup], [true, other]);

    // a clean run (no powerups) keeps an empty list; a page from before setups sends none: null
    r = await (await post(base, run({ pid: 'pilot-setup002', name: 'CLEAN', time: 77, setup: { ship: 'sparrow', stats: [3, 3, 3, 3, 3] } }))).json();
    assert.deepStrictEqual(r.best.setup, { ship: 'sparrow', stats: [3, 3, 3, 3, 3], items: {}, levels: {} });
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
      { ship: 'dart', stats: [3, 3, 3, 3, 3], levels: [1] }, { ship: 'dart', stats: [3, 3, 3, 3, 3], levels: { laser: 2 } },
      { ship: 'dart', stats: [3, 3, 3, 3, 3], levels: { missile: -1 } }, { ship: 'dart', stats: [3, 3, 3, 3, 3], levels: { missile: 4 } },
    ];
    for (const b of bad) assert.strictEqual((await post(base, run({ pid: 'pilot-setup009', setup: b }))).status, 400, JSON.stringify(b));
    const proto = '{"track":"lunar","pid":"pilot-setup009","name":"X","time":75.5,"lap":24.2,"diff":1,"place":2,' +
      '"setup":{"ship":"dart","stats":[3,3,3,3,3],"items":{"__proto__":{"nitro":1}}}}';
    assert.strictEqual((await post(base, proto, true)).status, 400, '__proto__ is not an item');
    assert.strictEqual((await board(base, 'lunar', 'pilot-setup009')).me, null, 'none of them was stored');
    assert.deepStrictEqual(cleanSetup({ ship: 'hammer', stats: [1, 2, 3, 4, 5], items: { emp: 2, defer: 0, rewind: 1 }, levels: { nitro: 1, emp: 2 } }),
      { ship: 'hammer', stats: [1, 2, 3, 4, 5], items: { emp: 2 }, levels: { emp: 2 } });
  } finally { server.close(); }
});

test('online races timed by the multiplayer server are stored with the same checks, marked online', async () => {
  const store = memoryStore(), logs = [];
  const record = onlineRecorder(store, (m) => logs.push(m));
  await record({ track: 'lunar', pid: 'pilot-online01', name: 'Zed', time: 75.5, lap: 24.2, diff: 2, place: 1,
    setup: { ship: 'dart', stats: [5, 5, 5, 3, 3], items: { nitro: 1 }, levels: { missile: 3 } } });
  const top = await store.top('lunar', 10);
  assert.strictEqual(top.length, 1);
  assert.deepStrictEqual([top[0].name, top[0].online, top[0].setup.levels], ['ZED', true, { missile: 3 }]);
  assert.strictEqual(await record({ track: 'lunar', pid: 'pilot-online02', name: 'Fast', time: 5, lap: 1, diff: 1 }), null);
  assert.match(logs[0], /refused/);
  assert.strictEqual((await store.top('lunar', 10)).length, 1, 'an impossible time is not stored');
  // times posted by players themselves are not marked online
  const { server, base } = await start();
  try {
    const r = await (await post(base, run({ pid: 'pilot-offline1', name: 'Off', time: 76 }))).json();
    assert.strictEqual(r.best.online, false);
  } finally { server.close(); }
});

test('the page may connect only to itself, and to online play when it is a separate service', async () => {
  const keep = process.env.MP_URL;
  try {
    delete process.env.MP_URL;
    let { server, base } = await start();
    let csp = (await fetch(base + '/')).headers.get('content-security-policy');
    server.close();
    assert.match(csp, /connect-src 'self';/);
    process.env.MP_URL = 'wss://rocketracer-mp-staging-abc-uc.a.run.app/ws';
    ({ server, base } = await start());
    csp = (await fetch(base + '/')).headers.get('content-security-policy');
    assert.match(csp, /connect-src 'self' wss:\/\/rocketracer-mp-staging-abc-uc\.a\.run\.app;/);
    assert.match((await fetch(base + '/api/health')).headers.get('content-security-policy'), /wss:\/\/rocketracer-mp-staging/, 'on every response');
    server.close();
    process.env.MP_URL = 'javascript:alert(1)';
    ({ server, base } = await start());
    csp = (await fetch(base + '/')).headers.get('content-security-policy');
    server.close();
    assert.match(csp, /connect-src 'self';/, 'anything but a ws(s) address is ignored');
  } finally { if (keep === undefined) delete process.env.MP_URL; else process.env.MP_URL = keep; }
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
  // the Indy-Galactic 500: five quick laps
  assert.strictEqual(validateScore(run({ track: 'indy', time: 72.4, lap: 13.9 })), null);
  assert.strictEqual(validateScore(run({ track: 'indy', time: 30, lap: 5.9 })), 'Race time out of range');
  assert.strictEqual(validateScore(run({ track: 'indy', time: 50, lap: 10.5 })), 'Lap and race times disagree', 'five laps, not three');
  for (let p = 1; p <= 6; p++) assert.strictEqual(validateScore(run({ place: p })), null);

  // staging keeps its scores in a different collection
  const { collectionName } = require('../lib/store');
  assert.strictEqual(collectionName({}), 'rocketracer');
  assert.strictEqual(collectionName({ LEADERBOARD_COLLECTION: 'rocketracer-staging' }), 'rocketracer-staging');
  assert.throws(() => collectionName({ LEADERBOARD_COLLECTION: 'a/b' }));
});

test('rows made in a lent rocket are marked lent - only when the multiplayer server says so', async () => {
  const store = memoryStore();
  const record = onlineRecorder(store, () => {});
  const setup = { ship: 'phoenix', stats: [10, 10, 10, 10, 10], items: { nitro: 4 }, levels: { nitro: 3, missile: 3 } };
  await record({ track: 'indy', pid: 'pilot-lent0001', name: 'ZED', time: 61.5, lap: 11.9, diff: 1, place: 1, setup, lent: true });
  await record({ track: 'dogfight', pid: 'pilot-lent0001', name: 'ZED', diff: 1, map: 'crucible', result: { place: 1, win: true, kills: 5, deaths: 0, left: 90 }, setup, lent: true });
  await record({ track: 'indy', pid: 'pilot-own00002', name: 'OWN', time: 70.1, lap: 13.2, diff: 1, place: 2, setup: null });
  assert.deepStrictEqual((await store.top('indy', 10)).map((e) => [e.name, e.lent]), [['ZED', true], ['OWN', false]]);
  assert.strictEqual((await store.top('dogfight', 10))[0].lent, true);
  // a page cannot mark its own time lent (nor would it want to)
  const { server, base } = await start();
  try {
    const r = await post(base, run({ track: 'indy', pid: 'pilot-self0003', name: 'SELF', time: 72.4, lap: 13.9, lent: true }));
    assert.strictEqual(r.status, 200);
    const rows = (await (await fetch(base + '/api/scores?track=indy')).json()).scores;
    assert.deepStrictEqual(rows.map((e) => [e.name, e.lent]), [['SELF', false]]);
  } finally { server.close(); }
});

test('a race time says whether the autopilot flew it', async () => {
  assert.strictEqual(validateScore(run({ auto: true })), null);
  assert.strictEqual(validateScore(run({ auto: 'yes' })), 'Bad auto');
  const { server, base } = await start();
  try {
    assert.strictEqual((await post(base, run({ track: 'indy', pid: 'pilot-auto0001', name: 'AUTO', time: 70.5, lap: 13.5, auto: true }))).status, 200);
    assert.strictEqual((await post(base, run({ track: 'indy', pid: 'pilot-hand0002', name: 'HAND', time: 72.5, lap: 13.9 }))).status, 200); // (a page from before)
    const rows = (await (await fetch(base + '/api/scores?track=indy')).json()).scores;
    assert.deepStrictEqual(rows.map((e) => [e.name, e.auto]), [['AUTO', true], ['HAND', false]]);
  } finally { server.close(); }
  // and online, as the multiplayer server says
  const store = memoryStore();
  await onlineRecorder(store, () => {})({ track: 'lunar', pid: 'pilot-auto0003', name: 'ON', time: 75.5, lap: 24.2, diff: 1, place: 1, auto: true });
  assert.strictEqual((await store.top('lunar', 10))[0].auto, true);
});

test('the leaderboard knows every course the game has, with the same number of laps', () => {
  const { TRACKS } = require('../server');
  const { RR } = require('../lib/engine').createEngine();
  assert.deepStrictEqual(Object.keys(TRACKS), Array.from(RR.TRACKS, (t) => t.id)); // (the engine's arrays are from its own context)
  for (const t of RR.TRACKS) assert.strictEqual(TRACKS[t.id].laps, t.laps, t.id + ': laps');
});

/* ------------------------------------------------- every event's table, and histories */

const fight = (over) => Object.assign({
  track: 'dogfight', pid: 'pilot-aaaaaaaa', name: 'Ada', diff: 1, map: 'crucible',
  result: { place: 1, win: true, kills: 5, deaths: 1, left: 60 },
}, over);
const game = (base, body) => fetch(base + '/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('records: the points for each fight mode, and which results the rules allow', () => {
  // dogfight: 100 a kill, -25 a loss, 300 for 1st, 2 a second left on a win by kills; x1, x1.5, x2 by rivals
  assert.strictEqual(R.score('dogfight', { place: 1, win: true, kills: 5, deaths: 1, left: 60 }, 0), 500 - 25 + 300 + 120);
  assert.strictEqual(R.score('dogfight', { place: 1, win: true, kills: 5, deaths: 1, left: 60 }, 2), (500 - 25 + 300 + 120) * 2);
  assert.strictEqual(R.score('dogfight', { place: 4, win: false, kills: 0, deaths: 9, left: 0 }, 1), 0, 'never below 0');
  // battle royale: 100 a kill, 500 / 300 / 200 / 100 / 50 for 1st to 5th
  assert.strictEqual(R.score('royale', { place: 2, win: false, kills: 3, deaths: 1 }, 1), Math.floor((300 + 300) * 1.5));
  // capture the flag: 300 a capture, 100 a return, 50 a kill, 300 when the team wins
  assert.strictEqual(R.score('ctf', { place: 3, win: true, kills: 2, deaths: 4, caps: 1, returns: 2 }, 0), 300 + 200 + 100 + 300);
  assert.strictEqual(R.check('dogfight', { place: 1, win: true, kills: 5, deaths: 0, left: 10 }), null);
  const bad = [
    ['dogfight', { place: 1, win: true, kills: 6, deaths: 0, left: 0 }, 'Bad kills'], // the dogfight ends at 5
    ['dogfight', { place: 2, win: true, kills: 1, deaths: 0, left: 0 }, 'Win and place disagree'],
    ['dogfight', { place: 1, win: true, kills: 4, deaths: 0, left: 30 }, 'Time left without a win by kills'],
    ['royale', { place: 3, win: false, kills: 1, deaths: 2 }, 'Bad deaths'], // one life
    ['royale', { place: 1, win: true, kills: 6, deaths: 0 }, 'Bad kills'], // five rivals
    ['ctf', { place: 1, win: true, kills: 1, deaths: 0, caps: 4, returns: 0 }, 'Bad flags'], // 3 ends the match
    ['ctf', { place: 7, win: false, kills: 1, deaths: 0, caps: 0, returns: 0 }, 'Bad place'],
    ['ctf', null, 'Bad result'],
  ];
  for (const [m, r, err] of bad) assert.strictEqual(R.check(m, r), err, m + ' ' + JSON.stringify(r));
  assert.strictEqual(R.check('ctf', { place: 4, win: true, kills: 0, deaths: 3, caps: 0, returns: 1 }), null, 'in capture the flag the team wins, whatever your place');
  // histories: games, wins, 1st / 2nd / 3rd places, by event and in all
  const h = R.emptyHistory();
  R.addGame(h, 'race', 1, true); R.addGame(h, 'ctf', 3, true); R.addGame(h, 'royale', 5, false);
  assert.deepStrictEqual([h.race, h.ctf, h.royale, h.all], [
    { played: 1, wins: 1, p1: 1, p2: 0, p3: 0 }, { played: 1, wins: 1, p1: 0, p2: 0, p3: 1 },
    { played: 1, wins: 0, p1: 0, p2: 0, p3: 0 }, { played: 3, wins: 2, p1: 1, p2: 0, p3: 1 }]);
  // a saved history is only trusted as far as it can be true
  const cleaned = R.cleanHistory({ race: { played: 2, wins: 5, p1: 1, p2: 1, p3: 1 }, ctf: { played: -3, wins: 'x' } });
  assert.deepStrictEqual([cleaned.race, cleaned.ctf, cleaned.all.played], [{ played: 2, wins: 2, p1: 0, p2: 0, p3: 0 }, { played: 0, wins: 0, p1: 0, p2: 0, p3: 0 }, 2]);
  assert.strictEqual(R.checkGame('dogfight', 2, true), 'Win and place disagree');
  assert.strictEqual(R.checkGame('ctf', 2, true), null);
});

test('every fight mode has a high score table: the server works out the points, keeps each pilot\'s best, most first', async () => {
  const { server, base } = await start();
  try {
    let r = await (await post(base, fight({ setup: { ship: 'dart', stats: [5, 5, 5, 3, 3], items: { missile: 2 }, levels: { missile: 3 } } }))).json();
    assert.deepStrictEqual([r.rank, r.improved, r.best.score, r.best.place, r.best.map, r.best.setup.ship], [1, true, Math.floor(895 * 1.5), 1, 'crucible', 'dart']);
    // whatever score the caller claims, the server counts its own
    r = await (await post(base, fight({ pid: 'pilot-bbbbbbbb', name: 'Bob', diff: 2, score: 999999, result: { place: 1, win: true, kills: 5, deaths: 0, left: 100 } }))).json();
    assert.strictEqual(r.best.score, (500 + 300 + 200) * 2);
    assert.deepStrictEqual(r.scores.map((e) => [e.name, e.score]), [['BOB', 2000], ['ADA', 1342]], 'most first');
    // a worse fight does not replace a pilot's best
    r = await (await post(base, fight({ result: { place: 3, win: false, kills: 1, deaths: 4, left: 0 } }))).json();
    assert.deepStrictEqual([r.improved, r.best.score, r.rank], [false, 1342, 2]);
    // each mode has its own table, with your own row when you say who you are
    await post(base, fight({ track: 'ctf', map: 'triad', result: { place: 2, win: true, kills: 3, deaths: 1, caps: 1, returns: 2 }, setup: { ship: 'sparrow', stats: [3, 3, 3, 3, 3], items: { reflag: 1 } } }));
    await post(base, fight({ track: 'royale', map: 'crucible', result: { place: 2, win: false, kills: 2, deaths: 1 } }));
    const ctf = await board(base, 'ctf', 'pilot-aaaaaaaa');
    assert.deepStrictEqual([ctf.scores.length, ctf.scores[0].score, ctf.me.rank, ctf.me.result.caps, ctf.scores[0].setup.items], [1, Math.floor((300 + 200 + 150 + 300) * 1.5), 1, 1, { reflag: 1 }]);
    assert.strictEqual((await board(base, 'royale')).scores[0].score, Math.floor(500 * 1.5));
    assert.strictEqual((await board(base, 'dogfight')).scores.length, 2);
    // results the rules do not allow are turned away
    for (const [over, err] of [
      [{ result: { place: 1, win: true, kills: 9, deaths: 0, left: 0 } }, 'Bad kills'],
      [{ track: 'royale', result: { place: 1, win: true, kills: 2, deaths: 3 } }, 'Bad deaths'],
      [{ map: '../etc' }, 'Bad map'],
      [{ diff: 5 }, 'Bad difficulty'],
      [{ track: 'joust' }, 'Unknown track'],
    ]) {
      const res = await post(base, fight(over));
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await res.json()).error, err);
    }
    assert.strictEqual((await fetch(base + '/api/scores?track=joust')).status, 400);
  } finally { server.close(); }
});

test('pilot histories: each finished game counts towards games played, wins and podium places; the pilots with the most wins; your own rank', async () => {
  const { server, base } = await start();
  try {
    let r = await (await game(base, { pid: 'pilot-aaaaaaaa', name: 'Ada', mode: 'race', place: 1, win: true })).json();
    assert.deepStrictEqual([r.history.name, r.history.race, r.history.all.played], ['ADA', { played: 1, wins: 1, p1: 1, p2: 0, p3: 0 }, 1]);
    // games that come too close together cannot be real
    const soon = await game(base, { pid: 'pilot-aaaaaaaa', name: 'Ada', mode: 'race', place: 1, win: true });
    assert.strictEqual(soon.status, 429);
    await game(base, { pid: 'pilot-bbbbbbbb', name: 'Bob', mode: 'ctf', place: 2, win: true });
    await game(base, { pid: 'pilot-cccccccc', name: 'Cy', mode: 'royale', place: 4, win: false });
    // games that cannot happen are turned away
    for (const [body, err] of [
      [{ pid: 'pilot-dddddddd', mode: 'race', place: 2, win: true }, 'Win and place disagree'],
      [{ pid: 'pilot-dddddddd', mode: 'joust', place: 1, win: true }, 'Unknown event'],
      [{ pid: 'pilot-dddddddd', mode: 'race', place: 0, win: false }, 'Bad place'],
      [{ pid: 'short', mode: 'race', place: 1, win: true }, 'Bad pid'],
    ]) {
      const res = await game(base, body);
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await res.json()).error, err);
    }
    // the world table: most wins first, only pilots who have played; yours with your rank
    const all = await (await fetch(base + '/api/history?mode=all', { headers: { 'X-Pilot-Id': 'pilot-cccccccc' } })).json();
    assert.deepStrictEqual(all.pilots.map((p) => [p.name, p.played, p.wins]), [['ADA', 1, 1], ['BOB', 1, 1], ['CY', 1, 0]]);
    assert.deepStrictEqual([all.me.name, all.me.royale.played, all.me.rank], ['CY', 1, 3]);
    const ctf = await (await fetch(base + '/api/history?mode=ctf')).json();
    assert.deepStrictEqual([ctf.pilots.map((p) => p.name), ctf.pilots[0].p2, ctf.me], [['BOB'], 1, null]);
    assert.strictEqual((await fetch(base + '/api/history?mode=joust')).status, 400);
    // the multiplayer server, which saw the games, records them without the gap (and marks fights' points online)
    const store = memoryStore(), rec = onlineRecorders(store, () => {});
    await rec.postGame({ pid: 'pilot-online01', name: 'Zed', mode: 'dogfight', place: 1, win: true });
    await rec.postGame({ pid: 'pilot-online01', name: 'Zed', mode: 'dogfight', place: 2, win: false });
    const zed = await store.pilot('pilot-online01', 'all');
    assert.deepStrictEqual([zed.dogfight.played, zed.dogfight.wins, zed.dogfight.p2, zed.rank], [2, 1, 1, 1]);
    assert.strictEqual(await rec.postGame({ pid: 'pilot-online01', name: 'Zed', mode: 'dogfight', place: 3, win: true }), null, 'refused');
    await rec.postScore(fight({ pid: 'pilot-online01', name: 'Zed' }));
    const top = await store.top('dogfight', 10);
    assert.deepStrictEqual([top[0].name, top[0].online], ['ZED', true]);
  } finally { server.close(); }
});
