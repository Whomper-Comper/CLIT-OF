import { randomInt, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CommandError } from '../commandError.js';
import { withCommunityTransaction } from './transactions.js';
import type { EntityBinding } from './types.js';
import { beginDuelMembershipCheck, closeDuel, enqueueDuelPublish, getDuelClosure, invalidateDuelMembership, queueDuelUpdate } from './duelTransport.js';
import { DeliveryStore } from './deliveries.js';

export interface DuelRecord extends EntityBinding {
  id: string;
  challengerId: string;
  opponentId: string;
  status: 'pending' | 'resolved' | 'declined' | 'cancelled' | 'expired';
  challengerRoll: number | null;
  opponentRoll: number | null;
  createdAt: number;
  /** One-time canonical activation immediately before the first enabling request. */
  activatedAt: number | null;
  expiresAt: number;
  /** Terminal instant for every status; expiry uses the invitation's deadline. */
  resolvedAt: number | null;
  revision: number;
  rematchOf: string | null;
}

const unavailable = () => new CommandError('This duel changed or is unavailable. Reopen /duel.');
const decode = (row: Record<string, unknown>): DuelRecord => ({
  id: String(row.id),
  guildId: String(row.guild_id),
  channelId: String(row.channel_id),
  messageId: row.message_id as string | null,
  challengerId: String(row.challenger_id),
  opponentId: String(row.opponent_id),
  status: row.status as DuelRecord['status'],
  challengerRoll: row.challenger_roll as number | null,
  opponentRoll: row.opponent_roll as number | null,
  createdAt: Number(row.created_at),
  activatedAt: row.activated_at as number | null,
  expiresAt: Number(row.expires_at),
  resolvedAt: row.resolved_at as number | null,
  revision: Number(row.revision),
  rematchOf: row.rematch_of as string | null,
});

export class DuelStore {
  constructor(private readonly sql: DatabaseSync) {}

