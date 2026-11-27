/* ==========================================================================
 * ROCKET RACER — proto.js
 * The online message format, shared by the game (window.RR.proto) and the
 * multiplayer server (require('./public/src/proto')).
 *
 * Lobby and control messages are small JSON objects. The two that flow all
 * the time are binary, to keep phones' data use down:
 *
 *   input     client -> server, 60 a second, 8 bytes
 *   snapshot  server -> client, 20 a second, about 0.5-1 KB
 *
 * Bump VERSION whenever either changes: a game and a server that disagree
 * refuse to play, and the game asks for a reload.
 * ======================================================================== */
(function (root) {
  'use strict';

  const P = {
    VERSION: 6, // 2: the gate deferral replaced the do-over; 3: capture the flag; 4: two or three teams;
    // 5: a fourth course (rooms name courses by number), rooms for humans only, and a course's weapons
    // on or off (every screen must build the same pickups: snapshots name them by number);
    // 6: the Indy-Galactic 500 rebuilt round a walled lane (its gates and pickups)
    INPUT: 1, SNAP: 2, // first byte of a binary message
    WEAPONS: [null, 'blaster', 'missile', 'mine', 'emp'],
    ITEMS: ['nitro', 'shield', 'repair', 'defer', 'blaster', 'missile', 'mine', 'emp', 'reflag'],
    FLAG: ['home', 'carried', 'dropped'], // capture the flag: where a flag is
  };
  const PI = Math.PI;

  /* ------------------------------------------------------------- input */

  /** { seq, turn -1..1, thrust 0..1, brake, fire, stick, aim (radians) | null, defer } -> 8 bytes */
  P.encodeInput = function (i) {
    const b = new ArrayBuffer(8), v = new DataView(b);
    v.setUint8(0, P.INPUT);
    v.setUint16(1, i.seq & 0xffff, true);
    v.setInt8(3, Math.round(clampN(i.turn, -1, 1) * 127));
    v.setUint8(4, Math.round(clampN(i.thrust, 0, 1) * 255));
    const aim = i.aim == null || !isFinite(i.aim) ? null : Math.atan2(Math.sin(i.aim), Math.cos(i.aim));
    v.setUint8(5, (i.brake ? 1 : 0) | (i.fire ? 2 : 0) | (i.stick ? 4 : 0) | (aim != null ? 8 : 0) | (i.defer ? 16 : 0));
    v.setInt16(6, aim == null ? 0 : Math.round((aim / PI) * 32767), true);
    return b;
  };

  P.decodeInput = function (buf) {
    const v = view(buf);
    if (!v || v.byteLength !== 8 || v.getUint8(0) !== P.INPUT) return null;
    const f = v.getUint8(5);
    return {
      seq: v.getUint16(1, true),
      turn: v.getInt8(3) / 127,
      thrust: v.getUint8(4) / 255,
      brake: f & 1 ? 1 : 0, fire: !!(f & 2), stick: !!(f & 4),
      aim: f & 8 ? (v.getInt16(6, true) / 32767) * PI : null,
      defer: !!(f & 16), // spend a gate deferral
    };
  };

  /* ---------------------------------------------------------- snapshot */

  // ship flags
  const F = { dead: 1, gone: 2, finished: 4, /* 8: spare */ shield: 16, nitro: 32, invuln: 64, stun: 128, emp: 256, zoned: 512, hit: 1024, human: 2048, bot: 4096 };
  P.SHIP_FLAGS = F;

  /** A growing byte buffer with typed writes. */
  function Writer() { this.b = new DataView(new ArrayBuffer(2048)); this.n = 0; }
  Writer.prototype.room = function (k) {
    if (this.n + k <= this.b.byteLength) return;
    const nb = new DataView(new ArrayBuffer(Math.max(this.b.byteLength * 2, this.n + k)));
    new Uint8Array(nb.buffer).set(new Uint8Array(this.b.buffer, 0, this.n));
    this.b = nb;
  };
  Writer.prototype.u8 = function (x) { this.room(1); this.b.setUint8(this.n, x); this.n += 1; };
  Writer.prototype.u16 = function (x) { this.room(2); this.b.setUint16(this.n, x, true); this.n += 2; };
  Writer.prototype.i16 = function (x) { this.room(2); this.b.setInt16(this.n, clampN(Math.round(x), -32768, 32767), true); this.n += 2; };
  Writer.prototype.u32 = function (x) { this.room(4); this.b.setUint32(this.n, x >>> 0, true); this.n += 4; };
  Writer.prototype.f32 = function (x) { this.room(4); this.b.setFloat32(this.n, x, true); this.n += 4; };
  Writer.prototype.bytes = function () { return this.b.buffer.slice(0, this.n); };

  function Reader(v) { this.v = v; this.n = 0; }
  Reader.prototype.u8 = function () { return this.v.getUint8(this.n++); };
  Reader.prototype.u16 = function () { const x = this.v.getUint16(this.n, true); this.n += 2; return x; };
  Reader.prototype.i16 = function () { const x = this.v.getInt16(this.n, true); this.n += 2; return x; };
  Reader.prototype.u32 = function () { const x = this.v.getUint32(this.n, true); this.n += 4; return x; };
  Reader.prototype.f32 = function () { const x = this.v.getFloat32(this.n, true); this.n += 4; return x; };

  const dsec = function (t) { return clampN(Math.round(t * 10), 0, 255); }; // timers in tenths of a second

  /**
   * The world as the players need to see it: the snapshot body, the same
   * for everyone in the room. `w` is the engine world (RR.game).
   */
  P.encodeWorld = function (w, tick, serverMs) {
    const o = new Writer();
    o.u32(tick); o.u32(serverMs);
    o.f32(w.raceTime); o.f32(Math.max(0, w.count));
    o.u8(w.phase === 'race' ? 1 : 0);
    o.u8((w.over ? 1 : 0) | (w.zone ? 2 : 0));
    o.f32(w.zone ? w.zone.r : 0);
    o.u8(w.ships.length);
    for (const s of w.ships) {
      o.u8(s.idx);
      o.u16((s.dead > 0 ? F.dead : 0) | (s.gone ? F.gone : 0) | (s.finished ? F.finished : 0) |
        (s.shield > 0 ? F.shield : 0) | (s.nitro > 0 ? F.nitro : 0) | (s.invuln > 0 ? F.invuln : 0) | (s.stun > 0 ? F.stun : 0) |
        (s.emp > 0 ? F.emp : 0) | (s.zoned ? F.zoned : 0) | (s.hitFlash > 0 ? F.hit : 0) | (s.human ? F.human : 0) | (s.ai ? F.bot : 0));
      o.f32(s.x); o.f32(s.y); o.f32(s.vx); o.f32(s.vy); o.f32(s.angle); o.f32(s.angVel);
      o.u8(Math.round(clampN(s.thrusting, 0, 1) * 255));
      o.u16(Math.round(clampN(s.hp, 0, 6000) * 10)); o.u16(s.maxHp);
      o.u8(dsec(s.shield)); o.u8(dsec(s.nitro)); o.u8(dsec(s.stun)); o.u8(dsec(s.emp)); o.u8(dsec(s.invuln));
      o.i16(s.spinRate * 100);
      o.u8(Math.max(0, P.WEAPONS.indexOf(s.weapon))); o.u8(clampN(s.ammo, 0, 255)); o.u8(clampN(s.defer, 0, 255)); o.u8(clampN(s.reflag, 0, 255)); o.u8(clampN(s.caps, 0, 255));
      o.u8(clampN(s.lap, 0, 255)); o.u8(clampN(s.nextCp, 0, 255)); o.u16(clampN(s.cpCount, 0, 65535)); o.u8(clampN(s.place, 0, 255));
      o.f32(s.lapStart); o.f32(s.bestLap || 0); o.f32(s.finished ? s.finishTime : 0); o.f32(s.progress || 0);
      o.u16(clampN(s.kills, 0, 65535)); o.u16(clampN(s.deaths, 0, 65535)); o.u8(clampN(s.elim, 0, 255));
    }
    const shots = w.shots;
    o.u16(Math.min(shots.length, 1000));
    for (let i = 0; i < shots.length && i < 1000; i++) {
      const b = shots[i];
      o.u8(b.type === 'missile' ? 1 : 0); o.u8(b.owner ? b.owner.idx : 255);
      o.f32(b.x); o.f32(b.y); o.i16(b.vx * 4); o.i16(b.vy * 4);
      o.i16(((b.type === 'missile' ? b.angle : 0) / PI) * 32767);
    }
    o.u8(Math.min(w.mines.length, 255));
    for (let i = 0; i < w.mines.length && i < 255; i++) {
      const m = w.mines[i];
      o.u8(m.owner ? m.owner.idx : 255); o.f32(m.x); o.f32(m.y); o.u16(Math.round(clampN(m.t, 0, 6000) * 10));
    }
    o.u8(Math.min(w.waves.length, 255));
    for (let i = 0; i < w.waves.length && i < 255; i++) { const e = w.waves[i]; o.f32(e.x); o.f32(e.y); o.f32(e.r); }
    o.u8(w.pickups.length);
    for (const p of w.pickups) { o.u8(p.on ? 1 : 0); o.u8(Math.max(0, P.ITEMS.indexOf(p.type))); }
    o.u8(w.rocks.length);
    for (const a of w.rocks) { o.u8(a.dead ? 1 : 0); o.f32(a.x); o.f32(a.y); }
    // capture the flag: each flag (where it is, who has it), then each team's captures
    const flags = w.ctf && w.flags ? w.flags : [], caps = w.ctf && w.caps ? w.caps : [];
    o.u8(flags.length);
    for (const f of flags) { o.u8(Math.max(0, P.FLAG.indexOf(f.state))); o.u8(f.carrier ? f.carrier.idx : 255); o.f32(f.x); o.f32(f.y); }
    o.u8(caps.length);
    for (const c of caps) o.u8(clampN(c, 0, 255));
    return o.bytes();
  };

  /** A snapshot for one player: their header (the last input the server used) then the shared body. */
  P.encodeSnap = function (ack, body) {
    const out = new Uint8Array(3 + body.byteLength), v = new DataView(out.buffer);
    v.setUint8(0, P.SNAP);
    v.setUint16(1, ack & 0xffff, true);
    out.set(new Uint8Array(body), 3);
    return out.buffer;
  };

  P.decodeSnap = function (buf) {
    const v = view(buf);
    if (!v || v.byteLength < 3 || v.getUint8(0) !== P.SNAP) return null;
    const r = new Reader(v);
    r.n = 1;
    const s = { ack: r.u16(), tick: r.u32(), serverMs: r.u32(), raceTime: r.f32(), count: r.f32(), phase: r.u8() ? 'race' : 'countdown' };
    const fl = r.u8();
    s.over = !!(fl & 1);
    const zr = r.f32();
    s.zone = fl & 2 ? zr : null;
    const n = r.u8();
    s.ships = [];
    for (let i = 0; i < n; i++) {
      const idx = r.u8(), f = r.u16();
      s.ships.push({
        idx: idx, flags: f,
        dead: !!(f & F.dead), gone: !!(f & F.gone), finished: !!(f & F.finished), zoned: !!(f & F.zoned),
        hit: !!(f & F.hit), human: !!(f & F.human), bot: !!(f & F.bot),
        x: r.f32(), y: r.f32(), vx: r.f32(), vy: r.f32(), angle: r.f32(), angVel: r.f32(),
        thrusting: r.u8() / 255,
        hp: r.u16() / 10, maxHp: r.u16(),
        shield: r.u8() / 10, nitro: r.u8() / 10, stun: r.u8() / 10, emp: r.u8() / 10, invuln: r.u8() / 10,
        spinRate: r.i16() / 100,
        weapon: P.WEAPONS[r.u8()] || null, ammo: r.u8(), defer: r.u8(), reflag: r.u8(), caps: r.u8(),
        lap: r.u8(), nextCp: r.u8(), cpCount: r.u16(), place: r.u8(),
        lapStart: r.f32(), bestLap: r.f32(), finishTime: r.f32(), progress: r.f32(),
        kills: r.u16(), deaths: r.u16(), elim: r.u8(),
      });
    }
    const ns = r.u16();
    s.shots = [];
    for (let i = 0; i < ns; i++) {
      const missile = r.u8() === 1, owner = r.u8();
      s.shots.push({ type: missile ? 'missile' : 'bolt', owner: owner, x: r.f32(), y: r.f32(), vx: r.i16() / 4, vy: r.i16() / 4, angle: (r.i16() / 32767) * PI });
    }
    const nm = r.u8();
    s.mines = [];
    for (let i = 0; i < nm; i++) s.mines.push({ owner: r.u8(), x: r.f32(), y: r.f32(), t: r.u16() / 10 });
    const nw = r.u8();
    s.waves = [];
    for (let i = 0; i < nw; i++) s.waves.push({ x: r.f32(), y: r.f32(), r: r.f32() });
    const np = r.u8();
    s.pickups = [];
    for (let i = 0; i < np; i++) s.pickups.push({ on: r.u8() === 1, type: P.ITEMS[r.u8()] });
    const nr = r.u8();
    s.rocks = [];
    for (let i = 0; i < nr; i++) s.rocks.push({ dead: r.u8() === 1, x: r.f32(), y: r.f32() });
    const nf = r.u8();
    s.flags = [];
    for (let i = 0; i < nf; i++) {
      const st = P.FLAG[r.u8()] || 'home', c = r.u8();
      s.flags.push({ state: st, carrier: c === 255 ? -1 : c, x: r.f32(), y: r.f32() });
    }
    const nc = r.u8();
    s.caps = [];
    for (let i = 0; i < nc; i++) s.caps.push(r.u8());
    return s;
  };

  /* ------------------------------------------------------------ helpers */

  function clampN(x, lo, hi) { x = +x || 0; return x < lo ? lo : x > hi ? hi : x; }

  function view(buf) {
    if (!buf) return null;
    if (buf instanceof DataView) return buf;
    if (buf instanceof ArrayBuffer) return new DataView(buf);
    if (ArrayBuffer.isView(buf)) return new DataView(buf.buffer, buf.byteOffset, buf.byteLength); // Node Buffer, Uint8Array
    return null;
  }

  if (typeof module === 'object' && module.exports) module.exports = P;
  else root.RR.proto = P;
})(typeof window !== 'undefined' ? window : globalThis);
