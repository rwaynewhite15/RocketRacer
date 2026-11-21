'use strict';

/*
 * Browser tests: open the real game in headless Chromium, drive its
 * simulation and check the rules hold. They need Playwright, which is not an
 * app dependency:
 *
 *   npm install --no-save playwright && npx playwright install chromium
 *
 * Without it they are skipped, except in CI, where a missing browser fails the build.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp } = require('../server');
const { memoryStore } = require('../lib/store');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* handled just below */ }
if (!chromium && process.env.CI) throw new Error('Playwright is required in CI: npm install --no-save playwright');
const skip = chromium ? false : 'Playwright is not installed';

let server, base, browser;

before(async () => {
  if (skip) return;
  server = http.createServer(createApp(memoryStore()));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

/** Open the game, collect page errors, and install a few helpers on `window.T`. */
async function openGame(viewport, baseUrl) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto((baseUrl || base) + '/');
  await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
  await addHelpers(page);
  return { page, ctx, errors };
}

/** `window.T`: test helpers in the page (again after a reload). */
async function addHelpers(page) {
  await page.evaluate(() => {
    const g = RR.game, S = 1 / 120;
    window.T = {
      // a rival's brain, to fly the player's ship
      ai: () => ({ skill: 0.97, aggro: 1, rubber: 0, margin: 6, ox: 0, oy: 0, cpFor: -1, pick: null, pickT: 0, stuck: 0, stuckN: 0, rev: 0, revTurn: 1, fireT: 9 }),
      run(sec, each) { for (let i = 0; i < Math.round(sec * 120); i++) { g.step(S); if (each) each(); } },
      fresh(track) { g.trackIdx = track; g.startRace(false); g.player.ai = T.ai(); g.state = 'play'; T.run(4.2); }, // past the countdown
    };
  });
}

test('boots to the title screen without errors', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const s = await page.evaluate(() => {
      const h = document.getElementById('hud');
      return { state: RR.game.state, hud: [h.width, h.height], W: RR.game.W, H: RR.game.H };
    });
    assert.strictEqual(s.state, 'title');
    assert.deepStrictEqual(s.hud, [s.W, s.H]);
    await page.waitForTimeout(1500); // let the attract-mode race draw some frames
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('an autopilot and the rivals finish every course', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const results = await page.evaluate(() => {
      const g = RR.game, out = [];
      for (let t = 0; t < RR.TRACKS.length; t++) {
        T.fresh(t);
        let steps = 0;
        while (steps++ < 120 * 500 && !g.ships.every((s) => s.finished)) g.step(1 / 120);
        out.push({ track: g.track.name, finished: g.ships.filter((s) => s.finished).length, player: g.player.finished, secs: Math.round(steps / 120) });
      }
      return out;
    });
    for (const r of results) {
      assert.ok(r.player, r.track + ': the autopilot did not finish in 500 s');
      assert.ok(r.finished >= 5, r.track + ': only ' + r.finished + ' of 6 ships finished');
    }
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('zoom changes the world scale but not the HUD, and is remembered', { skip }, async () => {
  const { page, ctx, errors } = await openGame({ width: 1280, height: 720 });
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, w = document.getElementById('screen'), h = document.getElementById('hud');
      const snap = () => ({ world: [w.width, w.height], hud: [h.width, h.height], ratio: g.zoomScale });
      const out = { normal: snap() };
      g.setZoom(-1); out.wide = snap();
      g.setZoom(1); out.close = snap();
      g.setZoom(0); out.back = snap();
      out.saved = JSON.parse(localStorage.getItem('rocketracer.v1')).zoom;
      out.levels = g.zoomLevels();
      return out;
    });
    assert.ok(r.wide.world[0] > r.normal.world[0], 'wide shows more of the world');
    assert.ok(r.close.world[0] < r.normal.world[0], 'close shows less of the world');
    for (const k of ['wide', 'close', 'back']) assert.deepStrictEqual(r[k].hud, r.normal.hud, 'HUD size at ' + k);
    assert.deepStrictEqual(r.back, r.normal);
    assert.strictEqual(r.saved, 0);
    assert.ok(r.levels.length >= 3);
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('gate deferral: the gate ahead counts as passed and the rocket heads straight on to the next; every lap is still flown over the line', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, S = 1 / 120, out = {};
      T.fresh(0);
      const p = g.player;
      out.N = g.track.cps.length;
      // on autopilot over the line: lap 1, heading for gate 1
      let n = 0; while (p.cpCount < 1 && n++ < 120 * 60) g.step(S);
      const before = { gate: p.nextCp, count: p.cpCount, x: p.x, y: p.y, t: g.raceTime };
      p.defer = 1;
      out.ok = g.tryDefer();
      out.before = before;
      out.after = {
        gate: p.nextCp, count: p.cpCount, held: p.defer, used: p.used.defer,
        moved: Math.hypot(p.x - before.x, p.y - before.y), clock: g.raceTime - before.t, banner: g.msg && g.msg.text,
      };
      // the line can't be deferred: heading for it, the deferral is kept and the pilot is told to fly it
      p.nextCp = 0; p.defer = 1;
      out.line = { ok: g.tryDefer(), can: g.canDefer(), held: p.defer, said: g.texts.some((t) => t.text === 'FLY THE LINE') };

      // a whole lap deferred: every gate but the line, which the autopilot then flies through, and the lap counts
      T.fresh(0);
      const q = g.player;
      n = 0; while (q.cpCount < 1 && n++ < 120 * 60) g.step(S);
      q.defer = 99;
      const lap0 = q.lap;
      let deferred = 0;
      n = 0;
      while (q.lap === lap0 && n++ < 120 * 60) { if (g.canDefer() && g.tryDefer()) deferred++; g.step(S); }
      out.lap = { from: lap0, to: q.lap, deferred: deferred, laps: q.lapTimes.length };

      // not before the lights go green
      g.startRace(false); g.player.defer = 1; g.player.nextCp = 1;
      out.countdown = { ok: g.tryDefer(), held: g.player.defer };
      return out;
    });
    assert.strictEqual(r.N, 9, 'the course has nine gates (the line and eight more)');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([r.before.gate, r.after.gate, r.after.count], [1, 2, r.before.count + 1], 'gate 1 counts as passed: on to gate 2');
    assert.deepStrictEqual([r.after.held, r.after.used], [0, 1], 'spent, and counted as used');
    assert.ok(r.after.moved < 1 && r.after.clock === 0, 'nothing else changes: the rocket stays put and the clock is untouched');
    assert.strictEqual(r.after.banner, 'GATE DEFERRED!');
    assert.deepStrictEqual(r.line, { ok: false, can: false, held: 1, said: true });
    assert.deepStrictEqual(r.lap, { from: 1, to: 2, deferred: r.N - 1, laps: 1 }, 'every gate but the line deferred; the lap counts once the line is flown');
    assert.deepStrictEqual(r.countdown, { ok: false, held: 1 });
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('leaderboard: rows show the race place, and your own row appears below the top ten', { skip }, async () => {
  // Its own server, so scores posted by the other tests' races cannot shift the ranks.
  const own = http.createServer(createApp(memoryStore()));
  await new Promise((resolve) => own.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + own.address().port;
  // eleven pilots faster than the autopilot can fly, so "we" come twelfth: off the bottom of the board
  const post = (b) => fetch(url + '/api/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  for (let i = 0; i < 11; i++) {
    const res = await post({ track: 'lunar', pid: 'seed-' + String(i).padStart(8, '0'), name: 'SEED' + i, time: 45 + i, lap: 14, diff: 1, place: (i % 6) + 1 });
    assert.strictEqual(res.status, 200);
  }
  const { page, ctx, errors } = await openGame(null, url);
  try {
    await page.waitForFunction(() => RR.net.online && RR.net.boards.lunar);
    const r = await page.evaluate(async () => {
      const g = RR.game, n = RR.net, out = {};
      out.before = n.me.lunar; // we have not raced yet
      // finish a real race on autopilot: slower than every seed, in whatever place it earns
      T.fresh(0);
      let k = 0; while (!g.playerDone && k++ < 120 * 400) g.step(1 / 120);
      out.place = g.player.place;
      for (let i = 0; i < 100 && !n.result; i++) await new Promise((res) => setTimeout(res, 50));
      out.result = n.result;
      out.me = n.me.lunar && { rank: n.me.lunar.rank, place: n.me.lunar.place, name: n.me.lunar.name };
      out.top = n.boards.lunar.slice(0, 2).map((e) => [e.name, e.place]);
      out.inTop = n.boards.lunar.some((e) => e.name === g.name);
      out.name = g.name;
      g.toTitle(); g.showBoard(); // and draw it
      out.state = g.state;
      return out;
    });
    await page.waitForTimeout(400);
    assert.strictEqual(r.before, null);
    assert.deepStrictEqual(r.top, [['SEED0', 1], ['SEED1', 2]]);
    assert.strictEqual(r.result.rank, 12);
    assert.deepStrictEqual(r.me, { rank: 12, place: r.place, name: r.name });
    assert.ok(r.place >= 1 && r.place <= 6);
    assert.strictEqual(r.inTop, false);
    assert.strictEqual(r.state, 'board');
    // reopening the game later still knows our row (it comes from the server, not this tab)
    await page.reload();
    await page.waitForFunction(() => RR.net.me.lunar !== undefined);
    assert.strictEqual(await page.evaluate(() => RR.net.me.lunar.rank), 12);
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); own.close(); }
});

/** A server of its own (so other tests' races cannot change its board), with these rows posted first. */
async function ownBoard(rows) {
  const own = http.createServer(createApp(memoryStore()));
  await new Promise((resolve) => own.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + own.address().port;
  for (const b of rows) {
    const res = await fetch(url + '/api/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    assert.strictEqual(res.status, 200, await res.text());
  }
  return { own, url };
}

test('leaderboard: a race sends the rocket flown, its stat levels and the powerups actually used', { skip }, async () => {
  const { own, url } = await ownBoard([]);
  const { page, ctx, errors } = await openGame(null, url);
  try {
    await page.waitForFunction(() => RR.net.online);
    const r = await page.evaluate(async () => {
      const g = RR.game, n = RR.net, read = RR.input.read, out = {};
      // fly a tuned DART: two points in ACCEL and one in HULL (its own levels are 4 4 4 2 3)
      g.prog.wins = 2; g.prog.points = 3; g.prog.ship = 1;
      g.spend(1, 0, 1); g.spend(1, 0, 1); g.spend(1, 3, 1);
      g.prog.pup = { missile: 3, nitro: 2 }; // and two upgraded powerups
      g.trackIdx = 0; g.startRace(false); g.state = 'play';
      let fire = false;
      RR.input.read = () => ({ turn: 0, thrust: 0, brake: 0, fire: fire, aim: null, stick: false });
      T.run(4.2); // past the countdown, hands off
      const p = g.player, pk = g.pickups[0];
      const grab = (type) => { pk.on = true; pk.type = type; p.x = pk.x; p.y = pk.y; p.vx = p.vy = 0; g.step(1 / 120); };
      const shoot = () => { fire = true; g.step(1 / 120); fire = false; g.step(1 / 120); };
      grab('nitro'); grab('shield');
      grab('blaster'); // picked up but never fired: not used
      grab('missile'); shoot(); T.run(0.6); shoot(); // two missiles from one pick-up: one missile powerup used
      T.run(0.6); grab('missile'); shoot(); // a second pick-up, fired (once the launcher has reloaded)
      out.during = Object.assign({}, p.used);
      grab('defer'); p.lap = 1; p.nextCp = 1; p.cpCount = 1; g.tryDefer(); // a gate deferred (as if just over the line)
      grab('defer'); // and one picked up but never used
      // nothing more to pick up or fire: the autopilot brings it home
      g.pickups.forEach((q) => { q.on = false; q.timer = 1e9; });
      p.weapon = null; p.ammo = 0;
      RR.input.read = read;
      p.ai = T.ai();
      let k = 0; while (!g.playerDone && k++ < 120 * 400) g.step(1 / 120);
      out.done = g.playerDone;
      for (let i = 0; i < 100 && !n.result; i++) await new Promise((res) => setTimeout(res, 50));
      out.result = n.result;
      out.mine = n.me.lunar && n.me.lunar.setup;
      out.row = n.boards.lunar && n.boards.lunar[0] && n.boards.lunar[0].setup;
      return out;
    });
    assert.deepStrictEqual(r.during, { nitro: 1, shield: 1, missile: 2 }, 'tallied as they were used');
    assert.ok(r.done && r.result && !r.result.error, JSON.stringify(r.result));
    const want = { ship: 'dart', stats: [6, 4, 4, 3, 3], items: { nitro: 1, shield: 1, missile: 2, defer: 1 }, levels: { missile: 3, nitro: 2 } };
    assert.deepStrictEqual(r.mine, want, 'your own row');
    assert.deepStrictEqual(r.row, want, 'the top-ten row everyone sees');
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); own.close(); }
});

test('leaderboard: rows show each pilot\'s rocket and powerups; a click (or the arrows and Enter) opens their card', { skip }, async () => {
  const at = (pid, name, time, setup) => Object.assign({ track: 'lunar', pid: 'card-' + pid.padEnd(8, '0'), name: name, time: time, lap: 14, diff: 2, place: 1 }, setup ? { setup } : {});
  const { own, url } = await ownBoard([
    at('a', 'COMET', 44, { ship: 'phoenix', stats: [8, 9, 7, 6, 5], items: { nitro: 3, shield: 1, missile: 2, defer: 1 } }),
    at('b', 'ZIPPY', 45, { ship: 'dart', stats: [6, 7, 6, 3, 3], items: { nitro: 1 } }),
    at('c', 'ROCKY', 46, { ship: 'sparrow', stats: [3, 3, 3, 3, 3], items: {} }),
    at('d', 'OLDIE', 47), // from before setups were saved
  ]);
  const { page, ctx, errors } = await openGame(null, url);
  try {
    await page.waitForFunction(() => RR.net.online);
    await page.evaluate(() => { RR.game.trackIdx = 0; RR.game.showBoard(); });
    await page.waitForFunction(() => RR.net.boards.lunar && RR.net.boards.lunar.length === 4);
    await page.waitForTimeout(200);
    const state = () => page.evaluate(() => {
      const g = RR.game, c = g.boardCard;
      return { state: g.state, card: c ? { rank: c.rank, name: c.e.name, shown: g.cardShown } : null, sel: g.boardSel };
    });

    // each row: the rocket, then the powerups most used first (two and a "+" when there are more than three)
    const strips = await page.evaluate(() => RR.game.boardRows.map((r) => r.strip));
    assert.deepStrictEqual(strips, [
      { ship: 'phoenix', icons: ['nitro', 'missile'], numbers: [], more: 2 },
      { ship: 'dart', icons: ['nitro'], numbers: [], more: 0 },
      { ship: 'sparrow', icons: [], numbers: [], more: 0 },
      null,
    ]);

    // click the top row: their card
    const box = await page.locator('#hud').boundingBox();
    const k = box.width / await page.evaluate(() => RR.game.W);
    const click = async (label) => {
      const u = await page.evaluate((l) => RR.game.ui.find((b) => b.label === l) || null, label);
      assert.ok(u, 'on screen: ' + label);
      await page.mouse.click(box.x + (u.x + u.w / 2) * k, box.y + (u.y + u.h / 2) * k);
      await page.waitForTimeout(150);
    };
    await click('PILOT 1');
    let s = await state();
    assert.deepStrictEqual(s.card, { rank: 1, name: 'COMET', shown: {
      ship: 'phoenix', stats: [8, 9, 7, 6, 5], items: [['nitro', 3], ['missile', 2], ['shield', 1], ['defer', 1]], numbers: [],
    } });
    await click('BACK (ENTER)');
    s = await state();
    assert.deepStrictEqual([s.state, s.card], ['board', null], 'back to the board');

    // keyboard: arrows pick a row, Enter opens it, Esc steps back out one level at a time
    const key = async (name, times) => { for (let i = 0; i < (times || 1); i++) { await page.keyboard.press(name); await page.waitForTimeout(60); } };
    await key('ArrowDown', 4); // from the clicked row 1 down to row 4... wrapping to the top
    assert.strictEqual((await state()).sel, 0);
    await key('ArrowUp');
    assert.strictEqual((await state()).sel, 3, 'up from the top wraps to the bottom');
    await key('Enter');
    s = await state();
    assert.deepStrictEqual(s.card, { rank: 4, name: 'OLDIE', shown: { ship: null, stats: null, items: [], numbers: [] } }, 'an old row: no setup on record');
    await key('Escape');
    assert.deepStrictEqual([(await state()).state, (await state()).card], ['board', null]);
    await key('ArrowUp');
    await key('Enter');
    s = await state();
    assert.deepStrictEqual(s.card, { rank: 3, name: 'ROCKY', shown: { ship: 'sparrow', stats: [3, 3, 3, 3, 3], items: [], numbers: [] } }, 'a clean run');
    await key('Enter');
    assert.strictEqual((await state()).card, null, 'Enter closes the card too');
    await key('Escape');
    assert.strictEqual((await state()).state, 'title', 'and Esc the board');
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); own.close(); }
});

test('powerup upgrades: events pay credits, credits buy upgrade points, and points raise powerups to level 3 like stat points', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    // a race on autopilot pays credits by finishing place, times the rival level
    const paid = await page.evaluate(() => {
      const g = RR.game;
      g.prog.credits = 0;
      T.fresh(1);
      let k = 0; while (!g.playerDone && k++ < 120 * 400) g.step(1 / 120);
      const place = g.player.place, want = Math.round([100, 70, 50, 40, 30, 30][place - 1] * [1, 1.5, 2][g.diffIdx]);
      return { got: g.reward.credits, want: want, credits: g.prog.credits };
    });
    assert.ok(paid.want > 0);
    assert.deepStrictEqual([paid.got, paid.credits], [paid.want, paid.want]);

    const r = await page.evaluate(() => {
      const g = RR.game, pr = g.prog, out = {}, now = () => [pr.credits, pr.upts, Object.assign({}, pr.pup)];
      pr.credits = 450; pr.upts = 0; pr.pup = {};
      out.buy = [g.buyUpgrade(), g.buyUpgrade(), g.buyUpgrade(), g.buyUpgrade(), now()]; // 150 each: the fourth is too dear
      out.up = [g.powerSpend('missile', 1), g.powerSpend('missile', 1), g.powerSpend('missile', 1), now()]; // level 3 is the top
      out.none = [g.powerSpend('mine', 1), g.powerSpend('mine', 1), now()]; // then no points left in hand
      out.back = [g.powerSpend('missile', -1), now()]; // taken back, kept to spend again
      out.move = [g.powerSpend('emp', 1), g.powerSpend('emp', -1), g.powerSpend('emp', -1), now()]; // level 1 is the bottom
      out.room = g.powerRoom(); // 8 powerups x 2 levels, less the two spent
      // points stop where every powerup would be maxed: never more than there is room for
      pr.credits = 1e6; let n = 0; while (g.buyUpgrade()) n++;
      out.cap = [n, pr.upts, g.powerRoom()];
      return out;
    });
    assert.deepStrictEqual(r.buy, [true, true, true, false, [0, 3, {}]]);
    assert.deepStrictEqual(r.up, [true, true, false, [0, 1, { missile: 3 }]], 'the third point stays in hand: level 3 is the top');
    assert.deepStrictEqual(r.none, [true, false, [0, 0, { missile: 3, mine: 2 }]]);
    assert.deepStrictEqual(r.back, [true, [0, 1, { missile: 2, mine: 2 }]]);
    assert.deepStrictEqual(r.move, [true, true, false, [0, 1, { missile: 2, mine: 2 }]]);
    assert.strictEqual(r.room, 14);
    assert.deepStrictEqual(r.cap, [13, 14, 14], 'buys stop at 14 points in hand: exactly the room left');

    // kept after a reload; a doctored save is trimmed
    await page.reload();
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    assert.deepStrictEqual(await page.evaluate(() => [RR.game.prog.upts, RR.game.prog.pup]), [14, { missile: 2, mine: 2 }]);
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('rocketracer.v1'));
      s.prog.upts = 999; s.prog.pup = { missile: 9, laser: 2, emp: 0 };
      localStorage.setItem('rocketracer.v1', JSON.stringify(s));
    });
    await page.reload();
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    assert.deepStrictEqual(await page.evaluate(() => [RR.game.prog.upts, RR.game.prog.pup]), [14, { missile: 3 }],
      'missile cut to 3, unknown dropped, points cut to the 14 levels left');

    // the hangar: tap POWERUPS, BUY and a powerup's +; the keyboard runs on from the stats into the upgrades
    await addHelpers(page);
    await page.evaluate(() => { const g = RR.game, pr = g.prog; pr.credits = 300; pr.upts = 0; pr.pup = {}; g.state = 'title'; g.openHangar(); });
    await page.waitForTimeout(100);
    const box = await page.locator('#hud').boundingBox();
    const k = box.width / await page.evaluate(() => RR.game.W);
    const click = async (label) => {
      const u = await page.evaluate((l) => RR.game.ui.find((b) => b.label === l) || null, label);
      assert.ok(u, 'on screen: ' + label);
      await page.mouse.click(box.x + (u.x + u.w / 2) * k, box.y + (u.y + u.h / 2) * k);
      await page.waitForTimeout(80);
    };
    await click('POWERUPS');
    await click('BUY ' + 150 + ' CR');
    await click('UP shield');
    const state = () => page.evaluate(() => { const g = RR.game; return [g.hangarPage, g.prog.credits, g.prog.upts, Object.assign({}, g.prog.pup)]; });
    assert.deepStrictEqual(await state(), ['power', 150, 0, { shield: 2 }]);
    assert.deepStrictEqual(await page.evaluate(() => RR.game.powerShown.find((x) => x[0] === 'shield')), ['shield', 2], 'the page shows level 2');
    await click('SHIP');
    // the keyboard: rows run on from the stats into the upgrades; down past FIREPOWER to BUY, then on to EMP
    const press = async (key, n) => { for (let i = 0; i < (n || 1); i++) { await page.keyboard.press(key); await page.waitForTimeout(60); } };
    await press('ArrowDown', 6);
    assert.strictEqual((await state())[0], 'power', 'past the stats, the page turns to powerups');
    await press('ArrowRight'); // BUY
    assert.deepStrictEqual(await state(), ['power', 0, 1, { shield: 2 }]);
    await press('ArrowDown', 7); // NITRO SHIELD REPAIR BLASTER MISSILE MINE EMP
    await press('ArrowRight');
    assert.deepStrictEqual(await state(), ['power', 0, 0, { shield: 2, emp: 2 }]);
    await press('ArrowDown', 2); // DEFERRAL, then round to the ship
    assert.strictEqual((await state())[0], 'ship');
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('powerup upgrades: an upgraded pick-up is stronger, rivals stay at level 1, and the leaderboard marks it with a small number', { skip }, async () => {
  const { own, url } = await ownBoard([
    { track: 'lunar', pid: 'lvl-a0000000', name: 'MAXED', time: 50, lap: 15, diff: 2, place: 1,
      setup: { ship: 'phoenix', stats: [8, 8, 8, 8, 8], items: { missile: 2, nitro: 1 }, levels: { missile: 3 } } },
    { track: 'lunar', pid: 'lvl-b0000000', name: 'BASIC', time: 51, lap: 15, diff: 2, place: 1,
      setup: { ship: 'dart', stats: [4, 4, 4, 2, 3], items: { nitro: 1 }, levels: {} } },
  ]);
  const { page, ctx, errors } = await openGame(null, url);
  try {
    await page.waitForFunction(() => RR.net.online);
    const r = await page.evaluate(async () => {
      const g = RR.game, n = RR.net, out = {};
      g.prog.pup = { nitro: 3, shield: 2, repair: 3, missile: 3, blaster: 3, defer: 2 };
      g.trackIdx = 0; g.modeIdx = 0; g.startRace(false); g.state = 'play';
      T.run(4.3);
      const p = g.player, rival = g.ships[1], pk = g.pickups[0];
      const grab = (s, type) => { pk.on = true; pk.type = type; s.x = pk.x; s.y = pk.y; s.vx = s.vy = 0; g.step(1 / 120); };
      grab(p, 'nitro'); out.nitro = +(p.nitro / 2.6).toFixed(2);
      grab(p, 'shield'); out.shield = +(p.shield / 7).toFixed(2);
      p.maxHp = 300; p.hp = 10; grab(p, 'repair'); out.repair = p.hp - 10; // (room for all of it)
      grab(p, 'missile'); out.missiles = [p.weapon, p.ammo];
      grab(p, 'blaster'); out.blaster = p.ammo; grab(p, 'blaster'); out.topUp = p.ammo; // a top-up never takes ammo away
      p.weapon = null; p.ammo = 0;
      grab(p, 'defer'); out.defers = p.defer;
      // a rival picking up the same thing gets level 1 (the player moved off the pick-up first)
      p.x = g.track.grid[0].x; p.y = g.track.grid[0].y;
      rival.weapon = null; rival.ammo = 0;
      grab(rival, 'missile'); out.rival = [rival.weapon, rival.ammo];
      rival.hp = 10; grab(rival, 'repair'); out.rivalRepair = rival.hp - 10;
      // two gate deferrals from one pick-up, both counted as used (heading for gate 1, over the line)
      p.lap = 1; p.nextCp = 1; p.cpCount = 1;
      g.tryDefer(); out.afterOne = p.defer;
      g.tryDefer(); out.afterTwo = [p.defer, p.used.defer, p.cpCount];
      out.words = [RR.powerDoes('missile', 3), RR.powerDoes('defer', 2), RR.powerDoes('nitro', 3), RR.powerDoes('shield', 2), RR.powerDoes('repair', 3), RR.powerDoes('emp', 1)];
      out.setupLevels = p.setup.levels;
      g.toTitle(); g.trackIdx = 0; g.showBoard();
      return out;
    });
    assert.ok(r.nitro > 1.98 && r.nitro <= 2, 'nitro level 3: twice as long: ' + r.nitro);
    assert.ok(r.shield > 1.48 && r.shield <= 1.5, 'shield level 2: half as long again: ' + r.shield);
    assert.strictEqual(r.repair, 100, 'repair level 3: +100 hull');
    assert.deepStrictEqual(r.missiles, ['missile', 5], 'missile level 3: five');
    assert.deepStrictEqual([r.blaster, r.topUp], [30, 60], 'blaster level 3: 30 shots, topped up to 60');
    assert.strictEqual(r.defers, 2, 'deferral level 2: two gates');
    assert.deepStrictEqual(r.rival, ['missile', 2], 'a rival still gets two missiles');
    assert.strictEqual(r.rivalRepair, 50);
    assert.deepStrictEqual([r.afterOne, r.afterTwo], [1, [0, 2, 3]]);
    assert.deepStrictEqual(r.words, ['5 MISSILES', '2 GATES', 'BOOST 5.2S', 'SHIELD 10.5S', '+100 HULL', '1 EMP']);
    assert.deepStrictEqual(r.setupLevels, { nitro: 3, shield: 2, repair: 3, missile: 3, blaster: 3, defer: 2 }, 'sent with the time');

    // the board: a small 3 beside the level 3 missile; nothing by a level 1 nitro
    await page.waitForFunction(() => RR.game.boardRows && RR.game.boardRows.length === 2);
    const strips = await page.evaluate(() => RR.game.boardRows.map((x) => x.strip));
    assert.deepStrictEqual(strips, [
      { ship: 'phoenix', icons: ['missile', 'nitro'], numbers: [['missile', 3]], more: 0 },
      { ship: 'dart', icons: ['nitro'], numbers: [], more: 0 },
    ]);
    // no underline: the line of pixels just below the row icons has no gold in it
    const gold = await page.evaluate(() => {
      const c = document.getElementById('hud').getContext('2d'), want = RR.PAL.gold.toLowerCase();
      let hits = 0;
      for (const row of RR.game.boardRows) {
        for (let k = 0; k < 54; k++) {
          const d = c.getImageData(row.at[0] + k, row.at[1] + 9, 1, 1).data;
          if ('#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('') === want) hits++;
        }
      }
      return hits;
    });
    assert.strictEqual(gold, 0);
    await page.evaluate(() => RR.game.openCard(RR.game.boardRows[0]));
    await page.waitForTimeout(150);
    assert.deepStrictEqual(await page.evaluate(() => RR.game.cardShown.numbers), [['missile', 3]], 'and on the card');
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); own.close(); }
});

