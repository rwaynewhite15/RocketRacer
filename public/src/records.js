/* ==========================================================================
 * ROCKET RACER — records.js
 * What the high score tables and pilot histories hold, and the rules for
 * them: shared by the game (window.RR.records) and the server
 * (require('./public/src/records')), so both count the same way.
 *
 * High scores. A Grand Prix's tables are its courses' race times. Each
 * fight mode has a table of points, one match's worth:
 *
 *   DOGFIGHT          100 a kill, -25 a loss, 300 / 150 / 75 for 1st / 2nd /
 *                     3rd, and a win by kills scores 2 for every second
 *                     still left on the clock
 *   BATTLE ROYALE     100 a kill, 500 / 300 / 200 / 100 / 50 for 1st to 5th
 *   CAPTURE THE FLAG  300 a flag captured, 100 a flag returned, 50 a kill,
 *                     300 when your team wins
 *
 * all times 1.5 against Pilot rivals and 2 against Aces, never below 0.
 *
 * Histories. Each pilot's games played, wins and 1st / 2nd / 3rd place
 * finishes, for each event and in all. A win is a 1st place, except in
 * capture the flag, where it is your team's: the team with the most flags.
 * ======================================================================== */
(function (root) {
  'use strict';

  const R = {
    // the events, as the tables and histories name them, with their menu names
    MODES: ['race', 'dogfight', 'royale', 'ctf'],
    NAMES: { race: 'GRAND PRIX', dogfight: 'DOGFIGHT', royale: 'BATTLE ROYALE', ctf: 'CAPTURE THE FLAG', all: 'ALL EVENTS' },
    FIGHTS: ['dogfight', 'royale', 'ctf'], // the modes with a table of points
    DIFF_MULT: [1, 1.5, 2], // rookie, pilot, ace rivals
    // the rules the points depend on (keep in step with RR.CFG in game.js)
    KILL_TARGET: 5, DOGFIGHT_TIME: 180, CTF_CAPS: 3, SHIPS: 6,
    COUNTS: ['played', 'wins', 'p1', 'p2', 'p3'], // a history's numbers, for each event
  };

  const DOG_PLACE = [300, 150, 75, 0, 0, 0], ROYALE_PLACE = [500, 300, 200, 100, 50, 0];

  /**
   * A match's points (see the top). `r`: { place 1-6, kills, deaths, caps,
   * returns, win, left } - `left`: seconds left on a dogfight's clock when
   * it was won; `diff`: 0-2.
   */
  R.score = function (mode, r, diff) {
    let pts;
    if (mode === 'dogfight') pts = r.kills * 100 - r.deaths * 25 + DOG_PLACE[r.place - 1] + (r.win ? Math.floor(r.left || 0) * 2 : 0);
    else if (mode === 'royale') pts = r.kills * 100 + ROYALE_PLACE[r.place - 1];
    else pts = (r.caps || 0) * 300 + (r.returns || 0) * 100 + r.kills * 50 + (r.win ? 300 : 0);
    return Math.max(0, Math.floor(pts * (R.DIFF_MULT[diff] || 1)));
  };

  /** How a fight's points are made, in a few short lines for the table's foot. */
  R.explain = function (mode) {
    const mult = 'X1.5 VS PILOTS  X2 VS ACES';
    if (mode === 'dogfight') return ['KILL 100  LOSS -25', '1ST 300  2ND 150  3RD 75', 'WIN BY KILLS: +2 A SECOND LEFT', mult];
    if (mode === 'royale') return ['KILL 100', '1ST 500  2ND 300  3RD 200', '4TH 100  5TH 50', mult];
    return ['FLAG 300  RETURN 100  KILL 50', 'YOUR TEAM WINS +300', mult];
  };

  const int = function (v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; };

  /**
   * Could a fight have ended this way? An error message, or null. The
   * numbers must be ones the rules allow: no more kills than a dogfight
   * lasts for (it ends at KILL_TARGET) or than a battle royale has rivals,
   * one life in a battle royale, a win where there is a 1st place (except in
   * capture the flag, where the team wins), time left only on a win by
   * kills, and no more flags than end a match.
   */
  R.check = function (mode, r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'Bad result';
    if (!int(r.place, 1, R.SHIPS)) return 'Bad place';
    if (typeof r.win !== 'boolean') return 'Bad win';
    if (mode !== 'ctf' && r.win !== (r.place === 1)) return 'Win and place disagree';
    if (!int(r.kills, 0, mode === 'ctf' ? 99 : mode === 'dogfight' ? R.KILL_TARGET : R.SHIPS - 1)) return 'Bad kills';
    if (!int(r.deaths, 0, mode === 'royale' ? 1 : 99)) return 'Bad deaths';
    if (mode === 'dogfight') {
      if (!int(r.left, 0, R.DOGFIGHT_TIME)) return 'Bad time left';
      if (r.left > 0 && !(r.win && r.kills === R.KILL_TARGET)) return 'Time left without a win by kills';
    }
    if (mode === 'ctf' && (!int(r.caps, 0, R.CTF_CAPS) || !int(r.returns, 0, 99))) return 'Bad flags';
    return null;
  };

  /** A result reduced to what is kept (the fields its mode uses). */
  R.clean = function (mode, r) {
    const out = { place: r.place, win: r.win, kills: r.kills, deaths: r.deaths };
    if (mode === 'dogfight') out.left = r.left;
    if (mode === 'ctf') { out.caps = r.caps; out.returns = r.returns; }
    return out;
  };

  /** Capture the flag: the team with the most flags, or -1 while two or more share the most. */
  R.leader = function (caps) {
    let best = -1, top = -1, shared = false;
    caps.forEach(function (c, side) {
      if (c > top) { top = c; best = side; shared = false; } else if (c === top) shared = true;
    });
    return shared ? -1 : best;
  };

  /* ------------------------------------------------------------ histories */

  /** An empty history: every event, and all of them, at nought. */
  R.emptyHistory = function () {
    const h = {};
    R.MODES.concat('all').forEach(function (m) {
      h[m] = {};
      R.COUNTS.forEach(function (k) { h[m][k] = 0; });
    });
    return h;
  };

  /** One more game in history `h` (changed in place): `place` 1-6, `win` true or false. */
  R.addGame = function (h, mode, place, win) {
    [mode, 'all'].forEach(function (m) {
      const c = h[m];
      c.played++;
      if (win) c.wins++;
      if (place <= 3) c['p' + place]++;
    });
    return h;
  };

  /** A history as saved somewhere we do not trust (a browser's storage): whole numbers only, nothing impossible. */
  R.cleanHistory = function (raw) {
    const h = R.emptyHistory();
    if (!raw || typeof raw !== 'object') return h;
    R.MODES.forEach(function (m) {
      const c = raw[m] || {}, out = h[m];
      R.COUNTS.forEach(function (k) { out[k] = Number.isInteger(c[k]) && c[k] > 0 ? c[k] : 0; });
      out.wins = Math.min(out.wins, out.played);
      const pods = out.p1 + out.p2 + out.p3;
      if (pods > out.played) { out.p1 = out.p2 = out.p3 = 0; }
      R.COUNTS.forEach(function (k) { h.all[k] += out[k]; });
    });
    return h;
  };

  /** Is a game for the history one that can happen? An error message, or null. */
  R.checkGame = function (mode, place, win) {
    if (R.MODES.indexOf(mode) < 0) return 'Unknown event';
    if (!int(place, 1, R.SHIPS)) return 'Bad place';
    if (typeof win !== 'boolean') return 'Bad win';
    if (mode !== 'ctf' && win !== (place === 1)) return 'Win and place disagree';
    return null;
  };

  if (typeof module === 'object' && module.exports) module.exports = R;
  else root.RR.records = R;
})(typeof window !== 'undefined' ? window : globalThis);
