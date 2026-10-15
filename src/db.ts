import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

export interface LinkedUser {
  discord_id: string;
  openfront_id: string;
  openfront_username: string | null;
  linked_at: string;
  verified_method: string;
}

export interface GuildClanConfig {
  guild_id: string;
  clan_tag: string;
  member_role_id: string;
  officer_role_id: string | null;
  leader_role_id: string | null;
  join_role_id: string | null;
  log_channel_id: string | null;
  sync_interval_mins: number;
  last_sync_at: string | null;
}

class BotDatabase {
  private db!: DatabaseSync;

  constructor() {
    this.init();
  }

  private init() {
    const dir = path.dirname(CONFIG.DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(CONFIG.DB_PATH);

    // Run migrations before creating tables (handles old → new schema)
    this.migrate();

    // Create tables with the current schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linked_users (
        discord_id TEXT PRIMARY KEY,
        openfront_id TEXT NOT NULL UNIQUE,
        openfront_username TEXT,
        linked_at TEXT NOT NULL,
        verified_method TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_linked_users_of_id ON linked_users(openfront_id);

      CREATE TABLE IF NOT EXISTS guild_clan_configs (
        guild_id TEXT NOT NULL,
        clan_tag TEXT NOT NULL,
        member_role_id TEXT NOT NULL,
        officer_role_id TEXT,
        leader_role_id TEXT,
        join_role_id TEXT,
        log_channel_id TEXT,
        sync_interval_mins INTEGER NOT NULL DEFAULT 10,
        last_sync_at TEXT,
        PRIMARY KEY (guild_id, clan_tag)
      );
    `);
  }

  /**
   * Migrates old single-clan schema (guild_id as sole PK) to the new
   * multi-clan composite PK (guild_id, clan_tag).
   * Also normalises legacy timestamps to ISO UTC with 'Z'.
   * Also drops the deprecated pending_verifications table.
   */
  private migrate() {
    // --- Migrate guild_clan_configs ---
    try {
      const info = this.db.prepare("PRAGMA table_info(guild_clan_configs)").all() as {
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];

      if (info.length > 0) {
        // Check if it's the old single-PK schema
        const pkColumns = info.filter((col) => col.pk > 0);
        const needsMigration =
          pkColumns.length === 1 && pkColumns[0].name === "guild_id";

        // Check if join_role_id column exists
        const hasJoinRole = info.some((col) => col.name === "join_role_id");

        if (needsMigration) {
          console.log("[DB] Migrating guild_clan_configs to multi-clan schema...");
          this.db.exec(`
            ALTER TABLE guild_clan_configs RENAME TO _old_guild_clan_configs;
          `);
          this.db.exec(`
            CREATE TABLE guild_clan_configs (
              guild_id TEXT NOT NULL,
              clan_tag TEXT NOT NULL,
              member_role_id TEXT NOT NULL,
              officer_role_id TEXT,
              leader_role_id TEXT,
              join_role_id TEXT,
              log_channel_id TEXT,
              sync_interval_mins INTEGER NOT NULL DEFAULT 10,
              last_sync_at TEXT,
              PRIMARY KEY (guild_id, clan_tag)
            );
          `);
          this.db.exec(`
            INSERT INTO guild_clan_configs
              (guild_id, clan_tag, member_role_id, officer_role_id, leader_role_id,
               join_role_id, log_channel_id, sync_interval_mins, last_sync_at)
            SELECT guild_id, clan_tag, member_role_id, officer_role_id, leader_role_id,
                   NULL, log_channel_id, sync_interval_mins, last_sync_at
            FROM _old_guild_clan_configs;
          `);
          this.db.exec(`DROP TABLE _old_guild_clan_configs;`);
          console.log("[DB] Migration to multi-clan schema complete.");
        } else if (!hasJoinRole) {
          console.log("[DB] Adding join_role_id column to guild_clan_configs...");
          this.db.exec(`ALTER TABLE guild_clan_configs ADD COLUMN join_role_id TEXT;`);
        }
      }
    } catch {
      // Table doesn't exist yet — init() will create it
    }

    // --- Timezone Normalisation Migration ---
    try {
      // Normalise legacy linked_at strings (e.g. "2026-10-15 14:15:36" -> "2026-10-15T14:15:36Z")
      this.db.exec(`
        UPDATE linked_users
        SET linked_at = replace(linked_at, ' ', 'T') || 'Z'
        WHERE linked_at NOT LIKE '%Z' AND linked_at LIKE '% %';
      `);
      this.db.exec(`
        UPDATE guild_clan_configs
        SET last_sync_at = replace(last_sync_at, ' ', 'T') || 'Z'
        WHERE last_sync_at IS NOT NULL AND last_sync_at NOT LIKE '%Z' AND last_sync_at LIKE '% %';
      `);
    } catch {
      // Ignore if table not yet created
    }

    // --- Drop deprecated pending_verifications ---
    try {
      this.db.exec(`DROP TABLE IF EXISTS pending_verifications;`);
    } catch {
      // Ignore
    }
  }

  // ────────────────────────────────────────────────────────
  //  User Linking Methods
  // ────────────────────────────────────────────────────────

  public linkUser(
    discordId: string,
    openfrontId: string,
    openfrontUsername: string | null,
    verifiedMethod: string
  ): void {
    const nowIso = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO linked_users (discord_id, openfront_id, openfront_username, linked_at, verified_method)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET
        openfront_id = excluded.openfront_id,
        openfront_username = excluded.openfront_username,
        linked_at = excluded.linked_at,
        verified_method = excluded.verified_method;
    `);
    stmt.run(discordId, openfrontId, openfrontUsername, nowIso, verifiedMethod);
  }

