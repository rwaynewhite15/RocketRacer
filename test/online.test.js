'use strict';

/*
 * Online play end to end: real browsers (headless Chromium) playing the
 * real game against the multiplayer server, in one room.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp } = require('../server');
const { memoryStore } = require('../lib/store');
const { attachMultiplayer } = require('../lib/mp');
const { createMpServer } = require('../mp-server');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* skipped below */ }
if (!chromium && process.env.CI) throw new Error('Playwright is required in CI: npm install --no-save playwright');
const skip = chromium ? false : 'Playwright is not installed';

let browser, keepMp;
before(async () => {
  if (skip) return;
  keepMp = process.env.MP;
  process.env.MP = 'embedded'; // /api/config: online play is on this server's /ws
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (keepMp === undefined) delete process.env.MP; else process.env.MP = keepMp;
});

/** The game's server with online play on /ws. */
async function serve(opts) {
  const posted = [];
  const server = http.createServer(createApp(memoryStore()));
  const hub = attachMultiplayer(server, Object.assign({ log: () => {}, post: (b) => posted.push(b) }, opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { hub, posted, url: 'http://127.0.0.1:' + server.address().port + '/', close: () => { hub.shutdown(); server.close(); } };
}

async function player(url, name) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 560 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.RR && RR.game && RR.game.state === 'title' && RR.net.mp);
  await page.evaluate((n) => { RR.game.name = n; RR.game.autoFull = false; }, name);
  const tap = async (label) => {
    const u = await page.evaluate((l) => RR.game.ui.find((b) => b.label === l) || null, label);
    assert.ok(u, name + ' sees a button "' + label + '"');
    const box = await page.locator('#hud').boundingBox(), k = box.width / await page.evaluate(() => RR.game.W);
    await page.mouse.click(box.x + (u.x + u.w / 2) * k, box.y + (u.y + u.h / 2) * k);
    await page.waitForTimeout(80);
  };
  return { ctx, page, errors, tap, name };
}

/** Alice opens a room from the title screen; Bob joins it with the code; both get READY: the race starts. */
async function intoRace(A, B) {
  await A.tap('ONLINE (O)');
  await A.page.waitForFunction(() => RR.game.state === 'online' && RR.mp.status === 'online');
  await A.tap('CREATE ROOM');
  await A.page.waitForFunction(() => RR.mp.room && RR.mp.room.code);
  const code = await A.page.evaluate(() => RR.mp.room.code);
  await B.page.keyboard.press('KeyO');
  await B.page.waitForFunction(() => RR.mp.status === 'online');
  await B.tap('JOIN ROOM');
  await B.page.fill('#roomcode', code.toLowerCase());
  await B.page.press('#roomcode', 'Enter');
  await A.page.waitForFunction(() => RR.mp.room.humans.length === 2);
  await A.page.waitForTimeout(100);
  const lobby = await A.page.evaluate(() => RR.game.onlineShown);
  await A.tap('READY (ENTER)');
  await B.page.keyboard.press('Enter'); // READY by keyboard
  for (const P of [A, B]) await P.page.waitForFunction(() => RR.game.state === 'play' && RR.game.online, null, { timeout: 5000 });
  return { code, lobby };
}

