import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { checkClanAccess, hasClanAccess, requireClanAccess } = await import("../dist/access.js");
const { hasConfigAccess, requireConfigAccess } = await import("../dist/access.js");
const { PermissionFlagsBits } = await import("discord.js");
const { configCommand, handleConfigInteraction } = await import("../dist/commands/config.js");
const { db } = await import("../dist/db.js");
const { openfrontApi } = await import("../dist/api.js");
after(() => db.close());

let sequence = 0;
const ids = { manager: "900000000000000001", replacement: "900000000000000002", member: "900000000000000003", officer: "900000000000000004", leader: "900000000000000005", approval: "900000000000000006", logs: "900000000000000007" };
function fixture({ bootstrap = false, owner = false, manageGuild = false } = {}) {
  const id = `80000000000000${String(++sequence).padStart(4, "0")}`;
  const userId = `70000000000000${String(sequence).padStart(4, "0")}`;
  const permissions = { manageGuild };
  const user = { id: userId, user: { bot: false }, roles: { cache: new Map(bootstrap ? [] : [[ids.manager, true]]) },
    permissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild && permissions.manageGuild } };
  const roles = new Map(Object.values(ids).map((id) => [id, { id, managed: false }]));
  let memberCalls = 0;
  const guild = { id, ownerId: owner ? userId : "600000000000000000", roles: { fetch: async (id) => id ? roles.get(id) ?? null : roles },
    channels: { fetch: async () => ({ type: 0, permissionsFor: () => ({ has: () => true }) }) },
    members: { cache: new Map([[userId, user]]), fetchMe: async () => ({ permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } }),
      fetch: async (options) => { memberCalls++; if (options) { assert.equal(options.force, true); return user; } return new Map([[userId, user]]); } } };
  if (!bootstrap) db.setManagerRole(id, ids.manager);
  return { guild, user, roles, userId, permissions, calls: () => memberCalls };
}
function command(f) {
  return { guild: f.guild, guildId: f.guild.id, user: { id: f.userId }, member: f.user, memberPermissions: f.user.permissions,
    inCachedGuild: () => true, deferred: false, replied: false,
    deferReply: async function (payload) { this.deferred = true; this.deferredPayload = payload; },
    editReply: async function (payload) { this.output = payload; } };
}
const rows = (payload) => payload.components.map((row) => row.toJSON());
const components = (payload) => rows(payload).flatMap((row) => row.components);
const session = (payload) => components(payload)[0].custom_id.split(":")[1];
function component(f, sessionId, action, kind = "button", values = [], overrides = {}) {
  return { guild: f.guild, guildId: f.guild.id, user: { id: f.userId }, member: f.user, memberPermissions: f.user.permissions, customId: `clit-config:${sessionId}:${action}`, values,
    inCachedGuild: () => true, isMessageComponent: () => kind !== "modal", isModalSubmit: () => kind === "modal", isFromMessage: () => true,
    isButton: () => kind === "button", isRoleSelectMenu: () => kind === "role", isStringSelectMenu: () => kind === "string", isChannelSelectMenu: () => kind === "channel",
    deferred: false, replied: false, followups: [],
    deferUpdate: async function () { this.deferred = true; }, update: async function (payload) { this.output = payload; this.replied = true; },
    editReply: async function (payload) { this.output = payload; },
    reply: async function (payload) { this.output = payload; this.replied = true; },
    followUp: async function (payload) { this.followups.push(payload); },
    showModal: async function (modal) { this.modal = modal; this.replied = true; }, ...overrides };
}
async function open(f) {
  const i = command(f);
  await configCommand.execute(i);
  assert.equal(i.deferred, true);
  return { i, id: session(i.output) };
}
async function action(f, id, name, kind, values, overrides) {
  if (["details", "member_role_id", "officer_role_id", "leader_role_id", "join_role_id", "log_channel_id"].includes(name)) name += ":TEST";
  const i = component(f, id, name, kind, values, overrides);
  assert.equal(await handleConfigInteraction(i), true);
  return i;
}
const error = (i) => i.followups.at(-1)?.content ?? i.output?.content ?? "";
const savedConfig = (f, overrides = {}) => ({ guild_id: f.guild.id, clan_tag: "TEST", member_role_id: ids.member, officer_role_id: null,
  leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null, ...overrides });
