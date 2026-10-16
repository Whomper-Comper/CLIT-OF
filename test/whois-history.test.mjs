import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { openfrontApi, OpenFrontApiError } = await import("../dist/api.js");
const { whoisCommand, handleWhoisStatsInteraction } = await import("../dist/commands/whois.js");
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
    options: { getUser: () => null, getString: () => "player" }, deferReply: async () => {},
    editReply: async function (value) { this.output = value; return { id: `history-message-${suffix}` }; } };
  const click = async (customId, overrides = {}) => {
    const i = { customId, guildId: interaction.guildId, user: interaction.user, message: { id: `history-message-${suffix}` },
      isButton: () => true, deferUpdate: async function () { this.deferred = true; },
      editReply: async function (value) { this.output = value; interaction.output = value; },
      reply: async function (value) { this.replyOutput = value; },
      followUp: async function (value) { this.followUpOutput = value; }, ...overrides };
    assert.equal(await handleWhoisStatsInteraction(i), true);
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
    assert.equal(id, "player"); assert.deepEqual(query, {});
    return { results: [game(1, { username: "**unsafe**", map: "@everyone *map*" }),
      game(2, { result: "incomplete", totalPlayers: null }), game(3, { result: "defeat" })], nextCursor: null };
  });
  await whoisCommand.execute(f.interaction);
  assert.equal(calls, 0);
  assert.match(fields(f.interaction).find((field) => field.name === "OpenFront Statistics").value, /No recorded statistics/);
  await f.click(button(f.interaction, 1, 0));
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
  });
  await whoisCommand.execute(f.interaction);
  await f.click(button(f.interaction, 1, 0));
  assert.equal(fields(f.interaction).filter((field) => field.value.includes("Match ID:")).length, 5);
  await f.click(button(f.interaction, 2, 1));
  assert.equal(queries.length, 1);
  assert.match(fields(f.interaction).find((field) => field.value.includes("Match ID:")).value, /match-5/);
  await f.click(button(f.interaction, 2, 1));
  assert.deepEqual(queries, [{}, { cursor: "next-batch" }]);
  assert.match(fields(f.interaction).find((field) => field.value.includes("Match ID:")).value, /match-6/);
  await f.click(button(f.interaction, 2, 0));
  assert.equal(queries.length, 2);
  assert.match(fields(f.interaction).find((field) => field.value.includes("Match ID:")).value, /match-5/);
  await f.click(button(f.interaction, 1, 1));
  assert.deepEqual(queries.at(-1), { filter: "ffa" });
  await f.click(button(f.interaction, 1, 0));
  assert.equal(queries.length, 3);
  assert.match(f.interaction.output.embeds[0].toJSON().footer.text, /page 2/);
  await f.click(button(f.interaction, 0, 0));
  assert.deepEqual(f.interaction.output.components[0].components.map((item) => item.data.label), ["Free For All", "Teams"]);
});

test("history controls require their original user, server, and message", async (t) => {
  let calls = 0;
  const f = setup(t, async () => { calls++; return { results: [], nextCursor: null }; });
  await whoisCommand.execute(f.interaction);
  const history = button(f.interaction, 1, 0);
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
  await whoisCommand.execute(f.interaction);
  const history = button(f.interaction, 1, 0);
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
  await whoisCommand.execute(f.interaction);
  const original = f.interaction.output;
  const pending = f.click(button(f.interaction, 1, 0));
  await waiting;
  f.setEnabled(0);
  release();
  const result = await pending;
  assert.match(result.followUpOutput.content, /disabled while/);
  assert.equal(f.interaction.output, original);
  const disabled = setup(t, async () => { throw new Error("disabled history must not fetch"); }, { enabled: 0 });
  await whoisCommand.execute(disabled.interaction);
  assert.equal(disabled.interaction.output.components.length, 1);
});

test("expiry during a request cannot refresh the original message", async (t) => {
  let now = Date.now(), release, entered;
  t.mock.method(Date, "now", () => now);
  const waiting = new Promise((resolve) => { entered = resolve; });
  const f = setup(t, async () => { entered(); await new Promise((resolve) => { release = resolve; }); return { results: [game(1)], nextCursor: null }; });
  await whoisCommand.execute(f.interaction);
  const original = f.interaction.output;
  const pending = f.click(button(f.interaction, 1, 0));
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
  await whoisCommand.execute(f.interaction);
  await f.click(button(f.interaction, 1, 0));
  assert.match(fields(f.interaction).find((field) => field.name === "History could not be refreshed").value, /temporarily unavailable/);
  await f.click(button(f.interaction, 0, 1));
  assert.equal(calls, 2);
  assert.match(fields(f.interaction).find((field) => field.name === "Recorded games").value, /No recorded games/);
});

test("unknown or deleted accounts are distinguished from known empty game history", async (t) => {
  let calls = 0;
  const f = setup(t, async () => ++calls === 1 ? null : { results: [], nextCursor: null });
  await whoisCommand.execute(f.interaction);
  await f.click(button(f.interaction, 1, 0));
  const error = fields(f.interaction).find((field) => field.name === "History could not be refreshed");
  assert.match(error.value, /could not find this player's game history/);
  assert.match(error.value, /deleted/);
  assert.equal(fields(f.interaction).some((field) => field.name === "Recorded games"), false);
  assert.doesNotMatch(JSON.stringify(f.interaction.output), /No recorded games/);
  await f.click(button(f.interaction, 0, 1));
  assert.equal(calls, 2);
  assert.match(fields(f.interaction).find((field) => field.name === "Recorded games").value, /No recorded games/);
});

test("history respects Discord field limits with long escaped names and caps retained matches", async (t) => {
  let calls = 0;
  const long = "*_[`".repeat(100);
  const f = setup(t, async () => { calls++; return { results: Array.from({ length: 100 }, (_, index) => game(index,
    { username: long, map: long, mode: long, type: long, rankedType: long, clanTag: long })), nextCursor: "more" }; });
  await whoisCommand.execute(f.interaction);
  await f.click(button(f.interaction, 1, 0));
  for (let index = 0; index < 19; index++) await f.click(button(f.interaction, 2, 1));
  assert.equal(calls, 1);
  assert.equal(f.interaction.output.components[2].components[1].data.disabled, true);
  const embed = f.interaction.output.embeds[0];
  assert.ok(embed.length <= 6000);
  assert.ok(embed.toJSON().fields.every((field) => field.name.length <= 256 && field.value.length <= 1024));
});
