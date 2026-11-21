'use strict';

/*
 * The multiplayer server (lib/mp.js, mp-server.js) with real WebSocket
 * clients: matchmaking, rooms, the race loop, snapshots, inputs,
 * disconnects and reconnects, limits, and the leaderboard post.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const P = require('../public/src/proto');
const { attachMultiplayer } = require('../lib/mp');
const { createMpServer } = require('../mp-server');
const { createApp } = require('../server');
const { memoryStore } = require('../lib/store');

async function serve(opts) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const hub = attachMultiplayer(server, Object.assign({ log: () => {} }, opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'ws://127.0.0.1:' + server.address().port + '/ws';
  return { server, hub, url, close: () => { hub.shutdown(); server.close(); } };
}

/** A test player: collects every message, and can wait for one that matches. */
function player(url, name, extra) {
  const ws = new WebSocket(url, extra);
  const c = { ws, msgs: [], snaps: [], waiters: [] };
  ws.on('message', (data, bin) => {
    const m = bin ? P.decodeSnap(data) : JSON.parse(String(data));
    if (bin) c.snaps.push(m); else c.msgs.push(m);
    for (const w of c.waiters.slice()) if (w.test(m, bin)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.done(m); }
  });
  c.closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  c.open = new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = (test, ms) => new Promise((resolve, reject) => {
    const found = c.msgs.find((m) => test(m, false));
    if (found) { c.msgs.splice(c.msgs.indexOf(found), 1); return resolve(found); }
    const t = setTimeout(() => reject(new Error('timed out waiting in ' + name + ': ' + test)), ms || 4000);
    c.waiters.push({ test: (m, bin) => !bin && test(m), done: (m) => { clearTimeout(t); c.msgs.splice(c.msgs.indexOf(m), 1); resolve(m); } });
  });
  c.hello = async (pid) => {
    await c.open;
    c.send({ t: 'hello', v: P.VERSION, pid: pid || ('pid-' + name).padEnd(10, 'x'), name });
    await c.wait((m) => m.t === 'welcome');
  };
  c.input = (i) => ws.send(P.encodeInput(Object.assign({ seq: 0, turn: 0, thrust: 0 }, i)));
  return c;
}

