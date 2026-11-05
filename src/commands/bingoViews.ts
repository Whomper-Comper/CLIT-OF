import { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from 'discord.js';
import type { BingoBoard } from '../community/bingo.js';
import { button, safe } from './eventViews.js';

export function bingoLineCells(part: number): number[] {
  if (part === 12) return Array.from({ length: 25 }, (_, n) => n);
  if (part >= 0 && part < 5) return [0, 1, 2, 3, 4].map(n => part * 5 + n);
  if (part >= 5 && part < 10) return [0, 1, 2, 3, 4].map(n => n * 5 + part - 5);
  if (part === 10) return [0, 6, 12, 18, 24];
  if (part === 11) return [4, 8, 12, 16, 20];
  return [];
}
export interface BingoViewState {
  ready: boolean;
  label: string;
  pending?: Set<number>;
}
export function visibleBingoBoard(board: BingoBoard, ready: boolean): BingoBoard {
  return { ...board, cells: board.cells.map(cell => !ready && cell.objective && cell.objective.kind !== 'manual'
    ? { ...cell, complete: false, progress: 0 } : cell) };
}
export function renderBingoBoard(board: BingoBoard, state: BingoViewState = { ready: false, label: 'Automatic tracking refreshing · Manual claims remain available' }): {
  embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[];
} {
  const visible = visibleBingoBoard(board, state.ready);
  const lines = Array.from({ length: 12 }, (_, part) => bingoLineCells(part)).filter(indices => indices.every(index => visible.cells[index].complete)).length;
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Shared server bingo · 5 × 5')
    .setDescription(`${visible.cells.filter(c => c.complete).length}/25 complete · ${lines}/12 lines\nCreated <t:${Math.floor(board.createdAt / 1000)}:f>${board.closesAt === null ? ' · No closing date' : ` · Closes <t:${Math.floor(board.closesAt / 1000)}:f>`}`)
    .setFooter({ text: `${state.label} · Full descriptions: /bingo action:view cell:<number> · Revision ${board.revision}`.slice(0, 1000) });
  for (let row = 0; row < 5; row++) {
    const value = visible.cells.slice(row * 5, row * 5 + 5).map(cell => {
      if (!cell.objective) return '**13 ✓ FREE**';
      const automatic = cell.objective.kind !== 'manual';
      const status = cell.complete ? '✓' : !state.ready && automatic ? '↻' : state.pending?.has(cell.index) ? 'Pending' : '○';
      const progress = automatic ? state.ready ? ` (${cell.progress}/${cell.objective.target})` : ' (refreshing)' : '';
      return `**${cell.index + 1} ${status}** ${safe(cell.objective.label).slice(0, 136)}${progress}`;
    }).join('\n');
    embed.addFields({ name: `Row ${row + 1}`, value });
  }
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`bingo:${board.id}:refresh:${board.revision}`, 'Refresh'),
    button(`bingo:${board.id}:claim:${board.revision}`, 'Claim a cell'),
  )] };
}
