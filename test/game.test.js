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

