import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { openfrontApi, OpenFrontApiError } = await import("../dist/api.js");
const { statsCommand, handleStatsInteraction } = await import("../dist/commands/stats.js");
after(() => db.close());

let sequence = 0;
const game = (number, overrides = {}) => ({ gameId: `match-${number}`, start: "2026-10-10T12:00:00Z",
  durationSeconds: 960, map: "World", mode: "Team", type: "Public", playerTeams: "Red", rankedType: "",
  result: "victory", totalPlayers: 50, username: "Player", clanTag: "TEST", ...overrides });
function setup(t, games, options = {}) {
  const suffix = ++sequence;
  let enabled = options.enabled ?? 1;
  t.mock.method(db.history, "getSettings", () => ({ player_history_enabled: enabled }));
  t.mock.method(db, "getEffectiveLinkByOpenFrontId", () => null);
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ username: "Player", createdAt: "2025-01-01T00:00:00Z", clans: [], stats: options.stats }));
  t.mock.method(openfrontApi, "getPlayerGames", games);
  const interaction = { guildId: options.dm ? null : `history-guild-${suffix}`, user: { id: `history-reader-${suffix}` },
    options: { getUser: () => null, getString: (name) => ({ openfront_id: "player", view: options.view, scope: options.scope, mode: options.mode })[name] ?? null }, deferReply: async () => {},
    editReply: async function (value) { this.output = value; return { id: `history-message-${suffix}` }; } };
  const click = async (customId, overrides = {}) => {
    const i = { customId, guildId: interaction.guildId, user: interaction.user, message: { id: `history-message-${suffix}` },
      isButton: () => true, deferUpdate: async function () { this.deferred = true; },
      editReply: async function (value) { this.output = value; interaction.output = value; },
      reply: async function (value) { this.replyOutput = value; },
      followUp: async function (value) { this.followUpOutput = value; }, ...overrides };
    assert.equal(await handleStatsInteraction(i), true);
    return i;
  };
  return { interaction, click, setEnabled: (value) => { enabled = value; } };
}
const button = (interaction, row, column) => interaction.output.components[row].components[column].data.custom_id;
const fields = (interaction) => interaction.output.embeds[0].toJSON().fields;

test("history loads lazily for profiles without lifetime stats, and incomplete games are not losses", async (t) => {
  let calls = 0;
  const f = setup(t, async (id, query) => {
    calls++;
    assert.equal(id, "player"); assert.deepEqual(query, { filter: "ffa", type: "public" });
    return { results: [game(1, { username: "**unsafe**", map: "@everyone *map*" }),
      game(2, { result: "incomplete", totalPlayers: null }), game(3, { result: "defeat" })], nextCursor: null };
  });
  await statsCommand.execute(f.interaction);
  assert.equal(calls, 0);
  assert.match(fields(f.interaction).find((field) => field.name === "Free For All Stats").value, /No recorded statistics/);
  await f.click(button(f.interaction, 1, 1));
  assert.equal(calls, 1);
  assert.match(fields(f.interaction).find((field) => field.name.includes("completed win rate")).name, /50\.0%/);
  assert.match(fields(f.interaction).find((field) => field.name.startsWith("Incomplete")).value, /Unknown player count/);
  assert.match(fields(f.interaction).find((field) => field.name.startsWith("Victory")).value, /\\\*\\\*unsafe\\\*\\\*/);
  assert.deepEqual(f.interaction.output.allowedMentions, { parse: [] });
  assert.doesNotMatch(JSON.stringify(f.interaction.output), /openfront\.io\/(?:game|replay)/);
});