function assertComponentLimits(payload) {
  let embedCharacters = 0;
  for (const builder of payload.embeds ?? []) {
    const embed = builder.toJSON();
    assert.ok((embed.title?.length ?? 0) <= 256);
    assert.ok((embed.description?.length ?? 0) <= 4096);
    assert.ok((embed.fields?.length ?? 0) <= 25);
    embedCharacters += (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0);
    for (const field of embed.fields ?? []) {
      assert.ok(field.name.length <= 256 && field.value.length <= 1024);
      embedCharacters += field.name.length + field.value.length;
    }
  }
  assert.ok(embedCharacters <= 6000, "configuration must fit Discord's combined embed limit");
  const json = rows(payload);
  const customIds = json.flatMap(row => row.components.map(component => component.custom_id));
  assert.equal(new Set(customIds).size, customIds.length, "each visible control must have its own custom ID");
  assert.ok(json.length <= 5, "Discord permits at most five action rows");
  for (const row of json) {
    assert.ok(row.components.length >= 1 && row.components.length <= 5);
    for (const c of row.components) {
      assert.ok(c.custom_id.length <= 100);
      if (c.type !== 2) assert.equal(row.components.length, 1, "select menus need their own row");
      if (c.options) assert.ok(c.options.length <= 25);
      if (c.type === 6 || c.type === 8) assert.ok(c.min_values >= 0 && c.max_values === 1);
    }
  }
}

for (const legacyOrder of [false, true]) test(`a newly created clan can be edited and removed with ${legacyOrder ? "legacy" : "current"} column order`, async t => {
  const f = fixture();
  if (legacyOrder) {
    // The supported migration adds join_role_id after the original columns.
    const readConfig = db.getGuildClanConfig.bind(db);
    t.mock.method(db, "getGuildClanConfig", (...args) => {
      const config = readConfig(...args);
      if (!config) return null;
      const { join_role_id, ...originalColumns } = config;
      return { ...originalColumns, join_role_id };
    });
  }
  const { id } = await open(f);
  await action(f, id, "new");
  await action(f, id, "details:new", "modal", [], {
    fields: { getTextInputValue: name => name === "tag" ? "TEST" : "10" },
  });
  await action(f, id, "member_role_id:new", "role", [ids.member]);
  const first = await action(f, id, "save");
  assert.equal(error(first), "");
  assert.ok(db.getGuildClanConfig(f.guild.id, "TEST"));
  const second = await action(f, id, "log_channel_id", "channel", [ids.logs]);
  assert.equal(error(second), "", "a saved draft must compare equal regardless of SQLite column order");
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").log_channel_id, ids.logs);
  await action(f, id, "delete");
  const removed = await action(f, id, "remove");
  assert.equal(error(removed), "");
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST"), null);
});

test("all clan access checks require the selected role even for an administrator or server owner", async () => {
  const f = fixture({ owner: true, manageGuild: true }), i = command(f);
  checkClanAccess(i);
  f.user.roles.cache.clear();
  assert.throws(() => checkClanAccess(i), /need the.*role/i);
  assert.equal(await hasClanAccess(f.guild, f.userId), false);
  await assert.rejects(requireClanAccess(f.guild, f.userId), /config role is missing/);
  assert.ok(f.calls() >= 2, "each asynchronous access check refreshes member roles");
  const unconfigured = fixture({ bootstrap: true, owner: true });
  assert.throws(() => checkClanAccess(command(unconfigured)), /choose.*role|configure.*role/i);
});

test("debug role selection is independent, rejects stale edits, and can be disabled", async () => {
  const f = fixture(), first = await open(f), second = await open(f);
  const saved = await action(f, first.id, "debug_access", "role", [ids.replacement]);
  assert.equal(error(saved), "");
  assert.equal(db.getDebugSettings(f.guild.id).debug_role_id, ids.replacement);
  assert.equal(db.getGuildSettings(f.guild.id).manager_role_id, ids.manager);
  const stale = await action(f, second.id, "debug_access", "role", [ids.member]);
  assert.match(error(stale), /changed in another session/);
  const disabled = await action(f, first.id, "debug_access", "role", []);
  assert.equal(error(disabled), "");
  assert.equal(db.getDebugSettings(f.guild.id).debug_role_id, null);
});

