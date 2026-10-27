import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";

const { db } = await import("../dist/db.js");
const { openfrontApi } = await import("../dist/api.js");
const { ClanSyncService } = await import("../dist/clanSync.js");

test("a queued role removal is rejected when another clan starts requiring the role", async (t) => {
  const guild = { id: "cross-config" };
  const config = (tag) => ({ guild_id: guild.id, clan_tag: tag, member_role_id: "shared",
    officer_role_id: null, leader_role_id: null, join_role_id: null, log_channel_id: null,
    sync_interval_mins: 10, last_sync_at: null });
  const first = config("AAA");
  db.setGuildClanConfig(first);
  db.linkUser("cross-user", "cross-id", null, "identity_token");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({
    clans: [{ tag: "BBB", name: "BBB", role: "member", joinedAt: new Date().toISOString() }],
  }));
  const cache = new Map([["shared", true]]);
  const member = { id: "cross-user", guild, roles: { cache,
    add: async (role) => cache.set(role, true), remove: async (role) => cache.delete(role) } };
  const service = new ClanSyncService({ guilds: { cache: new Map() } });
  service.rolePacer.run = async (work) => {
    db.setGuildClanConfig(config("BBB"));
    return work();
  };
  const result = await service.syncMemberForClan(member, db.getUserByDiscordId(member.id), first);
  assert.equal(cache.has("shared"), true);
  assert.match(result.error, /configuration changed|stale role update/i);
});

test("same-account reverification invalidates an in-flight profile before role changes", async (t) => {
  const guild = { id: "reverified-config" };
  const config = { guild_id: guild.id, clan_tag: "AAA", member_role_id: "member",
    officer_role_id: null, leader_role_id: null, join_role_id: null, log_channel_id: null,
    sync_interval_mins: 10, last_sync_at: null };
  db.setGuildClanConfig(config);
  db.linkUser("reverified-user", "reverified-id", null, "identity_token");
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  t.mock.method(openfrontApi, "getPlayerProfile", () => new Promise((resolve) => { release = resolve; started(); }));
  const cache = new Map();
  const member = { id: "reverified-user", guild, roles: { cache,
    add: async (role) => cache.set(role, true), remove: async (role) => cache.delete(role) } };
  const service = new ClanSyncService({ guilds: { cache: new Map() } });
  const work = service.syncMemberForClan(member, db.getUserByDiscordId(member.id), config);
  await ready;
  db.linkUser(member.id, "reverified-id", null, "identity_token");
  release({ clans: [{ tag: "AAA", name: "AAA", role: "member", joinedAt: new Date().toISOString() }] });
  const result = await work;
  assert.equal(cache.has("member"), false);
  assert.match(result.error, /link changed/i);
});

test("direct sync preserves a role used for another clan's join approval", async (t) => {
  const guild = { id: "shared-join" };
  const config = (tag, memberRole, joinRole) => ({ guild_id: guild.id, clan_tag: tag,
    member_role_id: memberRole, officer_role_id: null, leader_role_id: null, join_role_id: joinRole,
    log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
  const first = config("AAA", "shared", null);
  db.setGuildClanConfig(first);
  db.setGuildClanConfig(config("BBB", "other", "shared"));
  db.linkUser("join-user", "join-id", null, "identity_token");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: [] }));
  const cache = new Map([["shared", true]]);
  const member = { id: "join-user", guild, roles: { cache,
    add: async (role) => cache.set(role, true), remove: async (role) => cache.delete(role) } };
  const service = new ClanSyncService({ guilds: { cache: new Map() } });
  const result = await service.syncMemberForClan(member, db.getUserByDiscordId(member.id), first);
  assert.equal(cache.has("shared"), true);
  assert.deepEqual(result.rolesRemoved, []);
});
