import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LobbyStore } from "../dist/lobby/store.js";
import { LobbyWorker } from "../dist/lobby/worker.js";

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
    const feed = { snapshot: () => ({ observedAt: now, lobbies }) };
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
    const feed = { snapshot: () => ({ observedAt: now, lobbies: [...old, lobby] }) };
    const client = { guilds: { cache: new Map() } };
    const worker = new LobbyWorker(client, store, feed, { now: () => now });
    await worker.tick();
    assert.deepEqual(selected, ["new"]);
  } finally {
    sql.close();
  }
});
