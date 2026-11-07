import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { OpenFrontApi, OpenFrontApiError, openfrontApi } = await import("../dist/api.js");
const { summarizePlayerStats, winRate } = await import("../dist/playerStats.js");
const { buildCoverageReport, buildDoctorEmbeds } = await import("../dist/reporting.js");
const { statsCommand, handleStatsInteraction } = await import("../dist/commands/stats.js");
const { db } = await import("../dist/db.js");
after(() => db.close());

const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const profile = (overrides = {}) => ({ createdAt: "2025-01-01T00:00:00.000Z", username: "Player", clans: [], ...overrides });
const leaf = (wins, losses, stats = {}) => ({ wins: String(wins), losses: String(losses), total: String(BigInt(wins) + BigInt(losses)), stats });
const config = (overrides = {}) => ({ guild_id: "guild", clan_tag: "TEST", member_role_id: "member", officer_role_id: null,
  leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null, ...overrides });

// Count entries actually visited by cache iteration, without adding production instrumentation.
function cacheVisits(t, api) {
  let visits = 0;
  for (const name of [Symbol.iterator, "entries", "values", "keys"]) {
    const original = api.cache[name].bind(api.cache);
    t.mock.method(api.cache, name, function* () {
      for (const item of original()) { visits++; yield item; }
    });
  }
  const original = api.cache.forEach.bind(api.cache);
  t.mock.method(api.cache, "forEach", (callback, receiver) => original((value, key, map) => {
    visits++; callback.call(receiver, value, key, map);
  }));
  return () => visits;
}

test("500 frozen-time cached reads visit no expiry-map entries before the default fifteen-second boundary", async (t) => {
  let now = 0, calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(profile()); });
  const api = new OpenFrontApi("https://example.invalid", { now: () => now });
  for (let i = 0; i < 500; i++) await api.getPlayerProfile(`player-${i}`);
  const visits = cacheVisits(t, api);
  now = 14_999;
  for (let i = 0; i < 500; i++) assert.equal((await api.getPlayerProfile(`player-${i}`)).username, "Player");
  assert.equal(calls, 500);
  assert.equal(visits(), 0);
  now = 15_000;
  await api.getPlayerProfile("player-0");
  assert.equal(calls, 501);
  assert.equal(visits(), 500, "the exact expiry boundary sweeps retained entries once");
  await api.getPlayerProfile("player-0");
  assert.equal(visits(), 500);
});

test("expiry frontier lowers after clock rollback and preserves later-expiring entries", async (t) => {
  let now = 100, calls = 0;
  t.mock.method(globalThis, "fetch", async () => response(profile({ username: `value-${++calls}` })));
  const api = new OpenFrontApi("https://example.invalid", { now: () => now, cacheTtlMs: 20 });
  await api.getPlayerProfile("later"); // expires at 120
  now = 10;
  await api.getPlayerProfile("earlier"); // expires at 30
  const visits = cacheVisits(t, api);
  now = 29;
  assert.equal((await api.getPlayerProfile("earlier")).username, "value-2");
  assert.equal(visits(), 0);
  now = 30;
  assert.equal((await api.getPlayerProfile("earlier")).username, "value-3");
  assert.equal(visits(), 2);
  assert.equal((await api.getPlayerProfile("later")).username, "value-1");
  assert.equal(visits(), 2);
  now = 50;
  await api.getPlayerProfile("later");
  assert.equal(visits(), 4, "sweeping recomputes the next retained expiration");
  assert.equal(calls, 3);
});

test("default public cache evicts the oldest key after 500 entries", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => response(profile({ username: `value-${++calls}` })));
  const api = new OpenFrontApi("https://example.invalid", { now: () => 0 });
  for (let i = 0; i < 501; i++) await api.getPlayerProfile(`player-${i}`);
  assert.equal((await api.getPlayerProfile("player-500")).username, "value-501");
  assert.equal((await api.getPlayerProfile("player-0")).username, "value-502");
  assert.equal(api.cache.size, 500);
});

test("public API coalesces simultaneous profile reads and clones cached values", async (t) => {
  let calls = 0, release;
  t.mock.method(globalThis, "fetch", async () => { calls++; await new Promise((resolve) => { release = resolve; }); return response(profile()); });
  const api = new OpenFrontApi("https://example.invalid");
  const first = api.getPlayerProfile("player"), second = api.getPlayerProfile(" player ");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  a.username = "changed";
  assert.equal(b.username, "Player");
  assert.equal((await api.getPlayerProfile("player")).username, "Player");
  assert.equal(calls, 1);
});

