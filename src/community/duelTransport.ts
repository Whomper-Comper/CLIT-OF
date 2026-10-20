import type { DatabaseSync } from 'node:sqlite';
import { DeliveryStore } from './deliveries.js';
import type { DuelRecord } from './duels.js';
import type { EntityBinding } from './types.js';

export interface DuelClosure extends EntityBinding {
  id: string;
  revision: number;
  closedAt: number;
}

interface MembershipCheck { guildId: string; ids: readonly string[]; valid: boolean }
// Retain identities only while a lookup is in flight; departure invalidates the matching snapshots.
const checks = new WeakMap<DatabaseSync, Set<MembershipCheck>>();
export function beginDuelMembershipCheck(sql: DatabaseSync, guildId: string, ids: readonly string[]) {
  let active = checks.get(sql);
  if (!active) checks.set(sql, active = new Set());
  const check = { guildId, ids, valid: true };
  active.add(check);
  return { current: () => check.valid, release: () => { active.delete(check); } };
}
export function invalidateDuelMembership(sql: DatabaseSync, guildId: string, discordId?: string): void {
  for (const check of checks.get(sql) ?? []) {
    if (check.guildId === guildId && (discordId === undefined || check.ids.includes(discordId))) check.valid = false;
  }
}

export function enqueueDuelPublish(sql: DatabaseSync, duel: DuelRecord, now: number): void {
  new DeliveryStore(sql).enqueue({ key: `duel:${duel.id}:publish`, kind: 'duel_publish',
    guildId: duel.guildId, channelId: duel.channelId, subjectId: duel.id,
    revision: 1, dueAt: now, part: 0 });
}

export function queueDuelUpdate(sql: DatabaseSync, duel: DuelRecord | DuelClosure, now: number, refresh = false): void {
  if (!duel.messageId) return;
  const job = new DeliveryStore(sql).enqueue({ key: `duel:${duel.id}:update:${duel.revision}`, kind: 'duel_update',
    guildId: duel.guildId, channelId: duel.channelId, subjectId: duel.id,
    revision: duel.revision, dueAt: now, part: 0 });
  if (refresh) {
    // One stable job per saved revision coalesces simultaneous refreshes, including retries.
    sql.prepare(`UPDATE community_deliveries SET status='pending',attempts=0,next_attempt=?,updated_at=?,last_error=NULL
      WHERE id=? AND status IN ('sent','paused','failed','needs_review')`).run(now, now, job.id);
  }
}

export function getDuelClosure(sql: DatabaseSync, guildId: string, id: string): DuelClosure | null {
  const row = sql.prepare('SELECT * FROM community_duel_closures WHERE guild_id=? AND id=?').get(guildId, id);
  return row ? { id: String(row.id), guildId: String(row.guild_id), channelId: String(row.channel_id),
    messageId: row.message_id as string | null, revision: Number(row.revision), closedAt: Number(row.closed_at) } : null;
}

/** Transport-only closure: no participant IDs or saved personal invitation content. */
export function closeDuel(sql: DatabaseSync, duel: DuelRecord, now: number): void {
  sql.prepare(`INSERT OR IGNORE INTO community_duel_closures(id,guild_id,channel_id,message_id,revision,closed_at)
    VALUES(?,?,?,?,?,?)`).run(duel.id, duel.guildId, duel.channelId, duel.messageId, duel.revision + 1, now);
  sql.prepare('DELETE FROM community_duel_participants WHERE duel_id=?').run(duel.id);
  sql.prepare("DELETE FROM community_duels WHERE guild_id=? AND id=? AND status='pending'").run(duel.guildId, duel.id);
  new DeliveryStore(sql).cancelSubject(duel.guildId, 'duel_update', duel.id, duel.createdAt);
  queueDuelUpdate(sql, getDuelClosure(sql, duel.guildId, duel.id)!, duel.createdAt);
}
