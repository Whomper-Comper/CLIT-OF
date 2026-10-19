import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { backupDatabaseBeforeMigration } from "./backups.js";
import { HistoryStore } from "./historyStore.js";
import { CommunityStore } from "./community/store.js";

export interface LinkedUser {
  discord_id: string; openfront_id: string; openfront_username: string | null;
  linked_at: string; verified_method: string;
}
export interface GuildClanConfig {
  guild_id: string; clan_tag: string; member_role_id: string;
  officer_role_id: string | null; leader_role_id: string | null; join_role_id: string | null;
  log_channel_id: string | null; sync_interval_mins: number; last_sync_at: string | null;
}
export interface RoleJob {
  guild_id: string; discord_id: string; role_ids: string; version: string;
  attempts: number; available_at: number; last_error: string | null; priority: number; created_at: number;
}
export interface GuildSettings { guild_id: string; manager_role_id: string; revision: number }
export interface DebugSettings { guild_id: string; debug_role_id: string | null; revision: number; verbose_errors: number; ephemeral_replies: number }
export interface AuditEntry {
  id: number; guild_id: string | null; actor_id: string; discord_id: string;
  action: string; old_id: string | null; new_id: string | null; created_at: string;
}
export const managedRoles = (configs: GuildClanConfig[]) => [...new Set(configs.flatMap(c =>
  [c.member_role_id, c.officer_role_id, c.leader_role_id].filter((id): id is string => !!id)))];

