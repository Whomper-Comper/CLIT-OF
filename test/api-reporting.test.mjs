import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { OpenFrontApi, OpenFrontApiError, openfrontApi } = await import("../dist/api.js");
const { summarizePlayerStats, winRate } = await import("../dist/playerStats.js");
const { buildCoverageEmbeds, buildDoctorEmbeds } = await import("../dist/reporting.js");
const { whoisCommand, handleWhoisStatsInteraction } = await import("../dist/commands/whois.js");
const { db } = await import("../dist/db.js");
after(() => db.close());

const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const profile = (overrides = {}) => ({ createdAt: "2025-01-01T00:00:00.000Z", username: "Player", clans: [], ...overrides });
const clan = (overrides = {}) => ({ tag: "TEST", name: "Test Clan", description: "", memberCount: 20, ...overrides });
const leaf = (wins, losses, stats = {}) => ({ wins: String(wins), losses: String(losses), total: String(BigInt(wins) + BigInt(losses)), stats });
const config = (overrides = {}) => ({ guild_id: "guild", clan_tag: "TEST", member_role_id: "member", officer_role_id: null,
  leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null, ...overrides });

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

test("clan reads share canonical tags, enforce bounded cache, and retry errors", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(clan()); });
  const api = new OpenFrontApi("https://example.invalid", { maxCacheEntries: 1 });
  await Promise.all([api.getClanInfo("test"), api.getClanInfo(" TEST ")]);
  assert.equal(calls, 1);
  await api.getPlayerProfile("player");
  await api.getClanInfo("test");
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

test("array profiles and malformed clan sizes are rejected without populating caches", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response([]));
  const api = new OpenFrontApi("https://example.invalid");
  await assert.rejects(api.getPlayerProfile("player"), OpenFrontApiError);
  t.mock.method(globalThis, "fetch", async () => response(clan({ memberCount: -1 })));
  await assert.rejects(api.getClanInfo("test"), OpenFrontApiError);
  t.mock.method(globalThis, "fetch", async () => response(clan()));
  assert.equal((await api.getClanInfo("test")).memberCount, 20);
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

test("coverage counts current Discord humans and describes clan figures as a lower bound", async (t) => {
  const members = new Map([["linked", { id: "linked", user: { bot: false } }], ["unlinked", { id: "unlinked", user: { bot: false } }], ["bot", { id: "bot", user: { bot: true } }]]);
  t.mock.method(db, "getEffectiveLinks", () => [{ discord_id: "linked", openfront_id: "player" }, { discord_id: "bot", openfront_id: "robot" }, { discord_id: "another-server", openfront_id: "private" }]);
  t.mock.method(openfrontApi, "getPlayerProfile", async (id) => {
    assert.equal(id, "player");
    return profile({ clans: [{ tag: "test" }] });
  });
  t.mock.method(openfrontApi, "getClanInfo", async () => clan());
  const [embed] = await buildCoverageEmbeds({ id: "guild", members: { fetch: async () => members } }, [config()]);
  const fields = embed.toJSON().fields;
  assert.match(fields.find((field) => field.name === "Discord Members Linked").value, /1 \/ 2 \(50.0%\)/);
  assert.match(fields.find((field) => field.name.includes("Clan Members Linked")).value, /At least 1 \/ 20 \(5.0%\)/);
  assert.match(embed.toJSON().description, /outside this Discord server are not checked/);
});

test("coverage reports API failures as incomplete membership checks", async (t) => {
  const members = new Map([["linked", { user: { bot: false } }]]);
  t.mock.method(db, "getEffectiveLinks", () => [{ discord_id: "linked", openfront_id: "player" }]);
  t.mock.method(openfrontApi, "getPlayerProfile", async () => { throw new OpenFrontApiError(); });
  t.mock.method(openfrontApi, "getClanInfo", async () => clan());
  const [embed] = await buildCoverageEmbeds({ id: "guild", members: { fetch: async () => members } }, [config()]);
  assert.match(embed.toJSON().fields.find((field) => field.name === "Current Clan Membership Checks").value, /1 unavailable.*counts are partial/);
  assert.equal(embed.toJSON().color, 0xf59e0b);
});

test("doctor checks live hierarchy, deleted log channels, uncached API, and retry backlog", async (t) => {
  const roles = new Map([["member", { id: "member", managed: false }], ["manager", { id: "manager", managed: false }]]);
  const guild = { id: "guild", roles: { fetch: async () => roles }, members: { fetchMe: async () => ({ permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => -1 } } }) }, channels: { fetch: async () => null } };
  t.mock.method(openfrontApi, "getClanInfo", async (_tag, options) => { assert.equal(options.fresh, true); return clan(); });
  const [embed] = await buildDoctorEmbeds(guild, [config({ log_channel_id: "deleted" })], { accessRoleId: "manager", jobs: { pending: 2, retrying: 1, oldestAvailableAt: Date.now() - 60 * 60_000, lastError: "Missing Permissions" } });
  assert.match(embed.toJSON().description, /2 pending; 1 retrying/);
  assert.match(embed.toJSON().description, /over 15 minutes/);
  assert.match(embed.toJSON().fields[0].value, /above the member role/);
  assert.match(embed.toJSON().fields[0].value, /log channel was deleted/);
  assert.match(embed.toJSON().fields[0].value, /API is reachable/);
  assert.equal(embed.toJSON().color, 0xf59e0b);
});

test("whois shows FFA graph and switches to the Teams stats tab", async (t) => {
  t.mock.method(db, "getEffectiveLinkByOpenFrontId", () => null);
  t.mock.method(openfrontApi, "getPlayerProfile", async () => profile({ stats: { Public: {
    "Free For All": { Easy: leaf(3, 1, { units: { city: ["9"] } }) }, Team: { Easy: leaf(2, 2) },
  } } }));
  const interaction = { guildId: "guild", user: { id: "stats-reader" }, options: { getUser: () => null, getString: () => "player" }, deferReply: async () => {}, editReply: async function (value) { this.output = value; } };
  await whoisCommand.execute(interaction);
  const fields = interaction.output.embeds[0].toJSON().fields;
  assert.match(fields.find((field) => field.name === "Free For All Stats").value, /75\.0%/);
  assert.match(fields.find((field) => field.name === "Wins \/ losses").value, /Wins\s+█/);
  assert.deepEqual(interaction.output.components[0].components.map((button) => button.data.label), ["Free For All", "Teams"]);
  assert.match(fields.find((field) => field.name === "Lifetime totals").value, /Cities built: \*\*9\*\*/);
  const switched = { customId: interaction.output.components[0].components[1].data.custom_id,
    user: { id: "stats-reader" }, isButton: () => true,
    update: async function (value) { this.output = value; }, reply: async () => { throw new Error("unexpected stale tab"); } };
  assert.equal(await handleWhoisStatsInteraction(switched), true);
  assert.match(switched.output.embeds[0].toJSON().fields.find((field) => field.name === "Teams Stats").value, /50\.0%/);
});
