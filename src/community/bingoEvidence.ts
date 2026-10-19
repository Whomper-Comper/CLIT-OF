import type { StoredPlayerSession } from '../historyStore.js';
import type { MemberAvailability } from './availability.js';
import type { IdentityBinding } from './types.js';
import type { BingoBoard } from './bingo.js';

export interface BingoEvidence {
  key: string;
  boardId: string;
  discordId: string;
  publicId: string | null;
  kind: 'game' | 'availability';
  gameId: string | null;
  at: number;
  won: boolean;
  /** Captured effective link version; required for persisted game evidence. */
  linkedAt?: string;
}
export const bingoGameKey = (publicId: string, gameId: string): string => JSON.stringify(['game', publicId, gameId]);
export const bingoAvailabilityKey = (discordId: string): string => JSON.stringify(['availability', discordId]);

/** Inputs must already represent fresh eligible Discord members. Pass the full human-member ID set
 * separately when unlinked members contribute availability. No Discord/API requests occur here. */
export function collectBingoEvidence(board: BingoBoard, matches: StoredPlayerSession[], available: MemberAvailability[],
  identities: Map<string, IdentityBinding>, clanTags: Set<string>, retentionStart: number,
  currentMembers: Set<string> = new Set(identities.keys())): BingoEvidence[] {
  const result = new Map<string, BingoEvidence>();
  const tags = new Set([...clanTags].map(tag => tag.trim().toUpperCase()));
  const inBoard = (at: number) => Number.isFinite(at) && at >= board.createdAt && (board.closesAt === null || at < board.closesAt);
  for (const match of matches) {
    const binding = identities.get(match.discord_id);
    const at = Date.parse(match.gameStart);
    const end = Date.parse(match.gameEnd ?? '');
    if (!currentMembers.has(match.discord_id) || !binding || binding.guildId !== board.guildId || binding.discordId !== match.discord_id ||
        !binding.publicId || binding.publicId !== match.public_id || !binding.linkedAt ||
        !inBoard(at) || at < retentionStart || !Number.isFinite(end) || end < at ||
        match.gameType !== 'Public' || match.gameMode !== 'Team' || !match.gameId ||
        !match.clanTag || !tags.has(match.clanTag.trim().toUpperCase())) continue;
    const key = bingoGameKey(match.public_id, match.gameId);
    result.set(key, { key, boardId: board.id, discordId: match.discord_id, publicId: match.public_id,
      kind: 'game', gameId: match.gameId, at, won: match.hasWon === true, linkedAt: binding.linkedAt });
  }
  for (const availability of available) {
    if (!currentMembers.has(availability.discordId) || availability.guildId !== board.guildId ||
        !availability.windows.length || !inBoard(availability.updatedAt)) continue;
    const key = bingoAvailabilityKey(availability.discordId);
    result.set(key, { key, boardId: board.id, discordId: availability.discordId, publicId: null,
      kind: 'availability', gameId: null, at: availability.updatedAt, won: false });
  }
  return [...result.values()];
}
