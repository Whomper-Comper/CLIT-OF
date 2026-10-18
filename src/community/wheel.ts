import { randomInt, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CommandError } from '../commandError.js';
import { STARTER_PRESETS, validateWheelPreset, type WheelPreset } from './wheelPresets.js';
import { withCommunityTransaction } from './transactions.js';

export function spinWheel(presets: WheelPreset[], roll: (min: number, maxExclusive: number) => number = randomInt): { preset: WheelPreset; map: string } {
  if (presets.length > 50) throw new CommandError('A wheel supports at most 50 presets.');
  const enabled = presets.filter(preset => preset.enabled);
  if (!enabled.length) throw new CommandError('No enabled presets. Ask an officer to add or enable a preset using /wheel presets.');
  const preset = validateWheelPreset(enabled[roll(0, enabled.length)]);
  return { preset, map: preset.maps[roll(0, preset.maps.length)] };
}

export class WheelStore {
  constructor(private readonly sql: DatabaseSync) {}
  static initialize(sql: DatabaseSync): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS community_wheel_initialized (guild_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS community_wheel_presets (
      guild_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,
      PRIMARY KEY(guild_id,id));`);
  }
  private seed(guildId: string): void {
    if (this.sql.prepare('SELECT 1 FROM community_wheel_initialized WHERE guild_id=?').get(guildId)) return;
    withCommunityTransaction(this.sql, () => {
      this.sql.prepare('INSERT INTO community_wheel_initialized(guild_id) VALUES(?)').run(guildId);
      for (const source of STARTER_PRESETS) {
        const preset = validateWheelPreset({ ...source, id: randomUUID(), guildId, revision: 1 });
        this.sql.prepare('INSERT INTO community_wheel_presets VALUES(?,?,?,?)')
          .run(guildId, preset.id, 1, JSON.stringify(preset));
      }
    });
  }
  list(guildId: string): WheelPreset[] {
    this.seed(guildId);
    return this.sql.prepare('SELECT payload FROM community_wheel_presets WHERE guild_id=? ORDER BY rowid LIMIT 50')
      .all(guildId).map(row => JSON.parse(String(row.payload)) as WheelPreset);
  }
  save(input: WheelPreset, expectedRevision: number): WheelPreset {
    const valid = validateWheelPreset(input);
    this.seed(valid.guildId);
    return withCommunityTransaction(this.sql, () => {
      const row = this.sql.prepare('SELECT revision FROM community_wheel_presets WHERE guild_id=? AND id=?').get(valid.guildId, valid.id);
      if (Number(row?.revision ?? 0) !== expectedRevision || valid.revision !== expectedRevision) {
        throw new CommandError('Preset changed or removed. Reopen /wheel presets.');
      }
      if (!row && Number(this.sql.prepare('SELECT count(*) AS total FROM community_wheel_presets WHERE guild_id=?').get(valid.guildId)!.total) >= 50) {
        throw new CommandError('A guild supports at most 50 presets. Remove a preset first.');
      }
      const saved = { ...valid, revision: expectedRevision + 1 };
      this.sql.prepare(`INSERT INTO community_wheel_presets VALUES(?,?,?,?)
        ON CONFLICT(guild_id,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload`)
        .run(saved.guildId, saved.id, saved.revision, JSON.stringify(saved));
      return saved;
    });
  }
  remove(guildId: string, presetId: string, expectedRevision: number): void {
    const removed = this.sql.prepare('DELETE FROM community_wheel_presets WHERE guild_id=? AND id=? AND revision=?')
      .run(guildId, presetId, expectedRevision);
    if (!removed.changes) throw new CommandError('Preset changed or unavailable. Reopen /wheel presets.');
  }
}