test("history config integrates toggles, channel, validation and stale draft rejection", async () => {
  const f = fixture(), first = await open(f), second = await open(f);
  let screen = await action(f, first.id, "history");
  assertComponentLimits(screen.output);
  await action(f, second.id, "history");
  await action(f, first.id, "history_weekly");
  let saved = await action(f, first.id, "history_save");
  assert.match(error(saved), /require collection and a recap channel/);
  await action(f, first.id, "history_channel", "channel", [ids.logs]);
  saved = await action(f, first.id, "history_save");
  assert.equal(error(saved), "");
  const settings = db.history.getSettings(f.guild.id);
  assert.equal(settings.weekly_enabled, 1);
  assert.equal(settings.collection_enabled, 1);
  assert.equal(settings.channel_id, ids.logs);
  assert.equal(settings.timezone, "UTC");
  assert.equal(settings.weekly_hour, 12);
  const stale = await action(f, second.id, "history_save");
  assert.match(error(stale), /changed in another session/);
  screen = await action(f, first.id, "history_timing");
  assert.equal(screen.modal.toJSON().components.length, 5);
  await action(f, first.id, "history_details", "modal", [], { fields: { getTextInputValue: (key) => ({poll:"1",retention:"90",day:"1",hour:"9",timezone:"America/Bahia"})[key] } });
  assert.match(error(await action(f, first.id, "history_save")), /Poll interval/);
  assert.equal(db.history.getSettings(f.guild.id).poll_minutes, 15);
});

test("history and draft screens do not load unrelated clan lists or role queues", async (t) => {
  const f = fixture();
  const { id } = await open(f);
  t.mock.method(db, "getGuildConfigs", () => { throw new Error("unnecessary clan list read"); });
  t.mock.method(db, "getQueueSummary", () => { throw new Error("unnecessary queue read"); });
  const history = await action(f, id, "history");
  assert.ok(history.output?.embeds?.length, "history settings must render without loading clan summaries");
  assertComponentLimits(history.output);
  const draft = await action(f, id, "new");
  assert.ok(draft.output?.embeds?.length, "clan draft must render without loading queue summaries");
  assertComponentLimits(draft.output);
});

test("history config rechecks permission after channel validation before saving", async (t) => {
  const f = fixture(), { id } = await open(f);
  await action(f, id, "history");
  await action(f, id, "history_channel", "channel", [ids.logs]);
  t.mock.method(f.guild.channels, "fetch", async () => {
    f.user.roles.cache.clear();
    return { type: 0, permissionsFor: () => ({ has: () => true }) };
  });
  assert.match(error(await action(f, id, "history_save")), /Manage Server|config role/);
  assert.equal(db.history.getSettings(f.guild.id).revision, 0);
});

test("debug role rejects everyone, managed roles and changes after access revocation", async (t) => {
  const f = fixture(), { id } = await open(f);
  f.roles.set(f.guild.id, { id: f.guild.id, managed: false });
  assert.match(error(await action(f, id, "debug_access", "role", [f.guild.id])), /normal server role/);
  f.roles.get(ids.replacement).managed = true;
  assert.match(error(await action(f, id, "debug_access", "role", [ids.replacement])), /normal server role/);
  t.mock.method(f.guild.roles, "fetch", async (roleId) => { f.user.roles.cache.clear(); return f.roles.get(roleId); });
  assert.match(error(await action(f, id, "debug_access", "role", [ids.member])), /Manage Server|config role/);
  assert.equal(db.getDebugSettings(f.guild.id), null);
});

test("Manage Server can bootstrap and recover configuration while clan commands still require the chosen role", async () => {
  const denied = fixture({ bootstrap: true });
  await assert.rejects(configCommand.execute(command(denied)), /Manage Server|configuration|configured role|access role/i);
  const f = fixture({ bootstrap: true, manageGuild: true });
  const { i, id } = await open(f);
  assert.match(i.output.embeds[0].toJSON().title, /configuration/);
  assert.equal(await hasConfigAccess(f.guild, f.userId), true);
  const picked = await action(f, id, "access", "role", [ids.manager]);
  assert.equal(db.getGuildSettings(f.guild.id).manager_role_id, ids.manager);
  assert.equal(error(picked), "");
  assert.equal(await hasClanAccess(f.guild, f.userId), false);
  assert.throws(() => checkClanAccess(command(f)), /need the.*role/i);
  const managerCanConfigure = await action(f, id, "new");
  assert.equal(error(managerCanConfigure), "");
  f.permissions.manageGuild = false;
  assert.equal(await hasConfigAccess(f.guild, f.userId), false);
  f.user.roles.cache.set(ids.manager, true);
  const allowed = await open(f);
  assert.match(allowed.i.output.embeds[0].toJSON().title, /server configuration/);
  f.user.roles.cache.clear();
  f.permissions.manageGuild = true;
  const recovery = await open(f);
  const changed = await action(f, recovery.id, "access", "role", [ids.replacement]);
  assert.equal(error(changed), "");
  assert.equal(db.getGuildSettings(f.guild.id).manager_role_id, ids.replacement);
});

