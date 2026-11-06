import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, SlashCommandBuilder, type ChatInputCommandInteraction, type Interaction } from 'discord.js';
import { db as defaultDatabase, type BotDatabase } from '../db.js';
import { openfrontApi, type OpenFrontApi } from '../api.js';
import { CommandError, label, privateReply } from './support.js';
import { CommandLimits } from '../queues.js';
import { hasCommunityOfficerRole, requireCommunityOfficer } from '../community/access.js';
import { communitySessions, type CommunitySessions, type PrivateCommunitySession } from '../community/sessions.js';
import { prepareOnboardingStatus, type OnboardingStatus } from '../community/onboarding.js';
import { actionOption, commandAction, type CommandActions } from './actions.js';

const ACTIONS = {
  status: { optional: ['clan', 'user'] },
  queue: { optional: ['page'] },
} satisfies CommandActions;
interface Menu {
  targetId: string;
  clanTag: string;
  page: number;
  lastAction: number;
  busy: boolean;
}
interface Dependencies {
  db?: BotDatabase;
  api?: OpenFrontApi;
  now?: () => number;
  sessions?: CommunitySessions;
}
const titles = {
  link: '1 · Link account',
  clan: '2 · Join clan',
  availability: '3 · Save availability',
  event: '4 · Join an event'
};
export function createOnboardingCommand(dependencies: Dependencies = {}) {
  const db = dependencies.db ?? defaultDatabase;
  const api = dependencies.api ?? openfrontApi;
  const now = dependencies.now ?? Date.now;
  const sessions = dependencies.sessions ?? communitySessions;
  const limits = new CommandLimits();
  function controls(session: PrivateCommunitySession, pages = 1) {
    const data = session.data as Menu;
    const row = new ActionRowBuilder<ButtonBuilder>();
    if (session.kind === 'onboarding-queue')
      for (const [action, text, disabled] of [['previous', 'Previous', data.page === 0], ['next', 'Next', data.page >= pages - 1]] as const)
        row.addComponents(new ButtonBuilder().setCustomId(`onboarding:${session.id}:${action}`).setLabel(text).setStyle(ButtonStyle.Secondary).setDisabled(disabled));
    row.addComponents(new ButtonBuilder().setCustomId(`onboarding:${session.id}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Primary));
    return [row];
  }
  function details(status: OnboardingStatus, targetId: string, tag: string) {
    return new EmbedBuilder().setColor(0x5865f2).setTitle('Newcomer checklist · Private').setDescription(`Member: ${label(targetId)} · Clan: ${label(tag)}`)
      .addFields(...status.steps.map(s => ({ name: `${titles[s.key]} · ${s.state}`, value: s.detail })))
      .setFooter({ text: status.nextStep ?? 'All four steps complete · Signup does not prove attendance' });
  }
  async function render(i: ChatInputCommandInteraction | Extract<Interaction, {
    customId: string;
  }>, session: PrivateCommunitySession) {
    if (!i.guild)
      throw new CommandError('Use onboarding in a server.');
    const data = session.data as Menu;
    const queue = session.kind === 'onboarding-queue';
    const privileged = queue || data.targetId !== i.user.id;
    if (queue) {
      const roster = await i.guild.members.fetch({ withPresences: false });
      const page = db.community.onboarding.page(i.guild.id, [...roster.values()].filter(m => !m.user.bot).map(m => m.id), data.page);
      const finish = await Promise.all(page.entries.map(e => prepareOnboardingStatus(i.guild!.id, e.discordId, e.clanTag, db, api, now())));
      const current = await i.guild.members.fetch({ user: [...new Set([...page.entries.map(e => e.discordId), i.user.id])], withPresences: false });
      const officer = current.get(i.user.id);
      if (!officer || !hasCommunityOfficerRole(i.guild.id, officer, db))
        throw new CommandError('You need the configured manager, officer, or leader role for this community action.');
      // Revalidate the session after all network requests, including lifecycle cleanup and expiry.
      sessions.get(session.id, i.user.id, {
        guildId: i.guild.id,
        channelId: i.channelId!,
        messageId: session.messageId
      }, now());
      const statuses = finish.map((finalize, n) => finalize(current.get(page.entries[n].discordId)));
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Newcomer follow-up queue · Private').setDescription('Enrolled current members · Open /onboarding action:status user:… for private details.');
      embed.addFields(...statuses.map((s, n) => ({ name: `${label(page.entries[n].discordId)} · ${label(page.entries[n].clanTag)}`, value: s.nextStep ?? 'Complete · Confirmed signup is not attendance.' })));
      if (!statuses.length)
        embed.setDescription('No current members are enrolled. Members enroll with /onboarding action:status.');
      embed.setFooter({ text: `Page ${data.page + 1}/${page.pages} · 10 members per page · Private menu expires in 10 minutes` });
      return {
        embeds: [embed],
        components: controls(session, page.pages),
        allowedMentions: { parse: [] as never[] }
      };
    }
    const finish = await prepareOnboardingStatus(i.guild.id, data.targetId, data.clanTag, db, api, now());
    const roster = privileged ? await i.guild.members.fetch({ user: [...new Set([data.targetId, i.user.id])], withPresences: false }) : null;
    if (roster) {
      const officer = roster.get(i.user.id);
      if (!officer || !hasCommunityOfficerRole(i.guild.id, officer, db))
        throw new CommandError('You need the configured manager, officer, or leader role for this community action.');
    }
    const member = roster ? roster.get(data.targetId) : await i.guild.members.fetch({ user: data.targetId, force: true });
    sessions.get(session.id, i.user.id, {
      guildId: i.guild.id,
      channelId: i.channelId!,
      messageId: session.messageId
    }, now());
    return {
      embeds: [details(finish(member), data.targetId, data.clanTag)],
      components: controls(session),
      allowedMentions: { parse: [] as never[] }
    };
  }
  return {
    data: new SlashCommandBuilder().setName('onboarding').setDescription('Follow newcomer steps or privately review the officer queue').setContexts(InteractionContextType.Guild)
      .addStringOption(actionOption(ACTIONS))
      .addStringOption(o => o.setName('clan').setDescription('Status: configured clan tag; required if more than one is configured').setMaxLength(32))
      .addUserOption(o => o.setName('user').setDescription('Status: member to inspect (officers only)'))
      .addIntegerOption(o => o.setName('page').setDescription('Queue: page number').setMinValue(1)),

    async execute(i: ChatInputCommandInteraction): Promise<void> {
      if (!i.guild || !i.guildId || !i.channelId)
        throw new CommandError('Use onboarding in a server.');
      const queue = commandAction(i.options, ACTIONS) === 'queue';
      const targetId = queue ? i.user.id : i.options.getUser('user')?.id ?? i.user.id;
      if (queue || targetId !== i.user.id)
        await requireCommunityOfficer(i.guild, i.user.id, db);
      let clanTag = '';
      if (!queue) {
        const configs = db.getGuildConfigs(i.guildId);
        const requested = i.options.getString('clan')?.trim().toUpperCase();
        if (!requested && configs.length !== 1)
          throw new CommandError('Choose a configured clan explicitly with the clan option.');
        clanTag = requested ?? configs[0].clan_tag;
        if (!configs.some(c => c.clan_tag === clanTag))
          throw new CommandError('Choose a configured clan tag.');
      }
      if (!limits.take(`${i.guildId}:${i.user.id}`, 10000, now()))
        throw new CommandError('Please wait a few seconds before trying that command again.');
      await i.deferReply(privateReply);
      if (!queue && targetId === i.user.id) {
        const member = await i.guild.members.fetch({ user: targetId, force: true });
        if (member.user.bot)
          throw new CommandError('Only current human members can enroll.');
        db.community.onboarding.enroll(i.guildId, targetId, clanTag, now());
      }
      const session = sessions.create({
        kind: queue ? 'onboarding-queue' : 'onboarding-status',
        ownerId: i.user.id,
        guildId: i.guildId,
        channelId: i.channelId,
        messageId: null,

        data: {
          targetId,
          clanTag,
          page: queue ? (i.options.getInteger('page') ?? 1) - 1 : 0,
          lastAction: -Infinity,
          busy: false
        } satisfies Menu
      }, now());
      const message = await i.editReply(await render(i, session));
      sessions.bind(session.id, message.id);
    },

    async handleInteraction(i: Interaction): Promise<boolean> {
      if (!('customId' in i) || !i.customId.startsWith('onboarding:'))
        return false;
      if (!i.isButton())
        return false;
      if (!i.guild || !i.guildId || !i.channelId)
        throw new CommandError('Use onboarding in a server.');
      const [, id, action] = i.customId.split(':');
      const session = sessions.get(id, i.user.id, {
        guildId: i.guildId,
        channelId: i.channelId,
        messageId: i.message.id
      }, now());
      if (!['onboarding-queue', 'onboarding-status'].includes(session.kind) || !['previous', 'next', 'refresh'].includes(action) ||
        (session.kind === 'onboarding-status' && action !== 'refresh'))
        throw new CommandError('Reopen /onboarding action:status or queue.');
      const data = session.data as Menu;
      if (data.busy || now() - data.lastAction < 10000)
        throw new CommandError('Please wait a few seconds before refreshing or changing pages.');
      const previous = data.page;
      data.busy = true;
      data.lastAction = now();
      try {
        if (session.kind === 'onboarding-queue' || data.targetId !== i.user.id)
          await requireCommunityOfficer(i.guild, i.user.id, db);
        if (action === 'next')
          data.page++;
        else if (action === 'previous')
          data.page = Math.max(0, data.page - 1);
        await i.deferUpdate();
        await i.editReply(await render(i, session));
      } catch (error) {
        data.page = previous;
        throw error;
      } finally {
        data.busy = false;
      }
      return true;
    },
  };
}
export const onboardingCommand = createOnboardingCommand();
