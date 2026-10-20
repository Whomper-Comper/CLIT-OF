import type { DatabaseSync } from 'node:sqlite';
import { BingoStore } from './bingo.js';

/** Also advance generations when no evidence was committed yet: an awaited snapshot may still exist. */
export function invalidateBingoSources(sql: DatabaseSync, guildId?: string): void {
  sql.prepare(`UPDATE community_bingo_generations SET status='abandoned',updated_at=?
    WHERE status='staging'${guildId === undefined ? '' : ' AND guild_id=?'}`)
    .run(...(guildId === undefined ? [Date.now()] : [Date.now(), guildId]));
  if (guildId !== undefined) {
    sql.prepare(`INSERT INTO community_bingo_sources(guild_id,revision) VALUES(?,1)
      ON CONFLICT(guild_id) DO UPDATE SET revision=revision+1`).run(guildId);
  } else {
    sql.exec(`INSERT INTO community_bingo_sources(guild_id,revision)
      SELECT DISTINCT guild_id,1 FROM community_bingo_boards WHERE true
      ON CONFLICT(guild_id) DO UPDATE SET revision=revision+1`);
  }
}
export function clearBingoEvidence(sql: DatabaseSync, scope: 'identity' | 'account' | 'member' | 'availability' | 'games',
  id?: string, guildId?: string): void {
  const filters: string[] = [];
  const args: string[] = [];
  if (guildId !== undefined) { filters.push('guild_id=?'); args.push(guildId); }
  if (scope === 'account') { filters.push('public_id=?'); args.push(id!); }
  else if (scope !== 'games') { filters.push('discord_id=?'); args.push(id!); }
  if (scope === 'games' || scope === 'identity' || scope === 'account') filters.push("kind='game'");
  if (scope === 'availability') filters.push("kind='availability'");
  const where = filters.join(' AND ');
  const affected = sql.prepare(`SELECT DISTINCT board_id,guild_id FROM community_bingo_evidence WHERE ${where}`).all(...args);
  sql.prepare(`DELETE FROM community_bingo_evidence WHERE ${where}`).run(...args);
  invalidateBingoSources(sql, guildId);
  const store = new BingoStore(sql);
  for (const row of affected) {
    const board = store.get(String(row.guild_id), String(row.board_id));
    if (board && board.status !== 'archived') store.recompute(board.guildId, board.id, Date.now());
  }
}
export function purgeBingoGuild(sql: DatabaseSync, guildId: string): void {
  sql.prepare('DELETE FROM community_bingo_evidence WHERE guild_id=?').run(guildId);
  for (const table of ['community_bingo_approvals', 'community_bingo_audit', 'community_bingo_notifications']) {
    sql.prepare(`DELETE FROM ${table} WHERE board_id IN (SELECT id FROM community_bingo_boards WHERE guild_id=?)`).run(guildId);
  }
  for (const table of ['community_bingo_totals', 'community_bingo_groups', 'community_bingo_generations']) {
    sql.prepare(`DELETE FROM ${table} WHERE board_id IN (SELECT id FROM community_bingo_boards WHERE guild_id=?)`).run(guildId);
  }
  for (const table of ['community_bingo_boards', 'community_bingo_sources']) {
    sql.prepare(`DELETE FROM ${table} WHERE guild_id=?`).run(guildId);
  }
}
export function retainBingoEvidence(sql: DatabaseSync, guildId: string, cutoff: number): void {
  const rows = sql.prepare(`SELECT rowid,board_id FROM community_bingo_evidence
    WHERE guild_id=? AND kind='game' AND at<? ORDER BY at LIMIT 200`).all(guildId, cutoff);
  const remove = sql.prepare('DELETE FROM community_bingo_evidence WHERE rowid=?');
  for (const row of rows) remove.run(row.rowid!);
  if (!rows.length) return;
  invalidateBingoSources(sql, guildId);
  const store = new BingoStore(sql);
  for (const boardId of new Set(rows.map(row => String(row.board_id)))) {
    const board = store.get(guildId, boardId);
    if (board && board.status !== 'archived') store.recompute(guildId, board.id, Date.now());
  }
}
function pruneGenerations(sql: DatabaseSync, now: number): void {
  sql.prepare(`UPDATE community_bingo_generations SET status='abandoned' WHERE id IN (
    SELECT id FROM community_bingo_generations WHERE status='staging' AND updated_at<? ORDER BY updated_at,id LIMIT 20)`)
    .run(now - 86_400_000);
  const retired = sql.prepare(`SELECT id,board_id FROM community_bingo_generations WHERE status IN ('retired','abandoned')
    ORDER BY updated_at,id LIMIT 20`).all();
  for (const row of retired) {
    sql.prepare(`DELETE FROM community_bingo_evidence WHERE rowid IN (
      SELECT rowid FROM community_bingo_evidence WHERE board_id=? AND generation=? LIMIT 200)`).run(row.board_id!, row.id!);
    if (sql.prepare('SELECT 1 FROM community_bingo_evidence WHERE board_id=? AND generation=? LIMIT 1').get(row.board_id!, row.id!)) continue;
    for (const table of ['community_bingo_totals', 'community_bingo_groups']) {
      sql.prepare(`DELETE FROM ${table} WHERE board_id=? AND generation=?`).run(row.board_id!, row.id!);
    }
    sql.prepare('DELETE FROM community_bingo_generations WHERE id=?').run(row.id!);
  }
}
export function pruneBingo(sql: DatabaseSync, now: number): void {
  pruneGenerations(sql, now);
  const rows = sql.prepare(`SELECT id,guild_id FROM community_bingo_boards WHERE status='archived' AND archived_at<?
    ORDER BY archived_at,id LIMIT 20`).all(now - 90 * 86_400_000);
  for (const row of rows) {
    let remaining = false;
    for (const table of ['community_bingo_evidence', 'community_bingo_approvals', 'community_bingo_audit', 'community_bingo_notifications']) {
      sql.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE board_id=? LIMIT 200)`).run(row.id!);
      if (sql.prepare(`SELECT 1 FROM ${table} WHERE board_id=? LIMIT 1`).get(row.id!)) remaining = true;
    }
    if (!sql.prepare('SELECT 1 FROM community_bingo_evidence WHERE board_id=? LIMIT 1').get(row.id!)) {
      for (const table of ['community_bingo_totals', 'community_bingo_groups', 'community_bingo_generations']) {
        sql.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE board_id=? LIMIT 200)`).run(row.id!);
        if (sql.prepare(`SELECT 1 FROM ${table} WHERE board_id=? LIMIT 1`).get(row.id!)) remaining = true;
      }
    }
    sql.prepare(`DELETE FROM community_deliveries WHERE id IN (SELECT id FROM community_deliveries
      WHERE guild_id=? AND subject_id=? AND kind IN ('bingo_publish','bingo_update','bingo_complete') LIMIT 200)`).run(row.guild_id!, row.id!);
    if (sql.prepare(`SELECT 1 FROM community_deliveries WHERE guild_id=? AND subject_id=?
      AND kind IN ('bingo_publish','bingo_update','bingo_complete') LIMIT 1`).get(row.guild_id!, row.id!)) remaining = true;
    if (!remaining) sql.prepare('DELETE FROM community_bingo_boards WHERE id=?').run(row.id!);
  }
}