test("configuration sessions reject a different user and a different guild", async () => {
  const f = fixture(), { id } = await open(f);
  const otherUser = await action(f, id, "new", "button", [], { user: { id: "123456789012345678" } });
  assert.match(error(otherUser), /own.*menu/);
  assert.equal(otherUser.deferred, false);
  const otherGuild = await action(f, id, "new", "button", [], { guildId: "123456789012345678" });
  assert.match(error(otherGuild), /own.*menu/);
  assert.equal(otherGuild.deferred, false);
});

test("every component action rechecks revoked roles and expired menus cannot make changes", async (t) => {
  const f = fixture(), { id } = await open(f);
  f.user.roles.cache.clear();
  const revoked = await action(f, id, "new");
  assert.match(error(revoked), /Manage Server|configuration|configured role|access role/i);
  f.user.roles.cache.set(ids.manager, true);
  const old = Date.now();
  t.mock.method(Date, "now", () => old + 11 * 60_000);
  const expired = await action(f, id, "access", "role", [ids.replacement]);
  assert.match(error(expired), /menu expired/);
  assert.equal(db.getGuildSettings(f.guild.id).manager_role_id, ids.manager);
});

test("access-role changes reject stale sessions instead of overwriting a newer role", async () => {
  const f = fixture({ bootstrap: true, manageGuild: true });
  const first = await open(f), second = await open(f);
  const saved = await action(f, first.id, "access", "role", [ids.manager]);
  assert.equal(error(saved), "");
  const stale = await action(f, second.id, "access", "role", [ids.replacement]);
  assert.match(error(stale), /changed in another session/);
  assert.equal(db.getGuildSettings(f.guild.id).manager_role_id, ids.manager);
  assert.equal(db.getGuildSettings(f.guild.id).revision, 1);
});

test("any normal server role can be selected, including clan roles, while everyone and integrations are rejected", async () => {
  const f = fixture({ manageGuild: true }), { id } = await open(f);
  f.roles.set(f.guild.id, { id: f.guild.id, managed: false });
  let denied = await action(f, id, "access", "role", [f.guild.id]);
  assert.match(error(denied), /normal server role/);
  f.roles.get(ids.replacement).managed = true;
  denied = await action(f, id, "access", "role", [ids.replacement]);
  assert.match(error(denied), /normal server role/);
  db.setGuildClanConfig(savedConfig(f));
  const selected = await action(f, id, "access", "role", [ids.member]);
  assert.equal(error(selected), "");
  assert.equal(db.getGuildSettings(f.guild.id).manager_role_id, ids.member);
});

test("configuration menus stay within Discord limits and paginate more than 25 clans", async () => {
  const f = fixture();
  for (let n = 0; n < 27; n++) db.setGuildClanConfig(savedConfig(f, { clan_tag: `T${String(n).padStart(2, "0")}` }));
  const { i, id } = await open(f);
  assertComponentLimits(i.output);
  const clans = await action(f, id, "clans");
  assert.equal(components(clans.output).find((c) => c.type === 3).options.length, 25);
  const next = await action(f, id, "next");
  assertComponentLimits(next.output);
  assert.equal(components(next.output).find((c) => c.type === 3).options.length, 2);
  const edit = await action(f, id, "clan", "string", ["T00"]);
  assertComponentLimits(edit.output);
  const roles = await action(f, id, "roles");
  assertComponentLimits(roles.output);
  assert.equal(rows(roles.output).length, 5);
  const roleMenus = components(roles.output).filter((c) => c.type === 6);
  assert.deepEqual(roleMenus.map((c) => c.min_values), [1, 0, 0, 0]);
  const logs = await action(f, id, "logs");
  assertComponentLimits(logs.output);
});

