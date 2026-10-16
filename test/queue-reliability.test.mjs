import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db, BotDatabase } = await import("../dist/db.js");
const { ClanSyncService } = await import("../dist/clanSync.js");
const { openfrontApi } = await import("../dist/api.js");
const { PacedQueue } = await import("../dist/queues.js");

const config = (guild, tag = "TEST", role = "member", extra = {}) => ({ guild_id: guild, clan_tag: tag,
  member_role_id: role, officer_role_id: null, leader_role_id: null, join_role_id: null,
  log_channel_id: null, sync_interval_mins: 10, last_sync_at: null, ...extra });
function fixture(id, roles = []) {
  const guild = { id, name: id, members: {} };
  const member = { id: `${id}-user`, guild, roles: { cache: new Map(roles.map((role) => [role, true])),
    add: async (role) => member.roles.cache.set(role, true),
    remove: async (role) => member.roles.cache.delete(role) } };
  guild.members.fetch = async () => member;
  return { guild, member };
}
function serviceFor(fixtures) {
  const service = new ClanSyncService({ guilds: { cache: new Map(fixtures.map(({ guild }) => [guild.id, guild])) } });
  service.rolePacer = new PacedQueue(0);
  return service;
}

afterEach(() => { let job; while ((job = db.nextJob(Number.MAX_SAFE_INTEGER))) db.finishJob(job); });
after(() => db.close());

test("identity unlinks promote persisted work and later sync cannot demote it", () => {
  const store = new BotDatabase(":memory:");
  try {
    store.setGuildClanConfig(config("priority-a"));
    store.setGuildClanConfig(config("priority-b"));
    store.linkUser("global-user", "global-player", null, "identity_token");
    assert.equal(store.getJob("priority-a", "global-user").priority, 0);
    store.unlinkUser("global-user");
    for (const guild of ["priority-a", "priority-b"]) assert.equal(store.getJob(guild, "global-user").priority, 10);
    store.enqueueGuild("priority-a", "global-user");
    assert.equal(store.getJob("priority-a", "global-user").priority, 10);
    store.linkGuildUser("priority-local", "manager", "local-user", "local-player", null);
    assert.equal(store.getJob("priority-local", "local-user").priority, 0);
    store.unlinkGuildUser("priority-local", "manager", "local-user");
    assert.equal(store.getJob("priority-local", "local-user").priority, 10);
  } finally { store.close(); }
});

test("an old cleanup pass cannot consume a replacement job's roles", () => {
  const store = new BotDatabase(":memory:");
  try {
    store.enqueueGuild("versioned", "user", ["old-role"]);
    const old = store.getJob("versioned", "user");
    store.enqueueGuild("versioned", "user", ["new-role"], 10);
    store.progressJob(old, []);
    store.finishJob(old);
    const current = store.getJob("versioned", "user");
    assert.notEqual(current.version, old.version);
    assert.equal(current.priority, 10);
    assert.deepEqual(new Set(JSON.parse(current.role_ids)), new Set(["old-role", "new-role"]));
  } finally { store.close(); }
});

test("unlink priority overtakes ordinary sync while the shared lane waits", async () => {
  let now = 0, startWaiting, resume;
  const waiting = new Promise((resolve) => { startWaiting = resolve; });
  let pause = true;
  const lane = new PacedQueue(1000, async (milliseconds) => {
    if (pause) {
      pause = false;
      startWaiting();
      await new Promise((resolve) => { resume = resolve; });
    }
    now += milliseconds;
  }, () => now);
  const starts = [];
  await lane.run(async () => { starts.push(["first", now]); });
  const normal = lane.run(async () => { starts.push(["normal", now]); });
  await waiting;
  const unlink = lane.run(async () => { starts.push(["unlink", now]); }, { priority: 10, guildId: "unlink" });
  resume();
  await Promise.all([normal, unlink]);
  assert.deepEqual(starts, [["first", 0], ["unlink", 1000], ["normal", 2000]]);
});

test("equal priority role writes rotate across all three guilds", async () => {
  const lane = new PacedQueue(0), starts = [];
  const work = [];
  for (const guild of ["a", "b", "c"]) {
    for (let index = 0; index < 2; index++) {
      work.push(lane.run(async () => { starts.push(`${guild}${index}`); }, { guildId: guild }));
    }
  }
  await Promise.all(work);
  assert.deepEqual(starts, ["a0", "b0", "c0", "a1", "b1", "c1"]);
});

