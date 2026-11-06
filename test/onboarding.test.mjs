import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageFlags } from 'discord.js';
import { communityFixture, legacyCommandOptions } from './helpers/community.mjs';
const domain = await import('../dist/community/onboarding.js');
const commands = await import('../dist/commands/onboarding.js');
const { CommunitySessions } = await import('../dist/community/sessions.js');
function config(f, tag = 'MARS') {
  f.db.setGuildClanConfig({
    guild_id: 'g',
    clan_tag: tag,
    member_role_id: 'member',
    officer_role_id: 'officer',
    leader_role_id: null,
    join_role_id: 'approval',
    log_channel_id: null,
    sync_interval_mins: 10,
    last_sync_at: null
  });
}
function setup() {
  const f = communityFixture();
  config(f);
  f.addMember('u', ['approval']);
  f.db.linkGuildUser('g', 'admin', 'u', 'player', null);
  f.api.getPlayerProfile = async (id, options) => {
    f.calls.requests.push([id, options]);
    return { createdAt: '2020-01-01T00:00:00Z', clans: [] };
  };
  return f;
}
function enroll(f, id = 'u') {
  f.db.community.onboarding.enroll('g', id, 'MARS', f.now());
}
const status = f => domain.buildOnboardingStatus(f.guild, 'u', 'MARS', f.db, f.api, f.now());
const step = (s, key) => s.steps.find(s => s.key === key);
function availability(f) {
  f.db.community.availability.save({
    guildId: 'g',
    discordId: 'u',
    timezone: 'UTC',
    windows: [{
      id: 'w',
      weekday: 0,
      startMinute: 600,
      endMinute: 660
    }]
  }, 0, f.now());
}
function event(f, extra = {}) {
  const s = f.db.community.events;
  const e = s.createDraft({
    guildId: 'g',
    channelId: 'c',
    creatorId: 'officer',
    title: 'Play',
    description: '',
    startAt: f.now() + 3600000,
    durationMinutes: 60,
    capacity: 1,
    squads: [],
    reminderMinutes: 0,
    ...extra
  }, f.now());
  return s.publish('g', e.id, e.revision, 'm');
}
function interaction(f, sub, values = {}, user = 'u') {
  return {
    guild: f.guild,
    guildId: 'g',
    channelId: 'c',
    user: { id: user },
    options: legacyCommandOptions(sub, values),
    async deferReply(p) {
      this.deferred = p;
    },
    async editReply(p) {
      this.output = p;
      return { id: 'm' };
    }
  };
}
function click(f, id, user = 'officer', extra = {}) {
  return {
    guild: f.guild,
    guildId: 'g',
    channelId: 'c',
    user: { id: user },
    message: { id: 'm' },
    customId: id,
    isButton: () => true,
    async deferUpdate() {
      this.deferred = true;
    },
    async editReply(p) {
      this.output = p;
      return { id: 'm' };
    },
    ...extra
  };
}
const button = (i, name) => i.output.components.flatMap(r => r.components).find(b => b.data.label === name).data.custom_id;
function command(f) {
  return commands.createOnboardingCommand({
    db: f.db,
    api: f.api,
    now: f.now,
    sessions: new CommunitySessions()
  });
}
test('onboarding derives Waiting from approval and labels server-only links; fresh membership completes clan', async () => {
  const f = setup();
  try {
    enroll(f);
    let s = await status(f);
    assert.equal(step(s, 'clan').state, 'waiting');
    assert.match(step(s, 'link').detail, /server.only/i);
    assert.match(s.nextStep, /invit|clan/i);
    assert.deepEqual(f.calls.requests, [['player', { fresh: true }]]);
    f.api.getPlayerProfile = async () => ({ clans: [{ tag: 'mars' }] });
    s = await status(f);
    assert.equal(step(s, 'clan').state, 'complete');
    f.setRoles('u', []);
    f.api.getPlayerProfile = async () => ({ clans: [] });
    assert.equal(step(await status(f), 'clan').state, 'incomplete');
  } finally {
    await f.close();
  }
});
test('API failure or missing clan data is Unknown and never fabricates membership', async () => {
  const f = setup();
  try {
    for (const response of [null, {}, new Error('offline')]) {
      f.api.getPlayerProfile = async () => {
        if (response instanceof Error)
          throw response;
        return response;
      };
      assert.equal(step(await status(f), 'clan').state, 'unknown');
    }
  } finally {
    await f.close();
  }
});
test('in-flight identity replacement, unlink, same-account reverify, deletion and departure reject stale results', async () => {
  for (const mutate of [f => f.db.linkGuildUser('g', 'admin', 'u', 'new', null), f => f.db.unlinkUser('u'), f => f.db.linkGuildUser('g', 'admin', 'u', 'player', null), f => f.db.history.purgePlayer('player'), f => f.db.community.purgeMember('g', 'u')]) {
    const f = setup();
    try {
      enroll(f);
      f.api.getPlayerProfile = async () => {
        mutate(f);
        return { clans: [{ tag: 'MARS' }] };
      };
      await assert.rejects(status(f), /changed|reopen|deleted/i);
      assert.equal(f.db.community.onboarding.list('g')[0]?.completedAt ?? null, null);
    } finally {
      await f.close();
    }
  }
});
test('confirmed signups count beyond UI cap, retained past counts and reserve/cancelled/withdrawn/expired do not', async () => {
  const f = setup();
  try {
    const s = f.db.community.events;
    for (let n = 0; n < 105; n++)
      event(f, { startAt: f.now() + 7200000 + n * 60000 });
    const e = event(f);
    s.join('g', e.id, 'other', null, f.now());
    s.join('g', e.id, 'u', null, f.now());
    assert.equal(step(await status(f), 'event').state, 'incomplete');
    s.withdraw('g', e.id, 'other', new Set(['u']), f.now());
    assert.equal(step(await status(f), 'event').state, 'complete');
    f.advance(7200000);
    assert.equal(step(await status(f), 'event').state, 'complete');
    f.advance(91 * 86400000);
    assert.equal(step(await status(f), 'event').state, 'incomplete');
  } finally {
    await f.close();
  }
  const g = setup();
  try {
    const e = event(g);
    const s = g.db.community.events;
    s.join('g', e.id, 'u', null, g.now());
    s.withdraw('g', e.id, 'u', new Set(['u']), g.now());
    assert.equal(step(await status(g), 'event').state, 'incomplete');
    s.join('g', e.id, 'u', null, g.now());
    s.cancel('g', e.id, e.revision, g.now());
    assert.equal(step(await status(g), 'event').state, 'incomplete');
  } finally {
    await g.close();
  }
});
test('completion is derived again after availability clear, unlink and account cleanup; departure/guild cleanup removes enrollment', async () => {
  const f = setup();
  try {
    enroll(f);
    availability(f);
    const e = event(f);
    f.db.community.events.join('g', e.id, 'u', null, f.now());
    f.api.getPlayerProfile = async () => ({ clans: [{ tag: 'MARS' }] });
    assert.equal((await status(f)).nextStep, null);
    assert.equal(f.db.community.onboarding.list('g')[0].completedAt, f.now());
    f.db.community.availability.clear('g', 'u');
    assert.equal(step(await status(f), 'availability').state, 'incomplete');
    assert.equal(f.db.community.onboarding.list('g')[0].completedAt, null);
    f.db.community.onboarding.markCompletion('g', 'u', true, f.now());
    f.db.unlinkUser('u');
    assert.equal(f.db.community.onboarding.list('g')[0].completedAt, null);
    assert.equal(step(await status(f), 'link').state, 'incomplete');
    f.db.community.purgeMember('g', 'u');
    assert.deepEqual(f.db.community.onboarding.list('g'), []);
    enroll(f);
    f.db.community.purgeGuild('g');
    assert.deepEqual(f.db.community.onboarding.list('g'), []);
  } finally {
    await f.close();
  }
});
test('status requires explicit clan choice with multiple clans and selected-member details require officer access', async () => {
  const f = setup();
  try {
    config(f, 'MOON');
    const c = command(f);
    await assert.rejects(c.execute(interaction(f, 'status')), /choose|select|clan/i);
    const i = interaction(f, 'status', { clan: 'MARS' });
    await c.execute(i);
    assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
    assert.equal(f.db.community.onboarding.list('g')[0].clanTag, 'MARS');
    f.addMember('other');
    await assert.rejects(c.execute(interaction(f, 'status', { clan: 'MARS', user: { id: 'other' } })), /officer|manager/i);
    assert.equal(f.db.community.onboarding.list('g').length, 1);
  } finally {
    await f.close();
  }
});
test('officer queue is private, pages ten current enrollees and never fetches unlinked profiles', async () => {
  const f = setup();
  try {
    f.addMember('officer', ['officer']);
    for (let n = 0; n < 23; n++) {
      const id = `member${String(n).padStart(2, '0')}`;
      f.addMember(id);
      if (n % 2 === 0)
        f.db.linkGuildUser('g', 'admin', id, `player${n}`, null);
      enroll(f, id);
    }
    enroll(f, 'departed');
    const c = command(f);
    const i = interaction(f, 'queue', {}, 'officer');
    await c.execute(i);
    assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
    assert.equal(i.output.embeds[0].data.fields.length, 10);
    assert.match(i.output.embeds[0].data.footer.text, /1\/3/);
    assert.equal(f.calls.requests.length, 5);
    assert.ok(f.calls.requests.every(([id]) => /^player\d+$/.test(id)));
    assert.equal(f.calls.memberFetches.length, 3);
    const next = click(f, button(i, 'Next'));
    await c.handleInteraction(next);
    assert.equal(next.output.embeds[0].data.fields.length, 10);
    assert.equal(f.calls.requests.length, 10);
    await assert.rejects(c.handleInteraction(click(f, button(next, 'Next'))), /wait/i);
    f.advance(10001);
    f.setRoles('officer', []);
    await assert.rejects(c.handleInteraction(click(f, button(next, 'Next'))), /officer|manager/i);
    assert.equal(f.calls.requests.length, 10);
  } finally {
    await f.close();
  }
});
test('queue rechecks roles and identity after async profiles before releasing private results', async () => {
  const f = setup();
  try {
    enroll(f);
    f.addMember('officer', ['officer']);
    f.api.getPlayerProfile = async () => {
      f.setRoles('officer', []);
      return { clans: [{ tag: 'MARS' }] };
    };
    const i = interaction(f, 'queue', {}, 'officer');
    await assert.rejects(command(f).execute(i), /officer|manager/i);
    assert.equal(i.output, undefined);
  } finally {
    await f.close();
  }
});
test('private Refresh binds owner/channel/message/expiry and clears stale completion after data removal', async () => {
  const f = setup();
  try {
    const c = command(f);
    const i = interaction(f, 'status');
    await c.execute(i);
    const id = button(i, 'Refresh');
    for (const extra of [{ user: { id: 'other' } }, { channelId: 'other' }, { message: { id: 'other' } }])
      await assert.rejects(c.handleInteraction(click(f, id, 'u', extra)), /reopen/i);
    f.advance(10001);
    const fresh = click(f, id, 'u');
    await c.handleInteraction(fresh);
    assert.match(JSON.stringify(fresh.output), /availability/);
    f.advance(600000);
    await assert.rejects(c.handleInteraction(click(f, id, 'u')), /expired|reopen/i);
    assert.equal(await c.handleInteraction({
      customId: 'legacy:x', isButton: () => {
        throw Error('wrong route');
      }
    }), false);
  } finally {
    await f.close();
  }
});
test('queue final refresh targets only ten displayed members plus officer and caps linked profile reads at ten', async () => {
  const f = setup();
  try {
    f.addMember('officer', ['officer']);
    for (let n = 0; n < 31; n++) {
      const id = `linked${String(n).padStart(2, '0')}`;
      f.addMember(id);
      f.db.linkGuildUser('g', 'admin', id, `account${n}`, null);
      enroll(f, id);
    }
    const i = interaction(f, 'queue', {}, 'officer');
    await command(f).execute(i);
    assert.equal(f.calls.requests.length, 10);
    assert.deepEqual(f.calls.memberFetches[2], { user: ['linked00', 'linked01', 'linked02', 'linked03', 'linked04', 'linked05', 'linked06', 'linked07', 'linked08', 'linked09', 'officer'], withPresences: false });
    assert.equal(i.output.embeds[0].data.fields.length, 10);
  } finally {
    await f.close();
  }
});
test('changing clan mapping during profile resolution uses fresh approval role instead of stale approval', async () => {
  const f = setup();
  try {
    f.api.getPlayerProfile = async () => {
      const c = f.db.getGuildClanConfig('g', 'MARS');
      f.db.setGuildClanConfig({ ...c, join_role_id: 'new-approval' });
      return { clans: [] };
    };
    assert.equal(step(await status(f), 'clan').state, 'incomplete');
  } finally {
    await f.close();
  }
});
test('queue detects earlier-row account changes while a later profile is awaiting and releases no stale page', async () => {
  const f = setup();
  try {
    f.addMember('officer', ['officer']);
    for (const id of ['a', 'b']) {
      f.addMember(id);
      f.db.linkGuildUser('g', 'admin', id, `p${id}`, null);
      enroll(f, id);
    }
    f.api.getPlayerProfile = async (id) => {
      if (id === 'pb')
        f.db.linkGuildUser('g', 'admin', 'a', 'replaced', null);
      return { clans: [{ tag: 'MARS' }] };
    };
    const i = interaction(f, 'queue', {}, 'officer');
    await assert.rejects(command(f).execute(i), /changed|reopen/i);
    assert.equal(i.output, undefined);
  } finally {
    await f.close();
  }
});
test('self Refresh rejects enrollment recreation during profile response and unlinked users perform no profile read', async () => {
  const f = setup();
  try {
    const c = command(f);
    const i = interaction(f, 'status');
    await c.execute(i);
    f.api.getPlayerProfile = async () => {
      f.db.community.purgeMember('g', 'u');
      enroll(f);
      return { clans: [{ tag: 'MARS' }] };
    };
    f.advance(10001);
    await assert.rejects(c.handleInteraction(click(f, button(i, 'Refresh'), 'u')), /changed|reopen/i);
    f.db.unlinkUser('u');
    f.calls.requests.length = 0;
    const s = await status(f);
    assert.equal(step(s, 'link').state, 'incomplete');
    assert.equal(f.calls.requests.length, 0);
  } finally {
    await f.close();
  }
});
test('guild removal during private profile resolution invalidates the response', async () => {
  const f = setup();
  try {
    const c = command(f);
    const i = interaction(f, 'status');
    await c.execute(i);
    f.api.getPlayerProfile = async () => {
      f.db.community.purgeGuild('g');
      return { clans: [{ tag: 'MARS' }] };
    };
    await assert.rejects(c.handleInteraction(click(f, button(i, 'Refresh'), 'u')), /changed|reopen|expired/i);
    assert.deepEqual(f.db.community.onboarding.list('g'), []);
  } finally {
    await f.close();
  }
});
test('officer inspection Refresh denies revoked access before any new profile lookup', async () => {
  const f = setup();
  try {
    f.addMember('officer', ['officer']);
    const c = command(f);
    const i = interaction(f, 'status', { user: { id: 'u' } }, 'officer');
    await c.execute(i);
    assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
    assert.deepEqual(f.db.community.onboarding.list('g'), []);
    const reads = f.calls.requests.length;
    f.setRoles('officer', []);
    await assert.rejects(c.handleInteraction(click(f, button(i, 'Refresh'), 'officer')), /officer|manager/i);
    assert.equal(f.calls.requests.length, reads);
  } finally {
    await f.close();
  }
});
test('enrollment preserves first date and completion on same clan, switches reset progress, and same-account reverify preserves a valid marker', async () => {
  const f = setup();
  try {
    enroll(f);
    availability(f);
    const e = event(f);
    f.db.community.events.join('g', e.id, 'u', null, f.now());
    f.api.getPlayerProfile = async () => ({ clans: [{ tag: 'MARS' }] });
    await status(f);
    const first = f.db.community.onboarding.list('g')[0];
    f.advance(1000);
    enroll(f);
    assert.deepEqual(f.db.community.onboarding.list('g')[0], first);
    f.db.linkGuildUser('g', 'admin', 'u', 'player', null);
    assert.equal(f.db.community.onboarding.list('g')[0].completedAt, first.completedAt);
    f.db.history.purgePlayer('player');
    assert.equal(f.db.community.onboarding.list('g')[0].completedAt, null);
    f.db.community.onboarding.enroll('g', 'u', 'MOON', f.now());
    assert.deepEqual(f.db.community.onboarding.list('g')[0], {
      discordId: 'u',
      clanTag: 'MOON',
      enrolledAt: f.now(),
      completedAt: null
    });
  } finally {
    await f.close();
  }
});
test('command registry exposes server-only onboarding and rejects DMs before accessing guild state', async () => {
  const { commands: registry } = await import('../dist/commands/index.js');
  const entry = registry.find(c => c.data.name === 'onboarding');
  assert.ok(entry);
  assert.deepEqual(entry.data.toJSON().contexts, [0]);
  const f = setup();
  try {
    await assert.rejects(command(f).execute({
      ...interaction(f, 'status'),
      guild: null,
      guildId: null
    }), /server/i);
  } finally {
    await f.close();
  }
});
test('signup checklist query searches the member index and event primary key rather than scanning events', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { CommunityStore } = await import('../dist/community/store.js');
  const { EventStore } = await import('../dist/community/events.js');
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql);
    let query = '';
    const store = new EventStore({
      prepare(text) {
        query = text;
        return sql.prepare(text);
      }
    });
    assert.equal(store.hasConfirmedSignup('g', 'u', 1000000), false);
    const plan = sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all('g', 'u', 1000000 - 90 * 86400000).map(r => r.detail).join('\n');
    assert.match(plan, /SEARCH s USING INDEX community_signup_member \(guild_id=\? AND discord_id=\?\)/);
    assert.match(plan, /SEARCH e USING INDEX sqlite_autoindex_community_events_1/);
    assert.doesNotMatch(plan, /SCAN (e|community_events)/);
  } finally {
    sql.close();
  }
});
test('inspecting a different configured clan cannot set or clear completion for the enrolled clan', async () => {
  const f = setup();
  try {
    config(f, 'MOON');
    enroll(f);
    availability(f);
    const e = event(f);
    f.db.community.events.join('g', e.id, 'u', null, f.now());
    f.api.getPlayerProfile = async () => ({ clans: [{ tag: 'MOON' }] });
    await domain.buildOnboardingStatus(f.guild, 'u', 'MOON', f.db, f.api, f.now());
    assert.equal(f.db.community.onboarding.list('g')[0].completedAt, null);
    f.api.getPlayerProfile = async () => ({ clans: [{ tag: 'MARS' }] });
    await status(f);
    const completed = f.db.community.onboarding.list('g')[0].completedAt;
    assert.equal(completed, f.now());
    await domain.buildOnboardingStatus(f.guild, 'u', 'MOON', f.db, f.api, f.now());
    assert.equal(f.db.community.onboarding.list('g')[0].completedAt, completed);
  } finally {
    await f.close();
  }
});