test('hangar: no ship ever holds stat points it cannot use', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, pr = g.prog, out = { room: RR.HULLS.map((h, i) => RR.shipRoom(i)) };
      const win = () => {
        T.fresh(0);
        g.ships.forEach((s) => { if (s !== g.player) s.ai.skill = 0.2; }); // slow rivals: a sure win
        let k = 0; while (!g.playerDone && k++ < 120 * 400) g.step(1 / 120);
        return [g.player.place, pr.points, g.reward.pts, g.reward.capped];
      };
      g.diffIdx = 1; // a win against Pilot rivals earns 4 points
      pr.wins = 0; pr.points = 14;
      out.first = win(); // only the Sparrow (room 15): 1 of the 4 fits
      out.second = win(); // the second win opens the Dart (room 19): all 4 fit
      out.view = [0, 1].map((i) => [g.shipPoints(i), g.pointsLeft(i)]);
      out.third = win(); // full for the Dart: nothing more until a roomier ship opens
      out.credits = g.reward.credits > 0;
      return out;
    });
    assert.deepStrictEqual(r.room, [15, 19, 20, 25], 'Sparrow, Dart, Hammer, Phoenix');
    assert.deepStrictEqual(r.first, [1, 15, 1, true]);
    assert.deepStrictEqual(r.second, [1, 19, 4, false]);
    assert.deepStrictEqual(r.view, [[15, 15], [19, 19]], 'the Sparrow sees only the 15 it can use, the Dart all 19');
    assert.deepStrictEqual(r.third, [1, 19, 0, true]);
    assert.strictEqual(r.credits, true, 'credits still come');
    // a doctored save is cut back to what the unlocked ships can use
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('rocketracer.v1'));
      s.prog.points = 999; s.prog.wins = 5;
      localStorage.setItem('rocketracer.v1', JSON.stringify(s));
    });
    await page.reload();
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    assert.strictEqual(await page.evaluate(() => RR.game.prog.points), 20, 'five wins: the Hammer, room 20');
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('gate deferral: E (or the DEFER button on a touch screen) spends one; heading for the line, the button stays and a tap keeps it', { skip }, async () => {
  // keyboard
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, p = (T.fresh(0), g.player);
      let n = 0; while (p.cpCount < 1 && n++ < 120 * 60) g.step(1 / 120);
      p.ai = null; p.vx = p.vy = 0; p.defer = 2;
      return { gate: p.nextCp };
    });
    await page.waitForTimeout(100);
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => ({ gate: RR.game.player.nextCp, held: RR.game.player.defer }));
    assert.deepStrictEqual(after, { gate: r.gate + 1, held: 1 }, 'E defers the gate ahead');
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }

  // touch
  const ph = await phoneRace();
  try {
    const btn = () => ph.page.evaluate(() => !!RR.game.ui.find((u) => u.label === 'DEFER'));
    assert.strictEqual(await btn(), false, 'no button without a deferral');
    await ph.page.evaluate(() => { const p = RR.game.player; p.lap = 1; p.nextCp = 1; p.cpCount = 1; p.defer = 1; });
    await ph.page.waitForTimeout(100);
    assert.strictEqual(await btn(), true, 'the button appears with one');
    await ph.tapLabel('DEFER');
    const s = await ph.page.evaluate(() => ({ gate: RR.game.player.nextCp, held: RR.game.player.defer, banner: RR.game.msg && RR.game.msg.text }));
    assert.deepStrictEqual(s, { gate: 2, held: 0, banner: 'GATE DEFERRED!' });
    await ph.page.waitForTimeout(100);
    assert.strictEqual(await btn(), false, 'and goes once it is spent');

    // heading for the line: the button stays (dimmed), and a tap keeps the deferral and says why
    await ph.page.evaluate(() => { const p = RR.game.player; p.nextCp = 0; p.defer = 1; });
    await ph.page.waitForTimeout(100);
    await ph.tapLabel('DEFER');
    const l = await ph.page.evaluate(() => ({ held: RR.game.player.defer, gate: RR.game.player.nextCp, said: RR.game.texts.some((t) => t.text === 'FLY THE LINE') }));
    assert.deepStrictEqual(l, { held: 1, gate: 0, said: true });
    assert.deepStrictEqual(ph.errors, []);
  } finally { await ph.ctx.close(); }
});