const setup = { hull: 'sparrow', stats: [3, 3, 3, 3, 3], levels: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRoom = (pred) => (m) => m.t === 'room' && (!pred || pred(m));

test('mp: quick match puts two players in one room; when both are ready the race starts, bots fill the grid', async () => {
  const s = await serve();
  const a = player(s.url, 'ALICE'), b = player(s.url, 'BOB');
  try {
    await a.hello(); await b.hello();
    a.send({ t: 'quick', mode: 'race', track: 1, diff: 2, setup: { hull: 'dart', stats: [9, 9, 9, 9, 9], levels: { missile: 3, nitro: 7 } } });
    const r1 = await a.wait(isRoom());
    assert.deepStrictEqual([r1.you, r1.room.state, r1.room.priv, r1.room.track, r1.room.diff], [0, 'lobby', false, 1, 2]);
    b.send({ t: 'quick', mode: 'race', track: 0, diff: 0, setup });
    const r2 = await b.wait(isRoom());
    assert.strictEqual(r2.you, 1, 'the same room, second seat');
    assert.deepStrictEqual(r2.room.humans.map((h) => h.name), ['ALICE', 'BOB']);
    assert.strictEqual(r2.room.track, 1, "the room keeps its creator's course");

    a.send({ t: 'ready', on: true });
    await a.wait(isRoom((m) => m.room.humans[0].ready));
    assert.strictEqual(s.hub.stats().rooms, 1);
    b.send({ t: 'ready', on: true });
    const sa = await a.wait((m) => m.t === 'start'), sb = await b.wait((m) => m.t === 'start');
    assert.deepStrictEqual([sa.you, sb.you], [0, 1]);
    assert.strictEqual(sa.opts.seats.length, 6);
    assert.deepStrictEqual(sa.opts.seats.map((x) => x.human), [true, true, false, false, false, false], 'bots fill the empty seats');
    const alice = sa.opts.seats[0];
    assert.deepStrictEqual([alice.hull, alice.stats, alice.levels], ['dart', [8, 9, 8, 5, 6], { missile: 3 }], 'stats cut to the hull ceiling, bad levels dropped');

    // snapshots, about 20 a second, carrying the whole grid
    a.snaps.length = 0;
    await sleep(1000);
    assert.ok(a.snaps.length >= 15 && a.snaps.length <= 25, 'about 20 snapshots a second: ' + a.snaps.length);
    const last = a.snaps[a.snaps.length - 1];
    assert.deepStrictEqual([last.ships.length, last.phase], [6, 'countdown']);
    assert.ok(last.ships[0].human && last.ships[2].bot);
  } finally { a.ws.close(); b.ws.close(); s.close(); }
});

test('mp: inputs fly the right ship and are acknowledged; a gate deferral is taken on request', async () => {
  const s = await serve();
  const a = player(s.url, 'ALICE'), b = player(s.url, 'BOB');
  try {
    await a.hello(); await b.hello();
    a.send({ t: 'quick', mode: 'race', track: 0, diff: 1, setup: Object.assign({}, setup, { levels: { defer: 2 } }) });
    await a.wait(isRoom());
    b.send({ t: 'quick', mode: 'race', track: 0, diff: 1, setup });
    await b.wait(isRoom());
    a.send({ t: 'ready', on: true }); b.send({ t: 'ready', on: true });
    await a.wait((m) => m.t === 'start');
    await sleep(4200); // the countdown
    const room = [...s.hub.rooms][0], G = room.engine.G;
    assert.strictEqual(G.phase, 'race');
    const from = [0, 1].map((i) => ({ x: G.ships[i].x, y: G.ships[i].y }));
    let seq = 0;
    const burn = [0, 0]; // the most engine each ship showed (rivals bumping Bob can move him, but not light his engine)
    const flying = setInterval(() => {
      a.input({ seq: ++seq, thrust: 1 });
      for (const i of [0, 1]) burn[i] = Math.max(burn[i], G.ships[i].thrusting);
    }, 16);
    await sleep(1500);
    clearInterval(flying);
    const moved = Math.hypot(G.ships[0].x - from[0].x, G.ships[0].y - from[0].y);
    assert.ok(moved > 150, 'Alice flies: ' + moved);
    assert.ok(burn[0] > 0.9, 'on full throttle: ' + burn[0]);
    assert.strictEqual(burn[1], 0, 'Bob, who sent nothing, never fires his engine');
    await sleep(120);
    assert.strictEqual(a.snaps[a.snaps.length - 1].ack, seq, 'snapshots acknowledge the last input used');

    const me = G.ships[0];
    me.lap = Math.max(me.lap, 1);
    if (G.track.cps[me.nextCp].finish) { me.nextCp = 1; me.cpCount = Math.max(me.cpCount, 1); } // heading for a gate, not the line
    const gate = me.nextCp, count = me.cpCount;
    me.defer = 1;
    a.input({ seq: ++seq, defer: true });
    await sleep(100);
    assert.deepStrictEqual([me.defer, me.cpCount, me.nextCp], [0, count + 1, (gate + 1) % G.track.cps.length], 'the gate counts as passed');
    const ev = await a.wait((m) => m.t === 'ev' && m.e.some((e) => e[0] === 'd' && e[1] === 0 && e[2] === gate));
    assert.ok(ev.ms > 0);
    await sleep(120);
    const last = a.snaps[a.snaps.length - 1].ships[0];
    assert.ok(last.defer === 0 && last.cpCount >= count + 1, 'and the snapshots say so: ' + JSON.stringify([last.defer, last.cpCount]));
  } finally { a.ws.close(); b.ws.close(); s.close(); }
});

test('mp: private rooms by code; a dropped player is flown by a bot and gets the ship back on reconnecting', async () => {
  const s = await serve();
  const a = player(s.url, 'ALICE'), b = player(s.url, 'BOB'), c = player(s.url, 'CAROL');
  try {
    await a.hello(); await b.hello(); await c.hello();
    a.send({ t: 'create', mode: 'dogfight', track: 1, diff: 1, setup });
    const ra = await a.wait(isRoom());
    assert.ok(ra.room.priv && /^[A-Z]{4}$/.test(ra.room.code), 'a four-letter code: ' + ra.room.code);
    c.send({ t: 'quick', mode: 'dogfight', track: 1, diff: 1, setup });
    const rc = await c.wait(isRoom());
    assert.strictEqual(rc.room.code, null, 'quick match never lands in a private room');
    b.send({ t: 'join', code: 'ZZZZ', setup });
    assert.strictEqual((await b.wait((m) => m.t === 'error')).code, 'no such room');
    b.send({ t: 'join', code: ra.room.code.toLowerCase(), setup });
    const rb = await b.wait(isRoom());
    assert.deepStrictEqual([rb.you, rb.room.code, rb.room.mode], [1, ra.room.code, 'dogfight']);

    a.send({ t: 'ready', on: true }); b.send({ t: 'ready', on: true });
    await b.wait((m) => m.t === 'start');
    await sleep(300);
    const room = [...s.hub.rooms].find((r) => r.priv), G = room.engine.G;
    assert.ok(!G.ships[1].ai, 'Bob flies his own ship');
    b.ws.close();
    await sleep(200);
    assert.ok(G.ships[1].ai, 'a bot takes over at once');
    const bob2 = player(s.url, 'BOB');
    await bob2.hello();
    bob2.send({ t: 'resume', token: rb.token });
    const back = await bob2.wait((m) => m.t === 'start');
    assert.strictEqual(back.you, 1);
    assert.ok(!G.ships[1].ai && G.ships[1].netInput, 'and hands it back');
    bob2.send({ t: 'resume', token: 'nope' });
    assert.strictEqual((await bob2.wait((m) => m.t === 'error')).code, 'expired');
    bob2.ws.close();
  } finally { a.ws.close(); c.ws.close(); s.close(); }
});

test('mp: a race runs to the results; only finishes the player flew themselves go to the leaderboard, marked online', async () => {
  const posted = [];
  const s = await serve({ speed: 40, resultsMs: 400, post: (body) => posted.push(body) });
  const a = player(s.url, 'ALICE'), b = player(s.url, 'BOB');
  try {
    await a.hello('alice-pid-1'); await b.hello('bob-pid-22');
    a.send({ t: 'create', mode: 'race', track: 0, diff: 2, setup: Object.assign({}, setup, { levels: { missile: 3 } }) });
    const ra = await a.wait(isRoom());
    b.send({ t: 'join', code: ra.room.code, setup });
    await b.wait(isRoom());
    a.send({ t: 'ready', on: true }); b.send({ t: 'ready', on: true });
    await a.wait((m) => m.t === 'start');
    const room = [...s.hub.rooms][0], G = room.engine.G;
    // Alice gets the autopilot's brain on her controls; Bob drops out and a bot finishes for him
    while (G.phase !== 'race') await sleep(20);
    G.ships[0].ai = G.ships[2].ai;
    b.ws.close();
    const res = await a.wait((m) => m.t === 'results', 20000);
    assert.strictEqual(res.list.length, 6);
    const me = res.list.find((r) => r.you);
    assert.strictEqual(me.name, 'ALICE');
    assert.ok(res.list.every((r, i) => r.place === i + 1), 'in finishing order');
    assert.strictEqual(posted.length, 1, 'one time posted: ' + JSON.stringify(posted.map((p) => p.name)));
    const p = posted[0];
    assert.deepStrictEqual([p.track, p.pid, p.name, p.diff, p.place, p.setup.ship, p.setup.levels], ['lunar', 'alice-pid-1', 'ALICE', 2, me.place, 'sparrow', { missile: 3 }]);
    assert.ok(Math.abs(p.time - me.time) < 0.01 && p.lap > 0);
    // after the results, back to the lobby, ready flags cleared
    const lobby = await a.wait(isRoom((m) => m.room.state === 'lobby'), 3000);
    assert.ok(lobby.room.humans.every((h) => !h.ready));
  } finally { a.ws.close(); s.close(); }
});

test('mp: the server refuses an old game, junk, floods and oversized messages', async () => {
  const s = await serve();
  try {
    const old = player(s.url, 'OLD');
    await old.open;
    old.send({ t: 'hello', v: P.VERSION + 1, name: 'OLD' });
    assert.strictEqual((await old.wait((m) => m.t === 'error')).code, 'version');
    assert.strictEqual((await old.closed).code, 1008);

    const early = player(s.url, 'EARLY');
    await early.open;
    early.send({ t: 'quick', setup });
    assert.strictEqual((await early.wait((m) => m.t === 'error')).code, 'hello first');

    const junk = player(s.url, 'JUNK');
    await junk.hello();
    junk.ws.send('not json');
    junk.ws.send(Buffer.from([9, 9, 9]));
    junk.input({ seq: 1, thrust: 1 }); // not in a room: ignored
    junk.send({ t: 'ping', c: 5 });
    const pong = await junk.wait((m) => m.t === 'pong');
    assert.ok(pong.c === 5 && pong.s >= 0, 'still connected after junk');

    const big = player(s.url, 'BIG');
    await big.hello();
    big.ws.send('x'.repeat(10000));
    assert.strictEqual((await big.closed).code, 1009, 'too big: closed');

    const flood = player(s.url, 'FLOOD');
    await flood.hello();
    for (let i = 0; i < 400; i++) flood.send({ t: 'ping', c: i });
    assert.strictEqual((await flood.closed).code, 1008, 'a flood is cut off');
    for (const c of [junk]) c.ws.close();
  } finally { s.close(); }
});

test('mp: the standalone service answers health checks; the game finds online play through /api/config', async () => {
  const server = createMpServer(memoryStore(), { APP_ENV: 'staging', COMMIT_SHA: 'abc123', MP_ORIGINS: 'https://good.example' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const h = await (await fetch(base + '/api/health')).json();
    assert.deepStrictEqual([h.ok, h.mp, h.env, h.version, h.rooms, h.players], [true, true, 'staging', 'abc123', 0, 0]);
    // pages from elsewhere are turned away
    const bad = new WebSocket(base.replace('http', 'ws') + '/ws', { origin: 'https://evil.example' });
    const err = await new Promise((r) => bad.on('error', r));
    assert.match(String(err.message), /403/);
    const good = player(base.replace('http', 'ws') + '/ws', 'GOOD', { origin: 'https://good.example' });
    await good.hello();
    good.ws.close();
  } finally { server.hub.shutdown(); server.close(); }

  // the game's own service says where online play is
  const keep = { MP: process.env.MP, MP_URL: process.env.MP_URL };
  const app = http.createServer(createApp(memoryStore()));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const web = 'http://127.0.0.1:' + app.address().port;
  try {
    delete process.env.MP; delete process.env.MP_URL;
    assert.deepStrictEqual(await (await fetch(web + '/api/config')).json(), { mp: null });
    process.env.MP = 'embedded';
    assert.deepStrictEqual(await (await fetch(web + '/api/config')).json(), { mp: '/ws' });
    process.env.MP_URL = 'wss://mp.example/ws';
    assert.deepStrictEqual(await (await fetch(web + '/api/config')).json(), { mp: 'wss://mp.example/ws' });
  } finally {
    for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
    app.close();
  }
});
