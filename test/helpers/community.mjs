import { Collection, CommandInteractionOptionResolver } from 'discord.js';
process.env.DB_PATH = ':memory:';
process.env.DISCORD_TOKEN = 'test';
process.env.CLIENT_ID = 'test';
const { BotDatabase } = await import('../../dist/db.js');

/** Real Discord option parsing for commands registered before the action-choice transition. */
export function legacyCommandOptions(action, values = {}) {
  const options = Object.entries(values).filter(([, value]) => value != null).map(([name, value]) => {
    if (name === 'user' || name === 'channel') {
      const resolved = typeof value === 'object' ? value : { id: value };
      return { name, type: name === 'user' ? 6 : 7, value: resolved.id, [name]: resolved };
    }
    return { name, value, type: typeof value === 'boolean' ? 5 : typeof value === 'number' ? 4 : 3 };
  });
  return new CommandInteractionOptionResolver(null, [{ name: action, type: 1, options }], {});
}

// Only Discord/API boundaries are fake; stores and worker transitions use real SQLite.
export function communityFixture() {
  const db = new BotDatabase(':memory:');
  let time = Date.UTC(2026, 9, 18, 12);
  const calls = { requests: [], sends: [], edits: [], memberFetches: [] };
  const members = new Collection(), messages = new Collection(), services = [];
  const channel = { id: 'c', guildId: 'g', isTextBased: () => true,
    messages: { fetch: async (input) => typeof input === 'string' ? messages.get(input) : messages },
    send: async (payload) => {
      calls.sends.push(payload);
      const message = { id: `message-${calls.sends.length}`, author: { id: 'bot' }, content: payload.content ?? '', embeds: payload.embeds,
        edit: async (payload) => { calls.edits.push(payload); return message; } };
      messages.set(message.id, message);
      return message;
    } };
  const guild = { id: 'g', channels: { fetch: async () => channel }, members: {
    fetch: async (options) => {
      calls.memberFetches.push(options);
      if (!options || (typeof options === 'object' && !('user' in options))) return members;
      const id = typeof options === 'string' ? options : options.user;
      if (Array.isArray(id)) return new Collection([...members].filter(([key]) => id.includes(key)));
      if (!members.has(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      return members.get(id);
    } } };
  const client = { user: { id: 'bot' }, guilds: { cache: new Collection([['g', guild]]) }, channels: { fetch: async () => channel } };
  const api = { getPlayer: async (...args) => { calls.requests.push(args); return null; } };
  return { db, client, guild, api, channel, messages, calls, now: () => time,
    advance: (ms) => { time += ms; }, services,
    addMember(id, roles = [], bot = false) { const member = { id, user: { id, bot }, roles: { cache: new Collection(roles.map(role => [role, true])) }, permissions: { has: () => false } }; members.set(id, member); return member; },
    setRoles(id, roles) { members.get(id).roles.cache = new Collection(roles.map(role => [role, true])); },
    async close() { for (const service of services) await service.stop(); db.close(); } };
}
