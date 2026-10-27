import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
process.env.DEFAULT_SYNC_INTERVAL_MINS = "25";
const { db, BotDatabase } = await import("../dist/db.js");
const { CONFIG, validateConfig } = await import("../dist/config.js");
const { openfrontApi, OpenFrontApi, OpenFrontApiError } = await import("../dist/api.js");
const { ClanSyncService } = await import("../dist/clanSync.js");
const { clanCommand } = await import("../dist/commands/clan.js");
const { linkCommand } = await import("../dist/commands/link.js");
const { unlinkCommand } = await import("../dist/commands/unlink.js");
const { whoisCommand } = await import("../dist/commands/whois.js");
const { commands } = await import("../dist/commands/index.js");
const { desiredRoles } = await import("../dist/roles.js");
const { PacedQueue } = await import("../dist/queues.js");
const { pageOf, playerId } = await import("../dist/commands/support.js");
const { validateClanDraft, newClanDraft } = await import("../dist/setupConfig.js");
const config = (guild = "guild", tag = "TEST", overrides = {}) => ({ guild_id: guild, clan_tag: tag, member_role_id: "member",
  officer_role_id: null, leader_role_id: null, join_role_id: "join", log_channel_id: null, sync_interval_mins: 25, last_sync_at: null, ...overrides });
const membership = (tag = "TEST", role = "member") => ({ tag, name: tag, role, joinedAt: new Date().toISOString() });
const profile = (clans = []) => ({ username: "Player", clans });
function guildFixture(id) {
  const bot = { permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } };
  return { id, name: id, members: { fetch: async () => new Map(), fetchMe: async () => bot },
    roles: { fetch: async () => new Map([["member", { id: "member", managed: false }]]) } };
}
function interaction(action, guild = guildFixture(`guild-${action}`), values = {}, permission = true) {
  const accessRoles = new Map(permission ? [["clan-access", true]] : []);
  if (guild) {
    if (!db.getGuildSettings(guild.id)) db.setManagerRole(guild.id, "clan-access");
    const fetch = guild.members.fetch;
    guild.members.fetch = async (request) => request && typeof request === "object" && request.user === `actor-${guild.id}`
      ? { id: request.user, roles: { cache: accessRoles }, permissions: { has: () => permission } } : fetch(request);
  }
  return { guild, guildId: guild?.id ?? null, inCachedGuild: () => !!guild,
    member: { roles: { cache: accessRoles } },
    user: { id: `actor-${guild?.id ?? action}`, username: "Actor" }, memberPermissions: { has: () => permission },
    options: { getSubcommand: () => action, getUser: (name) => values[name] ?? null,
      getString: (name) => values[name] ?? null, getInteger: (name) => values[name] ?? null,
      getRole: (name) => values[name] ?? null, getChannel: (name) => values[name] ?? null },
    deferred: false, deferReply: async function () { this.deferred = true; },
    editReply: async function (value) { this.output = value; } };
}
function memberFixture(guild, id, initial = []) {
  const cache = new Map(initial.map((role) => [role, true]));
  return { id, guild, user: { bot: false }, roles: { cache,
    add: async (role) => cache.set(role, true), remove: async (role) => cache.delete(role) } };
}
function serviceFixture(guilds = []) {
  const service = new ClanSyncService({ guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) } });
  service.rolePacer = new PacedQueue(0);
  return service;
}
afterEach(() => { let job; while ((job = db.nextJob(Number.MAX_SAFE_INTEGER))) db.finishJob(job); });
after(() => db.close());

