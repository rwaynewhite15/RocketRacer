'use strict';

/*
 * Online multiplayer: rooms of up to six ships over WebSockets.
 *
 * The server is the authority. Each room runs the real game engine
 * (lib/engine.js) at 120 steps a second; players send only their controls
 * (60 a second) and get the world back 20 times a second, with the sounds
 * and explosions as events. Seats no human takes are flown by bots, and a
 * bot takes over a ship whose player drops out until they come back.
 *
 *   room:  lobby -> race (countdown, race) -> results -> lobby ...
 *
 * Messages are JSON, except the two that flow all the time (inputs and
 * snapshots), which are binary: see public/src/proto.js.
 *
 *   client -> server                      server -> client
 *   hello { v, pid, name }                welcome { ms }  |  error { code }
 *   ping { c }                            pong { c, s }
 *   quick { mode, track, diff, setup }    room { room, you, token }
 *   create { mode, track, diff, setup }   start { opts, you, ms }
 *   join { code, setup }                  ev { ms, e: [...] }
 *   resume { token }                      results { list, next }
 *   ready { on }   leave {}               bye { reason }
 *   <binary input>                        <binary snapshot>
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('../public/src/proto');
const { createEngine } = require('./engine');
const { cleanName } = require('./names');

const SEATS = 6;
const STEP = 1 / 120;
const SNAP_MS = 50; // 20 snapshots a second
const END_DELAY = 3; // seconds of racing on after the last human is done
const AFTER_FIRST = 60; // stragglers' cut-off, seconds after the first ship finishes
const RACE_CAP = 360; // no race or fight runs past six minutes
const RESULTS_MS = 9000;
const RECONNECT_MS = 30000;
const EMPTY_ROOM_MS = 30000;
const MAX_ROOMS = 200;
const MAX_CONN_PER_IP = 8;
const MAX_MSGS_PER_SEC = 200;
const BOT_NAMES = ['NOVA', 'BLITZ', 'COMET', 'VEGA', 'ORION', 'ZIPPY', 'ASTRO', 'PULSAR'];
const MODES = ['race', 'dogfight', 'royale'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

// the hull, stat and powerup tables, from one engine kept for reference
const REF = createEngine().RR;
const TRACK_COUNT = REF.TRACKS.length;
const ARENA_COUNT = REF.ARENAS.length;

/**
 * A player's rocket as they say it is, cut back to what the rules allow:
 * a known hull, stat levels between its own and its ceiling, powerup
 * levels 1-3. (Unlocks and points live in the player's browser, so this is
 * as far as the server can check, as for leaderboard setups.)
 */
function cleanSetup(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const hull = REF.HULLS.find((h) => h.id === raw.hull) || REF.HULLS[0];
  const stats = hull.base.map((b, k) => {
    const v = Array.isArray(raw.stats) ? raw.stats[k] : b;
    return Number.isInteger(v) ? Math.min(Math.max(v, b), hull.cap[k]) : b;
  });
  const levels = {};
  for (const pw of REF.POWER) {
    const v = raw.levels && raw.levels[pw.id];
    if (Number.isInteger(v) && v >= 2 && v <= 3) levels[pw.id] = v;
  }
  return { hull: hull.id, design: hull.design, stats, levels };
}

function cleanGame(raw) {
  const mode = MODES.includes(raw.mode) ? raw.mode : 'race';
  const n = mode === 'race' ? TRACK_COUNT : ARENA_COUNT;
  const track = Number.isInteger(raw.track) && raw.track >= 0 && raw.track < n ? raw.track : 0;
  const diff = [0, 1, 2].includes(raw.diff) ? raw.diff : 1;
  return { mode, track, diff };
}

const now = () => Date.now();

class Room {
  constructor(hub, game, priv) {
    this.hub = hub;
    this.id = ++hub.nextId;
    this.priv = priv;
    this.code = priv ? hub.newCode(this) : null;
    Object.assign(this, game); // mode, track, diff
    this.humans = []; // { conn, pid, name, setup, team, ready, token, connected, leftAt, ship, ack, waiting }
    this.state = 'lobby';
    this.engine = null;
    this.tick = 0; this.acc = 0; this.lastSnap = 0; this.lastStep = 0;
    this.events = [];
    this.results = null; this.resultsUntil = 0; this.endAt = 0;
    this.emptySince = now();
  }

