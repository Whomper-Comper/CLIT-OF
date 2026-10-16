import assert from "node:assert/strict";
import { after, test } from "node:test";
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { debugCommand } = await import("../dist/commands/debug.js");
const { MessageFlags } = await import("discord.js");
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
    inCachedGuild: () => true, options: { getString: () => action }, attachmentSizeLimit: 8 * 1024 * 1024,
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
  assert.deepEqual(Object.keys(data.users[0]).sort(), ["discord_id", "discord_username", "discord_display_name", "openfront_id", "openfront_username", "linked_at", "scope", "verification_method"].sort());
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
  const f = fixture("status");
  await debugCommand.execute(f.i);
  assert.equal(f.i.deferredPayload.flags, MessageFlags.Ephemeral);
  assert.match(f.i.output.content, /Linked members: \*\*0\*\*/);
  assert.match(f.i.output.content, /Role queue: \*\*0\*\*/);
  assert.equal(f.i.output.files, undefined);
});
