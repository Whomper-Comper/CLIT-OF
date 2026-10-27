import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { openfrontApi } = await import("../dist/api.js");
const { ClanSyncService } = await import("../dist/clanSync.js");
after(() => db.close());

function setup(guildId) {
  const config = { guild_id: guildId, clan_tag: "ABC", member_role_id: "rank", officer_role_id: null,
    leader_role_id: null, join_role_id: "approval", log_channel_id: "log", sync_interval_mins: 10, last_sync_at: null };
  db.setGuildClanConfig(config);
  const messages = [];
  let roster;
  const guild = { id: guildId, channels: { cache: new Map([["log", {
    isTextBased: () => true, send: async (payload) => { messages.push(payload); },
  }]]) }, members: { fetch: async () => roster } };
  const member = id => ({ id, guild, user: { bot: false }, roles: {
    cache: new Map([["approval", true]]), add: async () => {}, remove: async () => {},
  } });
  const first = member(`${guildId}-first`), second = member(`${guildId}-second`);
  roster = new Map([[first.id, first], [second.id, second]]);
  db.linkGuildUser(guildId, "manager", second.id, `${guildId}-second-account`, "Second");
  return { config, messages, guild, first, second, setRoster: (value) => { roster = value; } };
}

async function pauseSecond(t, fixture, mutate) {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  t.mock.method(openfrontApi, "getPlayerProfile", async (id) => {
    if (id.endsWith("-second-account")) { entered(); await wait; }
    return { clans: [] };
  });
  const work = new ClanSyncService({ guilds: { cache: new Map() } }).syncGuildClan(fixture.guild, fixture.config);
  await ready;
  mutate();
  release();
  await work;
}

test("pending invite summary excludes an identity unlinked while another member is checked", async (t) => {
  const f = setup("mismatch-unlink");
  db.linkGuildUser(f.guild.id, "manager", f.first.id, "old-account", "First");
  await pauseSecond(t, f, () => db.unlinkGuildUser(f.guild.id, "manager", f.first.id));
  assert.equal(f.messages.length, 1);
  const description = f.messages[0].embeds[0].toJSON().description;
  assert.doesNotMatch(description, /old-account|mismatch-unlink-first/);
  assert.match(description, /mismatch-unlink-second-account/);
});

test("pending invite summary excludes an unlinked entry if that member links while syncing", async (t) => {
  const f = setup("mismatch-link");
  await pauseSecond(t, f, () => db.linkGuildUser(f.guild.id, "manager", f.first.id, "new-account", "First"));
  assert.equal(f.messages.length, 1);
  const description = f.messages[0].embeds[0].toJSON().description;
  assert.doesNotMatch(description, /mismatch-link-first/);
  assert.match(description, /mismatch-link-second-account/);
});

test("pending invite summary excludes members absent from the refreshed roster", async (t) => {
  const f = setup("mismatch-departed");
  await pauseSecond(t, f, () => f.setRoster(new Map([[f.second.id, f.second]])));
  assert.equal(f.messages.length, 1);
  const description = f.messages[0].embeds[0].toJSON().description;
  assert.doesNotMatch(description, /mismatch-departed-first/);
  assert.match(description, /mismatch-departed-second-account/);
});

test("pending invite summary excludes a member whose approval role was removed", async (t) => {
  const f = setup("mismatch-role");
  await pauseSecond(t, f, () => f.first.roles.cache.delete("approval"));
  assert.equal(f.messages.length, 1);
  const description = f.messages[0].embeds[0].toJSON().description;
  assert.doesNotMatch(description, /mismatch-role-first/);
  assert.match(description, /mismatch-role-second-account/);
});

test("pending invite summary excludes an account reverified during the sync", async (t) => {
  const f = setup("mismatch-reverified");
  db.linkGuildUser(f.guild.id, "manager", f.first.id, "same-account", "First");
  await pauseSecond(t, f, () => db.linkGuildUser(f.guild.id, "manager", f.first.id, "same-account", "First"));
  assert.equal(f.messages.length, 1);
  const description = f.messages[0].embeds[0].toJSON().description;
  assert.doesNotMatch(description, /same-account|mismatch-reverified-first/);
  assert.match(description, /mismatch-reverified-second-account/);
});

test("a failed final roster refresh publishes no pending invite summary and does not mark the sync complete", async (t) => {
  const f = setup("mismatch-roster-failure");
  const roster = new Map([[f.first.id, f.first], [f.second.id, f.second]]);
  let fetches = 0;
  f.guild.members.fetch = async () => {
    if (++fetches === 1) return roster;
    throw new Error("roster refresh failed");
  };
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: [] }));
  await assert.rejects(new ClanSyncService({ guilds: { cache: new Map() } }).syncGuildClan(f.guild, f.config), /roster refresh failed/);
  assert.equal(f.messages.length, 0);
  assert.equal(db.getGuildClanConfig(f.guild.id, f.config.clan_tag).last_sync_at, null);
});
