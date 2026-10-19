import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CommandError } from '../commandError.js';
import { DeliveryStore } from './deliveries.js';
import { withCommunityTransaction } from './transactions.js';
import { bingoAvailabilityKey, bingoGameKey, type BingoEvidence } from './bingoEvidence.js';
import type { IdentityBinding } from './types.js';
import type { StoredPlayerSession } from '../historyStore.js';
export type { BingoEvidence } from './bingoEvidence.js';

export interface BingoObjective {
  kind: 'appearances' | 'wins' | 'contributors' | 'shared_game' | 'availability' | 'manual';
  target: number;
  label: string;
}
export interface BingoCell { index: number; objective: BingoObjective | null; complete: boolean; progress: number }
export interface BingoBoard {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  createdAt: number;
  closesAt: number | null;
  status: 'draft' | 'active' | 'archived';
  revision: number;
  cells: BingoCell[];
}
export interface BingoSnapshot {
  guildId: string;
  boardId: string;
  revision: number;
  version: string;
  retentionStart: number;
  now: number;
  validUntil: number;
}
export interface BingoGameCursor { start: string; publicId: string; gameId: string }
interface ValidationContext {
  state: ReturnType<BingoStore['gameEvidenceState']>;
  tags: Set<string>;
  identities: Map<string, boolean>;
}
const DAY = 86_400_000;
const changed = () => new CommandError('This bingo board or its evidence changed. Reopen /bingo view and refresh.');

export function defaultBingoObjectives(): BingoObjective[] {
  const objectives: BingoObjective[] = [];
  for (const target of [5, 15, 30]) objectives.push({ kind: 'appearances', target, label: `Record ${target} public Team appearances` });
  for (const target of [1, 5, 10]) objectives.push({ kind: 'wins', target, label: `Record ${target} public Team wins` });
  for (const target of [2, 5, 8]) objectives.push({ kind: 'contributors', target, label: `Have ${target} different linked members finish public Team games` });
  for (const target of [2, 3]) objectives.push({ kind: 'shared_game', target, label: `Have ${target} linked clan members finish the same Team game` });
  objectives.push({ kind: 'availability', target: 3, label: 'Have 3 different members save availability after board creation' });
  for (const label of ['Win on Europe', 'Win on World', 'Win on Black Sea', 'Win without nukes',
    'Win a naval-focused match', 'Make a comeback win', 'Teach a newcomer', 'Hold a training session',
    'Finish a full-squad session', 'Share a clan group screenshot', 'Play three different maps', 'Finish a clan night']) {
    objectives.push({ kind: 'manual', target: 1, label });
  }
  return objectives;
}

export function evaluateBingo(cells: BingoCell[], evidence: BingoEvidence[], approvedCells: Set<number>): {
  cells: BingoCell[]; lines: string[]; complete: boolean;
} {
  const games = new Map<string, BingoEvidence>();
  const availability = new Set<string>();
  for (const item of evidence) {
    if (item.kind === 'availability') availability.add(item.discordId);
    else if (item.publicId && item.gameId) games.set(bingoGameKey(item.publicId, item.gameId), item);
  }
  const contributors = new Set<string>();
  const groups = new Map<string, Set<string>>();
  let wins = 0;
  for (const item of games.values()) {
    contributors.add(item.publicId!);
    const members = groups.get(item.gameId!) ?? new Set<string>();
    members.add(item.publicId!);
    groups.set(item.gameId!, members);
    if (item.won) wins++;
  }
  let largest = 0;
  for (const group of groups.values()) largest = Math.max(largest, group.size);
  const progress = { appearances: games.size, wins, contributors: contributors.size, shared_game: largest, availability: availability.size };
  const evaluated = cells.map(cell => {
    if (cell.index === 12) return { ...cell, objective: null, progress: 1, complete: true };
    const objective = cell.objective!;
    const value = objective.kind === 'manual' ? Number(approvedCells.has(cell.index)) : progress[objective.kind];
    return { ...cell, objective: { ...objective }, progress: value, complete: value >= objective.target };
  });
  const completed = new Set(evaluated.filter(cell => cell.complete).map(cell => cell.index));
  const lines: string[] = [];
  for (let row = 0; row < 5; row++) if ([0, 1, 2, 3, 4].every(column => completed.has(row * 5 + column))) lines.push(`row:${row}`);
  for (let column = 0; column < 5; column++) if ([0, 1, 2, 3, 4].every(row => completed.has(row * 5 + column))) lines.push(`column:${column}`);
  if ([0, 6, 12, 18, 24].every(index => completed.has(index))) lines.push('diagonal:0');
  if ([4, 8, 12, 16, 20].every(index => completed.has(index))) lines.push('diagonal:1');
  return { cells: evaluated, lines, complete: evaluated.length === 25 && evaluated.every(cell => cell.complete) };
}

