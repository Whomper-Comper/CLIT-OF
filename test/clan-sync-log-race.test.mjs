import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { openfrontApi } = await import("../dist/api.js");
const { ClanSyncService } = await import("../dist/clanSync.js");
const { PacedQueue } = await import("../dist/queues.js");

afterEach(() => { let job; while ((job = db.nextJob(Number.MAX_SAFE_INTEGER))) db.finishJob(job); });
after(() => db.close());

for (const path of ["direct", "cleanup"]) for (const change of ["none", "destination", "unlink", "reverify"]) {
  test(`${path} sync logs only the current destination and identity after a role write (${change})`, async (t) => {
    const guildId = `log-${path}-${change}`, user = `user-${path}-${change}`;
    const config = { guild_id: guildId, clan_tag: "ABC", member_role_id: "role",
      officer_role_id: null, leader_role_id: null, join_role_id: null,
      log_channel_id: "old-channel", sync_interval_mins: 10, last_sync_at: null };
    db.setGuildClanConfig(config);
    db.linkGuildUser(guildId, "manager", user, "account", "Player");
    t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: [{ tag: "ABC", role: "member" }] }));
    let sends = 0;
    const channel = { isTextBased: () => true, send: async () => { sends++; } };
    const guild = { id: guildId, channels: { cache: new Map([["old-channel", channel]]) }, members: {} };
    const member = { id: user, guild, roles: { cache: new Map() } };
    const service = new ClanSyncService({ guilds: { cache: new Map([[guildId, guild]]) } });
    service.rolePacer = new PacedQueue(0);
    guild.members.fetch = async () => member;
    member.roles.add = async (role) => {
      member.roles.cache.set(role, true);
      if (change === "destination") db.setGuildClanConfig({ ...config, log_channel_id: "new-channel" });
      if (change === "unlink") db.unlinkGuildUser(guildId, "manager", user);
      if (change === "reverify") db.linkGuildUser(guildId, "manager", user, "account", "Player");
      if (path === "cleanup" && change !== "none") service.stopScheduler();
    };
    member.roles.remove = async (role) => member.roles.cache.delete(role);
    if (path === "direct") await service.syncMember(member);
    else await service.processRoleCleanupQueue();
    assert.equal(member.roles.cache.has("role"), true);
    assert.equal(sends, change === "none" ? 1 : 0);
  });
}

for (const change of ["none", "destination", "unlink", "reverify", "approval-removed", "fresh-removed", "fetch-error"]) {
  test(`join approval notice rechecks the destination and identity after a role write (${change})`, async (t) => {
    const guildId = `approval-${change}`, user = `approval-user-${change}`;
    const config = { guild_id: guildId, clan_tag: "ABC", member_role_id: "rank",
      officer_role_id: null, leader_role_id: null, join_role_id: "approval",
      log_channel_id: "old-channel", sync_interval_mins: 10, last_sync_at: null };
    db.setGuildClanConfig(config);
    db.linkGuildUser(guildId, "manager", user, "account", "Player");
    t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: [] }));
    t.mock.method(console, "log", () => {});
    let sends = 0;
    const channel = { isTextBased: () => true, send: async () => { sends++; } };
    const guild = { id: guildId, channels: { cache: new Map([["old-channel", channel]]) } };
    const oldMember = { roles: { cache: new Map() } };
    const member = { id: user, guild, user: { tag: user }, roles: { cache: new Map([["approval", true], ["rank", true]]) } };
    guild.members = { fetch: async () => {
      if (change === "fetch-error") throw new Error("membership unavailable");
      return change === "fresh-removed" ? { ...member, roles: { cache: new Map() } } : member;
    } };
    member.roles.remove = async (role) => {
      member.roles.cache.delete(role);
      if (change === "destination") db.setGuildClanConfig({ ...config, log_channel_id: "new-channel" });
      if (change === "unlink") db.unlinkGuildUser(guildId, "manager", user);
      if (change === "reverify") db.linkGuildUser(guildId, "manager", user, "account", "Player");
      if (change === "approval-removed") member.roles.cache.delete("approval");
    };
    member.roles.add = async (role) => member.roles.cache.set(role, true);
    const service = new ClanSyncService({ guilds: { cache: new Map([[guildId, guild]]) } });
    service.rolePacer = new PacedQueue(0);
    await service.handleMemberRoleUpdate(oldMember, member);
    assert.equal(member.roles.cache.has("rank"), false);
    assert.equal(sends, change === "none" ? 1 : 0);
  });
}