export class BotDatabase {
  private db: DatabaseSync;
  private lastIdentityTime = 0;
  readonly history: HistoryStore;
  readonly community: CommunityStore;
  constructor(filename = CONFIG.DB_PATH) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    backupDatabaseBeforeMigration(filename);
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.transaction(() => {
      const columns = this.db.prepare("PRAGMA table_info(guild_clan_configs)").all();
      const oldSchema = columns.length && columns.filter(c => Number(c.pk) > 0).length === 1;
      if (oldSchema) this.db.exec("ALTER TABLE guild_clan_configs RENAME TO legacy_clans");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS linked_users (
          discord_id TEXT PRIMARY KEY, openfront_id TEXT NOT NULL UNIQUE, openfront_username TEXT,
          linked_at TEXT NOT NULL, verified_method TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS guild_clan_configs (
          guild_id TEXT NOT NULL, clan_tag TEXT NOT NULL, member_role_id TEXT NOT NULL,
          officer_role_id TEXT, leader_role_id TEXT, join_role_id TEXT, log_channel_id TEXT,
          sync_interval_mins INTEGER NOT NULL DEFAULT 10, last_sync_at TEXT, PRIMARY KEY(guild_id, clan_tag));
        CREATE TABLE IF NOT EXISTS guild_links (
          guild_id TEXT NOT NULL, discord_id TEXT NOT NULL, openfront_id TEXT NOT NULL,
          openfront_username TEXT, linked_at TEXT NOT NULL, verified_method TEXT NOT NULL,
          PRIMARY KEY(guild_id, discord_id), UNIQUE(guild_id, openfront_id));
        CREATE TABLE IF NOT EXISTS link_audit (
          id INTEGER PRIMARY KEY, guild_id TEXT, actor_id TEXT NOT NULL, discord_id TEXT NOT NULL,
          action TEXT NOT NULL, old_id TEXT, new_id TEXT, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS audit_subject ON link_audit(discord_id, id);
        CREATE INDEX IF NOT EXISTS audit_guild ON link_audit(guild_id, id);
        CREATE TABLE IF NOT EXISTS role_jobs (
          guild_id TEXT NOT NULL, discord_id TEXT NOT NULL, role_ids TEXT NOT NULL,
          version TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          available_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, priority INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id, discord_id));
        CREATE TABLE IF NOT EXISTS guild_settings (
          guild_id TEXT PRIMARY KEY, manager_role_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS guild_debug_settings (
          guild_id TEXT PRIMARY KEY, debug_role_id TEXT, revision INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS legacy_manual_links (
          discord_id TEXT PRIMARY KEY, openfront_id TEXT NOT NULL, openfront_username TEXT,
          linked_at TEXT NOT NULL, migrated_at TEXT NOT NULL);
      `);
      const jobColumns = this.db.prepare("PRAGMA table_info(role_jobs)").all();
      const debugColumns = this.db.prepare("PRAGMA table_info(guild_debug_settings)").all();
      if (!debugColumns.some(c => c.name === "verbose_errors")) this.db.exec("ALTER TABLE guild_debug_settings ADD COLUMN verbose_errors INTEGER NOT NULL DEFAULT 0");
      if (!debugColumns.some(c => c.name === "ephemeral_replies")) this.db.exec("ALTER TABLE guild_debug_settings ADD COLUMN ephemeral_replies INTEGER NOT NULL DEFAULT 1");
      if (!jobColumns.some((c) => c.name === "priority")) this.db.exec("ALTER TABLE role_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
      if (!jobColumns.some((c) => c.name === "created_at")) this.db.exec("ALTER TABLE role_jobs ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
      this.db.prepare("UPDATE role_jobs SET created_at=? WHERE created_at=0").run(Date.now());
      if (oldSchema) {
        const joinColumn = columns.some(c => c.name === "join_role_id") ? "join_role_id" : "NULL";
        this.db.exec(`INSERT INTO guild_clan_configs SELECT guild_id, clan_tag, member_role_id,
          officer_role_id, leader_role_id, ${joinColumn}, log_channel_id, sync_interval_mins, last_sync_at FROM legacy_clans;
          DROP TABLE legacy_clans;`);
      } else if (columns.length && !columns.some(c => c.name === "join_role_id")) {
        this.db.exec("ALTER TABLE guild_clan_configs ADD COLUMN join_role_id TEXT");
      }
      this.db.exec(`UPDATE linked_users SET linked_at = replace(linked_at, ' ', 'T') || 'Z'
        WHERE linked_at LIKE '% %' AND linked_at NOT LIKE '%Z';
        UPDATE guild_clan_configs SET last_sync_at = replace(last_sync_at, ' ', 'T') || 'Z'
        WHERE last_sync_at LIKE '% %' AND last_sync_at NOT LIKE '%Z';`);
      // Old manual links have no guild provenance: quarantine them for safe local re-linking.
      const legacy = this.db.prepare("SELECT * FROM linked_users WHERE verified_method = 'admin_manual'").all() as unknown as LinkedUser[];
      for (const link of legacy) {
        this.audit(null, "migration", link.discord_id, "legacy_manual_revoked", link.openfront_id, null);
        this.enqueueAll(link.discord_id, 10);
      }
      this.db.exec(`INSERT OR IGNORE INTO legacy_manual_links SELECT discord_id, openfront_id,
        openfront_username, linked_at, '${new Date().toISOString()}' FROM linked_users WHERE verified_method = 'admin_manual'`);
      this.db.exec("DELETE FROM linked_users WHERE verified_method = 'admin_manual'");
      HistoryStore.initialize(this.db);
      CommunityStore.initialize(this.db);
    });
    this.community = new CommunityStore(this.db, binding => {
      const current = this.getEffectiveLink(binding.guildId, binding.discordId);
      return current?.openfront_id === binding.publicId && current.linked_at === binding.linkedAt &&
        !this.history.isDeleted(binding.publicId);
    });
    this.history = new HistoryStore(this.db, {
      purgeAccount: publicId => this.community.purgeAccount(publicId),
      clearGameEvidence: guildId => this.community.clearGameEvidence(guildId),
      retainGameEvidence: (guildId, cutoff) => this.community.retainGameEvidence(guildId, cutoff),
    });
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = action(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.close(); }
  getGuildSettings(guild: string): GuildSettings | null {
    return this.db.prepare("SELECT * FROM guild_settings WHERE guild_id=?").get(guild) as unknown as GuildSettings ?? null;
  }
  setManagerRole(guild: string, role: string, expectedRevision = 0): GuildSettings {
    return this.transaction(() => {
      const previous = this.getGuildSettings(guild);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new Error("The access role changed in another session. Open the configuration menu again.");
      this.db.prepare(`INSERT INTO guild_settings(guild_id,manager_role_id,revision) VALUES(?,?,1)
        ON CONFLICT(guild_id) DO UPDATE SET manager_role_id=excluded.manager_role_id,revision=guild_settings.revision+1`).run(guild,role);
      return this.getGuildSettings(guild)!;
    });
  }
  private audit(guild: string | null, actor: string, user: string, action: string, oldId: string | null, newId: string | null) {
    this.db.prepare(`INSERT INTO link_audit(guild_id,actor_id,discord_id,action,old_id,new_id,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(guild,actor,user,action,oldId,newId,new Date().toISOString());
  }
  getDebugSettings(guild: string): DebugSettings | null {
    return this.db.prepare("SELECT * FROM guild_debug_settings WHERE guild_id=?").get(guild) as unknown as DebugSettings ?? null;
  }
  setDebugRole(guild: string, role: string | null, expectedRevision = 0): DebugSettings {
    return this.transaction(() => {
      if ((this.getDebugSettings(guild)?.revision ?? 0) !== expectedRevision) throw new Error("The debug role changed in another session. Open the configuration menu again.");
      this.db.prepare(`INSERT INTO guild_debug_settings(guild_id,debug_role_id,revision) VALUES(?,?,1)
        ON CONFLICT(guild_id) DO UPDATE SET debug_role_id=excluded.debug_role_id,revision=guild_debug_settings.revision+1`).run(guild,role);
      return this.getDebugSettings(guild)!;
    });
  }
  setDebugOptions(guild: string, options: { verboseErrors?: boolean; ephemeralReplies?: boolean }, expectedRevision: number): DebugSettings {
    return this.transaction(() => {
      if (this.getDebugSettings(guild)?.revision !== expectedRevision) throw new Error("Debug settings changed in another session. Try again.");
      this.db.prepare(`UPDATE guild_debug_settings SET verbose_errors=COALESCE(?,verbose_errors),
        ephemeral_replies=COALESCE(?,ephemeral_replies),revision=revision+1 WHERE guild_id=?`)
        .run(options.verboseErrors === undefined ? null : Number(options.verboseErrors),
          options.ephemeralReplies === undefined ? null : Number(options.ephemeralReplies), guild);
      return this.getDebugSettings(guild)!;
    });
  }
  getUserByDiscordId(id: string): LinkedUser | null {
    return this.db.prepare("SELECT * FROM linked_users WHERE discord_id = ?").get(id) as unknown as LinkedUser ?? null;
  }
  getUserByOpenFrontId(id: string): LinkedUser | null {
    return this.db.prepare("SELECT * FROM linked_users WHERE openfront_id = ?").get(id) as unknown as LinkedUser ?? null;
  }
  getGuildLink(guild: string, id: string): LinkedUser | null {
    return this.db.prepare("SELECT * FROM guild_links WHERE guild_id = ? AND discord_id = ?").get(guild,id) as unknown as LinkedUser ?? null;
  }
  getEffectiveLink(guild: string, id: string) { return this.getUserByDiscordId(id) ?? this.getGuildLink(guild,id); }
  getEffectiveLinkByOpenFrontId(guild: string, id: string): LinkedUser | null {
    return this.getUserByOpenFrontId(id) ?? this.db.prepare(`SELECT g.* FROM guild_links g WHERE guild_id = ? AND openfront_id = ?
      AND NOT EXISTS (SELECT 1 FROM linked_users u WHERE u.discord_id = g.discord_id OR u.openfront_id = g.openfront_id)`).get(guild,id) as unknown as LinkedUser ?? null;
  }
  getEffectiveLinks(guild: string): LinkedUser[] {
    return this.db.prepare(`SELECT * FROM linked_users UNION ALL
      SELECT g.discord_id,g.openfront_id,g.openfront_username,g.linked_at,g.verified_method FROM guild_links g
      WHERE g.guild_id=? AND NOT EXISTS (SELECT 1 FROM linked_users u WHERE u.discord_id=g.discord_id OR u.openfront_id=g.openfront_id)
      ORDER BY openfront_username COLLATE NOCASE`).all(guild) as unknown as LinkedUser[];
  }
  private nextIdentityTimestamp(previous: (LinkedUser | null)[]): string {
    // Monotonic within this process even after unlink, when no previous row remains.
    this.lastIdentityTime = Math.max(Date.now(), this.lastIdentityTime + 1,
      ...previous.map(link => link ? Date.parse(link.linked_at) + 1 || 0 : 0));
    return new Date(this.lastIdentityTime).toISOString();
  }
  linkUser(id: string, ofId: string, username: string | null, method: string, originGuild: string | null = null) {
    if (!["identity_token", "profile_discord"].includes(method)) throw new Error("Global links require ownership verification.");
    this.transaction(() => {
      const old = this.getUserByDiscordId(id);
      const locals = this.db.prepare("SELECT * FROM guild_links WHERE discord_id = ? OR openfront_id = ?").all(id,ofId) as unknown as (LinkedUser & {guild_id:string})[];
      this.history.purgeIdentity(id);
      // Same-account re-verification retains award deduplication; its new binding still invalidates stale lookups.
      if (old && old.openfront_id !== ofId) this.community.purgeIdentity(id);
      const linkedAt = this.nextIdentityTimestamp([old,...locals]);
      this.db.prepare(`INSERT INTO linked_users(discord_id,openfront_id,openfront_username,linked_at,verified_method) VALUES(?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET
        openfront_id=excluded.openfront_id, openfront_username=excluded.openfront_username,
        linked_at=excluded.linked_at, verified_method=excluded.verified_method`).run(id,ofId,username,linkedAt,method);
      // Verified ownership invalidates conflicting local claims and the owner's old local links.
      for (const local of locals) {
        this.history.purgeMember(local.guild_id,local.discord_id);
        if (local.discord_id !== id || local.openfront_id !== ofId) this.community.purgeIdentity(local.discord_id,local.guild_id);
        this.audit(local.guild_id,id,local.discord_id,"local_superseded",local.openfront_id,null);
        this.enqueueGuild(local.guild_id,local.discord_id,[],10);
      }
      this.db.prepare("DELETE FROM guild_links WHERE discord_id = ? OR openfront_id = ?").run(id,ofId);
      this.audit(originGuild,id,id,"global_link",old?.openfront_id ?? null,ofId);
      this.enqueueAll(id);
    });
  }
  unlinkUser(id: string, originGuild: string | null = null): boolean {
    return this.transaction(() => {
      const global = this.getUserByDiscordId(id);
      const locals = this.db.prepare("SELECT * FROM guild_links WHERE discord_id = ?").all(id) as unknown as (LinkedUser & {guild_id:string})[];
      if (!global && !locals.length) return false;
      this.history.purgeIdentity(id);
      this.community.purgeIdentity(id);
      this.db.prepare("DELETE FROM linked_users WHERE discord_id = ?").run(id);
      this.db.prepare("DELETE FROM guild_links WHERE discord_id = ?").run(id);
      for (const local of locals) {
        this.audit(local.guild_id,id,id,"local_self_unlink",local.openfront_id,null);
        this.enqueueGuild(local.guild_id,id,[],10);
      }
      this.audit(originGuild,id,id,"global_unlink",global?.openfront_id ?? null,null);
      this.enqueueAll(id, 10);
      return true;
    });
  }
  linkGuildUser(guild: string, actor: string, id: string, ofId: string, username: string | null) {
    this.transaction(() => {
      if (this.getUserByDiscordId(id) || this.getUserByOpenFrontId(ofId)) throw new Error("A verified bot-wide link exists. Only its owner can change it with /link or /unlink.");
      const old = this.getGuildLink(guild,id);
      this.history.purgeMember(guild,id);
      if (old && old.openfront_id !== ofId) this.community.purgeIdentity(id,guild);
      const linkedAt = this.nextIdentityTimestamp([old]);
      const other = this.db.prepare("SELECT discord_id FROM guild_links WHERE guild_id=? AND openfront_id=?").get(guild,ofId);
      if (other && other.discord_id !== id) throw new Error("That OpenFront account already has a manual link in this server.");
      this.db.prepare(`INSERT INTO guild_links(guild_id,discord_id,openfront_id,openfront_username,linked_at,verified_method) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,discord_id) DO UPDATE SET
        openfront_id=excluded.openfront_id,openfront_username=excluded.openfront_username,
        linked_at=excluded.linked_at,verified_method=excluded.verified_method`).run(guild,id,ofId,username,linkedAt,"admin_manual");
      this.audit(guild,actor,id,"local_link",old?.openfront_id ?? null,ofId);
      this.enqueueGuild(guild,id);
    });
  }
  unlinkGuildUser(guild: string, actor: string, id: string): boolean {
    return this.transaction(() => {
      const old = this.getGuildLink(guild,id);
      if (!old) return false;
      this.history.purgeMember(guild,id);
      this.community.purgeIdentity(id,guild);
      this.db.prepare("DELETE FROM guild_links WHERE guild_id=? AND discord_id=?").run(guild,id);
      this.audit(guild,actor,id,"local_unlink",old.openfront_id,null);
      this.enqueueGuild(guild,id,[],10);
      return true;
    });
  }
  updateUsername(id: string, username: string, guild?: string) {
    this.db.prepare("UPDATE linked_users SET openfront_username=? WHERE discord_id=?").run(username,id);
    if (guild) this.db.prepare("UPDATE guild_links SET openfront_username=? WHERE guild_id=? AND discord_id=?").run(username,guild,id);
  }
  getAudit(guild: string | null, user: string | null, page = 1, ownHistory = false): AuditEntry[] {
    const parameters: (string | number)[] = [];
    let where: string;
    if (ownHistory && user) {
      where = "discord_id=? AND (guild_id=? OR action IN ('global_link','global_unlink','legacy_manual_revoked'))";
      parameters.push(user, guild ?? "");
    } else if (guild) {
      where = "guild_id=?";
      parameters.push(guild);
      if (user) { where += " AND discord_id=?"; parameters.push(user); }
    } else {
      if (!user) throw new Error("An audit query requires a guild or a user.");
      where = "discord_id=?";
      parameters.push(user);
    }
    return this.db.prepare(`SELECT * FROM link_audit WHERE ${where} ORDER BY id DESC LIMIT 10 OFFSET ?`)
      .all(...parameters, (page - 1) * 10) as unknown as AuditEntry[];
  }
  enqueueGuild(guild: string, id: string, extraRoles: string[] = [], priority = 0) {
    const previous = this.db.prepare("SELECT role_ids FROM role_jobs WHERE guild_id=? AND discord_id=?").get(guild,id);
    const roles = [...new Set([...managedRoles(this.getGuildConfigs(guild)), ...extraRoles,
      ...(previous ? JSON.parse(String(previous.role_ids)) as string[] : [])])];
    this.db.prepare(`INSERT INTO role_jobs(guild_id,discord_id,role_ids,version,priority,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(guild_id,discord_id) DO UPDATE SET role_ids=excluded.role_ids,version=excluded.version,
      available_at=0,attempts=0,last_error=NULL,priority=MAX(role_jobs.priority,excluded.priority)`).run(guild,id,JSON.stringify(roles),randomUUID(),priority,Date.now());
  }
  private enqueueAll(id: string, priority = 0) {
    for (const guild of new Set(this.getAllGuildConfigs().map(c=>c.guild_id))) this.enqueueGuild(guild,id,[],priority);
  }
  nextJob(now = Date.now(), afterGuild = ""): RoleJob | null {
    return this.db.prepare(`SELECT * FROM role_jobs WHERE available_at <= ? ORDER BY priority DESC,
      CASE WHEN guild_id > ? THEN 0 ELSE 1 END, guild_id, available_at, rowid LIMIT 1`).get(now,afterGuild) as unknown as RoleJob ?? null;
  }
  progressJob(job: RoleJob, remainingRoleIds: string[]) {
    this.db.prepare("UPDATE role_jobs SET role_ids=? WHERE guild_id=? AND discord_id=? AND version=?")
      .run(JSON.stringify(remainingRoleIds),job.guild_id,job.discord_id,job.version);
  }
  getQueueSummary(guild: string) {
    const row = this.db.prepare(`SELECT COUNT(*) AS pending,COALESCE(SUM(attempts>0),0) AS retrying,
      MIN(CASE WHEN available_at=0 THEN created_at ELSE available_at END) AS oldestAvailableAt
      FROM role_jobs WHERE guild_id=?`).get(guild)!;
    const error = this.db.prepare("SELECT last_error FROM role_jobs WHERE guild_id=? AND last_error IS NOT NULL ORDER BY created_at LIMIT 1").get(guild);
    return { pending: Number(row.pending), retrying: Number(row.retrying), oldestAvailableAt: row.oldestAvailableAt === null ? null : Number(row.oldestAvailableAt), lastError: error ? String(error.last_error) : null };
  }
  finishJob(job: RoleJob) {
    this.db.prepare("DELETE FROM role_jobs WHERE guild_id=? AND discord_id=? AND version=?").run(job.guild_id,job.discord_id,job.version);
  }
  retryJob(job: RoleJob, error: string) {
    this.db.prepare(`UPDATE role_jobs SET attempts=attempts+1, available_at=?, last_error=?
      WHERE guild_id=? AND discord_id=? AND version=?`).run(Date.now()+Math.min(3600000,60000*2**Math.min(job.attempts,6)),error.slice(0,500),job.guild_id,job.discord_id,job.version);
  }
  getJob(guild: string, id: string): RoleJob | null {
    return this.db.prepare("SELECT * FROM role_jobs WHERE guild_id=? AND discord_id=?").get(guild,id) as unknown as RoleJob ?? null;
  }
  setGuildClanConfig(c: GuildClanConfig, guildMemberIds: string[] = []) {
    this.transaction(() => {
      const old = this.getGuildClanConfig(c.guild_id, c.clan_tag);
      if (!old) this.history.clearGuildPlayerMatches(c.guild_id);
      for (const id of guildMemberIds) this.enqueueGuild(c.guild_id, id, [...managedRoles(old ? [old] : []), ...managedRoles([c])]);
      this.db.prepare(`INSERT INTO guild_clan_configs(guild_id,clan_tag,member_role_id,officer_role_id,leader_role_id,
        join_role_id,log_channel_id,sync_interval_mins,last_sync_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,clan_tag) DO UPDATE SET
        member_role_id=excluded.member_role_id,officer_role_id=excluded.officer_role_id,leader_role_id=excluded.leader_role_id,
        join_role_id=excluded.join_role_id,log_channel_id=excluded.log_channel_id,sync_interval_mins=excluded.sync_interval_mins,last_sync_at=NULL`)
        .run(c.guild_id,c.clan_tag.trim().toUpperCase(),c.member_role_id,c.officer_role_id,c.leader_role_id,c.join_role_id,c.log_channel_id,c.sync_interval_mins,c.last_sync_at);
    });
  }
  updateClanLastSync(guild: string, tag: string) {
    this.db.prepare("UPDATE guild_clan_configs SET last_sync_at=? WHERE guild_id=? AND clan_tag=?").run(new Date().toISOString(),guild,tag.trim().toUpperCase());
  }
  getGuildClanConfig(guild: string, tag: string): GuildClanConfig | null {
    return this.db.prepare("SELECT * FROM guild_clan_configs WHERE guild_id=? AND clan_tag=?").get(guild,tag.trim().toUpperCase()) as unknown as GuildClanConfig ?? null;
  }
  getGuildConfigs(guild: string): GuildClanConfig[] {
    return this.db.prepare("SELECT * FROM guild_clan_configs WHERE guild_id=? ORDER BY clan_tag").all(guild) as unknown as GuildClanConfig[];
  }
  deleteGuildClanConfig(guild: string, tag: string, guildMemberIds: string[] = []): boolean {
    return this.transaction(() => {
      const config = this.getGuildClanConfig(guild, tag);
      if (!config) return false;
      this.history.purgeClan(guild,tag);
      for (const id of guildMemberIds) this.enqueueGuild(guild, id, managedRoles([config]));
      return Number(this.db.prepare("DELETE FROM guild_clan_configs WHERE guild_id=? AND clan_tag=?").run(guild,tag.trim().toUpperCase()).changes)>0;
    });
  }
  getAllGuildConfigs(): GuildClanConfig[] {
    return this.db.prepare("SELECT * FROM guild_clan_configs").all() as unknown as GuildClanConfig[];
  }
}
export const db = new BotDatabase();