test('gate deferral: only humans pick one up, one at a time; none in a fight; saved do-over upgrades and button spots carry over', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, out = {};
      // capsules: rivals leave them, the human takes one but not a second
      T.fresh(1);
      const a = g.pickups[0], b = g.pickups[1];
      a.type = b.type = 'defer'; a.on = b.on = true;
      const rival = g.ships[1]; rival.x = a.x; rival.y = a.y; T.run(0.05);
      out.rivalIgnored = a.on && rival.defer === 0;
      rival.x = 1e5;
      const me = g.player; me.ai = null; me.x = a.x; me.y = a.y; me.vx = me.vy = 0; T.run(0.05);
      out.tookOne = { held: me.defer, gone: !a.on };
      me.x = b.x; me.y = b.y; T.run(0.05);
      out.secondLeft = { held: me.defer, stillThere: b.on };
      // a fight has no gates: no deferrals in its pick-ups, and none can be spent
      g.modeIdx = 1; g.arenaIdx = 0; g.startRace(false); g.state = 'play'; T.run(4.3);
      g.player.defer = 1;
      out.fight = { can: g.canDefer(), ok: g.tryDefer(), rolls: [] };
      for (let i = 0; i < 300; i++) { g.pickups.forEach((p) => { p.on = false; p.timer = 0; }); g.step(1 / 120); out.fight.rolls.push(...g.pickups.map((p) => p.type)); }
      out.fight.deferRolled = out.fight.rolls.includes('defer');
      delete out.fight.rolls;
      return out;
    });
    assert.strictEqual(r.rivalIgnored, true);
    assert.deepStrictEqual(r.tookOne, { held: 1, gone: true });
    assert.deepStrictEqual(r.secondLeft, { held: 1, stillThere: true });
    assert.deepStrictEqual(r.fight, { can: false, ok: false, deferRolled: false });

    // a save from before the change: do-over upgrades and the DO-OVER button's spot become the deferral's
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('rocketracer.v1') || '{}');
      s.prog = Object.assign({}, s.prog, { pup: { rewind: 3, nitro: 2 } });
      s.controls = { land: { rewind: { x: 0.25, y: 0.5 }, brake: { x: 0.5, y: 0.9 } } };
      localStorage.setItem('rocketracer.v1', JSON.stringify(s));
    });
    await page.reload();
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    const kept = await page.evaluate(() => ({ pup: RR.game.prog.pup, controls: RR.game.controls }));
    assert.deepStrictEqual(kept.pup, { nitro: 2, defer: 3 });
    assert.deepStrictEqual(kept.controls, { land: { brake: { x: 0.5, y: 0.9 }, defer: { x: 0.25, y: 0.5 } } });
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('hangar: races earn stat points, wins unlock ships, upgrades stop at the ship\'s ceiling and are saved', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, out = {};
      out.fresh = { ship: g.prog.ship, open: RR.HULLS.map((h, i) => g.shipUnlocked(i)), spent: g.spend(0, 0, 1) };

      // a real race on autopilot pays out by finishing place
      T.fresh(0);
      let n = 0; while (!g.playerDone && n++ < 120 * 400) g.step(1 / 120);
      const place = g.player.place;
      out.paid = { got: g.reward.pts, want: Math.max(0, 4 - place) + (place === 1 ? g.diffIdx : 0), points: g.prog.points, wins: g.prog.wins, won: place === 1 ? 1 : 0 };

      // spend: the Sparrow goes from 3 to its ceiling of 6 and no further; points can be taken back
      g.prog.points = 19; g.prog.wins = 2; // the Dart is open: up to 19 points (its room)
      out.ups = [1, 1, 1, 1].map(() => g.spend(0, 1, 1));
      out.level = g.statLevel(0, 1);
      out.left = g.pointsLeft(0);
      out.back = [g.spend(0, 1, -1), g.statLevel(0, 1), g.spend(0, 2, -1)];
      g.spend(0, 1, 1); g.spend(0, 3, 1);

      // two wins open the Dart, nothing more; a locked ship can be looked at but not flown or upgraded
      out.open = RR.HULLS.map((h, i) => g.shipUnlocked(i));
      g.state = 'title'; g.openHangar(); g.hangarBrowse(-1);
      out.locked = { viewing: g.hangarShip, flying: g.prog.ship, spend: g.spend(3, 0, 1) };
      g.hangarBrowse(1); g.closeHangar();

      // the upgrades reach the ship that flies
      g.startRace(false);
      const p = g.player, C = RR.CFG;
      out.flown = { speed: (p.accK / p.dragK).toFixed(3), hp: p.maxHp, rival: g.ships[1].maxHp, design: p.design };
      g.prog.ship = 1; g.save();
      return out;
    });
    assert.deepStrictEqual(r.fresh, { ship: 0, open: [true, false, false, false], spent: false });
    assert.strictEqual(r.paid.got, r.paid.want);
    assert.strictEqual(r.paid.points, r.paid.want);
    assert.strictEqual(r.paid.wins, r.paid.won);
    assert.deepStrictEqual(r.ups, [true, true, true, false], 'three levels of room, then the ceiling');
    assert.strictEqual(r.level, 6);
    assert.strictEqual(r.left, 12, 'the Sparrow can use 15 of the 19 points; 3 are in');
    assert.deepStrictEqual(r.back, [true, 5, false]);
    assert.deepStrictEqual(r.open, [true, true, false, false]);
    assert.deepStrictEqual(r.locked, { viewing: 3, flying: 0, spend: false });
    assert.deepStrictEqual(r.flown, { speed: '1.060', hp: 112, rival: 100, design: 0 });

    // progress survives a reload...
    await page.reload();
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    const kept = await page.evaluate(() => ({ p: RR.game.prog, design: RR.game.player.design }));
    const { credits, upts, pup, ...rest } = kept.p;
    assert.deepStrictEqual(rest, { wins: 2, points: 19, ship: 1, up: { sparrow: [0, 3, 0, 1, 0], dart: [0, 0, 0, 0, 0], hammer: [0, 0, 0, 0, 0], phoenix: [0, 0, 0, 0, 0] } });
    assert.ok(Number.isInteger(credits) && credits > 0, 'the race paid credits too: ' + credits);
    assert.deepStrictEqual([upts, pup], [0, {}]);
    assert.strictEqual(kept.design, 1, 'the attract mode flies the chosen ship');

    // ...and a doctored save is cut back to what the rules allow
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('rocketracer.v1'));
      s.prog = { wins: 1, points: 2, ship: 3, up: { sparrow: [9, 9, 9, 9, 9], dart: [1, 0, 0, 0, 0] }, credits: -50, upts: -3, pup: { missile: 'x', laser: 2 } };
      localStorage.setItem('rocketracer.v1', JSON.stringify(s));
    });
    await page.reload();
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    const fixed = await page.evaluate(() => RR.game.prog);
    assert.strictEqual(fixed.ship, 0, 'cannot fly a locked ship');
    assert.deepStrictEqual(fixed.up.sparrow, [0, 0, 0, 0, 0], 'more upgrades than points: wiped');
    assert.deepStrictEqual(fixed.up.dart, [1, 0, 0, 0, 0]);
    assert.deepStrictEqual([fixed.credits, fixed.upts, fixed.pup], [0, 0, {}], 'no debt, no negative points, no made-up powerups');
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('dogfight: the shooter gets the kill, the wreck respawns, five kills win', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, out = {};
      g.modeIdx = 1; g.startRace(false); g.state = 'play'; T.run(4.2);
      g.ships.forEach((s) => { s.ai = null; }); // hands off: nobody moves or shoots but us
      const p = g.player, v = g.ships[1], c = g.track.center;
      const duel = () => { p.x = c.x; p.y = c.y; p.vx = p.vy = 0; p.angle = 0; v.x = c.x + 110; v.y = c.y; v.vx = v.vy = 0; v.hp = 5; v.invuln = 0; };
      out.setup = { combat: g.combat, gates: g.track.cps.length, cannon: p.weapon === null };
      duel();
      RR.input.down.fire = true; T.run(0.5); RR.input.down.fire = false;
      out.kill = { kills: p.kills, deaths: v.deaths, wrecked: v.dead > 0, out: v.gone, over: g.over, feed: g.feed.length };
      T.run(2.5);
      out.back = { alive: v.dead === 0, hp: v.hp, safe: v.invuln > 0 };
      p.kills = 4; duel();
      RR.input.down.fire = true; T.run(0.5); RR.input.down.fire = false;
      out.end = { over: g.over, done: g.playerDone, place: p.place, pts: g.reward.pts, wins: g.prog.wins };
      T.run(3);
      out.state = g.state;
      out.frozen = p.kills;
      return out;
    });
    assert.deepStrictEqual(r.setup, { combat: true, gates: 0, cannon: true });
    assert.deepStrictEqual(r.kill, { kills: 1, deaths: 1, wrecked: true, out: false, over: false, feed: 1 });
    assert.deepStrictEqual(r.back, { alive: true, hp: 100, safe: true });
    assert.deepStrictEqual(r.end, { over: true, done: true, place: 1, pts: 4, wins: 1 });
    assert.strictEqual(r.state, 'results');
    assert.strictEqual(r.frozen, 5, 'the score stands once the fight is over');
    await page.waitForTimeout(300); // draw the results
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('battle royale: one life, the zone closes and burns, last ship flying wins', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, C = RR.CFG, out = {};
      g.modeIdx = 2; g.startRace(false); g.state = 'play'; T.run(4.2);
      g.ships.forEach((s) => { s.ai = null; });
      const p = g.player, v = g.ships[1], w = g.ships[2], c = g.track.center, r0 = g.zone.r0;
      out.start = { whole: g.zone.r === r0 && r0 > g.track.radius * 1.4, alive: g.ships.filter((s) => !s.gone).length };

      // a kill is for good
      p.x = c.x; p.y = c.y; p.vx = p.vy = 0; p.angle = 0; v.x = c.x + 110; v.y = c.y; v.vx = v.vy = 0; v.hp = 5; v.invuln = 0;
      RR.input.down.fire = true; T.run(0.5); RR.input.down.fire = false;
      T.run(4);
      out.kill = { kills: p.kills, gone: v.gone, place: v.place, over: g.over };

      // half-way through the shrink the zone is half the size, and outside it hurts
      g.raceTime = C.ZONE_GRACE + C.ZONE_SHRINK / 2;
      w.x = c.x; w.y = c.y - g.zone.r0; w.vx = w.vy = 0; w.hp = 100; w.shield = 5;
      p.hp = p.maxHp;
      T.run(1);
      out.zone = { half: Math.abs(g.zone.r / r0 - 0.5) < 0.02, burned: w.hp < 90, zoned: w.zoned, inside: p.hp === p.maxHp && !p.zoned };

      // when it closes completely everyone burns: the healthiest ship is the last one flying
      g.ships.forEach((s) => { if (s !== p && !s.gone) s.hp = 1; });
      g.raceTime = C.ZONE_GRACE + C.ZONE_SHRINK;
      T.run(0.5);
      out.end = { over: g.over, done: g.playerDone, place: p.place, alive: g.ships.filter((s) => !s.gone).length, wins: g.prog.wins, pts: g.reward.pts };
      out.order = g.order.map((s) => s.place).join('');
      return out;
    });
    assert.deepStrictEqual(r.start, { whole: true, alive: 6 });
    assert.deepStrictEqual(r.kill, { kills: 1, gone: true, place: 6, over: false });
    assert.deepStrictEqual(r.zone, { half: true, burned: true, zoned: true, inside: true });
    assert.deepStrictEqual(r.end, { over: true, done: true, place: 1, alive: 1, wins: 1, pts: 4 });
    assert.strictEqual(r.order, '123456');
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('rivals fight both combat modes to a finish in every arena', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const results = await page.evaluate(() => {
      const g = RR.game, out = [];
      for (let mode = 1; mode <= 2; mode++) {
        for (let a = 0; a < RR.ARENAS.length; a++) {
          g.modeIdx = mode; g.arenaIdx = a; g.startRace(false); g.state = 'play';
          g.player.ai = T.ai();
          let n = 0; while (!g.over && n++ < 120 * 400) g.step(1 / 120);
          out.push({
            what: RR.MODES[mode].name + ' / ' + g.track.name, over: g.over, secs: Math.round(g.endT),
            kills: g.ships.reduce((k, s) => k + s.kills, 0), alive: g.ships.filter((s) => !s.gone).length,
            placed: g.order.map((s) => s.place).join(''), inArena: g.ships.every((s) => s.gone || Math.hypot(s.x - g.track.center.x, s.y - g.track.center.y) < g.track.radius * 1.6),
          });
        }
      }
      return out;
    });
    for (const r of results) {
      assert.ok(r.over, r.what + ': not over after 400 s');
      assert.ok(r.kills >= 1, r.what + ': nobody was wrecked');
      assert.strictEqual(r.placed, '123456', r.what);
      assert.ok(r.inArena, r.what + ': a ship left the arena');
      if (/ROYALE/.test(r.what)) assert.ok(r.alive <= 1, r.what + ': ' + r.alive + ' ships still flying');
      else assert.ok(r.secs <= 181, r.what + ': ran past the time limit');
    }
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

/* ---------------------------------------------------------------- sound */

/** A phone-like page: touch screen, and a browser that refuses sound until a gesture. */
async function openPhone(strict, viewport) {
  const ctx = await strict.newContext({ viewport: viewport || { width: 390, height: 760 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  // Chromium has no Audio Session API (Safari's switch between "background sound" and "media playback"): stand one in
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'audioSession', { value: { type: 'auto' }, configurable: true }); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/');
  await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
  const box = await page.locator('#hud').boundingBox();
  // a spot on the title screen with no button under it (the logo)
  const tapEmpty = () => page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.12);
  return { ctx, page, errors, tapEmpty };
}

test('sound: the first tap on a phone starts it, as media playback so the iPhone silent switch does not mute it', { skip }, async () => {
  const strict = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
  try {
    const { page, errors, tapEmpty } = await openPhone(strict);
    const before = await page.evaluate(() => RR.audio.state());
    assert.ok(before === 'none' || before === 'suspended', 'silent until a gesture: ' + before);
    await tapEmpty();
    await page.waitForFunction(() => RR.audio.state() === 'running', null, { timeout: 5000 });
    const r = await page.evaluate(() => {
      const n = RR.audio.played;
      RR.audio.sfx('select');
      return { session: navigator.audioSession.type, played: RR.audio.played - n };
    });
    assert.strictEqual(r.session, 'playback');
    assert.strictEqual(r.played, 1, 'a sound effect actually starts');
    assert.deepStrictEqual(errors, []);
  } finally { await strict.close(); }
});

test('sound: if iOS leaves the audio stuck ("interrupted"), a tap resumes it, and a fresh context replaces one that stays stuck', { skip }, async () => {
  const strict = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
  try {
    const { page, errors, tapEmpty } = await openPhone(strict);
    await tapEmpty();
    await page.waitForFunction(() => RR.audio.state() === 'running', null, { timeout: 5000 });
    await page.waitForTimeout(600);
    // play a sound on the old context, then make that context behave like a stuck iPhone one:
    // it reports "interrupted" and its resume() does nothing
    await page.evaluate(() => {
      RR.audio.sfx('select');
      const c = RR.audio._ctx();
      window.__stuck = { c, resumes: 0 };
      Object.defineProperty(c, 'state', { get: () => 'interrupted', configurable: true });
      c.resume = () => { window.__stuck.resumes++; return Promise.resolve(); };
    });
    assert.strictEqual(await page.evaluate(() => RR.audio.state()), 'interrupted');

    await tapEmpty(); // first tap: try to resume the context we have
    const first = await page.evaluate(() => ({ resumes: __stuck.resumes, same: RR.audio._ctx() === __stuck.c, rebuilds: RR.audio.rebuilds }));
    assert.ok(first.resumes >= 1, 'the tap asked the context to resume');
    assert.deepStrictEqual([first.same, first.rebuilds], [true, 0], 'not replaced straight away');

    await page.waitForTimeout(1700);
    await tapEmpty(); // still stuck well after a tap: start fresh
    await page.waitForFunction(() => RR.audio._ctx() !== __stuck.c && RR.audio.state() === 'running', null, { timeout: 5000 });
    const after = await page.evaluate(() => {
      const n = RR.audio.played;
      RR.audio.sfx('select'); // the same effect played on the old context: must not be held back by its clock
      return { rebuilds: RR.audio.rebuilds, played: RR.audio.played - n, old: __stuck.c.state };
    });
    assert.strictEqual(after.rebuilds, 1);
    assert.strictEqual(after.played, 1, 'sound effects play on the fresh context');
    assert.deepStrictEqual(errors, []);
  } finally { await strict.close(); }
});

test('sound: touch players can switch it off and on, and the choice is remembered', { skip }, async () => {
  const strict = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
  try {
    const { page, errors } = await openPhone(strict);
    const box = await page.locator('#hud').boundingBox();
    const tapButton = async (label) => {
      const u = await page.evaluate((l) => RR.game.ui.find((b) => b.label === l) || null, label);
      assert.ok(u, 'a "' + label + '" button is on screen');
      const W = await page.evaluate(() => RR.game.W);
      const k = box.width / W;
      await page.touchscreen.tap(box.x + (u.x + u.w / 2) * k, box.y + (u.y + u.h / 2) * k);
      await page.waitForTimeout(150);
    };
    const muted = () => page.evaluate(() => ({ live: RR.audio.muted, saved: JSON.parse(localStorage.getItem('rocketracer.v1')).muted }));

    await tapButton('SOUND ON');
    assert.deepStrictEqual(await muted(), { live: true, saved: true });
    await tapButton('SOUND OFF');
    assert.deepStrictEqual(await muted(), { live: false, saved: false });
    await tapButton('SOUND ON');
    await page.reload();
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => RR.audio.muted), true, 'still off after a reload');
    // and it is in the pause menu too
    await page.evaluate(() => { RR.game.begin(); RR.game.pause(); });
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => RR.game.ui.some((b) => b.label === 'SOUND OFF')), 'pause menu has the switch');
    assert.deepStrictEqual(errors, []);
  } finally { await strict.close(); }
});

