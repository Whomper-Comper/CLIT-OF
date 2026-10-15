import assert from "node:assert/strict";
import { after, test } from "node:test";

// Never open the operator's database or contact Discord during tests.
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
process.env.DEFAULT_SYNC_INTERVAL_MINS = "25";
const { db } = await import("../dist/db.js");
const { CONFIG, validateConfig } = await import("../dist/config.js");
const { openfrontApi } = await import("../dist/api.js");
const { ClanSyncService } = await import("../dist/clanSync.js");
const { clanCommand } = await import("../dist/commands/clan.js");
after(() => db.close());

const config = {
  guild_id: "guild", clan_tag: "TEST", member_role_id: "member",
  officer_role_id: null, leader_role_id: null, join_role_id: "join",
  log_channel_id: null, sync_interval_mins: 25, last_sync_at: null,
};

test("configuration rejects missing credentials and invalid intervals", () => {
  const saved = { ...CONFIG };
  try {
    validateConfig();
    for (const value of [NaN, 0, 1, 2.5, 1441]) {
      CONFIG.DEFAULT_SYNC_INTERVAL_MINS = value;
      assert.throws(validateConfig, /integer between/);
    }
    CONFIG.DISCORD_TOKEN = "";
    assert.throws(validateConfig, /DISCORD_TOKEN/);
  } finally { Object.assign(CONFIG, saved); }
});

test("admin and clan mutations reject absent or insufficient permissions", async () => {
  for (const permissions of [null, { has: () => false }]) {
    for (const [command, sub] of [[clanCommand, "link"], [clanCommand, "unlink"], [clanCommand, "setup"], [clanCommand, "remove"]]) {
      let reply;
      await command.execute({ guild: { id: "guild" }, memberPermissions: permissions,
        options: { getSubcommand: () => sub }, reply: async (value) => { reply = value; } });
      assert.match(reply.content, /permission/);
    }
  }
});

test("clan setup uses the configured default interval", async (t) => {
  t.mock.method(openfrontApi, "getClanInfo", async () => null);
  await clanCommand.execute({ guild: { id: "guild" }, memberPermissions: { has: () => true },
    options: { getSubcommand: () => "setup", getString: () => "TEST",
      getRole: (name) => name === "member_role" ? { id: "member" } : null,
      getChannel: () => null, getInteger: () => null },
    deferReply: async () => {}, editReply: async () => {},
  });
  assert.equal(db.getGuildClanConfig("guild", "TEST").sync_interval_mins, 25);
});

test("username refresh preserves link timestamp and verification", async (t) => {
  db.linkUser("user", "player", "Old", "identity_token");
  const before = db.getUserByDiscordId("user");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ username: "New", clans: [] }));
  const member = { id: "user", roles: { cache: new Map() } };
  await new ClanSyncService({}).syncMemberForClan(member, before, config);
  assert.deepEqual({ ...db.getUserByDiscordId("user") }, { ...before, openfront_username: "New" });
});

test("API failures neither remove roles nor announce pending invitations", async (t) => {
  db.setGuildClanConfig(config);
  db.linkUser("user", "player", "Player", "profile_discord");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => null);
  const service = new ClanSyncService({});
  const notices = t.mock.method(service, "logJoinRoleMismatches", async () => {});
  const member = { id: "user", user: { bot: false }, roles: {
    cache: new Map([["join", true], ["member", true]]),
    remove: async () => assert.fail("Must retain roles when the API is unavailable"),
  } };
  const guild = { id: "guild", members: { fetch: async () => new Map([["user", member]]) } };
  const [result] = await service.syncGuildClan(guild, config);
  assert.match(result.error, /API unreachable/);
  assert.equal(notices.mock.callCount(), 0);
  await assert.rejects(service.getPendingJoinMembers(guild, config), /API unavailable/);
});

test("API requests have a timeout and encode player IDs", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(url.endsWith("/public/player/a%2Fb"));
    return { status: 404 };
  });
  assert.equal(await openfrontApi.getPlayerProfile("a/b"), null);
});