test("command registration exposes one clan command with an action choice and shared inputs", () => {
  const data = commands.map((command) => command.data.toJSON());
  assert.deepEqual(data.map((command) => command.name), ["link", "unlink", "whois", "stats", "clan", "config", "debug", "dice", "availability", "event", "onboarding", "wheel", "milestones", "bingo", "duel", "lobby"]);
  assert.equal(data.length, 16);
  assert.equal(new Set(data.map(command => command.name)).size, 16);
  assert.deepEqual(data.find(command => command.name === 'dice').options.map(option => option.name), ['sides', 'count']);
  for (const name of ['availability', 'event', 'onboarding', 'wheel', 'milestones', 'bingo', 'duel']) {
    assert.deepEqual(data.find(command => command.name === name).contexts, [0], name);
  }
  const duel = data.find((command) => command.name === 'duel');
  assert.deepEqual(duel.contexts, [0]);
  assert.equal(duel.options.length, 1);
  assert.equal(duel.options[0].name, 'opponent');
  assert.equal(duel.options[0].required, true);
  const clan = data.find((command) => command.name === "clan");
  assert.equal(clan.options.length, 13);
  assert.equal(clan.options[0].name, "action");
  assert.deepEqual(clan.options[0].choices.map((choice) => choice.value), ["setup", "config", "remove", "sync", "pending", "roster", "audit", "link", "unlink", "coverage", "doctor", "recent", "summary"]);
  assert.ok(clan.options.some((option) => option.name === "clan_tag"));
  assert.ok(clan.options.some((option) => option.name === "user"));
  assert.ok(clan.options.some((option) => option.name === "openfront_id"));
  assert.ok(clan.options.some((option) => option.name === "page"));
});

test("configuration rejects missing credentials and invalid intervals", () => {
  const saved = { ...CONFIG };
  try {
    validateConfig();
    for (const value of [NaN, 0, 1, 2.5, 1441]) { CONFIG.DEFAULT_SYNC_INTERVAL_MINS = value; assert.throws(validateConfig, /integer between/); }
    CONFIG.DISCORD_TOKEN = ""; assert.throws(validateConfig, /DISCORD_TOKEN/);
  } finally { Object.assign(CONFIG, saved); }
});

test("every clan subcommand requires its configured role before work", async () => {
  for (const action of ["setup", "remove", "link", "unlink", "sync", "audit", "pending", "roster", "doctor", "coverage", "config", "recent", "summary"]) {
    const i = interaction(action, guildFixture(`deny-${action}`), { user: { id: "someone-else" } }, false);
    await assert.rejects(clanCommand.execute(i, {}), /role/);
    assert.equal(i.deferred, false);
  }
  await assert.rejects(clanCommand.execute(interaction("config", null), {}), /server/);
});

test("recent clan history requires a configured tag and rechecks disabled settings after loading", async (t) => {
  const missing = interaction("recent", guildFixture("history-missing"));
  await assert.rejects(clanCommand.execute(missing, {}), /clan_tag/);
  const guild = guildFixture("history-during-fetch");
  db.setGuildClanConfig(config(guild.id));
  const i = interaction("recent", guild, {clan_tag:"TEST",days:1});
  t.mock.method(openfrontApi, "getClanSessions", async (_tag,q) => {
    const settings = db.history.getSettings(guild.id);
    db.history.saveSettings(guild.id, {...settings,clan_history_enabled:0}, settings.revision);
    return {results:[],total:0,page:1,limit:50};
  });
  await assert.rejects(clanCommand.execute(i,{}), /settings changed/);
  assert.equal(i.output, undefined);
});

test("setup validates real bot role hierarchy and rejects duplicate rank roles", async () => {
  const guild = guildFixture("validation");
  guild.members.fetchMe = async () => ({ permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => -1 } } });
  const errors = await validateClanDraft(guild, { ...newClanDraft("TEST"), member_role_id: "member" });
  assert.ok(errors.some((error) => error.includes("above")));
  const duplicate = await validateClanDraft(guild, { ...newClanDraft("TEST"), member_role_id: "member", officer_role_id: "member" });
  assert.ok(duplicate.some((error) => error.includes("different")));
});

test("setup uses the configured interval and saves only after validation", async (t) => {
  t.mock.method(openfrontApi, "getClanInfo", async () => ({ tag: "TEST", name: "Test", description: "" }));
  const guild = guildFixture("setup-default");
  const i = interaction("setup", guild, { clan_tag: "TEST", member_role: { id: "member" } });
  await clanCommand.execute(i, {});
  assert.equal(db.getGuildClanConfig(guild.id, "TEST").sync_interval_mins, 25);
  const invalid = guildFixture("setup-invalid-hierarchy");
  invalid.members.fetchMe = async () => ({ permissions: { has: () => true },
    roles: { highest: { comparePositionTo: () => -1 } } });
  await assert.rejects(clanCommand.execute(interaction("setup", invalid,
    { clan_tag: "TEST", member_role: { id: "member" } }), {}), /above/);
  assert.equal(db.getGuildClanConfig(invalid.id, "TEST"), null);
});

