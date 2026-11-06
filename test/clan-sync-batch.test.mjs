import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { OpenFrontApi, openfrontApi } = await import("../dist/api.js");
const { ClanSyncService } = await import("../dist/clanSync.js");
const { PacedQueue } = await import("../dist/queues.js");
const { clanCommand } = await import("../dist/commands/clan.js");

afterEach(() => { let job; while ((job = db.nextJob(Number.MAX_SAFE_INTEGER))) db.finishJob(job); });
after(() => db.close());

function fixture(id, tags = ["AAA", "BBB", "CCC"], approval = false) {
  const messages = [], writes = [];
  let fetches = 0;
  const guild = { id, name: id, channels: { cache: new Map() }, members: {
    fetch: async request => {
      if (request?.user) return roster.get(request.user);
      fetches++; return roster;
    },
  } };
  const configs = tags.map(tag => ({ guild_id: id, clan_tag: tag, member_role_id: `rank-${tag}`,
    officer_role_id: null, leader_role_id: null, join_role_id: approval ? `join-${tag}` : null,
    log_channel_id: approval ? `log-${tag}` : null, sync_interval_mins: 10, last_sync_at: null }));
  for (const config of configs) {
    db.setGuildClanConfig(config);
    guild.channels.cache.set(`log-${config.clan_tag}`, { isTextBased: () => true,
      send: async payload => { messages.push({ tag: config.clan_tag, payload }); } });
  }
  let roster = new Map();
  const addMember = (id, linked = true, roles = []) => {
    const cache = new Map(roles.map(role => [role, true]));
    const member = { id, guild, user: { bot: false }, roles: { cache,
      add: async role => { cache.set(role, true); writes.push([id, role, true]); },
      remove: async role => { cache.delete(role); writes.push([id, role, false]); } } };
    roster.set(id, member);
    if (linked) db.linkGuildUser(guild.id, "manager", id, `${id}-account`, id);
    return member;
  };
  const service = new ClanSyncService({ guilds: { cache: new Map([[guild.id, guild]]) } });
  service.rolePacer = new PacedQueue(0);
  return { guild, configs, service, addMember, messages, writes, get fetches() { return fetches; },
    setRoster: value => { roster = value; } };
}
const clans = tags => tags.map(tag => ({ tag, name: tag, role: "member" }));
const response = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Like discord.js single-role REST methods, writes update the server and return
// a clone. The input GuildMember remains stale until a separate Gateway update.
function delayedGatewayFixture(id, initialRoles = [], tags = ["AAA", "BBB"]) {
  const f = fixture(id, tags);
  for (const config of f.configs) {
    config.member_role_id = "shared";
    config.log_channel_id = `log-${config.clan_tag}`;
    db.setGuildClanConfig(config);
  }
  const memberId = `${id}-member`, actualRoles = new Set(initialRoles), requests = [];
  db.linkGuildUser(f.guild.id, "manager", memberId, `${memberId}-account`, "Player");
  let onWrite = () => {}, onRefresh = () => {}, refreshes = 0, rosters = 0;
  const snapshot = () => ({ id: memberId, guild: f.guild, user: { bot: false }, roles: {
    cache: new Map([...actualRoles].map(role => [role, true])),
    add: async role => { actualRoles.add(role); requests.push([role, true]); await onWrite(role, true); return snapshot(); },
    remove: async role => { actualRoles.delete(role); requests.push([role, false]); await onWrite(role, false); return snapshot(); },
  } });
  const original = snapshot();
  f.guild.members.fetch = async request => {
    if (!request) { rosters++; return new Map([[memberId, original]]); }
    assert.deepEqual(request, { user: memberId, force: true });
    refreshes++; await onRefresh(); return snapshot();
  };
  return { ...f, member: original, actualRoles, requests, snapshot,
    get refreshes() { return refreshes; }, get rosters() { return rosters; },
    onWrite: action => { onWrite = action; }, onRefresh: action => { onRefresh = action; } };
}

