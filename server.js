'use strict';

/*
 * Rocket Racer server — built for Google Cloud Run.
 *
 *   GET  /                    the game (static files from ./public)
 *   GET  /api/health          { ok, store, env, version }
 *   GET  /api/scores?track=   top 10 for a high score table: a course's race
 *                             times, or a fight mode's points (dogfight,
 *                             royale, ctf) (+ your own row, when the
 *                             X-Pilot-Id header carries your id)
 *   POST /api/scores          submit a finished race, or a fight's result
 *   GET  /api/history?mode=   the 10 pilots with the most wins (in one event,
 *                             or `all`) (+ your own history and rank)
 *   POST /api/history         one finished game for your history
 *   GET  /api/config          { mp }: where online play is (null when it is off)
 *   (WebSocket /ws)           online play, when this process serves it too (MP=embedded)
 *
 * (No /healthz: Cloud Run's front end keeps paths ending in "z" for itself.)
 *
 * No framework: Node's http module plus the Firestore client.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createStore } = require('./lib/store');
const { cleanName } = require('./lib/names');
const R = require('./public/src/records');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TOP_N = 10;

/*
 * Courses the leaderboard accepts, with the fastest times we will believe.
 * The floors sit well under what a perfect run can do; they only stop
 * obviously forged scores. Keep the ids in step with public/src/tracks.js.
 */
const TRACKS = {
  lunar: { laps: 3, minLap: 13, minRace: 42 },
  eight: { laps: 3, minLap: 16, minRace: 50 },
  gauntlet: { laps: 3, minLap: 25, minRace: 78 },
  indy: { laps: 5, minLap: 6.5, minRace: 34 }, // (its inside lane, hugged in a maxed Phoenix: about 8.9 s a lap)
};
const MAX_RACE = 3600;

/*
 * A time's setup: the rocket, its five stat levels, the powerups picked up
 * and used on the track (`items`, with counts), and the pilot's powerup
 * upgrade levels at the time (`levels`, 2 or 3; level 1 is left out).
 * It is only shown on the leaderboard, so it is checked for shape, not
 * against each ship's limits. Keep the lists in step with RR.HULLS, RR.STATS
 * and RR.ITEMS in public/src/game.js.
 */
const SHIPS = ['sparrow', 'dart', 'hammer', 'phoenix'];
const STAT_COUNT = 5;
const STAT_MAX = 10;
const ITEMS = ['nitro', 'shield', 'repair', 'defer', 'blaster', 'missile', 'mine', 'emp', 'reflag'];
const ITEM_MAX = 99;
const LEVEL_MAX = 3; // powerups are upgraded from level 1 to 3
const RACERS = 6; // ships on the grid, so the worst finishing place
const PID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAP_RE = /^[a-z0-9]{2,16}$/; // an arena's or flag map's id (see public/src/tracks.js)
const STORE_TIMEOUT_MS = 8000;
const GAME_GAP_MS = 5000; // a pilot's games come no closer together than this (a fight can end in seconds)
const isFight = (board) => R.FIGHTS.includes(board);
const isBoard = (board) => Object.prototype.hasOwnProperty.call(TRACKS, board) || isFight(board);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Headers on every response. The page may only load and connect to its own
 * address, plus, when online play runs as a separate service (MP_URL), that
 * service's WebSocket address: without it the browser refuses to connect.
 */
const headerCache = new Map();
function securityHeaders() {
  const mp = process.env.MP_URL || '';
  if (!headerCache.has(mp)) {
    let extra = '';
    try {
      const u = new URL(mp);
      if (u.protocol === 'wss:' || u.protocol === 'ws:') extra = ' ' + u.protocol + '//' + u.host;
    } catch (e) { /* not set, or not a URL: same origin only */ }
    headerCache.set(mp, {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self'" + extra + "; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    });
  }
  return headerCache.get(mp);
}

/* ------------------------------------------------------------- static */

/** Read ./public into memory once: the whole game is a few hundred KB. */
function loadStatic(dir) {
  const files = new Map();
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      const type = MIME[path.extname(ent.name).toLowerCase()];
      if (!type) continue; // only serve file types we know
      const buf = fs.readFileSync(full);
      const text = /^(text\/|application\/(json|manifest\+json)|image\/svg)/.test(type);
      const url = '/' + path.relative(dir, full).split(path.sep).join('/');
      files.set(url, {
        type, buf, gz: text ? zlib.gzipSync(buf, { level: 9 }) : null,
        etag: '"' + require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"',
      });
    }
  })(dir);
  return files;
}

