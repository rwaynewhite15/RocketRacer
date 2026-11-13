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
      const tgt = p.rw.tgt, tgtSpeed = Math.hypot(tgt.vx, tgt.vy); // what it was doing 3 s ago
      n = 0;
      while (p.rw && n++ < 120 * 3) g.step(S);
      out.A = {
        dist: Math.hypot(p.x - want.x, p.y - want.y), cp: p.cpCount, wantCp: want.cp, beforeCp: before.cp,
        alive: p.dead === 0, invuln: p.invuln, clock: g.raceTime - before.t, speed: Math.hypot(p.vx, p.vy), tgtSpeed,
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
    // it lands with the velocity it had back then (not always fast: the AI sometimes brakes hard for a gate)
    assert.ok(Math.abs(r.A.speed - r.A.tgtSpeed) < 1, 'keeps the speed it had: ' + r.A.speed + ' vs ' + r.A.tgtSpeed);
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
      g.prog.points = 20; g.prog.wins = 2;
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
    assert.strictEqual(r.left, 17);
    assert.deepStrictEqual(r.back, [true, 5, false]);
    assert.deepStrictEqual(r.open, [true, true, false, false]);
    assert.deepStrictEqual(r.locked, { viewing: 3, flying: 0, spend: false });
    assert.deepStrictEqual(r.flown, { speed: '1.060', hp: 112, rival: 100, design: 0 });

    // progress survives a reload...
    await page.reload();
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    const kept = await page.evaluate(() => ({ p: RR.game.prog, design: RR.game.player.design }));
    assert.deepStrictEqual(kept.p, { wins: 2, points: 20, ship: 1, up: { sparrow: [0, 3, 0, 1, 0], dart: [0, 0, 0, 0, 0], hammer: [0, 0, 0, 0, 0], phoenix: [0, 0, 0, 0, 0] } });
    assert.strictEqual(kept.design, 1, 'the attract mode flies the chosen ship');

    // ...and a doctored save is cut back to what the rules allow
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('rocketracer.v1'));
      s.prog = { wins: 1, points: 2, ship: 3, up: { sparrow: [9, 9, 9, 9, 9], dart: [1, 0, 0, 0, 0] } };
      localStorage.setItem('rocketracer.v1', JSON.stringify(s));
    });
    await page.reload();
    await page.waitForFunction(() => window.RR && RR.game && RR.game.ships.length === 6);
    const fixed = await page.evaluate(() => RR.game.prog);
    assert.strictEqual(fixed.ship, 0, 'cannot fly a locked ship');
    assert.deepStrictEqual(fixed.up.sparrow, [0, 0, 0, 0, 0], 'more upgrades than points: wiped');
    assert.deepStrictEqual(fixed.up.dart, [1, 0, 0, 0, 0]);
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
async function openPhone(strict) {
  const ctx = await strict.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
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

/* --------------------------------------------------------- touch sticks */

/** A phone with a race under way, and helpers to put thumbs on the screen (game-pixel coordinates). */
async function phoneRace() {
  const { ctx, page, errors } = await openPhone(browser);
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

test('touch: the fire stick aims blasts where it points, and fires straight ahead when held still', { skip }, async () => {
  const ph = await phoneRace();
  try {
    const f = (await ph.layout()).fire;
    // blaster in hand, rocket pointing up and still: shots should follow the stick, not the nose
    const arm = () => ph.page.evaluate(() => { const p = RR.game.player; p.weapon = 'blaster'; p.ammo = 99; p.angle = -Math.PI / 2; p.angVel = 0; p.vx = p.vy = 0; });
    const lastBolt = () => ph.page.evaluate(() => {
      const g = RR.game, me = g.player, b = g.shots.filter((s) => s.owner === me && s.type === 'bolt').pop();
      return b ? { dir: Math.atan2(b.vy - me.vy * 0.5, b.vx - me.vx * 0.5), ship: me.angle, aim: RR.input.touch.aim } : null;
    });
    await arm();
    await ph.down([f.x, f.y]);
    await ph.page.waitForTimeout(60);
    await ph.move([f.x - 30, f.y + 30]); // down and to the left
    await ph.page.waitForTimeout(400);
    let b = await lastBolt();
    assert.ok(b, 'it fired');
    assert.ok(angleGap(b.aim, 3 * Math.PI / 4) < 0.05, 'aiming down-left: ' + b.aim);
    assert.ok(angleGap(b.dir, 3 * Math.PI / 4) < 0.1, 'the blast went down-left: ' + b.dir);
    assert.ok(angleGap(b.ship, -Math.PI / 2) < 0.2, 'while the rocket still points up');
    await ph.up();
    await ph.page.waitForTimeout(250);

    await arm();
    await ph.down([f.x + 2, f.y + 1]); // a thumb resting in the middle
    await ph.page.waitForTimeout(400);
    b = await lastBolt();
    assert.strictEqual(b.aim, null);
    assert.ok(angleGap(b.dir, b.ship) < 0.1, 'straight ahead: ' + b.dir + ' vs ' + b.ship);
    await ph.up();

    // missiles launch along the aim too; mines still drop behind the rocket
    const r = await ph.page.evaluate(() => {
      const g = RR.game, me = g.player, read = RR.input.read, out = {};
      RR.input.read = () => ({ turn: 0, thrust: 0, brake: 0, fire: true, aim: 0 }); // stick pushed right
      try {
        me.angle = -Math.PI / 2; me.vx = me.vy = 0; me.cool = 0; me.prevFire = false; me.weapon = 'missile'; me.ammo = 1;
        g.step(1 / 120);
        out.missile = g.shots.filter((s) => s.owner === me && s.type === 'missile').pop().angle;
        me.angle = -Math.PI / 2; me.vx = me.vy = 0; me.cool = 0; me.prevFire = false; me.weapon = 'mine'; me.ammo = 1;
        g.step(1 / 120);
        const m = g.mines.filter((x) => x.owner === me).pop();
        out.mine = [m.x - me.x, m.y - me.y];
      } finally { RR.input.read = read; }
      return out;
    });
    assert.ok(angleGap(r.missile, 0) < 0.1, 'missile launched to the right: ' + r.missile);
    assert.ok(Math.abs(r.mine[0]) < 3 && Math.abs(r.mine[1] - 16) < 3, 'mine dropped behind (below) the rocket: ' + r.mine);
    assert.deepStrictEqual(ph.errors, []);
  } finally { await ph.ctx.close(); }
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
    assert.strictEqual(moved.steer, undefined, 'steering has no fixed spot');

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