  get connected() { return this.humans.filter((h) => h.connected); }
  get free() { return SEATS - this.humans.length; }

  summary() {
    return {
      code: this.code, priv: this.priv, mode: this.mode, track: this.track, diff: this.diff, state: this.state,
      humans: this.humans.map((h) => ({ name: h.name, team: h.team, design: h.setup.design, ready: h.ready, connected: h.connected, waiting: h.waiting })),
      results: this.results,
    };
  }

  add(conn, setup) {
    const used = new Set(this.humans.map((h) => h.team));
    const team = [0, 1, 2, 3, 4, 5].find((t) => !used.has(t));
    const h = {
      conn, pid: conn.pid, name: conn.name, setup, team, ready: false, connected: true, leftAt: 0,
      token: crypto.randomBytes(12).toString('hex'), ship: null, ack: 0, waiting: this.state !== 'lobby',
    };
    this.humans.push(h);
    this.hub.tokens.set(h.token, { room: this, h });
    conn.room = this; conn.h = h;
    this.emptySince = 0;
    this.sendRoom();
    return h;
  }

  remove(h) {
    const i = this.humans.indexOf(h);
    if (i < 0) return;
    this.humans.splice(i, 1);
    this.hub.tokens.delete(h.token);
    if (h.ship != null && this.engine) this.engine.G.botTakeover(this.engine.G.ships[h.ship], true);
    if (!this.connected.length) this.emptySince = now();
    this.sendRoom();
  }

  /** A player's connection dropped: keep their seat a while; a bot flies their ship meanwhile. */
  dropped(h) {
    h.connected = false; h.conn = null; h.leftAt = now(); h.ready = false;
    if (h.ship != null && this.engine) this.engine.G.botTakeover(this.engine.G.ships[h.ship], true);
    if (!this.connected.length) this.emptySince = now();
    this.sendRoom();
  }

  resumed(h, conn) {
    h.conn = conn; h.connected = true; h.leftAt = 0;
    conn.room = this; conn.h = h; conn.pid = h.pid; conn.name = h.name;
    this.emptySince = 0;
    this.sendRoom();
    if (this.state === 'race' && h.ship != null) {
      this.engine.G.botTakeover(this.engine.G.ships[h.ship], false);
      this.sendStart(h);
    }
  }

  send(h, msg) { if (h.connected && h.conn) h.conn.send(msg); }
  broadcast(msg) { const text = JSON.stringify(msg); for (const h of this.humans) this.send(h, text); }

  sendRoom() {
    const room = this.summary();
    for (const h of this.humans) this.send(h, JSON.stringify({ t: 'room', room, you: this.humans.indexOf(h), token: h.token }));
  }

  /** Everyone present is ready: race (or fight). Bots take the empty seats. */
  start() {
    const racers = this.humans.filter((h) => h.connected);
    const used = new Set(racers.map((h) => h.team));
    const seats = racers.map((h) => ({
      name: h.name, team: h.team, design: h.setup.design, hull: h.setup.hull, human: true, stats: h.setup.stats, levels: h.setup.levels,
    }));
    const names = BOT_NAMES.filter((n) => !racers.some((h) => h.name === n));
    for (let t = 0; seats.length < SEATS; t++) {
      if (used.has(t)) continue;
      seats.push({ name: names.shift() || 'BOT', team: t, design: seats.length % 3, human: false });
    }
    this.opts = { mode: this.mode, track: this.track, diff: this.diff, seats, turn: Math.floor(Math.random() * SEATS) };
    this.engine = createEngine();
    this.engine.G.startOnline(Object.assign({ server: true }, this.opts));
    for (const h of this.humans) { h.ship = null; h.ack = 0; h.waiting = !h.connected; }
    racers.forEach((h, i) => { h.ship = i; h.ready = false; h.waiting = false; });
    this.state = 'race';
    this.tick = 0; this.acc = 0; this.lastStep = now(); this.lastSnap = 0; this.endAt = 0;
    this.events = []; this.results = null;
    for (const h of racers) this.sendStart(h);
    this.sendRoom();
  }