/* ----------------------------------------------------------- full screen */

/** A human-speed tap through the browser's touch input: finger down, ~150 ms, finger up. */
async function humanTap(page, cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(150);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
}

test('full screen: a phone goes full screen on its first tap and at each race start, asking as the finger lifts; the button turns it off for good', { skip }, async () => {
  const strict = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
  try {
    const { ctx, page, errors } = await openPhone(strict);
    const cdp = await ctx.newCDPSession(page);
    const box = await page.locator('#hud').boundingBox();
    const k = box.width / await page.evaluate(() => RR.game.W);
    const spot = (u) => [box.x + (u.x + u.w / 2) * k, box.y + (u.y + u.h / 2) * k];
    const find = (src) => page.evaluate((f) => RR.game.ui.find(eval(f)) || null, src);
    const tapLabel = async (label) => {
      const u = await find('(b) => b.label === ' + JSON.stringify(label));
      assert.ok(u, 'a "' + label + '" button is on screen');
      await humanTap(page, cdp, ...spot(u));
    };
    const tapRace = async () => humanTap(page, cdp, ...spot(await find('(b) => b.h === 25 && b.w >= 100'))); // TAP TO RACE
    const tapEmpty = () => humanTap(page, cdp, box.x + box.width / 2, box.y + box.height * 0.12);
    const full = () => page.evaluate(() => !!document.fullscreenElement);
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('rocketracer.v1')).autoFull);

    // note which event each full-screen request is made from
    await page.evaluate(() => {
      window.__fsFrom = [];
      const el = document.documentElement, ask = el.requestFullscreen.bind(el);
      el.requestFullscreen = (o) => { window.__fsFrom.push(window.event ? window.event.type : 'no event'); return ask(o); };
    });

    assert.strictEqual(await full(), false, 'not before any tap');
    await tapEmpty();
    assert.strictEqual(await full(), true, 'the first tap goes full screen');

    await page.evaluate(() => document.exitFullscreen()); // the player swipes back out of full screen
    await tapEmpty();
    assert.strictEqual(await full(), false, 'an ordinary tap leaves that alone');
    await tapRace();
    assert.deepStrictEqual([await full(), await page.evaluate(() => RR.game.state)], [true, 'play'], 'starting a race goes full screen again');

    await page.evaluate(() => RR.game.toTitle());
    await page.waitForTimeout(150);
    await tapLabel('EXIT FULL');
    assert.deepStrictEqual([await full(), await saved()], [false, false], 'the button leaves full screen and remembers');
    await tapRace();
    assert.strictEqual(await full(), false, 'and races then stay windowed');

    await page.evaluate(() => RR.game.toTitle());
    await page.waitForTimeout(150);
    await tapLabel('FULLSCREEN');
    assert.deepStrictEqual([await full(), await saved()], [true, true], 'and back on again');

    const from = await page.evaluate(() => window.__fsFrom);
    assert.ok(from.length >= 3, 'requests were made: ' + from);
    assert.ok(from.every((t) => t === 'pointerup' || t === 'touchend' || t === 'click'), 'only ever asked as a finger lifts: ' + from);
    assert.deepStrictEqual(errors, []);
  } finally { await strict.close(); }
});

