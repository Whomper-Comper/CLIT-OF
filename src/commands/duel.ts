import { InteractionContextType, SlashCommandBuilder, type Guild, type Interaction,
  type ChatInputCommandInteraction } from 'discord.js';
import { db as defaultDatabase, type BotDatabase } from '../db.js';
import { CommandError, privateReply } from './support.js';
import { assertCommunityBinding } from '../community/access.js';
import type { DuelRecord } from '../community/duels.js';
export { renderDuel } from './duelViews.js';

interface Dependencies {
  db?: BotDatabase;
  now?: () => number;
  roll?: (min: number, maxExclusive: number) => number;
}

export function createDuelCommand(dependencies: Dependencies = {}) {
  const database = dependencies.db ?? defaultDatabase;
  const now = dependencies.now ?? Date.now;
  const store = database.community.duels;
  const unavailable = () => new CommandError('This duel changed or is unavailable. Reopen /duel.');

  async function withHumans<T>(guild: Guild, ids: string[], action: () => T, missing?: () => void): Promise<T> {
    const check = store.beginMembershipCheck(guild.id, ids);
    try {
      // An array uses a fresh gateway request rather than the single-member cache path.
      const found = await guild.members.fetch({ user: ids, withPresences: false, time: 10_000 });
      if (!check.current()) {
        missing?.();
        throw unavailable();
      }
      if (ids.some(id => !found.has(id) || found.get(id)!.user.bot)) {
        missing?.();
        throw new CommandError('Choose current human server members for this duel.');
      }
      return action();
    } finally { check.release(); }
  }
  function current(i: Interaction, id: string): DuelRecord {
    const record = store.get(i.guildId!, id);
    if (!record) throw unavailable();
    assertCommunityBinding(record, i);
    if (!record.messageId) throw unavailable();
    return record;
  }
  function authorize(record: DuelRecord, actor: string, action: string): void {
    if (action === 'accept' || action === 'decline') {
      if (actor !== record.opponentId) throw new CommandError('Only the opponent may accept or decline this duel.');
    } else if (action === 'cancel') {
      if (actor !== record.challengerId) throw new CommandError('Only the challenger may cancel this duel.');
    } else if (action === 'rematch') {
      if (actor !== record.challengerId && actor !== record.opponentId) {
        throw new CommandError('Only the original participants may request a rematch.');
      }
      if (record.status !== 'resolved' || record.challengerRoll !== record.opponentRoll) {
        throw new CommandError('A rematch requires a resolved tie.');
      }
    }
  }

  return {
    data: new SlashCommandBuilder().setName('duel').setDescription('Invite a member to a friendly D6 duel')
      .setContexts(InteractionContextType.Guild)
      .addUserOption(option => option.setName('opponent').setDescription('Member who must accept the challenge').setRequired(true)),

    async execute(i: ChatInputCommandInteraction): Promise<void> {
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError('Use /duel in a server.');
      const opponent = i.options.getUser('opponent', true);
      if (opponent.id === i.user.id) throw new CommandError('Choose a different member to duel.');
      await i.deferReply(privateReply);
      await withHumans(i.guild, [i.user.id, opponent.id], () =>
        store.invite({ guildId: i.guildId!, channelId: i.channelId!, messageId: null }, i.user.id, opponent.id, now()));
      await i.editReply({ content: 'Public invitation queued. The opponent must accept before either die is rolled.', allowedMentions: { parse: [] } });
    },

    async handleInteraction(i: Interaction): Promise<boolean> {
      if (!('customId' in i) || !i.customId.startsWith('clit-duel:')) return false;
      if (!i.isButton()) return false;
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError('Use /duel in a server.');
      const parts = i.customId.split(':');
      if (parts.length !== 3 || !['accept', 'decline', 'cancel', 'refresh', 'rematch'].includes(parts[2])) {
        throw new CommandError('Invalid duel control. Reopen the original invitation.');
      }
      const [, id, action] = parts;
      const original = current(i, id);
      authorize(original, i.user.id, action);
      await i.deferReply(privateReply);
      const ids = action === 'refresh' ? [i.user.id] : [original.challengerId, original.opponentId];
      await withHumans(i.guild, ids, () => {
        const fresh = current(i, id);
        authorize(fresh, i.user.id, action);
        if (action === 'accept' && fresh.status === 'pending' && fresh.activatedAt === null && now() < fresh.expiresAt) {
          throw new CommandError('This invitation is waiting for activation. Use its enabled Accept button.');
        }
        if (action === 'accept') store.resolve(i.guildId!, id, i.user.id, now(), dependencies.roll);
        else if (action === 'decline') store.decline(i.guildId!, id, i.user.id, now());
        else if (action === 'cancel') store.cancel(i.guildId!, id, i.user.id, now());
        else if (action === 'rematch') {
          const opponentId = i.user.id === fresh.challengerId ? fresh.opponentId : fresh.challengerId;
          store.invite({ guildId: i.guildId!, channelId: i.channelId!, messageId: null }, i.user.id, opponentId, now(), id);
        } else store.refresh(i.guildId!, id, now());
      }, action === 'refresh' ? undefined : () => store.closeUnavailable(i.guildId!, id, now()));
      await i.editReply({ content: action === 'rematch'
        ? 'Fresh public invitation queued. Your opponent must accept again.'
        : 'Saved duel state queued for the original public message. Refresh recovers a failed update.',
      allowedMentions: { parse: [] } });
      return true;
    },
  };
}

export const duelCommand = createDuelCommand();
export const handleDuelInteraction = (i: Interaction): Promise<boolean> => duelCommand.handleInteraction(i);