test('online: two players find each other through a room code, race, and each sees the other', { skip }, async () => {
  const s = await serve();
  const A = await player(s.url, 'ALICE'), B = await player(s.url, 'BOB');
  try {
    const { code, lobby } = await intoRace(A, B);
    assert.match(code, /^[A-Z]{4}$/);
    assert.deepStrictEqual(lobby, [['ALICE', '...'], ['BOB', '...']], 'the room lists both pilots, not ready yet');
    const who = await A.page.evaluate(() => ({ me: RR.mp.me, names: RR.game.ships.map((s) => s.name), remote: RR.game.ships.map((s) => !!s.remote) }));
    assert.deepStrictEqual([who.me, who.names.slice(0, 2), who.remote.slice(0, 2)], [0, ['ALICE', 'BOB'], [false, true]]);

    await A.page.waitForFunction(() => RR.game.phase === 'race', null, { timeout: 6000 });
    // Alice's controls answer at once, before any snapshot could come back
    const now = await A.page.evaluate(async () => {
      const me = RR.game.player, x0 = me.x;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { thr: me.thrusting, moved: me.x !== x0 };
    });
    assert.ok(now.thr > 0.9, 'the engine lights on the next frame: ' + now.thr);
    await A.page.waitForTimeout(2500);
    const a = await A.page.evaluate(() => ({ x: RR.game.player.x, y: RR.game.player.y, v: Math.hypot(RR.game.player.vx, RR.game.player.vy) }));
    const aliceOnB = await B.page.evaluate(() => ({ x: RR.game.ships[0].x, y: RR.game.ships[0].y }));
    const room = [...s.hub.rooms][0], srv = room.engine.G.ships[0];
    assert.ok(a.v > 200, 'Alice is flying: ' + a.v);
    const gap = Math.hypot(a.x - srv.x, a.y - srv.y);
    assert.ok(gap < 40, 'her own screen agrees with the server: ' + gap.toFixed(1) + ' px');
    const seen = Math.hypot(aliceOnB.x - srv.x, aliceOnB.y - srv.y);
    assert.ok(seen < a.v * 0.2 + 25, 'Bob sees her where she was a moment ago: ' + seen.toFixed(1) + ' px behind');
    assert.ok(seen > 5, 'drawn in the past, smoothly (not jumping to the newest snapshot)');
    assert.deepStrictEqual([A.errors, B.errors], [[], []]);
  } finally { await A.ctx.close(); await B.ctx.close(); s.close(); }
});

test('online: on a slow network (150 ms each way) the player\'s own ship still answers at once and the others move smoothly', { skip }, async () => {
  const s = await serve({ lag: 150 });
  const A = await player(s.url, 'ALICE'), B = await player(s.url, 'BOB');
  try {
    await intoRace(A, B);
    await A.page.waitForFunction(() => RR.game.phase === 'race', null, { timeout: 8000 });
    await B.page.keyboard.down('ArrowUp');
    await B.page.waitForTimeout(1500);
    // Bob's own ship: the engine is lit at once though the server is 300 ms away
    const lit = await A.page.evaluate(async () => {
      const me = RR.game.player;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return me.thrusting;
    });
    assert.ok(lit > 0.9, 'answers on the next frame: ' + lit);
    // Bob as Alice sees him: frame by frame, no jumps
    const path = await A.page.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        out.push([RR.game.ships[1].x, RR.game.ships[1].y, performance.now()]);
      }
      return out;
    });
    let worst = 0;
    for (let i = 1; i < path.length; i++) {
      const dt = Math.max(1, path[i][2] - path[i - 1][2]);
      worst = Math.max(worst, Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]) / dt * 1000);
    }
    const v = await B.page.evaluate(() => Math.hypot(RR.game.player.vx, RR.game.player.vy));
    assert.ok(v > 150, 'Bob is flying: ' + v);
    assert.ok(worst < v * 2.5 + 60, 'no jumps: fastest frame-to-frame move ' + worst.toFixed(0) + ' px/s at ' + v.toFixed(0) + ' px/s');
    const rtt = await A.page.evaluate(() => RR.mp.rtt);
    assert.ok(rtt >= 280, 'the round trip is measured: ' + rtt + ' ms');
    assert.deepStrictEqual([A.errors, B.errors], [[], []]);
  } finally { await A.ctx.close(); await B.ctx.close(); s.close(); }
});

