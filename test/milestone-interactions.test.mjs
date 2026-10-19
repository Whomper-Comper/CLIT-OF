import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { milestoneFixture, enable, profile } from './helpers/milestones.mjs';
import { createMilestonesCommand } from '../dist/commands/milestones.js';
import { CommunitySessions } from '../dist/community/sessions.js';

function command(f) {
  return createMilestonesCommand({ db: f.db, api: f.api, now: f.now, sessions: new CommunitySessions() });
}
function interaction(f, sub, user = 'u') {
  return { guild: f.guild, guildId: 'g', channelId: 'c', user: { id: user },
    options: { getSubcommand: () => sub },
    async deferReply(p) { this.deferred = p; },
    async editReply(p) { this.output = p; return { id: 'm' }; },
  };
}
function click(f, customId, extra = {}) {
  return { ...interaction(f, '', 'manager'), customId, message: { id: 'm' },
    isButton: () => true, isChannelSelectMenu: () => false,
    isStringSelectMenu: () => false, isModalSubmit: () => false,
    async deferUpdate() {}, ...extra };
}
function control(i, label) {
  return i.output.components.flatMap(r => r.components).find(b => b.data.label === label).data.custom_id;
}
test('announcement settings default to disabled with approved thresholds', async () => {
  const f = milestoneFixture();
  try {
    assert.deepEqual(f.db.community.settings.get('g'), { guildId: 'g', revision: 0,
      milestonesEnabled: false, milestoneChannelId: null,
      gameThresholds: ['10', '50', '100', '250', '500'], winThresholds: ['1', '10', '25', '50', '100'] });
  } finally { await f.close(); }
});
test('view is private, silently baselines earned awards and displays upcoming and unavailable counters', async () => {
  const f = milestoneFixture();
  try {
    f.api.getPlayerProfile = async () => profile('51', '2');
    let i = interaction(f, 'view');
    await command(f).execute(i);
    assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
    assert.match(JSON.stringify(i.output), /Earned.*10.*50/);
    assert.match(JSON.stringify(i.output), /Upcoming/);
    assert.equal(f.db.community.deliveries.list('g').length, 0);
    f.api.getPlayerProfile = async () => ({ clans: [{ tag: 'MARS' }], stats: null });
    i = interaction(f, 'view');
    await command(f).execute(i);
    assert.match(JSON.stringify(i.output), /unavailable/i);
    assert.match(JSON.stringify(i.output), /50/);
    assert.equal(f.calls.sends.length, 0);
  } finally { await f.close(); }
});
test('configuration requires fresh config access, original binding, valid channel and current revision', async () => {
  const f = milestoneFixture();
  try {
    const c = command(f);
    await assert.rejects(c.execute(interaction(f, 'configure')), /config|Manage Server/i);
    const i = interaction(f, 'configure', 'manager');
    await c.execute(i);
    assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
    const save = control(i, 'Save');
    await assert.rejects(c.handleInteraction(click(f, save, { channelId: 'wrong' })), /reopen/i);
    f.setRoles('manager', []);
    await assert.rejects(c.handleInteraction(click(f, save)), /config|Manage Server/i);
    f.setRoles('manager', ['manager']);
    enable(f);
    await assert.rejects(c.handleInteraction(click(f, save)), /changed|reopen/i);
    assert.equal(f.db.community.settings.get('g').revision, 1);
  } finally { await f.close(); }
});
test('Save rechecks config access after destination lookup and rejects inaccessible channels', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const c = command(f), i = interaction(f, 'configure', 'manager');
    await c.execute(i);
    f.channel.permissionsFor = () => ({ has: () => false });
    await assert.rejects(c.handleInteraction(click(f, control(i, 'Save'))), /channel|permission/i);
    f.channel.permissionsFor = () => ({ has: () => true });
    f.guild.channels.fetch = async () => { f.setRoles('manager', []); return f.channel; };
    await assert.rejects(c.handleInteraction(click(f, control(i, 'Save'))), /config|Manage Server/i);
    assert.equal(f.db.community.settings.get('g').revision, 1);
  } finally { await f.close(); }
});
test('view rejects stale identity and does not treat an approval role as clan membership', async () => {
  const f = milestoneFixture();
  try {
    f.api.getPlayerProfile = async () => profile('51', '2', []);
    const i = interaction(f, 'view');
    await command(f).execute(i);
    assert.match(JSON.stringify(i.output), /unavailable|clan/i);
    assert.equal(f.db.community.milestones.getState('g', 'player').counters, null);
    f.api.getPlayerProfile = async () => {
      f.db.linkGuildUser('g', 'admin', 'u', 'new', null);
      return profile('51', '2');
    };
    await assert.rejects(command(f).execute(interaction(f, 'view')), /changed|reopen/i);
  } finally { await f.close(); }
});
test('private sessions expire, bind owner and ignore legacy routes before type checks', async () => {
  const f = milestoneFixture();
  try {
    const c = command(f), i = interaction(f, 'configure', 'manager');
    await c.execute(i);
    const save = control(i, 'Save');
    await assert.rejects(c.handleInteraction(click(f, save, { user: { id: 'u' } })), /reopen/i);
    f.advance(600001);
    await assert.rejects(c.handleInteraction(click(f, save)), /expired|reopen/i);
    assert.equal(await c.handleInteraction({ customId: 'legacy:x', isButton() { throw Error('wrong route'); } }), false);
  } finally { await f.close(); }
});