for (const change of ["none", "destination", "link", "fresh-removed", "fetch-error"]) {
  test(`unlinked approval notice rechecks state after an earlier clan's awaited send (${change})`, async (t) => {
    const guildId = `unlinked-approval-${change}`, user = `unlinked-user-${change}`;
    const base = { guild_id: guildId, member_role_id: "rank", officer_role_id: null, leader_role_id: null,
      sync_interval_mins: 10, last_sync_at: null };
    const first = { ...base, clan_tag: "AAA", join_role_id: "approval-a", log_channel_id: "channel-a" };
    const second = { ...base, clan_tag: "BBB", join_role_id: "approval-b", log_channel_id: "channel-b" };
    db.setGuildClanConfig(first);
    db.setGuildClanConfig(second);
    t.mock.method(console, "log", () => {});
    let sentA = 0, sentB = 0, fetches = 0;
    const channelA = { isTextBased: () => true, send: async () => {
      sentA++;
      if (change === "destination") db.setGuildClanConfig({ ...second, log_channel_id: "changed" });
    } };
    const channelB = { isTextBased: () => true, send: async () => { sentB++; } };
    const guild = { id: guildId, channels: { cache: new Map([["channel-a", channelA], ["channel-b", channelB]]) } };
    const oldMember = { roles: { cache: new Map() } };
    const member = { id: user, guild, user: { tag: user }, roles: { cache: new Map([["approval-a", true], ["approval-b", true]]) } };
    guild.members = { fetch: async () => {
      fetches++;
      if (fetches > 1 && change === "link") db.linkGuildUser(guildId, "manager", user, "account", "Player");
      if (fetches > 1 && change === "fetch-error") throw new Error("membership unavailable");
      if (fetches > 1 && change === "fresh-removed") return { ...member, roles: { cache: new Map([["approval-a", true]]) } };
      return member;
    } };
    await new ClanSyncService({ guilds: { cache: new Map([[guildId, guild]]) } }).handleMemberRoleUpdate(oldMember, member);
    assert.equal(sentA, 1);
    assert.equal(sentB, change === "none" ? 1 : 0);
  });
}

test("approval notice checks its destination after the membership await", async (t) => {
  const guildId = "approval-microtask", user = "approval-microtask-user";
  const config = { guild_id: guildId, clan_tag: "ABC", member_role_id: "rank", officer_role_id: null,
    leader_role_id: null, join_role_id: "approval", log_channel_id: "old", sync_interval_mins: 10, last_sync_at: null };
  db.setGuildClanConfig(config);
  db.linkGuildUser(guildId, "manager", user, "account", "Player");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: [] }));
  t.mock.method(console, "log", () => {});
  let configAtSend = null;
  const channel = { isTextBased: () => true, send: async () => { configAtSend = db.getGuildClanConfig(guildId, "ABC").log_channel_id; } };
  const guild = { id: guildId, channels: { cache: new Map([["old", channel]]) } };
  const member = { id: user, guild, user: { tag: user }, roles: { cache: new Map([["approval", true]]) } };
  guild.members = { fetch: () => new Promise((resolve) => {
    resolve(member);
    queueMicrotask(() => queueMicrotask(() => db.setGuildClanConfig({ ...config, log_channel_id: "new" })));
  }) };
  await new ClanSyncService({ guilds: { cache: new Map([[guildId, guild]]) } })
    .handleMemberRoleUpdate({ roles: { cache: new Map() } }, member);
  assert.ok(configAtSend === null || configAtSend === "old");
  assert.equal(db.getGuildClanConfig(guildId, "ABC").log_channel_id, "new");
});