test("profile cache expires and fresh reads bypass both cache and pending reads", async (t) => {
  let now = 0, calls = 0, release;
  t.mock.method(globalThis, "fetch", async () => {
    const current = ++calls;
    if (current === 1) await new Promise((resolve) => { release = resolve; });
    return response(profile({ username: `value-${current}` }));
  });
  const api = new OpenFrontApi("https://example.invalid", { now: () => now, cacheTtlMs: 15 });
  const old = api.getPlayerProfile("player");
  assert.equal((await api.getPlayerProfile("player", { fresh: true })).username, "value-2");
  release();
  await old;
  assert.equal((await api.getPlayerProfile("player")).username, "value-2", "old in-flight response must not replace fresh verification");
  now = 16;
  assert.equal((await api.getPlayerProfile("player")).username, "value-3");
  assert.equal(calls, 3);
});

test("older reads cannot replace a later generation after another fresh request", async (t) => {
  let calls = 0, releaseOld, releaseNew;
  t.mock.method(globalThis, "fetch", async () => {
    const current = ++calls;
    if (current === 1) await new Promise((resolve) => { releaseOld = resolve; });
    if (current === 3) await new Promise((resolve) => { releaseNew = resolve; });
    return response(profile({ username: `value-${current}` }));
  });
  const api = new OpenFrontApi("https://example.invalid");
  const old = api.getPlayerProfile("player");
  await api.getPlayerProfile("player", { fresh: true });
  const newest = api.getPlayerProfile("player", { fresh: true });
  releaseOld(); await old;
  releaseNew(); await newest;
  assert.equal((await api.getPlayerProfile("player")).username, "value-3");
});

test("clan session reads share canonical tags, enforce bounded cache, and retry errors", async (t) => {
  let calls = 0;
  const query = { start: "2026-10-15T00:00:00Z", end: "2026-10-16T00:00:00Z", limit: 1 };
  t.mock.method(globalThis, "fetch", async url => { calls++; return response(url.includes("/sessions") ? { results: [], total: 0, page: 1, limit: 1 } : profile()); });
  const api = new OpenFrontApi("https://example.invalid", { maxCacheEntries: 1 });
  await Promise.all([api.getClanSessions("test", query), api.getClanSessions(" TEST ", query)]);
  assert.equal(calls, 1);
  await api.getPlayerProfile("player");
  await api.getClanSessions("test", query);
  assert.equal(calls, 3);
  t.mock.method(globalThis, "fetch", async () => response({}, 503));
  await assert.rejects(api.getPlayerProfile("retry"), OpenFrontApiError);
  t.mock.method(globalThis, "fetch", async () => response(profile()));
  assert.equal((await api.getPlayerProfile("retry")).username, "Player");
});

test("identity validation always sends fresh POSTs and keeps null statistics unchanged", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    assert.equal(options.method, "POST");
    return response({ publicId: "player" });
  });
  const api = new OpenFrontApi("https://example.invalid");
  const token = `e30.${Buffer.from(JSON.stringify({ aud: "ofstats.io" })).toString("base64url")}.signature`;
  assert.equal(await api.verifyIdentityToken(token), "player");
  assert.equal(await api.verifyIdentityToken(token), "player");
  assert.equal(calls, 2);
  t.mock.method(globalThis, "fetch", async () => response(profile({ stats: null })));
  assert.equal((await api.getPlayerProfile("player")).stats, null);
  assert.equal((await api.getPlayerProfile("player")).stats, null);
});

test("array profiles and malformed clan session pages are rejected without populating caches", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response([]));
  const api = new OpenFrontApi("https://example.invalid");
  await assert.rejects(api.getPlayerProfile("player"), OpenFrontApiError);
  const query = { start: "2026-10-15T00:00:00Z", end: "2026-10-16T00:00:00Z", limit: 1 };
  const empty = { results: [], total: 0, page: 1, limit: 1 };
  t.mock.method(globalThis, "fetch", async () => response({ ...empty, total: -1 }));
  await assert.rejects(api.getClanSessions("test", query), OpenFrontApiError);
  t.mock.method(globalThis, "fetch", async () => response(empty));
  assert.deepEqual(await api.getClanSessions("test", query), empty);
});