test("history splits bounded API batches into five-game pages and preserves cached previous pages and filters", async (t) => {
  const queries = [];
  const f = setup(t, async (_id, query) => {
    queries.push(query);
    if (query.filter) return { results: [game(100, { mode: "Free For All" })], nextCursor: null };
    return query.cursor ? { results: Array.from({ length: 6 }, (_, index) => game(index + 6)), nextCursor: null }
      : { results: Array.from({ length: 6 }, (_, index) => game(index)), nextCursor: "next-batch" };
  }, { mode: "all" });
  await statsCommand.execute(f.interaction);
  await f.click(button(f.interaction, 1, 1));
  assert.equal(fields(f.interaction).filter((field) => field.value.includes("Match ID:")).length, 5);
  await f.click(button(f.interaction, 2, 1));
  assert.equal(queries.length, 1);
  assert.match(fields(f.interaction).find((field) => field.value.includes("Match ID:")).value, /match-5/);
  await f.click(button(f.interaction, 2, 1));
  assert.deepEqual(queries, [{ type: "public" }, { type: "public", cursor: "next-batch" }]);
  assert.match(fields(f.interaction).find((field) => field.value.includes("Match ID:")).value, /match-6/);
  await f.click(button(f.interaction, 2, 0));
  assert.equal(queries.length, 2);
  assert.match(fields(f.interaction).find((field) => field.value.includes("Match ID:")).value, /match-5/);
  await f.click(button(f.interaction, 0, 0));
  assert.deepEqual(queries.at(-1), { filter: "ffa", type: "public" });
  await f.click(button(f.interaction, 0, 4));
  assert.equal(queries.length, 3);
  assert.match(f.interaction.output.embeds[0].toJSON().footer.text, /page 2/);
  await f.click(button(f.interaction, 1, 0));
  assert.deepEqual(f.interaction.output.components[0].components.map((item) => item.data.label), ["Free For All", "Teams", "Humans Vs Nations", "Ranked", "All modes"]);
});

test("history controls require their original user, server, and message", async (t) => {
  let calls = 0;
  const f = setup(t, async () => { calls++; return { results: [], nextCursor: null }; });
  await statsCommand.execute(f.interaction);
  const history = button(f.interaction, 1, 1);
  for (const overrides of [{ user: { id: "another-user" } }, { guildId: "another-guild" }, { message: { id: "another-message" } }]) {
    const click = await f.click(history, overrides);
    assert.ok(click.replyOutput);
    assert.equal(click.deferred, undefined);
  }
  assert.equal(calls, 0);
});

test("busy history controls prevent overlapping requests", async (t) => {
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const f = setup(t, async () => { entered(); await new Promise((resolve) => { release = resolve; }); return { results: [game(1)], nextCursor: null }; });
  await statsCommand.execute(f.interaction);
  const history = button(f.interaction, 1, 1);
  const first = f.click(history);
  await waiting;
  const second = await f.click(history);
  assert.match(second.replyOutput.content, /still loading/);
  release();
  await first;
});

test("disabling history during a request prevents publication and removes the entry point on new profiles", async (t) => {
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const f = setup(t, async () => { entered(); await new Promise((resolve) => { release = resolve; }); return { results: [game(1)], nextCursor: null }; });
  await statsCommand.execute(f.interaction);
  const original = f.interaction.output;
  const pending = f.click(button(f.interaction, 1, 1));
  await waiting;
  f.setEnabled(0);
  release();
  const result = await pending;
  assert.match(result.followUpOutput.content, /disabled while/);
  assert.equal(f.interaction.output, original);
  const disabled = setup(t, async () => { throw new Error("disabled history must not fetch"); }, { enabled: 0 });
  await statsCommand.execute(disabled.interaction);
  assert.equal(disabled.interaction.output.components.length, 3);
  assert.deepEqual(disabled.interaction.output.components[1].components.map((item) => item.data.label), ["Statistics", "Buildings"]);
});

test("expiry during a request cannot refresh the original message", async (t) => {
  let now = Date.now(), release, entered;
  t.mock.method(Date, "now", () => now);
  const waiting = new Promise((resolve) => { entered = resolve; });
  const f = setup(t, async () => { entered(); await new Promise((resolve) => { release = resolve; }); return { results: [game(1)], nextCursor: null }; });
  await statsCommand.execute(f.interaction);
  const original = f.interaction.output;
  const pending = f.click(button(f.interaction, 1, 1));
  await waiting;
  now += 11 * 60_000;
  release();
  const result = await pending;
  assert.match(result.followUpOutput.content, /expired while loading/);
  assert.equal(f.interaction.output, original);
});

