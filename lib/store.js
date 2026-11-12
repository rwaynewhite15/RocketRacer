'use strict';

/*
 * Leaderboard storage.
 *
 *   firestore  Google Cloud Firestore (used on Cloud Run)
 *   memory     in-process map, for local development and tests
 *
 * Both expose the same three async methods:
 *   top(track, n)             -> [{ name, time, lap, diff, place, at }]  fastest first
 *   submit(track, pid, entry) -> { improved, best, rank }
 *   find(track, pid)          -> that player's row plus `rank`, or null
 *
 * `place` is where the pilot finished in that race (1-6); rows written before
 * it existed have null.
 *
 * Each player (anonymous id `pid`) owns one row per track; a submission only
 * replaces it when the new race time is faster.
 */

function publicEntry(e) {
  return { name: e.name, time: e.time, lap: e.lap, diff: e.diff, place: e.place == null ? null : e.place, at: e.at };
}

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
  const boards = new Map(); // track -> Map(pid -> entry)
  const board = (track) => {
    if (!boards.has(track)) boards.set(track, new Map());
    return boards.get(track);
  };
  return {
    kind: 'memory',
    async top(track, n) {
      return [...board(track).values()].sort((a, b) => a.time - b.time).slice(0, n).map(publicEntry);
    },
    async submit(track, pid, entry) {
      const b = board(track), cur = b.get(pid);
      let improved = false, best = entry;
      if (cur && cur.time <= entry.time) {
        cur.name = entry.name; // keep the faster time, follow a renamed pilot
        best = cur;
      } else {
        b.set(pid, entry);
        improved = true;
      }
      let rank = 1;
      for (const e of b.values()) if (e.time < best.time) rank++;
      return { improved, best: publicEntry(best), rank };
    },
    async find(track, pid) {
      const b = board(track), cur = b.get(pid);
      if (!cur) return null;
      let rank = 1;
      for (const e of b.values()) if (e.time < cur.time) rank++;
      return Object.assign(publicEntry(cur), { rank });
    },
  };
}

function firestoreStore(env) {
  // Required lazily so local development works without Google credentials.
  const { Firestore } = require('@google-cloud/firestore');
  const opts = {};
  if (env.FIRESTORE_DATABASE) opts.databaseId = env.FIRESTORE_DATABASE;
  const db = new Firestore(opts);
  // {collection}/{track}/scores/{pid} — ordering by `time` within one
  // sub-collection needs only Firestore's automatic single-field index.
  const root = collectionName(env);
  const scores = (track) => db.collection(root).doc(track).collection('scores');

  return {
    kind: 'firestore',
    async top(track, n) {
      const snap = await scores(track).orderBy('time').limit(n).get();
      return snap.docs.map((d) => publicEntry(d.data()));
    },
    async submit(track, pid, entry) {
      const ref = scores(track).doc(pid);
      const res = await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        if (cur.exists && cur.data().time <= entry.time) {
          const kept = cur.data();
          if (kept.name !== entry.name) tx.update(ref, { name: entry.name });
          return { improved: false, best: Object.assign({}, kept, { name: entry.name }) };
        }
        tx.set(ref, entry);
        return { improved: true, best: entry };
      });
      const faster = await scores(track).where('time', '<', res.best.time).count().get();
      return { improved: res.improved, best: publicEntry(res.best), rank: faster.data().count + 1 };
    },
    async find(track, pid) {
      const snap = await scores(track).doc(pid).get();
      if (!snap.exists) return null;
      const e = snap.data();
      const faster = await scores(track).where('time', '<', e.time).count().get();
      return Object.assign(publicEntry(e), { rank: faster.data().count + 1 });
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
