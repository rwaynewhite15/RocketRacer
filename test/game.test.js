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
  await page.evaluate(() => {
    const g = RR.game, S = 1 / 120;
    window.T = {
      // a rival's brain, to fly the player's ship
      ai: () => ({ skill: 0.97, aggro: 1, rubber: 0, margin: 6, ox: 0, oy: 0, cpFor: -1, pick: null, pickT: 0, stuck: 0, stuckN: 0, rev: 0, revTurn: 1, fireT: 9 }),
      run(sec, each) { for (let i = 0; i < Math.round(sec * 120); i++) { g.step(S); if (each) each(); } },
      fresh(track) { g.trackIdx = track; g.startRace(false); g.player.ai = T.ai(); g.state = 'play'; T.run(4.2); }, // past the countdown
    };
  });
  return { page, ctx, errors };
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

test('do-over: goes back about 3 s, un-flies a gate, and the race clock keeps running', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, S = 1 / 120, out = {};

      // A: where the ship lands, and what it gets back. Rewind 1.2 s after
      // flying through the second gate, so the 3 s window always contains a
      // gate (a fixed race time did not: the AI's random lines vary per run).
      T.fresh(0);
      const p = g.player, log = [];
      const rec = () => log.push({ t: g.raceTime, x: p.x, y: p.y, cp: p.cpCount });
      let n = 0;
      while (p.cpCount < 2 && n++ < 120 * 60) { g.step(S); rec(); }
      T.run(1.2, rec);
      p.rewind = 1;
      const before = { t: g.raceTime, cp: p.cpCount };
      out.historySecs = (p.hist.length - 1) * 0.05;
      const want = log.find((e) => e.t >= before.t - 3.0);
      g.tryRewind();
      out.started = { rw: !!p.rw, charge: p.rewind };
      n = 0;
      while (p.rw && n++ < 120 * 3) g.step(S);
      out.A = {
        dist: Math.hypot(p.x - want.x, p.y - want.y), cp: p.cpCount, wantCp: want.cp, beforeCp: before.cp,
        alive: p.dead === 0, invuln: p.invuln, clock: g.raceTime - before.t, speed: Math.hypot(p.vx, p.vy),
      };

      // B: a gate flown through inside the window counts again once re-flown
      T.fresh(0);
      const q = g.player, k0 = q.cpCount;
      n = 0; while (q.cpCount === k0 && n++ < 120 * 60) g.step(S);
      const passed = q.cpCount;
      T.run(1.4);
      q.rewind = 1; g.tryRewind();
      n = 0; while (q.rw && n++ < 120 * 3) g.step(S);
      out.B = { passed, after: q.cpCount };
      n = 0; while (q.cpCount < passed && n++ < 120 * 30) g.step(S);
      out.B.reflown = q.cpCount;
      return out;
    });
    assert.ok(r.historySecs > 2.9, 'a full 3 s of history was recorded: ' + r.historySecs);
    assert.deepStrictEqual(r.started, { rw: true, charge: 0 });
    assert.ok(r.A.dist < 40, 'lands on the recorded path, ' + Math.round(r.A.dist) + ' px off');
    assert.strictEqual(r.A.cp, r.A.wantCp, 'gate progress is what it was 3 s ago');
    assert.ok(r.A.beforeCp > r.A.cp, 'the test window really contained a gate');
    assert.ok(r.A.alive && r.A.invuln > 1.9, 'alive and protected');
    assert.ok(r.A.speed > 50, 'keeps flying');
    assert.ok(r.A.clock > 0.8 && r.A.clock < 1.1, 'the race clock kept running: ' + r.A.clock);
    assert.ok(r.B.after < r.B.passed, 'gate is un-flown');
    assert.ok(r.B.reflown >= r.B.passed, 'and counts again when re-flown');
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

test('do-over: undoes a wreck', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, w = (T.fresh(0), g.player);
      T.run(9);
      w.rewind = 1; w.ai = null; // hands off: fly straight into a planet at speed
      const pl = g.track.planets[0];
      w.x = pl.x; w.y = pl.y - pl.r - 140; w.vx = 0; w.vy = 520; w.angle = Math.PI / 2; w.hp = 20;
      T.run(0.9);
      const wrecked = { dead: w.dead > 0 && w.dead < 5, hp: w.hp };
      g.tryRewind();
      let n = 0; while (w.rw && n++ < 120 * 3) g.step(1 / 120);
      return { wrecked, alive: w.dead === 0, hp: w.hp, clearOfPlanet: Math.hypot(w.x - pl.x, w.y - pl.y) - pl.r };
    });
    assert.deepStrictEqual(r.wrecked, { dead: true, hp: 0 });
    assert.ok(r.alive, 'back in the race');
    assert.ok(r.hp > 50, 'with the hull it had before');
    assert.ok(r.clearOfPlanet > 100, 'and away from the planet');
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});

test('do-over: needs history, one at a time, humans only, not during the countdown', { skip }, async () => {
  const { page, ctx, errors } = await openGame();
  try {
    const r = await page.evaluate(() => {
      const g = RR.game, out = {};

      // right after a rewind there is no history yet: "too soon", and the charge is kept
      T.fresh(0);
      const p = g.player;
      T.run(6);
      p.rewind = 1; g.tryRewind();
      let n = 0; while (p.rw && n++ < 120 * 3) g.step(1 / 120);
      p.rewind = 1; g.tryRewind();
      out.tooSoon = { rw: !!p.rw, charge: p.rewind };

      // capsules: rivals ignore them, the human takes one but not a second
      T.fresh(1);
      const a = g.pickups[0], b = g.pickups[1];
      a.type = b.type = 'rewind'; a.on = b.on = true;
      const rival = g.ships[1]; rival.x = a.x; rival.y = a.y; T.run(0.05);
      out.rivalIgnored = a.on && rival.rewind === 0;
      rival.x = 1e5;
      const me = g.player; me.ai = null; me.x = a.x; me.y = a.y; me.vx = me.vy = 0; T.run(0.05);
      out.tookOne = { charge: me.rewind, gone: !a.on };
      me.x = b.x; me.y = b.y; T.run(0.05);
      out.secondLeft = { charge: me.rewind, stillThere: b.on };

      // not before the lights go green
      g.startRace(false); g.player.rewind = 1; g.tryRewind();
      out.countdown = { rw: !!g.player.rw, charge: g.player.rewind };
      return out;
    });
    assert.deepStrictEqual(r.tooSoon, { rw: false, charge: 1 });
    assert.strictEqual(r.rivalIgnored, true);
    assert.deepStrictEqual(r.tookOne, { charge: 1, gone: true });
    assert.deepStrictEqual(r.secondLeft, { charge: 1, stillThere: true });
    assert.deepStrictEqual(r.countdown, { rw: false, charge: 1 });
    assert.deepStrictEqual(errors, []);
  } finally { await ctx.close(); }
});
