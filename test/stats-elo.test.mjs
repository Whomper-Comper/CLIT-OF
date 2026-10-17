import assert from "node:assert/strict";
import { after, test } from "node:test";
import dotenv from "dotenv";

dotenv.config = () => ({ parsed: {} });
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { openfrontApi } = await import("../dist/api.js");
const { statsCommand, handleStatsInteraction } = await import("../dist/commands/stats.js");
after(() => db.close());

let sequence = 0;
async function setup(t, options = {}) {
  const index = ++sequence, player = `elo-player-${index}`, guild = `elo-guild-${index}`, user = `elo-reader-${index}`;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  if (options.linked) db.linkUser(user, player, "Player", "identity_token");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ username: "Player", createdAt: "2025-01-01T00:00:00Z", clans: [], stats: null }));
  t.mock.method(openfrontApi, "getPlayerRatings", async () => {
    if (options.beforeRatings) await options.beforeRatings();
    return { ratings: (options.ratings ?? [{ ladder: "1v1", rating: 1350, rank: 1 }]).map(rating => ({ ...rating, publicId: player })),
      complete: options.complete ?? true, pages: 1, observedAt: new Date(now).toISOString() };
  });
  t.mock.method(openfrontApi, "getPlayerGames", async () => {
    if (options.beforeGames) await options.beforeGames();
    return { results: [{ gameId: "sensitive-match", start: new Date(now - 1000).toISOString(), durationSeconds: 60,
      map: "World", mode: "Free For All", type: "Public", playerTeams: "", rankedType: "", result: "victory", totalPlayers: 10, username: "Player", clanTag: "TEST" }], nextCursor: options.nextCursor ?? null };
  });
  const interaction = { guildId: guild, user: { id: user }, options: { getUser: () => null, getString: (key) => ({ openfront_id: player, period: options.period })[key] ?? null },
    deferReply: async () => {}, editReply: async function (value) { this.output = value; return { id: user }; } };
  await statsCommand.execute(interaction);
  const click = async (action) => {
    const component = interaction.output.components.flatMap(row => row.components).find(item => item.data.custom_id.endsWith(`:${action}`));
    assert.ok(component, `Missing control ${action}`);
    const event = { customId: component.data.custom_id, guildId: guild, user: interaction.user, message: { id: user }, isButton: () => true,
      deferUpdate: async () => {}, editReply: async value => { interaction.output = value; }, reply: async function (value) { this.notice = value; }, followUp: async function (value) { this.notice = value; } };
    await handleStatsInteraction(event);
    return event;
  };
  return { interaction, click, player, guild, user, now: () => now, advance: ms => { now += ms; } };
}
const fields = fixture => fixture.interaction.output.embeds[0].toJSON().fields;
const text = fixture => JSON.stringify(fixture.interaction.output.embeds[0].toJSON());

for (const change of ["deletion", "unlink", "settings"]) {
  test(`cached Elo cannot be published after ${change}`, async t => {
    const f = await setup(t, { linked: change === "unlink" });
    await f.click("elo");
    assert.equal(fields(f).find(field => field.name === "Latest observed Elo").value, "1,350");
    if (change === "deletion") db.history.purgePlayer(f.player);
    if (change === "unlink") db.unlinkUser(f.user);
    if (change === "settings") {
      const settings = db.history.getSettings(f.guild);
      const disabled = db.history.saveSettings(f.guild, { ...settings, player_history_enabled: 0 }, settings.revision);
      db.history.saveSettings(f.guild, { ...disabled, player_history_enabled: 1 }, disabled.revision);
    }
    await f.click("numbers");
    assert.equal(fields(f).some(field => field.name === "Latest observed Elo"), false);
    assert.doesNotMatch(text(f), /1,350/);
    assert.match(text(f), /changed|deleted|again/i);
    assert.equal(f.interaction.output.files.length, 0);
  });
}

test("cached filtered match history cannot be published after deletion", async t => {
  const f = await setup(t, { period: "7d" });
  await f.click("history");
  assert.match(text(f), /sensitive-match/);
  db.history.purgePlayer(f.player);
  await f.click("numbers");
  assert.doesNotMatch(text(f), /sensitive-match/);
  await f.click("stats");
  assert.equal(fields(f).some(field => field.name.includes("recorded results")), false);
});