for (const operation of ["save", "remove"]) test(`configuration ${operation} selects reconciliation members with one identity read for a large roster`, async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f, { officer_role_id: ids.officer, join_role_id: ids.approval }));
  const member = (id, roles = []) => ({ id, user: { bot: false }, roles: { cache: new Map(roles.map(role => [role, true])) } });
  const global = member(`global-${f.guild.id}`), local = member(`local-${f.guild.id}`), holder = member("unlinked-holder", [ids.officer]);
  const approval = member("approval-only", [ids.approval]), foreign = member("foreign-local"), outside = `outside-${f.guild.id}`;
  db.linkUser(global.id, `account-${global.id}`, null, "identity_token");
  db.linkGuildUser(f.guild.id, "manager", local.id, `account-${local.id}`, null);
  db.linkGuildUser(`other-${f.guild.id}`, "manager", foreign.id, `account-foreign-${f.guild.id}`, null);
  db.linkUser(outside, `account-${outside}`, null, "identity_token");
  for (const id of [global.id, local.id, outside]) {
    const job = db.getJob(f.guild.id, id);
    if (job) db.finishJob(job);
  }
  const roster = new Map([global, local, holder, approval, foreign,
    ...Array.from({ length: 451 }, (_, index) => member(`unlinked-${index}`))].map(value => [value.id, value]));
  f.guild.members.fetch = async options => options ? f.user : roster;
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  if (operation === "remove") await action(f, id, "delete");
  const prepare = db.db.prepare.bind(db.db);
  let identityReads = 0;
  t.mock.method(db.db, "prepare", sql => {
    if (/^SELECT\b/i.test(sql) && /\bFROM\s+(?:linked_users|guild_links)\b/i.test(sql)) identityReads++;
    return prepare(sql);
  });
  const result = operation === "save" ? await action(f, id, "officer_role_id", "role", []) : await action(f, id, "remove");
  assert.equal(error(result), "");
  assert.equal(identityReads, 1, "identity reads must not grow with the roster");
  for (const memberId of [global.id, local.id, holder.id]) {
    assert.ok(db.getJob(f.guild.id, memberId), `${memberId} requires reconciliation`);
    assert.ok(JSON.parse(db.getJob(f.guild.id, memberId).role_ids).includes(ids.officer), "obsolete mapped roles remain queued");
  }
  for (const memberId of [approval.id, foreign.id, outside, "unlinked-450"]) assert.equal(db.getJob(f.guild.id, memberId), null);
});

test("new clan stays a draft until Create clan", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected OpenFront request"); });
  const f = fixture(), { id } = await open(f);
  await action(f, id, "new");
  const basics = await action(f, id, "basics");
  assert.equal(error(basics), "");
  assert.ok(basics.modal, "a new clan must show a valid tag/interval modal");
  const modal = basics.modal.toJSON();
  assert.equal(modal.components.length, 2);
  await action(f, id, "details:new", "modal", [], { fields: { getTextInputValue: (key) => key === "tag" ? "test" : "15" } });
  await action(f, id, "roles");
  await action(f, id, "member_role_id:new", "role", [ids.member]);
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST"), null);
  const saved = await action(f, id, "save");
  assert.equal(error(saved), "");
  assert.equal(upstream.mock.callCount(), 0);
  const current = db.getGuildClanConfig(f.guild.id, "TEST");
  assert.equal(current.member_role_id, ids.member);
  assert.equal(current.sync_interval_mins, 15);
  assert.match(saved.output.embeds[0].toJSON().description, /Saved/);
});

test("saving a clan rejects changes from another session and retains the newer configuration", async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  db.setGuildClanConfig(savedConfig(f, { sync_interval_mins: 30 }));
  const stale = await action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  assert.match(error(stale), /changed in another session/);
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").sync_interval_mins, 30);
});

test("a clan edit from an old screen cannot autosave to another clan", async () => {
  const f = fixture(), { id } = await open(f);
  db.setGuildClanConfig(savedConfig(f));
  db.setGuildClanConfig(savedConfig(f, { clan_tag: "NEXT" }));
  await action(f, id, "clan", "string", ["TEST"]);
  const form = await action(f, id, "basics");
  await action(f, id, "clan", "string", ["NEXT"]);
  const stale = await action(f, id, "details", "modal", [], {
    customId: form.modal.toJSON().custom_id,
    fields: { getTextInputValue: () => "30" },
  });
  assert.match(error(stale), /clan.*changed|reopen/i);
  assert.equal(db.getGuildClanConfig(f.guild.id, "NEXT").sync_interval_mins, 10);
});

