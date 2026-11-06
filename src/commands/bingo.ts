import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, ModalBuilder,
  SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type Interaction } from 'discord.js';
import { db as defaultDatabase, type BotDatabase } from '../db.js';
import { CommandError, privateReply } from './support.js';
import { assertCommunityBinding, hasCommunityOfficerRole, requireCommunityOfficer } from '../community/access.js';
import { communitySessions, type CommunitySessions, type PrivateCommunitySession } from '../community/sessions.js';
import { defaultBingoObjectives, type BingoBoard, type BingoObjective } from '../community/bingo.js';
import { bingoViewState, queueBingoUpdate, syncBingoInventory } from '../community/bingoWorker.js';
import { button, safe } from './eventViews.js';
import { renderBingoBoard } from './bingoViews.js';
import { actionOption, commandAction, type CommandActions } from './actions.js';
export { renderBingoBoard } from './bingoViews.js';

interface MenuData {
  boardId: string;
  revision: number;
  replace?: { id: string; revision: number };
  claimId?: string;
  claimRevision?: number;
  publicMessageId?: string | null;
}
interface Dependencies { db?: BotDatabase; now?: () => number; sessions?: CommunitySessions }
const ACTIONS = {
  view: { optional: ['cell'] },
  create: {},
  claim: { required: ['cell', 'explanation'], optional: ['evidence'] },
  review: { optional: ['page'] },
  reset: {},
} satisfies CommandActions;

