#!/usr/bin/env node
'use strict';

/*
 * Smoke test for an online-play service: open a private room over the
 * WebSocket, get READY, and check that the race starts and snapshots flow.
 * Used by tools/ci-deploy.sh on a new revision before it gets traffic.
 *
 *   node tools/mp-smoke.js wss://candidate---rocketracer-mp-....run.app/ws
 *
 * Exits 0 when it all works, 1 (with the reason) when it does not.
 */

const P = require('../public/src/proto');

const url = process.argv[2];
if (!url) { console.error('usage: mp-smoke.js <wss://host/ws>'); process.exit(2); }
const WS = globalThis.WebSocket || require('ws');
const fail = (why) => { console.error('FAILED: ' + why); process.exit(1); };
const timer = setTimeout(() => fail('no race within 20 s'), 20000);

const ws = new WS(url);
ws.binaryType = 'arraybuffer';
let snaps = 0;
const send = (m) => ws.send(JSON.stringify(m));
ws.onerror = (e) => fail('could not connect: ' + (e && e.message || 'error'));
ws.onopen = () => send({ t: 'hello', v: P.VERSION, name: 'SMOKE TEST' });
ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') {
    const s = P.decodeSnap(ev.data);
    if (!s || s.ships.length !== 6) fail('a bad snapshot');
    if (++snaps === 5) {
      console.log('  ok: snapshots arrive (' + s.ships.length + ' ships, ' + ev.data.byteLength + ' bytes)');
      send({ t: 'leave' });
      clearTimeout(timer);
      ws.close();
      setTimeout(() => process.exit(0), 100);
    }
    return;
  }
  const m = JSON.parse(ev.data);
  if (m.t === 'error') fail('the server said: ' + m.code);
  if (m.t === 'welcome') { console.log('  ok: the server speaks protocol ' + P.VERSION); send({ t: 'create', mode: 'race', track: 0, diff: 1, setup: {} }); }
  if (m.t === 'room' && m.room.state === 'lobby' && !m.room.humans[0].ready) { console.log('  ok: a private room opens (' + m.room.code + ')'); send({ t: 'ready', on: true }); }
  if (m.t === 'start') console.log('  ok: the race starts with ' + m.opts.seats.length + ' ships');
};