test("clan save rechecks member role after slow validation and rejects revoked access", async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  t.mock.method(f.guild.roles, "fetch", async () => { f.user.roles.cache.clear(); return f.roles; });
  const denied = await action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  assert.match(error(denied), /Manage Server|configuration|configured role|access role/i);
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").sync_interval_mins, 10);
});

test("access checks use the latest configured role if settings change during member fetch", async (t) => {
  const f = fixture();
  t.mock.method(f.guild.members, "fetch", async () => {
    db.setManagerRole(f.guild.id, ids.replacement, 1);
    return f.user;
  });
  assert.equal(await hasClanAccess(f.guild, f.userId), false);
});

test("configured role opens configuration without Manage Server permission", async () => {
  const f = fixture();
  assert.equal(f.user.permissions.has(PermissionFlagsBits.ManageGuild), false);
  assert.equal(await hasConfigAccess(f.guild, f.userId), true);
  await requireConfigAccess(f.guild, f.userId);
  const { i } = await open(f);
  assert.match(i.output.embeds[0].toJSON().title, /configuration/);
  f.user.roles.cache.clear();
  assert.equal(await hasConfigAccess(f.guild, f.userId), false);
  await assert.rejects(requireConfigAccess(f.guild, f.userId), /Manage Server|configured role|configuration|access role/i);
});

test("revoking Manage Server while an access-role change loads blocks the write", async (t) => {
  const f = fixture({ bootstrap: true, manageGuild: true });
  const { id } = await open(f);
  t.mock.method(f.guild.roles, "fetch", async (roleId) => {
    f.permissions.manageGuild = false;
    return f.roles.get(roleId);
  });
  const denied = await action(f, id, "access", "role", [ids.manager]);
  assert.match(error(denied), /Manage Server|configured role|configuration|access role/i);
  assert.equal(db.getGuildSettings(f.guild.id), null);
});

test("configuration role checks reread settings after member lookup", async (t) => {
  const f = fixture();
  t.mock.method(f.guild.members, "fetch", async () => {
    db.setManagerRole(f.guild.id, ids.replacement, 1);
    return f.user;
  });
  assert.equal(await hasConfigAccess(f.guild, f.userId), false);
});

test("changing the configured role during a clan save denies a user who lacks the new role", async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  t.mock.method(f.guild.roles, "fetch", async () => {
    db.setManagerRole(f.guild.id, ids.replacement, 1);
    return f.roles;
  });
  const denied = await action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  assert.match(error(denied), /Manage Server|configured role|configuration|access role/i);
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").sync_interval_mins, 10);
});

test("Manage Server permits configuration saves without holding the configured role", async (t) => {
  const f = fixture({ manageGuild: true });
  f.user.roles.cache.clear();
  const lastSync = "2026-11-01T00:00:00.000Z";
  db.setGuildClanConfig(savedConfig(f, { last_sync_at: lastSync }));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  const fetchMember = f.guild.members.fetch;
  const fetch = t.mock.method(f.guild.members, "fetch", fetchMember);
  const saved = await action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  assert.equal(error(saved), "");
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").sync_interval_mins, 30);
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").last_sync_at, lastSync);
  assert.ok(fetch.mock.calls.every(({ arguments: args }) => args[0]?.user), "interval changes need no full roster");
  assert.equal(await hasClanAccess(f.guild, f.userId), false);
});

test("an in-progress save blocks overlapping actions in the same menu", async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  t.mock.method(f.guild.roles, "fetch", () => new Promise((resolve) => { release = resolve; entered(); }));
  const saving = action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  await started;
  const overlapping = await action(f, id, "new");
  assert.match(error(overlapping), /change is still running/);
  release(f.roles);
  assert.equal(error(await saving), "");
  const afterSave = await action(f, id, "roles");
  assert.equal(error(afterSave), "", "menu lock must be released after save");
});

test("a menu expiring during validation cannot finish a persistent save", async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(f.guild.roles, "fetch", async () => { now += 11 * 60_000; return f.roles; });
  const expired = await action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  assert.match(error(expired), /menu expired/);
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").sync_interval_mins, 10);
});

