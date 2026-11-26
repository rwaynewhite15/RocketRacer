'use strict';

/*
 * Leaderboard and pilot history storage.
 *
 *   firestore  Google Cloud Firestore (used on Cloud Run)
 *   memory     in-process maps, for local development and tests
 *
 * Both expose the same async methods. High score tables, one per `board`:
 * a course's id (race times, fastest first) or a fight mode's
 * (`dogfight`, `royale`, `ctf`: points, most first; see public/src/records.js):
 *
 *   top(board, n)             -> rows, best first
 *   submit(board, pid, entry) -> { improved, best, rank }
 *   find(board, pid)          -> that player's row plus `rank`, or null
 *
 * A race row is { name, time, lap, diff, place, setup, online, lent, at }: `place`
 * is where the pilot finished in that race (1-6) and `setup` the rocket,
 * stat levels and powerups used ({ ship, stats, items, levels }); rows
 * written before either existed have null; `lent`: set in a rocket an invite
 * link lent (see lib/mp.js). A fight row is { name, score,
 * diff, place, map, result, setup, online, lent, at }: `result` is the match as
 * records.js describes it, and `map` the arena or flag map. Each player
 * (anonymous id `pid`) owns one row per table; a submission only replaces
 * it when it is better.
 *
 * Pilot histories: games played, wins and 1st / 2nd / 3rd place finishes,
 * for each event and in all (records.js), one per player:
 *
 *   addGame(pid, name, mode, place, win, minGapMs) -> { history } | { tooSoon: true }
 *   pilots(mode, n)           -> the n pilots with the most wins in `mode` ('all' for every event)
 *   pilot(pid, mode)          -> that player's history plus `rank` by wins in `mode`, or null
 *
 * `minGapMs` turns away a game that comes too soon after the same pilot's
 * last one (a flood of made-up games); the multiplayer server, which saw
 * the game itself, passes 0.
 */

const R = require('../public/src/records');

const isScore = (board) => R.FIGHTS.includes(board);
/** Is row a better than row b on this board? */
const better = (board, a, b) => (isScore(board) ? a.score > b.score : a.time < b.time);

function publicEntry(e) {
  if (e.score != null) {
    return {
      name: e.name, score: e.score, diff: e.diff, place: e.result ? e.result.place : null, map: e.map || null,
      result: e.result || null, setup: e.setup || null, online: !!e.online, lent: !!e.lent, at: e.at,
    };
  }
  return {
    name: e.name, time: e.time, lap: e.lap, diff: e.diff, place: e.place == null ? null : e.place,
    setup: e.setup || null, online: !!e.online, lent: !!e.lent, at: e.at,
  };
}

/** One event's (or all events') numbers from a history, with the pilot's name. */
function publicPilot(d, mode) {
  const c = (d && d[mode]) || {};
  const out = { name: d.name };
  for (const k of R.COUNTS) out[k] = c[k] || 0;
  return out;
}

/** A whole history, as its owner sees it. */
function publicHistory(d) {
  const out = { name: d.name };
  for (const m of R.MODES.concat('all')) out[m] = publicPilot(d, m);
  for (const m of R.MODES.concat('all')) delete out[m].name;
  return out;
}

/** Fewer wins first in a ranking? (Ties: more 1st places, then fewer games, ahead.) */
const pilotOrder = (mode) => (a, b) => {
  const x = a[mode] || {}, y = b[mode] || {};
  return (y.wins || 0) - (x.wins || 0) || (y.p1 || 0) - (x.p1 || 0) || (x.played || 0) - (y.played || 0);
};

/**
 * Firestore collection the boards live under. A staging service points this
 * somewhere else (LEADERBOARD_COLLECTION) so test runs never touch real scores.
 */
function collectionName(env) {
  const name = env.LEADERBOARD_COLLECTION || 'rocketracer';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('Bad LEADERBOARD_COLLECTION "' + name + '"');
  return name;
}

