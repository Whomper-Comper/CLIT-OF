import type { DatabaseSync } from 'node:sqlite';
import type { BingoEvidence } from './bingoEvidence.js';

/** Evidence generations make complete publication a constant-size pointer change. */
export function initializeBingoGenerations(sql: DatabaseSync): void {
  const boardColumns = new Set(sql.prepare('PRAGMA table_info(community_bingo_boards)').all().map(row => row.name));
  if (!boardColumns.has('evidence_generation')) {
    sql.exec(`ALTER TABLE community_bingo_boards ADD COLUMN evidence_generation TEXT NOT NULL DEFAULT '';
      ALTER TABLE community_bingo_boards ADD COLUMN refresh_cursor TEXT;
      ALTER TABLE community_bingo_boards ADD COLUMN refresh_version TEXT;
      UPDATE community_bingo_boards SET evidence_generation=id;`);
  }
  const evidenceColumns = new Set(sql.prepare('PRAGMA table_info(community_bingo_evidence)').all().map(row => row.name));
  const migrate = evidenceColumns.size > 0 && !evidenceColumns.has('generation');
  if (migrate) sql.exec('ALTER TABLE community_bingo_evidence RENAME TO community_bingo_evidence_legacy');
  sql.exec(`CREATE TABLE IF NOT EXISTS community_bingo_evidence (
    board_id TEXT NOT NULL,generation TEXT NOT NULL,guild_id TEXT NOT NULL,evidence_key TEXT NOT NULL,
    discord_id TEXT NOT NULL,public_id TEXT,kind TEXT NOT NULL,game_id TEXT,at INTEGER NOT NULL,won INTEGER NOT NULL,linked_at TEXT,
    PRIMARY KEY(board_id,generation,evidence_key));
    CREATE TABLE IF NOT EXISTS community_bingo_generations (
    id TEXT PRIMARY KEY,board_id TEXT NOT NULL,guild_id TEXT NOT NULL,status TEXT NOT NULL,snapshot TEXT,
    phase TEXT NOT NULL DEFAULT 'games',cursor TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS community_bingo_generation_board ON community_bingo_generations(board_id,status,id);
    CREATE INDEX IF NOT EXISTS community_bingo_generation_guild ON community_bingo_generations(guild_id,status,id);
    CREATE INDEX IF NOT EXISTS community_bingo_generation_cleanup ON community_bingo_generations(status,updated_at,id);
    CREATE TABLE IF NOT EXISTS community_bingo_totals (
    board_id TEXT NOT NULL,generation TEXT NOT NULL,appearances INTEGER NOT NULL DEFAULT 0,wins INTEGER NOT NULL DEFAULT 0,
    contributors INTEGER NOT NULL DEFAULT 0,availability INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(board_id,generation));
    CREATE TABLE IF NOT EXISTS community_bingo_groups (
    board_id TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL,subject TEXT NOT NULL,count INTEGER NOT NULL,
    PRIMARY KEY(board_id,generation,kind,subject));
    CREATE INDEX IF NOT EXISTS community_bingo_group_max ON community_bingo_groups(board_id,generation,kind,count DESC);`);
  if (migrate) {
    sql.exec(`INSERT INTO community_bingo_evidence SELECT board_id,board_id,guild_id,evidence_key,discord_id,public_id,
      kind,game_id,at,won,linked_at FROM community_bingo_evidence_legacy;
      DROP TABLE community_bingo_evidence_legacy;
      INSERT INTO community_bingo_groups SELECT board_id,generation,'contributor',public_id,COUNT(*)
      FROM community_bingo_evidence WHERE kind='game' GROUP BY board_id,generation,public_id;
      INSERT INTO community_bingo_groups SELECT board_id,generation,'shared',game_id,COUNT(*)
      FROM community_bingo_evidence WHERE kind='game' GROUP BY board_id,generation,game_id;
      INSERT INTO community_bingo_totals SELECT board_id,generation,SUM(kind='game'),SUM(kind='game' AND won=1),
      COUNT(DISTINCT CASE WHEN kind='game' THEN public_id END),SUM(kind='availability')
      FROM community_bingo_evidence GROUP BY board_id,generation;`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS community_bingo_evidence_member ON community_bingo_evidence(discord_id,guild_id,kind,board_id);
    CREATE INDEX IF NOT EXISTS community_bingo_evidence_account ON community_bingo_evidence(public_id,board_id);
    CREATE INDEX IF NOT EXISTS community_bingo_evidence_guild ON community_bingo_evidence(guild_id,kind,at,board_id);
    CREATE INDEX IF NOT EXISTS community_bingo_evidence_time ON community_bingo_evidence(board_id,generation,kind,at);
    INSERT OR IGNORE INTO community_bingo_generations(id,board_id,guild_id,status,created_at,updated_at)
    SELECT evidence_generation,id,guild_id,'current',created_at,created_at FROM community_bingo_boards;
    CREATE TRIGGER IF NOT EXISTS bingo_evidence_insert AFTER INSERT ON community_bingo_evidence BEGIN
      INSERT INTO community_bingo_totals(board_id,generation,appearances,wins,contributors,availability)
      VALUES(NEW.board_id,NEW.generation,NEW.kind='game',NEW.kind='game' AND NEW.won=1,
        NEW.kind='game' AND NOT EXISTS (SELECT 1 FROM community_bingo_groups
          WHERE board_id=NEW.board_id AND generation=NEW.generation AND kind='contributor' AND subject=NEW.public_id),
        NEW.kind='availability') ON CONFLICT(board_id,generation) DO UPDATE SET
        appearances=appearances+excluded.appearances,wins=wins+excluded.wins,
        contributors=contributors+excluded.contributors,availability=availability+excluded.availability;
      INSERT INTO community_bingo_groups(board_id,generation,kind,subject,count)
      SELECT NEW.board_id,NEW.generation,'contributor',NEW.public_id,1 WHERE NEW.kind='game'
      ON CONFLICT(board_id,generation,kind,subject) DO UPDATE SET count=count+1;
      INSERT INTO community_bingo_groups(board_id,generation,kind,subject,count)
      SELECT NEW.board_id,NEW.generation,'shared',NEW.game_id,1 WHERE NEW.kind='game'
      ON CONFLICT(board_id,generation,kind,subject) DO UPDATE SET count=count+1;
    END;
    CREATE TRIGGER IF NOT EXISTS bingo_evidence_delete AFTER DELETE ON community_bingo_evidence BEGIN
      UPDATE community_bingo_totals SET appearances=appearances-(OLD.kind='game'),wins=wins-(OLD.kind='game' AND OLD.won=1),
        availability=availability-(OLD.kind='availability'),contributors=contributors-(OLD.kind='game' AND EXISTS
        (SELECT 1 FROM community_bingo_groups WHERE board_id=OLD.board_id AND generation=OLD.generation
          AND kind='contributor' AND subject=OLD.public_id AND count=1))
        WHERE board_id=OLD.board_id AND generation=OLD.generation;
      UPDATE community_bingo_groups SET count=count-1 WHERE board_id=OLD.board_id AND generation=OLD.generation
        AND OLD.kind='game' AND kind='contributor' AND subject=OLD.public_id;
      UPDATE community_bingo_groups SET count=count-1 WHERE board_id=OLD.board_id AND generation=OLD.generation
        AND OLD.kind='game' AND kind='shared' AND subject=OLD.game_id;
      DELETE FROM community_bingo_groups WHERE board_id=OLD.board_id AND generation=OLD.generation
        AND kind='contributor' AND subject=OLD.public_id AND count=0;
      DELETE FROM community_bingo_groups WHERE board_id=OLD.board_id AND generation=OLD.generation
        AND kind='shared' AND subject=OLD.game_id AND count=0;
    END;
    CREATE TRIGGER IF NOT EXISTS bingo_evidence_update AFTER UPDATE OF won ON community_bingo_evidence
    WHEN NEW.kind='game' AND NEW.won<>OLD.won BEGIN
      UPDATE community_bingo_totals SET wins=wins+NEW.won-OLD.won WHERE board_id=NEW.board_id AND generation=NEW.generation;
    END;`);
}
export function currentBingoGeneration(sql: DatabaseSync, boardId: string): string {
  return String(sql.prepare('SELECT evidence_generation FROM community_bingo_boards WHERE id=?').get(boardId)!.evidence_generation);
}
export function writeBingoEvidence(sql: DatabaseSync, guildId: string, generation: string, item: BingoEvidence): void {
  sql.prepare(`INSERT INTO community_bingo_evidence
    (board_id,generation,guild_id,evidence_key,discord_id,public_id,kind,game_id,at,won,linked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(board_id,generation,evidence_key) DO UPDATE SET discord_id=excluded.discord_id,at=excluded.at,
    won=excluded.won,linked_at=excluded.linked_at WHERE discord_id IS NOT excluded.discord_id OR at IS NOT excluded.at
    OR won IS NOT excluded.won OR linked_at IS NOT excluded.linked_at`)
    .run(item.boardId, generation, guildId, item.key, item.discordId, item.publicId, item.kind, item.gameId, item.at, Number(item.won), item.linkedAt ?? null);
}
export function bingoGenerationProgress(sql: DatabaseSync, boardId: string): {
  appearances: number; wins: number; contributors: number; shared_game: number; availability: number;
} {
  const generation = currentBingoGeneration(sql, boardId);
  const totals = sql.prepare('SELECT appearances,wins,contributors,availability FROM community_bingo_totals WHERE board_id=? AND generation=?').get(boardId, generation);
  const group = sql.prepare(`SELECT count FROM community_bingo_groups WHERE board_id=? AND generation=? AND kind='shared'
    ORDER BY count DESC LIMIT 1`).get(boardId, generation);
  return { appearances: Number(totals?.appearances ?? 0), wins: Number(totals?.wins ?? 0),
    contributors: Number(totals?.contributors ?? 0), shared_game: Number(group?.count ?? 0), availability: Number(totals?.availability ?? 0) };
}
