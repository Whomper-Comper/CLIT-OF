import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CommandError } from '../commandError.js';
import { DeliveryStore } from './deliveries.js';
import { withCommunityTransaction } from './transactions.js';
import { bingoAvailabilityKey, bingoGameKey, collectBingoEvidence, type BingoEvidence } from './bingoEvidence.js';
import { initializeBingoGenerations, currentBingoGeneration, writeBingoEvidence, bingoGenerationProgress } from './bingoGenerations.js';
import type { MemberAvailability } from './availability.js';
import type { IdentityBinding } from './types.js';
import type { StoredPlayerSession } from '../historyStore.js';
import { BingoClaims, initializeBingoClaims } from './bingoClaims.js';
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
  return evaluateProgress(cells, progress, approvedCells);
}
function evaluateProgress(cells: BingoCell[], progress: ReturnType<typeof bingoGenerationProgress>, approvedCells: Set<number>): {
  cells: BingoCell[]; lines: string[]; complete: boolean;
} {
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
function lineCells(key: string): number[] {
  if (key === 'board') return Array.from({ length: 25 }, (_, index) => index);
  const [kind, value] = key.split(':');
  const index = Number(value);
  if (kind === 'row') return [0, 1, 2, 3, 4].map(column => index * 5 + column);
  if (kind === 'column') return [0, 1, 2, 3, 4].map(row => row * 5 + index);
  return index === 0 ? [0, 6, 12, 18, 24] : [4, 8, 12, 16, 20];
}
function draftCells(objectives: BingoObjective[], closesAt: number | null, now: number): BingoCell[] {
  const kinds = new Set(['appearances', 'wins', 'contributors', 'shared_game', 'availability', 'manual']);
  if (!Number.isSafeInteger(now) || (closesAt !== null && (!Number.isSafeInteger(closesAt) || closesAt <= now)) ||
      !Array.isArray(objectives) || objectives.length !== 24 || objectives.some(objective => !objective ||
        !kinds.has(objective.kind) || !Number.isSafeInteger(objective.target) || objective.target < 1 || objective.target > 1_000_000 ||
        (objective.kind === 'manual' && objective.target !== 1) || typeof objective.label !== 'string' ||
        !objective.label.trim() || objective.label.length > 160)) {
    throw new CommandError('Choose 24 valid bingo challenges and a future closing date.');
  }
  let next = 0;
  return Array.from({ length: 25 }, (_, index) => ({ index, objective: index === 12 ? null : { ...objectives[next++] },
    complete: index === 12, progress: index === 12 ? 1 : 0 }));
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
    initializeBingoGenerations(sql);
    initializeBingoClaims(sql);
    const columns = new Set(sql.prepare('PRAGMA table_info(community_bingo_boards)').all().map(row => row.name));
    if (!columns.has('draft_owner')) sql.exec('ALTER TABLE community_bingo_boards ADD COLUMN draft_owner TEXT');
    sql.exec('CREATE INDEX IF NOT EXISTS community_bingo_draft_owner ON community_bingo_boards(guild_id,draft_owner,status,created_at DESC)');
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
  createDraft(guildId: string, channelId: string, objectives: BingoObjective[], closesAt: number | null, now: number, ownerId?: string): BingoBoard {
    if (!guildId || !channelId) throw changed();
    const cells = draftCells(objectives, closesAt, now);
    const id = randomUUID();
    return withCommunityTransaction(this.sql, () => {
      this.sql.prepare(`INSERT INTO community_bingo_boards(id,guild_id,channel_id,created_at,closes_at,status,revision,cells,evidence_generation,draft_owner)
        VALUES(?,?,?,?,?,'draft',1,?,?,?)`).run(id, guildId, channelId, now, closesAt, JSON.stringify(cells), id, ownerId ?? null);
      this.sql.prepare(`INSERT INTO community_bingo_generations(id,board_id,guild_id,status,created_at,updated_at)
        VALUES(?,?,?,'current',?,?)`).run(id, id, guildId, now, now);
      return this.get(guildId, id)!;
    });
  }
  get(guildId: string, boardId: string): BingoBoard | null {
    const row = this.sql.prepare('SELECT * FROM community_bingo_boards WHERE guild_id=? AND id=?').get(guildId, boardId);
    return row ? decode(row) : null;
  }
  draft(guildId: string, ownerId?: string): BingoBoard | null {
    const row = this.sql.prepare(`SELECT * FROM community_bingo_boards WHERE guild_id=? AND status='draft'
      ${ownerId === undefined ? '' : 'AND draft_owner=?'} ORDER BY created_at DESC,rowid DESC LIMIT 1`)
      .get(guildId, ...(ownerId === undefined ? [] : [ownerId]));
    return row ? decode(row) : null;
  }
  editDraft(guildId: string, boardId: string, revision: number, objectives: BingoObjective[], closesAt: number | null, now: number): BingoBoard {
    return withCommunityTransaction(this.sql, () => {
      const board = this.require(guildId, boardId, revision);
      if (board.status !== 'draft' || this.deliveryJobs(guildId, boardId).length) throw changed();
      const cells = draftCells(objectives, closesAt, now);
      this.sql.prepare('UPDATE community_bingo_boards SET cells=?,closes_at=?,revision=revision+1 WHERE id=?')
        .run(JSON.stringify(cells), closesAt, boardId);
      return this.get(guildId, boardId)!;
    });
  }
  requestPublish(guildId: string, boardId: string, revision: number, replace: { id: string; revision: number } | null, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const board = this.require(guildId, boardId, revision);
      if (board.status !== 'draft') throw changed();
      const active = this.getActive(guildId);
      if (replace) {
        if (!active || active.id !== replace.id || active.revision !== replace.revision) throw changed();
        this.archive(guildId, active.id, active.revision, now);
      } else if (active) throw new CommandError('Use /bingo reset to explicitly confirm replacement.');
      new DeliveryStore(this.sql).enqueue({ key: `bingo:${board.id}:publish:${revision}`, guildId,
        channelId: board.channelId, kind: 'bingo_publish', subjectId: board.id, revision, dueAt: now, part: 0 });
    });
  }
  deliveryJobs(guildId: string, boardId: string) {
    const rows = this.sql.prepare(`SELECT id FROM community_deliveries WHERE guild_id=? AND subject_id=?
      AND kind IN ('bingo_publish','bingo_update','bingo_complete') AND status IN ('paused','failed','needs_review','pending','sending')
      ORDER BY due_at DESC LIMIT 10`).all(guildId, boardId);
    const deliveries = new DeliveryStore(this.sql);
    return rows.map(row => deliveries.get(String(row.id))!);
  }
  queueUpdate(guildId: string, boardId: string, signature: string, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const board = this.require(guildId, boardId);
      if (board.status !== 'active' || !board.messageId) return;
      const state = this.sql.prepare('SELECT signature,sequence FROM community_bingo_public_state WHERE board_id=?').get(boardId);
      if (state?.signature === signature) return;
      const sequence = Number(state?.sequence ?? 0) + 1;
      this.sql.prepare(`INSERT INTO community_bingo_public_state(board_id,signature,sequence) VALUES(?,?,?)
        ON CONFLICT(board_id) DO UPDATE SET signature=excluded.signature,sequence=excluded.sequence`).run(boardId, signature, sequence);
      const deliveries = new DeliveryStore(this.sql);
      deliveries.cancelSubject(guildId, 'bingo_update', boardId, now);
      deliveries.enqueue({ key: `bingo:${boardId}:update:${sequence}`, guildId, channelId: board.channelId,
        kind: 'bingo_update', subjectId: boardId, revision: board.revision, dueAt: now, part: 0 });
    });
  }
  claim(guildId: string, boardId: string, cell: number, actorId: string, explanation: string, evidenceUrl: string | null, now: number) {
    return new BingoClaims(this.sql, this).claim(guildId, boardId, cell, actorId, explanation, evidenceUrl, now);
  }
  review(guildId: string, claimId: string, officerId: string, approve: boolean, reason: string, expectedRevision: number, now: number): void {
    new BingoClaims(this.sql, this).review(guildId, claimId, officerId, approve, reason, expectedRevision, now);
  }
  claims(guildId: string, boardId: string, page = 1) {
    return new BingoClaims(this.sql, this).list(guildId, boardId, page);
  }
  pendingCells(guildId: string, boardId: string): Set<number> {
    const board = this.get(guildId, boardId);
    const pending = new Set<number>();
    const query = this.sql.prepare("SELECT 1 FROM community_bingo_claims WHERE board_id=? AND cell_index=? AND guild_id=? AND status='pending' LIMIT 1");
    for (const cell of board?.cells ?? []) {
      if (cell.objective?.kind === 'manual' && query.get(boardId, cell.index, guildId)) pending.add(cell.index);
    }
    return pending;
  }
  findClaim(guildId: string, boardId: string, claimId: string) {
    return new BingoClaims(this.sql, this).find(guildId, boardId, claimId);
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
  beginEvidenceStage(snapshot: BingoSnapshot, now = Date.now()): string {
    return withCommunityTransaction(this.sql, () => {
      this.assertSnapshot(snapshot, now);
      this.sql.prepare("UPDATE community_bingo_generations SET status='abandoned',updated_at=? WHERE board_id=? AND status='staging'")
        .run(now, snapshot.boardId);
      const id = randomUUID();
      this.sql.prepare(`INSERT INTO community_bingo_generations(id,board_id,guild_id,status,snapshot,created_at,updated_at)
        VALUES(?,?,?,'staging',?,?,?)`).run(id, snapshot.boardId, snapshot.guildId, JSON.stringify(snapshot), now, now);
      return id;
    });
  }
  private stage(id: string, now: number): { row: Record<string, unknown>; snapshot: BingoSnapshot; board: BingoBoard } {
    const row = this.sql.prepare("SELECT * FROM community_bingo_generations WHERE id=? AND status='staging'").get(id);
    if (!row || !row.snapshot) throw changed();
    const snapshot = JSON.parse(String(row.snapshot)) as BingoSnapshot;
    return { row, snapshot, board: this.assertSnapshot(snapshot, now) };
  }
  /** Trusted producer: this call reads, parses, validates and stages at most 200 canonical source rows.
   * The consumer syncs the fresh inventory before continuing; no accumulated array is passed to finalization. */
  stageEvidencePage(id: string, identities: Map<string, IdentityBinding>, clanTags: Set<string>, currentMembers: Set<string>,
    now = Date.now(), limit = 200): { phase: 'games' | 'availability' | 'ready'; processed: number } {
    return withCommunityTransaction(this.sql, () => {
      const { row, snapshot, board } = this.stage(id, now);
      const take = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 200;
      let phase = row.phase as 'games' | 'availability' | 'ready';
      if (phase === 'ready') return { phase, processed: 0 };
      let matches: StoredPlayerSession[] = [];
      let available: MemberAvailability[] = [];
      let cursor: string | null = null;
      let processed: number;
      if (phase === 'games') {
        const page = this.readGamePage(snapshot, row.cursor ? JSON.parse(String(row.cursor)) : null, take, now);
        matches = page.matches;
        processed = matches.length;
        cursor = page.next ? JSON.stringify(page.next) : null;
        if (!page.next) phase = 'availability';
      } else {
        const rows = this.sql.prepare(`SELECT * FROM community_availability WHERE guild_id=? AND discord_id>?
          AND windows IS NOT NULL ORDER BY discord_id LIMIT ?`).all(board.guildId, row.cursor ? String(row.cursor) : '', take + 1);
        const page = rows.slice(0, take);
        available = page.map(item => ({ guildId: board.guildId, discordId: String(item.discord_id), timezone: String(item.timezone),
          windows: JSON.parse(String(item.windows)), revision: Number(item.revision), updatedAt: Number(item.updated_at) }));
        processed = available.length;
        cursor = rows.length > take ? String(page.at(-1)!.discord_id) : null;
        if (cursor === null) phase = 'ready';
      }
      const context = this.validationContext(board.guildId, now);
      const tags = new Set([...clanTags].map(tag => tag.trim().toUpperCase()).filter(tag => context.tags.has(tag)));
      const evidence = collectBingoEvidence(board, context.state.status === 'observed' ? matches : [], available,
        identities, tags, snapshot.retentionStart, currentMembers);
      for (const item of evidence) {
        if (item.kind === 'game' && !this.bindingAllowed(board, item, context)) continue;
        writeBingoEvidence(this.sql, board.guildId, id, item);
      }
      this.sql.prepare('UPDATE community_bingo_generations SET phase=?,cursor=?,updated_at=? WHERE id=?').run(phase, cursor, now, id);
      return { phase, processed };
    });
  }
  /** Constant-size atomic publication: token/health/retention check, generation pointer and 25 cells.
   * Staging already validated source payloads; source mutations invalidate the token. */
  finalizeEvidenceStage(id: string, now = Date.now()): BingoBoard {
    return withCommunityTransaction(this.sql, () => {
      const { row, snapshot, board } = this.stage(id, now);
      if (row.phase !== 'ready') throw new CommandError('Finish every bingo source page before publishing progress.');
      const previous = currentBingoGeneration(this.sql, board.id);
      this.sql.prepare("UPDATE community_bingo_generations SET status='retired',updated_at=? WHERE id=?").run(now, previous);
      this.sql.prepare("UPDATE community_bingo_generations SET status='current',snapshot=NULL,cursor=NULL,updated_at=? WHERE id=?").run(now, id);
      const first = this.sql.prepare("SELECT MIN(at) AS at FROM community_bingo_evidence WHERE board_id=? AND generation=? AND kind='game'").get(board.id, id)!;
      const nextExpiry = first.at === null ? null : Number(first.at) + this.gameEvidenceState(board.guildId, now).retentionDays * DAY + 1;
      this.sql.prepare(`UPDATE community_bingo_boards SET evidence_generation=?,source_version=?,next_expiry=?,refresh_cursor=NULL,refresh_version=NULL
        WHERE id=?`).run(id, snapshot.version, nextExpiry, board.id);
      return this.evaluate(board, now);
    });
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
    if (!this.bindingAllowed(board, item, context)) return null;
    const row = this.sql.prepare('SELECT discord_id,payload FROM history_player_matches WHERE guild_id=? AND public_id=? AND game_id=?')
      .get(board.guildId, item.publicId, item.gameId);
    if (!row || row.discord_id !== item.discordId) return null;
    const match = JSON.parse(String(row.payload)) as StoredPlayerSession;
    if (Date.parse(match.gameStart) !== item.at || !match.gameEnd || !Number.isFinite(Date.parse(match.gameEnd)) ||
        Date.parse(match.gameEnd) < item.at || match.gameType !== 'Public' || match.gameMode !== 'Team' ||
        !match.clanTag || !context.tags.has(match.clanTag.trim().toUpperCase())) return null;
    return { ...item, key: bingoGameKey(item.publicId, item.gameId), won: match.hasWon === true };
  }
  private bindingAllowed(board: BingoBoard, item: BingoEvidence, context: ValidationContext): boolean {
    if (!item.publicId || !item.linkedAt) return false;
    const bindingKey = JSON.stringify([item.discordId, item.publicId, item.linkedAt]);
    if (!context.identities.has(bindingKey)) {
      const binding = { guildId: board.guildId, discordId: item.discordId, publicId: item.publicId, linkedAt: item.linkedAt };
      context.identities.set(bindingKey, (!this.identityCurrent || this.identityCurrent(binding)) &&
        !this.sql.prepare('SELECT 1 FROM history_deleted_players WHERE public_id=?').get(item.publicId));
    }
    return context.identities.get(bindingKey) === true;
  }
  /** Synchronous compatibility for untrusted arrays: canonical validation is proportional to input.
   * Production workers must use bounded stageEvidencePage + finalizeEvidenceStage instead. */
  replaceEvidence(guildId: string, boardId: string, revision: number, evidence: BingoEvidence[], snapshot?: BingoSnapshot, now = Date.now()): void {
    withCommunityTransaction(this.sql, () => {
      const board = this.require(guildId, boardId, revision);
      const at = now;
      if (snapshot && (snapshot.guildId !== guildId || snapshot.boardId !== boardId || snapshot.revision !== revision)) throw changed();
      if (snapshot) this.assertSnapshot(snapshot, at);
      const current = new Map(this.listEvidence(guildId, boardId).map(item => [item.key, item]));
      const generation = currentBingoGeneration(this.sql, boardId);
      const desired = new Map<string, BingoEvidence>();
      const context = this.validationContext(guildId, at);
      for (const item of evidence) {
        const accepted = this.canonical(board, item, context);
        if (accepted) desired.set(accepted.key, accepted);
      }
      const remove = this.sql.prepare('DELETE FROM community_bingo_evidence WHERE board_id=? AND generation=? AND evidence_key=?');
      for (const key of current.keys()) if (!desired.has(key)) remove.run(boardId, generation, key);
      for (const [key, item] of desired) {
        const previous = current.get(key);
        if (previous && previous.discordId === item.discordId && previous.publicId === item.publicId && previous.kind === item.kind &&
            previous.gameId === item.gameId && previous.at === item.at && previous.won === item.won && previous.linkedAt === item.linkedAt) continue;
        writeBingoEvidence(this.sql, guildId, generation, item);
      }
      const version = this.sourceVersion(guildId, at);
      const first = this.sql.prepare("SELECT MIN(at) AS at FROM community_bingo_evidence WHERE board_id=? AND generation=? AND kind='game'").get(boardId, generation)!;
      const nextExpiry = first.at === null ? null : Number(first.at) + this.gameEvidenceState(guildId, at).retentionDays * DAY + 1;
      this.sql.prepare(`UPDATE community_bingo_boards SET source_version=?,next_expiry=? WHERE id=?
        AND (source_version IS NOT ? OR next_expiry IS NOT ?)`).run(version, nextExpiry, boardId, version, nextExpiry);
      this.evaluate(board, at);
    });
  }
  listEvidence(guildId: string, boardId: string): BingoEvidence[] {
    const generation = currentBingoGeneration(this.sql, boardId);
    return this.sql.prepare('SELECT * FROM community_bingo_evidence WHERE guild_id=? AND board_id=? AND generation=? ORDER BY evidence_key').all(guildId, boardId, generation)
      .map(row => this.decodeEvidence(row, boardId));
  }
  private decodeEvidence(row: Record<string, unknown>, boardId: string): BingoEvidence {
    return { key: String(row.evidence_key), boardId, discordId: String(row.discord_id), publicId: row.public_id as string | null,
        kind: row.kind as BingoEvidence['kind'], gameId: row.game_id as string | null, at: Number(row.at), won: !!row.won,
        linkedAt: row.linked_at === null ? undefined : String(row.linked_at) };
  }
  private evaluate(board: BingoBoard, now: number): BingoBoard {
    const approvals = this.sql.prepare('SELECT cell_index FROM community_bingo_approvals WHERE board_id=? AND approved=1').all(board.id);
    const result = evaluateProgress(board.cells, bingoGenerationProgress(this.sql, board.id), new Set(approvals.map(row => Number(row.cell_index))));
    const cells = JSON.stringify(result.cells);
    const lines = JSON.stringify(result.lines);
    this.sql.prepare('UPDATE community_bingo_boards SET cells=?,lines=? WHERE id=? AND (cells<>? OR lines<>?)').run(cells, lines, board.id, cells, lines);
    if (board.status === 'active') {
      const fresh = !this.needsEvidenceRefresh(board.guildId, board.id, now);
      const notifications = result.complete ? [...result.lines, 'board'] : result.lines;
      for (const line of notifications) {
        // A partial correction may leave stale automatic counts. Do not consume their historical keys.
        if (!fresh && !lineCells(line).every(index => index === 12 || result.cells[index].objective?.kind === 'manual')) continue;
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
      const version = this.sourceVersion(guildId, now);
      const state = this.sql.prepare('SELECT evidence_generation,refresh_cursor,refresh_version FROM community_bingo_boards WHERE id=?').get(boardId)!;
      const cursor = state.refresh_version === version ? String(state.refresh_cursor ?? '') : '';
      const generation = String(state.evidence_generation);
      const rows = this.sql.prepare(`SELECT * FROM community_bingo_evidence WHERE board_id=? AND generation=? AND evidence_key>?
        ORDER BY evidence_key LIMIT 200`).all(boardId, generation, cursor);
      const evidence = rows.map(row => this.decodeEvidence(row, boardId));
      const context = this.validationContext(guildId, now);
      const remove = this.sql.prepare('DELETE FROM community_bingo_evidence WHERE board_id=? AND generation=? AND evidence_key=?');
      const update = this.sql.prepare('UPDATE community_bingo_evidence SET won=? WHERE board_id=? AND generation=? AND evidence_key=?');
      for (const item of evidence) {
        const canonical = this.canonical(board, item, context);
        if (!canonical) remove.run(boardId, generation, item.key);
        else if (canonical.won !== item.won) update.run(Number(canonical.won), boardId, generation, item.key);
      }
      this.sql.prepare('UPDATE community_bingo_boards SET refresh_cursor=?,refresh_version=? WHERE id=?')
        .run(evidence.length === 200 ? evidence.at(-1)!.key : null, version, boardId);
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