test('full screen: desktops are left alone, and iPhones (which cannot) get the Add to Home Screen tip instead', { skip }, async () => {
  // desktop: clicking around never goes full screen by itself
  const { page, ctx, errors } = await openGame();
  try {
    await page.mouse.click(640, 80);
    await page.waitForTimeout(300);
    assert.strictEqual(await page.evaluate(() => !!document.fullscreenElement), false);
    assert.strictEqual(await page.evaluate(() => RR.game.homeScreenTip()), false);
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }

  // iPhone Safari: no Fullscreen API for pages
  const iphone = { viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
  const noFullscreen = () => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false, configurable: true });
  };
  for (const installed of [false, true]) {
    const c = await browser.newContext(iphone);
    await c.addInitScript(noFullscreen);
    if (installed) await c.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true }));
    const p = await c.newPage();
    try {
      await p.goto(base + '/');
      await p.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
      await p.waitForTimeout(300);
      const r = await p.evaluate(() => ({ tip: RR.game.homeScreenTip(), button: RR.game.ui.some((b) => b.label === 'FULLSCREEN' || b.label === 'EXIT FULL') }));
      assert.deepStrictEqual(r, { tip: !installed, button: false }, installed ? 'opened from the home screen: no tip' : 'in Safari: the tip, and no button that cannot work');
    } finally { await c.close(); }
  }
});

test('full screen: iPads skip Safari\'s full screen (a downward swipe, which steering makes, drops out of it) and get the Add to Home Screen tip; Macs keep it', { skip }, async () => {
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const kinds = [
    // iPadOS Safari asks for desktop sites as a Mac, so only the touch points tell it apart
    { what: 'an iPad (desktop-site mode)', ua: MAC, touchPoints: 5, ipad: true },
    { what: 'an iPad', ua: IPAD, touchPoints: 5, ipad: true },
    { what: 'a Mac', ua: MAC, touchPoints: 0, ipad: false },
  ];
  for (const k of kinds) {
    const c = await browser.newContext(k.ipad
      ? { viewport: { width: 1194, height: 834 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: k.ua }
      : { viewport: { width: 1280, height: 720 }, userAgent: k.ua });
    await c.addInitScript((n) => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => n, configurable: true }), k.touchPoints);
    const p = await c.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.stack || e.message));
    try {
      await p.goto(base + '/');
      await p.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
      // the page's own Fullscreen API is there (as it is in iPad Safari): the game must choose not to use it
      assert.strictEqual(await p.evaluate(() => document.fullscreenEnabled), true);
      await p.waitForTimeout(200);
      const r = await p.evaluate(() => ({ can: RR.game.canFullscreen(), tip: RR.game.homeScreenTip(), button: RR.game.ui.some((b) => b.label === 'FULLSCREEN' || b.label === 'EXIT FULL') }));
      if (!k.ipad) {
        assert.deepStrictEqual(r, { can: true, tip: false, button: false }, k.what + ': full screen stays available (F)');
        await p.keyboard.press('KeyF');
        await p.waitForTimeout(200);
        assert.strictEqual(await p.evaluate(() => !!document.fullscreenElement), true, k.what + ': F goes full screen');
        continue;
      }
      assert.deepStrictEqual(r, { can: false, tip: true, button: false }, k.what + ': the tip, and no FULLSCREEN button');
      const box = await p.locator('#hud').boundingBox();
      await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.12); // the first tap would go full screen elsewhere
      await p.waitForTimeout(200);
      assert.strictEqual(await p.evaluate(() => !!document.fullscreenElement), false, k.what + ': a tap leaves the page as it is');
      await p.evaluate(() => { RR.game.autoFull = true; RR.game.wantFull = false; RR.game.begin(); });
      await p.touchscreen.tap(box.x + 40, box.y + 200);
      await p.waitForTimeout(200);
      assert.strictEqual(await p.evaluate(() => !!document.fullscreenElement), false, k.what + ': and so does starting a race');
      await p.keyboard.press('KeyF');
      await p.waitForTimeout(100);
      assert.deepStrictEqual(await p.evaluate(() => [!!document.fullscreenElement, RR.game.toast && RR.game.toast.text]), [false, 'SHARE > ADD TO HOME SCREEN'], k.what + ': F on its keyboard says how');
      assert.deepStrictEqual(errors, []);
    } finally { await c.close(); }
  }
});

