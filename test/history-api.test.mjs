import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { OpenFrontApi, OpenFrontApiError } = await import("../dist/api.js");
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const start = "2026-10-15T00:00:00.000Z", end = "2026-10-16T00:00:00.000Z";
const game = (overrides = {}) => ({ gameId: "game", start, durationSeconds: 1200, map: "World", mode: "Team", type: "Public",
  playerTeams: "Duos", rankedType: "unranked", result: "victory", totalPlayers: 8, username: "Player", clanTag: "MARS", ...overrides });
const session = (overrides = {}) => ({ gameId: "game", gameStart: start, gameEnd: end, gameType: "Public", gameMode: "Team",
  gameRankedType: "unranked", clientId: "recorded-client", username: "Player", clanTag: "MARS", hasWon: true, ...overrides });
const clanSession = (overrides = {}) => ({ gameId: "game", clanTag: "MARS", clanPlayerCount: 2, hasWon: false, numTeams: 2,
  playerTeams: "2", totalPlayerCount: 20, gameStart: start, score: -0.2, ...overrides });
const rankedRow = (public_id, elo = 1000, rank = 1) => ({ public_id, elo, rank });

test("timeouts while reading the response body remain timeouts and do not poison retries", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++attempts === 1) return { ok: true, status: 200, json: async () => {
      throw Object.assign(new Error("body timed out"), { name: "AbortError" });
    } };
    return response({ username: "Player", clans: [] });
  });
  const api = new OpenFrontApi("https://example.invalid");
  await assert.rejects(api.getPlayerProfile("player"), error => error instanceof OpenFrontApiError && error.reason === "timeout");
  assert.equal((await api.getPlayerProfile("player")).username, "Player");
  assert.equal(attempts, 2);
});

test("ratings use exact public IDs and independent ladders while preserving cached observation times", async (t) => {
  let now = Date.parse(start), calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/leaderboard/ranked");
    assert.equal(parsed.searchParams.get("page"), "1");
    return response({
      "1v1": [rankedRow("player-extra", 9999), rankedRow("player", 1350, 2)],
      "2v2": [rankedRow("player", 1460, 20)],
      ffa: [rankedRow("Player", 9998), rankedRow("player", 1120, 3)],
      "clan-wars": [rankedRow("player", 9997)],
    });
  });
  const api = new OpenFrontApi("https://example.invalid", { now: () => now, cacheTtlMs: 60_000 });
  await api.getRankedLeaderboardPage();
  now += 5000;
  assert.deepEqual(await api.getPlayerRatings(" player "), {
    ratings: [
      { publicId: "player", ladder: "1v1", rating: 1350, rank: 2, observedAt: start },
      { publicId: "player", ladder: "2v2", rating: 1460, rank: 20, observedAt: start },
      { publicId: "player", ladder: "ffa", rating: 1120, rank: 3, observedAt: start },
    ], complete: true, pages: 1, observedAt: start,
  });
  assert.equal(calls, 1);
  const fresh = await api.getPlayerRatings("player", { fresh: true });
  assert.equal(fresh.observedAt, "2026-10-15T00:00:05.000Z");
  assert.ok(fresh.ratings.every(row => row.observedAt === "2026-10-15T00:00:05.000Z"));
  assert.equal(calls, 2);
});

test("bounded leaderboard absence stays incomplete until exhaustion and later failures preserve partial ratings", async (t) => {
  const full = Array.from({ length: 50 }, (_, index) => rankedRow(`other-${index}`, 1000, index + 1));
  for (const scenario of [
    { name: "bounded absence", maxPages: 1, replies: [{ value: { "1v1": full } }], complete: false, pages: 1, ratings: [] },
    { name: "empty final page", maxPages: 2, replies: [{ value: { "1v1": full } }, { value: { "1v1": [] } }], complete: true, pages: 2, ratings: [] },
    { name: "official page bound", maxPages: 2, replies: [{ value: { "1v1": full } }, { value: { message: "Page must be between 1 and 1" }, status: 400 }], complete: true, pages: 2, ratings: [] },
    { name: "later unavailable page", maxPages: 2, replies: [{ value: { "1v1": [rankedRow("player", 1350), ...full.slice(1)] } }, { value: {}, status: 503 }], complete: false, pages: 1,
      ratings: [{ publicId: "player", ladder: "1v1", rating: 1350, rank: 1, observedAt: start }] },
  ]) {
    const requested = [];
    t.mock.method(globalThis, "fetch", async (url) => {
      requested.push(Number(new URL(url).searchParams.get("page")));
      const reply = scenario.replies[requested.length - 1];
      assert.ok(reply, `${scenario.name}: exceeded request bound`);
      return response(reply.value, reply.status ?? 200);
    });
    const api = new OpenFrontApi("https://example.invalid", { now: () => Date.parse(start) });
    assert.deepEqual(await api.getPlayerRatings("player", { maxPages: scenario.maxPages }), {
      ratings: scenario.ratings, complete: scenario.complete, pages: scenario.pages, observedAt: start,
    }, scenario.name);
    assert.deepEqual(requested, scenario.maxPages === 1 ? [1] : [1, 2], scenario.name);
  }
});