test("removal defers before fetching members and queues cleanup for unlinked role holders", async () => {
  const guild = guildFixture("remove-deadline"), c = config(guild.id);
  db.setGuildClanConfig(c);
  const holder = memberFixture(guild, "unlinked-holder", ["member"]);
  const i = interaction("remove", guild, { clan_tag: "TEST" });
  const fetch = guild.members.fetch;
  guild.members.fetch = async (request) => {
    assert.equal(i.deferred, true);
    return request && typeof request === "object" ? fetch(request) : new Map([[holder.id, holder]]);
  };
  await clanCommand.execute(i, {});
  assert.equal(db.getGuildClanConfig(guild.id, "TEST"), null);
  assert.ok(JSON.parse(db.getJob(guild.id, holder.id).role_ids).includes("member"));
});

test("configuration output pages large servers within Discord limits", async () => {
  const guild = guildFixture("many-configs");
  for (let index = 0; index < 12; index++) db.setGuildClanConfig(config(guild.id, `T${index}`));
  const i = interaction("config", guild, { page: 4 });
  await clanCommand.execute(i, {});
  assert.equal(i.output.embeds.length, 3);
  assert.match(i.output.embeds[0].data.footer.text, /4\/4/);
  assert.ok(i.output.embeds.reduce((sum, embed) => sum + embed.length, 0) <= 6000);
});

test("pending invitations paginate members rather than silently truncating them", async () => {
  const guild = guildFixture("pending-pages"); db.setGuildClanConfig(config(guild.id));
  const list = Array.from({ length: 22 }, (_, index) => ({ member: { id: `pending-${index}` }, link: null }));
  const i = interaction("pending", guild, { page: 2 });
  await clanCommand.execute(i, { getPendingJoinMembers: async () => list });
  assert.match(i.output.embeds[0].data.description, /pending-21/);
  assert.doesNotMatch(i.output.embeds[0].data.description, /pending-0>/);
});

test("server sync reports failed checks without a green success summary", async () => {
  const guild = guildFixture("sync-errors"); db.setGuildClanConfig(config(guild.id));
  const i = interaction("sync", guild);
  await clanCommand.execute(i, { syncGuildClan: async () => [{ discordId: "u", inClan: false, rolesAdded: [], rolesRemoved: [], error: "Missing Permissions" }] });
  assert.match(i.output.embeds[0].data.title, /errors/);
  assert.match(i.output.embeds[0].data.description, /1 failed/);
});

test("invalid and ambiguous player inputs are rejected before API work", async () => {
  for (const value of ["<@123456789012345678>", "https://openfront.io/", "not a player id"]) assert.throws(() => playerId(value), /public ID/);
  assert.equal(playerId("<https://openfront.io/player/HabCsQYR>"), "HabCsQYR");
  assert.throws(() => pageOf([], 2, 3), /1 to 1/);
  await assert.rejects(linkCommand.execute(interaction("link", null, { token: "token", openfront_id: "player" })), /exactly one/);
  await assert.rejects(whoisCommand.execute(interaction("whois", null, { user: { id: "a" }, openfront_id: "player" })), /exactly one/);
});

test("whois keeps a stored identity but does not claim no clans during an outage", async (t) => {
  db.linkUser("whois-user", "whois-id", "Stored", "identity_token");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => { throw new OpenFrontApiError(); });
  const i = interaction("whois", null, { user: { id: "whois-user" } });
  await whoisCommand.execute(i);
  assert.match(i.output.embeds[0].data.fields.find((field) => field.name === "Clans").value, /unavailable/);
});

test("DM unlink clears server-only links across guilds even with no global link", async () => {
  db.linkGuildUser("unlink-a", "manager", "local-user", "local-id", null);
  db.linkGuildUser("unlink-b", "manager", "local-user", "other-id", null);
  const i = interaction("unlink", null); i.user.id = "local-user";
  await unlinkCommand.execute(i);
  assert.equal(db.getGuildLink("unlink-a", "local-user"), null);
  assert.equal(db.getGuildLink("unlink-b", "local-user"), null);
});

