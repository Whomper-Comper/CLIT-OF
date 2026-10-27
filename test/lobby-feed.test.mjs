import test from "node:test";
import assert from "node:assert/strict";
import { LobbyFeed, decodeFrame, SUPPORTED_BUILD } from "../dist/lobby/feed.js";
import { matches, normalizeLobby } from "../dist/lobby/model.js";
const now = 1_800_000_000_000;
const raw = {
  gameID: "a1234567",
  numClients: 12,
  startsAt: now + 60000,
  publicGameType: "team",
  gameConfig: { gameMap: "World", gameMode: "Team", maxPlayers: 100 },
};
test("filters combine and never match unknown, full or started lobbies", () => {
  const lobby = normalizeLobby(raw, "https://blue.openfront.io", now, now);
  assert.equal(
    matches({ map: " world ", mode: "team", min: 10, max: 20 }, lobby, now),
    true,
  );
  for (const rule of [
    { map: "Europe" },
    { min: 13 },
    { max: 11 },
    { category: "ffa" },
  ])
    assert.equal(matches(rule, lobby, now), false);
  assert.equal(matches({}, { ...lobby, capacity: null }, now), false);
  assert.equal(matches({}, { ...lobby, players: 100 }, now), false);
  assert.equal(matches({}, { ...lobby, startsAt: now }, now), false);
});
test("feed merges count deltas, rejects unknown builds and invalidates disconnected snapshots", () => {
  const f = new LobbyFeed({ now: () => now });
  f.accept(
    { type: "counts", serverTime: now, counts: { a1234567: 20 } },
    "https://blue.openfront.io",
  );
  assert.equal(f.snapshot(), null);
  f.accept(
    {
      type: "full",
      serverTime: now,
      gitCommit: SUPPORTED_BUILD,
      active: true,
      games: { team: [raw] },
    },
    "https://blue.openfront.io",
  );
  assert.equal(f.snapshot().lobbies[0].players, 12);
  f.accept(
    { type: "counts", serverTime: now, counts: { a1234567: 20 } },
    "https://blue.openfront.io",
  );
  assert.equal(f.snapshot().lobbies[0].players, 20);
  assert.throws(
    () =>
      f.accept(
        {
          type: "full",
          serverTime: now,
          gitCommit: "ffffffffffffffffffffffffffffffffffffffff",
          games: { team: [raw] },
        },
        "https://blue.openfront.io",
      ),
    /build/i,
  );
  assert.equal(f.snapshot(), null);
  f.stop();
  assert.equal(f.snapshot(), null);
});
test("corrupt/oversized binary frames are rejected", () => {
  assert.throws(() => decodeFrame(new Uint8Array([255, 255, 255])));
  assert.throws(() => decodeFrame(new Uint8Array(1_048_577)));
});
import { readFileSync } from "node:fs";
import { setImmediate as immediate } from "node:timers/promises";
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/lobby-wire.json", import.meta.url)),
);
test("decodes synthetic snapshot and count delta fixtures from the pinned codec", () => {
  const f = new LobbyFeed({ now: () => now });
  f.accept(
    decodeFrame(Buffer.from(vectors.full, "base64")),
    "https://blue.openfront.io",
  );
  assert.equal(f.snapshot().lobbies[0].map, "World");
  assert.equal(f.snapshot().lobbies[0].capacity, 100);
  f.accept(
    decodeFrame(Buffer.from(vectors.counts, "base64")),
    "https://blue.openfront.io",
  );
  assert.equal(f.snapshot().lobbies[0].players, 20);
});
test("connection errors replace watchdog with reconnect instead of leaving the feed dead", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let sockets = 0;
  class Socket extends EventTarget {
    close() {}
    binaryType = "";
  }
  let socket;
  const f = new LobbyFeed({
    now: () => now,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        servers: {
          a: {
            state: "open",
            version: SUPPORTED_BUILD,
            host: "blue.openfront.io",
            numWorkers: 1,
          },
        },
      }),
    }),
    socket: () => {
      sockets++;
      return (socket = new Socket());
    },
  });
  f.start();
  await immediate();
  assert.equal(sockets, 1);
  socket.dispatchEvent(new Event("error"));
  t.mock.timers.tick(3000);
  await immediate();
  assert.equal(sockets, 2);
  f.stop();
});

test("discovery timeout includes a stalled response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const f = new LobbyFeed({
    fetch: async (_, options) => {
      signal = options.signal;
      return {
        ok: true,
        json: () =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new Error("timeout")),
            );
          }),
      };
    },
  });
  f.start();
  await immediate();
  t.mock.timers.tick(8000);
  await immediate();
  assert.equal(signal.aborted, true);
  f.stop();
});