  sendStart(h) {
    this.send(h, JSON.stringify({ t: 'start', opts: this.opts, you: h.ship, ms: this.hub.ms() }));
  }

  /** Called about 100 times a second by the hub. */
  update() {
    const t = now();
    if (this.state === 'lobby') {
      for (const h of this.humans.slice()) if (!h.connected && t - h.leftAt > RECONNECT_MS) this.remove(h);
      const present = this.connected;
      if (present.length && present.every((h) => h.ready)) this.start();
      return;
    }
    if (this.state === 'results') {
      if (t >= this.resultsUntil) this.toLobby();
      return;
    }
    // racing: advance the world in fixed steps
    const G = this.engine.G;
    const k = this.hub.speed; // 1, except in tests
    this.acc += Math.min(0.25 * k, ((t - this.lastStep) / 1000) * k);
    this.lastStep = t;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      G.step(STEP);
      this.tick++;
    }
    if (G.events.length) { for (const e of G.events) this.events.push(e); G.events.length = 0; }
    this.checkEnd(G);
    if (t - this.lastSnap >= SNAP_MS || this.state !== 'race') this.snapshot(G);
    if (this.state === 'race' && !this.connected.length) this.finishRace(G); // everyone has gone
  }

  checkEnd(G) {
    if (this.endAt) { if (G.raceTime >= this.endAt) this.finishRace(G); return; }
    const racing = this.humans.filter((h) => h.ship != null);
    let done;
    if (G.combat) done = G.over || racing.every((h) => G.ships[h.ship].gone || !h.connected);
    else {
      const first = G.ships.filter((s) => s.finished).reduce((m, s) => Math.min(m, s.finishTime), Infinity);
      done = racing.every((h) => G.ships[h.ship].finished || !h.connected) || G.raceTime > first + AFTER_FIRST;
    }
    if (done || G.raceTime > RACE_CAP) this.endAt = G.raceTime + END_DELAY;
  }

  snapshot(G) {
    this.lastSnap = now();
    const ms = this.hub.ms();
    if (this.events.length) { this.broadcast({ t: 'ev', ms, e: this.events }); this.events = []; }
    const body = P.encodeWorld(G, this.tick, ms);
    for (const h of this.humans) if (h.connected && h.ship != null) h.conn.sendBinary(P.encodeSnap(h.ack, body));
  }

  finishRace(G) {
    if (this.state !== 'race') return;
    this.snapshot(G);
    const list = G.order.map((s) => {
      const h = this.humans.find((x) => x.ship === s.idx);
      return {
        idx: s.idx, name: s.name, team: s.team, human: !!s.human, place: s.place, finished: s.finished,
        time: s.finished ? +s.finishTime.toFixed(2) : null, best: s.bestLap ? +s.bestLap.toFixed(2) : null,
        kills: s.kills, deaths: s.deaths, you: h ? h.token : null,
      };
    });
    // the server's own times go to the leaderboard: only Grand Prix finishers still at the controls
    if (!G.combat && this.hub.post) {
      for (const h of this.humans) {
        const s = h.ship != null ? G.ships[h.ship] : null;
        if (!s || !s.finished || !h.pid || s.botFlown) continue; // not a time a bot helped with
        // (as plain data: the engine's objects belong to its own context, which Firestore would not accept)
        this.hub.post(JSON.parse(JSON.stringify({
          track: REF.TRACKS[this.track].id, pid: h.pid, name: h.name, time: s.finishTime, lap: s.bestLap, diff: this.diff, place: s.place,
          setup: { ship: s.setup.ship, stats: s.setup.stats, items: s.used, levels: s.setup.levels },
        })));
      }
    }
    for (const h of this.humans) {
      const mine = list.map((r) => Object.assign({}, r, { you: r.you === h.token }));
      this.send(h, JSON.stringify({ t: 'results', list: mine, next: this.hub.resultsMs }));
    }
    this.results = list.map((r) => Object.assign({}, r, { you: undefined }));
    this.state = 'results';
    this.resultsUntil = now() + this.hub.resultsMs;
    this.engine = null;
    this.sendRoom();
  }

  toLobby() {
    this.state = 'lobby';
    for (const h of this.humans.slice()) {
      h.ship = null; h.ready = false; h.waiting = false;
      if (!h.connected && now() - h.leftAt > RECONNECT_MS) this.remove(h);
    }
    this.sendRoom();
  }

  /** A player's controls, applied from the next step on. */
  input(h, inp) {
    h.ack = inp.seq;
    if (this.state !== 'race' || h.ship == null) return;
    const G = this.engine.G, s = G.ships[h.ship];
    if (!s.netInput || s.ai) return; // finished, or not theirs to steer
    const n = s.netInput;
    n.turn = inp.turn; n.thrust = inp.thrust; n.brake = inp.brake; n.fire = inp.fire; n.aim = inp.aim; n.stick = inp.stick;
    if (inp.rewind) G.tryRewind(s);
  }
}