function memoryStore() {
  const boards = new Map(); // board -> Map(pid -> entry)
  const histories = new Map(); // pid -> { name, at, race: {...}, ..., all: {...} }
  const board = (id) => {
    if (!boards.has(id)) boards.set(id, new Map());
    return boards.get(id);
  };
  const rankOf = (id, row) => {
    let rank = 1;
    for (const e of board(id).values()) if (better(id, e, row)) rank++;
    return rank;
  };
  return {
    kind: 'memory',
    async top(id, n) {
      return [...board(id).values()].sort((a, b) => (isScore(id) ? b.score - a.score : a.time - b.time)).slice(0, n).map(publicEntry);
    },
    async submit(id, pid, entry) {
      const b = board(id), cur = b.get(pid);
      let improved = false, best = entry;
      if (cur && !better(id, entry, cur)) {
        cur.name = entry.name; // keep the better row, follow a renamed pilot
        best = cur;
      } else {
        b.set(pid, entry);
        improved = true;
      }
      return { improved, best: publicEntry(best), rank: rankOf(id, best) };
    },
    async find(id, pid) {
      const cur = board(id).get(pid);
      return cur ? Object.assign(publicEntry(cur), { rank: rankOf(id, cur) }) : null;
    },
    async addGame(pid, name, mode, place, win, minGapMs) {
      const now = Date.now(), cur = histories.get(pid);
      if (cur && minGapMs && now - cur.at < minGapMs) return { tooSoon: true };
      const d = cur || Object.assign({ name, at: 0 }, R.emptyHistory());
      d.name = name; d.at = now;
      R.addGame(d, mode, place, win);
      histories.set(pid, d);
      return { history: publicHistory(d) };
    },
    async pilots(mode, n) {
      return [...histories.values()].filter((d) => d[mode].played > 0).sort(pilotOrder(mode)).slice(0, n).map((d) => publicPilot(d, mode));
    },
    async pilot(pid, mode) {
      const d = histories.get(pid);
      if (!d) return null;
      let rank = 1;
      for (const o of histories.values()) if (o[mode].wins > d[mode].wins) rank++;
      return Object.assign(publicHistory(d), { rank });
    },
  };
}

function firestoreStore(env) {
  // Required lazily so local development works without Google credentials.
  const { Firestore } = require('@google-cloud/firestore');
  const opts = {};
  if (env.FIRESTORE_DATABASE) opts.databaseId = env.FIRESTORE_DATABASE;
  const db = new Firestore(opts);
  // {collection}/{board}/scores/{pid} — ordering by `time` or `score` within one
  // sub-collection needs only Firestore's automatic single-field indexes.
  // {collection}/pilots/history/{pid} — ordered by `<event>.wins`, again a single field.
  const root = collectionName(env);
  const scores = (id) => db.collection(root).doc(id).collection('scores');
  const histories = () => db.collection(root).doc('pilots').collection('history');
  const key = (id) => (isScore(id) ? 'score' : 'time');
  const ahead = (id, row) => scores(id).where(key(id), isScore(id) ? '>' : '<', row[key(id)]).count().get();

  return {
    kind: 'firestore',
    async top(id, n) {
      const snap = await scores(id).orderBy(key(id), isScore(id) ? 'desc' : 'asc').limit(n).get();
      return snap.docs.map((d) => publicEntry(d.data()));
    },
    async submit(id, pid, entry) {
      const ref = scores(id).doc(pid);
      const res = await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        if (cur.exists && !better(id, entry, cur.data())) {
          const kept = cur.data();
          if (kept.name !== entry.name) tx.update(ref, { name: entry.name });
          return { improved: false, best: Object.assign({}, kept, { name: entry.name }) };
        }
        tx.set(ref, entry);
        return { improved: true, best: entry };
      });
      const n = await ahead(id, res.best);
      return { improved: res.improved, best: publicEntry(res.best), rank: n.data().count + 1 };
    },
    async find(id, pid) {
      const snap = await scores(id).doc(pid).get();
      if (!snap.exists) return null;
      const e = snap.data(), n = await ahead(id, e);
      return Object.assign(publicEntry(e), { rank: n.data().count + 1 });
    },
    async addGame(pid, name, mode, place, win, minGapMs) {
      const ref = histories().doc(pid);
      return db.runTransaction(async (tx) => {
        const cur = await tx.get(ref), now = Date.now();
        if (cur.exists && minGapMs && now - (cur.data().at || 0) < minGapMs) return { tooSoon: true };
        const d = Object.assign(R.emptyHistory(), cur.exists ? R.cleanHistory(cur.data()) : {});
        R.addGame(d, mode, place, win);
        d.name = name; d.at = now;
        tx.set(ref, d);
        return { history: publicHistory(d) };
      });
    },
    async pilots(mode, n) {
      const snap = await histories().orderBy(mode + '.wins', 'desc').limit(n).get();
      return snap.docs.map((d) => d.data()).filter((d) => d[mode] && d[mode].played > 0).sort(pilotOrder(mode)).map((d) => publicPilot(d, mode));
    },
    async pilot(pid, mode) {
      const snap = await histories().doc(pid).get();
      if (!snap.exists) return null;
      const d = snap.data();
      const n = await histories().where(mode + '.wins', '>', (d[mode] && d[mode].wins) || 0).count().get();
      return Object.assign(publicHistory(d), { rank: n.data().count + 1 });
    },
  };
}

/**
 * STORE=firestore|memory picks explicitly. Otherwise Firestore is used when
 * running on Cloud Run (K_SERVICE is set there) and memory everywhere else.
 */
function createStore(env) {
  env = env || process.env;
  const kind = env.STORE || (env.K_SERVICE ? 'firestore' : 'memory');
  if (kind === 'firestore') return firestoreStore(env);
  if (kind === 'memory') return memoryStore();
  throw new Error('Unknown STORE "' + kind + '" (expected "firestore" or "memory")');
}

module.exports = { createStore, memoryStore, collectionName };
