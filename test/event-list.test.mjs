import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageFlags } from 'discord.js';
import { communityFixture } from './helpers/community.mjs';
const { createEventCommand } = await import('../dist/commands/event.js');

const draft = (f, extra = {}) => ({ guildId: 'g', channelId: 'c', creatorId: 'u', title: 'Team night',
  description: 'Play', startAt: f.now() + 3600000, durationMinutes: 120, capacity: 2,
  squads: [], reminderMinutes: 0, ...extra });
function interaction(f, page = null) {
  return { guild: f.guild, guildId: 'g', channelId: 'c', user: { id: 'u' },
    options: { getSubcommand: () => 'list', getInteger: () => page },
    async deferReply(payload) { this.deferred = payload; },
    async editReply(payload) { this.output = payload; return { id: 'private' }; } };
}
function publish(f, extra) {
  const s = f.db.community.events, e = s.createDraft(draft(f, extra), f.now());
  return s.publish(e.guildId, e.id, 1, 'public');
}

test('event list reads only ten published payloads per page while preserving its capped order and private reply', async () => {
  const f = communityFixture();
  try {
    const command = createEventCommand({ db: f.db, now: f.now }), store = f.db.community.events;
    const published = [];
    for (let n = 0; n < 106; n++) published.push(publish(f, { title: 'Published ' + n, startAt: f.now() + 3600000 + (n % 3) }));
    for (let n = 0; n < 105; n++) store.createDraft(draft(f, { title: 'Hidden draft', startAt: f.now() + 7200000 + n }), f.now());
    publish(f, { guildId: 'other', title: 'Other server', startAt: f.now() + 10800000 });
    const expected = published.sort((a, b) => b.startAt - a.startAt || a.id.localeCompare(b.id)).slice(0, 100).map(e => e.id);
    const sql = f.db.db, prepare = sql.prepare.bind(sql);
    let returned = 0, decoded = 0, queries = [];
    sql.prepare = query => {
      const statement = prepare(query);
      return new Proxy(statement, { get(target, key) {
        if ((key === 'all' || key === 'get') && /FROM community_events\b/.test(query)) return (...args) => {
          const result = target[key](...args), rows = key === 'all' ? result : result ? [result] : [];
          queries.push({ query, args, rows: rows.length });
          const tracked = rows.map(row => {
            if (!Object.hasOwn(row, 'data')) return row;
            returned++;
            return new Proxy(row, { get(value, field) { if (field === 'data') decoded++; return value[field]; } });
          });
          return key === 'all' ? tracked : tracked[0];
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    for (const page of [1, 10]) {
      returned = 0; decoded = 0; queries = [];
      const i = interaction(f, page); await command.execute(i);
      const embed = i.output.embeds[0].toJSON();
      assert.deepEqual([...embed.description.matchAll(/\/event view id:([^\s]+)/g)].map(m => m[1]),
        expected.slice((page - 1) * 10, page * 10));
      assert.equal(embed.footer.text, 'Page ' + page + '/10');
      assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
      assert.equal(i.output.components, undefined);
      assert.doesNotMatch(embed.description, /Hidden draft|Other server/);
      assert.equal(returned, 10, 'Only the ten displayed event payloads should cross the SQLite boundary');
      assert.equal(decoded, 10, 'Only the ten displayed event payloads should be decoded');
      assert.ok(queries.every(q => q.rows <= 10));
      assert.ok(queries.every(q => prepare('EXPLAIN QUERY PLAN ' + q.query).all(...q.args)
        .some(row => /USING.*INDEX/.test(row.detail))));
    }
    returned = 0; decoded = 0;
    await assert.rejects(command.execute(interaction(f, 11)), /existing event page/i);
    assert.equal(returned, 0); assert.equal(decoded, 0);
  } finally { await f.close(); }
});

test('event list preserves empty and partial final pages and rejects unavailable pages', async () => {
  const f = communityFixture();
  try {
    const command = createEventCommand({ db: f.db, now: f.now });
    const empty = interaction(f); await command.execute(empty);
    assert.equal(empty.output.embeds[0].toJSON().description, 'No published events yet.');
    assert.equal(empty.output.embeds[0].toJSON().footer.text, 'Page 1/1');
    await assert.rejects(command.execute(interaction(f, 2)), /existing event page/i);
    for (let n = 0; n < 11; n++) publish(f, { title: 'Published ' + n, startAt: f.now() + 3600000 + n });
    const last = interaction(f, 2); await command.execute(last);
    assert.equal(last.output.embeds[0].toJSON().description.match(/\/event view/g).length, 1);
    assert.equal(last.output.embeds[0].toJSON().footer.text, 'Page 2/2');
    await assert.rejects(command.execute(interaction(f, 3)), /existing event page/i);
  } finally { await f.close(); }
});
