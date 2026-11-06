import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, ModalBuilder, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, type ChatInputCommandInteraction, type Interaction } from "discord.js";
import { db as defaultDatabase, type BotDatabase } from "../db.js";
import { CommandError, privateReply } from "./support.js";
import { assertCommunityBinding, hasCommunityOfficerRole, requireCommunityOfficer } from "../community/access.js";
import { communitySessions, type CommunitySessions, type PrivateCommunitySession } from "../community/sessions.js";
import type { EventDraftInput, EventRecord } from "../community/events.js";
import { resolveEventStart } from "../community/time.js";
import { safe, button, renderEvent } from './eventViews.js';
import { actionOption, commandAction, type CommandActions } from './actions.js';
export { renderEvent } from './eventViews.js';
interface MenuData {
  eventId: string;
  revision: number;
  interpretation?: string;
  publicMessageId?: string | null;
  targetId?: string;
}
interface Dependencies {
  db?: BotDatabase;
  now?: () => number;
  sessions?: CommunitySessions;
}
const ACTIONS = {
  create: { required: ['title', 'start', 'timezone'], optional: ['offset', 'description', 'capacity', 'duration', 'reminder'] },
  list: { optional: ['page'] },
  view: { required: ['id'] },
  edit: { required: ['id'] },
  cancel: { required: ['id'] },
} satisfies CommandActions;

