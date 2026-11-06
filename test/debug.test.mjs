import assert from "node:assert/strict";
import { after, test } from "node:test";
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { debugCommand } = await import("../dist/commands/debug.js");
const { MessageFlags } = await import("discord.js");
const { commandReplyOptions, CommandError } = await import("../dist/commands/support.js");
const { commandErrorMessage } = await import("../dist/commands/errorMessages.js");
const { OpenFrontApiError } = await import("../dist/api.js");
after(() => db.close());
let sequence = 0;
function fixture(action = "export_links", role = true) {
  const id = `debug-${++sequence}`, userId = `actor-${id}`;
  const held = new Map(role ? [["debug-role", true]] : []);
  const members = new Map();
  let afterFetch = () => {};
  const guild = { id, name: "Test server", ownerId: userId, members: { fetch: async (options) => {
    if (options) { assert.equal(options.force, true); return { roles: { cache: held } }; }
    afterFetch(); return members;
  } } };
  db.setDebugRole(id, "debug-role");
  const i = { guild, guildId: id, user: { id: userId }, memberPermissions: { has: () => true },
    inCachedGuild: () => true, options: { getString: () => action, getBoolean: () => null }, attachmentSizeLimit: 8 * 1024 * 1024,
    deferReply: async function (payload) { this.deferredPayload = payload; },
    editReply: async function (payload) { this.output = payload; } };
  return { i, held, members, afterFetch: (fn) => { afterFetch = fn; } };
}
const member = (id) => ({ user: { username: `user-${id}` }, displayName: `Member ${id}` });
test("debug rejects DMs, unconfigured roles, and owners/admins without the debug role", async () => {
  const f = fixture("export_links", false);
  await assert.rejects(debugCommand.execute(f.i), /configured debug role/);
  assert.equal(f.i.output, undefined);
  db.setDebugRole(f.i.guildId, null, 1);
  await assert.rejects(debugCommand.execute(f.i), /Choose a debug role/);
  f.i.inCachedGuild = () => false;
  await assert.rejects(debugCommand.execute(f.i), /in a server/);
});
test("debug export includes only effective links for current members and no credentials", async () => {
  const f = fixture();
  db.linkUser("export-global", "global-id", "Global", "identity_token");
  db.linkUser("export-left", "left-id", "Left", "profile_discord");
  db.linkGuildUser(f.i.guildId, "manager", "export-local", "local-id", "Local");
  db.linkGuildUser("another-server", "manager", "export-other", "other-id", "Other");
  for (const id of ["export-global", "export-local", "export-other", "unlinked"]) f.members.set(id, member(id));
  await debugCommand.execute(f.i);
  assert.equal(f.i.deferredPayload.flags, MessageFlags.Ephemeral);
  const file = f.i.output.files[0];
  const data = JSON.parse(file.attachment.toString("utf8"));
  assert.equal(data.schema_version, 1);
  assert.equal(data.guild.id, f.i.guildId);
  assert.equal(data.member_count, 4);
  assert.equal(data.linked_user_count, 2);
  assert.deepEqual(data.users.map((row) => row.discord_id), ["export-global", "export-local"]);
  assert.deepEqual(data.users.map((row) => row.scope), ["bot_wide", "server"]);
  for (const user of data.users) {
    assert.deepEqual(Object.keys(user).sort(), ["discord_id", "discord_username", "discord_display_name", "openfront_id", "openfront_username", "linked_at", "scope", "verification_method"].sort());
  }
  assert.equal(typeof data.users[0].discord_id, "string");
});
test("revoking debug access during membership fetch blocks data release", async () => {
  const f = fixture();
  f.afterFetch(() => f.held.clear());
  await assert.rejects(debugCommand.execute(f.i), /configured debug role/);
  assert.equal(f.i.output, undefined);
});
test("changing the debug role during member fetch uses the latest setting", async () => {
  const f = fixture();
  f.afterFetch(() => db.setDebugRole(f.i.guildId, "new-role", 1));
  await assert.rejects(debugCommand.execute(f.i), /configured debug role/);
  assert.equal(f.i.output, undefined);
});
test("empty exports are valid and oversized exports fail without sending a partial file", async () => {
  const empty = fixture();
  await debugCommand.execute(empty.i);
  assert.deepEqual(JSON.parse(empty.i.output.files[0].attachment.toString()).users, []);
  const big = fixture(); big.i.attachmentSizeLimit = 1;
  await assert.rejects(debugCommand.execute(big.i), /attachment size limit/);
  assert.equal(big.i.output, undefined);
});
test("membership failures do not generate partial exports", async () => {
  const f = fixture();
  f.afterFetch(() => { throw new Error("Discord unavailable"); });
  await assert.rejects(debugCommand.execute(f.i), /No partial export/);
  assert.equal(f.i.output, undefined);
});
test("debug status stays scoped to this server and uses a private reply", async () => {
  const f = fixture("status"), other = fixture();
  const config = (guildId, tag) => ({ guild_id: guildId, clan_tag: tag, member_role_id: "member",
    officer_role_id: null, leader_role_id: null, join_role_id: null, log_channel_id: null,
    sync_interval_mins: 10, last_sync_at: null });
  db.setGuildClanConfig(config(f.i.guildId, "HERE"));
  db.linkGuildUser(f.i.guildId, "staff", "status-here", "here-player", null);
  f.members.set("status-here", member("status-here"));
  f.members.set("status-unlinked", member("status-unlinked"));
  db.setGuildClanConfig(config(other.i.guildId, "OTHER"));
  db.setGuildClanConfig(config(other.i.guildId, "ELSE"));
  db.linkGuildUser(other.i.guildId, "staff", "status-elsewhere", "elsewhere-player", null);
  db.linkGuildUser(other.i.guildId, "staff", "status-another", "another-player", null);
  // An unrelated server link must not become effective just because its user is present here.
  f.members.set("status-elsewhere", member("status-elsewhere"));
  await debugCommand.execute(f.i);
  assert.equal(f.i.deferredPayload.flags, MessageFlags.Ephemeral);
  assert.match(f.i.output.content, /Current server members: \*\*3\*\*/);
  assert.match(f.i.output.content, /Linked members: \*\*1\*\*/);
  assert.match(f.i.output.content, /Configured clans: \*\*1\*\*/);
  assert.match(f.i.output.content, /Role queue: \*\*1\*\*/);
  assert.equal(f.i.output.files, undefined);
});

