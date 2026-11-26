/* ==========================================================================
 * ROCKET RACER — net.js
 * Talks to the leaderboard and pilot history API served alongside the game
 * (see server.js).
 * Everything here is optional: opened from a plain file or a static host,
 * the game notices there is no API and keeps to local records.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR;
  const N = (RR.net = {
    online: false, // true once /api/health has answered
    // high score tables: a course's id -> [{ name, time, lap, diff, place, setup }] (setup is null on rows from
    // before it was recorded); a fight mode's -> [{ name, score, diff, place, map, result, setup }]
    boards: {},
    me: {}, // table -> this player's own row plus world `rank`, or null if they have no row yet
    pilots: {}, // event ('all', 'race', ...) -> the pilots with the most wins [{ name, played, wins, p1, p2, p3 }]
    history: null, // this player's history on the server, with `rank` by wins in all events (see loadPilots)
    env: 'production', version: '', // which deployment we are talking to (see /api/health)
    mp: null, // where online play is (see /api/config): a wss:// URL or a path on this server; null when it is off
    failed: {}, // table (or 'pilots:' + event) -> true when the last fetch of it failed
    result: null, // outcome of the last submission: { track, rank, improved, best } | { error }
    busy: false,
  });

  function api(path, opts) {
    const ctl = window.AbortController ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, 7000) : 0;
    opts = opts || {};
    if (ctl) opts.signal = ctl.signal;
    // relative URL, so the game works from any path it is hosted under
    return fetch('api/' + path, opts).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  N.init = function () {
    if (!window.fetch || window.location.protocol === 'file:') return;
    api('config').then(function (d) { N.mp = d && typeof d.mp === 'string' ? d.mp : null; }).catch(function () { N.mp = null; });
    api('health').then(function (d) {
      N.online = !!(d && d.ok);
      if (d && typeof d.env === 'string') N.env = d.env;
      if (d && typeof d.version === 'string') N.version = d.version;
      if (N.online) {
        RR.TRACKS.forEach(function (t) { N.load(t.id); });
        RR.records.FIGHTS.forEach(N.load);
      }
    }).catch(function () { N.online = false; });
  };

  N.load = function (track) {
    if (!N.online) return;
    // the id header asks the server to include our own row and world rank
    const pid = RR.game && RR.game.pid;
    api('scores?track=' + encodeURIComponent(track), pid ? { headers: { 'X-Pilot-Id': pid } } : {}).then(function (d) {
      if (d && Array.isArray(d.scores)) {
        N.boards[track] = d.scores;
        N.me[track] = d.me || null;
        N.failed[track] = false;
      }
    }).catch(function () { N.failed[track] = true; /* keep whatever we had */ });
  };

  /** The pilots with the most wins in `mode` ('all' for every event), and this player's own history and rank. */
  N.loadPilots = function (mode) {
    mode = mode || 'all';
    if (!N.online) return;
    const pid = RR.game && RR.game.pid;
    api('history?mode=' + encodeURIComponent(mode), pid ? { headers: { 'X-Pilot-Id': pid } } : {}).then(function (d) {
      if (d && Array.isArray(d.pilots)) {
        N.pilots[mode] = d.pilots;
        if (mode === 'all') N.history = d.me || null;
        N.failed['pilots:' + mode] = false;
      }
    }).catch(function () { N.failed['pilots:' + mode] = true; });
  };

  /**
   * A finished race or fight for its high score table. A race's entry:
   * { name, pid, time, lap, diff, place, setup } — `place` is the finishing
   * position; `setup` is { ship, stats, items, levels }: the rocket flown, its
   * five stat levels, how many of each powerup were picked up and used, and
   * the pilot's powerup upgrade levels. A fight's (track = its mode):
   * { name, pid, diff, map, result, setup }, `result` as public/src/records.js
   * describes it (the server works out the points).
   */
  N.submit = function (track, entry) {
    N.result = null;
    if (!N.online) return;
    N.busy = true;
    api('scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ track: track }, entry)),
    }).then(function (d) {
      N.busy = false;
      N.result = { track: track, rank: d.rank, improved: d.improved, best: d.best };
      if (Array.isArray(d.scores)) N.boards[track] = d.scores;
      if (d.best) { N.me[track] = d.best; N.me[track].rank = d.rank; }
    }).catch(function () {
      N.busy = false;
      N.result = { track: track, error: true };
    });
  };

  /**
   * One finished game (played offline: online, the server records it) for
   * this player's history on the server. The server takes a pilot's games
   * no closer together than a few seconds, so they queue here and go
   * GAME_GAP_MS apart.
   */
  const GAME_GAP_MS = 6000, games = [];
  let lastGame = 0, gameTimer = 0;
  N.game = function (mode, place, win) {
    if (!N.online) return;
    games.push({ mode: mode, place: place, win: win });
    if (games.length > 30) games.shift();
    sendGames();
  };
  function sendGames() {
    if (gameTimer || !games.length) return;
    gameTimer = setTimeout(function () {
      gameTimer = 0;
      const x = games.shift(), g = RR.game;
      lastGame = Date.now();
      api('history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: g.pid, name: g.name, mode: x.mode, place: x.place, win: x.win }),
      }).then(function () { N.loadPilots('all'); }).catch(function () { /* the local history still has it */ });
      sendGames();
    }, Math.max(0, lastGame + GAME_GAP_MS - Date.now()));
  }

  /** Same rule as the server: the characters our bitmap font can draw. */
  N.cleanName = function (raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9 _.!-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10).trim();
  };

  N.randomName = function () {
    const words = ['COMET', 'ZIPPY', 'TURBO', 'DONUT', 'ROCKY', 'ASTRO', 'PIXEL', 'BLAZE', 'ORBIT', 'QUASAR', 'SPRINKLE'];
    return words[Math.floor(Math.random() * words.length)] + (10 + Math.floor(Math.random() * 90));
  };

  N.randomId = function () {
    const a = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    let s = '';
    for (let i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return s;
  };
})();