test('iPhone Home Screen app: the page is made screen-tall (iOS 26 cut off the bottom otherwise) without ever scrolling, and the game refits when the window changes size unannounced', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 }); // an iPhone 17 Pro
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  try {
    await page.goto(base + '/');
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    // the rule, as written in style.css: only for an installed app (standalone or fullscreen display)
    const rule = await page.evaluate(() => {
      for (const sh of document.styleSheets) for (const r of sh.cssRules) {
        if (r.media && /display-mode: standalone/.test(r.media.mediaText)) return { media: r.media.mediaText, css: r.cssRules[0].cssText };
      }
      return null;
    });
    assert.ok(rule && /fullscreen/.test(rule.media), 'a rule for installed apps: ' + JSON.stringify(rule));
    assert.match(rule.css, /^html \{ min-height: min\(100lvh, calc\(100% \+ env\(safe-area-inset-top, 0px\)\)\); \}$/);
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.documentElement).minHeight), '0px', 'off in a browser tab');

    // applied (Chrome can't pretend to be an installed app), with the iPhone's status bar and home indicator insets
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 62, topMax: 62, bottom: 34, bottomMax: 34 } });
    await page.evaluate((css) => { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); }, rule.css);
    await page.waitForTimeout(200);
    const on = await page.evaluate(() => ({ h: document.documentElement.getBoundingClientRect().height, sh: document.documentElement.scrollHeight, ih: innerHeight }));
    assert.strictEqual(on.h, 874, 'the page is the screen\'s height, and capped there: ' + on.h);
    assert.strictEqual(on.sh, on.ih, 'the page never grows past the screen, so it cannot scroll');
    await page.mouse.wheel(0, 400);
    await page.evaluate(() => window.scrollTo(0, 500));
    assert.strictEqual(await page.evaluate(() => window.scrollY), 0, 'and does not scroll');
    const fit = await page.evaluate(() => ({ H: RR.game.H, base: RR.game.baseScale, inset: RR.game.inset.b, cssH: parseFloat(document.getElementById('hud').style.height) }));
    assert.ok(fit.cssH >= 874 - fit.base / 3 && fit.cssH <= 874 + fit.base / 3, 'the game fills the screen top to bottom: ' + fit.cssH);
    assert.ok(fit.inset > 0, 'and keeps its controls above the home indicator');

    // iOS can change the window's size with no resize event: the game notices on its own
    const before = await page.evaluate(() => RR.game.H);
    await page.evaluate(() => Object.defineProperty(window, 'innerHeight', { get: () => 812, configurable: true }));
    await page.waitForFunction((h) => RR.game.H < h, before, { timeout: 2000 });
    const after = await page.evaluate(() => ({ H: RR.game.H, cssH: parseFloat(document.getElementById('hud').style.height) }));
    assert.ok(Math.abs(after.cssH - 812) < 2, 'refitted to the new height: ' + after.cssH);
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

/* --------------------------------------------------------- touch sticks */

/** A phone (or a tablet, given its screen size) with a race under way, and helpers to put thumbs on the screen (game-pixel coordinates). */
async function phoneRace(viewport) {
  const { ctx, page, errors } = await openPhone(browser, viewport);
  await page.evaluate(() => {
    const g = RR.game;
    g.autoFull = false; g.wantFull = false; // keep the page still for these tests
    g.begin();
    for (let i = 0; i < 120 * 4.3; i++) g.step(1 / 120); // past the countdown
  });
  const cdp = await ctx.newCDPSession(page);
  const box = await page.locator('#hud').boundingBox();
  const k = box.width / await page.evaluate(() => RR.game.W);
  const pts = (list) => list.map((q, i) => ({ x: box.x + q[0] * k, y: box.y + q[1] * k, id: i + 1 }));
  return {
    ctx, page, errors,
    layout: () => page.evaluate(() => RR.touchLayout(RR.game.W, RR.game.H, RR.game.inset)),
    down: (...list) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(list) }),
    move: (...list) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(list) }),
    up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    tapLabel: async (label) => {
      const u = await page.evaluate((l) => RR.game.ui.find((b) => b.label === l) || null, label);
      assert.ok(u, 'a "' + label + '" button is on screen');
      await page.touchscreen.tap(box.x + (u.x + u.w / 2) * k, box.y + (u.y + u.h / 2) * k);
      await page.waitForTimeout(200);
    },
  };
}
const angleGap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

test('touch: dragging from anywhere steers that way, and the farther the drag the more power, up to a maximum', { skip }, async () => {
  const ph = await phoneRace();
  try {
    const { W, H, DEAD, MAX } = await ph.page.evaluate(() => ({ W: RR.game.W, H: RR.game.H, DEAD: RR.input.DRAG_DEAD, MAX: RR.input.DRAG_MAX }));
    const drag = () => ph.page.evaluate(() => { const d = RR.input.touch.drag; return d && { x: d.x, y: d.y, dist: d.dist, power: d.power, ang: d.ang, max: d.max }; });
    const ship = () => ph.page.evaluate(() => { const p = RR.game.player; return { angle: p.angle, speed: Math.hypot(p.vx, p.vy), thrust: RR.input.read(p).thrust, burning: p.thrusting }; });
    const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b);

    // two quite different starting points: the open middle of the screen, and up in a corner
    for (const [sx, sy] of [[Math.round(W * 0.4), Math.round(H * 0.5)], [30, 60]]) {
      await ph.page.evaluate(() => { const p = RR.game.player; p.vx = p.vy = 0; p.angle = 0; p.angVel = 0; });
      await ph.down([sx, sy]);
      await ph.page.waitForTimeout(120);
      let d = await drag(), sh = await ship();
      assert.ok(d, 'a touch at ' + [sx, sy] + ' starts a drag');
      assert.deepStrictEqual([d.x, d.y, d.power], [sx, sy, 0], 'it starts where the thumb landed, with no power');
      assert.deepStrictEqual([sh.thrust, sh.burning], [0, 0], 'so a tap alone burns nothing');

      await ph.move([sx, sy + 31]); // straight down, about half way
      await ph.page.waitForTimeout(700);
      d = await drag(); sh = await ship();
      near(d.power, (31 - DEAD) / (MAX - DEAD), 0.01, 'power follows the distance');
      near(d.ang, Math.PI / 2, 0.02, 'pointing down');
      near(sh.thrust, d.power, 0.001, 'the engine runs at that power');
      near(sh.burning, d.power, 0.001, 'and the rocket burns at it');
      assert.ok(angleGap(sh.angle, Math.PI / 2) < 0.3, 'the rocket turned to face down: ' + sh.angle);
      const half = sh.speed;

      await ph.move([sx, sy + MAX]); // exactly at the limit
      await ph.page.waitForTimeout(100);
      d = await drag();
      near(d.power, 1, 0.001, 'full power at the limit');
      assert.deepStrictEqual([d.x, d.y], [sx, sy], 'the starting point has not moved yet');

      await ph.move([sx, sy + MAX + 50]); // well past it
      await ph.page.waitForTimeout(900);
      d = await drag(); sh = await ship();
      assert.strictEqual(d.power, 1, 'never more than full');
      near(d.dist, MAX, 0.01, 'capped at the limit');
      near(d.y, sy + 50, 0.5, 'past the limit the starting point trails the thumb');
      assert.ok(sh.speed > half * 1.3, 'more power, more speed: ' + Math.round(half) + ' -> ' + Math.round(sh.speed));

      await ph.move([sx, sy + MAX + 30]); // ease back 20
      await ph.page.waitForTimeout(100);
      d = await drag();
      near(d.power, (MAX - 20 - DEAD) / (MAX - DEAD), 0.01, 'easing back lowers the power straight away');

      await ph.up();
      await ph.page.waitForTimeout(100);
      assert.strictEqual(await drag(), null, 'lifting the thumb ends it');
      assert.strictEqual((await ship()).thrust, 0);
    }

    // a touch that starts on a button, the brake or the fire stick is not a steering drag
    const L = await ph.layout();
    const zoom = await ph.page.evaluate(() => RR.game.ui.find((b) => b.label === 'ZOOM'));
    for (const [what, x, y] of [['the ZOOM button', zoom.x + zoom.w / 2, zoom.y + zoom.h / 2], ['BRAKE', L.brake.x + 20, L.brake.y + 20], ['the fire stick', L.fire.x, L.fire.y]]) {
      await ph.down([x, y]);
      await ph.page.waitForTimeout(120);
      await ph.move([x - 40, y + 5]);
      await ph.page.waitForTimeout(120);
      assert.strictEqual(await drag(), null, 'starting on ' + what);
      await ph.up();
      await ph.page.waitForTimeout(80);
    }

    // both thumbs at once: one steering, one aiming
    await ph.down([60, 200], [L.fire.x, L.fire.y]);
    await ph.page.waitForTimeout(80);
    await ph.move([60 + MAX, 200], [L.fire.x, L.fire.y - 30]);
    await ph.page.waitForTimeout(150);
    const both = await ph.page.evaluate(() => ({ power: RR.input.touch.drag.power, aim: RR.input.touch.aim, fire: RR.input.touch.fire }));
    assert.deepStrictEqual([both.power, both.fire], [1, true]);
    assert.ok(angleGap(both.aim, -Math.PI / 2) < 0.05, 'aiming up while steering right');
    await ph.up();
    assert.deepStrictEqual(ph.errors, []);
  } finally { await ph.ctx.close(); }
});

test('touch: a power meter appears with the drag, fills as it lengthens, and tops out at MAX; no circle is drawn round the touch', { skip }, async () => {
  const ph = await phoneRace();
  try {
    const { W, H, DEAD, MAX } = await ph.page.evaluate(() => ({ W: RR.game.W, H: RR.game.H, DEAD: RR.input.DRAG_DEAD, MAX: RR.input.DRAG_MAX }));
    // the meter as drawn, plus the colour actually on screen in the middle of each of its segments
    const meter = () => ph.page.evaluate(() => {
      const m = RR.game.meter;
      if (!m) return null;
      const c = document.getElementById('hud').getContext('2d'), hex = (d) => '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      const segs = [];
      for (let i = 0; i < m.of; i++) segs.push(hex(c.getImageData(m.segX + i * m.segStep + 2, m.segY + 3, 1, 1).data));
      return Object.assign({ segs, dark: RR.PAL.dusk }, m);
    });
    const litOnScreen = (m) => m.segs.filter((c) => c !== m.dark).length;

    assert.strictEqual(await meter(), null, 'no meter until the screen is touched');

    for (const [sx, sy] of [[Math.round(W * 0.45), Math.round(H * 0.55)], [24, 40], [W - 30, H - 150]]) {
      await ph.down([sx, sy]);
      await ph.page.waitForTimeout(120);
      let m = await meter();
      assert.ok(m, 'the meter appears on touch at ' + [sx, sy]);
      assert.deepStrictEqual([m.lit, litOnScreen(m), m.full], [0, 0, false], 'empty to begin with');

      // drag out in steps: the meter only ever grows, and matches the distance
      const dir = sy > H / 2 ? -1 : 1; // drag up from low on the screen, down from high
      let last = 0;
      for (const d of [12, 20, 31, 40, 50, MAX]) {
        await ph.move([sx, sy + dir * d]);
        await ph.page.waitForTimeout(90);
        m = await meter();
        const want = Math.max(1, Math.round(((d - DEAD) / (MAX - DEAD)) * m.of));
        assert.strictEqual(m.lit, want, 'at ' + d + ' px the meter reads ' + m.lit + '/' + m.of);
        assert.strictEqual(litOnScreen(m), m.lit, 'and that many segments are lit on screen: ' + m.segs);
        assert.ok(m.lit >= last, 'never falling as the drag lengthens');
        last = m.lit;
      }
      assert.deepStrictEqual([m.lit, m.full], [m.of, true], 'full at the limit');

      // no circle round the touch: the screen to the sides of the drag and behind it is left clear
      // (checked out in the open, where no other part of the HUD is in the way)
      const open = sx > 80 && sx < W - 80 && sy > H * 0.4 && sy < H * 0.6;
      const clear = !open ? [] : await ph.page.evaluate(([x, y, R, dir]) => {
        const c = document.getElementById('hud').getContext('2d'), W = RR.game.W, H = RR.game.H, inked = [];
        for (const r of [R, R * 0.75, R * 0.5, R * 0.25]) {
          for (const a of [0, Math.PI, -dir * Math.PI / 2, -dir * Math.PI / 4, -dir * 3 * Math.PI / 4]) {
            const px = Math.round(x + Math.cos(a) * r), py = Math.round(y + Math.sin(a) * r);
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            if (c.getImageData(px, py, 1, 1).data[3]) inked.push([px, py]);
          }
        }
        return inked;
      }, [sx, sy, MAX, dir]);
      assert.deepStrictEqual(clear, [], 'nothing drawn in a circle round the touch');

      await ph.move([sx, sy + dir * (MAX + 40)]);
      await ph.page.waitForTimeout(90);
      m = await meter();
      assert.deepStrictEqual([m.lit, litOnScreen(m), m.full], [m.of, m.of, true], 'and no more than full past it');
      assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.w <= W && m.y + m.h <= H, 'the meter stays on screen: ' + JSON.stringify([m.x, m.y, m.w, m.h]));

      await ph.move([sx, sy + dir * (MAX + 40 - 28)]); // ease back half way
      await ph.page.waitForTimeout(90);
      m = await meter();
      assert.deepStrictEqual([m.lit, m.full], [Math.round(((MAX - 28 - DEAD) / (MAX - DEAD)) * m.of), false], 'easing back empties it again');

      await ph.up();
      await ph.page.waitForTimeout(120);
      assert.strictEqual(await meter(), null, 'gone when the thumb lifts');
    }
    assert.deepStrictEqual(ph.errors, []);
  } finally { await ph.ctx.close(); }
});