test("debug toggles are explicit, server scoped, reversible, and private", async () => {
  const f = fixture("verbose"), other = fixture();
  assert.equal(db.getDebugSettings(f.i.guildId).verbose_errors, 0);
  assert.equal(db.getDebugSettings(f.i.guildId).ephemeral_replies, 1);
  await assert.rejects(debugCommand.execute(f.i), /enabled input/);
  f.i.options.getBoolean = () => true;
  await debugCommand.execute(f.i);
  assert.equal(db.getDebugSettings(f.i.guildId).verbose_errors, 1);
  assert.equal(db.getDebugSettings(other.i.guildId).verbose_errors, 0);
  f.i.options.getString = () => "ephemeral";
  f.i.options.getBoolean = () => false;
  await debugCommand.execute(f.i);
  assert.deepEqual(commandReplyOptions(f.i), {});
  assert.equal(f.i.deferredPayload.flags, MessageFlags.Ephemeral);
  assert.equal(commandReplyOptions(other.i).flags, MessageFlags.Ephemeral);
  assert.equal(commandReplyOptions({ guildId: null }).flags, MessageFlags.Ephemeral);
  f.i.options.getBoolean = () => true;
  await debugCommand.execute(f.i);
  assert.equal(commandReplyOptions(f.i).flags, MessageFlags.Ephemeral);
  assert.throws(() => db.setDebugOptions(f.i.guildId, { verboseErrors: false }, 1), /another session/);
});

test("toggle rechecks debug role after slow initial authorization", async () => {
  const f = fixture("verbose");
  f.i.options.getBoolean = () => true;
  const fetch = f.i.guild.members.fetch;
  let calls = 0;
  f.i.guild.members.fetch = async (options) => {
    if (++calls === 2) f.held.clear();
    return fetch(options);
  };
  await assert.rejects(debugCommand.execute(f.i), /configured debug role/);
  assert.equal(db.getDebugSettings(f.i.guildId).verbose_errors, 0);
});

test("verbose errors explain API, permissions and conflicts without exposing raw exceptions", () => {
  const f = fixture();
  const api = new OpenFrontApiError("http", 429);
  assert.equal(commandErrorMessage(api, f.i.guildId), api.message);
  db.setDebugOptions(f.i.guildId, { verboseErrors: true }, 1);
  assert.match(commandErrorMessage(api, f.i.guildId), /rate limiting/);
  assert.match(commandErrorMessage(new OpenFrontApiError("timeout"), f.i.guildId), /time limit/);
  const permission = Object.assign(new Error("sensitive token and HTTP request body"), { code: 50013 });
  const output = commandErrorMessage(permission, f.i.guildId);
  assert.match(output, /role above/);
  assert.doesNotMatch(output, /sensitive token|HTTP request body|\n\s+at /);
  assert.match(commandErrorMessage(new CommandError("The user input is required."), f.i.guildId), /selected action needs/);
  assert.equal(commandErrorMessage(permission, null), "An unexpected error occurred. Please try again later.");
});

for (const { reason, explanation } of [
  { reason: "busy", explanation: /bot.*request capacity.*full/i },
  { reason: "queue_timeout", explanation: /bot.*wait.*deadline/i },
]) {
  test(`admission error ${reason} explains local capacity only when verbose errors are enabled`, () => {
    const f = fixture();
    const error = new OpenFrontApiError(reason);
    assert.equal(commandErrorMessage(error, f.i.guildId), error.message);
    assert.equal(commandErrorMessage(error, null), error.message);
    db.setDebugOptions(f.i.guildId, { verboseErrors: true }, 1);
    Object.assign(error, { body: "secret-body", token: "secret-token", stack: "secret-stack" });
    const output = commandErrorMessage(error, f.i.guildId);
    assert.ok(output.startsWith(error.message));
    assert.match(output, explanation);
    assert.match(output, /retry/i);
    assert.doesNotMatch(output, /returned data|API format|secret-body|secret-token|secret-stack/);
  });
}