test('online: a dropped connection comes back to the same ship; the results are shown and paid; then the next race', { skip }, async () => {
  const s = await serve({ resultsMs: 1500 });
  const A = await player(s.url, 'ALICE'), B = await player(s.url, 'BOB');
  try {
    await intoRace(A, B);
    await A.page.waitForFunction(() => RR.game.phase === 'race', null, { timeout: 6000 });
    const room = [...s.hub.rooms][0], G = room.engine.G;

    // Bob's connection drops: a bot flies his ship, and he is back on it when he reconnects
    await B.page.evaluate(() => RR.mp._drop());
    await B.page.waitForTimeout(150);
    assert.ok(G.ships[1].ai, 'a bot holds Bob\'s ship');
    await B.page.waitForFunction(() => RR.mp.status === 'online' && RR.game.state === 'play', null, { timeout: 5000 });
    await B.page.waitForTimeout(300);
    assert.ok(!G.ships[1].ai, 'Bob has it back');
    assert.strictEqual(await B.page.evaluate(() => RR.mp.me), 1);

    // both cross the line on their last lap: the race ends, results come
    for (const i of [0, 1]) {
      const s = G.ships[i];
      s.lap = G.laps; s.nextCp = 0; s.cpCount = G.track.cps.length * G.laps; s.x = G.track.cps[0].x; s.y = G.track.cps[0].y + i * 4;
    }
    for (const P of [A, B]) await P.page.waitForFunction(() => RR.game.state === 'mpresults', null, { timeout: 8000 });
    const r = await A.page.evaluate(() => ({ list: RR.mp.results, reward: RR.mp.reward, credits: RR.game.prog.credits }));
    assert.strictEqual(r.list.length, 6);
    const mine = r.list.find((x) => x.you);
    assert.strictEqual(mine.name, 'ALICE');
    assert.ok(mine.time > 0 && mine.place >= 1);
    assert.ok(r.reward && r.reward.credits > 0 && r.credits === r.reward.credits, 'credits paid for an online race');
    assert.strictEqual(s.posted.length, 1, "Alice's own finish is posted; Bob's ship was flown by a bot for a while");
    assert.strictEqual(s.posted[0].name, 'ALICE');

    // back to the room for the next race
    await A.tap('NEXT RACE (ENTER)');
    await A.page.waitForFunction(() => RR.game.state === 'online' && RR.mp.room && RR.mp.room.state === 'lobby', null, { timeout: 5000 });
    // and leaving goes back to the title screen; the room keeps Bob
    await A.tap('BACK (ESC)');
    await A.page.waitForFunction(() => RR.game.state === 'title');
    await B.page.waitForFunction(() => RR.mp.room && RR.mp.room.humans.length === 1, null, { timeout: 5000 });
    assert.deepStrictEqual([A.errors, B.errors], [[], []]);
  } finally { await A.ctx.close(); await B.ctx.close(); s.close(); }
});

test('online: a fight online - the kill feed and the menu (the fight goes on behind it)', { skip }, async () => {
  const s = await serve();
  const A = await player(s.url, 'ALICE'), B = await player(s.url, 'BOB');
  try {
    await A.page.evaluate(() => { RR.game.modeIdx = 1; }); // DOGFIGHT on the menu
    await intoRace(A, B);
    assert.strictEqual(await B.page.evaluate(() => RR.game.mode), 'dogfight', 'the room races what its creator picked');
    await A.page.waitForFunction(() => RR.game.phase === 'race', null, { timeout: 6000 });
    const room = [...s.hub.rooms][0], G = room.engine.G;
    // Alice's cannon finishes Bob: everyone's feed says so, and Alice gets the banner
    G.ships[1].hp = 1; G.ships[1].shield = 0; G.ships[1].invuln = 0;
    G.ships[1].hitBy = G.ships[0]; G.ships[1].hitT = G.t;
    G.ships[1].x = G.track.planets[0].x; G.ships[1].y = G.track.planets[0].y - G.track.planets[0].r - 9; G.ships[1].vy = 600;
    await B.page.waitForFunction(() => RR.game.feed.some((f) => f.a === 'ALICE' && f.b === 'BOB'), null, { timeout: 4000 });
    await A.page.waitForFunction(() => RR.game.player.kills === 1, null, { timeout: 4000 });
    // the menu: no pause online
    await A.page.keyboard.press('KeyP');
    const t0 = await A.page.evaluate(() => RR.game.raceTime);
    await A.page.waitForTimeout(600);
    const m = await A.page.evaluate(() => ({ menu: RR.game.mpMenu, state: RR.game.state, t: RR.game.raceTime }));
    assert.deepStrictEqual([m.menu, m.state], [true, 'play']);
    assert.ok(m.t > t0 + 0.4, 'the fight went on');
    await A.tap('LEAVE THE ROOM (Q)');
    await A.page.waitForFunction(() => RR.game.state === 'title');
    assert.deepStrictEqual([A.errors, B.errors], [[], []]);
  } finally { await A.ctx.close(); await B.ctx.close(); s.close(); }
});

