/* ==========================================================================
 * ROCKET RACER — mp.js
 * Online play in the browser (the server side is lib/mp.js).
 *
 * The server runs the race. This screen:
 *   - sends the player's controls 60 times a second (binary, see proto.js);
 *   - flies the player's own ship straight away from those controls
 *     (prediction), and when a snapshot arrives puts it where the server
 *     says and replays the controls the server has not used yet
 *     (reconciliation), blending out small differences;
 *   - draws everyone else 100 ms in the past, smoothly between the two
 *     snapshots either side of that moment (interpolation);
 *   - plays the server's events (sounds, explosions, pickups, kills) at the
 *     same moment as the ships they belong to;
 *   - keeps its clock in step with the server's (ping / pong).
 * A dropped connection reconnects and resumes the seat (a bot flies the
 * ship meanwhile).
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR, P = RR.proto;
  const STEP = 1 / 120;
  const INTERP_MS = 100; // how far behind the server the other ships are drawn
  const PING_MS = 2000;
  const MAX_STEPS = 360; // unacknowledged steps kept for replay (3 s)
  const TOKEN_KEY = 'rocketracer.mp.token';

  const M = (RR.mp = {
    status: 'off', // off | connecting | online | lost
    error: null, notice: null,
    room: null, you: -1, token: null, results: null, reward: null,
    me: -1, // the player's ship in the current race
    rtt: 0, offset: 0,
  });
  let ws = null, pingTimer = 0, retryTimer = 0, retries = 0, pendingAction = null, leaving = false;
  let samples = []; // clock samples: { rtt, offset }
  let snaps = []; // decoded snapshots, oldest first
  let events = []; // { ms, e }
  let steps = []; // the player's own steps not yet acknowledged: { seq, inp }
  let seq = 0, stepN = 0, acc = 0, wantDefer = false, last = null;

  M.available = function () { return !!RR.net.mp; };
  M.serverNow = function () { return performance.now() + M.offset; };

  function url() {
    const u = RR.net.mp;
    if (/^wss?:\/\//.test(u)) return u;
    const loc = window.location;
    return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + u;
  }

  function send(m) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; }
    return false;
  }

  /** The player's rocket, as the server needs it: hull, stat levels, powerup levels. */
  function setup() {
    const G = RR.game, i = G.prog.ship, h = RR.HULLS[i];
    return { hull: h.id, stats: RR.STATS.map(function (st, k) { return G.statLevel(i, k); }), levels: Object.assign({}, G.prog.pup) };
  }

  /* ------------------------------------------------------- connection */

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    clearTimeout(retryTimer);
    M.status = 'connecting';
    leaving = false;
    try { ws = new WebSocket(url()); } catch (e) { lost(); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      const G = RR.game;
      send({ t: 'hello', v: P.VERSION, pid: G.pid, name: G.name });
      ping();
      clearInterval(pingTimer);
      pingTimer = setInterval(ping, PING_MS);
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        message(m);
      } else snapshot(ev.data);
    };
    ws.onclose = function () {
      clearInterval(pingTimer);
      ws = null;
      if (leaving) { M.status = 'off'; return; }
      lost();
    };
  }

  /** The connection dropped: try again, a little later each time, while there is a seat to go back to. */
  function lost() {
    M.status = 'lost';
    const G = RR.game;
    if (retries >= 8 || (G.state !== 'online' && G.state !== 'play' && G.state !== 'mpresults')) { M.error = 'CONNECTION LOST'; return; }
    M.notice = 'RECONNECTING...';
    retryTimer = setTimeout(connect, Math.min(8000, 600 * Math.pow(2, retries++)));
  }

  function ping() { send({ t: 'ping', c: performance.now() }); }

  function pong(m) {
    const t = performance.now(), rtt = t - m.c;
    samples.push({ rtt: rtt, offset: m.s - (m.c + rtt / 2) });
    if (samples.length > 8) samples.shift();
    let best = samples[0];
    for (const s of samples) if (s.rtt < best.rtt) best = s; // the quickest round trip says most about the clock
    M.offset = best.offset;
    M.rtt = Math.round(best.rtt);
  }

  /* --------------------------------------------------------- messages */

  function message(m) {
    const G = RR.game;
    if (m.t === 'pong') { pong(m); return; }
    if (m.t === 'welcome') {
      M.status = 'online'; M.notice = null; retries = 0;
      if (!samples.length) M.offset = m.ms - performance.now();
      const token = M.token || storage(TOKEN_KEY);
      if (pendingAction) { send(pendingAction); pendingAction = null; } else if (token) send({ t: 'resume', token: token });
      return;
    }
    if (m.t === 'error') {
      const words = { version: 'A NEW VERSION IS OUT - RELOAD THE PAGE', 'no such room': 'NO ROOM WITH THAT CODE', 'room full': 'THAT ROOM IS FULL',
        'server full': 'SERVERS ARE FULL - TRY AGAIN SOON', expired: null };
      if (m.code === 'expired') { M.token = null; storage(TOKEN_KEY, null); if (G.state === 'play' || G.state === 'mpresults') G.toOnlineLobby(); return; }
      M.error = words[m.code] !== undefined ? words[m.code] : String(m.code).toUpperCase();
      RR.audio.sfx('deny');
      return;
    }
    if (m.t === 'room') {
      M.room = m.room; M.you = m.you; M.token = m.token; M.error = null;
      storage(TOKEN_KEY, m.token);
      // after the results, the room is back in its lobby
      if (m.room.state === 'lobby' && G.state === 'mpresults' && M.resultsShown > 2) M.backToRoom();
      return;
    }
    if (m.t === 'start') { start(m); return; }
    if (m.t === 'ev') { for (const e of m.e) events.push({ ms: m.ms, e: e }); return; }
    if (m.t === 'results') { results(m); return; }
    if (m.t === 'left') { M.room = null; M.token = null; storage(TOKEN_KEY, null); return; }
    if (m.t === 'bye') { M.notice = 'SERVER UPDATING - RECONNECTING...'; }
  }

  function start(m) {
    const G = RR.game;
    G.startOnline(Object.assign({}, m.opts, { me: m.you }));
    G.ships.forEach(function (s, i) { s.remote = i !== m.you; });
    G.mpMenu = false;
    M.me = m.you; M.results = null; M.reward = null; M.error = null;
    snaps = []; events = []; steps = []; seq = 0; stepN = 0; acc = 0; wantDefer = false; last = null;
    RR.audio.sfx('confirm');
    RR.audio.music({ on: true, tempo: 1, lead: true, restart: true });
  }

  function results(m) {
    const G = RR.game;
    M.results = m.list;
    M.resultsShown = 0;
    const mine = m.list.find(function (r) { return r.you; });
    M.reward = mine ? G.awardOnline(mine.place) : null;
    G.state = 'mpresults';
    G.mpMenu = false;
    RR.audio.sfx(mine && mine.place <= 3 ? 'finish' : 'lose');
    RR.audio.music({ tempo: 0.9 });
  }

  /* ------------------------------------------------------ the lobby */

  /** The ONLINE screen. */
  M.open = function () {
    const G = RR.game;
    if (!M.available()) return;
    G.state = 'online';
    M.error = null;
    RR.audio.sfx('select');
    connect();
  };

  function act(msg) {
    M.error = null;
    if (!send(msg)) { pendingAction = msg; connect(); }
  }
  function game() {
    const G = RR.game, mode = RR.MODES[G.modeIdx].id;
    return { mode: mode, track: mode === 'race' ? G.trackIdx : G.arenaIdx, diff: G.diffIdx };
  }
  M.quick = function () { act(Object.assign({ t: 'quick', setup: setup() }, game())); };
  M.create = function () { act(Object.assign({ t: 'create', setup: setup() }, game())); };
  M.join = function (code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (code.length === 4) act({ t: 'join', code: code, setup: setup() });
  };
  M.ready = function (on) { send({ t: 'ready', on: on }); };
  M.isReady = function () { const h = M.room && M.room.humans[M.you]; return !!(h && h.ready); };

  /** Leave the room (and the race, if there is one): back to the title screen. */
  M.leave = function () {
    const G = RR.game;
    send({ t: 'leave' });
    M.room = null; M.token = null; M.results = null;
    storage(TOKEN_KEY, null);
    leaving = true;
    if (ws) ws.close();
    G.toTitle();
  };

  /** From the results back to the room's lobby. */
  M.backToRoom = function () {
    const G = RR.game;
    if (G.state !== 'mpresults') return;
    G.toOnlineLobby();
  };

  M.keys = function (hit) {
    if (hit.pause || hit.quit) { M.leave(); return; }
    if (!M.room) {
      if (hit.ok || hit.fire) M.quick();
    } else if (hit.ok || hit.fire) M.ready(!M.isReady());
  };

  M.defer = function () { wantDefer = true; }; // a gate deferral, asked for with the next input

  /** JOIN ROOM: a real text field, so phones show a keyboard. */
  M.askCode = function () {
    const box = document.getElementById('codebox'), field = document.getElementById('roomcode');
    if (!box || !field) return;
    field.value = '';
    box.hidden = false;
    RR.input.typing = true;
    RR.input.down = {};
    field.focus();
  };
  M.closeCode = function (join) {
    const box = document.getElementById('codebox'), field = document.getElementById('roomcode');
    if (!box || box.hidden) return;
    if (join) M.join(field.value);
    field.blur();
    box.hidden = true;
    RR.input.typing = false;
    RR.input.focus(); // keys back to the game
  };

  /* ---------------------------------------------------- the race */

  /** Called by the game every frame of an online race or its results. */
  M.frame = function (dt) {
    const G = RR.game;
    if (G.state === 'mpresults') M.resultsShown = (M.resultsShown || 0) + dt;
    acc += dt;
    let n = 0;
    while (acc >= STEP) {
      acc -= STEP;
      if (++n > 14) { acc = 0; break; }
      step(G);
    }
    interpolate(G);
    playEvents(G);
  };

  /** Can the player's own ship be flown here, ahead of the server? */
  function predictable(G, s) {
    return G.state === 'play' && G.phase === 'race' && s.dead <= 0 && !s.finished && !s.gone;
  }

  const ZERO = { turn: 0, thrust: 0, brake: 0, fire: false, aim: null, stick: false };

  function step(G) {
    G.onlineStep(STEP);
    const me = G.ships[M.me];
    if (!me || G.state !== 'play') return;
    const inp = G.mpMenu ? ZERO : RR.input.read(me);
    stepN++;
    const next = (seq + 1) & 0xffff;
    if (predictable(G, me)) {
      G.predictShip(me, inp, STEP, false);
      steps.push({ seq: next, inp: { turn: inp.turn, thrust: inp.thrust, brake: inp.brake, fire: inp.fire, aim: inp.aim, stick: inp.stick, keyAim: inp.keyAim } });
      if (steps.length > MAX_STEPS) steps.shift();
    }
    if (stepN % 2 === 0 && ws && ws.readyState === 1) { // 60 a second
      seq = next;
      ws.send(P.encodeInput({ seq: seq, turn: inp.turn, thrust: inp.thrust, brake: inp.brake, fire: inp.fire, aim: inp.aim, stick: inp.stick, defer: wantDefer }));
      wantDefer = false;
    }
  }

  /** u16 sequence numbers wrap: is a after b? */
  function after(a, b) { const d = (a - b) & 0xffff; return d !== 0 && d < 32768; }

  function snapshot(buf) {
    const G = RR.game, s = P.decodeSnap(buf);
    if (!s || !G.online || M.me < 0) return;
    snaps.push(s);
    if (snaps.length > 40) snaps.shift();
    own(G, s);
  }

  /** The player's own ship: the server's word, plus the controls it has not seen yet. */
  function own(G, s) {
    const me = G.ships[M.me], st = s.ships[M.me];
    if (!me || !st) return;
    const was = { lap: me.lap, cp: me.cpCount, dead: me.dead > 0, finished: me.finished, emp: me.emp > 0 };
    copyState(me, st);
    G.phase = s.phase;
    G.playerDone = st.finished || st.gone;
    steps = steps.filter(function (x) { return after(x.seq, s.ack); });
    if (predictable(G, me)) {
      const px = me.x, py = me.y;
      me.x = st.x; me.y = st.y; me.vx = st.vx; me.vy = st.vy; me.angle = st.angle; me.angVel = st.angVel;
      for (const x of steps) G.predictShip(me, x.inp, STEP, true);
      const ex = px - me.x, ey = py - me.y;
      if (last && ex * ex + ey * ey < 90 * 90) { me.x += ex * 0.6; me.y += ey * 0.6; } // ease small differences out
    } else {
      me.x = st.x; me.y = st.y; me.vx = st.vx; me.vy = st.vy; me.angle = st.angle; me.angVel = st.angVel; me.thrusting = st.thrusting;
      steps = [];
    }
    last = s;
    // what changed for the player: the cues a local race would give
    const fx = RR.fx, PAL = RR.PAL;
    if (!G.combat && me.cpCount > was.cp && was.cp >= 0 && G.phase === 'race') {
      RR.audio.sfx('cp');
      const cp = G.track.cps[(me.nextCp + G.track.cps.length - 1) % G.track.cps.length];
      fx.ring(cp.x, cp.y, RR.Art.DONUT_RC - 12, RR.Art.DONUT_RC + 26, 0.35, PAL.yellow);
    }
    if (!G.combat && me.lap > was.lap && was.lap > 0 && !me.finished) {
      const lastLap = me.lap === G.laps;
      fx.banner(lastLap ? 'FINAL LAP!' : 'LAP ' + me.lap, lastLap ? PAL.orange : PAL.cyan, 1.6, 4);
      RR.audio.sfx('lap');
    }
    if (me.dead > 0 && !was.dead && !me.gone) {
      G.flash = 0.6; G.shake = 12;
      fx.banner('WRECKED!', PAL.alarm, 1.5, 3);
      RR.input.buzz(160);
    }
    if (me.emp > 0 && !was.emp) fx.banner('ENGINES DOWN!', PAL.violet, 1.2, 2);
    if (me.finished && !was.finished && !G.combat) {
      fx.banner('FINISH!', me.place === 1 ? PAL.yellow : PAL.white, 2.2, 5);
      RR.audio.sfx(me.place <= 3 ? 'finish' : 'lose');
    }
  }

  /** The discrete parts of a ship's state, straight from a snapshot. */
  function copyState(s, st) {
    s.hp = st.hp; s.maxHp = st.maxHp;
    s.shield = st.shield; s.nitro = st.nitro; s.stun = st.stun; s.emp = st.emp; s.invuln = st.invuln; s.spinRate = st.spinRate;
    s.weapon = st.weapon; s.ammo = st.ammo; s.defer = st.defer;
    s.lap = st.lap; s.nextCp = st.nextCp; s.cpCount = st.cpCount; s.place = st.place;
    s.lapStart = st.lapStart; s.bestLap = st.bestLap; s.progress = st.progress;
    s.finished = st.finished; s.finishTime = st.finishTime;
    s.kills = st.kills; s.deaths = st.deaths; s.elim = st.elim; s.gone = st.gone; s.zoned = st.zoned;
    s.dead = st.dead ? Math.max(s.dead, 1) : 0;
    if (st.hit) s.hitFlash = 0.12;
  }

  /** Everything but the player's own ship, as it was INTERP_MS ago. */
  function interpolate(G) {
    if (!snaps.length || !G.online) return;
    const now = M.serverNow(), rt = now - INTERP_MS, newest = snaps[snaps.length - 1];
    let a = snaps[0], b = snaps[0];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].serverMs <= rt) { a = snaps[i]; b = snaps[Math.min(i + 1, snaps.length - 1)]; break; }
    }
    const span = b.serverMs - a.serverMs;
    const f = span > 0 ? Math.min(1, Math.max(0, (rt - a.serverMs) / span)) : 0;
    const over = span > 0 ? 0 : Math.min(0.2, Math.max(0, (rt - b.serverMs) / 1000)); // late: carry on a little
    const lerp = function (x, y) { return x + (y - x) * f; };

    // the clock and the countdown run on from the newest snapshot
    const since = Math.max(0, (now - newest.serverMs) / 1000);
    G.raceTime = newest.raceTime + (newest.phase === 'race' ? since : 0);
    G.count = Math.max(0, newest.count - (newest.phase === 'race' ? 0 : since));
    G.over = newest.over;
    if (G.zone && b.zone != null) G.zone.r = lerp(a.zone, b.zone);

    for (let i = 0; i < G.ships.length; i++) {
      if (i === M.me) continue;
      const s = G.ships[i], sa = a.ships[i], sb = b.ships[i];
      if (!sa || !sb) continue;
      copyState(s, sb);
      if (Math.abs(sb.x - sa.x) + Math.abs(sb.y - sa.y) > 300) { s.x = sb.x; s.y = sb.y; } // a respawn: no sliding across the map
      else { s.x = lerp(sa.x, sb.x) + sb.vx * over; s.y = lerp(sa.y, sb.y) + sb.vy * over; }
      s.angle = sa.angle + RR.angDiff(sb.angle, sa.angle) * f;
      s.vx = sb.vx; s.vy = sb.vy;
      s.thrusting = sb.thrusting;
    }
    // places
    G.order = G.ships.slice().sort(function (x, y) { return x.place - y.place; });

    // shots carry on from the older snapshot at their own speed
    const ta = Math.max(0, (rt - a.serverMs) / 1000);
    G.shots = a.shots.map(function (sh) {
      const owner = G.ships[sh.owner];
      return {
        type: sh.type, owner: owner, x: sh.x + sh.vx * ta, y: sh.y + sh.vy * ta, vx: sh.vx, vy: sh.vy, angle: sh.angle,
        color: owner ? owner.colors.i : '#ffffff', life: 1,
      };
    });
    G.mines = b.mines.map(function (m, k) { return { owner: G.ships[m.owner], x: m.x, y: m.y, t: m.t, ph: k * 0.37 }; });
    G.waves = b.waves.map(function (w) { return { x: w.x, y: w.y, r: w.r, hit: [] }; });
    for (let k = 0; k < G.pickups.length && k < b.pickups.length; k++) {
      G.pickups[k].on = b.pickups[k].on; G.pickups[k].type = b.pickups[k].type || G.pickups[k].type;
    }
    for (let k = 0; k < G.rocks.length && k < b.rocks.length; k++) {
      const r = G.rocks[k], ra = a.rocks[k], rb = b.rocks[k];
      r.dead = rb.dead;
      r.x = ra ? lerp(ra.x, rb.x) : rb.x; r.y = ra ? lerp(ra.y, rb.y) : rb.y;
    }
  }

  /** The server's events, at the moment of the world they belong to. */
  function playEvents(G) {
    if (!events.length) return;
    const rt = M.serverNow() - INTERP_MS;
    let k = 0;
    while (k < events.length && events[k].ms <= rt) k++;
    if (!k) return;
    const due = events.splice(0, k);
    for (const x of due) play(G, x.e);
  }

  function play(G, e) {
    const fx = RR.fx, PAL = RR.PAL;
    switch (e[0]) {
      case 's':
        fx.snd(e[1], e[2], e[3], e[4]);
        if (e[1] === 'bump' || e[1] === 'hit') fx.burst(e[2], e[3], 6, 110, 'spark', 0.3);
        else if (e[1] === 'rock') fx.burst(e[2], e[3], 8, 120, 'rock', 0.5);
        else if (e[1] === 'shield') fx.burst(e[2], e[3], 10, 120, 'shield', 0.4);
        else if (e[1] === 'emp') fx.ring(e[2], e[3], 8, 60, 0.4, PAL.violet);
        break;
      case 'b': fx.boom(e[1], e[2], e[3]); break;
      case 'p': {
        const pk = G.pickups[e[1]], it = RR.ITEMS[e[3]];
        if (!pk || !it) break;
        fx.burst(pk.x, pk.y, 12, 120, it.ammo ? 'fire' : e[3] === 'defer' ? 'ion' : 'shield', 0.45);
        fx.ring(pk.x, pk.y, 6, 20, 0.22, it.color);
        if (e[2] === M.me) {
          fx.text(pk.x, pk.y - 12, it.name, it.color);
          RR.audio.sfx(it.ammo ? 'weapon' : 'power');
          if (e[3] === 'defer') fx.banner('DEFERRAL READY', PAL.violet, 1.6, 3);
        }
        break;
      }
      case 'k': {
        const killer = G.ships[e[1]], victim = G.ships[e[2]];
        if (!victim) break;
        G.feed.push({ a: killer ? killer.name : '', b: victim.name, zone: !!e[3], t: 0 });
        if (G.feed.length > 3) G.feed.shift();
        if (e[1] === M.me && e[2] !== M.me) { fx.banner('WRECKED ' + victim.name + '!', PAL.yellow, 1.3, 3); RR.audio.sfx('power'); }
        break;
      }
      case 'd': fx.deferred(e[1], e[2]); break; // ship e[1] deferred gate e[2]
      default: break;
    }
  }

  /* -------------------------------------------------------- helpers */

  function storage(key, value) {
    try {
      if (value === undefined) return window.sessionStorage.getItem(key);
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch (e) { /* private browsing */ }
    return null;
  }

  // for the tests: drop the connection as a bad network would (it reconnects and resumes)
  M._drop = function () { if (ws) ws.close(); };
  // for the tests: a look inside
  M._debug = function () { return { snaps: snaps.length, steps: steps.length, events: events.length, seq: seq, ws: ws ? ws.readyState : -1 }; };
})();
