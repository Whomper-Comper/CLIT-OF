import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LobbyFeed, SUPPORTED_BUILD } from "../dist/lobby/feed.js";
import { LobbyStore } from "../dist/lobby/store.js";
import { LobbyWorker } from "../dist/lobby/worker.js";

const epoch = 1_800_000_000_000;
const source = "https://blue.openfront.io";
const otherSource = "https://red.openfront.io";
const rawLobby = (id, players = 12) => ({
  gameID: id,
  numClients: players,
  startsAt: epoch + 60_000,
  publicGameType: "team",
  gameConfig: { gameMap: "World", gameMode: "Team", maxPlayers: 100 },
});
const full = (lobbies) => ({
  type: "full", serverTime: epoch, gitCommit: SUPPORTED_BUILD,
  active: true, games: { team: lobbies },
});
const counts = (values) => ({ type: "counts", serverTime: epoch, counts: values });

test("2000-lobby count frames do no tuple serialization or index rebuilding", (t) => {
  let now = epoch;
  const feed = new LobbyFeed({ now: () => now });
  feed.accept(full(Array.from({ length: 2000 }, (_, i) => rawLobby(`l${i}`))), source);
  // Test-only identity observations measure owned object replacements without a public API.
  const owned = feed.current;
  const ownedLobbies = owned.lobbies;
  const references = ownedLobbies.slice();
  const work = { tupleSerializations: 0, indexClears: 0, indexSets: 0 };
  const stringify = JSON.stringify;
  const clear = Map.prototype.clear;
  const set = Map.prototype.set;
  t.mock.method(JSON, "stringify", function (value, ...args) {
    if (Array.isArray(value) && value.length === 2 && value[0] === source)
      work.tupleSerializations++;
    return Reflect.apply(stringify, this, [value, ...args]);
  });
  t.mock.method(Map.prototype, "clear", function (...args) {
    work.indexClears++;
    return Reflect.apply(clear, this, args);
  });
  t.mock.method(Map.prototype, "set", function (...args) {
    work.indexSets++;
    return Reflect.apply(set, this, args);
  });
  try {
    for (let i = 0; i < 100; i++) {
      now++;
      feed.accept(counts({ l0: i % 50, l1999: 5, absent: 90 }), otherSource);
    }
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual(work, { tupleSerializations: 0, indexClears: 0, indexSets: 0 });
  assert.strictEqual(feed.current, owned);
  assert.strictEqual(feed.current.lobbies, ownedLobbies);
  assert.equal(feed.current.lobbies.filter((lobby, i) => lobby !== references[i]).length, 0);
  const snapshot = feed.snapshot();
  assert.equal(snapshot.observedAt, epoch + 100);
  assert.equal(snapshot.lobbies.length, 2000);
  assert.equal(snapshot.lobbies[0].players, 49);
  assert.equal(snapshot.lobbies[1].players, 12);
  assert.equal(snapshot.lobbies[1999].players, 5);
  assert.equal(feed.getLobby(source, "l0").players, 49);
  assert.equal(feed.getLobby(otherSource, "l0"), null);
});

test("partial zero and duplicate count updates preserve returned copies and input ownership", () => {
  let now = epoch;
  const feed = new LobbyFeed({ now: () => now });
  const raw = rawLobby("duplicate");
  const frame = full([raw, rawLobby("duplicate", 30), rawLobby("unchanged", 7)]);
  feed.accept(frame, source);
  const oldSnapshot = feed.snapshot();
  const oldPoint = feed.getLobby(source, "duplicate");
  raw.numClients = 99;
  raw.gameConfig.gameMap = "Europe";
  frame.games.team.length = 0;
  assert.equal(feed.getLobby(source, "duplicate").players, 12);
  assert.equal(feed.getLobby(source, "duplicate").map, "World");

  now += 1000;
  const values = { duplicate: 0, unknown: 40 };
  feed.accept(counts(values), otherSource);
  values.duplicate = 90;
  assert.deepEqual(feed.snapshot().lobbies.map((lobby) => lobby.players), [0, 0, 7]);
  assert.equal(feed.getLobby(source, "duplicate").players, 0);
  assert.equal(feed.getLobby(otherSource, "duplicate"), null);
  assert.equal(feed.getLobby(source, "unknown"), null);
  assert.deepEqual(oldSnapshot.lobbies.map((lobby) => lobby.players), [12, 30, 7]);
  assert.equal(oldPoint.players, 12);

  const exposed = feed.snapshot();
  const point = feed.getLobby(source, "duplicate");
  exposed.lobbies[0].players = 55;
  exposed.lobbies[1].source = otherSource;
  exposed.lobbies.length = 0;
  point.players = 66;
  feed.accept(counts({ unchanged: 8 }), source);
  assert.deepEqual(feed.snapshot().lobbies.map((lobby) => lobby.players), [0, 0, 8]);
  assert.equal(feed.getLobby(source, "duplicate").players, 0);
});

test("unchanged and empty count frames renew freshness with exact thirty-second expiry", () => {
  let now = epoch;
  const feed = new LobbyFeed({ now: () => now });
  feed.accept(full([rawLobby("a")]), source);
  for (const values of [{ a: 12 }, {}]) {
    now += 29_999;
    feed.accept(counts(values), source);
    assert.equal(feed.snapshot().observedAt, now);
    const acceptedAt = now;
    now = acceptedAt + 29_999;
    assert.equal(feed.getLobby(source, "a").players, 12);
    assert.ok(feed.snapshot());
    now++;
    assert.equal(feed.snapshot(), null);
    assert.equal(feed.getLobby(source, "a"), null);
    feed.accept(full([rawLobby("a")]), source);
  }
});

test("full replacements rebuild first-duplicate lookup and clear old owned count state", () => {
  const feed = new LobbyFeed({ now: () => epoch });
  feed.accept(full([rawLobby("a")]), source);
  feed.accept(counts({ a: 0 }), source);
  feed.accept(full([rawLobby("a", 4), rawLobby("a", 50)]), otherSource);
  assert.equal(feed.getLobby(source, "a"), null);
  assert.equal(feed.getLobby(otherSource, "a").players, 4);
  feed.accept(counts({ a: 9 }), source);
  assert.deepEqual(feed.snapshot().lobbies.map((lobby) => lobby.players), [9, 9]);
  assert.equal(feed.getLobby(otherSource, "a").players, 9);
  feed.accept(full([]), source);
  assert.deepEqual(feed.snapshot().lobbies, []);
  assert.equal(feed.getLobby(otherSource, "a"), null);
});

for (const [label, invalid] of [
  ["missing", null], ["negative", { a: 0, bad: -1 }],
  ["fractional", { a: 0, bad: 1.5 }], ["NaN", { a: 0, bad: NaN }],
]) {
  test(`invalid counts atomically invalidate snapshot and point lookup (${label})`, () => {
    const feed = new LobbyFeed({ now: () => epoch });
    feed.accept(full([rawLobby("a")]), source);
    const old = feed.snapshot();
    const owned = feed.current;
    assert.throws(() => feed.accept(counts(invalid), source), /Invalid lobby counts/);
    assert.equal(feed.snapshot(), null);
    assert.equal(feed.getLobby(source, "a"), null);
    assert.equal(old.lobbies[0].players, 12);
    assert.equal(owned.lobbies[0].players, 12, "validate the whole frame before mutating any owned count");
    feed.accept(counts({ a: 9 }), source);
    assert.equal(feed.snapshot(), null);
    feed.accept(full([rawLobby("a", 4)]), source);
    assert.equal(feed.getLobby(source, "a").players, 4);
  });
}

for (const [label, players] of [["fills capacity", 100], ["exceeds saved maximum", 21]]) {
  test(`count update during awaited DM creation prevents delivery when it ${label}`, async () => {
    const sql = new DatabaseSync(":memory:");
    try {
      LobbyStore.initialize(sql);
      const store = new LobbyStore(sql);
      store.configure("g", true, "c", epoch);
      store.watch("g", "u", { name: "World", map: "World", max: 20 }, epoch);
      const feed = new LobbyFeed({ now: () => epoch });
      feed.accept(full([rawLobby("a")]), source);
      const oldSnapshot = feed.snapshot();
      const oldPoint = feed.getLobby(source, "a");
      const entered = Promise.withResolvers();
      const opening = Promise.withResolvers();
      const sent = [];
      const member = { user: { bot: false }, createDM: () => {
        entered.resolve();
        return opening.promise;
      } };
      const guild = { members: { fetch: async () => member } };
      const worker = new LobbyWorker({ guilds: { cache: new Map([["g", guild]]) } }, store, feed, { now: () => epoch });
      const pending = worker.tick();
      await entered.promise;
      feed.accept(counts({ a: players }), source);
      assert.equal(oldSnapshot.lobbies[0].players, 12);
      assert.equal(oldPoint.players, 12);
      opening.resolve({ id: "dm", send: async (payload) => {
        sent.push(payload);
        return { id: "m", createdTimestamp: epoch };
      } });
      await pending;
      assert.equal(sent.length, 0);
      assert.equal(feed.getLobby(source, "a").players, players);
      assert.equal(store.search("g", "u").state, "searching");
    } finally {
      sql.close();
    }
  });
}