test('online: with online play as its own service at another address (as on Cloud Run), the game connects and races', { skip }, async () => {
  // the online-play service on one port, the game's on another, told where it is by MP_URL
  const mp = createMpServer(memoryStore(), {});
  await new Promise((r) => mp.listen(0, '127.0.0.1', r));
  const keep = process.env.MP_URL;
  process.env.MP_URL = 'ws://127.0.0.1:' + mp.address().port + '/ws';
  const web = http.createServer(createApp(memoryStore()));
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + web.address().port + '/';
  const A = await player(url, 'ALICE'), B = await player(url, 'BOB');
  try {
    const csp = (await fetch(url)).headers.get('content-security-policy');
    assert.match(csp, new RegExp("connect-src 'self' ws://127\\.0\\.0\\.1:" + mp.address().port + ';'), 'the page may connect to it: ' + csp);
    await intoRace(A, B);
    await A.page.waitForFunction(() => RR.game.phase === 'race', null, { timeout: 6000 });
    assert.strictEqual(mp.hub.stats().players, 2, 'both are on the online-play service');
    assert.deepStrictEqual([A.errors, B.errors], [[], []]);
  } finally {
    await A.ctx.close(); await B.ctx.close();
    if (keep === undefined) delete process.env.MP_URL; else process.env.MP_URL = keep;
    web.close(); mp.hub.shutdown(); mp.close();
  }
});

