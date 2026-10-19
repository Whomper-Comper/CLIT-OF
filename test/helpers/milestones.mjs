import { communityFixture } from './community.mjs';

export const profile = (games = '9', wins = '0', clans = [{ tag: 'MARS' }]) => ({
  clans,
  stats: { Public: { Team: { Easy: { total: games, wins, losses: '0' } } } },
});
export function milestoneFixture() {
  const f = communityFixture();
  f.db.setGuildClanConfig({ guild_id: 'g', clan_tag: 'MARS', member_role_id: 'member',
    officer_role_id: null, leader_role_id: null, join_role_id: 'approval',
    log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
  f.addMember('u', ['approval']);
  f.addMember('manager', ['manager']);
  f.db.setManagerRole('g', 'manager');
  f.db.linkGuildUser('g', 'admin', 'u', 'player', null);
  f.db.history.setMeta('deletions_last_success', new Date(f.now()).toISOString());
  f.api.getPlayerProfile = async (id, options) => {
    f.calls.requests.push([id, options]);
    return profile();
  };
  f.channel.isThread = () => false;
  f.channel.type = 0;
  f.channel.isDMBased = () => false;
  f.channel.isSendable = () => true;
  f.channel.permissionsFor = () => ({ has: () => true });
  f.guild.members.me = { id: 'bot' };
  return f;
}
export function enable(f, guildId = 'g', channelId = 'c') {
  return f.db.community.settings.save(guildId, {
    milestonesEnabled: true, milestoneChannelId: channelId,
    gameThresholds: ['10', '50'], winThresholds: ['1'],
  }, 0);
}
export function binding(f, guildId = 'g', discordId = 'u') {
  const link = f.db.getEffectiveLink(guildId, discordId);
  return { guildId, discordId, publicId: link.openfront_id, linkedAt: link.linked_at };
}
