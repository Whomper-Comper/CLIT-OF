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
    members: { fetchMe: async () => ({ permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } }),
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
  const i = component(f, id, name, kind, values, overrides);
  assert.equal(await handleConfigInteraction(i), true);
  return i;
}
const error = (i) => i.followups.at(-1)?.content ?? i.output?.content ?? "";
const savedConfig = (f, overrides = {}) => ({ guild_id: f.guild.id, clan_tag: "TEST", member_role_id: ids.member, officer_role_id: null,
  leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null, ...overrides });
function assertComponentLimits(payload) {
  const json = rows(payload);
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
  assert.equal(components(i.output).find((c) => c.type === 3).options.length, 25);
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

test("new clan modal, role selection and save persist a validated mapping", async (t) => {
  const f = fixture(), { id } = await open(f);
  t.mock.method(openfrontApi, "getClanInfo", async () => ({ tag: "TEST", name: "Test", description: "" }));
  await action(f, id, "new");
  const basics = await action(f, id, "basics");
  assert.equal(error(basics), "");
  assert.ok(basics.modal, "a new clan must show a valid tag/interval modal");
  const modal = basics.modal.toJSON();
  assert.equal(modal.components.length, 2);
  await action(f, id, "details", "modal", [], { fields: { getTextInputValue: (key) => key === "tag" ? "test" : "15" } });
  await action(f, id, "roles");
  await action(f, id, "member_role_id", "role", [ids.member]);
  const saved = await action(f, id, "save");
  assert.equal(error(saved), "");
  const current = db.getGuildClanConfig(f.guild.id, "TEST");
  assert.equal(current.member_role_id, ids.member);
  assert.equal(current.sync_interval_mins, 15);
  assert.match(saved.output.embeds[0].toJSON().description, /Saved/);
});

test("saving a clan rejects changes from another session and retains the newer configuration", async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  t.mock.method(openfrontApi, "getClanInfo", async () => ({ tag: "TEST", name: "Test", description: "" }));
  await action(f, id, "clan", "string", ["TEST"]);
  db.setGuildClanConfig(savedConfig(f, { sync_interval_mins: 30 }));
  const stale = await action(f, id, "save");
  assert.match(error(stale), /changed in another session/);
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").sync_interval_mins, 30);
});

test("clan save rechecks member role after slow validation and rejects revoked access", async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  await action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  t.mock.method(openfrontApi, "getClanInfo", async () => { f.user.roles.cache.clear(); return { tag: "TEST", name: "Test", description: "" }; });
  const denied = await action(f, id, "save");
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
  await action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  t.mock.method(openfrontApi, "getClanInfo", async () => {
    db.setManagerRole(f.guild.id, ids.replacement, 1);
    return { tag: "TEST", name: "Test", description: "" };
  });
  const denied = await action(f, id, "save");
  assert.match(error(denied), /Manage Server|configured role|configuration|access role/i);
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").sync_interval_mins, 10);
});

test("Manage Server permits configuration saves without holding the configured role", async (t) => {
  const f = fixture({ manageGuild: true });
  f.user.roles.cache.clear();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  await action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  t.mock.method(openfrontApi, "getClanInfo", async () => ({ tag: "TEST", name: "Test", description: "" }));
  const saved = await action(f, id, "save");
  assert.equal(error(saved), "");
  assert.equal(db.getGuildClanConfig(f.guild.id, "TEST").sync_interval_mins, 30);
  assert.equal(await hasClanAccess(f.guild, f.userId), false);
});

test("an in-progress save blocks overlapping actions in the same menu", async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  t.mock.method(openfrontApi, "getClanInfo", () => new Promise((resolve) => { release = resolve; entered(); }));
  const saving = action(f, id, "save");
  await started;
  const overlapping = await action(f, id, "new");
  assert.match(error(overlapping), /change is still running/);
  release({ tag: "TEST", name: "Test", description: "" });
  assert.equal(error(await saving), "");
  const afterSave = await action(f, id, "roles");
  assert.equal(error(afterSave), "", "menu lock must be released after save");
});

test("a menu expiring during validation cannot finish a persistent save", async (t) => {
  const f = fixture();
  db.setGuildClanConfig(savedConfig(f));
  const { id } = await open(f);
  await action(f, id, "clan", "string", ["TEST"]);
  await action(f, id, "details", "modal", [], { fields: { getTextInputValue: () => "30" } });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(openfrontApi, "getClanInfo", async () => { now += 11 * 60_000; return { tag: "TEST", name: "Test", description: "" }; });
  const expired = await action(f, id, "save");
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