test('online: a hit flashes a ship white only for a moment; human pilots are named at the start and for 2 s as they come into view (bots never); a gate deferral goes through the server', { skip }, async () => {
  const s = await serve();
  const A = await player(s.url, 'ALICE'), B = await player(s.url, 'BOB');
  try {
    await intoRace(A, B);
    const G = [...s.hub.rooms][0].engine.G, alice = G.ships[0], bob = G.ships[1], bot = G.ships[2];
    const tags = () => A.page.evaluate(() => (RR.game.tagsShown || []).slice().sort());
    const place = (sh, x, y) => { sh.x = x; sh.y = y; sh.vx = sh.vy = 0; sh.angVel = 0; };
    const inView = (i, on) => A.page.waitForFunction(([i, on]) => !!RR.game.ships[i].inView === on, [i, on], { timeout: 4000 });

    // the start: every human pilot's name (and no bot's), through the countdown and the first 2 s
    await A.page.waitForTimeout(300);
    assert.deepStrictEqual(await tags(), ['ALICE', 'BOB'], 'both pilots named on the grid');
    await A.page.waitForFunction(() => RR.game.phase === 'race' && RR.game.raceTime > RR.TAG_HOLD + 0.6, null, { timeout: 8000 });
    assert.deepStrictEqual(await tags(), [], 'then the names go');

    // Bob leaves Alice's screen and comes back into it: his name, for 2 s
    place(bob, G.track.cps[4].x, G.track.cps[4].y); // the far side of the course
    await inView(1, false);
    place(bob, alice.x + 40, alice.y - 40);
    await inView(1, true);
    assert.deepStrictEqual(await tags(), ['BOB'], 'Bob is named as he comes into view');
    await A.page.waitForTimeout(1500);
    assert.deepStrictEqual(await tags(), ['BOB'], 'and still is 1.5 s later');
    await A.page.waitForTimeout(900);
    assert.deepStrictEqual(await tags(), [], 'gone after 2 s');

    // a bot doing the same is never named
    place(bot, G.track.cps[4].x, G.track.cps[4].y); bot.ai = null;
    await inView(2, false);
    place(bot, alice.x - 40, alice.y + 40);
    await inView(2, true);
    assert.deepStrictEqual(await tags(), [], 'no name for a bot');

    // a hit (a shot, a bump, a rock) flashes Bob white on Alice's screen, for a moment only
    bob.hitFlash = 0.12;
    const flash = await A.page.evaluate(async () => {
      const s = RR.game.ships[1];
      let most = 0;
      for (let i = 0; i < 25; i++) { most = Math.max(most, s.hitFlash); await new Promise((r) => setTimeout(r, 20)); }
      await new Promise((r) => setTimeout(r, 500));
      return { most, after: s.hitFlash };
    });
    assert.ok(flash.most > 0, 'the flash shows');
    assert.ok(flash.after <= 0, 'and ends (it used to stay white for good): ' + flash.after);

    // a gate deferral: Alice presses E, the server takes it, and her screen and Bob's show it (her autopilot flies a
    // Grand Prix, so she is parked well away from the gates, braking, while it happens)
    const far = G.track.cps[6];
    alice.x = far.x; alice.y = far.y; alice.vx = alice.vy = 0;
    await A.page.keyboard.down('ArrowDown');
    alice.lap = 1; alice.nextCp = 1; alice.cpCount = 1; alice.defer = 1;
    await A.page.waitForFunction(() => RR.game.player.defer === 1 && RR.game.player.nextCp === 1);
    await A.page.keyboard.press('KeyE');
    await A.page.waitForFunction(() => RR.game.player.nextCp === 2 && RR.game.player.defer === 0 && RR.game.msg && RR.game.msg.text === 'GATE DEFERRED!', null, { timeout: 3000 });
    assert.deepStrictEqual([alice.nextCp, alice.cpCount, alice.defer, alice.used.defer], [2, 2, 0, 1], 'on the server');
    await B.page.waitForFunction(() => RR.game.texts.some((t) => t.text === 'DEFERRED'), null, { timeout: 3000 });
    await A.page.keyboard.up('ArrowDown');
    assert.deepStrictEqual([A.errors, B.errors], [[], []]);
  } finally { await A.ctx.close(); await B.ctx.close(); s.close(); }
});