for (const path of ["batch", "targeted"]) for (const scenario of ["grant", "removal", "expired-reversal"]) {
  test(`${path} sync observes authoritative shared roles after clone-returning writes (${scenario})`, async t => {
    const f = delayedGatewayFixture(`clone-${path}-${scenario}`, scenario === "removal" ? ["shared"] : []);
    let now = 0, http = 0;
    const api = new OpenFrontApi("https://example.invalid", { now: () => now });
    t.mock.method(globalThis, "fetch", async () => {
      http++;
      return response({ clans: scenario === "removal" || (scenario === "expired-reversal" && http > 1) ? [] : clans(["AAA", "BBB"]) });
    });
    t.mock.method(openfrontApi, "getPlayerProfile", api.getPlayerProfile.bind(api));
    f.onWrite(() => { if (scenario === "expired-reversal") now = 15_000; });
    const buckets = path === "batch" ? await f.service.syncGuildClans(f.guild, f.configs) : null;
    const results = buckets ? buckets.map(bucket => bucket.results[0]) : await f.service.syncMember(f.member);
    const expectedWrites = scenario === "grant" ? [["shared", true]] : scenario === "removal" ? [["shared", false]]
      : [["shared", true], ["shared", false]];
    assert.deepEqual(f.requests, expectedWrites);
    assert.equal(f.actualRoles.has("shared"), scenario === "grant");
    assert.deepEqual(results.map(result => [result.rolesAdded, result.rolesRemoved]), scenario === "grant" ? [[["shared"], []], [[], []]]
      : scenario === "removal" ? [[[], ["shared"]], [[], []]] : [[["shared"], []], [[], ["shared"]]]);
    assert.ok(results.every(result => !result.error));
    assert.deepEqual(f.messages.map(message => message.tag), scenario === "expired-reversal" ? ["AAA", "BBB"] : ["AAA"]);
    assert.equal(http, scenario === "expired-reversal" ? 2 : 1);
    assert.equal(f.refreshes, 1);
    assert.equal(f.rosters, path === "batch" ? 1 : 0);
    for (const config of f.configs) assert.equal(!!db.getGuildClanConfig(f.guild.id, config.clan_tag).last_sync_at, path === "batch");
  });
}

for (const change of ["manager-role-removal", "unlink", "config", "refresh-failure"]) {
  test(`post-write member refresh respects intervening current state (${change})`, async t => {
    const f = delayedGatewayFixture(`clone-refresh-${change}`);
    t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: clans(["AAA", "BBB"]) }));
    f.onRefresh(() => {
      if (change === "manager-role-removal") f.actualRoles.delete("shared");
      if (change === "unlink") db.unlinkGuildUser(f.guild.id, "manager", f.member.id);
      if (change === "config") db.setGuildClanConfig({ ...f.configs[1], member_role_id: "replacement" });
      if (change === "refresh-failure") throw new Error("member refresh unavailable");
    });
    const buckets = await f.service.syncGuildClans(f.guild, f.configs);
    assert.equal(f.refreshes, 1);
    assert.deepEqual(f.requests, change === "manager-role-removal" ? [["shared", true], ["shared", true]] : [["shared", true]]);
    if (change === "config" || change === "refresh-failure") {
      assert.match(buckets[1].results[0].error, change === "config" ? /configuration changed/ : /refresh unavailable/);
      assert.equal(db.getGuildClanConfig(f.guild.id, "BBB").last_sync_at, null);
    }
    if (change === "unlink") assert.equal(buckets[1].results.length, 0);
    assert.equal(f.messages.length, change === "manager-role-removal" ? 2 : 1);
  });
}

for (const path of ["batch", "targeted"]) {
  test(`${path} sync reuses a refreshed member across subsequent no-write clans`, async t => {
    const f = delayedGatewayFixture(`clone-reuse-${path}`, [], ["AAA", "BBB", "CCC"]);
    t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: clans(["AAA", "BBB", "CCC"]) }));
    const results = path === "batch" ? (await f.service.syncGuildClans(f.guild, f.configs)).flatMap(bucket => bucket.results)
      : await f.service.syncMember(f.member);
    assert.deepEqual(f.requests, [["shared", true]]);
    assert.equal(f.refreshes, 1, "no refresh follows either no-write clan");
    assert.deepEqual(results.map(result => result.rolesAdded), [["shared"], [], []]);
    assert.deepEqual(f.messages.map(message => message.tag), ["AAA"]);
  });

  test(`${path} sync reports every remaining clan after a post-write member refresh fails`, async t => {
    const f = delayedGatewayFixture(`clone-failure-${path}`, [], ["AAA", "BBB", "CCC"]);
    t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: clans(["AAA", "BBB", "CCC"]) }));
    f.onRefresh(() => { throw new Error("member refresh unavailable"); });
    const results = path === "batch" ? (await f.service.syncGuildClans(f.guild, f.configs)).flatMap(bucket => bucket.results)
      : await f.service.syncMember(f.member);
    assert.deepEqual(f.requests, [["shared", true]]);
    assert.equal(f.refreshes, 1, "a failed member is not retried for each remaining clan");
    assert.equal(results[0].error, undefined);
    for (const result of results.slice(1)) assert.match(result.error, /member refresh unavailable/);
    for (const tag of ["BBB", "CCC"]) assert.equal(db.getGuildClanConfig(f.guild.id, tag).last_sync_at, null);
    assert.deepEqual(f.messages.map(message => message.tag), ["AAA"]);
  });
}