test("malformed or forbidden leaderboards fail rather than becoming empty rankings and remain retryable", async (t) => {
  const api = new OpenFrontApi("https://example.invalid");
  for (const { value, status = 200, reason = "invalid_response" } of [
    { value: {} }, { value: { "1v1": "not-an-array" } },
    { value: { "1v1": [rankedRow("invalid id")] } },
    { value: { "1v1": [rankedRow("player", "1350")] } },
    { value: { "1v1": [rankedRow("player", 1350, 0)] } },
    { value: { "1v1": Array.from({ length: 101 }, () => rankedRow("player")) } },
    { value: {}, status: 403, reason: "http" },
    { value: { message: "Invalid request" }, status: 400, reason: "http" },
  ]) {
    t.mock.method(globalThis, "fetch", async () => response(value, status));
    await assert.rejects(api.getPlayerRatings("player"), error => error instanceof OpenFrontApiError && error.reason === reason && (reason !== "http" || error.status === status));
  }
  // Older public responses may omit newer ladders; absence is not malformed.
  t.mock.method(globalThis, "fetch", async () => response({ "1v1": [] }));
  const recovered = await api.getPlayerRatings("player");
  assert.deepEqual(recovered.ratings, []);
  assert.equal(recovered.complete, true);
});

test("player history preserves opaque cursors, separates filters, and coalesces cached pages", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const parsed = new URL(url);
    urls.push(parsed);
    assert.equal(options.headers.Authorization, undefined);
    return response({ results: [game()], nextCursor: "next +/&=" });
  });
  const api = new OpenFrontApi("https://example.invalid");
  const query = { filter: "team", type: "public", cursor: " prior +/&= " };
  const [a, b] = await Promise.all([api.getPlayerGames(" id/with?spaces ", query), api.getPlayerGames("id/with?spaces", query)]);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].pathname, "/public/player/id%2Fwith%3Fspaces/games");
  assert.equal(urls[0].searchParams.get("cursor"), query.cursor);
  assert.equal(urls[0].searchParams.get("filter"), "team");
  assert.equal(urls[0].searchParams.get("type"), "public");
  a.results[0].username = "Changed";
  assert.equal(b.results[0].username, "Player");
  assert.equal(b.nextCursor, "next +/&=");
  await api.getPlayerGames("id/with?spaces", { ...query, filter: "ffa" });
  assert.equal(urls.length, 2);
  await api.getPlayerGames("id/with?spaces", query, { fresh: true });
  assert.equal(urls.length, 3);
});

test("known empty history differs from unknown players, and nullable match fields are accepted", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("missing")) return response({}, 404);
    if (url.includes("empty")) return response({ results: [], nextCursor: null });
    return response({ results: [game({ playerTeams: null, totalPlayers: null, clanTag: null, result: "incomplete" })], nextCursor: null });
  });
  const api = new OpenFrontApi("https://example.invalid");
  assert.equal(await api.getPlayerGames("missing"), null);
  assert.deepEqual(await api.getPlayerGames("empty"), { results: [], nextCursor: null });
  assert.equal((await api.getPlayerGames("player")).results[0].result, "incomplete");
});

test("malformed or oversized player pages fail and are not cached", async (t) => {
  const invalid = [
    { results: [game({ durationSeconds: -1 })], nextCursor: null },
    { results: [game({ result: "win" })], nextCursor: null },
    { results: [game({ start: "yesterday" })], nextCursor: null },
    { results: [game()], nextCursor: 12 },
    { results: [game()], nextCursor: "" },
    { results: Array.from({ length: 101 }, () => game()), nextCursor: null },
  ];
  const api = new OpenFrontApi("https://example.invalid");
  for (const value of invalid) {
    t.mock.method(globalThis, "fetch", async () => response(value));
    await assert.rejects(api.getPlayerGames("player"), OpenFrontApiError);
  }
  t.mock.method(globalThis, "fetch", async () => response({ results: [game()], nextCursor: null }));
  assert.equal((await api.getPlayerGames("player")).results.length, 1);
});

test("player sessions send inclusive time bounds and validate the official session fields", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/public/player/player/sessions");
    assert.equal(parsed.searchParams.get("start"), start);
    assert.equal(parsed.searchParams.get("end"), end);
    assert.equal(parsed.searchParams.get("type"), "public");
    assert.equal(parsed.searchParams.get("filter"), "team");
    return response({ results: [session({ gameEnd: null, clanTag: null })], nextCursor: null });
  });
  const api = new OpenFrontApi("https://example.invalid");
  const page = await api.getPlayerSessions("player", { start, end, type: "public", filter: "team" });
  assert.equal(page.results[0].clientId, "recorded-client");
  assert.equal(page.results[0].clanTag, null);
  t.mock.method(globalThis, "fetch", async () => response({ results: [session({ hasWon: "true" })], nextCursor: null }));
  await assert.rejects(api.getPlayerSessions("invalid"), OpenFrontApiError);
});

