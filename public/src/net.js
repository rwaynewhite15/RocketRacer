/* ==========================================================================
 * ROCKET RACER — net.js
 * Talks to the leaderboard API served alongside the game (see server.js).
 * Everything here is optional: opened from a plain file or a static host,
 * the game notices there is no API and keeps to local records.
 * ======================================================================== */
(function () {
  'use strict';

  const RR = window.RR;
  const N = (RR.net = {
    online: false, // true once /api/health has answered
    boards: {}, // track id -> [{ name, time, lap, diff, place }]
    me: {}, // track id -> this player's own row plus world `rank`, or null if they have no time yet
    env: 'production', version: '', // which deployment we are talking to (see /api/health)
    failed: {}, // track id -> true when the last fetch of that board failed
    result: null, // outcome of the last submission: { track, rank, improved } | { error }
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
    api('health').then(function (d) {
      N.online = !!(d && d.ok);
      if (d && typeof d.env === 'string') N.env = d.env;
      if (d && typeof d.version === 'string') N.version = d.version;
      if (N.online) RR.TRACKS.forEach(function (t) { N.load(t.id); });
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

  /** entry: { name, pid, time, lap, diff, place } — `place` is the finishing position in that race */
  N.submit = function (track, entry) {
    N.result = null;
    if (!N.online) return;
    N.busy = true;
    api('scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track: track, name: entry.name, pid: entry.pid, time: entry.time, lap: entry.lap, diff: entry.diff, place: entry.place,
      }),
    }).then(function (d) {
      N.busy = false;
      N.result = { track: track, rank: d.rank, improved: d.improved };
      if (Array.isArray(d.scores)) N.boards[track] = d.scores;
      if (d.best) { N.me[track] = d.best; N.me[track].rank = d.rank; }
    }).catch(function () {
      N.busy = false;
      N.result = { track: track, error: true };
    });
  };

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