for (const scope of ["all", "page", "tag"]) {
  test(`targeted slash handler shares authoritative role state and preserves selected ${scope} scope`, async t => {
    const tags = scope === "all" ? ["AAA", "BBB"] : Array.from({ length: 12 }, (_, index) => `C${String(index).padStart(2, "0")}`);
    const f = delayedGatewayFixture(`clone-command-${scope}`, [], tags);
    const selectedTags = scope === "all" ? tags : scope === "page" ? ["C10", "C11"] : ["C06"];
    db.setManagerRole(f.guild.id, "manager");
    const originalFetch = f.guild.members.fetch;
    f.guild.members.fetch = async request => request?.user === "actor" ? { roles: { cache: new Map([["manager", true]]) } }
      : request === f.member.id ? f.member : originalFetch(request);
    let now = 0, http = 0;
    const api = new OpenFrontApi("https://example.invalid", { now: () => now });
    t.mock.method(globalThis, "fetch", async () => {
      http++;
      return response({ clans: http === 1 ? clans(selectedTags) : [] });
    });
    t.mock.method(openfrontApi, "getPlayerProfile", api.getPlayerProfile.bind(api));
    f.onWrite(() => { now = 15_000; });
    const i = { guild: f.guild, guildId: f.guild.id, user: { id: "actor" }, inCachedGuild: () => true,
      member: { roles: { cache: new Map([["manager", true]]) } },
      options: { getString: name => name === "action" ? "sync" : name === "clan_tag" && scope === "tag" ? "C06" : null,
        getInteger: name => name === "page" && scope === "page" ? 2 : null,
        getUser: name => name === "user" ? { id: f.member.id } : null },
      deferReply: async () => {}, editReply: async function (output) { this.output = output; } };
    await clanCommand.execute(i, f.service);
    const twoClans = selectedTags.length === 2;
    assert.deepEqual(f.requests, twoClans ? [["shared", true], ["shared", false]] : [["shared", true]]);
    assert.equal(f.actualRoles.has("shared"), !twoClans);
    assert.deepEqual(f.messages.map(message => message.tag), selectedTags, "the service owns each log exactly once");
    assert.deepEqual(i.output.embeds[0].data.fields.map(field => field.name), selectedTags.map(tag => `[${tag}]`));
    for (const field of i.output.embeds[0].data.fields) assert.match(field.value, /1 role changes/);
    assert.match(i.output.embeds[0].data.description, new RegExp(`1 linked member.*across ${selectedTags.length} clan`));
    assert.equal(http, twoClans ? 2 : 1);
    assert.equal(f.refreshes, twoClans ? 1 : 0);
    assert.equal(f.rosters, 0);
    for (const config of f.configs) assert.equal(db.getGuildClanConfig(f.guild.id, config.clan_tag).last_sync_at, null);
  });
}

