'use strict';

// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp, cleanName, validateScore } = require('../server');
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
const run = (over) => Object.assign({ track: 'lunar', pid: 'pilot-aaaaaaaa', name: 'Ada', time: 75.5, lap: 24.2, diff: 1 }, over);

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
    assert.strictEqual((await fetch(base + '/healthz')).status, 200);
    // conditional requests revalidate cheaply
    const again = await fetch(base + '/', { headers: { 'If-None-Match': home.headers.get('etag') } });
    assert.strictEqual(again.status, 304);
  } finally { server.close(); }
});

test('leaderboard keeps one best time per pilot, fastest first', async () => {
  const { server, base } = await start();
  try {
    assert.deepStrictEqual(await (await fetch(base + '/api/health')).json(), { ok: true, store: 'memory' });
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
    ];
    for (const b of bad) assert.strictEqual((await post(base, b)).status, 400, JSON.stringify(b));
    assert.strictEqual((await post(base, '{not json', true)).status, 400);
    assert.strictEqual((await post(base, JSON.stringify(run({ name: 'x'.repeat(5000) })), true)).status, 413);
    assert.strictEqual((await fetch(base + '/api/scores?track=nope')).status, 400);
    assert.strictEqual((await fetch(base + '/api/nothing')).status, 404);
    assert.deepStrictEqual((await (await fetch(base + '/api/scores?track=lunar')).json()).scores, []);
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
});