test("an unlink submitted during link verification wins after verification completes", async (t) => {
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  t.mock.method(openfrontApi, "getPlayerProfile", () => new Promise((resolve) => { release = resolve; started(); }));
  const id = "100000000000000001";
  const link = interaction("link", null, { openfront_id: "race-player" }); link.user.id = id;
  const unlink = interaction("unlink", null); unlink.user.id = id;
  const linking = linkCommand.execute(link);
  await ready;
  const unlinking = unlinkCommand.execute(unlink);
  release({ ...profile([]), user: { id } });
  await Promise.all([linking, unlinking]);
  assert.equal(db.getUserByDiscordId(id), null);
});

test("guild admins cannot overwrite verified identity or leak a local link into another guild", () => {
  const store = new BotDatabase(":memory:");
  try {
    store.linkGuildUser("a", "staff", "user", "local", null);
    assert.equal(store.getEffectiveLink("b", "user"), null);
    store.linkUser("user", "verified", null, "identity_token", "a");
    assert.throws(() => store.linkGuildUser("b", "staff", "user", "fake", null), /verified/);
    assert.equal(store.getEffectiveLink("b", "user").openfront_id, "verified");
    assert.equal(store.getGuildLink("a", "user"), null);
  } finally { store.close(); }
});

test("audit scoping keeps global events out of unrelated server histories", () => {
  const store = new BotDatabase(":memory:");
  try {
    store.setGuildClanConfig(config("unrelated"));
    store.linkUser("owner", "audit-id", null, "identity_token", "origin");
    store.linkGuildUser("private", "staff", "owner2", "private-id", null);
    assert.equal(store.getAudit("unrelated", null).length, 0);
    assert.equal(store.getAudit("origin", "owner").length, 1);
    assert.equal(store.getAudit("unrelated", "owner", 1, true).length, 1);
    assert.equal(store.getAudit("origin", "owner2", 1, true).length, 0);
  } finally { store.close(); }
});

