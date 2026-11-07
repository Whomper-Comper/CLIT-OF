import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { Client, Collection, Events, MessageFlags, ChatInputCommandInteraction, ButtonInteraction,
  ChannelSelectMenuInteraction, StringSelectMenuInteraction, PermissionFlagsBits } from "discord.js";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
let client;
mock.method(Client.prototype, "login", async function () { client = this; return "test"; });
await import("../dist/index.js");
const { db } = await import("../dist/db.js");
const { commandsByName } = await import("../dist/commands/index.js");
const { handleCommunityInteraction } = await import("../dist/community/interactions.js");
const { milestonesCommand } = await import("../dist/commands/milestones.js");
const { defaultBingoObjectives } = await import("../dist/community/bingo.js");
const { communitySessions } = await import("../dist/community/sessions.js");
const route = client.listeners(Events.InteractionCreate)[0];
after(async () => { await client.destroy(); db.close(); mock.restoreAll(); });

test('actual interaction event dispatches saved duel consent through the complete community chain', async () => {
  const guildId = 'router-duel-event';
  try {
    assert.ok(commandsByName.has('duel'));
    const d = db.community.duels.invite({ guildId, channelId: 'duel-channel', messageId: null }, 'challenger', 'opponent', Date.now());
    db.community.duels.bindMessage(guildId, d.id, d.revision, 'duel-message');
    db.community.duels.activate(guildId, d.id, 'duel-channel', 'duel-message', Date.now());
    let memberFetches = 0;
    const i = interaction({ guildId, channelId: 'duel-channel', user: { id: 'opponent' },
      guild: { id: guildId, members: { fetch: async options => {
        memberFetches++;
        assert.deepEqual(options.user, ['challenger', 'opponent']);
        return new Collection(options.user.map(id => [id, { user: { id, bot: false } }]));
      } } },
      message: { id: 'duel-message' }, customId: `clit-duel:${d.id}:accept`,
      async deferReply(payload) { this.deferred = true; this.deferPayload = payload; } });
    await route(i);
    assert.equal(db.community.duels.get(guildId, d.id).status, 'resolved');
    assert.equal(memberFetches, 1);
    assert.equal(i.deferPayload.flags, MessageFlags.Ephemeral);
    assert.equal(i.edits.length, 1);
    assert.equal(i.followups.length, 0);
  } finally { db.community.purgeGuild(guildId); }
});

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