test("public clan sessions validate the observed public schema with negative scores and canonical tags", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/public/clan/MARS/sessions");
    assert.equal(parsed.searchParams.get("start"), start);
    assert.equal(parsed.searchParams.get("end"), end);
    return response({ results: [clanSession()], total: 96, page: 1, limit: 2 });
  });
  const api = new OpenFrontApi("https://example.invalid");
  const query = { start, end, page: 1, limit: 2 };
  const [a, b] = await Promise.all([api.getClanSessions(" mars ", query), api.getClanSessions("MARS", query)]);
  assert.equal(calls, 1);
  assert.equal(a.results[0].score, -0.2);
  assert.equal(a.total, 96);
  a.results[0].clanPlayerCount = 99;
  assert.equal(b.results[0].clanPlayerCount, 2);
});

test("invalid clan ranges and pagination fail before making an API request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not fetch"); });
  const api = new OpenFrontApi("https://example.invalid");
  for (const query of [
    {}, { start }, { start, end: start }, { start, end: "2026-10-16T00:00:00.001Z" },
    { start, end, page: 201 }, { start, end, page: 0 }, { start, end, limit: 51 }, { start, end, limit: 1.5 },
  ]) await assert.rejects(api.getClanSessions("MARS", query), RangeError);
  await assert.rejects(api.getPlayerSessions("player", { start: end, end: start }), RangeError);
  await assert.rejects(api.getPlayerGames("player", { filter: "all" }), RangeError);
  assert.equal(calls, 0);
});

test("clan pages reject authenticated response shapes and unsafe statistics", async (t) => {
  const api = new OpenFrontApi("https://example.invalid");
  for (const value of [
    { results: [{ gameId: "game", result: "victory", clanPlayers: [] }], total: 1, page: 1, limit: 2 },
    { results: [clanSession({ totalPlayerCount: -1 })], total: 1, page: 1, limit: 2 },
    { results: [clanSession({ score: null })], total: 1, page: 1, limit: 2 },
    { results: [clanSession()], total: 1, page: 2, limit: 2 },
    { results: [clanSession(), clanSession(), clanSession()], total: 3, page: 1, limit: 2 },
  ]) {
    t.mock.method(globalThis, "fetch", async () => response(value));
    await assert.rejects(api.getClanSessions("MARS", { start, end, limit: 2 }), OpenFrontApiError);
  }
});

test("deletion feed encodes a timestamp and rejects unusable deletions", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/public/players/recently-deleted");
    assert.equal(parsed.searchParams.get("since"), start);
    return response([{ publicId: "deleted-player", deletedAt: end }]);
  });
  const api = new OpenFrontApi("https://example.invalid");
  assert.deepEqual(await api.getRecentlyDeletedPlayers(start), [{ publicId: "deleted-player", deletedAt: end }]);
  t.mock.method(globalThis, "fetch", async () => response([{ publicId: "deleted-player", deletedAt: "bad" }]));
  await assert.rejects(api.getRecentlyDeletedPlayers(undefined), OpenFrontApiError);
});

test("all history timestamps normalize ISO offsets to canonical UTC before caching", async (t) => {
  const offsetStart = "2026-10-15T03:00:00.000+03:00", offsetEnd = "2026-10-16T03:00:00.000+03:00";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    if (url.includes("recently-deleted")) return response([{ publicId: "deleted-player", deletedAt: offsetEnd }]);
    if (url.includes("/clan/")) return response({ results: [clanSession({ gameStart: offsetStart })], total: 1, page: 1, limit: 20 });
    if (url.includes("/sessions")) return response({ results: [session({ gameStart: offsetStart, gameEnd: offsetEnd })], nextCursor: null });
    return response({ results: [game({ start: offsetStart })], nextCursor: null });
  });
  const api = new OpenFrontApi("https://example.invalid");
  const games = await api.getPlayerGames("player");
  assert.equal(games.results[0].start, start);
  games.results[0].start = "changed";
  assert.equal((await api.getPlayerGames("player")).results[0].start, start, "normalization must retain cloned cache results");
  const sessions = await api.getPlayerSessions("player");
  assert.equal(sessions.results[0].gameStart, start);
  assert.equal(sessions.results[0].gameEnd, end);
  assert.equal((await api.getClanSessions("MARS", { start, end })).results[0].gameStart, start);
  assert.equal((await api.getRecentlyDeletedPlayers())[0].deletedAt, end);
  assert.equal(calls, 4);
});