test("scheduled clans share one initial roster and adjacent members share actual HTTP reads", async t => {
  const f = fixture("batch-scheduled");
  for (const id of ["scheduled-one", "scheduled-two"]) f.addMember(id, true, f.configs.map(c => c.member_role_id));
  let now = 0, requests = 0;
  const api = new OpenFrontApi("https://example.invalid", { now: () => now });
  t.mock.method(globalThis, "fetch", async () => {
    requests++; now += 16_000;
    return response({ username: "Player", clans: clans(f.configs.map(c => c.clan_tag)) });
  });
  t.mock.method(openfrontApi, "getPlayerProfile", api.getPlayerProfile.bind(api));
  t.mock.method(console, "log", () => {});
  await f.service.checkAndSyncAllGuilds();
  assert.equal(f.fetches, 1, "C initial roster requests become one");
  assert.equal(requests, 2, "each member's adjacent clan checks use the real fifteen-second API cache");
  for (const config of f.configs) assert.ok(db.getGuildClanConfig(f.guild.id, config.clan_tag).last_sync_at);
  // Reproduce the former clan-first orchestration through the compatibility API.
  // The same deterministic request clock makes each member expire before its next clan.
  const sequential = fixture("batch-scheduled-sequential");
  for (const id of ["sequential-one", "sequential-two"]) sequential.addMember(id, true, sequential.configs.map(c => c.member_role_id));
  now = 0; requests = 0;
  const sequentialApi = new OpenFrontApi("https://example.invalid", { now: () => now });
  t.mock.method(openfrontApi, "getPlayerProfile", sequentialApi.getPlayerProfile.bind(sequentialApi));
  for (const config of sequential.configs) await sequential.service.syncGuildClan(sequential.guild, config);
  assert.equal(sequential.fetches, 3);
  assert.equal(requests, 6);
});

test("batch keeps separate ordered result buckets and one fresh pending roster per clan", async t => {
  const f = fixture("batch-buckets", undefined, true);
  f.addMember("bucket-linked", true, f.configs.map(c => c.join_role_id));
  f.addMember("bucket-unlinked", false, f.configs.map(c => c.join_role_id));
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: [] }));
  const buckets = await f.service.syncGuildClans(f.guild, f.configs);
  assert.equal(f.fetches, 4, "2C roster requests become C+1, retaining final safety refreshes");
  assert.deepEqual(buckets.map(b => b.config.clan_tag), ["AAA", "BBB", "CCC"]);
  for (const bucket of buckets) {
    assert.equal(bucket.results.length, 1);
    assert.equal(bucket.results[0].clanTag, bucket.config.clan_tag);
    assert.equal(bucket.results[0].discordId, "bucket-linked");
    assert.equal(bucket.error, undefined);
  }
  assert.deepEqual(f.messages.map(m => m.tag), ["AAA", "BBB", "CCC"]);
  for (const message of f.messages) {
    const description = message.payload.embeds[0].toJSON().description;
    assert.match(description, /bucket-linked-account/);
    assert.match(description, /bucket-unlinked/);
  }
  const sequential = fixture("batch-buckets-sequential", undefined, true);
  sequential.addMember("bucket-sequential-linked", true, sequential.configs.map(c => c.join_role_id));
  sequential.addMember("bucket-sequential-unlinked", false, sequential.configs.map(c => c.join_role_id));
  for (const config of sequential.configs) await sequential.service.syncGuildClan(sequential.guild, config);
  assert.equal(sequential.fetches, 6, "former clan-first orchestration fetched both rosters for every clan");
});

test("a slow awaited role log expires the real profile cache before the next selected clan", async t => {
  const f = fixture("batch-expiry", ["AAA", "BBB"]);
  f.configs[0].log_channel_id = "log-AAA";
  db.setGuildClanConfig(f.configs[0]);
  f.addMember("expiry-member");
  let now = 0, requests = 0;
  const api = new OpenFrontApi("https://example.invalid", { now: () => now });
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return response({ clans: requests === 1 ? clans(["AAA", "BBB"]) : [] });
  });
  t.mock.method(openfrontApi, "getPlayerProfile", api.getPlayerProfile.bind(api));
  f.guild.channels.cache.get("log-AAA").send = async () => { now = 15_000; };
  const buckets = await f.service.syncGuildClans(f.guild, f.configs);
  assert.equal(requests, 2, "no pass-long profile memo may hide an expired cache entry");
  assert.equal(buckets[0].results[0].inClan, true);
  assert.equal(buckets[1].results[0].inClan, false);
  assert.deepEqual(f.writes, [["expiry-member", "rank-AAA", true]]);
});

