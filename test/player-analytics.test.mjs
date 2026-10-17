import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPlayerAnalytics } from "../dist/playerAnalytics.js";

const now = Date.parse("2026-10-16T12:00:00Z");
const start = "2026-10-15T12:00:00.000Z";
const options = { mode: "ffa", scope: "public", period: "24h", now };
const game = (id, extra = {}) => ({ gameId: id, start, durationSeconds: 60,
  map: "World", mode: "Free For All", type: "Public", playerTeams: null,
  rankedType: "Unranked", result: "victory", totalPlayers: 10, username: "Player", clanTag: null, ...extra });

test("period boundaries are inclusive, future games excluded, and incomplete games do not lower win rate", async () => {
  const api = { getPlayerGames: async (id, query) => {
    assert.equal(id, "exact-public-id");
    assert.deepEqual(query, { filter: "ffa", type: "public" });
    return { results: [game("end", { start: new Date(now).toISOString(), result: "defeat", durationSeconds: 120 }),
      game("unfinished", { result: "incomplete", durationSeconds: 900 }), game("start"),
      game("future", { start: new Date(now + 1).toISOString() }),
      game("old", { start: "2026-10-15T11:59:59.999Z" })], nextCursor: null };
  } };
  const result = await loadPlayerAnalytics(api, "exact-public-id", options);
  assert.equal(result.total, 3);
  assert.equal(result.completed, 2);
  assert.equal(result.incomplete, 1);
  assert.equal(result.winRate, "50.0%");
  assert.equal(result.averageDurationSeconds, 90);
  assert.equal(result.coverage.complete, true);
});

test("map normalization matches full map names while scope and ranked mode remain separate", async () => {
  const api = { getPlayerGames: async () => ({ results: [
    game("match", { map: "North-America" }), game("spacing", { map: "north america", result: "defeat" }),
    game("substring", { map: "America" }), game("private", { map: "NorthAmerica", type: "Private" }),
    game("ranked", { map: "NorthAmerica", rankedType: "1v1" }), game("team", { map: "NorthAmerica", mode: "Team" }),
  ], nextCursor: null }) };
  const result = await loadPlayerAnalytics(api, "exact-public-id", { ...options, map: "NORTH_AMERICA" });
  assert.deepEqual(result.games.map(row => row.gameId), ["match", "spacing"]);
  assert.equal(result.maps.length, 1);
  assert.equal(result.maps[0].winRate, "50.0%");
});

test("duplicate games and cursor loops cannot inflate statistics or trigger unbounded reads", async () => {
  let reads = 0;
  const api = { getPlayerGames: async (_id, query) => {
    reads++;
    if (reads === 1) { assert.equal(query.cursor, undefined); return { results: [game("one")], nextCursor: "opaque+cursor" }; }
    assert.equal(query.cursor, "opaque+cursor");
    return { results: [game("one"), game("two", { result: "defeat" })], nextCursor: "opaque+cursor" };
  } };
  const result = await loadPlayerAnalytics(api, "player", options);
  assert.equal(reads, 2);
  assert.equal(result.total, 2);
  assert.equal(result.coverage.scanned, 2);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, "cursor_loop");
});

test("a later API failure retains the fetched sample and marks it partial", async () => {
  let reads = 0;
  const api = { getPlayerGames: async () => {
    if (++reads === 1) return { results: [game("one")], nextCursor: "next" };
    throw new Error("offline");
  } };
  const result = await loadPlayerAnalytics(api, "player", options);
  assert.equal(result.total, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, "api_error");
  await assert.rejects(loadPlayerAnalytics(api, "player", options), /offline/);
});

test("an empty map sample at the page cap does not claim a complete search", async () => {
  const api = { getPlayerGames: async () => ({ results: [game("one")], nextCursor: "next" }) };
  const result = await loadPlayerAnalytics(api, "player", { ...options, map: "Europe", maxPages: 1 });
  assert.equal(result.total, 0);
  assert.equal(result.winRate, "—");
  assert.equal(result.averageDurationSeconds, null);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, "page_limit");
});

test("a scan crossing the period boundary does not fetch older pages", async () => {
  let reads = 0;
  const api = { getPlayerGames: async () => { reads++; return {
    results: [game("edge"), game("old", { start: "2026-10-14T12:00:00.000Z" })], nextCursor: "older",
  }; } };
  const result = await loadPlayerAnalytics(api, "player", options);
  assert.equal(reads, 1);
  assert.equal(result.total, 1);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.reason, "period_boundary");
});
