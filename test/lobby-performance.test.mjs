import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LobbyStore } from "../dist/lobby/store.js";
import { LobbyWorker } from "../dist/lobby/worker.js";
import { LobbyFeed, SUPPORTED_BUILD } from "../dist/lobby/feed.js";

for (const change of ["fresh at 29999ms", "expired at 30000ms", "source changed", "disappeared", "feed stopped"]) {
  test(`final delivery revalidation uses the real feed when ${change}`, async () => {
    const sql = new DatabaseSync(":memory:");
    try {
      LobbyStore.initialize(sql);
      const store = new LobbyStore(sql);
      let now = 1800000000000;
      const source = "https://blue.openfront.io";
      store.configure("g", true, "c", now);
      store.watch("g", "u", { name: "World", map: "World" }, now);
      const feed = new LobbyFeed({ now: () => now });
      const raw = { gameID: "match", numClients: 12, startsAt: now + 600000, publicGameType: "team",
        gameConfig: { gameMap: "World", gameMode: "Team", maxPlayers: 100 } };
      const full = games => ({ type: "full", serverTime: now, gitCommit: SUPPORTED_BUILD, games: { team: games } });
      feed.accept(full([raw]), source);
      const sent = [];
      const member = { user: { bot: false }, createDM: async () => {
        if (change === "fresh at 29999ms") now += 29999;
        if (change === "expired at 30000ms") now += 30000;
        if (change === "source changed") feed.accept(full([raw]), "https://red.openfront.io");
        if (change === "disappeared") feed.accept(full([]), source);
        if (change === "feed stopped") feed.stop();
        return { id: "dm", send: async payload => {
          sent.push(payload); return { id: "m", createdTimestamp: now };
        } };
      } };
      let membershipFetches = 0;
      const guild = { members: { fetch: async () => { membershipFetches++; return member; } } };
      const worker = new LobbyWorker({ guilds: { cache: new Map([["g", guild]]) } }, store, feed, { now: () => now });
      await worker.tick();
      assert.equal(membershipFetches, 2, "the change occurs between initial and final membership lookup");
      const fresh = change === "fresh at 29999ms";
      assert.equal(sent.length, fresh ? 1 : 0);
      assert.equal(store.search("g", "u").state, fresh ? "waiting" : "searching");
    } finally { sql.close(); }
  });
}

test("delivery uses one whole snapshot per tick and point reads after awaits", async (t) => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const store = new LobbyStore(sql);
    const now = 1800000000000, source = "https://blue.openfront.io";
    store.configure("g", true, "c", now);
    store.watch("g", "u", { name: "World", map: "World" }, now);
    const feed = new LobbyFeed({ now: () => now });
    const raw = { gameID: "match", numClients: 12, startsAt: now + 600000, publicGameType: "team",
      gameConfig: { gameMap: "World", gameMode: "Team", maxPlayers: 100 } };
    feed.accept({ type: "full", serverTime: now, gitCommit: SUPPORTED_BUILD,
      games: { team: Array.from({ length: 500 }, (_, i) => ({ ...raw, gameID: `other-${i}`,
        gameConfig: { ...raw.gameConfig, gameMap: "Other" } })).concat(raw) } }, source);
    let snapshots = 0, revalidationClones = 0, awaitingDelivery = false;
    const snapshot = feed.snapshot.bind(feed), clone = globalThis.structuredClone;
    t.mock.method(feed, "snapshot", () => { snapshots++; return snapshot(); });
    t.mock.method(globalThis, "structuredClone", value => {
      if (awaitingDelivery && Array.isArray(value?.lobbies)) revalidationClones++;
      return clone(value);
    });
    const sent = [];
    const member = { user: { bot: false }, createDM: async () => ({ id: "dm", send: async payload => {
      sent.push(payload); return { id: "m", createdTimestamp: now };
    } }) };
    const guild = { members: { fetch: async () => {
      awaitingDelivery = true;
      feed.accept({ type: "counts", serverTime: now, counts: { match: 20 } }, source);
      return member;
    } } };
    const worker = new LobbyWorker({ guilds: { cache: new Map([["g", guild]]) } }, store, feed, { now: () => now });
    await worker.tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0].embeds[0].data.description, /20\/100 current players/);
    assert.equal(snapshots, 1);
    assert.equal(revalidationClones, 0);
  } finally { sql.close(); }
});

test("matching skips database selection for nonmatching lobbies and still finds a later match", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const store = new LobbyStore(sql);
    const now = 1800000000000;
    store.configure("g", true, "c", now);
    store.watch("g", "u", { name: "World", map: "World" }, now);
    const lobby = {
      source: "https://blue.openfront.io", id: "match", map: "World",
      mode: "Team", category: "team", players: 12, capacity: 100,
      startsAt: now + 600000, restricted: false,
    };
    const lobbies = Array.from({ length: 500 }, (_, i) => ({
      ...lobby, id: `other-${i}`, map: "Other",
    })).concat(lobby);
    const selected = [];
    const select = store.select.bind(store);
    store.select = (...args) => { selected.push(args[2].id); return select(...args); };
    const feed = { snapshot: () => ({ observedAt: now, lobbies }),
      getLobby: (source, id) => lobbies.find(lobby => lobby.source === source && lobby.id === id) ?? null };
    const client = { guilds: { cache: new Map() } };
    const worker = new LobbyWorker(client, store, feed, { now: () => now });
    await worker.tick();
    assert.deepEqual(selected, ["match"]);
  } finally {
    sql.close();
  }
});

test("matching skips already handled lobbies before selecting a new match", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const store = new LobbyStore(sql);
    const now = 1800000000000;
    store.configure("g", true, "c", now);
    store.watch("g", "u", { name: "World", map: "World" }, now);
    const lobby = {
      source: "https://blue.openfront.io", id: "new", map: "World",
      mode: "Team", category: "team", players: 12, capacity: 100,
      startsAt: now + 600000, restricted: false,
    };
    const old = Array.from({ length: 500 }, (_, i) => ({ ...lobby, id: `old-${i}` }));
    const insert = sql.prepare(`INSERT INTO lobby_notifications
      (id,guild,user,generation,revision,source,lobby_id,lobby,status,next,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of old)
      insert.run(item.id, "g", "u", "previous", 1, item.source, item.id,
        JSON.stringify(item), "sent", now, now);
    const selected = [];
    const select = store.select.bind(store);
    store.select = (...args) => { selected.push(args[2].id); return select(...args); };
    const lobbies = [...old, lobby];
    const feed = { snapshot: () => ({ observedAt: now, lobbies }),
      getLobby: (source, id) => lobbies.find(lobby => lobby.source === source && lobby.id === id) ?? null };
    const client = { guilds: { cache: new Map() } };
    const worker = new LobbyWorker(client, store, feed, { now: () => now });
    await worker.tick();
    assert.deepEqual(selected, ["new"]);
  } finally {
    sql.close();
  }
});
