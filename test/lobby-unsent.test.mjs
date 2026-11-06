import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LobbyStore } from "../dist/lobby/store.js";
import { LobbyWorker } from "../dist/lobby/worker.js";

const now = 1800000000000;
const lobby = {
  source: "https://blue.openfront.io",
  id: "a1234567",
  map: "World",
  mode: "Team",
  category: "team",
  players: 12,
  capacity: 100,
  startsAt: now + 600000,
  restricted: false,
};

function fixture() {
  const sql = new DatabaseSync(":memory:");
  LobbyStore.initialize(sql);
  const store = new LobbyStore(sql);
  store.configure("g", true, "c", now);
  store.watch("g", "u", { name: "World", map: "World" }, now);
  return { sql, store };
}

test("an unsent match can be alerted after a feed outage recovers", async () => {
  const { sql, store } = fixture();
  let available = true;
  let interrupt = true;
  let sent = 0;
  const member = {
    user: { bot: false },
    createDM: async () => ({
      id: "dm",
      send: async () => {
        sent++;
        return { id: "m", createdTimestamp: now };
      },
    }),
  };
  const guild = {
    members: {
      fetch: async () => {
        if (interrupt) {
          available = false;
          interrupt = false;
        }
        return member;
      },
    },
  };
  const client = { guilds: { cache: new Map([["g", guild]]) } };
  const feed = {
    snapshot: () => available ? { observedAt: now, lobbies: [lobby] } : null,
    getLobby: (source, id) => available && source === lobby.source && id === lobby.id ? { ...lobby } : null,
  };
  const worker = new LobbyWorker(client, store, feed, { now: () => now });
  await worker.tick();
  assert.equal(sent, 0);
  assert.equal(store.search("g", "u").state, "searching");
  available = true;
  await worker.tick();
  assert.equal(sent, 1);
  assert.equal(store.search("g", "u").state, "waiting");
  sql.close();
});

test("stopped or reconfigured unsent searches can later select the same lobby", () => {
  for (const cancel of [
    (s) => s.stop("g", "u", now),
    (s) => s.configure("g", true, "c", now),
  ]) {
    const { sql, store } = fixture();
    assert.ok(store.select("g", "u", lobby, now));
    cancel(store);
    store.resume("g", "u", now);
    assert.ok(store.select("g", "u", lobby, now));
    sql.close();
  }
});

test("cancelling while a send is in flight preserves uncertain outcome protection", async () => {
  const { sql, store } = fixture();
  const n = store.select("g", "u", lobby, now);
  assert.equal(store.begin(n.id, false, now), true);
  store.obsolete(n.id, now);
  assert.equal(store.notification(n.id).status, "sending_dm");
  assert.equal(store.search("g", "u").state, "delivering");
  assert.equal(store.select("g", "u", lobby, now), null);
  const worker = new LobbyWorker(
    { guilds: { cache: new Map() } },
    store,
    { snapshot: () => null, getLobby: () => null },
    { now: () => now },
  );
  await worker.tick();
  assert.equal(store.notification(n.id).status, "review");
  assert.equal(store.search("g", "u").state, "stopped");
  store.resume("g", "u", now);
  assert.equal(store.select("g", "u", lobby, now), null);
  sql.close();
});

test("removing the matching rule during a send preserves the delivered continuation", async () => {
  const { sql, store } = fixture();
  const rule = store.rules("g", "u")[0];
  store.watch("g", "u", { name: "Other", map: "Europe" }, now);
  let release;
  let entered;
  const sending = new Promise((resolve) => {
    entered = resolve;
  });
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const member = {
    user: { bot: false },
    createDM: async () => ({
      id: "dm",
      send: async () => {
        entered();
        await response;
        return { id: "m", createdTimestamp: now };
      },
    }),
  };
  const client = {
    guilds: {
      cache: new Map([["g", { members: { fetch: async () => member } }]]),
    },
  };
  const worker = new LobbyWorker(
    client,
    store,
    { snapshot: () => ({ observedAt: now, lobbies: [lobby] }),
      getLobby: (source, id) => source === lobby.source && id === lobby.id ? { ...lobby } : null },
    { now: () => now },
  );
  const running = worker.tick();
  await sending;
  const notificationId = store.search("g", "u").pending;
  store.remove("g", "u", rule.id, now);
  release();
  await running;
  assert.equal(store.search("g", "u").state, "waiting");
  store.continue(notificationId, "u", "dm", "m", now + 1);
  assert.equal(store.search("g", "u").state, "searching");
  store.watch("g", "u", { name: "World again", map: "World" }, now + 2);
  assert.equal(store.select("g", "u", lobby, now + 2), null);
  sql.close();
});