function decode(row: Record<string, unknown>): BingoBoard {
  return { id: String(row.id), guildId: String(row.guild_id), channelId: String(row.channel_id),
    messageId: row.message_id as string | null, createdAt: Number(row.created_at), closesAt: row.closes_at as number | null,
    status: row.status as BingoBoard['status'], revision: Number(row.revision), cells: JSON.parse(String(row.cells)) };
}
export class BingoStore {
  constructor(private readonly sql: DatabaseSync, private readonly identityCurrent?: (binding: IdentityBinding) => boolean) {}

  static initialize(sql: DatabaseSync): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS community_bingo_boards (
      id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,
      closes_at INTEGER,status TEXT NOT NULL,revision INTEGER NOT NULL,cells TEXT NOT NULL,lines TEXT NOT NULL DEFAULT '[]',
      archived_at INTEGER,source_version TEXT,next_expiry INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS community_bingo_active ON community_bingo_boards(guild_id) WHERE status='active';
      CREATE INDEX IF NOT EXISTS community_bingo_guild ON community_bingo_boards(guild_id,status,id);
      CREATE INDEX IF NOT EXISTS community_bingo_active_page ON community_bingo_boards(status,id);
      CREATE INDEX IF NOT EXISTS community_bingo_retention ON community_bingo_boards(status,archived_at,id);
      CREATE TABLE IF NOT EXISTS community_bingo_evidence (
      board_id TEXT NOT NULL,guild_id TEXT NOT NULL,evidence_key TEXT NOT NULL,discord_id TEXT NOT NULL,public_id TEXT,
      kind TEXT NOT NULL,game_id TEXT,at INTEGER NOT NULL,won INTEGER NOT NULL,linked_at TEXT,
      PRIMARY KEY(board_id,evidence_key));
      CREATE INDEX IF NOT EXISTS community_bingo_evidence_member ON community_bingo_evidence(discord_id,guild_id,kind,board_id);
      CREATE INDEX IF NOT EXISTS community_bingo_evidence_account ON community_bingo_evidence(public_id,board_id);
      CREATE INDEX IF NOT EXISTS community_bingo_evidence_guild ON community_bingo_evidence(guild_id,kind,board_id);
      CREATE INDEX IF NOT EXISTS community_bingo_evidence_time ON community_bingo_evidence(board_id,kind,at);
      CREATE TABLE IF NOT EXISTS community_bingo_approvals (
      board_id TEXT NOT NULL,cell_index INTEGER NOT NULL,approved INTEGER NOT NULL,PRIMARY KEY(board_id,cell_index));
      CREATE TABLE IF NOT EXISTS community_bingo_audit (
      id INTEGER PRIMARY KEY,board_id TEXT NOT NULL,cell_index INTEGER NOT NULL,approved INTEGER NOT NULL,
      actor_id TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS community_bingo_audit_board ON community_bingo_audit(board_id,id);
      CREATE TABLE IF NOT EXISTS community_bingo_notifications (
      board_id TEXT NOT NULL,line_key TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(board_id,line_key));
      CREATE TABLE IF NOT EXISTS community_bingo_sources (
      guild_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,eligibility TEXT);`);
    if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_player_matches'").get()) {
      sql.exec('CREATE INDEX IF NOT EXISTS history_bingo_page ON history_player_matches(guild_id,game_start,public_id,game_id)');
    }
    for (const table of ['history_player_matches', 'community_availability'] as const) {
      if (!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      BingoStore.initializeSourceTriggers(sql, table);
    }
  }
  static initializeSourceTriggers(sql: DatabaseSync, table: 'history_player_matches' | 'community_availability'): void {
    const condition = table === 'history_player_matches'
      ? 'OLD.payload IS NOT NEW.payload OR OLD.discord_id IS NOT NEW.discord_id OR OLD.game_start IS NOT NEW.game_start'
      : 'OLD.windows IS NOT NEW.windows OR OLD.updated_at IS NOT NEW.updated_at OR OLD.revision IS NOT NEW.revision';
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = operation === 'DELETE' ? 'OLD' : 'NEW';
      sql.exec(`CREATE TRIGGER IF NOT EXISTS bingo_source_${table}_${operation} AFTER ${operation} ON ${table}
        ${operation === 'UPDATE' ? `WHEN ${condition}` : ''} BEGIN
        INSERT INTO community_bingo_sources(guild_id,revision) VALUES(${ref}.guild_id,1)
        ON CONFLICT(guild_id) DO UPDATE SET revision=revision+1; END;`);
    }
  }
  private require(guildId: string, boardId: string, revision?: number): BingoBoard {
    const board = this.get(guildId, boardId);
    if (!board || board.status === 'archived' || (revision !== undefined && board.revision !== revision)) throw changed();
    return board;
  }
  createDraft(guildId: string, channelId: string, objectives: BingoObjective[], closesAt: number | null, now: number): BingoBoard {
    const kinds = new Set(['appearances', 'wins', 'contributors', 'shared_game', 'availability', 'manual']);
    if (!guildId || !channelId || !Number.isSafeInteger(now) || (closesAt !== null && (!Number.isSafeInteger(closesAt) || closesAt <= now)) ||
        !Array.isArray(objectives) || objectives.length !== 24 || objectives.some(objective => !objective ||
          !kinds.has(objective.kind) || !Number.isSafeInteger(objective.target) || objective.target < 1 || objective.target > 1_000_000 ||
          (objective.kind === 'manual' && objective.target !== 1) || typeof objective.label !== 'string' ||
          !objective.label.trim() || objective.label.length > 160)) throw new CommandError('Choose 24 valid bingo challenges and a future closing date.');
    let next = 0;
    const cells = Array.from({ length: 25 }, (_, index) => ({ index, objective: index === 12 ? null : { ...objectives[next++] },
      complete: index === 12, progress: index === 12 ? 1 : 0 }));
    const id = randomUUID();
    this.sql.prepare(`INSERT INTO community_bingo_boards(id,guild_id,channel_id,created_at,closes_at,status,revision,cells)
      VALUES(?,?,?,?,?,'draft',1,?)`).run(id, guildId, channelId, now, closesAt, JSON.stringify(cells));
    return this.get(guildId, id)!;
  }
  get(guildId: string, boardId: string): BingoBoard | null {
    const row = this.sql.prepare('SELECT * FROM community_bingo_boards WHERE guild_id=? AND id=?').get(guildId, boardId);
    return row ? decode(row) : null;
  }
  getActive(guildId: string): BingoBoard | null {
    const row = this.sql.prepare("SELECT * FROM community_bingo_boards WHERE guild_id=? AND status='active'").get(guildId);
    return row ? decode(row) : null;
  }
  /** Keyset page for fair worker traversal; no guild history is loaded here. */
  activeBoards(afterId = '', limit = 20): BingoBoard[] {
    return this.sql.prepare("SELECT * FROM community_bingo_boards WHERE status='active' AND id>? ORDER BY id LIMIT ?")
      .all(afterId, Math.max(0, Math.min(200, Math.floor(limit)))).map(decode);
  }
  publish(guildId: string, boardId: string, revision: number, messageId: string): BingoBoard {
    return withCommunityTransaction(this.sql, () => {
      const board = this.require(guildId, boardId, revision);
      if (!messageId || (board.status === 'active' && board.messageId !== messageId)) throw changed();
      const current = this.getActive(guildId);
      if (current && current.id !== boardId) throw new CommandError('Archive the current bingo board before publishing its replacement.');
      this.sql.prepare("UPDATE community_bingo_boards SET status='active',message_id=? WHERE id=? AND (status<>'active' OR message_id IS NOT ?)")
        .run(messageId, boardId, messageId);
      return this.get(guildId, boardId)!;
    });
  }
  gameEvidenceState(guildId: string, now: number): { status: 'observed' | 'disabled' | 'unavailable'; retentionStart: number; retentionDays: number } {
    const settings = this.sql.prepare('SELECT player_history_enabled,collection_enabled,retention_days FROM history_settings WHERE guild_id=?').get(guildId);
    const days = settings ? Number(settings.retention_days) : 90;
    const meta = this.sql.prepare("SELECT key,value FROM history_meta WHERE key IN ('deletions_last_success','deletions_error')").all();
    const values = new Map(meta.map(row => [String(row.key), String(row.value)]));
    const checkpoint = Date.parse(values.get('deletions_last_success') ?? '');
    const enabled = settings && settings.player_history_enabled === 1 && settings.collection_enabled === 1;
    const healthy = Number.isFinite(checkpoint) && checkpoint <= now && now - checkpoint < DAY && !values.get('deletions_error');
    return { status: !enabled ? 'disabled' : healthy ? 'observed' : 'unavailable', retentionDays: days, retentionStart: now - days * DAY };
  }
  private sourceVersion(guildId: string, now: number): string {
    const source = this.sql.prepare('SELECT revision FROM community_bingo_sources WHERE guild_id=?').get(guildId);
    const settings = this.sql.prepare('SELECT revision FROM history_settings WHERE guild_id=?').get(guildId);
    return `${source?.revision ?? 0}:${settings?.revision ?? 0}:${this.gameEvidenceState(guildId, now).status}`;
  }
  /** Call once with a fresh full human-member inventory before checking dirty state.
   * Bindings are the currently eligible effective game identities; members also include unlinked humans. */
  syncEvidenceEligibility(guildId: string, bindings: IdentityBinding[], memberIds: Iterable<string>, clanTags: Iterable<string>): void {
    const members = [...new Set(memberIds)].sort();
    const present = new Set(members);
    const identities = bindings.filter(binding => binding.guildId === guildId && present.has(binding.discordId) &&
      (!this.identityCurrent || this.identityCurrent(binding)))
      .map(binding => [binding.discordId, binding.publicId, binding.linkedAt]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const tags = [...new Set([...clanTags].map(tag => tag.trim().toUpperCase()))].sort();
    const fingerprint = createHash('sha256').update(JSON.stringify([members, identities, tags])).digest('hex');
    this.sql.prepare(`INSERT INTO community_bingo_sources(guild_id,revision,eligibility) VALUES(?,1,?)
      ON CONFLICT(guild_id) DO UPDATE SET revision=revision+1,eligibility=excluded.eligibility
      WHERE eligibility IS NOT excluded.eligibility`).run(guildId, fingerprint);
  }
  evidenceSnapshot(guildId: string, boardId: string, now: number): BingoSnapshot {
    const board = this.require(guildId, boardId);
    const state = this.gameEvidenceState(guildId, now);
    const first = this.sql.prepare(`SELECT game_start FROM history_player_matches WHERE guild_id=? AND game_start>=?
      ${board.closesAt === null ? '' : 'AND game_start<?'} ORDER BY game_start,public_id,game_id LIMIT 1`)
      .get(guildId, new Date(Math.max(state.retentionStart, board.createdAt)).toISOString(),
        ...(board.closesAt === null ? [] : [new Date(board.closesAt).toISOString()]));
    const validUntil = first ? Date.parse(String(first.game_start)) + state.retentionDays * DAY + 1 : now + DAY;
    return { guildId, boardId, revision: board.revision, version: this.sourceVersion(guildId, now),
      retentionStart: state.retentionStart, now, validUntil };
  }
  private assertSnapshot(snapshot: BingoSnapshot, now: number): BingoBoard {
    const board = this.require(snapshot.guildId, snapshot.boardId, snapshot.revision);
    if (now < snapshot.now || now >= snapshot.validUntil || this.sourceVersion(snapshot.guildId, now) !== snapshot.version) throw changed();
    return board;
  }
  needsEvidenceRefresh(guildId: string, boardId: string, now: number): boolean {
    this.require(guildId, boardId);
    const row = this.sql.prepare('SELECT source_version,next_expiry FROM community_bingo_boards WHERE id=?').get(boardId)!;
    return row.source_version !== this.sourceVersion(guildId, now) || (row.next_expiry !== null && Number(row.next_expiry) <= now);
  }
  readGamePage(snapshot: BingoSnapshot, cursor: BingoGameCursor | null = null, limit = 200, now = Date.now()): {
    matches: StoredPlayerSession[]; next: BingoGameCursor | null;
  } {
    const board = this.assertSnapshot(snapshot, now);
    const lower = new Date(Math.max(snapshot.retentionStart, board.createdAt)).toISOString();
    const take = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.sql.prepare(`SELECT public_id,discord_id,game_id,game_start,payload FROM history_player_matches
      WHERE guild_id=? AND game_start>=? ${board.closesAt === null ? '' : 'AND game_start<?'}
      ${cursor ? 'AND (game_start,public_id,game_id)>(?,?,?)' : ''}
      ORDER BY game_start,public_id,game_id LIMIT ?`).all(snapshot.guildId, lower,
        ...(board.closesAt === null ? [] : [new Date(board.closesAt).toISOString()]),
        ...(cursor ? [cursor.start, cursor.publicId, cursor.gameId] : []), take + 1);
    const page = rows.slice(0, take);
    const last = page.at(-1);
    return { matches: page.map(row => ({ ...JSON.parse(String(row.payload)), public_id: String(row.public_id), discord_id: String(row.discord_id) })),
      next: rows.length > take && last ? { start: String(last.game_start), publicId: String(last.public_id), gameId: String(last.game_id) } : null };
  }
  private validationContext(guildId: string, now: number): ValidationContext {
    return { state: this.gameEvidenceState(guildId, now), identities: new Map(),
      tags: new Set(this.sql.prepare('SELECT clan_tag FROM guild_clan_configs WHERE guild_id=?').all(guildId)
        .map(row => String(row.clan_tag).trim().toUpperCase())) };
  }
  private canonical(board: BingoBoard, item: BingoEvidence, context: ValidationContext): BingoEvidence | null {
    if (item.boardId !== board.id || !item.discordId || !Number.isSafeInteger(item.at) || item.at < board.createdAt ||
        (board.closesAt !== null && item.at >= board.closesAt)) return null;
    if (item.kind === 'availability') {
      const row = this.sql.prepare('SELECT updated_at,windows FROM community_availability WHERE guild_id=? AND discord_id=?')
        .get(board.guildId, item.discordId);
      if (!row || !row.windows || !JSON.parse(String(row.windows)).length || Number(row.updated_at) !== item.at) return null;
      return { ...item, key: bingoAvailabilityKey(item.discordId), publicId: null, gameId: null, won: false, linkedAt: undefined };
    }
    const state = context.state;
    if (item.kind !== 'game' || state.status !== 'observed' || item.at < state.retentionStart || !item.publicId || !item.gameId || !item.linkedAt) return null;
    const bindingKey = JSON.stringify([item.discordId, item.publicId, item.linkedAt]);
    if (!context.identities.has(bindingKey)) {
      const binding = { guildId: board.guildId, discordId: item.discordId, publicId: item.publicId, linkedAt: item.linkedAt };
      context.identities.set(bindingKey, (!this.identityCurrent || this.identityCurrent(binding)) &&
        !this.sql.prepare('SELECT 1 FROM history_deleted_players WHERE public_id=?').get(item.publicId));
    }
    if (!context.identities.get(bindingKey)) return null;
    const row = this.sql.prepare('SELECT discord_id,payload FROM history_player_matches WHERE guild_id=? AND public_id=? AND game_id=?')
      .get(board.guildId, item.publicId, item.gameId);
    if (!row || row.discord_id !== item.discordId) return null;
    const match = JSON.parse(String(row.payload)) as StoredPlayerSession;
    if (Date.parse(match.gameStart) !== item.at || !match.gameEnd || !Number.isFinite(Date.parse(match.gameEnd)) ||
        Date.parse(match.gameEnd) < item.at || match.gameType !== 'Public' || match.gameMode !== 'Team' ||
        !match.clanTag || !context.tags.has(match.clanTag.trim().toUpperCase())) return null;
    // Current Discord/clan eligibility is the fresh inventory consumer's responsibility.
    return { ...item, key: bingoGameKey(item.publicId, item.gameId), won: match.hasWon === true };
  }
  /** Atomic whole-snapshot replacement. Awaited callers MUST pass the token captured before any await.
   * Accumulate bounded pages externally; never finalize a partial scan. */
  replaceEvidence(guildId: string, boardId: string, revision: number, evidence: BingoEvidence[], snapshot?: BingoSnapshot, now = Date.now()): void {
    withCommunityTransaction(this.sql, () => {
      const board = this.require(guildId, boardId, revision);
      const at = now;
      if (snapshot && (snapshot.guildId !== guildId || snapshot.boardId !== boardId || snapshot.revision !== revision)) throw changed();
      if (snapshot) this.assertSnapshot(snapshot, at);
      const current = new Map(this.listEvidence(guildId, boardId).map(item => [item.key, item]));
      const desired = new Map<string, BingoEvidence>();
      const context = this.validationContext(guildId, at);
      for (const item of evidence) {
        const accepted = this.canonical(board, item, context);
        if (accepted) desired.set(accepted.key, accepted);
      }
      const remove = this.sql.prepare('DELETE FROM community_bingo_evidence WHERE board_id=? AND evidence_key=?');
      for (const key of current.keys()) if (!desired.has(key)) remove.run(boardId, key);
      const upsert = this.sql.prepare(`INSERT INTO community_bingo_evidence
        (board_id,guild_id,evidence_key,discord_id,public_id,kind,game_id,at,won,linked_at) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(board_id,evidence_key) DO UPDATE SET discord_id=excluded.discord_id,public_id=excluded.public_id,
        kind=excluded.kind,game_id=excluded.game_id,at=excluded.at,won=excluded.won,linked_at=excluded.linked_at`);
      for (const [key, item] of desired) {
        const previous = current.get(key);
        if (previous && previous.discordId === item.discordId && previous.publicId === item.publicId && previous.kind === item.kind &&
            previous.gameId === item.gameId && previous.at === item.at && previous.won === item.won && previous.linkedAt === item.linkedAt) continue;
        upsert.run(boardId, guildId, key, item.discordId, item.publicId, item.kind, item.gameId, item.at, Number(item.won), item.linkedAt ?? null);
      }
      this.evaluate(board, at);
      const version = this.sourceVersion(guildId, at);
      const first = this.sql.prepare("SELECT MIN(at) AS at FROM community_bingo_evidence WHERE board_id=? AND kind='game'").get(boardId)!;
      const nextExpiry = first.at === null ? null : Number(first.at) + this.gameEvidenceState(guildId, at).retentionDays * DAY + 1;
      this.sql.prepare(`UPDATE community_bingo_boards SET source_version=?,next_expiry=? WHERE id=?
        AND (source_version IS NOT ? OR next_expiry IS NOT ?)`).run(version, nextExpiry, boardId, version, nextExpiry);
    });
  }
  listEvidence(guildId: string, boardId: string): BingoEvidence[] {
    return this.sql.prepare('SELECT * FROM community_bingo_evidence WHERE guild_id=? AND board_id=? ORDER BY evidence_key').all(guildId, boardId)
      .map(row => ({ key: String(row.evidence_key), boardId, discordId: String(row.discord_id), publicId: row.public_id as string | null,
        kind: row.kind as BingoEvidence['kind'], gameId: row.game_id as string | null, at: Number(row.at), won: !!row.won,
        linkedAt: row.linked_at === null ? undefined : String(row.linked_at) }));
  }
  private evaluate(board: BingoBoard, now: number): BingoBoard {
    const approvals = this.sql.prepare('SELECT cell_index FROM community_bingo_approvals WHERE board_id=? AND approved=1').all(board.id);
    const result = evaluateBingo(board.cells, this.listEvidence(board.guildId, board.id), new Set(approvals.map(row => Number(row.cell_index))));
    const cells = JSON.stringify(result.cells);
    const lines = JSON.stringify(result.lines);
    this.sql.prepare('UPDATE community_bingo_boards SET cells=?,lines=? WHERE id=? AND (cells<>? OR lines<>?)').run(cells, lines, board.id, cells, lines);
    if (board.status === 'active') {
      const notifications = result.complete ? [...result.lines, 'board'] : result.lines;
      for (const line of notifications) {
        const inserted = this.sql.prepare('INSERT OR IGNORE INTO community_bingo_notifications(board_id,line_key,at) VALUES(?,?,?)').run(board.id, line, now);
        if (inserted.changes) new DeliveryStore(this.sql).enqueue({ key: `bingo:${board.id}:${line}`, guildId: board.guildId,
          channelId: board.channelId, kind: 'bingo_complete', subjectId: board.id, revision: board.revision, dueAt: now,
          part: line === 'board' ? 12 : line.startsWith('row:') ? Number(line.slice(4)) : line.startsWith('column:') ? 5 + Number(line.slice(7)) : 10 + Number(line.slice(9)) });
      }
    }
    return { ...board, cells: result.cells };
  }
  /** Lifecycle removal already validated the deletion scope; recompute without accepting new observations. */
  recompute(guildId: string, boardId: string, now: number): BingoBoard {
    return this.evaluate(this.require(guildId, boardId), now);
  }
  refresh(guildId: string, boardId: string, now: number): BingoBoard {
    return withCommunityTransaction(this.sql, () => {
      const board = this.require(guildId, boardId);
      if (!this.needsEvidenceRefresh(guildId, boardId, now)) return board;
      const evidence = this.listEvidence(guildId, boardId);
      const context = this.validationContext(guildId, now);
      const remove = this.sql.prepare('DELETE FROM community_bingo_evidence WHERE board_id=? AND evidence_key=?');
      const update = this.sql.prepare('UPDATE community_bingo_evidence SET won=? WHERE board_id=? AND evidence_key=?');
      for (const item of evidence) {
        const canonical = this.canonical(board, item, context);
        if (!canonical) remove.run(boardId, item.key);
        else if (canonical.won !== item.won) update.run(Number(canonical.won), boardId, item.key);
      }
      return this.evaluate(board, now);
    });
  }
  getProgress(guildId: string, boardId: string): { lines: string[]; complete: boolean } {
    const row = this.sql.prepare('SELECT lines,cells FROM community_bingo_boards WHERE guild_id=? AND id=?').get(guildId, boardId);
    if (!row) throw changed();
    return { lines: JSON.parse(String(row.lines)), complete: (JSON.parse(String(row.cells)) as BingoCell[]).every(cell => cell.complete) };
  }
  setManualApproval(guildId: string, boardId: string, revision: number, index: number, approved: boolean, actorId: string, reason: string, now: number): void {
    withCommunityTransaction(this.sql, () => {
      let board = this.require(guildId, boardId, revision);
      if (board.status !== 'active' || !Number.isInteger(index) || index === 12 || board.cells[index]?.objective?.kind !== 'manual' ||
          !actorId || typeof approved !== 'boolean' || !reason.trim() || reason.length > 1000 || !Number.isSafeInteger(now)) throw new CommandError('Choose a manual cell and supply an audit reason.');
      board = this.refresh(guildId, boardId, now);
      this.sql.prepare(`INSERT INTO community_bingo_approvals(board_id,cell_index,approved) VALUES(?,?,?)
        ON CONFLICT(board_id,cell_index) DO UPDATE SET approved=excluded.approved`).run(boardId, index, Number(approved));
      this.sql.prepare('INSERT INTO community_bingo_audit(board_id,cell_index,approved,actor_id,reason,at) VALUES(?,?,?,?,?,?)')
        .run(boardId, index, Number(approved), actorId, reason, now);
      this.evaluate(board, now);
    });
  }
  archive(guildId: string, boardId: string, revision: number, now: number): void {
    withCommunityTransaction(this.sql, () => {
      this.require(guildId, boardId, revision);
      this.sql.prepare("UPDATE community_bingo_boards SET status='archived',revision=revision+1,archived_at=? WHERE id=?").run(now, boardId);
      for (const kind of ['bingo_publish', 'bingo_update', 'bingo_complete']) new DeliveryStore(this.sql).cancelSubject(guildId, kind, boardId);
    });
  }
}
