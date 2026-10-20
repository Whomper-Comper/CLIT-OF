import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder,
  InteractionContextType, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type Interaction,
} from 'discord.js';
import { db as defaultDatabase, type BotDatabase } from '../db.js';
import { openfrontApi, type OpenFrontApi } from '../api.js';
import { requireConfigAccess } from '../access.js';
import { CommandError, privateReply, profileLink } from './support.js';
import { CommunitySessions, communitySessions, type PrivateCommunitySession } from '../community/sessions.js';
import type { CommunitySettings } from '../community/settings.js';
import { milestoneBinding, milestoneClanEligible, milestoneHealth, milestoneIdentityCurrent } from '../community/milestoneWorker.js';
import { readMilestoneCounters, validateMilestoneThresholds } from '../community/milestoneCounters.js';
import { CommandLimits } from '../queues.js';

interface Menu {
  draft: CommunitySettings;
  selectedJob: string | null;
  page: number;
  busy: boolean;
}
interface Dependencies { db?: BotDatabase; api?: OpenFrontApi; now?: () => number; sessions?: CommunitySessions }
type Component = Extract<Interaction, { customId: string }>;
const changed = () => new CommandError('Milestone identity or settings changed. Reopen /milestones view.');
export function createMilestonesCommand(dependencies: Dependencies = {}) {
  const db = dependencies.db ?? defaultDatabase;
  const api = dependencies.api ?? openfrontApi;
  const now = dependencies.now ?? Date.now;
  const sessions = dependencies.sessions ?? communitySessions;
  // Share the foreground gate across every private menu; retain no profile or eligibility cache.
  const readLimits = new CommandLimits(400);
  const readsInFlight = new Set<string>();
  const button = (s: PrivateCommunitySession, action: string, text: string, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`milestones:${s.id}:${action}`).setLabel(text).setStyle(style);
  function get(i: Component, id: string): PrivateCommunitySession {
    const s = sessions.get(id, i.user.id, {
      guildId: i.guildId!, channelId: i.channelId!, messageId: i.message?.id ?? null,
    }, now());
    if (!['milestones-view', 'milestones-configure'].includes(s.kind)) throw changed();
    return s;
  }
  function config(s: PrivateCommunitySession) {
    const data = s.data as Menu;
    const settings = data.draft;
    const { jobs, hasNext } = db.community.deliveries.diagnosticsPage(s.guildId, 'milestone', data.page);
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Milestone announcements · Private')
      .setDescription('Changes remain drafts until Save. Earned milestones remain available when announcements are off.')
      .addFields(
        { name: 'Announcements', value: settings.milestonesEnabled ? 'Enabled' : 'Disabled', inline: true },
        { name: 'Destination', value: settings.milestoneChannelId ? `<#${settings.milestoneChannelId}>` : 'Not selected', inline: true },
        { name: 'Games thresholds', value: settings.gameThresholds.join(', ') || 'None', inline: true },
        { name: 'Wins thresholds', value: settings.winThresholds.join(', ') || 'None', inline: true },
        { name: 'Delivery diagnostics', value: jobs
          .map(j => `${j.id} · ${j.status}: ${j.lastError ?? 'Review required'}`).join('\n').slice(0, 1024) || 'No failed deliveries on this page.' },
      ).setFooter({ text: `Private menu · 10 minutes · Revision ${settings.revision} · Diagnostics page ${data.page + 1}` });
    const channel = new ChannelSelectMenuBuilder().setCustomId(`milestones:${s.id}:channel`)
      .setPlaceholder('Announcement channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(0).setMaxValues(1);
    if (settings.milestoneChannelId) channel.setDefaultChannels(settings.milestoneChannelId);
    const components: ActionRowBuilder<any>[] = [
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channel),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(s, 'toggle', settings.milestonesEnabled ? 'Disable announcements' : 'Enable announcements'),
        button(s, 'thresholds', 'Thresholds'), button(s, 'save', 'Save', ButtonStyle.Primary),
        button(s, 'refresh', 'Refresh'),
      ),
    ];
    if (jobs.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`milestones:${s.id}:job`).setPlaceholder('Choose a delivery to retry / reconcile')
        .addOptions(jobs.map(j => ({ label: `${j.status} · ${j.id}`, value: j.id }))),
    ));
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(s, 'previous', 'Previous').setDisabled(data.page === 0),
      button(s, 'next', 'Next').setDisabled(!hasNext),
      button(s, 'retry', 'Retry / reconcile').setDisabled(!data.selectedJob),
    ));
    return { embeds: [embed], components, allowedMentions: { parse: [] as never[] } };
  }
  async function view(i: ChatInputCommandInteraction | Component, s: PrivateCommunitySession, refresh: boolean) {
    sessions.get(s.id, i.user.id, { guildId: s.guildId, channelId: s.channelId, messageId: s.messageId }, now());
    const binding = milestoneBinding(db, s.guildId, i.user.id);
    if (!binding || !milestoneIdentityCurrent(db, binding)) throw new CommandError('Link your current OpenFront account with /link before viewing milestones.');
    const settings = db.community.settings.get(s.guildId);
    const data = s.data as Menu;
    let available = false;
    const readKeys = [`member:${i.user.id}`, `account:${binding.publicId}`];
    if (refresh && milestoneHealth(db, now()) && readsInFlight.size <= 398 &&
      readKeys.every(key => !readsInFlight.has(key)) &&
      readKeys.every(key => readLimits.take(key, 10_000, now()))) {
      for (const key of readKeys) readsInFlight.add(key);
      try {
        const before = await i.guild!.members.fetch({ user: i.user.id, force: true });
        if (before.user.bot || !milestoneIdentityCurrent(db, binding)) throw changed();
        const generation = db.community.milestones.prepareObservation(binding, now());
        const fetchedAt = now();
        let profile = null;
        try { profile = await api.getPlayerProfile(binding.publicId, { fresh: true }); } catch { /* Keep durable earned cards visible. */ }
        const member = await i.guild!.members.fetch({ user: i.user.id, force: true });
        sessions.get(s.id, i.user.id, { guildId: s.guildId, channelId: s.channelId, messageId: s.messageId }, now());
        if (member.user.bot || !milestoneIdentityCurrent(db, binding) ||
          db.community.settings.get(s.guildId).revision !== settings.revision ||
          db.community.milestones.candidateGeneration(binding) !== generation) throw changed();
        const counters = readMilestoneCounters(profile?.stats);
        if (counters && now() >= fetchedAt && now() - fetchedAt <= 60_000 &&
          milestoneHealth(db, now()) && milestoneClanEligible(db, s.guildId, profile)) {
          db.community.milestones.observe(binding, counters,
            { games: settings.gameThresholds, wins: settings.winThresholds }, now(), generation, settings.revision);
          available = true;
        }
      } finally {
        for (const key of readKeys) readsInFlight.delete(key);
      }
    }
    if (!milestoneIdentityCurrent(db, binding)) throw changed();
    const state = db.community.milestones.getState(s.guildId, binding.publicId);
    const awards = db.community.milestones.listAwards(s.guildId, binding.publicId);
    const earnedText = awards.map(a => `${a.metric}: **${a.threshold}** · Observed ${a.total} <t:${Math.floor(a.observedAt / 1000)}:f>`)
      .join('\n') || 'No earned milestones yet.';
    // Bound both per-field and combined embed text without rounding or discarding long exact values.
    const pages = Math.max(1, Math.ceil(earnedText.length / 3000));
    data.page = Math.max(0, Math.min(data.page, pages - 1));
    const earnedPage = earnedText.slice(data.page * 3000, (data.page + 1) * 3000);
    const fields = [];
    for (let offset = 0; offset < earnedPage.length; offset += 1000) {
      fields.push({ name: offset ? 'Earned · continued' : 'Earned', value: earnedPage.slice(offset, offset + 1000) });
    }
    for (const metric of ['games', 'wins'] as const) {
      const thresholds = metric === 'games' ? settings.gameThresholds : settings.winThresholds;
      fields.push({ name: `Upcoming · ${metric}`, value: thresholds.filter(t => !state.earned.has(`${metric}:${t}`)).join(', ') || 'None' });
    }
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Your milestones · Private')
      .setDescription(`${profileLink(binding.publicId)}\n${available ? 'Current public Team counters observed.' : 'Current counters unavailable; showing saved earned milestones.'}`)
      .addFields(fields)
      .setFooter({ text: `Page ${data.page + 1}/${pages} · Initial and newly configured thresholds initialize quietly · Private menu expires in 10 minutes` });
    return { embeds: [embed], allowedMentions: { parse: [] as never[] }, components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(s, 'previous', 'Previous').setDisabled(data.page === 0),
        button(s, 'next', 'Next').setDisabled(data.page + 1 >= pages), button(s, 'refresh', 'Refresh'),
      ),
    ] };
  }
  async function validateDestination(i: Component, data: Menu) {
    if (!data.draft.milestoneChannelId) return;
    const channel = await i.guild!.channels.fetch(data.draft.milestoneChannelId);
    if (!channel || channel.guildId !== i.guildId ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
      !channel.isTextBased() || channel.isDMBased() ||
      channel.isThread() || !('send' in channel)) throw new CommandError('Choose a server text or announcement channel.');
    const me = i.guild!.members.me ?? await i.guild!.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) {
      throw new CommandError('The announcement channel requires View Channel, Send Messages, Embed Links and Read Message History permissions.');
    }
  }
  return {
    data: new SlashCommandBuilder().setName('milestones').setDescription('View earned milestones or configure announcements')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand(s => s.setName('view').setDescription('Your private earned and upcoming milestones'))
      .addSubcommand(s => s.setName('configure').setDescription('Private announcement settings and delivery recovery')),
    async execute(i: ChatInputCommandInteraction): Promise<void> {
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError('Use milestones in a server.');
      await i.deferReply(privateReply);
      const configuring = i.options.getSubcommand() === 'configure';
      if (configuring) await requireConfigAccess(i.guild, i.user.id, db);
      const s = sessions.create({ kind: configuring ? 'milestones-configure' : 'milestones-view', ownerId: i.user.id,
        guildId: i.guildId, channelId: i.channelId, messageId: null,
        data: { draft: db.community.settings.get(i.guildId), selectedJob: null, page: 0, busy: false } satisfies Menu }, now());
      const payload = configuring ? config(s) : await view(i, s, true);
      const message = await i.editReply(payload);
      sessions.bind(s.id, message.id);
    },
    async handleInteraction(i: Interaction): Promise<boolean> {
      if (!('customId' in i) || !i.customId.startsWith('milestones:')) return false;
      if (!i.isButton() && !i.isChannelSelectMenu() && !i.isStringSelectMenu() && !i.isModalSubmit()) return false;
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError('Use milestones in a server.');
      const [, id, action] = i.customId.split(':');
      const s = get(i, id);
      const data = s.data as Menu;
      if (data.busy) throw new CommandError('Please wait for the current milestone action.');
      data.busy = true;
      try {
        if (s.kind === 'milestones-configure') {
          if (action === 'thresholds' && i.isButton()) {
            await requireConfigAccess(i.guild, i.user.id, db);
            get(i, id);
            const modal = new ModalBuilder().setCustomId(`milestones:${s.id}:thresholds_submit`).setTitle('Milestone thresholds');
            for (const [key, title, values] of [['games', 'Games', data.draft.gameThresholds], ['wins', 'Wins', data.draft.winThresholds]] as const) {
              modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
                .setCustomId(key).setLabel(`${title}: ascending integers; blank disables`)
                .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(600).setValue(values.join(', '))));
            }
            await i.showModal(modal);
            return true;
          }
          await i.deferUpdate();
          await requireConfigAccess(i.guild, i.user.id, db);
          get(i, id);
          if (action === 'toggle' && i.isButton()) data.draft.milestonesEnabled = !data.draft.milestonesEnabled;
          else if (action === 'channel' && i.isChannelSelectMenu()) data.draft.milestoneChannelId = i.values[0] ?? null;
          else if (action === 'thresholds_submit' && i.isModalSubmit()) {
            const parse = (key: string) => i.fields.getTextInputValue(key).trim().split(/[\s,]+/).filter(Boolean);
            const thresholds = { games: parse('games'), wins: parse('wins') };
            validateMilestoneThresholds(thresholds);
            data.draft.gameThresholds = thresholds.games;
            data.draft.winThresholds = thresholds.wins;
          } else if (action === 'save' && i.isButton()) {
            await validateDestination(i, data);
            await requireConfigAccess(i.guild, i.user.id, db);
            get(i, id);
            data.draft = db.community.settings.save(s.guildId, data.draft, data.draft.revision);
          } else if (action === 'refresh' && i.isButton()) {
            data.draft = db.community.settings.get(s.guildId);
            data.selectedJob = null;
          } else if (action === 'job' && i.isStringSelectMenu()) data.selectedJob = i.values[0];
          else if (action === 'retry' && i.isButton()) {
            const job = data.selectedJob ? db.community.deliveries.get(data.selectedJob) : null;
            const settings = db.community.settings.get(s.guildId);
            if (!job || job.guildId !== s.guildId || job.kind !== 'milestone' || job.revision !== settings.revision ||
              !settings.milestonesEnabled || job.channelId !== settings.milestoneChannelId) throw new CommandError('This delivery changed. Refresh the settings menu.');
            await requireConfigAccess(i.guild, i.user.id, db);
            get(i, id);
            db.community.deliveries.retry(s.guildId, job.id, job.revision, now());
          } else if (action === 'next' && i.isButton()) data.page++;
          else if (action === 'previous' && i.isButton()) data.page = Math.max(0, data.page - 1);
          else throw new CommandError('Reopen /milestones configure.');
          // No await separates the final access check/mutation above from this private render.
          get(i, id);
          await i.editReply(config(s));
        } else {
          if (!i.isButton() || !['next', 'previous', 'refresh'].includes(action)) throw changed();
          await i.deferUpdate();
          if (action === 'next') data.page++;
          if (action === 'previous') data.page--;
          await i.editReply(await view(i, s, action === 'refresh'));
        }
      } finally { data.busy = false; }
      return true;
    },
  };
}
export const milestonesCommand = createMilestonesCommand();