test("scheduler submits only due configs while explicit sync can force a recent clan", async t => {
  const f = fixture("batch-due", ["AAA", "BBB", "CCC"]);
  db.updateClanLastSync(f.guild.id, "BBB");
  const submitted = [];
  t.mock.method(f.service, "syncGuildClans", async (_guild, selected) => {
    submitted.push(selected.map(c => c.clan_tag));
    return selected.map(config => ({ config, results: [] }));
  });
  t.mock.method(console, "log", () => {});
  await f.service.checkAndSyncAllGuilds();
  assert.deepEqual(submitted, [["AAA", "CCC"]]);
  const forced = fixture("batch-force", ["AAA", "BBB"]);
  db.updateClanLastSync(forced.guild.id, "BBB");
  await forced.service.syncGuildClan(forced.guild, db.getGuildClanConfig(forced.guild.id, "BBB"));
  assert.equal(forced.fetches, 1);
  assert.equal(db.getGuildClanConfig(forced.guild.id, "AAA").last_sync_at, null);
});

test("overlapping reversed batches and a single-clan sync serialize without deadlock", { timeout: 3000 }, async () => {
  const f = fixture("batch-overlap", ["AAA", "BBB", "CCC"]);
  const entered = deferred(), release = deferred();
  let starts = 0;
  f.guild.members.fetch = async () => {
    starts++;
    if (starts === 1) { entered.resolve(); await release.promise; }
    return new Map();
  };
  const first = f.service.syncGuildClans(f.guild, [f.configs[1], f.configs[0]]);
  await entered.promise;
  const second = f.service.syncGuildClans(f.guild, [f.configs[0], f.configs[1]]);
  const single = f.service.syncGuildClan(f.guild, f.configs[1]);
  const third = f.service.syncGuildClans(f.guild, [f.configs[2], f.configs[1]]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(starts, 1, "overlapping batches must not enter the roster phase concurrently");
  release.resolve();
  const [a, b, c, d] = await Promise.all([first, second, single, third]);
  assert.deepEqual(a.map(bucket => bucket.config.clan_tag), ["BBB", "AAA"]);
  assert.deepEqual(b.map(bucket => bucket.config.clan_tag), ["AAA", "BBB"]);
  assert.deepEqual(c, []);
  assert.deepEqual(d.map(bucket => bucket.config.clan_tag), ["CCC", "BBB"]);
  assert.equal(starts, 4);
});

test("a final roster failure belongs to its clan and other unchanged clans still complete", async t => {
  const f = fixture("batch-final-failure", ["AAA", "BBB"], true);
  const member = f.addMember("final-failure-member", false, f.configs.map(c => c.join_role_id));
  let fetches = 0;
  f.guild.members.fetch = async () => {
    if (++fetches === 2) throw new Error("final AAA roster unavailable");
    return new Map([[member.id, member]]);
  };
  const buckets = await f.service.syncGuildClans(f.guild, f.configs);
  assert.match(buckets[0].error, /final AAA roster unavailable/);
  assert.equal(buckets[1].error, undefined);
  assert.equal(db.getGuildClanConfig(f.guild.id, "AAA").last_sync_at, null);
  assert.ok(db.getGuildClanConfig(f.guild.id, "BBB").last_sync_at);
  assert.deepEqual(f.messages.map(m => m.tag), ["BBB"]);
});

test("a shared initial roster failure cannot advance any clan or publish summaries", async () => {
  const f = fixture("batch-initial-failure", ["AAA", "BBB"], true);
  f.guild.members.fetch = async () => { throw new Error("initial roster unavailable"); };
  await assert.rejects(f.service.syncGuildClans(f.guild, f.configs), /initial roster unavailable/);
  for (const config of f.configs) assert.equal(db.getGuildClanConfig(f.guild.id, config.clan_tag).last_sync_at, null);
  assert.deepEqual(f.messages, []);
});

test("a final roster rejection with an empty message is still a visible clan failure", async () => {
  const f = fixture("batch-empty-error", ["AAA"], true);
  const member = f.addMember("empty-error-member", false, ["join-AAA"]);
  let fetches = 0;
  f.guild.members.fetch = async () => {
    if (++fetches > 1) throw new Error();
    return new Map([[member.id, member]]);
  };
  const [bucket] = await f.service.syncGuildClans(f.guild, f.configs);
  assert.ok(bucket.error, "even empty upstream errors must keep the bucket visibly failed");
  assert.equal(db.getGuildClanConfig(f.guild.id, "AAA").last_sync_at, null);
});

test("an empty batch does not fetch members and duplicate tags do not acquire a lock twice", { timeout: 3000 }, async () => {
  const f = fixture("batch-empty-duplicate", ["AAA"]);
  assert.deepEqual(await f.service.syncGuildClans(f.guild, []), []);
  assert.equal(f.fetches, 0);
  const buckets = await f.service.syncGuildClans(f.guild, [f.configs[0], f.configs[0]]);
  assert.equal(buckets.length, 1);
  assert.equal(f.fetches, 1);
});

test("unlinked discovery is shared only for a synchronous member block", async t => {
  const f = fixture("batch-unlinked-discovery", undefined, true);
  f.addMember("unlinked-discovery", false, f.configs.map(c => c.join_role_id));
  const getLink = t.mock.method(db, "getEffectiveLink");
  await f.service.syncGuildClans(f.guild, f.configs);
  // One initial discovery plus one fresh identity check before each final send.
  assert.equal(getLink.mock.callCount(), 4);
  assert.equal(f.messages.length, 3);
});

test("a mapping edited during the shared fetch stays unsynced while its unchanged sibling completes", async () => {
  const f = fixture("batch-edit-roster", ["AAA", "BBB"]);
  f.guild.members.fetch = async () => {
    db.setGuildClanConfig({ ...f.configs[0], member_role_id: "replacement" });
    return new Map();
  };
  await f.service.syncGuildClans(f.guild, f.configs);
  assert.equal(db.getGuildClanConfig(f.guild.id, "AAA").last_sync_at, null);
  assert.ok(db.getGuildClanConfig(f.guild.id, "BBB").last_sync_at);
});

test("an awaited profile cannot write or log an edited mapping in a batch", async t => {
  const f = fixture("batch-edit-profile", ["AAA", "BBB"]);
  f.configs[0].log_channel_id = "log-AAA";
  db.setGuildClanConfig(f.configs[0]);
  const member = f.addMember("profile-edit-member");
  const entered = deferred(), release = deferred();
  let reads = 0;
  t.mock.method(openfrontApi, "getPlayerProfile", async () => {
    if (++reads === 1) { entered.resolve(); await release.promise; }
    return { clans: clans(["AAA", "BBB"]) };
  });
  const work = f.service.syncGuildClans(f.guild, f.configs);
  await entered.promise;
  db.setGuildClanConfig({ ...f.configs[0], member_role_id: "replacement" });
  release.resolve();
  const buckets = await work;
  assert.match(buckets[0].results[0].error, /configuration changed/);
  assert.equal(member.roles.cache.has("rank-AAA"), false);
  assert.equal(member.roles.cache.has("rank-BBB"), true);
  assert.deepEqual(f.messages, []);
  assert.equal(db.getGuildClanConfig(f.guild.id, "AAA").last_sync_at, null);
  assert.ok(db.getGuildClanConfig(f.guild.id, "BBB").last_sync_at);
});

for (const change of ["destination", "unlink", "reverify"]) {
  test(`batch role logging rechecks identity and destination after an awaited write (${change})`, async t => {
    const f = fixture(`batch-role-log-${change}`, ["AAA", "BBB"]);
    f.configs[0].log_channel_id = "log-AAA";
    db.setGuildClanConfig(f.configs[0]);
    const member = f.addMember(`role-log-${change}`);
    t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: clans(["AAA", "BBB"]) }));
    member.roles.add = async role => {
      member.roles.cache.set(role, true);
      if (role !== "rank-AAA") return;
      if (change === "destination") db.setGuildClanConfig({ ...f.configs[0], log_channel_id: "new-log" });
      if (change === "unlink") db.unlinkGuildUser(f.guild.id, "manager", member.id);
      if (change === "reverify") db.linkGuildUser(f.guild.id, "manager", member.id, `${member.id}-account`, member.id);
    };
    const buckets = await f.service.syncGuildClans(f.guild, f.configs);
    assert.equal(member.roles.cache.has("rank-AAA"), true);
    assert.equal(member.roles.cache.has("rank-BBB"), change !== "unlink");
    assert.equal(buckets[1].results.length, change === "unlink" ? 0 : 1);
    assert.deepEqual(f.messages, []);
    if (change === "destination") assert.equal(db.getGuildClanConfig(f.guild.id, "AAA").last_sync_at, null);
  });
}

