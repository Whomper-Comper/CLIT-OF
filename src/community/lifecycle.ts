import type { DatabaseSync } from "node:sqlite";
import { communitySessions } from "./sessions.js";

/** Feature-owned personal tables extend these hooks as their stores are introduced. */
export function purgeIdentity(_sql: DatabaseSync, _discordId: string, _guildId?: string): void {}
export function purgeAccount(_sql: DatabaseSync, _publicId: string): void {}
export function clearGameEvidence(_sql: DatabaseSync, _guildId?: string): void {}
export function purgeMember(sql: DatabaseSync, guildId: string, discordId: string): void {
  sql.prepare("DELETE FROM community_availability WHERE guild_id=? AND discord_id=?").run(guildId,discordId);
  sql.prepare("DELETE FROM community_availability_changes WHERE guild_id=? AND discord_id=?").run(guildId,discordId);
  purgeIdentity(sql,discordId,guildId); communitySessions.purgeMember(guildId,discordId);
}
export function purgeGuild(sql: DatabaseSync, guildId: string): void {
  for (const table of ["community_settings","community_deliveries","community_guild_work","community_availability","community_availability_changes"]) sql.prepare(`DELETE FROM ${table} WHERE guild_id=?`).run(guildId);
  communitySessions.purgeGuild(guildId);
}
export function prune(sql: DatabaseSync, now: number): void {
  // Bound each tick's deletion work, retaining active work and diagnostics requiring review.
  sql.prepare(`DELETE FROM community_deliveries WHERE id IN (SELECT id FROM community_deliveries
    WHERE status IN ('sent','cancelled','failed') AND updated_at<? ORDER BY updated_at LIMIT 200)`)
    .run(now - 30 * 86_400_000);
}