test('online: capture the flag - two players on opposite teams; a flag taken on the server shows on both screens; Replace Flag (E) goes through the server', { skip }, async () => {
  const s = await serve();
  const A = await player(s.url, 'ALICE'), B = await player(s.url, 'BOB');
  try {
    await A.page.evaluate(() => { const g = RR.game; g.modeIdx = RR.MODES.findIndex((m) => m.id === 'ctf'); g.startRace(true); });
    await intoRace(A, B);
    const G = [...s.hub.rooms][0].engine.G;
    assert.strictEqual(G.ctf, true, 'the room plays capture the flag');
    const look = (P) => P.page.evaluate(() => {
      const g = RR.game;
      return { ctf: g.ctf, me: RR.mp.me, side: g.player.side, flags: g.flags.map((f) => f.state), carrier: g.flags[0].carrier ? g.flags[0].carrier.idx : -1, feed: g.feed.map((f) => f.text) };
    });
    let a = await look(A), b = await look(B);
    assert.deepStrictEqual([a.ctf, a.me, a.side, b.me, b.side], [true, 0, 0, 1, 1], 'Alice red, Bob blue');
    assert.deepStrictEqual(a.flags, ['home', 'home']);
    await A.page.waitForFunction(() => RR.game.phase === 'race', null, { timeout: 8000 });

    // Bob's ship takes red's flag (moved there on the server)
    for (const sh of G.ships) if (sh.ai) sh.ai = null;
    const bob = G.ships[1], red = G.flags[0];
    bob.x = red.home.x; bob.y = red.home.y; bob.vx = bob.vy = 0;
    await A.page.waitForFunction(() => RR.game.flags[0].state === 'carried', null, { timeout: 3000 });
    a = await look(A);
    assert.strictEqual(a.carrier, 1, 'on Alice\'s screen, Bob has her flag');
    await A.page.waitForFunction(() => RR.game.feed.some((f) => f.text === 'BLUE TEAM TOOK THE RED FLAG'), null, { timeout: 3000 });
    await B.page.waitForFunction(() => RR.game.player.flag && RR.game.msg && RR.game.msg.text === 'GOT THE RED FLAG!', null, { timeout: 3000 });
    bob.x = 4000; bob.y = 600; // off into the middle

    // Alice holds a Replace Flag (given on the server); E sends her flag home
    G.ships[0].reflag = 1;
    await A.page.waitForFunction(() => RR.game.player.reflag === 1, null, { timeout: 3000 });
    // both screens say which team holds it (not who)
    await B.page.waitForFunction(() => RR.game.reflagShown === 'REPLACE FLAG: RED TEAM', null, { timeout: 3000 });
    await A.page.keyboard.press('KeyE');
    await A.page.waitForFunction(() => RR.game.flags[0].state === 'home' && RR.game.msg && RR.game.msg.text === 'RED FLAG REPLACED!', null, { timeout: 3000 });
    assert.deepStrictEqual([red.state, bob.flag, G.ships[0].reflag], ['home', null, 0], 'on the server');
    await B.page.waitForFunction(() => !RR.game.player.flag && RR.game.flags[0].state === 'home', null, { timeout: 3000 });
    await B.page.waitForFunction(() => RR.game.reflagShown === null, null, { timeout: 3000 }); // (used up: nobody holds it)
    assert.deepStrictEqual([A.errors, B.errors], [[], []]);
  } finally { await A.ctx.close(); await B.ctx.close(); s.close(); }
});