for (const change of ["departure", "approval", "rebind", "config"]) {
  test(`each clan refreshes pending membership after an earlier summary send (${change})`, async t => {
    const f = fixture(`batch-final-${change}`, ["AAA", "BBB"], true);
    const member = f.addMember(`final-${change}-member`, true, f.configs.map(c => c.join_role_id));
    t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ clans: [] }));
    f.guild.channels.cache.get("log-AAA").send = async payload => {
      f.messages.push({ tag: "AAA", payload });
      if (change === "departure") f.setRoster(new Map());
      if (change === "approval") member.roles.cache.delete("join-BBB");
      if (change === "rebind") db.linkGuildUser(f.guild.id, "manager", member.id, "replacement-account", "New");
      if (change === "config") db.setGuildClanConfig({ ...f.configs[1], log_channel_id: "replacement-log" });
    };
    await f.service.syncGuildClans(f.guild, f.configs);
    assert.deepEqual(f.messages.map(m => m.tag), ["AAA"]);
    assert.equal(f.fetches, change === "config" ? 2 : 3);
    assert.equal(!!db.getGuildClanConfig(f.guild.id, "BBB").last_sync_at, change !== "config");
  });
}

test("batch rereads a member's live binding between awaited clan operations", async t => {
  const f = fixture("batch-live-binding", ["AAA", "BBB"]);
  const member = f.addMember("binding-member");
  const ids = [];
  t.mock.method(openfrontApi, "getPlayerProfile", async id => { ids.push(id); return { clans: clans(["AAA", "BBB"]) }; });
  member.roles.add = async role => {
    member.roles.cache.set(role, true);
    if (role === "rank-AAA") db.linkGuildUser(f.guild.id, "manager", member.id, "replacement", "New");
  };
  const buckets = await f.service.syncGuildClans(f.guild, f.configs);
  assert.deepEqual(ids, ["binding-member-account", "replacement"]);
  assert.equal(buckets[1].results[0].openfrontId, "replacement");
  assert.equal(member.roles.cache.has("rank-BBB"), true);
});

