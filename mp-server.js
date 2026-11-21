'use strict';

/*
 * Rocket Racer online play, on its own: the Cloud Run service
 * rocketracer-mp (and rocketracer-mp-staging). Same image as the game's
 * service, started with `node mp-server.js`.
 *
 *   GET  /api/health    { ok, mp, env, version, rooms, players, connections }
 *   WebSocket /ws       online play (lib/mp.js)
 *
 * Environment: PORT, APP_ENV, COMMIT_SHA, STORE / LEADERBOARD_COLLECTION
 * (where online race times are recorded, as for the game's service), and
 * MP_ORIGINS: the pages allowed to connect, comma separated (all when unset).
 */

const http = require('http');
const { createStore } = require('./lib/store');
const { attachMultiplayer } = require('./lib/mp');
const { onlineRecorder } = require('./server');

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function createMpServer(store, env) {
  env = env || process.env;
  let hub = null;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/api/health') {
      return json(res, 200, Object.assign({
        ok: true, mp: true, store: store.kind, env: env.APP_ENV || 'production', version: env.COMMIT_SHA || 'dev',
      }, hub ? hub.stats() : {}));
    }
    if (path === '/') return json(res, 200, { ok: true, service: 'Rocket Racer online play', ws: '/ws' });
    return json(res, 404, { error: 'Not found' });
  });
  const origins = env.MP_ORIGINS ? env.MP_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : null;
  hub = attachMultiplayer(server, { post: onlineRecorder(store), origins, log: console.error });
  server.hub = hub;
  return server;
}

module.exports = { createMpServer };

if (require.main === module) {
  const store = createStore();
  const port = parseInt(process.env.PORT || '8080', 10);
  const server = createMpServer(store);
  server.listen(port, () => console.log('Rocket Racer online play on port ' + port + ' (leaderboard store: ' + store.kind + ')'));
  // Cloud Run sends SIGTERM before replacing or stopping an instance: tell the players, then go
  process.on('SIGTERM', () => {
    server.hub.shutdown('update');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
