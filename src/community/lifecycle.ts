import type { DatabaseSync } from "node:sqlite";
import { communitySessions } from "./sessions.js";
import { purgeMilestones } from "./milestones.js";
import { clearBingoEvidence, purgeBingoGuild, pruneBingo } from './bingoLifecycle.js';

/** Feature-owned personal tables extend these hooks as their stores are introduced. */
export function purgeIdentity(sql: DatabaseSync, discordId: string, guildId?: string): void {
  clearBingoEvidence(sql, 'identity', discordId, guildId);
  purgeMilestones(sql, 'identity', discordId, guildId);
  sql.prepare(`UPDATE community_onboarding SET completed_at=NULL,public_id=NULL,token=hex(randomblob(16)) WHERE discord_id=?${guildId===undefined?'':' AND guild_id=?'}`)
    .run(...(guildId===undefined?[discordId]:[discordId,guildId]));
}
export function purgeAccount(sql: DatabaseSync, publicId: string): void {
  clearBingoEvidence(sql, 'account', publicId);
  purgeMilestones(sql, 'account', publicId);
  sql.prepare(`UPDATE community_onboarding SET completed_at=NULL,public_id=NULL,token=hex(randomblob(16)) WHERE public_id=?`).run(publicId);
}
export function clearGameEvidence(sql: DatabaseSync, guildId?: string): void {
  clearBingoEvidence(sql, 'games', undefined, guildId);
}
export function purgeMember(sql: DatabaseSync, guildId: string, discordId: string): void {
  sql.prepare("DELETE FROM community_bingo_claims WHERE guild_id=? AND actor_id=? AND status='pending'").run(guildId,discordId);
  clearBingoEvidence(sql, 'member', discordId, guildId);
  sql.prepare(`UPDATE community_events SET promotion_due=1 WHERE guild_id=? AND status='scheduled' AND id IN
    (SELECT event_id FROM community_event_signups WHERE guild_id=? AND discord_id=?)`).run(guildId,guildId,discordId);
  sql.prepare(`DELETE FROM community_event_signups WHERE guild_id=? AND discord_id=? AND event_id IN
    (SELECT id FROM community_events WHERE guild_id=? AND status IN ('draft','scheduled'))`).run(guildId,discordId,guildId);
  sql.prepare("DELETE FROM community_availability WHERE guild_id=? AND discord_id=?").run(guildId,discordId);
  sql.prepare("DELETE FROM community_availability_changes WHERE guild_id=? AND discord_id=?").run(guildId,discordId);
  sql.prepare("DELETE FROM community_onboarding WHERE guild_id=? AND discord_id=?").run(guildId,discordId);
  purgeIdentity(sql,discordId,guildId); communitySessions.purgeMember(guildId,discordId);
}
export function purgeGuild(sql: DatabaseSync, guildId: string): void {
  purgeMilestones(sql, 'guild', guildId);
  for (const table of ["community_wheel_presets","community_wheel_initialized","community_onboarding","community_event_reminder_parts","community_event_signups","community_events","community_settings","community_deliveries","community_guild_work","community_availability","community_availability_changes"]) sql.prepare(`DELETE FROM ${table} WHERE guild_id=?`).run(guildId);
  // Availability deletion advances bingo sources; remove those sources only after the trigger-producing tables.
  purgeBingoGuild(sql, guildId);
  communitySessions.purgeGuild(guildId);
}
export function prune(sql: DatabaseSync, now: number): void {
  pruneBingo(sql, now);
  sql.prepare(`DELETE FROM community_milestone_account_attempts WHERE public_id IN (
    SELECT public_id FROM community_milestone_account_attempts WHERE next_attempt<?
    ORDER BY next_attempt,public_id LIMIT 200)`).run(now);
  const retired = sql.prepare(`SELECT id,guild_id FROM community_events INDEXED BY community_event_retention
    WHERE status IN ('scheduled','finished','cancelled') AND retire_at<? ORDER BY retire_at,id LIMIT 20`).all(now-90*86_400_000);
  for (const row of retired) {
    // A single event may have arbitrarily many reserves or historical revisions.
    // Drain bounded child batches before removing the canonical parent.
    sql.prepare(`DELETE FROM community_event_signups WHERE rowid IN
      (SELECT rowid FROM community_event_signups WHERE event_id=? LIMIT 200)`).run(row.id!);
    sql.prepare(`DELETE FROM community_event_reminder_parts WHERE rowid IN
      (SELECT rowid FROM community_event_reminder_parts WHERE event_id=? LIMIT 200)`).run(row.id!);
    sql.prepare(`DELETE FROM community_deliveries WHERE id IN
      (SELECT id FROM community_deliveries WHERE guild_id=? AND kind IN ('event_publish','event_update','event_reminder')
      AND subject_id=? LIMIT 200)`).run(row.guild_id!,row.id!);
    if (sql.prepare(`SELECT 1 FROM community_event_signups WHERE event_id=? LIMIT 1`).get(row.id!) ||
        sql.prepare(`SELECT 1 FROM community_event_reminder_parts WHERE event_id=? LIMIT 1`).get(row.id!) ||
        sql.prepare(`SELECT 1 FROM community_deliveries WHERE guild_id=? AND kind IN ('event_publish','event_update','event_reminder')
          AND subject_id=? LIMIT 1`).get(row.guild_id!,row.id!)) continue;
    sql.prepare('DELETE FROM community_events WHERE id=?').run(row.id!);
  }
  // Bound each tick's deletion work, retaining active work and diagnostics requiring review.
  sql.prepare(`DELETE FROM community_deliveries WHERE id IN (SELECT id FROM community_deliveries
    WHERE status IN ('sent','cancelled','failed') AND updated_at<? ORDER BY updated_at LIMIT 200)`)
    .run(now - 30 * 86_400_000);
  sql.prepare(`DELETE FROM community_milestone_intents WHERE id IN (
    SELECT i.id FROM community_milestone_intents i WHERE i.observed_at<?
    AND NOT EXISTS (SELECT 1 FROM community_deliveries d
      WHERE d.guild_id=i.guild_id AND d.kind='milestone' AND d.subject_id=i.id)
    ORDER BY i.observed_at LIMIT 200)`).run(now - 30 * 86_400_000);
}
