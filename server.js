'use strict';

/*
 * Rocket Racer server — built for Google Cloud Run.
 *
 *   GET  /                    the game (static files from ./public)
 *   GET  /api/health          { ok, store }
 *   GET  /api/scores?track=   top 10 race times for a course
 *   POST /api/scores          submit a finished race
 *   GET  /healthz             liveness probe
 *
 * No framework: Node's http module plus the Firestore client.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createStore } = require('./lib/store');

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
};
const MAX_RACE = 3600;
const STORE_TIMEOUT_MS = 8000;

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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
};

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
  }, SECURITY_HEADERS);
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
  }, SECURITY_HEADERS));
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

/** Pilot names use the game's bitmap font: A-Z, 0-9 and a little punctuation. */
function cleanName(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9 _.!-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10).trim();
  return s || 'PILOT';
}

function validateScore(body) {
  if (!body || typeof body !== 'object') return 'Expected a JSON object';
  const t = TRACKS[body.track];
  if (!Object.prototype.hasOwnProperty.call(TRACKS, body.track)) return 'Unknown track';
  if (typeof body.pid !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.pid)) return 'Bad pid';
  if (typeof body.time !== 'number' || !Number.isFinite(body.time)) return 'Bad time';
  if (body.time < t.minRace || body.time > MAX_RACE) return 'Race time out of range';
  if (typeof body.lap !== 'number' || !Number.isFinite(body.lap)) return 'Bad lap';
  // the best lap can be neither impossibly quick nor slower than the whole race
  if (body.lap < t.minLap || body.lap > body.time) return 'Lap time out of range';
  if (body.lap * t.laps > body.time + 0.05) return 'Lap and race times disagree';
  if (![0, 1, 2].includes(body.diff)) return 'Bad difficulty';
  return null;
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

function createApp(store) {
  // In production the files never change, so read them once. In development
  // re-read on every request so edits show up on refresh.
  const production = process.env.NODE_ENV === 'production';
  const cached = production ? loadStatic(PUBLIC_DIR) : null;
  const allowPost = rateLimiter(20, 60 * 1000);
  const cache = new Map(); // track -> { at, scores }: spares Firestore on busy title screens
  const CACHE_MS = 5000;

  async function top(track) {
    const c = cache.get(track);
    if (c && Date.now() - c.at < CACHE_MS) return c.scores;
    const scores = await withTimeout(store.top(track, TOP_N), STORE_TIMEOUT_MS);
    cache.set(track, { at: Date.now(), scores });
    return scores;
  }

  async function api(req, res, url) {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, store: store.kind });

    if (url.pathname === '/api/scores' && req.method === 'GET') {
      const track = url.searchParams.get('track');
      if (!Object.prototype.hasOwnProperty.call(TRACKS, track)) return json(res, 400, { error: 'Unknown track' });
      return json(res, 200, { track, scores: await top(track) });
    }

    if (url.pathname === '/api/scores' && req.method === 'POST') {
      if (!allowPost(clientIp(req))) return json(res, 429, { error: 'Too many submissions, slow down' });
      let body;
      try { body = JSON.parse(await readBody(req, 2048)); } catch (e) {
        return json(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON' });
      }
      const err = validateScore(body);
      if (err) return json(res, 400, { error: err });
      const entry = {
        name: cleanName(body.name),
        // truncate to hundredths, the way the in-game clock shows times
        time: Math.floor(body.time * 100 + 1e-6) / 100,
        lap: Math.floor(body.lap * 100 + 1e-6) / 100,
        diff: body.diff,
        at: Date.now(),
      };
      const out = await withTimeout(store.submit(body.track, body.pid, entry), STORE_TIMEOUT_MS);
      cache.delete(body.track);
      return json(res, 200, { track: body.track, rank: out.rank, improved: out.improved, best: out.best, scores: await top(body.track) });
    }

    return json(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, { error: 'No such endpoint' });
  }

  return function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, 'text/plain; charset=utf-8', 'Bad request'); }

    if (url.pathname === '/healthz') return send(res, 200, 'text/plain; charset=utf-8', 'ok');
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

module.exports = { createApp, cleanName, validateScore, TRACKS };

if (require.main === module) {
  const store = createStore();
  const port = parseInt(process.env.PORT || '8080', 10);
  const server = http.createServer(createApp(store));
  server.listen(port, () => {
    console.log('Rocket Racer listening on port ' + port + ' (leaderboard store: ' + store.kind + ')');
  });
  // Cloud Run sends SIGTERM before stopping an instance: finish in-flight requests.
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