test("OpenFront stats sum disjoint buckets without counting recent windows or MIRV submunitions twice", () => {
  const summary = summarizePlayerStats({
    Public: { "Free For All": { Easy: leaf(4, 6, { units: { city: ["12"] }, bombs: { abomb: ["2"], mirv: ["1"], mirvw: ["99"] } }) } },
    Private: { Team: { Hard: leaf(3, 1) } }, Singleplayer: { "Humans Vs Nations": { Impossible: leaf(2, 0) } },
    Ranked: { "1v1": leaf(1, 1), futureType: leaf(1, 0) },
    recent: { all: { games: 6, wins: 4 }, Public: { all: { games: 5, wins: 3 } } },
  });
  assert.equal(summary.games, 19n);
  assert.equal(summary.wins, 11n);
  assert.equal(summary.losses, 8n);
  assert.equal(summary.details.find((item) => item.name === "Nukes launched").value, 3n);
  assert.deepEqual(summary.recent, { games: 6, wins: 4 });
  assert.equal(winRate(summary.wins, summary.games), "57.9%");
});

test("missing or null statistics are unavailable; huge counters preserve integer precision", () => {
  for (const stats of [undefined, null, {}, { Public: null }, { recent: { all: { games: 100, wins: 50 } } }]) assert.equal(summarizePlayerStats(stats), null);
  const games = 9007199254740993n;
  const summary = summarizePlayerStats({ Ranked: { "1v1": leaf(games, 0) } });
  assert.equal(summary.games, games);
  assert.equal(winRate(summary.wins, summary.games), "100.0%");
  assert.equal(winRate(0n, 0n), "—");
  assert.equal(winRate(0n, 5n), "0.0%");
  assert.deepEqual(summary.details, []);
});

test("building graphs use built slots, separate modes and distinguish missing counters from zero", () => {
  const stats = { Public: { "Free For All": { Easy: leaf(2, 1, { units: {
    city: ["10", "999"], port: ["0"], defp: ["3"], fact: ["2"], silo: ["1"],
  } }), Hard: leaf(1, 0, { units: { city: ["5"] } }) }, Team: { Easy: leaf(1, 1, { units: { city: ["90"] } }) } } };
  const ffa = summarizePlayerStats(stats, "ffa"), teams = summarizePlayerStats(stats, "teams");
  assert.deepEqual(ffa.buildings.map((row) => row.value), [15n, 0n, 3n, 2n, 1n]);
  assert.equal(ffa.buildings[0].partial, false);
  assert.equal(ffa.buildings[1].partial, true);
  assert.equal(teams.buildings[0].value, 90n);
  assert.equal(teams.buildings[1].value, null);
});

test("graph columns align with zero, missing, partial and very large counts", async () => {
  const { alignedBarChart } = await import("../dist/commands/statsGraph.js");
  const chart = alignedBarChart([{ name: "Cities", value: 12345678901234567890n }, { name: "Defense posts", value: 0n },
    { name: "Ports", value: null }, { name: "Missile silos", value: 12n, partial: true }]);
  const lines = chart.split("\n").slice(1, -1);
  assert.ok(lines.every((line) => line.length === 34));
  assert.ok(lines.every((line) => line[13] === " " && line[24] === " "));
  assert.match(lines[2], /N\/A/);
  assert.match(lines[3], /12\+/);
  assert.ok(chart.length < 1024);
});

test("coverage counts current Discord humans without requesting clan totals", async (t) => {
  const members = new Map([["linked", { id: "linked", user: { bot: false } }], ["unlinked", { id: "unlinked", user: { bot: false } }], ["bot", { id: "bot", user: { bot: true } }]]);
  t.mock.method(db, "getEffectiveLinks", () => [{ discord_id: "linked", openfront_id: "player" }, { discord_id: "bot", openfront_id: "robot" }, { discord_id: "another-server", openfront_id: "private" }]);
  t.mock.method(openfrontApi, "getPlayerProfile", async (id) => {
    assert.equal(id, "player");
    return profile({ clans: [{ tag: "test" }] });
  });
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected OpenFront request"); });
  const { embeds: [embed], assertCurrent } = await buildCoverageReport({ id: "guild", members: { cache: members, fetch: async () => members } }, [config()]);
  assertCurrent();
  assert.equal(upstream.mock.callCount(), 0);
  const fields = embed.toJSON().fields;
  assert.match(fields.find((field) => field.name === "Discord Members Linked").value, /1 \/ 2 \(50.0%\)/);
  assert.match(fields.find((field) => field.name.includes("Clan Members Linked")).value, /1 confirmed linked here.*Full clan size is unavailable/);
  assert.match(embed.toJSON().description, /outside this Discord server are not checked/);
});