function serveStatic(files, req, res, pathname) {
  let f = files.get(pathname === '/' ? '/index.html' : pathname);
  if (!f) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  const headers = Object.assign({
    'Content-Type': f.type,
    ETag: f.etag,
    // Always revalidate: a redeploy shows up on the next load, and an
    // unchanged file costs one tiny 304.
    'Cache-Control': 'no-cache',
    Vary: 'Accept-Encoding',
  }, securityHeaders());
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
  let body = f.buf;
  if (f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = f.gz;
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ---------------------------------------------------------------- api */

function send(res, status, type, body) {
  res.writeHead(status, Object.assign({
    'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
  }, securityHeaders()));
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', (c) => {
      if (over) return; // keep draining so the 413 below can still be delivered
      size += c.length;
      if (size > limit) { over = true; reject(Object.assign(new Error('Body too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}


function validateScore(body) {
  if (!body || typeof body !== 'object') return 'Expected a JSON object';
  if (isFight(body.track)) return validateFight(body);
  const t = TRACKS[body.track];
  if (!Object.prototype.hasOwnProperty.call(TRACKS, body.track)) return 'Unknown track';
  if (typeof body.pid !== 'string' || !PID_RE.test(body.pid)) return 'Bad pid';
  if (typeof body.time !== 'number' || !Number.isFinite(body.time)) return 'Bad time';
  if (body.time < t.minRace || body.time > MAX_RACE) return 'Race time out of range';
  if (typeof body.lap !== 'number' || !Number.isFinite(body.lap)) return 'Bad lap';
  // the best lap can be neither impossibly quick nor slower than the whole race
  if (body.lap < t.minLap || body.lap > body.time) return 'Lap time out of range';
  if (body.lap * t.laps > body.time + 0.05) return 'Lap and race times disagree';
  if (![0, 1, 2].includes(body.diff)) return 'Bad difficulty';
  if (body.auto != null && typeof body.auto !== 'boolean') return 'Bad auto'; // flown on the autopilot (optional: older pages)
  // finishing place in that race; optional so a page loaded before this existed can still post
  if (body.place != null && !(Number.isInteger(body.place) && body.place >= 1 && body.place <= RACERS)) return 'Bad place';
  // the rocket and powerups behind the time; optional, as pages from before it existed do not send one
  if (body.setup != null) return setupError(body.setup);
  return null;
}

/**
 * A fight's result for its mode's table: { track: 'dogfight' | 'royale' |
 * 'ctf', pid, name, diff, map, result, setup }. The result must be one the
 * rules allow (records.js); its points are worked out here, never taken
 * from the caller.
 */
function validateFight(body) {
  if (typeof body.pid !== 'string' || !PID_RE.test(body.pid)) return 'Bad pid';
  if (![0, 1, 2].includes(body.diff)) return 'Bad difficulty';
  if (body.map != null && !(typeof body.map === 'string' && MAP_RE.test(body.map))) return 'Bad map';
  const err = R.check(body.track, body.result);
  if (err) return err;
  if (body.setup != null) return setupError(body.setup);
  return null;
}

/** One finished game for a pilot's history: { pid, name, mode, place, win }. */
function validateGame(body) {
  if (!body || typeof body !== 'object') return 'Expected a JSON object';
  if (typeof body.pid !== 'string' || !PID_RE.test(body.pid)) return 'Bad pid';
  return R.checkGame(body.mode, body.place, body.win);
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function setupError(s) {
  if (!isMap(s)) return 'Bad setup';
  if (!SHIPS.includes(s.ship)) return 'Unknown ship';
  if (!Array.isArray(s.stats) || s.stats.length !== STAT_COUNT ||
    !s.stats.every((v) => Number.isInteger(v) && v >= 1 && v <= STAT_MAX)) return 'Bad stats';
  // items: picked up on the track and used, item -> how many; levels: upgrade levels, item -> 1-3
  for (const [list, max] of [[s.items, ITEM_MAX], [s.levels, LEVEL_MAX]]) {
    if (list == null) continue;
    if (!isMap(list)) return 'Bad items';
    for (const k of Object.keys(list)) {
      if (!ITEMS.includes(k)) return 'Unknown item';
      const v = list[k];
      if (!Number.isInteger(v) || v < 0 || v > max) return 'Bad item count';
    }
  }
  return null;
}

/** A setup that passed setupError, reduced to exactly what is stored (unused items dropped). */
function cleanSetup(s) {
  if (s == null) return null;
  const pick = (list) => {
    const out = {};
    for (const k of ITEMS) if (list && list[k] > 0) out[k] = list[k];
    return out;
  };
  const levels = {};
  for (const k of ITEMS) if (s.levels && s.levels[k] > 1) levels[k] = s.levels[k]; // level 1 is the default
  return { ship: s.ship, stats: s.stats.slice(), items: pick(s.items), levels };
}

/** Give up on a slow backend call so a request never hangs on Firestore. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Leaderboard store timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Fixed-window limiter, per instance. Good enough to blunt a flood. */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    return ++h.n <= max;
  };
}

function clientIp(req) {
  // Google's front end appends the address it saw as the last X-Forwarded-For
  // hop, so unlike the first hop it cannot be forged by the caller.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'unknown';
}

/**
 * A leaderboard row from a checked submission. `online`: timed (or refereed)
 * by the multiplayer server itself, which alone can say the rocket was lent
 * (by an invite link: see lib/mp.js); a row is marked `lent` only then.
 */
function makeEntry(body, online) {
  const lent = !!(online && body.lent === true);
  if (isFight(body.track)) {
    return {
      name: cleanName(body.name), score: R.score(body.track, body.result, body.diff), diff: body.diff,
      map: body.map || null, result: R.clean(body.track, body.result), setup: cleanSetup(body.setup), online: !!online, lent, at: Date.now(),
    };
  }
  return {
    name: cleanName(body.name),
    // truncate to hundredths, the way the in-game clock shows times
    time: Math.floor(body.time * 100 + 1e-6) / 100,
    lap: Math.floor(body.lap * 100 + 1e-6) / 100,
    diff: body.diff,
    place: body.place == null ? null : body.place,
    setup: cleanSetup(body.setup),
    online: !!online,
    lent,
    auto: body.auto === true, // the autopilot flew it (as the page, or online the server, says)
    at: Date.now(),
  };
}

/**
 * How the multiplayer server records an online race or fight: the same
 * checks as a posted one, marked `online` (the server refereed it, so it is
 * trustworthy).
 */
function onlineRecorder(store, log) {
  log = log || console.error;
  return function (body) {
    const err = validateScore(body);
    if (err) { log('online result refused: ' + err); return Promise.resolve(null); }
    return withTimeout(store.submit(body.track, body.pid, makeEntry(body, true)), STORE_TIMEOUT_MS)
      .catch((e) => { log('online result not stored: ' + (e && e.message || e)); return null; });
  };
}

/** How the multiplayer server adds an online game to a player's history (it saw the game: no gap needed). */
function onlineHistory(store, log) {
  log = log || console.error;
  return function (body) {
    const err = validateGame(body);
    if (err) { log('online game refused: ' + err); return Promise.resolve(null); }
    return withTimeout(store.addGame(body.pid, cleanName(body.name), body.mode, body.place, body.win, 0), STORE_TIMEOUT_MS)
      .catch((e) => { log('online game not stored: ' + (e && e.message || e)); return null; });
  };
}

/** Everything the multiplayer server records: race times (`post`), fights' points (`postScore`), and games (`postGame`). */
function onlineRecorders(store, log) {
  const record = onlineRecorder(store, log);
  return { post: record, postScore: record, postGame: onlineHistory(store, log) };
}

/** Where the game finds online play: MP_URL (a separate service), this server's /ws, or nowhere. */
function mpUrl(env) {
  if (env.MP_URL) return env.MP_URL;
  return env.MP === 'embedded' ? '/ws' : null;
}

function createApp(store) {
  // In production the files never change, so read them once. In development
  // re-read on every request so edits show up on refresh.
  const production = process.env.NODE_ENV === 'production';
  const cached = production ? loadStatic(PUBLIC_DIR) : null;
  const allowPost = rateLimiter(20, 60 * 1000), allowGame = rateLimiter(20, 60 * 1000);
  const cache = new Map(); // board (or 'pilots:' + mode) -> { at, rows }: spares Firestore on busy title screens
  const CACHE_MS = 5000;

  async function memo(key, load) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < CACHE_MS) return c.rows;
    const rows = await withTimeout(load(), STORE_TIMEOUT_MS);
    cache.set(key, { at: Date.now(), rows });
    return rows;
  }
  const top = (board) => memo(board, () => store.top(board, TOP_N));
  const pilots = (mode) => memo('pilots:' + mode, () => store.pilots(mode, TOP_N));
  const pidOf = (req) => { const pid = req.headers['x-pilot-id']; return typeof pid === 'string' && PID_RE.test(pid) ? pid : null; };

  async function api(req, res, url) {
    if (url.pathname === '/api/config') return json(res, 200, { mp: mpUrl(process.env) });
    if (url.pathname === '/api/health') {
      // `env` and `version` say which deployment answered: handy for staging and for "is my change live?"
      return json(res, 200, {
        ok: true, store: store.kind, env: process.env.APP_ENV || 'production', version: process.env.COMMIT_SHA || 'dev',
      });
    }

    if (url.pathname === '/api/scores' && req.method === 'GET') {
      const track = url.searchParams.get('track');
      if (!isBoard(track)) return json(res, 400, { error: 'Unknown track' });
      // The caller's own row and world rank, if they say who they are. The id
      // travels in a header rather than the URL so it stays out of request logs.
      const pid = pidOf(req);
      const me = pid ? await withTimeout(store.find(track, pid), STORE_TIMEOUT_MS) : null;
      return json(res, 200, { track, scores: await top(track), me });
    }

    if (url.pathname === '/api/history' && req.method === 'GET') {
      const mode = url.searchParams.get('mode') || 'all';
      if (mode !== 'all' && !R.MODES.includes(mode)) return json(res, 400, { error: 'Unknown event' });
      const pid = pidOf(req);
      const me = pid ? await withTimeout(store.pilot(pid, mode), STORE_TIMEOUT_MS) : null;
      return json(res, 200, { mode, pilots: await pilots(mode), me });
    }

    if (url.pathname === '/api/history' && req.method === 'POST') {
      if (!allowGame(clientIp(req))) return json(res, 429, { error: 'Too many submissions, slow down' });
      let body;
      try { body = JSON.parse(await readBody(req, 1024)); } catch (e) {
        return json(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON' });
      }
      const err = validateGame(body);
      if (err) return json(res, 400, { error: err });
      const out = await withTimeout(store.addGame(body.pid, cleanName(body.name), body.mode, body.place, body.win, GAME_GAP_MS), STORE_TIMEOUT_MS);
      if (out.tooSoon) return json(res, 429, { error: 'Games that close together cannot be real' });
      for (const m of ['all', body.mode]) cache.delete('pilots:' + m);
      return json(res, 200, { history: out.history });
    }

    if (url.pathname === '/api/scores' && req.method === 'POST') {
      if (!allowPost(clientIp(req))) return json(res, 429, { error: 'Too many submissions, slow down' });
      let body;
      try { body = JSON.parse(await readBody(req, 2048)); } catch (e) {
        return json(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON' });
      }
      const err = validateScore(body);
      if (err) return json(res, 400, { error: err });
      const entry = makeEntry(body, false);
      const out = await withTimeout(store.submit(body.track, body.pid, entry), STORE_TIMEOUT_MS);
      cache.delete(body.track);
      return json(res, 200, { track: body.track, rank: out.rank, improved: out.improved, best: out.best, scores: await top(body.track) });
    }

    return json(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, { error: 'No such endpoint' });
  }

  return function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, 'text/plain; charset=utf-8', 'Bad request'); }

    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((e) => {
        // Most likely Firestore is unreachable or not set up; the game
        // carries on with local records when it sees a 5xx.
        console.error('API error on ' + req.method + ' ' + url.pathname + ': ' + (e && e.stack || e));
        if (!res.headersSent) json(res, 503, { error: 'Leaderboard unavailable' });
        else res.end();
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    serveStatic(cached || loadStatic(PUBLIC_DIR), req, res, decodeURIComponentSafe(url.pathname));
  };
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

module.exports = {
  createApp, cleanName, validateScore, validateGame, cleanSetup, onlineRecorder, onlineHistory, onlineRecorders, mpUrl, TRACKS, SHIPS, ITEMS,
};

if (require.main === module) {
  const store = createStore();
  const port = parseInt(process.env.PORT || '8080', 10);
  const server = http.createServer(createApp(store));
  // MP=embedded: serve online play from this process too (local development; see mp-server.js for Cloud Run)
  const hub = process.env.MP === 'embedded'
    ? require('./lib/mp').attachMultiplayer(server, Object.assign({ log: console.error }, onlineRecorders(store))) : null;
  server.listen(port, () => {
    console.log('Rocket Racer listening on port ' + port + ' (leaderboard store: ' + store.kind + (hub ? ', online play on /ws' : '') + ')');
  });
  // Cloud Run sends SIGTERM before stopping an instance: finish in-flight requests.
  process.on('SIGTERM', () => {
    if (hub) hub.shutdown('update');
    server.close(() => process.exit(0));
  });
}