test('online: humans only - the switch on the ONLINE screen (RIGHT, or a tap) is remembered, and two players race the Indy-Galactic 500 with no bots (and, switched on, its weapons)', { skip }, async () => {
  const s = await serve();
  const A = await player(s.url, 'ALICE'), B = await player(s.url, 'BOB');
  try {
    // Alice picks the course on the menu with its weapons on, opens ONLINE and switches the empty seats to humans only with RIGHT
    await A.page.evaluate(() => { const g = RR.game; g.modeIdx = 0; g.trackIdx = RR.TRACKS.findIndex((t) => t.id === 'indy'); g.toggleWeapons(); });
    await A.page.keyboard.press('KeyO');
    await A.page.waitForFunction(() => RR.game.state === 'online' && RR.mp.status === 'online');
    await A.tap('< PILOT BOTS IN EMPTY SEATS >'); // (a tap switches it...)
    await A.tap('< HUMANS ONLY - NO BOTS >'); // (...and back)
    await A.page.keyboard.press('ArrowRight');
    await A.page.waitForTimeout(80);
    assert.strictEqual(await A.page.evaluate(() => RR.game.humansOnly), true);
    assert.strictEqual(await A.page.evaluate(() => JSON.parse(localStorage.getItem('rocketracer.v1')).humansOnly), true, 'remembered');
    await A.page.keyboard.press('Enter'); // QUICK MATCH
    await A.page.waitForFunction(() => RR.mp.room);
    assert.deepStrictEqual(await A.page.evaluate(() => [RR.mp.room.bots, RR.mp.room.priv, RR.mp.room.weapons]), [false, false, true]);
    await A.page.keyboard.press('Enter'); // READY: alone, nothing starts
    await A.page.waitForTimeout(400);
    assert.deepStrictEqual(await A.page.evaluate(() => [RR.game.state, RR.mp.room.state, RR.mp.isReady()]), ['online', 'lobby', true]);

    // Bob, by touch: ONLINE, the switch, QUICK MATCH, READY
    await B.tap('ONLINE (O)');
    await B.page.waitForFunction(() => RR.mp.status === 'online');
    await B.tap('< PILOT BOTS IN EMPTY SEATS >');
    await B.tap('QUICK MATCH (ENTER)');
    await B.page.waitForFunction(() => RR.mp.room);
    assert.deepStrictEqual(await B.page.evaluate(() => [RR.mp.room.bots, RR.mp.room.humans.map((h) => h.name)]), [false, ['ALICE', 'BOB']], 'into Alice\'s room');
    await B.tap('READY (ENTER)');
    for (const P of [A, B]) await P.page.waitForFunction(() => RR.game.state === 'play' && RR.game.online, null, { timeout: 5000 });
    const look = (P) => P.page.evaluate(() => ({ course: RR.game.track.def.id, ships: RR.game.ships.map((x) => [x.name, x.human]), pickups: RR.game.pickups.map((p) => p.kind).join('') }));
    const srv = [...s.hub.rooms][0].engine.G;
    // (Bob's own menu has Indy's weapons off: the room's choice is what counts, the same on every screen as on the server)
    const want = { course: 'indy', ships: [['ALICE', true], ['BOB', true]], pickups: srv.pickups.map((p) => p.kind).join('') };
    assert.ok(want.pickups.includes('W'), 'weapon crates out on the server');
    assert.deepStrictEqual(await look(A), want, 'just the two of them, on the oval');
    assert.deepStrictEqual(await look(B), want);

    // Alice's autopilot flies her round, into the outside lane (RIGHT): her own screen flies it ahead of the
    // server and agrees with it, between the walls
    await A.page.waitForFunction(() => RR.game.phase === 'race', null, { timeout: 8000 });
    await A.page.waitForTimeout(400);
    await A.page.keyboard.down('ArrowRight'); await A.page.waitForTimeout(150); await A.page.keyboard.up('ArrowRight');
    await A.page.waitForTimeout(3000);
    const mine = await A.page.evaluate(() => { const p = RR.game.player, L = RR.game.track.lane; return { x: p.x, y: p.y, v: Math.hypot(p.vx, p.vy), d: L.at(p.x, p.y).d, lane: p.pilot.lane }; });
    const srv2 = [...s.hub.rooms][0].engine.G, ship = srv2.ships[0];
    assert.ok(mine.v > 200 && mine.lane === 1, 'flying itself, in the outside lane: ' + JSON.stringify(mine));
    assert.ok(Math.abs(mine.d) < 140, 'between the walls');
    assert.ok(Math.hypot(mine.x - ship.x, mine.y - ship.y) < 40, 'her screen agrees with the server');
    assert.deepStrictEqual([A.errors, B.errors], [[], []]);
  } finally { await A.ctx.close(); await B.ctx.close(); s.close(); }
});