test("migrated column ordering cannot corrupt role and interval settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "clit-migration-"));
  const file = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE guild_clan_configs(guild_id TEXT,clan_tag TEXT,member_role_id TEXT,officer_role_id TEXT,
    leader_role_id TEXT,log_channel_id TEXT,sync_interval_mins INTEGER,last_sync_at TEXT,PRIMARY KEY(guild_id,clan_tag));`);
  legacy.close();
  const store = new BotDatabase(file);
  try {
    const saved = config("migration", "TEST", { join_role_id: "approval", log_channel_id: "logs", sync_interval_mins: 31 });
    store.setGuildClanConfig(saved);
    assert.deepEqual({ ...store.getGuildClanConfig("migration", "TEST") }, saved);
  } finally {
    store.close(); unlinkSync(file);
    const backups = join(directory, "backups");
    for (const entry of readdirSync(backups)) unlinkSync(join(backups, entry));
    rmdirSync(backups); rmdirSync(directory);
  }
});

test("shared officer roles require officer rank in at least one configured clan", () => {
  const a = config("ranks", "AAA", { officer_role_id: "officer" });
  const b = config("ranks", "BBB", { member_role_id: "b-member", officer_role_id: "officer" });
  assert.equal(desiredRoles([a, b], [membership("AAA"), membership("BBB")]).has("officer"), false);
  assert.equal(desiredRoles([a, b], [membership("AAA"), membership("BBB", "officer")]).has("officer"), true);
});

test("missing clan data cannot strip existing roles", async (t) => {
  const guild = guildFixture("missing-clans"), c = config(guild.id); db.setGuildClanConfig(c);
  db.linkUser("missing-user", "missing-id", "Old", "identity_token");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ username: "New" }));
  const m = memberFixture(guild, "missing-user", ["member"]);
  const result = await serviceFixture().syncMemberForClan(m, db.getUserByDiscordId(m.id), c);
  assert.match(result.error, /did not return clan/);
  assert.equal(m.roles.cache.has("member"), true);
});

test("username refresh preserves original link timestamp and verification", async (t) => {
  const guild = guildFixture("username"), c = config(guild.id); db.setGuildClanConfig(c);
  db.linkUser("username-user", "username-id", "Old", "identity_token");
  const before = db.getUserByDiscordId("username-user");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => ({ username: "New", clans: [] }));
  await serviceFixture().syncMemberForClan(memberFixture(guild, "username-user"), before, c);
  assert.deepEqual({ ...db.getUserByDiscordId("username-user") }, { ...before, openfront_username: "New" });
});

test("a demoted member loses the shared officer role without losing their member role", async (t) => {
  const guild = guildFixture("demotion");
  const a = config(guild.id, "AAA", { officer_role_id: "officer" });
  const b = config(guild.id, "BBB", { officer_role_id: "officer", member_role_id: "other-member" });
  db.setGuildClanConfig(a); db.setGuildClanConfig(b);
  db.linkUser("demoted", "demoted-id", null, "identity_token");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => profile([membership("AAA"), membership("BBB")]));
  const m = memberFixture(guild, "demoted", ["member", "officer"]);
  const result = await serviceFixture().syncMemberForClan(m, db.getUserByDiscordId(m.id), a);
  assert.deepEqual(result.rolesRemoved, ["officer"]);
  assert.equal(m.roles.cache.has("member"), true);
});

test("link removal while an API lookup is pending cannot regrant roles", async (t) => {
  const guild = guildFixture("stale-link"), c = config(guild.id); db.setGuildClanConfig(c);
  db.linkUser("stale-user", "stale-id", null, "identity_token");
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  t.mock.method(openfrontApi, "getPlayerProfile", () => new Promise((resolve) => { release = resolve; started(); }));
  const m = memberFixture(guild, "stale-user");
  const work = serviceFixture().syncMemberForClan(m, db.getUserByDiscordId(m.id), c);
  await ready; db.unlinkUser(m.id); release(profile([membership()]));
  const result = await work;
  assert.match(result.error, /Link changed/);
  assert.equal(m.roles.cache.size, 0);
});

test("configuration removal while an API lookup is pending prevents stale writes", async (t) => {
  const guild = guildFixture("stale-config"), c = config(guild.id); db.setGuildClanConfig(c);
  db.linkUser("config-user", "config-id", null, "identity_token");
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  t.mock.method(openfrontApi, "getPlayerProfile", () => new Promise((resolve) => { release = resolve; started(); }));
  const m = memberFixture(guild, "config-user");
  const work = serviceFixture().syncMemberForClan(m, db.getUserByDiscordId(m.id), c);
  await ready; db.deleteGuildClanConfig(guild.id, "TEST"); release(profile([membership()]));
  assert.match((await work).error, /configuration changed/);
  assert.equal(m.roles.cache.size, 0);
});

test("queued writes recheck identity after waiting for the global role lane", async (t) => {
  const guild = guildFixture("queued-stale"), c = config(guild.id); db.setGuildClanConfig(c);
  db.linkUser("queue-user", "queue-id", null, "identity_token");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => profile([membership()]));
  const m = memberFixture(guild, "queue-user"), service = serviceFixture();
  service.rolePacer.run = async (work) => { db.unlinkUser(m.id); return work(); };
  const result = await service.syncMemberForClan(m, db.getUserByDiscordId(m.id), c);
  assert.match(result.error, /stale role update/);
  assert.equal(m.roles.cache.size, 0);
});

test("role API failures are reported and do not advance the success timestamp", async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const guild = guildFixture("role-fail"), c = config(guild.id); db.setGuildClanConfig(c);
  db.linkUser("failed-user", "failed-id", null, "identity_token");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => profile([membership()]));
  const m = memberFixture(guild, "failed-user"); m.roles.add = async () => { throw new Error("Missing Permissions"); };
  guild.members.fetch = async () => new Map([[m.id, m]]);
  const [result] = await serviceFixture().syncGuildClan(guild, c);
  assert.match(result.error, /Missing Permissions/);
  assert.equal(db.getGuildClanConfig(guild.id, "TEST").last_sync_at, null);
  assert.deepEqual(warnings, [['[ClanSync] Role update failed for failed-user in guild role-fail:', 'Missing Permissions']]);
});

test("role lane serializes writes with a one-second gap even after a failed write", async () => {
  let now = 0;
  const starts = [];
  const lane = new PacedQueue(1000, async (ms) => { now += ms; }, () => now);
  const failure = new Error("failed");
  const outcomes = await Promise.allSettled([lane.run(async () => { starts.push(now); throw failure; }),
    lane.run(async () => { starts.push(now); return "second"; }),
    lane.run(async () => { starts.push(now); return "third"; })]);
  assert.deepEqual(starts, [0, 1000, 2000]);
  assert.deepEqual(outcomes, [{ status: "rejected", reason: failure },
    { status: "fulfilled", value: "second" }, { status: "fulfilled", value: "third" }]);
});

test("API transport distinguishes 404, outages, and malformed memberships", async (t) => {
  const api = new OpenFrontApi("https://api.example.test");
  const stub = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(url.endsWith("a%2Fb"));
    return new Response(null, { status: 404 });
  });
  assert.equal(await api.getPlayerProfile("a/b"), null);
  stub.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(api.getPlayerProfile("player"), OpenFrontApiError);
  stub.mock.mockImplementation(async () => new Response(JSON.stringify({ clans: [{ tag: "TEST", name: "Test", role: "invented" }] })));
  await assert.rejects(api.getPlayerProfile("player"), OpenFrontApiError);
});

test("self-unlink also wins over an earlier server-admin link awaiting the API", async (t) => {
  const guild = guildFixture("manual-race");
  guild.members.fetch = async () => ({ id: "manual-target" });
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  t.mock.method(openfrontApi, "getPlayerProfile", () => new Promise((resolve) => { release = resolve; started(); }));
  const manual = interaction("link", guild, { user: { id: "manual-target" }, openfront_id: "manual-id" });
  const pendingLink = clanCommand.execute(manual, {});
  await ready;
  const unlink = interaction("unlink", null); unlink.user.id = "manual-target";
  const pendingUnlink = unlinkCommand.execute(unlink);
  release(profile([]));
  await Promise.all([pendingLink, pendingUnlink]);
  assert.equal(db.getGuildLink(guild.id, "manual-target"), null);
});

test("one failed addition does not prevent removing an obsolete officer role", async (t) => {
  const guild = guildFixture("partial-update"), c = config(guild.id, "TEST", { officer_role_id: "officer" });
  db.setGuildClanConfig(c); db.linkUser("partial-user", "partial-id", null, "identity_token");
  t.mock.method(openfrontApi, "getPlayerProfile", async () => profile([membership()]));
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const m = memberFixture(guild, "partial-user", ["officer"]);
  m.roles.add = async () => { throw new Error("Missing Permissions"); };
  const result = await serviceFixture().syncMemberForClan(m, db.getUserByDiscordId(m.id), c);
  assert.match(result.error, /Missing Permissions/);
  assert.deepEqual(result.rolesRemoved, ["officer"]);
  assert.deepEqual(warnings, [['[ClanSync] Role update failed for partial-user in guild partial-update:', 'Missing Permissions']]);
});

test("cleanup across two guilds uses the same paced lane", async () => {
  const a = guildFixture("paced-a"), b = guildFixture("paced-b");
  const first = memberFixture(a, "paced-user", ["member"]), second = memberFixture(b, "paced-user", ["member"]);
  db.setGuildClanConfig(config(a.id)); db.setGuildClanConfig(config(b.id));
  a.members.fetch = async () => first; b.members.fetch = async () => second;
  db.enqueueGuild(a.id, first.id); db.enqueueGuild(b.id, second.id);
  let now = 0; const starts = [];
  for (const m of [first, second]) m.roles.remove = async (role) => { starts.push(now); m.roles.cache.delete(role); };
  const service = serviceFixture([a, b]);
  service.rolePacer = new PacedQueue(1000, async (ms) => { now += ms; }, () => now);
  await service.processRoleCleanupQueue();
  assert.deepEqual(starts, [0, 1000]);
  assert.equal(db.getJob(a.id, first.id), null);
  assert.equal(db.getJob(b.id, second.id), null);
});

test("server sync finishes by editing its public bot message", async () => {
  const guild = guildFixture("public-progress"); db.setGuildClanConfig(config(guild.id));
  const i = interaction("sync", guild);
  let completed;
  i.editReply = async () => ({ edit: async (payload) => { completed = payload; } });
  await clanCommand.execute(i, { syncGuildClan: async () => [] });
  assert.equal(completed.content, null);
  assert.match(completed.embeds[0].data.title, /complete/);
});