test('configuration permits empty thresholds and deliberately retries paused diagnostics', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const job = f.db.community.deliveries.enqueue({ key: 'paused', guildId: 'g', channelId: 'c', kind: 'milestone',
      subjectId: 'intent', revision: 1, dueAt: f.now(), part: 0 });
    const claimed = f.db.community.deliveries.claim(f.now(), 1)[0];
    f.db.community.deliveries.fail(job.id, claimed.leaseId, 'paused', 'Missing permission', f.now());
    const c = command(f), i = interaction(f, 'configure', 'manager');
    await c.execute(i);
    assert.match(JSON.stringify(i.output), /Missing permission/);
    const select = i.output.components.flatMap(r => r.components).find(b => b.data.custom_id.endsWith(':job'));
    const picked = click(f, select.data.custom_id, { isButton: () => false, isStringSelectMenu: () => true, values: [job.id] });
    await c.handleInteraction(picked);
    await c.handleInteraction(click(f, control(picked, 'Retry / reconcile')));
    assert.equal(f.db.community.deliveries.get(job.id).status, 'pending');
    const thresholds = control(i, 'Thresholds').replace(':thresholds', ':thresholds_submit');
    await c.handleInteraction(click(f, thresholds, { isButton: () => false, isModalSubmit: () => true,
      fields: { getTextInputValue: () => '' } }));
    await c.handleInteraction(click(f, control(i, 'Save')));
    const settings = f.db.community.settings.get('g');
    assert.deepEqual(settings.gameThresholds, []);
    assert.deepEqual(settings.winThresholds, []);
    assert.equal(f.db.community.deliveries.get(job.id).status, 'cancelled');
  } finally { await f.close(); }
});
test('command registry exposes server-only milestones and rejects DMs', async () => {
  const { commands } = await import('../dist/commands/index.js');
  const entry = commands.find(c => c.data.name === 'milestones');
  assert.deepEqual(entry.data.toJSON().contexts, [0]);
  const f = milestoneFixture();
  try {
    await assert.rejects(command(f).execute({ ...interaction(f, 'view'), guild: null, guildId: null }), /server/i);
  } finally { await f.close(); }
});

test('Save rejects a forged non-text destination even if it exposes text sending', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const c = command(f), i = interaction(f, 'configure', 'manager');
    await c.execute(i);
    f.channel.type = 2;
    await assert.rejects(c.handleInteraction(click(f, control(i, 'Save'))), /text|announcement/i);
    assert.equal(f.db.community.settings.get('g').revision, 1);
  } finally { await f.close(); }
});

test('threshold editor opens a valid Discord modal and retains the settings draft', async () => {
  const f = milestoneFixture();
  try {
    const c = command(f), i = interaction(f, 'configure', 'manager');
    await c.execute(i);
    const input = click(f, control(i, 'Thresholds'), {
      async showModal(modal) { this.modal = modal.toJSON(); },
    });
    await c.handleInteraction(input);
    assert.equal(input.modal.components.length, 2);
    assert.match(input.modal.components[0].components[0].value, /10, 50, 100/);
  } finally { await f.close(); }
});

test('slow private profile evidence never persists a new observation', async () => {
  const f = milestoneFixture();
  try {
    f.api.getPlayerProfile = async () => { f.advance(60001); return profile('51', '2'); };
    const i = interaction(f, 'view');
    await command(f).execute(i);
    assert.match(JSON.stringify(i.output), /unavailable/i);
    assert.equal(f.db.community.milestones.getState('g', 'player').counters, null);
  } finally { await f.close(); }
});
test('large exact threshold lists remain within Discord private view text limits', async () => {
  const f = milestoneFixture();
  try {
    const values = Array.from({ length: 10 }, (_, n) => `${n + 1}${'0'.repeat(54)}`);
    f.db.community.settings.save('g', { ...f.db.community.settings.get('g'), gameThresholds: values, winThresholds: values }, 0);
    const i = interaction(f, 'view');
    await command(f).execute(i);
    const output = i.output.embeds[0].toJSON();
    assert.ok(output.fields.every(field => field.value.length <= 1024));
    assert.ok(JSON.stringify(output).includes(values[9]));
  } finally { await f.close(); }
});
