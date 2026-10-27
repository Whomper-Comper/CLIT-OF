import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { ClanSyncService } = await import("../dist/clanSync.js");

const config = (guild, role) => ({ guild_id: guild, clan_tag: "ABC", member_role_id: role,
  officer_role_id: null, leader_role_id: null, join_role_id: null, log_channel_id: null,
  sync_interval_mins: 10, last_sync_at: null });

test("a stale empty guild sync does not mark an edited clan mapping as synced", async () => {
  const guildId = "schedule-stale";
  const original = config(guildId, "old-role");
  db.setGuildClanConfig(original);
  const guild = { id: guildId, members: { fetch: async () => {
    db.setGuildClanConfig(config(guildId, "new-role"));
    return new Map();
  } } };
  const service = new ClanSyncService({ guilds: { cache: new Map() } });
  await service.syncGuildClan(guild, original);
  const updated = db.getGuildClanConfig(guildId, "ABC");
  assert.equal(updated.member_role_id, "new-role");
  assert.equal(updated.last_sync_at, null);
});

test("a successful empty guild sync records the sync time for the unchanged mapping", async () => {
  const guildId = "schedule-current";
  const current = config(guildId, "member-role");
  db.setGuildClanConfig(current);
  const guild = { id: guildId, members: { fetch: async () => new Map() } };
  const service = new ClanSyncService({ guilds: { cache: new Map() } });
  await service.syncGuildClan(guild, current);
  assert.ok(db.getGuildClanConfig(guildId, "ABC").last_sync_at);
});

test("a mapping edited during member fetch suppresses the old pending-invite log", async () => {
  const guildId = "schedule-stale-log";
  const original = { ...config(guildId, "member-role"), join_role_id: "old-approval", log_channel_id: "log" };
  db.setGuildClanConfig(original);
  let sends = 0;
  const channel = { isTextBased: () => true, send: async () => { sends++; } };
  const member = { user: { bot: false }, roles: { cache: new Map([["old-approval", true]]) } };
  const guild = { id: guildId, channels: { cache: new Map([["log", channel]]) }, members: { fetch: async () => {
    db.setGuildClanConfig({ ...original, join_role_id: "new-approval" });
    return new Map([["unlinked-user", member]]);
  } } };
  await new ClanSyncService({ guilds: { cache: new Map() } }).syncGuildClan(guild, original);
  assert.equal(sends, 0);
});

test("an unchanged mapping still logs pending invites", async () => {
  const guildId = "schedule-current-log";
  const original = { ...config(guildId, "member-role"), join_role_id: "approval", log_channel_id: "log" };
  db.setGuildClanConfig(original);
  let sends = 0;
  const channel = { isTextBased: () => true, send: async () => { sends++; } };
  const member = { user: { bot: false }, roles: { cache: new Map([["approval", true]]) } };
  const guild = { id: guildId, channels: { cache: new Map([["log", channel]]) }, members: { fetch: async () => new Map([["unlinked-user", member]]) } };
  await new ClanSyncService({ guilds: { cache: new Map() } }).syncGuildClan(guild, original);
  assert.equal(sends, 1);
});