test("history errors leave a retry control and DMs permit public player history", async (t) => {
  let calls = 0;
  const f = setup(t, async () => { if (++calls === 1) throw new OpenFrontApiError("http", 503); return { results: [], nextCursor: null }; }, { dm: true });
  await statsCommand.execute(f.interaction);
  await f.click(button(f.interaction, 1, 1));
  assert.match(fields(f.interaction).find((field) => field.name === "History could not be refreshed").value, /temporarily unavailable/);
  await f.click(button(f.interaction, 1, 1));
  assert.equal(calls, 2);
  assert.match(fields(f.interaction).find((field) => field.name === "Recorded games").value, /No recorded games/);
});

test("unknown or deleted accounts are distinguished from known empty game history", async (t) => {
  let calls = 0;
  const f = setup(t, async () => ++calls === 1 ? null : { results: [], nextCursor: null });
  await statsCommand.execute(f.interaction);
  await f.click(button(f.interaction, 1, 1));
  const error = fields(f.interaction).find((field) => field.name === "History could not be refreshed");
  assert.match(error.value, /could not find this player's game history/);
  assert.match(error.value, /deleted/);
  assert.equal(fields(f.interaction).some((field) => field.name === "Recorded games"), false);
  assert.doesNotMatch(JSON.stringify(f.interaction.output), /No recorded games/);
  await f.click(button(f.interaction, 1, 1));
  assert.equal(calls, 2);
  assert.match(fields(f.interaction).find((field) => field.name === "Recorded games").value, /No recorded games/);
});

test("history respects Discord field limits with long escaped names and caps retained matches", async (t) => {
  let calls = 0;
  const long = "*_[`".repeat(100);
  const f = setup(t, async () => { calls++; return { results: Array.from({ length: 100 }, (_, index) => game(index,
    { username: long, map: long, mode: long, type: long, rankedType: long, clanTag: long })), nextCursor: "more" }; });
  await statsCommand.execute(f.interaction);
  await f.click(button(f.interaction, 1, 1));
  for (let index = 0; index < 19; index++) await f.click(button(f.interaction, 2, 1));
  assert.equal(calls, 1);
  assert.equal(f.interaction.output.components[2].components[1].data.disabled, true);
  const embed = f.interaction.output.embeds[0];
  assert.ok(embed.length <= 6000);
  assert.ok(embed.toJSON().fields.every((field) => field.name.length <= 256 && field.value.length <= 1024));
});

test("raw numbers selection persists across statistics tabs and history without graph glyphs", async (t) => {
  const leaf = (wins, losses, units) => ({ wins: String(wins), losses: String(losses), total: String(wins + losses), stats: { units } });
  const f = setup(t, async (_id, query) => {
    assert.deepEqual(query, { filter: "team", type: "public" });
    return { results: [game(1), game(2, { result: "defeat" }), game(3, { result: "incomplete" })], nextCursor: null };
  }, { view: "numbers", stats: { Public: { "Free For All": { Easy: leaf(3, 1, { city: ["12345678901234567890"] }) },
    Team: { Easy: leaf(2, 2, { city: ["15"], port: ["0"] }) } } } });
  await statsCommand.execute(f.interaction);
  assert.match(fields(f.interaction).find((field) => field.name.startsWith("Buildings built")).value, /Cities: \*\*12,345,678,901,234,567,890\*\*/);
  assert.match(fields(f.interaction).find((field) => field.name.startsWith("Buildings built")).value, /Ports: Unavailable/);
  assert.equal(fields(f.interaction).some((field) => field.name === "Wins / losses"), false);
  assert.doesNotMatch(JSON.stringify(f.interaction.output), /[█░]|N\/A = unavailable/);
  await f.click(button(f.interaction, 0, 1));
  assert.match(fields(f.interaction).find((field) => field.name.startsWith("Buildings built")).value, /Cities: \*\*15\*\*\nPorts: \*\*0\*\*/);
  await f.click(button(f.interaction, 1, 1));
  const results = fields(f.interaction).find((field) => field.name.includes("completed win rate"));
  assert.match(results.name, /50\.0%/);
  assert.equal(results.value, "Wins: **1**\nLosses: **1**\nIncomplete: **1**");
  assert.doesNotMatch(JSON.stringify(f.interaction.output), /[█░]/);
});

test("graph view removes the old legend and keeps aligned building and history charts", async (t) => {
  const f = setup(t, async () => ({ results: [game(1)], nextCursor: null }), { stats: {
    Public: { "Free For All": { Easy: { wins: "1", losses: "0", total: "1", stats: { units: { city: ["12"] } } } } },
  } });
  await statsCommand.execute(f.interaction);
  assert.match(fields(f.interaction).find((field) => field.name.startsWith("Buildings built")).value, /^```text\nCities\s+█/);
  assert.doesNotMatch(JSON.stringify(f.interaction.output), /N\/A = unavailable|Exact available totals below/);
  await f.click(button(f.interaction, 1, 1));
  assert.match(fields(f.interaction).find((field) => field.name.includes("completed win rate")).value, /^```text\nWins\s+█/);
});

test("scope filters lifetime counters and every history cursor request consistently", async (t) => {
  const queries = [];
  const f = setup(t, async (_id, query) => {
    queries.push(query);
    return { results: [game(queries.length, { type: "Private" })], nextCursor: query.cursor ? null : "private-next" };
  }, { scope: "private", stats: { Public: { "Free For All": { Easy: { wins: "10", losses: "0", total: "10" } } },
    Private: { "Free For All": { Easy: { wins: "1", losses: "3", total: "4" } } }, Ranked: { "1v1": { wins: "5", losses: "0", total: "5" } } } });
  await statsCommand.execute(f.interaction);
  assert.match(fields(f.interaction).find((field) => field.name === "Free For All Stats").value, /\*\*Games:\*\* 4.*25\.0%/);
  assert.equal(fields(f.interaction).some((field) => field.name.startsWith("Ranked Record")), false);
  assert.match(f.interaction.output.embeds[0].toJSON().footer.text, /^Private matches/);
  await f.click(button(f.interaction, 1, 1));
  await f.click(button(f.interaction, 2, 1));
  await f.click(button(f.interaction, 0, 1));
  assert.deepEqual(queries, [{ filter: "ffa", type: "private" }, { filter: "ffa", type: "private", cursor: "private-next" }, { filter: "team", type: "private" }]);
  assert.match(f.interaction.output.embeds[0].toJSON().footer.text, /^Private matches/);
});

test("all scope omits the API type constraint and is clearly labelled", async (t) => {
  const f = setup(t, async (_id, query) => { assert.deepEqual(query, { filter: "ffa" }); return { results: [game(1)], nextCursor: null }; }, { scope: "all" });
  await statsCommand.execute(f.interaction);
  await f.click(button(f.interaction, 1, 1));
  assert.match(f.interaction.output.embeds[0].toJSON().footer.text, /^All public, private and singleplayer matches/);
});

test("exact lifetime totals remain within Discord limits with very large counters", async (t) => {
  const huge = "9".repeat(100);
  const stats = { Public: { "Free For All": { Easy: { wins: "1", losses: "0", total: "1", stats: {
    units: Object.fromEntries(["city", "port", "defp", "fact", "silo", "wshp"].map((key) => [key, [huge]])),
    bombs: { abomb: [huge], hbomb: [huge], mirv: [huge] }, attacks: [huge], gold: ["0", "0", huge],
  } } } } };
  const f = setup(t, async () => ({ results: [], nextCursor: null }), { stats });
  await statsCommand.execute(f.interaction);
  const lifetime = fields(f.interaction).filter((field) => field.name.startsWith("Lifetime totals"));
  assert.equal(lifetime.length, 2);
  assert.ok(lifetime.every((field) => field.value.length <= 1024));
  assert.match(lifetime.map((field) => field.value).join("\n"), /Trade gold earned:/);
  assert.ok(f.interaction.output.embeds[0].length <= 6000);
});