for (const change of ["deletion", "unlink", "settings"]) {
  test(`in-flight Elo cannot store or publish ratings after ${change}`, async t => {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const f = await setup(t, { linked: change === "unlink", beforeRatings: async () => {
      entered(); await new Promise(resolve => { release = resolve; });
    } });
    const pending = f.click("elo");
    await waiting;
    if (change === "deletion") db.history.purgePlayer(f.player);
    if (change === "unlink") db.unlinkUser(f.user);
    if (change === "settings") {
      const settings = db.history.getSettings(f.guild);
      db.history.saveSettings(f.guild, { ...settings, retention_days: 14 }, settings.revision);
    }
    release();
    await pending;
    assert.equal(fields(f).some(field => field.name === "Latest observed Elo"), false);
    assert.equal(f.interaction.output.files.length, 0);
    assert.deepEqual(db.history.getEloHistory(f.guild, f.player, "1v1", "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z"), []);
  });
}

test("unfiltered cached match history is cleared after an identity unlink", async t => {
  const f = await setup(t, { linked: true });
  await f.click("history");
  assert.match(text(f), /sensitive-match/);
  db.unlinkUser(f.user);
  await f.click("graphs");
  assert.doesNotMatch(text(f), /sensitive-match/);
  assert.match(text(f), /identity link changed/i);
});

test("a failed history refresh cannot republish cached games deleted while it loaded", async t => {
  let calls = 0, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { nextCursor: "more", beforeGames: async () => {
    if (++calls === 1) return;
    entered(); await new Promise(resolve => { release = resolve; });
    throw new Error("history endpoint unavailable");
  } });
  await f.click("history");
  const pending = f.click("next");
  await waiting;
  db.history.purgePlayer(f.player);
  release();
  await pending;
  assert.doesNotMatch(text(f), /sensitive-match/);
  assert.match(text(f), /deleted/);
});

test("cached leaderboard warnings follow the selected ladder", async t => {
  const f = await setup(t, { ratings: [{ ladder: "2v2", rating: 1460, rank: 20 }] });
  await f.click("elo");
  assert.match(text(f), /not found on the selected/);
  await f.click("elo-2v2");
  assert.equal(fields(f).find(field => field.name === "Latest observed Elo").value, "1,460");
  assert.doesNotMatch(text(f), /not found on the selected/);
  await f.click("elo-ffa");
  assert.match(text(f), /not found on the selected/);
});

test("bounded leaderboard absence remains qualified for each missing ladder", async t => {
  const f = await setup(t, { complete: false, ratings: [{ ladder: "2v2", rating: 1460, rank: 20 }] });
  await f.click("elo");
  assert.match(text(f), /does not prove they are unranked/);
  await f.click("elo-2v2");
  assert.doesNotMatch(text(f), /bounded leaderboard lookup/);
  await f.click("elo-ffa");
  assert.match(text(f), /does not prove they are unranked/);
});

test("Elo graph attachment is reused for unchanged samples and replaced when samples change", async t => {
  const f = await setup(t);
  await f.click("elo");
  const first = f.interaction.output.files[0].attachment;
  await f.click("numbers");
  assert.equal(f.interaction.output.files.length, 0);
  await f.click("graphs");
  assert.strictEqual(f.interaction.output.files[0].attachment, first);
  f.advance(1000);
  db.history.recordElo(f.guild, f.player, null, "1v1", 1400, f.now());
  await f.click("numbers");
  assert.equal(fields(f).find(field => field.name === "Latest observed Elo").value, "1,400");
  await f.click("graphs");
  assert.notStrictEqual(f.interaction.output.files[0].attachment, first);
  assert.notDeepEqual(f.interaction.output.files[0].attachment, first);
});

test("switching ladders reuses only the matching graph attachment", async t => {
  const f = await setup(t, { ratings: [{ ladder: "1v1", rating: 1300, rank: 1 },
    { ladder: "2v2", rating: 1500, rank: 2 }] });
  await f.click("elo");
  const first = f.interaction.output.files[0].attachment;
  await f.click("elo-2v2");
  assert.notStrictEqual(f.interaction.output.files[0].attachment, first);
  assert.equal(fields(f).find(field => field.name === "Latest observed Elo").value, "1,500");
  await f.click("elo-1v1");
  assert.strictEqual(f.interaction.output.files[0].attachment, first);
});

test("Elo graph refresh drops samples removed from storage", async t => {
  const f = await setup(t);
  await f.click("elo");
  db.history.clearGuildPlayerHistory(f.guild);
  await f.click("numbers");
  assert.equal(fields(f).some(field => field.name === "Latest observed Elo"), false);
  await f.click("graphs");
  assert.equal(f.interaction.output.files.length, 0);
});