test("unrelated interactions fall through and closing a menu invalidates its session", async () => {
  assert.equal(await handleConfigInteraction({ isMessageComponent: () => false, isModalSubmit: () => false }), false);
  const f = fixture(), { id } = await open(f);
  const closed = await action(f, id, "close");
  assert.deepEqual(closed.output.components, []);
  const expired = await action(f, id, "new");
  assert.match(error(expired), /menu expired/);
});

for (const report of ['coverage', 'doctor']) {
  for (const change of ['access', 'mapping', 'history', 'expiry']) test(`configuration ${report} withholds a report after ${change} changes during loading`, async t => {
    const f = fixture();
    db.setGuildClanConfig(savedConfig(f));
    const { id } = await open(f);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    db.linkGuildUser(f.guild.id, 'manager', f.userId, 'coverage-race', 'Player');
    t.mock.method(openfrontApi, report === 'coverage' ? 'getPlayerProfile' : 'getClanSessions', async () => {
      if (change === 'access') f.user.roles.cache.clear();
      if (change === 'mapping') db.setGuildClanConfig(savedConfig(f, { member_role_id: ids.replacement }));
      if (change === 'history') db.history.saveSettings(f.guild.id, { ...db.history.getSettings(f.guild.id), player_history_enabled: 0 }, 0);
      if (change === 'expiry') now += 11 * 60_000;
      return report === 'coverage' ? { clans: [] } : { results: [], total: 0, page: 1, limit: 1 };
    });
    const result = await action(f, id, report);
    assert.equal(result.followups.some(value => value.embeds?.length), false, 'obsolete report must not be released');
    assert.match(error(result), /permission|role|settings|configuration|expired/i);
  });
}

for (const change of ['identity', 'departure']) test(`configuration coverage withholds ${change} during final authorization`, async t => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  db.linkGuildUser(f.guild.id, 'manager', f.userId, 'coverage-final-auth', 'Player');
  const { id } = await open(f);
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => ({ clans: [{ tag: 'TEST' }] }));
  const fetch = f.guild.members.fetch;
  let checks = 0;
  t.mock.method(f.guild.members, 'fetch', async request => {
    if (request?.user && ++checks === 2) {
      if (change === 'identity') db.unlinkGuildUser(f.guild.id, 'manager', f.userId);
      else {
        f.guild.members.cache.delete(f.userId);
        db.history.purgeMember(f.guild.id, f.userId);
        db.community.purgeMember(f.guild.id, f.userId);
      }
    }
    return fetch(request);
  });
  const result = await action(f, id, 'coverage');
  assert.equal(result.followups.some(value => value.embeds?.length), false);
  assert.match(error(result), /membership|identit.*changed/i);
});

test("configuration home links focused pages and access saves are explicit", async () => {
  const f = fixture(), { i, id } = await open(f);
  const links = components(i.output).map(c => c.custom_id.split(":").at(-1));
  for (const name of ["clans", "access_page", "history", "diagnostics"]) assert.ok(links.includes(name), name);
  assert.equal(components(i.output).some(c => c.type === 6), false);
  for (const name of ["clans", "access_page", "diagnostics"]) {
    const page = await action(f, id, name);
    assertComponentLimits(page.output);
    assert.ok(components(page.output).some(c => c.label === "Back"));
  }
  const access = await action(f, id, "access_page");
  assert.ok(components(access.output).filter(c => c.type === 6).every(c => /immediately/.test(c.placeholder)));
});

for (const setting of ["history_channel"]) test(`${setting} visibly confirms staged select and clear, and discards a failed redraw`, async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  if (setting === "history_channel") await action(f, id, "history");
  else { await action(f, id, "clan", "string", ["TEST"]); await action(f, id, "logs"); }
  const selected = await action(f, id, setting, "channel", [ids.logs]);
  assert.match(selected.output.embeds[0].toJSON().description, /unsaved/i);
  const failures = [];
  t.mock.method(console, "warn", (...args) => failures.push(args));
  const failed = await action(f, id, setting, "channel", [], {
    editReply: async () => { throw Object.assign(new Error("secret-token https://discord.com/api/webhooks/private"), { code: 50035, requestBody: "private" }); },
  });
  assert.match(error(failed), /try again|unexpected/i);
  const page = await action(f, id, setting === "history_channel" ? "history_collect" : "logs");
  const channel = components(page.output).find(c => c.type === 8);
  assert.equal(channel.default_values[0].id, ids.logs, "failed redraw must not silently clear the draft");
  const cleared = await action(f, id, setting, "channel", []);
  assert.match(cleared.output.embeds[0].toJSON().description, /cleared.*unsaved/i);
  assert.equal(components(cleared.output).find(c => c.type === 8).default_values?.length ?? 0, 0);
  assert.equal(failures.length, 1);
  const diagnostic = failures[0][1];
  assert.equal(diagnostic.action, setting);
  assert.equal(diagnostic.stage, "redraw");
  assert.equal(diagnostic.code, 50035);
  assert.equal(diagnostic.deferred, true);
  assert.doesNotMatch(JSON.stringify(failures), /secret-token|webhooks|requestBody|private/);
});