/** All the rooms on this server, and the connections to them. */
class Hub {
  constructor(opts) {
    this.post = opts.post || null;
    this.speed = opts.speed || 1; // tests run races faster than real time
    this.resultsMs = opts.resultsMs || RESULTS_MS;
    this.origins = opts.origins || null;
    this.log = opts.log || (() => {});
    this.rooms = new Set();
    this.codes = new Map();
    this.tokens = new Map();
    this.conns = new Set();
    this.perIp = new Map();
    this.nextId = 0;
    this.t0 = now();
    this.timer = setInterval(() => this.update(), 10);
    if (this.timer.unref) this.timer.unref();
  }

  ms() { return now() - this.t0; }

  newCode(room) {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.codes.has(c)) { this.codes.set(c, room); return c; }
    }
  }

  stats() {
    let players = 0;
    for (const r of this.rooms) players += r.connected.length;
    return { rooms: this.rooms.size, players, connections: this.conns.size };
  }

  update() {
    for (const r of this.rooms) {
      try { r.update(); } catch (e) { this.log('room ' + r.id + ' failed: ' + (e && e.stack || e)); this.close(r); }
      if (!r.connected.length && r.emptySince && now() - r.emptySince > EMPTY_ROOM_MS) this.close(r);
    }
  }

  close(r) {
    this.rooms.delete(r);
    if (r.code) this.codes.delete(r.code);
    for (const h of r.humans) { this.tokens.delete(h.token); if (h.conn) { h.conn.room = null; h.conn.h = null; } }
  }

  /** Accept a new connection (already upgraded to a WebSocket). */
  accept(ws, ip) {
    const n = (this.perIp.get(ip) || 0) + 1;
    if (n > MAX_CONN_PER_IP) { ws.close(1008, 'too many connections'); return; }
    this.perIp.set(ip, n);
    const conn = {
      ws, ip, pid: null, name: null, room: null, h: null, hello: false, msgs: 0, sec: 0,
      send: (text) => { if (ws.readyState === 1) ws.send(text); },
      sendBinary: (buf) => { if (ws.readyState === 1) ws.send(buf, { binary: true }); },
    };
    this.conns.add(conn);
    ws.on('message', (data, isBinary) => this.message(conn, data, isBinary));
    ws.on('close', () => this.gone(conn));
    ws.on('error', () => {});
  }

  gone(conn) {
    if (!this.conns.delete(conn)) return;
    const n = (this.perIp.get(conn.ip) || 1) - 1;
    if (n > 0) this.perIp.set(conn.ip, n); else this.perIp.delete(conn.ip);
    if (conn.room && conn.h) conn.room.dropped(conn.h);
  }

  error(conn, code, close) {
    conn.send(JSON.stringify({ t: 'error', code }));
    if (close) conn.ws.close(1008, code);
  }

  message(conn, data, isBinary) {
    const sec = Math.floor(now() / 1000);
    if (sec !== conn.sec) { conn.sec = sec; conn.msgs = 0; }
    if (++conn.msgs > MAX_MSGS_PER_SEC) { conn.ws.close(1008, 'slow down'); return; }
    if (isBinary) {
      const inp = P.decodeInput(data);
      if (inp && conn.room && conn.h) conn.room.input(conn.h, inp);
      return;
    }
    let m;
    try { m = JSON.parse(String(data)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { conn.send(JSON.stringify({ t: 'pong', c: m.c, s: this.ms() })); return; }
    if (m.t === 'hello') {
      if (m.v !== P.VERSION) { this.error(conn, 'version', true); return; }
      conn.hello = true;
      conn.pid = typeof m.pid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(m.pid) ? m.pid : null;
      conn.name = cleanName(m.name);
      conn.send(JSON.stringify({ t: 'welcome', ms: this.ms() }));
      return;
    }
    if (!conn.hello) { this.error(conn, 'hello first', true); return; }

    if (m.t === 'resume') {
      const seat = typeof m.token === 'string' && this.tokens.get(m.token);
      if (!seat || !this.rooms.has(seat.room)) { this.error(conn, 'expired'); return; }
      if (seat.h.conn && seat.h.conn !== conn) seat.h.conn.ws.close(1000, 'resumed elsewhere');
      this.leaveRoom(conn);
      seat.room.resumed(seat.h, conn);
      return;
    }
    if (m.t === 'quick' || m.t === 'create' || m.t === 'join') {
      this.leaveRoom(conn);
      const setup = cleanSetup(m.setup);
      let room;
      if (m.t === 'join') {
        room = typeof m.code === 'string' && this.codes.get(m.code.toUpperCase());
        if (!room) { this.error(conn, 'no such room'); return; }
        if (room.free <= 0) { this.error(conn, 'room full'); return; }
      } else {
        const game = cleanGame(m);
        if (m.t === 'quick') {
          for (const r of this.rooms) {
            if (!r.priv && r.state === 'lobby' && r.mode === game.mode && r.free > 0) { room = r; break; }
          }
        }
        if (!room) {
          if (this.rooms.size >= MAX_ROOMS) { this.error(conn, 'server full'); return; }
          room = new Room(this, game, m.t === 'create');
          this.rooms.add(room);
        }
      }
      room.add(conn, setup);
      return;
    }
    if (!conn.room || !conn.h) return;
    if (m.t === 'ready') { conn.h.ready = !!m.on && conn.room.state === 'lobby'; conn.room.sendRoom(); return; }
    if (m.t === 'leave') { this.leaveRoom(conn); conn.send(JSON.stringify({ t: 'left' })); }
  }

  leaveRoom(conn) {
    if (conn.room && conn.h) conn.room.remove(conn.h);
    conn.room = null; conn.h = null;
  }

  /** Tell everyone the server is going away (a new version is rolling out), then close. */
  shutdown(reason) {
    clearInterval(this.timer);
    for (const c of this.conns) {
      c.send(JSON.stringify({ t: 'bye', reason: reason || 'update' }));
      c.ws.close(1001, 'server update');
    }
  }
}

/**
 * Serve multiplayer on an http.Server: WebSocket upgrades on `path` ('/ws').
 *   opts.post(body)     record a finished online race on the leaderboard
 *   opts.origins        allowed page origins (others are refused); all when unset
 * Returns the hub (rooms, stats(), shutdown()).
 */
function attachMultiplayer(server, opts) {
  opts = opts || {};
  const path = opts.path || '/ws';
  const hub = new Hub(opts);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0];
    if (url !== path) { socket.destroy(); return; }
    const origin = req.headers.origin;
    if (hub.origins && origin && !hub.origins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // Google's front end adds the address it saw last (see server.js clientIp)
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ip = xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'unknown';
    wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws, ip));
  });
  hub.wss = wss;
  return hub;
}

module.exports = { attachMultiplayer, cleanSetup, cleanGame, SEATS };