  static initialize(sql: DatabaseSync): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS community_duels (
      id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT,
      challenger_id TEXT NOT NULL,opponent_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','resolved','declined','cancelled','expired')),
      challenger_roll INTEGER CHECK(challenger_roll BETWEEN 1 AND 6),
      opponent_roll INTEGER CHECK(opponent_roll BETWEEN 1 AND 6),
      created_at INTEGER NOT NULL,activated_at INTEGER,expires_at INTEGER NOT NULL,resolved_at INTEGER,
      revision INTEGER NOT NULL,rematch_of TEXT,CHECK(challenger_id!=opponent_id));
      CREATE INDEX IF NOT EXISTS community_duel_guild ON community_duels(guild_id,id);
      CREATE INDEX IF NOT EXISTS community_duel_expiry ON community_duels(expires_at,id) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS community_duel_retention ON community_duels(resolved_at,id) WHERE status!='pending';
      CREATE TABLE IF NOT EXISTS community_duel_participants (
        guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,duel_id TEXT NOT NULL,
        PRIMARY KEY(guild_id,discord_id));
      CREATE INDEX IF NOT EXISTS community_duel_slots ON community_duel_participants(duel_id);
      CREATE TABLE IF NOT EXISTS community_duel_cooldowns (
        guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,available_at INTEGER NOT NULL,
        PRIMARY KEY(guild_id,discord_id));
      CREATE INDEX IF NOT EXISTS community_duel_cooldown_expiry ON community_duel_cooldowns(available_at);`);
    const columns = sql.prepare('PRAGMA table_info(community_duels)').all();
    if (!columns.some(column => column.name === 'activated_at')) sql.exec('ALTER TABLE community_duels ADD COLUMN activated_at INTEGER');
    sql.exec(`CREATE TABLE IF NOT EXISTS community_duel_closures (
      id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT,
      revision INTEGER NOT NULL,closed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS community_duel_closure_guild ON community_duel_closures(guild_id,id);
      CREATE INDEX IF NOT EXISTS community_duel_closure_retention ON community_duel_closures(closed_at,id);`);
  }

  beginMembershipCheck(guildId: string, ids: readonly string[]) {
    return beginDuelMembershipCheck(this.sql, guildId, ids);
  }

  closure(guildId: string, id: string) { return getDuelClosure(this.sql, guildId, id); }

  bindPublication(guildId: string, id: string, channelId: string, messageId: string, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const duel = this.get(guildId, id);
      if (duel && duel.channelId === channelId) {
        this.bindMessage(guildId, id, duel.revision, messageId);
        return;
      }
      const closure = this.closure(guildId, id);
      if (!closure || closure.channelId !== channelId || (closure.messageId && closure.messageId !== messageId)) throw unavailable();
      this.sql.prepare('UPDATE community_duel_closures SET message_id=? WHERE guild_id=? AND id=?')
        .run(messageId, guildId, id);
      queueDuelUpdate(this.sql, { ...closure, messageId }, now);
    });
  }

  closeUnavailable(guildId: string, duelId: string, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const duel = this.get(guildId, duelId);
      if (duel?.status === 'pending') closeDuel(this.sql, duel, now);
    });
  }

  expireInvitation(guildId: string, duelId: string, now: number): DuelRecord | null {
    return withCommunityTransaction(this.sql, () => {
      const duel = this.get(guildId, duelId);
      return duel?.status === 'pending' && now >= duel.expiresAt
        ? this.terminal(duel, 'expired', duel.expiresAt) : duel;
    });
  }

  activate(guildId: string, duelId: string, channelId: string, messageId: string, now: number): DuelRecord | null {
    return withCommunityTransaction(this.sql, () => {
      const duel = this.expireInvitation(guildId, duelId, now);
      if (!duel || duel.channelId !== channelId || duel.messageId !== messageId) return null;
      if (duel.status !== 'pending' || duel.activatedAt !== null) return duel;
      // The unactivated expiry is a separate hard wait bound; it never slides on retries.
      if (now >= duel.createdAt + 120_000) return this.terminal(duel, 'expired', duel.expiresAt);
      this.sql.prepare(`UPDATE community_duels SET activated_at=?,expires_at=?
        WHERE guild_id=? AND id=? AND status='pending' AND activated_at IS NULL`)
        .run(now, now + 120_000, guildId, duelId);
      return this.require(guildId, duelId);
    });
  }

  refresh(guildId: string, duelId: string, now: number): void {
    withCommunityTransaction(this.sql, () => {
      let duel = this.require(guildId, duelId);
      if (duel.status === 'pending' && now >= duel.expiresAt) duel = this.terminal(duel, 'expired', duel.expiresAt);
      queueDuelUpdate(this.sql, duel, now, true);
    });
  }

  get(guildId: string, duelId: string): DuelRecord | null {
    const row = this.sql.prepare('SELECT * FROM community_duels WHERE guild_id=? AND id=?').get(guildId, duelId);
    return row ? decode(row) : null;
  }

  invite(binding: EntityBinding, challengerId: string, opponentId: string, now: number, rematchOf?: string): DuelRecord {
    if (challengerId === opponentId) throw new CommandError('Choose a different member to duel.');
    return withCommunityTransaction(this.sql, () => {
      if (rematchOf !== undefined) this.assertRematch(binding.guildId, rematchOf, challengerId, opponentId);

      // At most two indexed slot lookups: stale invitations cannot block a fresh invite
      // just because the background sweep has not reached them yet.
      for (const discordId of [challengerId, opponentId]) {
        const slot = this.sql.prepare(`SELECT duel_id FROM community_duel_participants
          WHERE guild_id=? AND discord_id=?`).get(binding.guildId, discordId);
        if (!slot) continue;
        const existing = this.require(binding.guildId, String(slot.duel_id));
        if (existing.expiresAt <= now) this.terminal(existing, 'expired', existing.expiresAt);
        else throw new CommandError('One of these members already has a pending duel.');
      }
      const cooldown = this.sql.prepare(`SELECT available_at FROM community_duel_cooldowns
        WHERE guild_id=? AND discord_id=?`).get(binding.guildId, challengerId);
      if (cooldown && Number(cooldown.available_at) > now) {
        throw new CommandError('Wait for the 30 seconds invitation cooldown before challenging again.');
      }

      const id = randomUUID();
      this.sql.prepare(`INSERT INTO community_duels
        (id,guild_id,channel_id,message_id,challenger_id,opponent_id,status,created_at,expires_at,revision,rematch_of)
        VALUES(?,?,?,?,?,?,'pending',?,?,1,?)`).run(id, binding.guildId, binding.channelId,
          binding.messageId, challengerId, opponentId, now, now + 120_000, rematchOf ?? null);
      const claim = this.sql.prepare('INSERT INTO community_duel_participants(guild_id,discord_id,duel_id) VALUES(?,?,?)');
      claim.run(binding.guildId, challengerId, id);
      claim.run(binding.guildId, opponentId, id);
      this.sql.prepare(`INSERT INTO community_duel_cooldowns(guild_id,discord_id,available_at) VALUES(?,?,?)
        ON CONFLICT(guild_id,discord_id) DO UPDATE SET available_at=excluded.available_at`)
        .run(binding.guildId, challengerId, now + 30_000);
      const invitation = this.require(binding.guildId, id);
      enqueueDuelPublish(this.sql, invitation, now);
      return invitation;
    });
  }

  bindMessage(guildId: string, duelId: string, revision: number, messageId: string): void {
    withCommunityTransaction(this.sql, () => {
      const changed = this.sql.prepare(`UPDATE community_duels SET message_id=?
        WHERE guild_id=? AND id=? AND revision=? AND (message_id IS NULL OR message_id=?)`)
        .run(messageId, guildId, duelId, revision, messageId);
      if (!changed.changes) throw unavailable();
      const duel = this.require(guildId, duelId);
      new DeliveryStore(this.sql).cancelSubject(guildId, 'duel_publish', duelId, duel.createdAt);
      queueDuelUpdate(this.sql, duel, duel.resolvedAt ?? duel.createdAt);
    });
  }

  resolve(guildId: string, duelId: string, actorId: string, now: number,
    roll: (min: number, maxExclusive: number) => number = randomInt): DuelRecord {
    return this.transition(guildId, duelId, actorId, now, 'resolved', roll);
  }

  decline(guildId: string, duelId: string, actorId: string, now: number): DuelRecord {
    return this.transition(guildId, duelId, actorId, now, 'declined');
  }

  cancel(guildId: string, duelId: string, actorId: string, now: number): DuelRecord {
    return this.transition(guildId, duelId, actorId, now, 'cancelled');
  }

  /** Returns at most 200 saved expirations, oldest deadline first. */
  expire(now: number): DuelRecord[] {
    return withCommunityTransaction(this.sql, () => {
      const rows = this.sql.prepare(`SELECT * FROM community_duels WHERE status='pending' AND expires_at<=?
        ORDER BY expires_at,id LIMIT 200`).all(now);
      return rows.map(row => {
        const duel = decode(row);
        return this.terminal(duel, 'expired', duel.expiresAt);
      });
    });
  }

  private require(guildId: string, duelId: string): DuelRecord {
    const duel = this.get(guildId, duelId);
    if (!duel) throw unavailable();
    return duel;
  }

  private assertRematch(guildId: string, duelId: string, challengerId: string, opponentId: string): void {
    const original = this.require(guildId, duelId);
    if (original.status !== 'resolved' || original.challengerRoll === null || original.challengerRoll !== original.opponentRoll) {
      throw new CommandError('A rematch requires a resolved tie.');
    }
    if (!((challengerId === original.challengerId && opponentId === original.opponentId)
      || (challengerId === original.opponentId && opponentId === original.challengerId))) {
      throw new CommandError('Only the original pair of participants may request this rematch.');
    }
  }

  private transition(guildId: string, duelId: string, actorId: string, now: number,
    status: 'resolved' | 'declined' | 'cancelled', roll?: (min: number, maxExclusive: number) => number): DuelRecord {
    return withCommunityTransaction(this.sql, () => {
      const duel = this.require(guildId, duelId);
      const owner = status === 'cancelled' ? duel.challengerId : duel.opponentId;
      if (owner !== actorId) {
        throw new CommandError(status === 'cancelled'
          ? 'Only the challenger may cancel this duel.'
          : 'Only the opponent may accept or decline this duel.');
      }
      if (duel.status !== 'pending') {
        // A synchronous injected RNG must not recursively consume an incomplete claim.
        if (duel.status === 'resolved' && duel.challengerRoll === null) throw unavailable();
        return duel;
      }
      if (now >= duel.expiresAt) return this.terminal(duel, 'expired', duel.expiresAt);

      // Claim before drawing; the savepoint rolls back the claim and saved outcome
      // on any failure. No Discord operation or asynchronous function runs here.
      const result = this.terminal(duel, status, now);
      if (status !== 'resolved') return result;
      const challengerRoll = roll!(1, 7);
      const opponentRoll = roll!(1, 7);
      for (const value of [challengerRoll, opponentRoll]) {
        if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error('Invalid D6 roll.');
      }
      this.sql.prepare(`UPDATE community_duels SET challenger_roll=?,opponent_roll=?
        WHERE guild_id=? AND id=? AND status='resolved' AND revision=?`)
        .run(challengerRoll, opponentRoll, guildId, duelId, result.revision);
      return this.require(guildId, duelId);
    });
  }

  private terminal(duel: DuelRecord, status: Exclude<DuelRecord['status'], 'pending'>, now: number): DuelRecord {
    const claimed = this.sql.prepare(`UPDATE community_duels SET status=?,resolved_at=?,revision=revision+1
      WHERE guild_id=? AND id=? AND status='pending' AND revision=?`)
      .run(status, now, duel.guildId, duel.id, duel.revision);
    if (!claimed.changes) throw unavailable();
    this.sql.prepare('DELETE FROM community_duel_participants WHERE duel_id=?').run(duel.id);
    const saved = this.require(duel.guildId, duel.id);
    new DeliveryStore(this.sql).cancelSubject(duel.guildId, 'duel_update', duel.id, now);
    queueDuelUpdate(this.sql, saved, now);
    return saved;
  }
}

/** Member departure removes pending consent, while completed public outcomes retain their lifetime. */
export function purgeDuelMember(sql: DatabaseSync, guildId: string, discordId: string): void {
  invalidateDuelMembership(sql, guildId, discordId);
  const slot = sql.prepare(`SELECT duel_id FROM community_duel_participants WHERE guild_id=? AND discord_id=?`)
    .get(guildId, discordId);
  if (slot) {
    const duel = new DuelStore(sql).get(guildId, String(slot.duel_id));
    if (duel?.status === 'pending') closeDuel(sql, duel, Date.now());
  }
  sql.prepare('DELETE FROM community_duel_cooldowns WHERE guild_id=? AND discord_id=?').run(guildId, discordId);
}

/** Each pass removes at most 200 closures, 200 terminal records and 200 elapsed cooldowns. */
export function pruneDuels(sql: DatabaseSync, now: number): void {
  sql.prepare(`DELETE FROM community_duel_closures WHERE id IN (SELECT id FROM community_duel_closures
    WHERE closed_at<? ORDER BY closed_at,id LIMIT 200)`).run(now - 30 * 86_400_000);
  sql.prepare(`DELETE FROM community_duels WHERE id IN (SELECT id FROM community_duels
    WHERE status!='pending' AND resolved_at<? ORDER BY resolved_at,id LIMIT 200)`).run(now - 30 * 86_400_000);
  sql.prepare(`DELETE FROM community_duel_cooldowns WHERE rowid IN (SELECT rowid FROM community_duel_cooldowns
    WHERE available_at<=? ORDER BY available_at LIMIT 200)`).run(now);
}