test("persisted cleanup gives each guild one role removal per turn", async () => {
  const fixtures = [fixture("rotate-a", ["member", "officer"]), fixture("rotate-b", ["member", "officer"]),
    fixture("rotate-c", ["member", "officer"])];
  const writes = [];
  for (const { guild, member } of fixtures) {
    db.setGuildClanConfig(config(guild.id, "TEST", "member", { officer_role_id: "officer" }));
    db.enqueueGuild(guild.id, member.id, [], 10);
    member.roles.remove = async (role) => { writes.push(guild.id); member.roles.cache.delete(role); };
  }
  await serviceFor(fixtures).processRoleCleanupQueue();
  assert.deepEqual(writes, ["rotate-a", "rotate-b", "rotate-c", "rotate-a", "rotate-b", "rotate-c"]);
  for (const { guild, member } of fixtures) assert.equal(db.getJob(guild.id, member.id), null);
});

test("new unlink runs between a linked member's roles across many clans", async (t) => {
  const linked = fixture("batch-linked"), unlinked = fixture("batch-unlinked", ["member"]);
  const writes = [];
  for (const tag of ["AAA", "BBB", "CCC"]) db.setGuildClanConfig(config(linked.guild.id, tag, tag.toLowerCase()));
  db.setGuildClanConfig(config(unlinked.guild.id));
  db.linkGuildUser(linked.guild.id, "staff", linked.member.id, "batch-player", "Player");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ username: "Player",
    clans: ["AAA", "BBB", "CCC"].map((tag) => ({ tag, role: "member" })) }));
  linked.member.roles.add = async (role) => {
    writes.push(role);
    linked.member.roles.cache.set(role, true);
    if (role === "aaa") db.enqueueGuild(unlinked.guild.id, unlinked.member.id, [], 10);
  };
  unlinked.member.roles.remove = async (role) => { writes.push("unlink"); unlinked.member.roles.cache.delete(role); };
  await serviceFor([linked, unlinked]).processRoleCleanupQueue();
  assert.deepEqual(writes, ["aaa", "unlink", "bbb", "ccc"]);
});

test("a failed guild backs off without delaying cleanup in another guild", async (t) => {
  const failed = fixture("failure-a", ["member"]), working = fixture("failure-b", ["member"]);
  for (const { guild, member } of [failed, working]) {
    db.setGuildClanConfig(config(guild.id));
    db.enqueueGuild(guild.id, member.id, [], 10);
  }
  failed.guild.members.fetch = async () => { throw new Error("Discord unavailable"); };
  t.mock.method(console, "warn", () => {});
  await serviceFor([failed, working]).processRoleCleanupQueue();
  assert.equal(db.getJob(failed.guild.id, failed.member.id).attempts, 1);
  assert.ok(db.getJob(failed.guild.id, failed.member.id).available_at > Date.now());
  assert.equal(db.getJob(working.guild.id, working.member.id), null);
  assert.equal(working.member.roles.cache.has("member"), false);
});

test("cleanup revokes obsolete ranks before attempting a failing grant", async (t) => {
  const f = fixture("revoke-first", ["officer"]);
  db.setGuildClanConfig(config(f.guild.id, "TEST", "member", { officer_role_id: "officer" }));
  db.linkGuildUser(f.guild.id, "staff", f.member.id, "revoke-player", "Player");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: [{ tag: "TEST", role: "member" }] }));
  t.mock.method(console, "warn", () => {});
  f.member.roles.add = async () => { throw new Error("Missing Permissions"); };
  await serviceFor([f]).processRoleCleanupQueue();
  assert.equal(f.member.roles.cache.has("officer"), false);
  assert.equal(db.getJob(f.guild.id, f.member.id).attempts, 1);
  assert.deepEqual(JSON.parse(db.getJob(f.guild.id, f.member.id).role_ids), ["member"]);
});

test("persisted progress remains after shutdown and finishes after restart", async () => {
  const f = fixture("restart", ["member", "officer"]);
  db.setGuildClanConfig(config(f.guild.id, "TEST", "member", { officer_role_id: "officer" }));
  db.enqueueGuild(f.guild.id, f.member.id, [], 10);
  const service = serviceFor([f]);
  f.member.roles.remove = async (role) => { f.member.roles.cache.delete(role); service.stopScheduler(); };
  await service.processRoleCleanupQueue();
  assert.deepEqual(JSON.parse(db.getJob(f.guild.id, f.member.id).role_ids), ["officer"]);
  f.member.roles.remove = async (role) => { f.member.roles.cache.delete(role); };
  await serviceFor([f]).processRoleCleanupQueue();
  assert.equal(f.member.roles.cache.size, 0);
  assert.equal(db.getJob(f.guild.id, f.member.id), null);
});