export function createEventCommand(dependencies: Dependencies = {}) {
  const database = dependencies.db ?? defaultDatabase;
  const now = dependencies.now ?? Date.now;
  const sessions = dependencies.sessions ?? communitySessions;
  const store = database.community.events;
  const requireEvent = (guildId: string, id: string) => {
    const e = store.get(guildId, id);
    if (!e) {
      throw new CommandError('Event unavailable. Reopen /event action:list.');
    }
    return e;
  };
  const assertFresh = (expected: EventRecord) => {
    const current = requireEvent(expected.guildId, expected.id);
    if (current.revision !== expected.revision || current.messageId !== expected.messageId) {
      throw new CommandError('Event changed during lookup. Use Refresh or reopen event management.');
    }
  };
  function menu(session: PrivateCommunitySession, e: EventRecord) {
    const data = session.data as MenuData;
    const jobs = store.deliveryJobs(e.guildId, e.id);
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Event management · Private').setDescription(`**${safe(e.title)}**\n${data.interpretation ?? `UTC ${new Date(e.startAt).toISOString()} (UTC+00:00)`}\n<t:${Math.floor(e.startAt / 1000)}:F>\n${e.capacity} seats · ${e.durationMinutes} minutes · ${e.status}\nEvent ID: \`${e.id}\`\n${safe(e.description)}`)
      .setFooter({ text: `Revision ${e.revision} · Confirm the interpreted date before publishing · Menu expires in 10 minutes` });
    if (jobs.length) {
      embed.addFields({ name: 'Delivery status', value: jobs.map(j => `${j.kind}: ${j.status}${j.lastError ? ` · ${safe(j.lastError).slice(0, 150)}` : ''}`).join('\n') });
    }
    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`evtmenu:${session.id}:publish`, 'Publish', e.status !== 'draft', ButtonStyle.Success),
        button(`evtmenu:${session.id}:details`, 'Edit details'),
        button(`evtmenu:${session.id}:squads`, 'Edit squads'),
        button(`evtmenu:${session.id}:move`, 'Move member'),
        button(`evtmenu:${session.id}:retry`, 'Retry / reconcile', !jobs.some(j => ['paused', 'failed', 'needs_review'].includes(j.status))),
      )],
      allowedMentions: { parse: [] as never[] }
    };
  }
  async function openMenu(i: Interaction, e: EventRecord, interpretation?: string): Promise<void> {
    if (!('editReply' in i)) {
      throw new CommandError('Open this draft in a server command.');
    }
    const session = sessions.create({
      kind: 'event-manage',
      ownerId: i.user.id,
      guildId: e.guildId,
      channelId: i.channelId!,
      messageId: null,
      data: {
        eventId: e.id,
        revision: e.revision,
        interpretation
      } satisfies MenuData
    }, now());
    const message = await i.editReply(menu(session, e));
    sessions.bind(session.id, message.id);
  }
  async function createDraft(i: Interaction, seed: Partial<EventDraftInput>, assertSourceCurrent?: () => void): Promise<void> {
    if (!i.guild || !i.guildId || !i.channelId || !('deferReply' in i)) {
      throw new CommandError('Use event in a server.');
    }
    await i.deferReply(privateReply);
    await requireCommunityOfficer(i.guild, i.user.id, database);
    assertSourceCurrent?.();
    const e = store.createDraft({
      guildId: i.guildId,
      channelId: i.channelId,
      creatorId: i.user.id,
      title: seed.title ?? 'Team event',
      description: seed.description ?? '',
      startAt: seed.startAt ?? now() + 86400000,
      durationMinutes: seed.durationMinutes ?? 120,
      capacity: seed.capacity ?? 20,
      squads: seed.squads ?? [],
      reminderMinutes: seed.reminderMinutes ?? 0,
      settingsText: seed.settingsText
    }, now());
    await openMenu(i, e);
  }
  async function eligible(i: Interaction, requireOfficer = false): Promise<Set<string>> {
    if (!i.guild) {
      throw new CommandError('Use event in a server.');
    }
    const roster = await i.guild.members.fetch({ withPresences: false });
    if (requireOfficer) {
      const actor = roster.get(i.user.id);
      if (!actor || !hasCommunityOfficerRole(i.guild.id, actor, database)) {
        throw new CommandError('You need the configured manager, officer, or leader role for this community action.');
      }
    }
    return new Set([...roster.values()].filter(m => !m.user.bot).map(m => m.id));
  }
  function modal(session: PrivateCommunitySession, title: string, fields: [string, string, string, number][]): ModalBuilder {
    const m = new ModalBuilder().setTitle(title).setCustomId(`evtmenu:${session.id}:save`);
    for (const [id, label, value, max] of fields) {
      m.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setValue(value).setStyle(max > 100 ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(true).setMaxLength(max)));
    }
    return m;
  }
  return {
    data: new SlashCommandBuilder().setName('event').setDescription('Create and join team events').setContexts(InteractionContextType.Guild)
      .addStringOption(actionOption(ACTIONS))
      .addStringOption(o => o.setName('title').setDescription('Create: event title').setMaxLength(100))
      .addStringOption(o => o.setName('start').setDescription('Create: local date YYYY-MM-DD HH:mm'))
      .addStringOption(o => o.setName('timezone').setDescription('Create: IANA timezone, e.g. America/Bahia'))
      .addStringOption(o => o.setName('offset').setDescription('Create: UTC offset +/-HH:mm (required if date repeats)'))
      .addStringOption(o => o.setName('description').setDescription('Create: description').setMaxLength(1000))
      .addIntegerOption(o => o.setName('capacity').setDescription('Create: seats (default 20)').setMinValue(1).setMaxValue(100))
      .addIntegerOption(o => o.setName('duration').setDescription('Create: minutes (default 120)').setMinValue(15).setMaxValue(720))
      .addIntegerOption(o => o.setName('reminder').setDescription('Create: optional reminder lead').addChoices({ name: 'Off', value: 0 }, { name: '15 minutes', value: 15 }, { name: '30 minutes', value: 30 }, { name: '60 minutes', value: 60 }))
      .addIntegerOption(o => o.setName('page').setDescription('List: page').setMinValue(1).setMaxValue(10))
      .addStringOption(o => o.setName('id').setDescription('View/edit/cancel: event ID')),

    createDraft,

    async execute(i: ChatInputCommandInteraction): Promise<void> {
      if (!i.guild || !i.guildId || !i.channelId) {
        throw new CommandError('Use event in a server.');
      }
      const sub = commandAction(i.options, ACTIONS);
      await i.deferReply(privateReply);
      if (['create', 'edit', 'cancel'].includes(sub)) {
        await requireCommunityOfficer(i.guild, i.user.id, database);
      }
      if (sub === 'create') {
        const local = i.options.getString('start', true);
        const zone = i.options.getString('timezone', true);
        const offset = i.options.getString('offset') ?? undefined;
        const startAt = resolveEventStart(local, zone, offset);
        const localParts = local.match(/\d+/g)!.map(Number);
        const utcWall = Date.UTC(localParts[0], localParts[1] - 1, localParts[2], localParts[3], localParts[4]);
        const minutes = (utcWall - startAt) / 60000;
        const interpretedOffset = `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
        const e = store.createDraft({
          guildId: i.guildId,
          channelId: i.channelId,
          creatorId: i.user.id,
          title: i.options.getString('title', true),
          description: i.options.getString('description') ?? '',
          startAt,
          durationMinutes: i.options.getInteger('duration') ?? 120,
          capacity: i.options.getInteger('capacity') ?? 20,
          squads: [],
          reminderMinutes: (i.options.getInteger('reminder') ?? 0) as EventDraftInput['reminderMinutes']
        }, now());
        await openMenu(i, e, `${local} · ${safe(zone)} · UTC${interpretedOffset}`);
        return;
      }
      if (sub === 'list') {
        const page = i.options.getInteger('page') ?? 1;
        const { entries, pages } = store.publishedPage(i.guildId, page);
        await i.editReply({ embeds: [new EmbedBuilder().setTitle('Team events').setDescription(entries.map(e => `**${safe(e.title)}** · <t:${Math.floor(e.startAt / 1000)}:f> · ${e.status}\n/event action:view id:${e.id}`).join('\n\n') || 'No published events yet.').setFooter({ text: `Page ${page}/${pages}` })], allowedMentions: { parse: [] } });
        return;
      }
      const e = requireEvent(i.guildId, i.options.getString('id', true));
      if (sub === 'edit') {
        await openMenu(i, e);
        return;
      }
      if (sub === 'cancel') {
        store.cancel(i.guildId, e.id, e.revision, now());
        await i.editReply({ content: 'Event cancelled. Its public card update is queued.' });
        return;
      }
      if (sub !== 'view') {
        throw new CommandError('Choose a supported event action.');
      }
      if (e.status === 'draft') {
        await requireCommunityOfficer(i.guild, i.user.id, database);
        await openMenu(i, e);
        return;
      }
      const card = renderEvent(e, store.participants(i.guildId, e.id), 1, now());
      // Persistent signup controls live only on their canonical public message.
      await i.editReply({
        ...card,
        components: [],
        content: e.messageId ? `[Open signup card](https://discord.com/channels/${e.guildId}/${e.channelId}/${e.messageId})` : undefined,
        allowedMentions: { parse: [] }
      });
    },

    async handleInteraction(i: Interaction): Promise<boolean> {
      if (!('customId' in i) || !['event:', 'evtmenu:'].some(p => i.customId.startsWith(p))) {
        return false;
      }
      if (!(i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())) {
        return false;
      }
      if (!i.guild || !i.guildId || !i.channelId) {
        throw new CommandError('Use event in a server.');
      }
      if (i.customId.startsWith('evtmenu:')) {
        const parts = i.customId.split(':');
        if (parts.length !== 3) {
          throw new CommandError('Invalid control. Reopen event management.');
        }
        const [, id, action] = parts;
        const binding = {
          guildId: i.guildId,
          channelId: i.channelId,
          messageId: i.message?.id ?? null
        };
        const recheckSession = () => sessions.get(id, i.user.id, binding, now());
        const session = recheckSession();
        const data = session.data as MenuData;
        if (!['event-manage', 'event-squad', 'event-details', 'event-squads', 'event-move'].includes(session.kind)) {
          throw new CommandError('Reopen your event menu.');
        }
        let e = requireEvent(i.guildId, data.eventId);
        if (e.revision !== data.revision) {
          throw new CommandError('Event changed. Reopen the menu.');
        }
        if (session.kind === 'event-squad') {
          if (action !== 'select' || !i.isStringSelectMenu() || i.values.length !== 1) {
            throw new CommandError('Reopen squad selection.');
          }
          if (e.messageId !== data.publicMessageId) {
            throw new CommandError('Event message changed. Reopen its public card.');
          }
          const member = await i.guild.members.fetch({ user: i.user.id, force: true });
          recheckSession();
          if (member.user.bot) {
            throw new CommandError('Only server members can join.');
          }
          assertFresh(e);
          const existing = store.signup(i.guildId, e.id, i.user.id);
          if (existing) {
            const members = await eligible(i);
            recheckSession();
            assertFresh(e);
            store.move(i.guildId, e.id, i.user.id, i.values[0], members, now());
          }
          else {
            store.join(i.guildId, e.id, i.user.id, i.values[0], now());
          }
          sessions.delete(id);
          await i.update({
            content: 'Squad signup saved. The public card update is queued.',
            embeds: [],
            components: []
          });
          return true;
        }
        await requireCommunityOfficer(i.guild, i.user.id, database);
        recheckSession();
        assertFresh(e);
        if (action === 'save' && i.isModalSubmit()) {
          if (session.kind === 'event-details') {
            const schedule = i.fields.getTextInputValue('schedule').split('|').map(s => s.trim());
            if (schedule.length < 2 || schedule.length > 3) {
              throw new CommandError('Use local date | IANA timezone | optional UTC offset.');
            }
            const values = i.fields.getTextInputValue('limits').split(',').map(s => Number(s.trim()));
            if (values.length !== 3) {
              throw new CommandError('Enter capacity, duration, reminder lead (0/15/30/60).');
            }
            e = store.edit(i.guildId, e.id, data.revision, {
              title: i.fields.getTextInputValue('title'),
              description: i.fields.getTextInputValue('description') === '-' ? '' : i.fields.getTextInputValue('description'),
              startAt: resolveEventStart(schedule[0], schedule[1], schedule[2] || undefined),
              capacity: values[0],
              durationMinutes: values[1],
              reminderMinutes: values[2] as EventDraftInput['reminderMinutes']
            }, now());
          }
          else if (session.kind === 'event-squads') {
            const text = i.fields.getTextInputValue('squads').trim();
            const squads = text === '-' ? [] : text.split('\n').map(line => {
              const parts = line.split('|').map(s => s.trim());
              if (parts.length !== 3) {
                throw new CommandError('Each squad line must be id | name | capacity.');
              }
              return {
                id: parts[0],
                name: parts[1],
                capacity: Number(parts[2])
              };
            });
            e = store.edit(i.guildId, e.id, data.revision, { capacity: Number(i.fields.getTextInputValue('capacity').trim()), squads }, now());
          }
          else if (session.kind === 'event-move') {
            const target = i.fields.getTextInputValue('member').trim();
            const squad = i.fields.getTextInputValue('squad').trim();
            const members = await eligible(i, true);
            recheckSession();
            assertFresh(e);
            store.move(i.guildId, e.id, target, squad, members, now());
          }
          else {
            throw new CommandError('Reopen event management.');
          }
          sessions.delete(id);
          await i.reply({
            content: `Saved. Start: UTC ${new Date(e.startAt).toISOString()} (UTC+00:00), <t:${Math.floor(e.startAt / 1000)}:F>. Reopen /event action:edit to review or publish.`,
            ...privateReply,
            allowedMentions: { parse: [] }
          });
          return true;
        }
        if (!i.isButton() || session.kind !== 'event-manage') {
          throw new CommandError('Reopen event management.');
        }
        if (action === 'publish') {
          store.requestPublish(i.guildId, e.id, e.revision, now());
          await i.update(menu(session, e));
          return true;
        }
        if (action === 'retry') {
          const job = store.deliveryJobs(i.guildId, e.id).find(j => j.revision === e.revision && ['paused', 'failed', 'needs_review'].includes(j.status));
          if (!job) {
            throw new CommandError('No recoverable delivery remains. Reopen event management.');
          }
          database.community.deliveries.retry(i.guildId, job.id, job.revision, now());
          await i.update(menu(session, e));
          return true;
        }
        if (!['details', 'squads', 'move'].includes(action)) {
          throw new CommandError('Reopen event management.');
        }
        const child = sessions.create({
          kind: `event-${action}`,
          ownerId: i.user.id,
          guildId: i.guildId,
          channelId: i.channelId,
          messageId: session.messageId,
          data: { ...data }
        }, now());
        if (action === 'squads') {
          await i.showModal(modal(child, 'Edit squads', [
            ['capacity', 'Total event capacity (1–100)', String(e.capacity), 3],
            ['squads', 'id | name | capacity; - clears all squads', e.squads.map(s => `${s.id} | ${s.name} | ${s.capacity}`).join('\n') || '-', 2000]
          ]));
        }
        else if (action === 'move') {
          await i.showModal(modal(child, 'Move member', [['member', 'Discord member ID', '', 20], ['squad', 'Destination squad ID', '', 32]]));
        }
        else {
          await i.showModal(modal(child, 'Edit event', [
            ['title', 'Title', e.title, 100], ['description', 'Description (- for empty)', e.description || '-', 1000], ['schedule', 'Local YYYY-MM-DD HH:mm | IANA zone | offset', `${new Date(e.startAt).toISOString().slice(0, 16).replace('T', ' ')} | UTC | +00:00`, 150],
            ['limits', 'Capacity, duration minutes, reminder lead', `${e.capacity}, ${e.durationMinutes}, ${e.reminderMinutes}`, 40]
          ]));
        }
        return true;
      }
      const parts = i.customId.split(':');
      if (parts.length < 4 || parts.length > 5 || !/^\d+$/.test(parts[3]) || (parts[4] !== undefined && !/^\d+$/.test(parts[4]))) {
        throw new CommandError('Invalid event control. Reopen /event action:view.');
      }
      const [, id, action, revision, pageText] = parts;
      const e = requireEvent(i.guildId, id);
      assertCommunityBinding(e, i);
      if (!i.isButton()) {
        throw new CommandError('Invalid event control. Reopen its public card.');
      }
      if (Number(revision) !== e.revision && action !== 'refresh') {
        throw new CommandError('This event changed. Use Refresh on its public card.');
      }
      let page = Number(pageText ?? 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
        throw new CommandError('Invalid event page. Use Refresh.');
      }
      if (['join', 'withdraw', 'squad', 'reminder'].includes(action)) {
        if (e.status !== 'scheduled' || e.startAt <= now()) {
          throw new CommandError('Event signups are closed. Use Refresh.');
        }
        if (action === 'squad' || (action === 'join' && e.squads.length)) {
          if (!e.squads.length) {
            throw new CommandError('This event has no squads. Use Join on its public card.');
          }
          const session = sessions.create({
            kind: 'event-squad',
            ownerId: i.user.id,
            guildId: i.guildId,
            channelId: i.channelId,
            messageId: null,
            data: {
              eventId: e.id,
              revision: e.revision,
              publicMessageId: e.messageId
            } satisfies MenuData
          }, now());
          await i.reply({
            content: 'Choose a squad. Full squads add you to their reserve list.',
            ...privateReply,
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`evtmenu:${session.id}:select`).setPlaceholder('Choose a squad').addOptions(e.squads.map(s => ({ label: s.name, value: s.id }))))],
            allowedMentions: { parse: [] }
          });
          const message = await i.fetchReply();
          sessions.bind(session.id, message.id);
          return true;
        }
        if (action === 'withdraw') {
          await i.deferUpdate();
          const members = await eligible(i);
          assertFresh(e);
          store.withdraw(i.guildId, id, i.user.id, members, now());
        }
        else {
          const member = await i.guild.members.fetch({ user: i.user.id, force: true });
          if (member.user.bot) {
            throw new CommandError('Only server members can join.');
          }
          assertFresh(e);
          if (action === 'join') {
            store.join(i.guildId, id, i.user.id, null, now());
          }
          else {
            const signup = store.signup(i.guildId, id, i.user.id);
            store.setReminder(i.guildId, id, i.user.id, !signup?.reminder, now());
            await i.reply({ content: `Event reminder ${signup?.reminder ? 'disabled' : 'enabled'}. Only confirmed participants receive it.`, ...privateReply });
            return true;
          }
        }
      }
      else if (action === 'previous') {
        page--;
      }
      else if (action === 'next') {
        page++;
      }
      else if (action !== 'refresh') {
        throw new CommandError('Invalid event action. Use Refresh.');
      }
      const payload = { ...renderEvent(requireEvent(i.guildId, id), store.participants(i.guildId, id, page), page, now()), allowedMentions: { parse: [] as never[] } };
      if (i.deferred) {
        await i.editReply(payload);
      }
      else {
        await i.update(payload);
      }
      return true;
    },
  };
}
export const eventCommand = createEventCommand();
export const createEventDraft = (i: Interaction, seed: Partial<EventDraftInput>, assertSourceCurrent?: () => void): Promise<void> =>
  eventCommand.createDraft(i, seed, assertSourceCurrent);
