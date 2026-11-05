import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CommandError } from '../commandError.js';
import type { BingoStore } from './bingo.js';
import { withCommunityTransaction } from './transactions.js';

export interface BingoClaim {
  id: string;
  cell: number;
  actorId: string;
  explanation: string;
  evidenceUrl: string | null;
  status: 'pending' | 'approved' | 'rejected';
  revision: number;
}
export function initializeBingoClaims(sql: DatabaseSync): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS community_bingo_claims (
    id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,board_id TEXT NOT NULL,cell_index INTEGER NOT NULL,
    actor_id TEXT NOT NULL,explanation TEXT NOT NULL,evidence_url TEXT,status TEXT NOT NULL,revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,reviewer_id TEXT,reason TEXT,reviewed_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS community_bingo_claim_pending ON community_bingo_claims(board_id,cell_index,actor_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS community_bingo_claim_board ON community_bingo_claims(guild_id,board_id,created_at DESC,id);
    CREATE INDEX IF NOT EXISTS community_bingo_claim_pending_cells ON community_bingo_claims(guild_id,board_id,cell_index) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS community_bingo_claim_member ON community_bingo_claims(guild_id,actor_id,status);
    CREATE INDEX IF NOT EXISTS community_bingo_claim_archive ON community_bingo_claims(board_id,id);
    CREATE TABLE IF NOT EXISTS community_bingo_public_state (board_id TEXT PRIMARY KEY,signature TEXT NOT NULL,sequence INTEGER NOT NULL);`);
}
function decode(row: Record<string, unknown>): BingoClaim {
  return { id: String(row.id), cell: Number(row.cell_index), actorId: String(row.actor_id),
    explanation: String(row.explanation), evidenceUrl: row.evidence_url as string | null,
    status: row.status as BingoClaim['status'], revision: Number(row.revision) };
}
export class BingoClaims {
  constructor(private readonly sql: DatabaseSync, private readonly boards: BingoStore) {}
  claim(guildId: string, boardId: string, cell: number, actorId: string, explanation: string, evidenceUrl: string | null, now: number): BingoClaim {
    const board = this.boards.getActive(guildId);
    if (!board || board.id !== boardId || (board.closesAt !== null && now >= board.closesAt) || !Number.isInteger(cell) ||
        board.cells[cell]?.objective?.kind !== 'manual' || !actorId || !Number.isSafeInteger(now) ||
        typeof explanation !== 'string' || !explanation.trim() || explanation.length > 1000) {
      throw new CommandError('Choose an open manual bingo cell and an explanation of 1–1000 characters.');
    }
    if (evidenceUrl !== null) {
      let url: URL;
      try { url = new URL(evidenceUrl); } catch { throw new CommandError('Evidence must be an HTTPS URL.'); }
      if (url.protocol !== 'https:' || url.username || url.password || evidenceUrl.length > 500) throw new CommandError('Evidence must be an HTTPS URL of at most 500 characters.');
    }
    return withCommunityTransaction(this.sql, () => {
      const existing = this.sql.prepare("SELECT * FROM community_bingo_claims WHERE board_id=? AND cell_index=? AND actor_id=? AND status='pending'").get(boardId, cell, actorId);
      if (existing) return decode(existing);
      const id = randomUUID();
      this.sql.prepare(`INSERT INTO community_bingo_claims(id,guild_id,board_id,cell_index,actor_id,explanation,evidence_url,status,revision,created_at)
        VALUES(?,?,?,?,?,?,?,'pending',1,?)`).run(id, guildId, boardId, cell, actorId, explanation.trim(), evidenceUrl, now);
      return decode(this.sql.prepare('SELECT * FROM community_bingo_claims WHERE id=?').get(id)!);
    });
  }
  review(guildId: string, claimId: string, officerId: string, approve: boolean, reason: string, expectedRevision: number, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const claim = this.sql.prepare('SELECT * FROM community_bingo_claims WHERE guild_id=? AND id=?').get(guildId, claimId);
      const board = this.boards.getActive(guildId);
      if (!claim || !board || claim.board_id !== board.id || claim.revision !== expectedRevision ||
          !officerId || typeof approve !== 'boolean' || typeof reason !== 'string' || !reason.trim() || reason.length > 1000 || !Number.isSafeInteger(now)) {
        throw new CommandError('Claim changed or is unavailable. Reopen /bingo action:review and supply an audit reason.');
      }
      if (approve || claim.status === 'approved') {
        this.boards.setManualApproval(guildId, board.id, board.revision, Number(claim.cell_index), approve, officerId, reason, now);
      } else {
        this.sql.prepare('INSERT INTO community_bingo_audit(board_id,cell_index,approved,actor_id,reason,at) VALUES(?,?,?,?,?,?)')
          .run(board.id, claim.cell_index!, 0, officerId, reason, now);
      }
      this.sql.prepare('UPDATE community_bingo_claims SET status=?,revision=revision+1,reviewer_id=?,reason=?,reviewed_at=? WHERE id=?')
        .run(approve ? 'approved' : 'rejected', officerId, reason, now, claimId);
    });
  }
  list(guildId: string, boardId: string, page: number): BingoClaim[] {
    const offset = (Math.max(1, Math.min(10000, Math.floor(page) || 1)) - 1) * 10;
    return this.sql.prepare('SELECT * FROM community_bingo_claims WHERE guild_id=? AND board_id=? ORDER BY created_at DESC,id LIMIT 10 OFFSET ?')
      .all(guildId, boardId, offset).map(decode);
  }
  find(guildId: string, boardId: string, claimId: string): BingoClaim | null {
    const row = this.sql.prepare('SELECT * FROM community_bingo_claims WHERE guild_id=? AND board_id=? AND id=?').get(guildId, boardId, claimId);
    return row ? decode(row) : null;
  }
}