for (const save of ["log_channel_id", "history_save", "access", "debug_access"]) test(`${save} retains committed session state when redraw fails`, async (t) => {
  const f = fixture({ manageGuild: true });
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  t.mock.method(console, "warn", () => {});
  if (save === "log_channel_id") {
    await action(f, id, "clan", "string", ["TEST"]);
    await action(f, id, "logs");
  } else if (save === "history_save") {
    await action(f, id, "history"); await action(f, id, "history_channel", "channel", [ids.logs]);
  }
  const kind = save.endsWith("access") ? "role" : save === "log_channel_id" ? "channel" : "button";
  const value = save === "log_channel_id" ? ids.logs : ids.replacement;
  const target = save === "history_save" ? db.history : db;
  const method = { log_channel_id: "setGuildClanConfig", history_save: "saveSettings", access: "setManagerRole", debug_access: "setDebugRole" }[save];
  const write = target[method].bind(target);
  let writes = 0;
  t.mock.method(target, method, (...args) => { writes++; return write(...args); });
  const failed = await action(f, id, save, kind, [value], {
    editReply: async () => { throw Object.assign(new Error("invalid payload"), { code: 50035 }); },
  });
  assert.equal(writes, 1, "failed redraw/recovery must not repeat the committed write");
  assert.match(error(failed), /saved.*reopen/i);
  if (save === "log_channel_id") assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").log_channel_id, ids.logs);
  const again = await action(f, id, save, kind, [value]);
  assert.equal(error(again), "", "committed snapshot/revision must survive redraw failure");
  assert.ok(again.output, "busy lock must be released");
});

test("failed acknowledgement logs safe timing, contains recovery failure and releases busy", async (t) => {
  const f = fixture(), { id } = await open(f), failures = [];
  t.mock.method(console, "warn", (...args) => failures.push(args));
  const before = f.calls();
  await assert.doesNotReject(action(f, id, "clans", "button", [], {
    createdTimestamp: Date.now() - 3500,
    deferUpdate: async () => { throw Object.assign(new Error("secret expired"), { code: 10062 }); },
    reply: async () => { throw new Error("secret recovery"); },
  }));
  assert.equal(f.calls(), before, "failed acknowledgement must not fetch access or mutate");
  assert.equal(failures.length, 2);
  assert.equal(failures[0][1].stage, "acknowledgement");
  assert.equal(failures[0][1].code, 10062);
  assert.ok(failures[0][1].interactionAgeMs >= 3500);
  assert.equal(failures[1][1].stage, "recovery");
  assert.doesNotMatch(JSON.stringify(failures), /secret/);
  assert.ok((await action(f, id, "clans")).output);
});

test("config acknowledges before a slow refreshed access check", async () => {
  const f = fixture(), { id } = await open(f), i = component(f, id, "clans");
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async options => { assert.equal(i.deferred, true); return fetch(options); };
  await handleConfigInteraction(i);
  assert.ok(i.output);
});

test("opening config logs safe failure fields and never forwards a raw error to the central event", async t => {
  const f = fixture(), i = command(f), failures = [];
  t.mock.method(console, "warn", (...args) => failures.push(args));
  i.editReply = async () => { throw Object.assign(new Error("secret-token private webhook URL"), { code: 50035 }); };
  await assert.rejects(configCommand.execute(i), error => {
    assert.equal(error.constructor.name, "CommandError");
    assert.doesNotMatch(error.message, /secret-token|webhook/);
    return true;
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0][1].action, "open");
  assert.equal(failures[0][1].stage, "redraw");
  assert.equal(failures[0][1].code, 50035);
  assert.doesNotMatch(JSON.stringify(failures), /secret-token|webhook/);
});