test('touch: the blaster fires all the time the fire stick is held, straight ahead and then the way it is dragged', { skip }, async () => {
  const ph = await phoneRace();
  try {
    const f = (await ph.layout()).fire;
    // note every bolt as it leaves, with the way it went (less the rocket's own drift)
    await ph.page.evaluate(() => {
      const g = RR.game, me = g.player, push = g.shots.push;
      window.fired = [];
      g.shots.push = function (b) {
        if (b.owner === me) window.fired.push({ type: b.type, dir: b.type === 'bolt' ? Math.atan2(b.vy - me.vy * 0.5, b.vx - me.vx * 0.5) : b.angle, target: g.ships.indexOf(b.target), ship: me.angle });
        return push.apply(this, arguments);
      };
      me.weapon = 'blaster'; me.ammo = 999; me.angle = -Math.PI / 2; me.angVel = 0; me.vx = me.vy = 0;
    });
    const fired = () => ph.page.evaluate(() => window.fired.slice());
    const shown = () => ph.page.evaluate(() => RR.game.aimShown);

    await ph.down([f.x + 1, f.y + 1]); // pressed and held, not dragged
    await ph.page.waitForTimeout(500);
    let b = await fired();
    assert.ok(b.length >= 3, 'automatic: it keeps firing while held (' + b.length + ' shots)');
    for (const x of b) assert.ok(angleGap(x.dir, x.ship) < 0.1, 'straight ahead while not dragged: ' + x.dir + ' vs ' + x.ship);
    assert.strictEqual(await shown(), null, 'no aim line while firing straight ahead');

    await ph.move([f.x - 30, f.y + 30]); // then dragged down and to the left, still held
    await ph.page.waitForTimeout(800); // (one shot every 0.13 s: room for several after the two the drag overlaps)
    const after = (await fired()).slice(b.length + 2);
    assert.ok(after.length >= 2, 'still firing after the drag');
    for (const x of after) {
      assert.ok(angleGap(x.dir, 3 * Math.PI / 4) < 0.1, 'the blasts go down-left: ' + x.dir);
      assert.ok(angleGap(x.ship, -Math.PI / 2) < 0.2, 'while the rocket still points up');
    }
    const line = await shown();
    assert.ok(line && line.weapon === 'blaster' && angleGap(line.ang, 3 * Math.PI / 4) < 0.05, 'a dashed aim line points down-left: ' + JSON.stringify(line));

    await ph.up();
    await ph.page.waitForTimeout(150);
    const n = (await fired()).length;
    await ph.page.waitForTimeout(400);
    assert.strictEqual((await fired()).length, n, 'and stops when let go');
    assert.strictEqual(await shown(), null, 'the aim line goes with it');
    assert.deepStrictEqual(ph.errors, []);
  } finally { await ph.ctx.close(); }
});

test('touch: missiles are aimed with a drag on the fire stick and launch on letting go; mines drop at once; keys still fire at once', { skip }, async () => {
  const ph = await phoneRace();
  try {
    const f = (await ph.layout()).fire;
    // a rival to the right and one straight ahead; the rest out of the way
    const setup = (weapon, ammo) => ph.page.evaluate(([weapon, ammo]) => {
      const g = RR.game, me = g.player, push = g.shots.push;
      if (!window.fired) {
        window.fired = [];
        g.shots.push = function (b) {
          if (b.owner === me) window.fired.push({ type: b.type, dir: b.angle, target: g.ships.indexOf(b.target), ship: me.angle });
          return push.apply(this, arguments);
        };
      }
      window.fired.length = 0;
      me.weapon = weapon; me.ammo = ammo; me.cool = 0; me.angle = -Math.PI / 2; me.angVel = 0; me.vx = me.vy = 0;
      const others = g.ships.filter((o) => o !== me);
      others.forEach((o, i) => { o.vx = o.vy = 0; o.dead = i < 2 ? 0 : 100; });
      Object.assign(others[0], { x: me.x + 230, y: me.y }); // right
      Object.assign(others[1], { x: me.x, y: me.y - 230 }); // ahead
      return { right: g.ships.indexOf(others[0]), ahead: g.ships.indexOf(others[1]) };
    }, [weapon, ammo]);
    const st = () => ph.page.evaluate(() => ({ fired: window.fired.slice(), ammo: RR.game.player.ammo, shown: RR.game.aimShown }));

    // hold: nothing launches, and the line shows straight ahead, locked onto the rival there
    let who = await setup('missile', 2);
    await ph.down([f.x, f.y]);
    await ph.page.waitForTimeout(350);
    let r = await st();
    assert.deepStrictEqual([r.fired.length, r.ammo], [0, 2], 'holding the stick does not launch');
    assert.ok(r.shown && r.shown.weapon === 'missile' && angleGap(r.shown.ang, -Math.PI / 2) < 0.05, 'aim line straight ahead: ' + JSON.stringify(r.shown));
    assert.strictEqual(r.shown.lock, who.ahead, 'marked: the rival ahead');

    // drag right: still nothing, the line and the lock swing round
    await ph.move([f.x + 32, f.y]);
    await ph.page.waitForTimeout(300);
    r = await st();
    assert.deepStrictEqual([r.fired.length, r.ammo], [0, 2], 'dragging does not launch either');
    assert.ok(angleGap(r.shown.ang, 0) < 0.05, 'aim line to the right: ' + r.shown.ang);
    assert.strictEqual(r.shown.lock, who.right, 'marked: the rival to the right');

    // let go: one missile, to the right, after that rival, though the rocket points up
    await ph.up();
    await ph.page.waitForTimeout(120);
    r = await st();
    assert.strictEqual(r.fired.length, 1, 'letting go launches');
    assert.ok(angleGap(r.fired[0].dir, 0) < 0.05, 'launched to the right: ' + r.fired[0].dir);
    assert.ok(angleGap(r.fired[0].ship, -Math.PI / 2) < 0.1, 'while the rocket points up');
    assert.strictEqual(r.fired[0].target, who.right, 'locked onto the rival it was aimed at');
    assert.strictEqual(r.ammo, 1);
    assert.strictEqual(r.shown, null, 'the aim line is gone');

    // a plain tap (no drag) launches straight ahead
    who = await setup('missile', 2);
    await ph.down([f.x, f.y]);
    await ph.page.waitForTimeout(90);
    await ph.up();
    await ph.page.waitForTimeout(100);
    r = await st();
    assert.strictEqual(r.fired.length, 1, 'a tap launches');
    assert.ok(angleGap(r.fired[0].dir, -Math.PI / 2) < 0.05, 'straight ahead: ' + r.fired[0].dir);
    assert.strictEqual(r.fired[0].target, who.ahead);

    // a second aimed launch let go while the launcher reloads still goes, once it is ready
    await ph.down([f.x, f.y]);
    await ph.page.waitForTimeout(60);
    await ph.move([f.x + 32, f.y]);
    await ph.page.waitForTimeout(60);
    await ph.up();
    await ph.page.waitForTimeout(600);
    r = await st();
    assert.strictEqual(r.fired.length, 2, 'the quick second missile was not lost');
    assert.ok(angleGap(r.fired[1].dir, 0) < 0.05, 'and went the way it was aimed: ' + r.fired[1].dir);
    assert.strictEqual(r.ammo, 0);

    // mines drop as soon as the stick is touched, behind the rocket
    await setup('mine', 1);
    await ph.down([f.x, f.y]);
    await ph.page.waitForTimeout(100);
    const mine = await ph.page.evaluate(() => { const me = RR.game.player, m = RR.game.mines.filter((x) => x.owner === me).pop(); return m && [m.x - me.x, m.y - me.y]; });
    assert.ok(mine, 'the mine dropped while the stick was still held');
    assert.ok(Math.abs(mine[0]) < 4 && Math.abs(mine[1] - 16) < 4, 'behind (below) the rocket: ' + mine);
    await ph.up();

    // with a keyboard, a missile still goes on the key press, straight ahead
    await setup('missile', 1);
    await ph.page.keyboard.down('Space');
    await ph.page.waitForTimeout(100);
    r = await st();
    assert.strictEqual(r.fired.length, 1, 'Space launches at once');
    assert.ok(angleGap(r.fired[0].dir, -Math.PI / 2) < 0.05, 'straight ahead');
    await ph.page.keyboard.up('Space');
    assert.deepStrictEqual(ph.errors, []);
  } finally { await ph.ctx.close(); }
});

test('touch: a steering stick sits bottom left, the fire stick\'s mirror image; pushed, it flies that way with power by how far; drags elsewhere still steer', { skip }, async () => {
  for (const vp of [undefined, { width: 844, height: 390 }]) { // an upright phone, and one held sideways
    const ph = await phoneRace(vp);
    try {
      const { W, H, ins, DEAD } = await ph.page.evaluate(() => ({ W: RR.game.W, H: RR.game.H, ins: RR.game.inset, DEAD: RR.input.STEER_DEAD }));
      const L = await ph.layout(), st = L.steer, f = L.fire;
      assert.deepStrictEqual([st.x - ins.l, st.y, st.r, st.grab], [W - ins.r - f.x, f.y, f.r, f.grab], 'the same size and the same distance from its corner as the fire stick');
      assert.ok(st.x < W / 2 && st.y > H / 2, 'bottom left');

      const drag = () => ph.page.evaluate(() => {
        const d = RR.input.touch.drag, inp = RR.input.read(RR.game.player);
        return d && { stick: !!d.stick, power: d.power, ang: d.ang, thrust: inp.thrust };
      });
      await ph.down([st.x, st.y]);
      await ph.page.waitForTimeout(80);
      let d = await drag();
      assert.deepStrictEqual([d.stick, d.power, d.thrust], [true, 0, 0], 'touched in the middle: the stick, no power yet');
      await ph.move([st.x, st.y - st.r / 2]); // half way up
      await ph.page.waitForTimeout(80);
      d = await drag();
      assert.ok(Math.abs(d.power - (0.5 - DEAD) / (1 - DEAD)) < 0.03, 'half pushed, part power: ' + d.power);
      assert.ok(angleGap(d.ang, -Math.PI / 2) < 0.03 && Math.abs(d.thrust - d.power) < 1e-9, 'heading up, engine at that power');
      await ph.move([st.x + st.r + 30, st.y]); // past the rim, to the right
      await ph.page.waitForTimeout(80);
      d = await drag();
      assert.deepStrictEqual([d.power, d.thrust], [1, 1], 'full power at the rim and beyond');
      assert.ok(angleGap(d.ang, 0) < 0.03, 'heading right');
      // held: the rocket turns to face the way it is pushed
      await ph.page.evaluate(() => { const p = RR.game.player; p.angle = Math.PI / 2; p.angVel = 0; });
      await ph.page.waitForTimeout(700);
      assert.ok(angleGap(await ph.page.evaluate(() => RR.game.player.angle), 0) < 0.3, 'the rocket turned to the right');
      await ph.up();
      await ph.page.waitForTimeout(80);
      assert.strictEqual(await drag(), null, 'let go: nothing');

      // a drag anywhere else still steers, as before
      await ph.down([Math.round(W * 0.5), Math.round(H * 0.4)]);
      await ph.page.waitForTimeout(60);
      await ph.move([Math.round(W * 0.5) + 40, Math.round(H * 0.4)]);
      await ph.page.waitForTimeout(80);
      d = await drag();
      assert.ok(d && !d.stick && d.power > 0.5, 'a drag in the open still flies: ' + JSON.stringify(d));
      await ph.up();
      assert.deepStrictEqual(ph.errors, []);
    } finally { await ph.ctx.close(); }
  }
});