export function createBingoCommand(dependencies: Dependencies = {}) {
  const database = dependencies.db ?? defaultDatabase;
  const now = dependencies.now ?? Date.now;
  const sessions = dependencies.sessions ?? communitySessions;
  const store = database.community.bingo;
  const active = (guildId: string) => {
    const board = store.getActive(guildId);
    if (!board) throw new CommandError('No active bingo board. Ask an officer to use /bingo action:create.');
    return board;
  };
  const fresh = (expected: BingoBoard) => {
    const board = store.get(expected.guildId, expected.id);
    if (!board || board.status === 'archived' || board.revision !== expected.revision || board.messageId !== expected.messageId || board.status !== expected.status) {
      throw new CommandError('Bingo board changed. Reopen /bingo action:view or your private menu.');
    }
    return board;
  };
  function session(i: Interaction, kind: string, data: MenuData, messageId: string | null = null) {
    return sessions.create({ kind, ownerId: i.user.id, guildId: i.guildId!, channelId: i.channelId!, messageId, data }, now());
  }
  function modal(s: PrivateCommunitySession, title: string, fields: [string, string, string, number][]) {
    const form = new ModalBuilder().setCustomId(`bingomenu:${s.id}:save`).setTitle(title);
    for (const [id, label, value, max] of fields) {
      form.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId(id).setLabel(label).setStyle(max > 200 ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(true).setMaxLength(max).setValue(value)));
    }
    return form;
  }
  function draftMenu(s: PrivateCommunitySession, board: BingoBoard) {
    const data = s.data as MenuData;
    const jobs = store.deliveryJobs(board.guildId, board.id);
    const card = renderBingoBoard(board);
    card.embeds[0].setTitle(data.replace ? 'Confirm bingo reset · Private preview' : 'Bingo draft · Private preview');
    card.embeds[0].addFields({ name: 'Publication', value: `${data.replace ? 'Confirming archives the old board and queues this replacement.' : 'Review all 24 challenges before publishing.'}\n${jobs.map(job => `${job.kind}: ${job.status}${job.lastError ? ` · ${safe(job.lastError).slice(0, 100)}` : ''}`).join('\n') || 'Not queued.'}`.slice(0, 1024) });
    return { content: `Destination: <#${board.channelId}> · Edit each challenge as kind | target | description. Supported kinds: appearances, wins, contributors, shared_game, availability, manual. Manual targets are 1.`,
      embeds: card.embeds, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(`bingomenu:${s.id}:publish`, data.replace ? 'Confirm reset' : 'Publish board', jobs.some(j => ['pending', 'sending'].includes(j.status)), data.replace ? ButtonStyle.Danger : ButtonStyle.Success),
      button(`bingomenu:${s.id}:edit`, 'Edit challenges', jobs.length > 0),
      button(`bingomenu:${s.id}:retry`, 'Retry / reconcile', !jobs.some(j => ['paused', 'failed', 'needs_review'].includes(j.status))),
    )], allowedMentions: { parse: [] as never[] } };
  }
  async function openDraft(i: ChatInputCommandInteraction, board: BingoBoard, replace?: MenuData['replace']) {
    const s = session(i, 'bingo-draft', { boardId: board.id, revision: board.revision, replace });
    const message = await i.editReply(draftMenu(s, board));
    sessions.bind(s.id, message.id);
  }
  async function member(i: Interaction): Promise<void> {
    const found = await i.guild!.members.fetch({ user: i.user.id, force: true });
    if (found.user.bot) throw new CommandError('Only current human server members can claim a cell.');
  }
  function parseChallenges(text: string): BingoObjective[] {
    return text.split('\n').filter(line => line.trim() && line.trim() !== '-').map(line => {
      const parts = line.split('|').map(part => part.trim());
      if (parts.length !== 3) throw new CommandError('Each challenge uses kind | target | description.');
      return { kind: parts[0] as BingoObjective['kind'], target: Number(parts[1]), label: parts[2] };
    });
  }
  function closingDate(text: string): number | null {
    if (text === '-') return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
      throw new CommandError('Use a valid closing date in UTC: YYYY-MM-DDTHH:mm:ssZ, or - for no closing date.');
    }
    const time = Date.parse(text);
    const canonical = text.includes('.') ? text : text.replace('Z', '.000Z');
    if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) throw new CommandError('Choose a valid calendar date for closing.');
    return time;
  }
  return {
    data: new SlashCommandBuilder().setName('bingo').setDescription('Shared server challenges and private claims').setContexts(InteractionContextType.Guild)
      .addStringOption(actionOption(ACTIONS))
      .addIntegerOption(o => o.setName('cell').setDescription('View/claim: cell number 1–25').setMinValue(1).setMaxValue(25))
      .addStringOption(o => o.setName('explanation').setDescription('Claim: explain completion').setMaxLength(1000))
      .addStringOption(o => o.setName('evidence').setDescription('Claim: optional HTTPS evidence URL (never fetched)').setMaxLength(500))
      .addIntegerOption(o => o.setName('page').setDescription('Review: claim page').setMinValue(1).setMaxValue(10000)),

    async execute(i: ChatInputCommandInteraction): Promise<void> {
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError('Use /bingo in a server.');
      const sub = commandAction(i.options, ACTIONS);
      await i.deferReply(privateReply);
      if (['create', 'review', 'reset'].includes(sub)) await requireCommunityOfficer(i.guild, i.user.id, database);
      if (sub === 'create' || sub === 'reset') {
        const old = store.getActive(i.guildId);
        if (sub === 'create' && old) throw new CommandError('A board is already active. Use /bingo action:reset to confirm replacement.');
        if (sub === 'reset' && !old) throw new CommandError('No active board to reset. Use /bingo action:create.');
        const draft = store.draft(i.guildId, i.user.id) ?? store.createDraft(i.guildId, i.channelId, defaultBingoObjectives(), null, now(), i.user.id);
        await openDraft(i, draft, sub === 'reset' ? { id: old!.id, revision: old!.revision } : undefined);
        return;
      }
      const board = active(i.guildId);
      if (sub === 'claim') {
        await member(i);
        fresh(board);
        const claim = store.claim(i.guildId, board.id, i.options.getInteger('cell', true) - 1, i.user.id,
          i.options.getString('explanation', true), i.options.getString('evidence'), now());
        queueBingoUpdate(database, board, now());
        await i.editReply({ content: `Claim ${claim.id} is ${claim.status}. Officer review is private.`, allowedMentions: { parse: [] } });
        return;
      }
      if (sub === 'review') {
        const page = i.options.getInteger('page') ?? 1;
        const claims = store.claims(i.guildId, board.id, page);
        const jobs = store.deliveryJobs(i.guildId, board.id);
        const s = session(i, 'bingo-review', { boardId: board.id, revision: board.revision });
        const embed = new EmbedBuilder().setTitle('Bingo claims · Private').setDescription(claims.map(claim => `Cell ${claim.cell + 1} · ${claim.status}\n${safe(claim.explanation).slice(0, 180)}${claim.evidenceUrl ? `\n${safe(claim.evidenceUrl).slice(0, 160)}` : ''}`).join('\n\n') || 'No claims on this page.');
        if (jobs.length) embed.addFields({ name: 'Delivery status', value: jobs.map(job => `${job.kind}: ${job.status}${job.lastError ? ` · ${safe(job.lastError).slice(0, 55)}` : ''}`).join('\n').slice(0, 1024) });
        const message = await i.editReply({ content: `Private claim review · Page ${page}. Reopen /bingo action:review page:${page + 1} for older claims.`,
          embeds: [embed],
          components: [...(claims.length ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`bingomenu:${s.id}:choose`).setPlaceholder('Choose a claim to review or revoke')
            .addOptions(claims.map(claim => ({ label: `Cell ${claim.cell + 1} · ${claim.status} · ${claim.actorId}`.slice(0, 100), value: `${claim.id}:${claim.revision}` }))))] : []),
          new ActionRowBuilder<ButtonBuilder>().addComponents(button(`bingomenu:${s.id}:retry`, 'Retry / reconcile', !jobs.some(job => ['paused', 'failed', 'needs_review'].includes(job.status))))],
          allowedMentions: { parse: [] } });
        sessions.bind(s.id, message.id);
        return;
      }
      if (sub !== 'view') throw new CommandError('Choose a supported bingo action.');
      await syncBingoInventory(i.guild, database);
      const current = fresh(board);
      const cell = i.options.getInteger('cell');
      if (cell !== null) {
        const objective = current.cells[cell - 1]?.objective;
        await i.editReply({ content: objective ? `**Cell ${cell}** · ${objective.kind} · Target ${objective.target}\n${safe(objective.label)}` : '**Cell 13 · Free center**', allowedMentions: { parse: [] } });
        return;
      }
      await i.editReply({ ...renderBingoBoard(current, bingoViewState(database, current, now())), components: [],
        content: board.messageId ? `[Open shared board](https://discord.com/channels/${board.guildId}/${board.channelId}/${board.messageId})` : undefined,
        allowedMentions: { parse: [] } });
    },

    async handleInteraction(i: Interaction): Promise<boolean> {
      if (!('customId' in i) || !['bingo:', 'bingomenu:'].some(prefix => i.customId.startsWith(prefix))) return false;
      if (!(i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())) return false;
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError('Use /bingo in a server.');
      if (i.customId.startsWith('bingo:')) {
        const parts = i.customId.split(':');
        if (parts.length !== 4 || !/^\d+$/.test(parts[3]) || !i.isButton()) throw new CommandError('Invalid bingo control. Reopen /bingo action:view.');
        const [, id, action, revision] = parts;
        const board = active(i.guildId);
        if (id !== board.id || Number(revision) !== board.revision) throw new CommandError('Board changed. Reopen /bingo action:view.');
        assertCommunityBinding(board, i);
        if (action === 'refresh') {
          await i.deferReply(privateReply);
          await syncBingoInventory(i.guild, database);
          queueBingoUpdate(database, fresh(board), now());
          await i.editReply({ content: 'Board refresh queued. Automatic progress stays hidden while its complete evidence refresh is pending.' });
        } else if (action === 'claim') {
          const s = session(i, 'bingo-claim', { boardId: board.id, revision: board.revision, publicMessageId: board.messageId }, board.messageId);
          await i.showModal(modal(s, 'Claim a manual bingo cell', [['cell', 'Cell number 1–25', '', 2], ['explanation', 'Explain completion', '', 1000], ['evidence', 'HTTPS evidence URL (- for none)', '-', 500]]));
        } else throw new CommandError('Invalid bingo action. Reopen /bingo action:view.');
        return true;
      }
      const parts = i.customId.split(':');
      if (parts.length !== 3) throw new CommandError('Invalid menu. Reopen /bingo.');
      const [, id, action] = parts;
      const binding = { guildId: i.guildId, channelId: i.channelId, messageId: i.message?.id ?? null };
      const recheckSession = () => sessions.get(id, i.user.id, binding, now());
      const s = recheckSession();
      if (!['bingo-draft', 'bingo-edit', 'bingo-review', 'bingo-decision', 'bingo-claim'].includes(s.kind)) throw new CommandError('Reopen /bingo.');
      const data = s.data as MenuData;
      const board = store.get(i.guildId, data.boardId);
      if (!board || board.status === 'archived' || board.revision !== data.revision) throw new CommandError('Board changed. Reopen /bingo.');
      if (s.kind === 'bingo-claim') {
        if (!i.isModalSubmit() || action !== 'save') throw new CommandError('Reopen /bingo action:claim.');
        await member(i);
        recheckSession();
        const current = fresh(board);
        if (current.messageId !== data.publicMessageId) throw new CommandError('Board changed. Reopen /bingo action:view.');
        const evidence = i.fields.getTextInputValue('evidence').trim();
        const claim = store.claim(i.guildId, board.id, Number(i.fields.getTextInputValue('cell')) - 1, i.user.id,
          i.fields.getTextInputValue('explanation'), evidence === '-' ? null : evidence, now());
        sessions.delete(id);
        queueBingoUpdate(database, current, now());
        await i.reply({ content: `Claim ${claim.id} is ${claim.status}.`, ...privateReply, allowedMentions: { parse: [] } });
        return true;
      }
      await requireCommunityOfficer(i.guild, i.user.id, database);
      recheckSession();
      fresh(board);
      if (s.kind === 'bingo-review' && i.isButton() && action === 'retry') {
        const job = store.deliveryJobs(i.guildId, board.id).find(j => ['paused', 'failed', 'needs_review'].includes(j.status));
        if (!job) throw new CommandError('No recoverable delivery. Reopen /bingo action:review.');
        database.community.deliveries.retry(i.guildId, job.id, job.revision, now());
        await i.update({ content: 'Delivery retry/reconciliation queued. Reopen /bingo action:review for current diagnostics.', embeds: [], components: [] });
        return true;
      }
      if (s.kind === 'bingo-draft' && i.isButton()) {
        if (action === 'publish') {
          store.requestPublish(i.guildId, board.id, board.revision, data.replace ?? null, now());
          await i.update(draftMenu(s, board));
        } else if (action === 'retry') {
          const job = store.deliveryJobs(i.guildId, board.id).find(j => ['paused', 'failed', 'needs_review'].includes(j.status));
          if (!job) throw new CommandError('No recoverable delivery. Reopen /bingo action:create.');
          database.community.deliveries.retry(i.guildId, job.id, job.revision, now());
          await i.update(draftMenu(s, board));
        } else if (action === 'edit') {
          if (store.deliveryJobs(i.guildId, board.id).length) throw new CommandError('Publication already queued. Reopen /bingo.');
          const child = session(i, 'bingo-edit', { ...data }, s.messageId);
          const objectives = board.cells.filter(cell => cell.objective).map(cell => cell.objective!);
          const lines = (start: number) => objectives.slice(start, start + 12).map(o => `${o.kind} | ${o.target} | ${o.label}`).join('\n');
          await i.showModal(modal(child, 'Edit 24 bingo challenges', [['challenges', 'First 12: kind | target | description', lines(0), 4000],
            ['remaining', 'Last 12 (manual target is 1)', lines(12), 4000], ['closing', 'Closing ISO UTC date (- for none)', board.closesAt === null ? '-' : new Date(board.closesAt).toISOString(), 40]]));
        } else throw new CommandError('Reopen bingo draft.');
        return true;
      }
      if (s.kind === 'bingo-edit' && i.isModalSubmit() && action === 'save') {
        const closing = i.fields.getTextInputValue('closing').trim();
        store.editDraft(i.guildId, board.id, board.revision,
          parseChallenges(`${i.fields.getTextInputValue('challenges')}\n${i.fields.getTextInputValue('remaining')}`), closingDate(closing), now());
        sessions.delete(id);
        await i.reply({ content: 'Saved all 24 definitions. Reopen /bingo action:create (or /bingo action:reset) to preview and explicitly publish.', ...privateReply });
        return true;
      }
      if (s.kind === 'bingo-review' && i.isStringSelectMenu() && action === 'choose') {
        if (i.values.length !== 1) throw new CommandError('Choose one claim.');
        const [claimId, revision] = i.values[0].split(':');
        const claim = store.findClaim(i.guildId, board.id, claimId);
        if (!claim || claim.revision !== Number(revision)) throw new CommandError('Claim changed. Reopen /bingo action:review.');
        const child = session(i, 'bingo-decision', { ...data, claimId, claimRevision: claim.revision }, s.messageId);
        await i.showModal(modal(child, `Review cell ${claim.cell + 1}`, [['explanation', 'Submitted explanation (read before deciding)', claim.explanation, 1000],
          ['evidence', 'Submitted evidence URL (never fetched)', claim.evidenceUrl ?? '-', 500],
          ['decision', 'approve or reject (reject revokes approval)', '', 10], ['reason', 'Audit reason', '', 1000]]));
        return true;
      }
      if (s.kind === 'bingo-decision' && i.isModalSubmit() && action === 'save') {
        const decision = i.fields.getTextInputValue('decision').trim().toLowerCase();
        if (!['approve', 'reject'].includes(decision)) throw new CommandError('Enter approve or reject.');
        const inventory = await syncBingoInventory(i.guild, database);
        recheckSession();
        const officer = inventory.roster.get(i.user.id);
        if (!officer || !hasCommunityOfficerRole(i.guildId, officer, database)) {
          throw new CommandError('You need the configured manager, officer, or leader role for this community action.');
        }
        fresh(board);
        store.review(i.guildId, data.claimId!, i.user.id, decision === 'approve', i.fields.getTextInputValue('reason'), data.claimRevision!, now());
        sessions.delete(id);
        queueBingoUpdate(database, store.get(i.guildId, board.id)!, now());
        await i.reply({ content: 'Decision audited. The public board update is queued.', ...privateReply });
        return true;
      }
      throw new CommandError('Reopen your bingo menu.');
    },
  };
}
export const bingoCommand = createBingoCommand();
