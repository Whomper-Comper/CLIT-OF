import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { Client, Events, MessageFlags } from "discord.js";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
let client;
mock.method(Client.prototype, "login", async function () { client = this; return "test"; });
await import("../dist/index.js");
const { db } = await import("../dist/db.js");
const { commandsByName } = await import("../dist/commands/index.js");
const route = client.listeners(Events.InteractionCreate)[0];
after(async () => { await client.destroy(); db.close(); mock.restoreAll(); });

function interaction(overrides = {}) {
  return {
    guildId: null, deferred: false, replied: false, replies: [], edits: [], followups: [],
    isMessageComponent: () => true, isModalSubmit: () => false, isButton: () => true,
    isChatInputCommand: () => false, isRepliable: () => true,
    customId: "whois-stats:expired",
    reply: async function (value) { this.replies.push(value); this.replied = true; },
    editReply: async function (value) { this.edits.push(value); },
    followUp: async function (value) { this.followups.push(value); },
    ...overrides,
  };
}

test("expired component reply failures cannot escape the interaction event", async (t) => {
  t.mock.method(console, "error", () => {});
  const i = interaction({ reply: async () => { throw Object.assign(new Error("expired"), { code: 10062 }); } });
  await assert.doesNotReject(route(i));
});

test("component failures after acknowledgment keep the original information and send a private error", async (t) => {
  t.mock.method(console, "error", () => {});
  const i = interaction({ deferred: true, reply: async () => { throw new Error("simulated component failure"); } });
  await assert.doesNotReject(route(i));
  assert.equal(i.edits.length, 0, "a component failure must not erase the source message");
  assert.equal(i.followups.length, 1);
  assert.equal(i.followups[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(i.followups[0].allowedMentions, { parse: [] });
  assert.doesNotMatch(i.followups[0].content, /simulated component failure/);
});

test("a failed private error follow-up is contained too", async (t) => {
  t.mock.method(console, "error", () => {});
  const i = interaction({ deferred: true,
    reply: async () => { throw new Error("component failed"); },
    followUp: async () => { throw new Error("Discord unavailable"); } });
  await assert.doesNotReject(route(i));
  assert.equal(i.edits.length, 0);
});

test("unknown slash commands still return a private actionable error", async () => {
  const i = interaction({ isMessageComponent: () => false, isButton: () => false,
    isChatInputCommand: () => true, commandName: "missing" });
  await route(i);
  assert.equal(i.replies.length, 1);
  assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(i.replies[0].content, /no longer available/);
});

test("deferred slash errors replace their own reply and hide unexpected details", async (t) => {
  t.mock.method(console, "error", () => {});
  const command = commandsByName.get("whois");
  t.mock.method(command, "execute", async () => { throw new Error("private exception detail"); });
  const i = interaction({ deferred: true, isMessageComponent: () => false, isButton: () => false,
    isChatInputCommand: () => true, commandName: "whois" });
  await route(i);
  assert.equal(i.edits.length, 1);
  assert.deepEqual(i.edits[0].embeds, []);
  assert.deepEqual(i.edits[0].components, []);
  assert.doesNotMatch(i.edits[0].content, /private exception detail/);
});