test('persistent community prefixes reject forged saved bindings without changing SQLite', async () => {
  const guildId = 'router-all-prefixes';
  const now = Date.now();
  const event = db.community.events.createDraft({ guildId, channelId: 'saved-channel', creatorId: 'owner',
    title: 'private integration title', description: '', startAt: now + 3600000,
    durationMinutes: 60, capacity: 20, squads: [], reminderMinutes: 0 }, now);
  db.community.events.publish(guildId, event.id, event.revision, 'saved-message');
  const draft = db.community.bingo.createDraft(guildId, 'saved-channel', defaultBingoObjectives(), null, now);
  const board = db.community.bingo.publish(guildId, draft.id, draft.revision, 'saved-message');
  const duel = db.community.duels.invite({ guildId, channelId: 'saved-channel', messageId: null }, 'a', 'b', now);
  db.community.duels.bindMessage(guildId, duel.id, duel.revision, 'saved-message');
  const ids = [`event:${event.id}:join:${event.revision}`, `bingo:${board.id}:claim:${board.revision}`,
    `clit-duel:${duel.id}:accept`];
  const snapshot = () => db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'community_%' ORDER BY name")
    .all().map(({ name }) => [name, db.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
  try {
    const before = snapshot();
    for (const customId of ids) {
      for (const forged of [{ channelId: 'forged-channel' }, { guildId: 'forged-guild', guild: { id: 'forged-guild' } }]) {
        const i = interaction({ guildId, guild: { id: guildId }, channelId: 'saved-channel',
          user: { id: 'owner' }, message: { id: 'saved-message' }, customId,
          isStringSelectMenu: () => false, isChannelSelectMenu: () => false, ...forged });
        await assert.rejects(handleCommunityInteraction(i), /reopen|belong|changed|unavailable|board|binding/i, customId);
        await route(i);
        const response = [...i.replies, ...i.followups, ...i.edits];
        assert.equal(response.length, 1, customId);
        assert.equal(response[0].flags, MessageFlags.Ephemeral, customId);
        assert.doesNotMatch(JSON.stringify(response), /private integration title/);
        assert.deepEqual(snapshot(), before, customId);
      }
    }
  } finally {
    db.community.purgeGuild(guildId);
  }
});

test('each valid private route succeeds before owner, guild, channel and message forgeries are rejected privately', async () => {
  const guildId = 'router-private-valid', now = Date.now();
  const sessions = [];
  const event = db.community.events.createDraft({ guildId, channelId: 'saved-channel', creatorId: 'owner',
    title: 'private integration title', description: '', startAt: now + 3600000,
    durationMinutes: 60, capacity: 20, squads: [], reminderMinutes: 0 }, now);
  const board = db.community.bingo.createDraft(guildId, 'saved-channel', defaultBingoObjectives(), null, now);
  const preset = db.community.wheel.list(guildId)[0];
  db.setManagerRole(guildId, 'manager');
  const member = { id: 'owner', user: { id: 'owner', bot: false },
    roles: { cache: new Collection([['manager', true]]) }, permissions: { has: () => true } };
  const guild = { id: guildId, members: { fetch: async () => member } };
  const fixtures = [
    ['evtmenu', 'event-manage', { eventId: event.id, revision: event.revision }, 'details', 'modal'],
    ['availability', 'availability', { targetId: 'owner', revision: 0, page: 0, selected: null }, 'next', 'update'],
    ['onboarding', 'onboarding-status', { targetId: 'owner', clanTag: 'TEST', page: 0, lastAction: -Infinity, busy: false }, 'refresh', 'edit'],
    ['wheel', 'wheel-editor', { preset, expected: preset.revision, remove: false }, 'basics', 'modal'],
    ['milestones', 'milestones-configure', { draft: db.community.settings.get(guildId), selectedJob: null, page: 0, busy: false }, 'thresholds', 'modal'],
    ['bingomenu', 'bingo-draft', { boardId: board.id, revision: board.revision }, 'edit', 'modal'],
  ];
  const snapshot = () => db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'community_%' ORDER BY name")
    .all().map(({ name }) => [name, db.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
  try {
    for (const [prefix, kind, data, action, output] of fixtures) {
      const s = communitySessions.create({ kind, ownerId: 'owner', guildId, channelId: 'saved-channel',
        messageId: 'saved-message', data }, now);
      sessions.push(s.id);
      const make = (forged = {}) => interaction({ guildId, guild, channelId: 'saved-channel', user: { id: 'owner' },
        message: { id: 'saved-message' }, customId: `${prefix}:${s.id}:${action}`,
        isStringSelectMenu: () => false, isChannelSelectMenu: () => false,
        async deferUpdate() { this.deferred = true; },
        async update(value) { this.updated = value; },
        async showModal(modal) { this.modal = modal.toJSON(); }, ...forged });
      const valid = make();
      assert.equal(await handleCommunityInteraction(valid), true, prefix);
      assert.ok(output === 'modal' ? valid.modal : output === 'update' ? valid.updated : valid.edits.length, prefix);
      const before = snapshot();
      for (const forged of [{ user: { id: 'intruder' } }, { guildId: 'forged-guild', guild: { id: 'forged-guild' } },
        { channelId: 'forged-channel' }, { message: { id: 'forged-message' } }]) {
        await assert.rejects(handleCommunityInteraction(make(forged)), /unavailable|expired|reopen/i, prefix);
        const invalid = make(forged); await route(invalid);
        const response = [...invalid.replies, ...invalid.followups, ...invalid.edits];
        assert.equal(response.length, 1, prefix);
        assert.equal(response[0].flags, MessageFlags.Ephemeral, prefix);
        assert.doesNotMatch(JSON.stringify(response), /private integration title/);
        assert.deepEqual(snapshot(), before, prefix);
      }
    }
  } finally {
    for (const id of sessions) communitySessions.delete(id);
    communitySessions.purgeGuild(guildId);
    db.community.purgeGuild(guildId);
  }
});

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

function bingoControl(guildId) {
  const draft = db.community.bingo.createDraft(guildId, 'router-channel', defaultBingoObjectives(), null, Date.now());
  const board = db.community.bingo.publish(guildId, draft.id, draft.revision, 'router-board');
  return interaction({ guildId, guild: { id: guildId }, channelId: 'router-channel', user: { id: 'router-user' },
    message: { id: 'router-board' }, customId: `bingo:${board.id}:claim:${board.revision}`,
    async showModal(modal) { this.modal = modal; this.replied = true; } });
}

test('community router awaits the unrelated milestones result and reaches a valid bingo claim control', async () => {
  const guildId = 'router-bingo-direct';
  try {
    const i = bingoControl(guildId);
    assert.equal(await milestonesCommand.handleInteraction(i), false);
    assert.equal(await handleCommunityInteraction(i), true);
    assert.match(i.modal.toJSON().custom_id, /^bingomenu:/);
    assert.equal(i.modal.toJSON().components.length, 3);
  } finally { db.community.purgeGuild(guildId); }
});

test('actual interaction event opens bingo controls before legacy routing', async () => {
  const guildId = 'router-bingo-event';
  try {
    const i = bingoControl(guildId);
    await route(i);
    assert.ok(i.modal, 'the actual event route must open the private claim form');
    assert.equal(i.replies.length, 0);
    assert.equal(i.followups.length, 0);
  } finally { db.community.purgeGuild(guildId); }
});

test('milestones controls still resolve true and unrelated legacy prefixes fall through without type probing', async () => {
  const guildId = 'router-milestones';
  const session = communitySessions.create({ kind: 'milestones-configure', ownerId: 'router-user', guildId,
    channelId: 'router-channel', messageId: 'router-private',
    data: { draft: db.community.settings.get(guildId), selectedJob: null, page: 0, busy: false, lastRead: -Infinity } }, Date.now());
  try {
    const i = interaction({ guildId, channelId: 'router-channel', user: { id: 'router-user' },
      guild: { id: guildId, members: { fetch: async () => ({ permissions: { has: () => true } }) } },
      message: { id: 'router-private' }, customId: `milestones:${session.id}:thresholds`,
      async showModal(modal) { this.modal = modal; } });
    assert.equal(await handleCommunityInteraction(i), true);
    assert.match(i.modal.toJSON().custom_id, /^milestones:/);
    assert.equal(await handleCommunityInteraction({ customId: 'whois-stats:legacy' }), false);
    const legacy = interaction();
    await route(legacy);
    assert.equal(legacy.replies.length, 1);
    assert.equal(legacy.replies[0].flags, MessageFlags.Ephemeral);
  } finally {
    communitySessions.delete(session.id);
    db.community.purgeGuild(guildId);
  }
});

test('actual central event routes a saved lobby continuation from a DM',async()=>{
 const guildId='router-lobby-dm',now=Date.now(),s=db.community.lobbies;
 s.configure(guildId,true,'fallback',now);s.watch(guildId,'owner',{name:'World',map:'World'},now);
 const n=s.select(guildId,'owner',{source:'https://blue.openfront.io',id:'a1234567',map:'World',mode:'Team',category:'team',players:12,capacity:100,startsAt:now+60000,restricted:false},now);s.delivered(n.id,'dm','lobby-message',now);
 client.guilds.cache.set(guildId,{id:guildId,members:{fetch:async()=>({id:'owner',user:{bot:false}})}});
 try{
  const i=interaction({client,guildId:null,channelId:'dm',user:{id:'owner'},customId:`lobby:continue:${n.id}`,message:{id:'lobby-message',edit:async()=>{}},deferReply:async function(p){this.deferred=true;this.deferPayload=p;}});
  await route(i);assert.equal(s.search(guildId,'owner').state,'searching');assert.equal(i.edits.length,1);assert.equal(i.deferPayload.flags,MessageFlags.Ephemeral);
 }finally{client.guilds.cache.delete(guildId);db.community.purgeGuild(guildId);}
});

let configSequence = 0;
async function realConfigFixture(t) {
  const n = ++configSequence;
  const guildId = `82000000000000000${n}`, userId = "720000000000000001", channelId = "920000000000000001";
  const roleId = "920000000000000002", selectedChannel = "920000000000000003", changedChannel = "920000000000000004";
  const member = { id: userId, user: { id: userId, bot: false }, roles: { cache: new Collection([[roleId, true]]) }, permissions: { has: () => true } };
  const guild = { id: guildId, ownerId: userId,
    members: { _add: () => member, resolve: () => null, fetch: async options => options ? member : new Collection([[userId, member]]),
      fetchMe: async () => ({ permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } }) },
    roles: { fetch: async id => id ? { id, managed: false } : new Collection([[roleId, { id: roleId, managed: false }]]) },
    channels: { fetch: async id => ({ id, type: 0, permissionsFor: () => ({ has: () => true }) }) } };
  client.guilds.cache.set(guildId, guild);
  t.after(() => client.guilds.cache.delete(guildId));
  db.setManagerRole(guildId, roleId);
  db.setGuildClanConfig({ guild_id: guildId, clan_tag: "TEST", member_role_id: roleId, officer_role_id: null,
    leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
  const responses = [], edits = [], order = [], fail = {};
  const message = body => ({ id: "620000000000000001", channel_id: channelId, guild_id: guildId,
    author: { id: "520000000000000001", username: "bot", discriminator: "0", bot: true },
    content: "", embeds: [], components: [], attachments: [], flags: 64, ...JSON.parse(JSON.stringify(body ?? {})) });
  t.mock.method(client.rest, "request", async () => { throw new Error("Unexpected REST boundary"); });
  t.mock.method(client.rest, "post", async (path, options) => {
    order.push("ack"); responses.push(options.body);
    if (path.endsWith("/callback") && fail.ack) { const error = fail.ack; delete fail.ack; throw error; }
    if (!path.endsWith("/callback") && fail.recovery) { const error = fail.recovery; delete fail.recovery; throw error; }
    return path.endsWith("/callback") ? {} : message(options.body);
  });
  t.mock.method(client.rest, "patch", async (_path, options) => {
    order.push("redraw");
    if (fail.redraw) { const error = fail.redraw; delete fail.redraw; throw error; }
    edits.push(options.body); return message(options.body);
  });
  let serial = 0;
  const raw = (type, data) => ({ id: String((BigInt(Date.now()) - 1420070400000n) * 4194304n + BigInt(++serial)), application_id: "520000000000000001",
    token: "local-test-token", type, version: 1, guild_id: guildId, channel: { id: channelId, type: 0 },
    member: { user: { id: userId, username: "manager", discriminator: "0" }, roles: [roleId], permissions: String(PermissionFlagsBits.ManageGuild) },
    app_permissions: "0", locale: "en-US", guild_locale: "en-US", entitlements: [], authorizing_integration_owners: {}, data,
    ...(type === 3 ? { message: message(edits.at(-1)) } : {}) });
  const slash = new ChatInputCommandInteraction(client, raw(2, { id: "420000000000000001", name: "config", type: 1 }));
  await route(slash);
  assert.equal(slash.deferred, true);
  assert.equal(responses[0].data.flags, 64);
  const custom = action => edits.at(-1).components.flatMap(r => r.components).find(c => c.custom_id?.split(":")[2] === action)?.custom_id;
  const send = async (action, values, explicitId) => {
    const id = explicitId ?? custom(action);
    assert.ok(id, `visible ${action} control`);
    const data = { custom_id: id, component_type: values ? (action === "clan" ? 3 : 8) : 2, ...(values ? { values, resolved: {} } : {}) };
    const Class = values ? (action === "clan" ? StringSelectMenuInteraction : ChannelSelectMenuInteraction) : ButtonInteraction;
    const i = new Class(client, raw(3, data));
    await route(i);
    return i;
  };
  return { guildId, guild, selectedChannel, changedChannel, edits, responses, order, send, custom, fail };
}

test("actual central event saves config channel selections and clears immediately", async t => {
  const f = await realConfigFixture(t);
  await f.send("clans"); await f.send("clan", ["TEST"]); await f.send("logs");
  for (const selected of [f.selectedChannel, f.changedChannel, null]) {
    const i = await f.send("log_channel_id", selected ? [selected] : []);
    assert.ok(i instanceof ChannelSelectMenuInteraction);
    assert.equal(i.deferred, true);
    const body = f.edits.at(-1), select = body.components.flatMap(r => r.components).find(c => c.type === 8);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.match(body.embeds[0].description, /saved/i);
    assert.deepEqual(select.default_values ?? [], selected ? [{ id: selected, type: "channel" }] : []);
    assert.equal(db.getGuildClanConfig(f.guildId, "TEST").log_channel_id, selected);
    assert.equal(f.custom("save"), undefined);
  }
  await f.send("log_channel_id", [f.changedChannel]);
  assert.equal(db.getGuildClanConfig(f.guildId, "TEST").log_channel_id, f.changedChannel);
  assert.match(f.edits.at(-1).embeds[0].description, /Saved/);
  assert.ok(f.responses.slice(1).every(body => body.type === 6), "normal components deferUpdate before redraw");
  assert.deepEqual(f.order.slice(-2), ["ack", "redraw"]);
  await f.send("log_channel_id", []);
  assert.equal(db.getGuildClanConfig(f.guildId, "TEST").log_channel_id, null);
});

test("actual central event serializes real history channel select, change, clear and Save interactions", async t => {
  const f = await realConfigFixture(t);
  await f.send("history");
  for (const selected of [f.selectedChannel, f.changedChannel, null]) {
    await f.send("history_channel", selected ? [selected] : []);
    const body = f.edits.at(-1), select = body.components.flatMap(r => r.components).find(c => c.type === 8);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.match(body.embeds[0].description, /unsaved/i);
    assert.deepEqual(select.default_values ?? [], selected ? [{ id: selected, type: "channel" }] : []);
    assert.equal(db.history.getSettings(f.guildId).channel_id, null);
  }
  await f.send("history_channel", [f.changedChannel]); await f.send("history_save");
  assert.equal(db.history.getSettings(f.guildId).channel_id, f.changedChannel);
  await f.send("history_channel", []); await f.send("history_save");
  assert.equal(db.history.getSettings(f.guildId).channel_id, null);
  assert.equal(db.history.getSettings(f.guildId).weekly_enabled, 0);
});

test("real config redraw rejection preserves the saved edit and contains a failed private recovery", async t => {
  const f = await realConfigFixture(t), failures = [], centralErrors = [];
  t.mock.method(console, "warn", (...args) => failures.push(args));
  t.mock.method(console, "error", (...args) => centralErrors.push(args));
  await f.send("clans"); await f.send("clan", ["TEST"]); await f.send("logs");
  await f.send("log_channel_id", [f.selectedChannel]);
  f.fail.redraw = Object.assign(new Error("secret-token private request"), { code: 50035, requestBody: "secret request" });
  f.fail.recovery = Object.assign(new Error("secret webhook"), { code: 10062 });
  await assert.doesNotReject(f.send("log_channel_id", [f.changedChannel]));
  assert.deepEqual(failures.map(args => [args[1].stage, args[1].code]), [["redraw", 50035], ["recovery", 10062]]);
  assert.doesNotMatch(JSON.stringify(failures), /secret|requestBody|token|webhook/);
  assert.equal(centralErrors.length, 0);
  const recovery = f.responses.at(-1);
  assert.equal(recovery.flags, 64);
  assert.deepEqual(recovery.allowed_mentions, { parse: [] });
  assert.match(recovery.content, /saved.*reopen/i);
  assert.equal(db.getGuildClanConfig(f.guildId, "TEST").log_channel_id, f.changedChannel);
  await f.send("log_channel_id", []);
  assert.equal(db.getGuildClanConfig(f.guildId, "TEST").log_channel_id, null);
});

test("real config acknowledgement expiry stops work and releases the session", async t => {
  const f = await realConfigFixture(t), failures = [];
  t.mock.method(console, "warn", (...args) => failures.push(args));
  const clansId = f.custom("clans"), before = f.edits.length;
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async () => { assert.fail("failed acknowledgement must stop before access fetch"); };
  f.fail.ack = Object.assign(new Error("secret expiry"), { code: 10062 });
  const i = await f.send("clans");
  assert.equal(i.deferred, false);
  assert.equal(f.edits.length, before);
  assert.equal(failures[0][1].stage, "acknowledgement");
  assert.equal(failures[0][1].code, 10062);
  assert.doesNotMatch(JSON.stringify(failures), /secret/);
  assert.equal(f.responses.at(-1).data.flags, 64);
  assert.deepEqual(f.responses.at(-1).data.allowed_mentions, { parse: [] });
  f.guild.members.fetch = fetch;
  await f.send("clans", undefined, clansId);
  assert.match(f.edits.at(-1).embeds[0].title, /Clan configuration/);
});

test("saved clan config report groups mappings, approval/logging and synchronization", async t => {
  const f = await realConfigFixture(t);
  const clan = commandsByName.get("clan"), output = [];
  await clan.execute({ guildId: f.guildId, guild: f.guild, user: { id: "720000000000000001" },
    member: { roles: { cache: new Collection([["920000000000000002", true]]) } }, memberPermissions: { has: () => true },
    inCachedGuild: () => true, options: { getString: key => key === "action" ? "config" : null, getInteger: () => 1 },
    deferReply: async () => {}, editReply: async body => { output.push(body); } }, {});
  const fields = output[0].embeds[0].toJSON().fields;
  assert.deepEqual(fields.map(field => field.name), ["Role mappings", "Approval & logging", "Synchronization"]);
  assert.match(fields[0].value, /Member.*Officer.*Leader/s);
  assert.match(fields[1].value, /Approval.*Logs/s);
  assert.match(fields[2].value, /10 minutes.*Never/s);
});
