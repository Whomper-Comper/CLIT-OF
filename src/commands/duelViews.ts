import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { DuelRecord } from '../community/duels.js';

export function renderDuel(record: DuelRecord) {
  const pending = record.status === 'pending';
  const bound = record.messageId !== null;
  const enabled = bound && record.activatedAt !== null;
  const tie = record.status === 'resolved' && record.challengerRoll === record.opponentRoll;
  const description = pending
    ? `<@${record.challengerId}> challenges <@${record.opponentId}>. Both roll one D6 after acceptance.\n${record.activatedAt === null ? 'Waiting for activation until' : 'Accept before'} <t:${Math.floor(record.expiresAt / 1000)}:R>.`
    : record.status === 'resolved'
      ? `<@${record.challengerId}> rolled **${record.challengerRoll}**\n<@${record.opponentId}> rolled **${record.opponentRoll}**\n\n${tie ? '**A tie!** Request a rematch for a fresh invitation.' : `**<@${record.challengerRoll! > record.opponentRoll! ? record.challengerId : record.opponentId}> wins!**`}`
      : `This invitation is **${record.status}**.${record.status === 'expired' ? ' Use /duel to try again.' : ''}`;
  const button = (action: string, label: string, style: ButtonStyle, disabled: boolean) =>
    new ButtonBuilder().setCustomId(`clit-duel:${record.id}:${action}`).setLabel(label).setStyle(style).setDisabled(disabled);
  const controls = [button('accept', 'Accept', ButtonStyle.Success, !pending || !enabled),
    button('decline', 'Decline', ButtonStyle.Secondary, !pending || !enabled),
    button('cancel', 'Cancel', ButtonStyle.Danger, !pending || !enabled),
    button('refresh', 'Refresh', ButtonStyle.Secondary, !bound)];
  if (tie) controls.push(button('rematch', 'Rematch', ButtonStyle.Primary, !bound));
  return { embeds: [new EmbedBuilder().setTitle(pending ? '🎲 Dice duel · Invitation' : '🎲 Dice duel · Result')
    .setColor(pending ? 0x5865f2 : tie ? 0xfee75c : record.status === 'resolved' ? 0x57f287 : 0x747f8d)
    .setDescription(description).setFooter({ text: 'Two players · One D6 each · No stakes' })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...controls)], allowedMentions: { parse: [] as never[] } };
}

export function renderClosedDuel() {
  return { embeds: [new EmbedBuilder().setTitle('🎲 Dice duel · Closed').setColor(0x747f8d)
    .setDescription('This invitation is unavailable because a participant left. Use /duel for a fresh invitation.')],
    components: [], allowedMentions: { parse: [] as never[] } };
}