test("coverage reports API failures as incomplete membership checks", async (t) => {
  const members = new Map([["linked", { id: "linked", user: { bot: false } }]]);
  t.mock.method(db, "getEffectiveLinks", () => [{ discord_id: "linked", openfront_id: "player" }]);
  t.mock.method(openfrontApi, "getPlayerProfile", async () => { throw new OpenFrontApiError(); });
  const { embeds: [embed], assertCurrent } = await buildCoverageReport({ id: "guild", members: { cache: members, fetch: async () => members } }, [config()]);
  assertCurrent();
  assert.match(embed.toJSON().fields.find((field) => field.name === "Current Clan Membership Checks").value, /1 unavailable.*counts are partial/);
  assert.equal(embed.toJSON().color, 0xf59e0b);
});

test("doctor checks live hierarchy, deleted log channels, uncached API, and retry backlog", async (t) => {
  const roles = new Map([["member", { id: "member", managed: false }], ["manager", { id: "manager", managed: false }]]);
  const guild = { id: "guild", roles: { fetch: async () => roles }, members: { fetchMe: async () => ({ permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => -1 } } }) }, channels: { fetch: async () => null } };
  const probe = t.mock.method(openfrontApi, "getClanSessions", async (tag, query, options) => {
    assert.equal(tag, "TEST");
    assert.equal(query.limit, 1);
    assert.equal(Date.parse(query.end) - Date.parse(query.start), 86_400_000);
    assert.equal(options.fresh, true);
    return { results: [], total: 0, page: 1, limit: 1 };
  });
  const [embed] = await buildDoctorEmbeds(guild, [config({ log_channel_id: "deleted" }), config({ clan_tag: "NEXT" })], { accessRoleId: "manager", jobs: { pending: 2, retrying: 1, oldestAvailableAt: Date.now() - 60 * 60_000, lastError: "Missing Permissions" } });
  assert.match(embed.toJSON().description, /2 pending; 1 retrying/);
  assert.match(embed.toJSON().description, /over 15 minutes/);
  assert.match(embed.toJSON().fields[0].value, /above the member role/);
  assert.match(embed.toJSON().fields[0].value, /log channel was deleted/);
  assert.match(embed.toJSON().description, /public clan sessions endpoint is reachable/);
  assert.equal(probe.mock.callCount(), 1);
  assert.equal(embed.toJSON().color, 0xf59e0b);
});

test("stats shows public FFA graph and switches to exact Team stats", async (t) => {
  t.mock.method(db, "getEffectiveLinkByOpenFrontId", () => null);
  t.mock.method(openfrontApi, "getPlayerProfile", async () => profile({ stats: { Public: {
    "Free For All": { Easy: leaf(3, 1, { units: { city: ["9"] } }) }, Team: { Easy: leaf(2, 2) },
    "Humans Vs Nations": { Easy: leaf(40, 0) },
  }, Private: { "Free For All": { Easy: leaf(99, 0) } } } }));
  const interaction = { guildId: "guild", user: { id: "stats-reader" }, options: { getUser: () => null, getString: (name) => name === "openfront_id" ? "player" : null }, deferReply: async () => {}, editReply: async function (value) { this.output = value; return { id: "stats-message" }; } };
  await statsCommand.execute(interaction);
  const fields = interaction.output.embeds[0].toJSON().fields;
  assert.match(fields.find((field) => field.name === "Free For All Stats").value, /75\.0%/);
  assert.match(fields.find((field) => field.name === "Wins \/ losses").value, /Wins\s+█/);
  assert.match(fields.find((field) => field.name === "Lifetime totals").value, /Cities built: \*\*9\*\*/);
  assert.match(fields.find((field) => field.name.startsWith("Buildings built")).value, /^```text\nCities\s+█+\s+9/);
  assert.match(interaction.output.embeds[0].toJSON().footer.text, /^Public matches/);
  const switched = { customId: interaction.output.components[0].components.find((button) => button.data.label === "Teams").data.custom_id,
    user: { id: "stats-reader" }, guildId: "guild", message: { id: "stats-message" }, isButton: () => true,
    deferUpdate: async () => {}, editReply: async function (value) { this.output = value; }, reply: async () => { throw new Error("unexpected stale tab"); } };
  assert.equal(await handleStatsInteraction(switched), true);
  assert.match(switched.output.embeds[0].toJSON().fields.find((field) => field.name === "Teams Stats").value, /50\.0%/);
  assert.match(switched.output.embeds[0].toJSON().footer.text, /Teams/);
});