test('touch: Pause > MOVE CONTROLS drags the controls to new spots, keeps them, and RESET puts them back', { skip }, async () => {
  const ph = await phoneRace();
  try {
    const before = await ph.layout();
    await ph.page.evaluate(() => RR.game.pause());
    await ph.page.waitForTimeout(150);
    await ph.tapLabel('MOVE CONTROLS');
    assert.strictEqual(await ph.page.evaluate(() => RR.game.state), 'layout');

    const c = before.fire;
    await ph.down([c.x, c.y]);
    await ph.page.waitForTimeout(60);
    await ph.move([c.x - 30, c.y - 45]);
    await ph.page.waitForTimeout(60);
    await ph.move([c.x - 60, c.y - 90]);
    await ph.page.waitForTimeout(150);
    await ph.up();
    const moved = await ph.layout();
    assert.deepStrictEqual([moved.fire.x, moved.fire.y], [c.x - 60, c.y - 90], 'the fire stick moved with the drag');
    assert.deepStrictEqual([moved.brake.x, moved.brake.y], [before.brake.x, before.brake.y], 'nothing else moved');
    assert.deepStrictEqual([moved.steer.x, moved.steer.y], [before.steer.x, before.steer.y], 'nor the steering stick');

    await ph.tapLabel('DONE');
    const saved = await ph.page.evaluate(() => JSON.parse(localStorage.getItem('rocketracer.v1')).controls);
    assert.strictEqual(await ph.page.evaluate(() => RR.game.state), 'paused');
    assert.ok(saved.port && saved.port.fire, 'saved for an upright phone: ' + JSON.stringify(saved));

    await ph.page.reload();
    await ph.page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    const after = await ph.layout();
    assert.deepStrictEqual([after.fire.x, after.fire.y], [moved.fire.x, moved.fire.y], 'still there after a reload');

    await ph.page.evaluate(() => { const g = RR.game; g.autoFull = false; g.wantFull = false; g.begin(); g.pause(); });
    await ph.page.waitForTimeout(150);
    await ph.tapLabel('MOVE CONTROLS');
    await ph.tapLabel('RESET');
    const reset = await ph.layout();
    assert.deepStrictEqual([reset.fire.x, reset.fire.y], [c.x, c.y], 'back to the standard spot');
    assert.deepStrictEqual(ph.errors, []);
  } finally { await ph.ctx.close(); }
});

test('iPad with a keyboard: keys and touch fly the rocket together or apart; a key clears the touch controls only once the thumbs have left them a while', { skip }, async () => {
  const ph = await phoneRace({ width: 1194, height: 834 }); // an 11-inch iPad, sideways
  try {
    const { page } = ph, wait = (ms) => page.waitForTimeout(ms), kb = page.keyboard;
    const MAX = await page.evaluate(() => RR.input.DRAG_MAX);
    const st = () => page.evaluate(() => {
      const I = RR.input, inp = I.read(RR.game.player), d = I.touch.drag;
      return { touch: I.touchMode, power: d && d.power, ang: d && d.ang, turn: inp.turn, thrust: inp.thrust, fire: inp.fire };
    });
    assert.strictEqual((await st()).touch, true, 'a tablet starts with the touch controls');

    // drag to steer, Space to fire: the drag carries on through the key press
    await ph.down([200, 200]);
    await wait(100);
    await ph.move([200 + MAX + 10, 200]); // past the limit: full power
    await wait(150);
    assert.strictEqual((await st()).power, 1, 'flying with a drag');
    await kb.down('Space');
    await wait(150);
    let s = await st();
    assert.deepStrictEqual([s.touch, s.power, s.thrust, s.fire], [true, 1, 1, true], 'Space fires, and the drag and the touch controls stay');
    await ph.move([210, 200 + MAX + 10]); // the thumb swings round to point down (from where the start point trailed to)
    await wait(150);
    s = await st();
    assert.strictEqual(s.power, 1, 'still steering after the key press');
    assert.ok(angleGap(s.ang, Math.PI / 2) < 0.02, 'and it follows the thumb: ' + s.ang);
    await kb.up('Space');
    await ph.up();

    // arrows to steer, the fire stick to shoot
    const f = (await ph.layout()).fire;
    await kb.down('ArrowLeft');
    await kb.down('ArrowUp');
    await ph.down([f.x, f.y]);
    await wait(150);
    s = await st();
    assert.deepStrictEqual([s.touch, s.turn, s.thrust, s.fire], [true, -1, 1, true], 'keys fly, the stick fires');
    await ph.up();
    await kb.up('ArrowLeft');
    await kb.up('ArrowUp');

    // keys alone just after: the controls stay put (the thumb may be on its way back)
    await kb.down('ArrowUp');
    await wait(100);
    s = await st();
    assert.deepStrictEqual([s.touch, s.thrust], [true, 1]);
    await kb.up('ArrowUp');

    // keys alone once the thumbs have been off the controls a while: keyboard prompts, no touch controls
    await page.evaluate(() => { RR.input.controlAt -= RR.input.KEEP_TOUCH_MS + 1; });
    await kb.down('ArrowUp');
    await wait(100);
    s = await st();
    assert.deepStrictEqual([s.touch, s.thrust], [false, 1], 'the keys take over the screen and still fly');
    await kb.up('ArrowUp');

    // a thumb anywhere brings the touch controls back, and steers straight away
    await ph.down([300, 300]);
    await wait(100);
    await ph.move([300, 300 - MAX - 10]);
    await wait(150);
    s = await st();
    assert.deepStrictEqual([s.touch, s.power, s.thrust], [true, 1, 1], 'touch is back');
    assert.ok(angleGap(s.ang, -Math.PI / 2) < 0.02, 'steering up: ' + s.ang);
    await ph.up();

    // tapping buttons (pause, resume) is not flying with the touch controls: a key right after still clears them
    await page.evaluate(() => { RR.input.controlAt -= RR.input.KEEP_TOUCH_MS + 1; });
    const II = await page.evaluate(() => RR.game.ui.find((u) => u.label === 'II'));
    await ph.down([II.x + II.w / 2, II.y + II.h / 2]); // a thumb resting on the pause button for a few frames
    await wait(120);
    await ph.up();
    await wait(80);
    assert.strictEqual(await page.evaluate(() => RR.game.state), 'paused');
    await ph.tapLabel('RESUME');
    assert.strictEqual(await page.evaluate(() => RR.game.state), 'play');
    await kb.down('ArrowRight');
    await wait(100);
    s = await st();
    assert.deepStrictEqual([s.touch, s.turn], [false, 1]);
    await kb.up('ArrowRight');
    assert.deepStrictEqual(ph.errors, []);
  } finally { await ph.ctx.close(); }
});

test('iPad keyboard: the game holds the keyboard focus, knows keys by the names iPad Safari uses, and keys out-steer a drag or a forgotten touch', { skip }, async () => {
  const ph = await phoneRace({ width: 1194, height: 834 });
  try {
    const { page } = ph, wait = (ms) => page.waitForTimeout(ms);
    const focused = () => page.evaluate(() => document.activeElement && document.activeElement.id);
    const inp = () => page.evaluate(() => RR.input.read(RR.game.player));

    // Safari on an iPad sends a hardware keyboard's keys only to a focused element
    assert.strictEqual(await focused(), 'hud', 'the game has the focus from the start');
    await page.evaluate(() => document.activeElement.blur());
    await ph.down([300, 300]);
    await ph.up();
    await wait(80);
    assert.strictEqual(await focused(), 'hud', 'and a tap takes it back');

    // keys as iPad Safari may name them: no code, UIKit arrow names, or only the old keyCode
    const key = (type, init) => page.evaluate(([type, init]) => {
      const e = new KeyboardEvent(type, Object.assign({ bubbles: true, cancelable: true }, init));
      for (const f of ['keyCode', 'which']) if (init[f] !== undefined) Object.defineProperty(e, f, { value: init[f] });
      document.activeElement.dispatchEvent(e);
    }, [type, init]);
    const cases = [
      [{ key: 'UIKeyInputLeftArrow', code: 'Unidentified', keyCode: 0 }, 'turn', -1],
      [{ key: 'UIKeyInputRightArrow', code: '' }, 'turn', 1],
      [{ key: 'ArrowRight', code: '' }, 'turn', 1],
      [{ key: 'Unidentified', code: '', keyCode: 38 }, 'thrust', 1],
      [{ key: 'UIKeyInputDownArrow', code: 'Unidentified' }, 'brake', 1],
      [{ key: 'a', code: '' }, 'turn', -1],
      [{ key: ' ', code: '' }, 'fire', true],
    ];
    for (const [init, what, want] of cases) {
      await key('keydown', init);
      assert.strictEqual((await inp())[what], want, JSON.stringify(init) + ' down: ' + what);
      await key('keyup', init);
      assert.notStrictEqual((await inp())[what], want, JSON.stringify(init) + ' up: let go');
    }

    // a held turn key out-steers a drag that wants the other way (the drag keeps the engine going)
    await page.evaluate(() => { const p = RR.game.player; p.angle = -Math.PI / 2; p.angVel = 0; }); // nose up
    const MAX = await page.evaluate(() => RR.input.DRAG_MAX);
    await ph.down([300, 300]);
    await wait(80);
    await ph.move([300 + MAX + 10, 300]); // drag right: the drag alone turns right
    await wait(60);
    await page.evaluate(() => { const p = RR.game.player; p.angle = -Math.PI / 2; p.angVel = 0; });
    let r = await inp();
    assert.deepStrictEqual([r.turn, r.thrust], [1, 1], 'the drag turns right');
    await page.keyboard.down('ArrowLeft');
    await wait(60);
    await page.evaluate(() => { const p = RR.game.player; p.angle = -Math.PI / 2; p.angVel = 0; });
    r = await inp();
    assert.deepStrictEqual([r.turn, r.thrust], [-1, 1], 'the key turns left, and the drag still drives');
    await page.keyboard.up('ArrowLeft');
    await ph.up();
    await wait(80);

    // a touch whose lift never arrived (a system gesture took it) is cleared once every finger is off
    await page.evaluate(() => { RR.input.pointers[777] = { x: 200 + RR.input.DRAG_MAX, y: 200, sx: 200, sy: 200, role: 'steer', touch: true }; });
    await wait(60);
    assert.ok(await page.evaluate(() => RR.input.touch.drag && RR.input.touch.drag.power === 1), 'the stuck touch is steering');
    await ph.down([500, 300]);
    await ph.up();
    await wait(60);
    assert.deepStrictEqual(await page.evaluate(() => [777 in RR.input.pointers, RR.input.touch.drag]), [false, null], 'gone after the next touch ends');

    // typing a pilot name takes the keys; closing the box gives them back to the game
    await page.evaluate(() => { RR.game.toTitle(); RR.game.editName(); });
    assert.strictEqual(await focused(), 'pilot');
    await page.evaluate(() => RR.game.closeName(false));
    assert.strictEqual(await focused(), 'hud');
    assert.deepStrictEqual(ph.errors, []);
  } finally { await ph.ctx.close(); }
});