test("profile errors stay in their own result buckets and suppress last-sync", async t => {
  const f = fixture("batch-member-failure", ["AAA", "BBB"]);
  const member = f.addMember("member-failure");
  let reads = 0;
  t.mock.method(openfrontApi, "getPlayerProfile", async () => {
    if (++reads === 1) throw new Error("temporary profile failure");
    return { clans: clans(["BBB"]) };
  });
  const buckets = await f.service.syncGuildClans(f.guild, f.configs);
  assert.match(buckets[0].results[0].error, /temporary profile failure/);
  assert.equal(buckets[1].results[0].error, undefined);
  assert.equal(db.getGuildClanConfig(f.guild.id, "AAA").last_sync_at, null);
  assert.ok(db.getGuildClanConfig(f.guild.id, "BBB").last_sync_at);
  assert.equal(member.roles.cache.has("rank-BBB"), true);
});

test("bulk slash sync submits only its validated page as one batch and reports clan failures", async t => {
  const f = fixture("batch-command", Array.from({ length: 12 }, (_, i) => `C${String(i).padStart(2, "0")}`));
  db.setManagerRole(f.guild.id, "manager");
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async request => request?.user === "actor" ? { roles: { cache: new Map([["manager", true]]) } } : fetch(request);
  let output, selected;
  const interaction = { guild: f.guild, guildId: f.guild.id, user: { id: "actor" }, inCachedGuild: () => true,
    member: { roles: { cache: new Map([["manager", true]]) } },
    options: { getString: name => name === "action" ? "sync" : null, getInteger: name => name === "page" ? 2 : null,
      getUser: () => null }, deferReply: async () => {}, editReply: async () => ({ edit: async value => { output = value; } }) };
  t.mock.method(f.service, "syncGuildClans", async (_guild, configs) => {
    selected = configs;
    return configs.map((config, i) => ({ config, results: [], ...(i ? {} : { error: "roster unavailable" }) }));
  });
  await clanCommand.execute(interaction, f.service);
  assert.deepEqual(selected.map(c => c.clan_tag), ["C10", "C11"]);
  assert.match(output.embeds[0].data.title, /errors/);
  assert.match(output.embeds[0].data.description, /1 failed/);
  assert.match(output.embeds[0].data.fields[0].value, /roster unavailable/);
});