test('online: invite links - the host\'s INVITE LINK opens the game for a friend, who picks a pilot name and joins at once; a lending link gives them a maxed-out Phoenix for the room', { skip }, async () => {
  const s = await serve();
  const A = await player(s.url, 'ALICE');
  const guests = [];
  /** A friend opening a link: the page asks for a pilot name before anything else. */
  const opens = async (link) => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 560 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.stack || e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(link);
    await page.waitForFunction(() => window.RR && RR.game && !document.getElementById('namebox').hidden);
    const P = { ctx, page, errors };
    guests.push(P);
    return P;
  };
  try {
    await A.tap('ONLINE (O)');
    await A.page.waitForFunction(() => RR.mp.status === 'online');
    await A.tap('CREATE ROOM');
    await A.page.waitForFunction(() => RR.mp.room && RR.mp.room.code && RR.mp.key);
    const code = await A.page.evaluate(() => RR.mp.room.code);

    // INVITE LINK (L): the plain link, then (ticked) the lending one
    await A.page.keyboard.press('KeyL');
    await A.page.waitForSelector('#linkbox:not([hidden])');
    assert.strictEqual(await A.page.textContent('#linktitle'), 'INVITE TO ROOM ' + code);
    const plain = await A.page.inputValue('#invitelink');
    assert.strictEqual(plain, s.url + '?room=' + code);
    await A.page.click('#lend');
    const lending = await A.page.inputValue('#invitelink');
    assert.match(lending, new RegExp('\\?room=' + code + '&loan=[0-9a-f]{12}$'));
    assert.match(await A.page.textContent('#linkhelp'), /MAXED OUT/i);
    await A.page.click('#linkdone');
    await A.page.waitForSelector('#linkbox', { state: 'hidden' });

    // Bob opens the lending link: JOIN ROOM, a name, and he is in, in a maxed-out Phoenix
    const B = await opens(lending);
    assert.strictEqual(await B.page.textContent('#nametitle'), 'JOIN ROOM ' + code);
    assert.match(await B.page.textContent('#namehelp'), /lent a Phoenix with every stat and powerup maxed out/);
    assert.strictEqual(B.page.url(), s.url, 'the link is taken out of the address bar (a reload will not join twice)');
    const hangar = await B.page.evaluate(() => JSON.stringify(RR.game.prog));
    await B.page.fill('#pilot', 'zed');
    await B.page.click('#nameok');
    await B.page.waitForFunction(() => RR.game.state === 'online' && RR.mp.room && RR.mp.room.humans.length === 2, null, { timeout: 6000 });
    assert.deepStrictEqual(await B.page.evaluate(() => [RR.game.name, RR.mp.room.code, RR.mp.room.humans[RR.mp.you].loan, RR.mp.key]), ['ZED', code, true, null],
      'named ZED, in the room, flying a lent rocket, and not the host');

    // Carol opens the plain link: her own rocket. Dan opens it and says NOT NOW: he stays on the title screen
    const C = await opens(plain);
    assert.doesNotMatch(await C.page.textContent('#namehelp'), /maxed/i);
    await C.page.click('#nameok');
    await C.page.waitForFunction(() => RR.mp.room && RR.mp.room.humans.length === 3, null, { timeout: 6000 });
    const D = await opens(plain);
    await D.page.click('#namecancel');
    await D.page.waitForTimeout(500);
    assert.deepStrictEqual(await D.page.evaluate(() => [RR.game.state, RR.mp.room]), ['title', null]);

    // everyone READY: Bob races in the Phoenix with every stat at its ceiling; Carol in her own Sparrow
    await A.page.keyboard.press('Enter');
    for (const P of [B, C]) await P.page.keyboard.press('Enter');
    await B.page.waitForFunction(() => RR.game.state === 'play' && RR.game.online, null, { timeout: 6000 });
    const seats = [...s.hub.rooms][0].opts.seats;
    assert.deepStrictEqual(seats.slice(0, 3).map((x) => [x.name, x.hull, x.stats.join()]),
      [['ALICE', 'sparrow', '3,3,3,3,3'], ['ZED', 'phoenix', '10,10,10,10,10'], [seats[2].name, 'sparrow', '3,3,3,3,3']]);
    assert.deepStrictEqual(Object.values(seats[1].levels), [3, 3, 3, 3, 3, 3, 3, 3], 'every powerup maxed too');
    assert.deepStrictEqual(await B.page.evaluate(() => [RR.game.player.design, RR.game.player.plv.missile]), [3, 3], 'his own screen flies the Phoenix too');
    assert.strictEqual(await B.page.evaluate(() => JSON.stringify(RR.game.prog)), hangar, 'and his own hangar is untouched');
    assert.deepStrictEqual([A.errors, ...guests.map((P) => P.errors)], [[], [], [], []]);
  } finally { await A.ctx.close(); for (const P of guests) await P.ctx.close(); s.close(); }
});