  public unlinkUser(discordId: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM linked_users WHERE discord_id = ?`);
    const res = stmt.run(discordId) as { changes?: number };
    return (res.changes ?? 0) > 0;
  }

  public unlinkByOpenFrontId(openfrontId: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM linked_users WHERE openfront_id = ?`);
    const res = stmt.run(openfrontId) as { changes?: number };
    return (res.changes ?? 0) > 0;
  }

  public getUserByDiscordId(discordId: string): LinkedUser | null {
    const stmt = this.db.prepare(`SELECT * FROM linked_users WHERE discord_id = ?`);
    return (stmt.get(discordId) as LinkedUser | undefined) ?? null;
  }

  public getUserByOpenFrontId(openfrontId: string): LinkedUser | null {
    const stmt = this.db.prepare(`SELECT * FROM linked_users WHERE openfront_id = ?`);
    return (stmt.get(openfrontId) as LinkedUser | undefined) ?? null;
  }

  public getAllLinkedUsers(): LinkedUser[] {
    const stmt = this.db.prepare(`SELECT * FROM linked_users`);
    return stmt.all() as unknown as LinkedUser[];
  }

  // ────────────────────────────────────────────────────────
  //  Guild Clan Configuration (Multi-Clan)
  // ────────────────────────────────────────────────────────

  public setGuildClanConfig(config: GuildClanConfig): void {
    const stmt = this.db.prepare(`
      INSERT INTO guild_clan_configs (
        guild_id, clan_tag, member_role_id, officer_role_id,
        leader_role_id, join_role_id, log_channel_id, sync_interval_mins, last_sync_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, clan_tag) DO UPDATE SET
        member_role_id = excluded.member_role_id,
        officer_role_id = excluded.officer_role_id,
        leader_role_id = excluded.leader_role_id,
        join_role_id = excluded.join_role_id,
        log_channel_id = excluded.log_channel_id,
        sync_interval_mins = excluded.sync_interval_mins;
    `);
    stmt.run(
      config.guild_id,
      config.clan_tag.toUpperCase().trim(),
      config.member_role_id,
      config.officer_role_id || null,
      config.leader_role_id || null,
      config.join_role_id || null,
      config.log_channel_id || null,
      config.sync_interval_mins || 10,
      config.last_sync_at || null
    );
  }

  public updateClanLastSync(guildId: string, clanTag: string): void {
    const nowIso = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE guild_clan_configs
      SET last_sync_at = ?
      WHERE guild_id = ? AND clan_tag = ?
    `);
    stmt.run(nowIso, guildId, clanTag.toUpperCase());
  }

  /** Get a specific clan config for a guild. */
  public getGuildClanConfig(guildId: string, clanTag: string): GuildClanConfig | null {
    const stmt = this.db.prepare(
      `SELECT * FROM guild_clan_configs WHERE guild_id = ? AND clan_tag = ?`
    );
    return (stmt.get(guildId, clanTag.toUpperCase()) as GuildClanConfig | undefined) ?? null;
  }

  /** Get ALL clan configs for a guild (multi-clan). */
  public getGuildConfigs(guildId: string): GuildClanConfig[] {
    const stmt = this.db.prepare(
      `SELECT * FROM guild_clan_configs WHERE guild_id = ?`
    );
    return stmt.all(guildId) as unknown as GuildClanConfig[];
  }

  public deleteGuildClanConfig(guildId: string, clanTag: string): boolean {
    const stmt = this.db.prepare(
      `DELETE FROM guild_clan_configs WHERE guild_id = ? AND clan_tag = ?`
    );
    const res = stmt.run(guildId, clanTag.toUpperCase()) as { changes?: number };
    return (res.changes ?? 0) > 0;
  }

  public deleteAllGuildConfigs(guildId: string): number {
    const stmt = this.db.prepare(`DELETE FROM guild_clan_configs WHERE guild_id = ?`);
    const res = stmt.run(guildId) as { changes?: number };
    return res.changes ?? 0;
  }

  public getAllGuildConfigs(): GuildClanConfig[] {
    const stmt = this.db.prepare(`SELECT * FROM guild_clan_configs`);
    return stmt.all() as unknown as GuildClanConfig[];
  }
}

export const db = new BotDatabase();
