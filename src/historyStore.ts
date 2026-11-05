import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { OpenFrontClanSession, OpenFrontPlayerSession } from "./historyTypes.js";

export interface HistorySettings {
  guild_id: string; revision: number; clan_history_enabled: number; player_history_enabled: number;
  collection_enabled: number; weekly_enabled: number; channel_id: string | null; poll_minutes: number;
  retention_days: number; weekly_day: number; weekly_hour: number; timezone: string;
}
export type HistorySettingsDraft = Omit<HistorySettings, "guild_id" | "revision">;
export interface StoredPlayerSession extends OpenFrontPlayerSession { public_id: string; discord_id: string }
export interface HistoryJob {
  guild_id: string; kind: "clan" | "player"; subject: string; discord_id: string | null; identity_version: string | null;
  window_start: string; window_end: string; page: number; cursor: string | null;
  next_attempt: number; attempts: number; last_error: string | null; last_work: number;
}
export interface HistoryCoverage { complete: boolean; coveredDays: number; totalDays: number }
export interface HistoryJobInput {
  kind: "clan" | "player"; subject: string; discordId?: string | null; identityVersion?: string | null;
}
export interface EloObservation { publicId: string; discordId: string | null; ladder: string; rating: number }
export interface WeeklyDelivery {
  guild_id: string; period_start: string; period_end: string; channel_id: string; nonce: string;
  status: "pending" | "sending" | "sent" | "failed"; attempts: number; next_attempt: number;
  message_id: string | null; last_error: string | null;
}
export const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const dayFloor = (ms: number) => Math.floor(ms / DAY) * DAY;
const SETTINGS_COLUMNS = `guild_id,revision,clan_history_enabled,player_history_enabled,collection_enabled,
  weekly_enabled,channel_id,poll_minutes,retention_days,weekly_day,weekly_hour,timezone`;

export class HistoryStore {
  constructor(private readonly db: DatabaseSync, private readonly cleanup?: {
    purgeAccount(publicId: string): void;
    clearGameEvidence(guildId?: string): void;
    retainGameEvidence?(guildId: string, cutoff: number): void;
  }) {}
  /** Called inside BotDatabase's backed-up migration transaction. */
  static initialize(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS history_settings (
        guild_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, clan_history_enabled INTEGER NOT NULL DEFAULT 1,
        player_history_enabled INTEGER NOT NULL DEFAULT 1, collection_enabled INTEGER NOT NULL DEFAULT 0,
        weekly_enabled INTEGER NOT NULL DEFAULT 0, channel_id TEXT, poll_minutes INTEGER NOT NULL DEFAULT 15,
        retention_days INTEGER NOT NULL DEFAULT 90, weekly_day INTEGER NOT NULL DEFAULT 1,
        weekly_hour INTEGER NOT NULL DEFAULT 12, timezone TEXT NOT NULL DEFAULT 'UTC', weekly_since TEXT);
      CREATE TABLE IF NOT EXISTS history_clan_matches (
        guild_id TEXT NOT NULL, clan_tag TEXT NOT NULL, game_id TEXT NOT NULL, game_start TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(guild_id,clan_tag,game_id));
      CREATE INDEX IF NOT EXISTS history_clan_time ON history_clan_matches(guild_id,game_start);
      CREATE TABLE IF NOT EXISTS history_player_matches (
        guild_id TEXT NOT NULL, public_id TEXT NOT NULL, discord_id TEXT NOT NULL,
        game_id TEXT NOT NULL, game_start TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(guild_id,public_id,game_id));
      CREATE INDEX IF NOT EXISTS history_player_time ON history_player_matches(guild_id,game_start);
      CREATE INDEX IF NOT EXISTS history_player_public_id ON history_player_matches(public_id);
      CREATE INDEX IF NOT EXISTS history_player_identity ON history_player_matches(discord_id,guild_id,public_id);
      CREATE TABLE IF NOT EXISTS history_observed_elo (
        guild_id TEXT NOT NULL, public_id TEXT NOT NULL, discord_id TEXT, ladder TEXT NOT NULL,
        hour_bucket INTEGER NOT NULL, observed_at TEXT NOT NULL, rating REAL NOT NULL,
        PRIMARY KEY(guild_id,public_id,ladder,hour_bucket));
      CREATE INDEX IF NOT EXISTS history_elo_time ON history_observed_elo(guild_id,observed_at);
      CREATE INDEX IF NOT EXISTS history_elo_player ON history_observed_elo(public_id);
      CREATE INDEX IF NOT EXISTS history_elo_identity ON history_observed_elo(discord_id,guild_id,public_id) WHERE discord_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS history_jobs (
        guild_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, discord_id TEXT, identity_version TEXT,
        window_start TEXT NOT NULL, window_end TEXT NOT NULL, page INTEGER NOT NULL DEFAULT 1, cursor TEXT,
        next_attempt INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        last_work INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id,kind,subject));
      CREATE INDEX IF NOT EXISTS history_job_subject ON history_jobs(kind,subject);
      CREATE INDEX IF NOT EXISTS history_job_last_work ON history_jobs(last_work);
      CREATE INDEX IF NOT EXISTS history_job_identity ON history_jobs(discord_id,guild_id,subject) WHERE kind='player';
      CREATE TABLE IF NOT EXISTS history_coverage (
        guild_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
        collected_at TEXT NOT NULL, PRIMARY KEY(guild_id,kind,subject,start,end));
      CREATE INDEX IF NOT EXISTS history_coverage_subject ON history_coverage(kind,subject);
      CREATE TABLE IF NOT EXISTS history_weekly_deliveries (
        guild_id TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, channel_id TEXT NOT NULL,
        nonce TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, message_id TEXT, last_error TEXT,
        PRIMARY KEY(guild_id,period_start,period_end));
      CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_deleted_players (public_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL);
    `);
    // Convert the original default once; later explicit/custom schedules remain user controlled.
    if (!db.prepare("SELECT 1 FROM history_meta WHERE key='weekly_utc_noon_v1'").get()) {
      const changedAt = new Date().toISOString();
      db.prepare(`UPDATE history_settings SET weekly_hour=12,timezone='UTC',revision=revision+1,
        weekly_since=CASE WHEN weekly_enabled=1 THEN ? ELSE weekly_since END
        WHERE weekly_hour=9 AND timezone='America/Bahia'`).run(changedAt);
      db.prepare("INSERT INTO history_meta(key,value) VALUES('weekly_utc_noon_v1',?)").run(changedAt);
    }
  }
  getSettings(guild: string): HistorySettings {
    return this.db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM history_settings WHERE guild_id=?`)
      .get(guild) as unknown as HistorySettings ?? { guild_id: guild, revision: 0, clan_history_enabled: 1,
        player_history_enabled: 1, collection_enabled: 0, weekly_enabled: 0, channel_id: null,
        poll_minutes: 15, retention_days: 90, weekly_day: 1, weekly_hour: 12, timezone: "UTC" };
  }
  listSettings(): HistorySettings[] {
    return this.db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM history_settings`).all() as unknown as HistorySettings[];
  }
  saveSettings(guild: string, draft: HistorySettingsDraft, expectedRevision: number): HistorySettings {
    for (const value of [draft.clan_history_enabled,draft.player_history_enabled,draft.collection_enabled,draft.weekly_enabled])
      if (![0,1].includes(value)) throw new Error("History toggles must be on or off.");
    for (const [value,min,max,label] of [[draft.poll_minutes,5,1440,"Poll interval"], [draft.retention_days,14,365,"Retention"],
      [draft.weekly_day,0,6,"Weekly day"], [draft.weekly_hour,0,23,"Weekly hour"]] as const)
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
    try { new Intl.DateTimeFormat("en", { timeZone: draft.timezone }).format(); }
    catch { throw new Error("Choose a valid IANA timezone, such as America/Bahia or UTC."); }
    if (draft.weekly_enabled && (!draft.collection_enabled || !draft.channel_id)) throw new Error("Weekly recaps require collection and a recap channel.");
    if (draft.channel_id !== null && !/^\d{1,22}$/.test(draft.channel_id)) throw new Error("Choose a server text channel for recaps.");
    const previous = this.getSettings(guild);
    if (previous.revision !== expectedRevision) throw new Error("History settings changed in another session. Open the configuration menu again.");
    this.db.prepare(`INSERT INTO history_settings(guild_id,revision,clan_history_enabled,player_history_enabled,collection_enabled,
      weekly_enabled,channel_id,poll_minutes,retention_days,weekly_day,weekly_hour,timezone,weekly_since)
      VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET revision=history_settings.revision+1,
      clan_history_enabled=excluded.clan_history_enabled,player_history_enabled=excluded.player_history_enabled,
      collection_enabled=excluded.collection_enabled,weekly_enabled=excluded.weekly_enabled,channel_id=excluded.channel_id,
      poll_minutes=excluded.poll_minutes,retention_days=excluded.retention_days,weekly_day=excluded.weekly_day,
      weekly_hour=excluded.weekly_hour,timezone=excluded.timezone,
      weekly_since=CASE WHEN history_settings.weekly_enabled=0 AND excluded.weekly_enabled=1 THEN excluded.weekly_since ELSE history_settings.weekly_since END`)
      .run(guild,draft.clan_history_enabled,draft.player_history_enabled,draft.collection_enabled,draft.weekly_enabled,draft.channel_id,
        draft.poll_minutes,draft.retention_days,draft.weekly_day,draft.weekly_hour,draft.timezone,iso(Date.now()));
    if (!draft.player_history_enabled) this.clearGuildPlayerHistory(guild);
    else if (!draft.collection_enabled) this.cleanup?.clearGameEvidence(guild);
    return this.getSettings(guild);
  }
  getWeeklyEnabledAt(guild: string): string | null {
    return this.db.prepare("SELECT weekly_since FROM history_settings WHERE guild_id=?").get(guild)?.weekly_since as string | null ?? null;
  }
  getClanMatches(guild: string, tag: string, start: string, end: string): OpenFrontClanSession[] {
    return [...this.iterateClanMatches(guild,tag,start,end)];
  }
  /** Consume synchronously; never retain an active SQLite iterator across an await. */
  *iterateClanMatches(guild: string, tag: string, start: string, end: string): IterableIterator<OpenFrontClanSession> {
    const rows = this.db.prepare(`SELECT payload FROM history_clan_matches WHERE guild_id=? AND clan_tag=? AND game_start>=? AND game_start<? ORDER BY game_start DESC,game_id`)
      .iterate(guild,tag.trim().toUpperCase(),start,end);
    for (const row of rows) yield JSON.parse(String(row.payload)) as OpenFrontClanSession;
  }
  upsertClanMatches(guild: string, tag: string, matches: OpenFrontClanSession[]) {
    const normalized = tag.trim().toUpperCase();
    const statement = this.db.prepare(`INSERT INTO history_clan_matches(guild_id,clan_tag,game_id,game_start,payload) VALUES(?,?,?,?,?)
      ON CONFLICT(guild_id,clan_tag,game_id) DO UPDATE SET game_start=excluded.game_start,payload=excluded.payload`);
    this.savePage(() => {
      for (const match of matches) if (match.clanTag.trim().toUpperCase() === normalized)
        statement.run(guild,normalized,match.gameId,iso(Date.parse(match.gameStart)),JSON.stringify(match));
    });
  }
  getPlayerMatches(guild: string, start: string, end: string): StoredPlayerSession[] {
    return [...this.iteratePlayerMatches(guild,start,end)];
  }
  /** Consume synchronously; never retain an active SQLite iterator across an await. */
  *iteratePlayerMatches(guild: string, start: string, end: string): IterableIterator<StoredPlayerSession> {
    const rows = this.db.prepare(`SELECT public_id,discord_id,payload FROM history_player_matches WHERE guild_id=? AND game_start>=? AND game_start<? ORDER BY game_start DESC,game_id`)
      .iterate(guild,start,end);
    for (const row of rows) yield { ...JSON.parse(String(row.payload)) as OpenFrontPlayerSession,
      public_id: String(row.public_id), discord_id: String(row.discord_id) };
  }
  upsertPlayerMatches(guild: string, publicId: string, discordId: string, matches: OpenFrontPlayerSession[]) {
    if (this.isDeleted(publicId)) return;
    const statement = this.db.prepare(`INSERT INTO history_player_matches(guild_id,public_id,discord_id,game_id,game_start,payload) VALUES(?,?,?,?,?,?)
      ON CONFLICT(guild_id,public_id,game_id) DO UPDATE SET discord_id=excluded.discord_id,game_start=excluded.game_start,payload=excluded.payload
      WHERE history_player_matches.discord_id IS NOT excluded.discord_id OR history_player_matches.game_start IS NOT excluded.game_start
      OR history_player_matches.payload IS NOT excluded.payload`);
    this.savePage(() => {
      for (const match of matches) statement.run(guild,publicId,discordId,match.gameId,iso(Date.parse(match.gameStart)),JSON.stringify(match));
    });
  }
  private savePage(save: () => void) {
    // Savepoints batch disk commits and preserve any transaction owned by the caller.
    this.db.exec("SAVEPOINT history_page");
    try {
      save();
      this.db.exec("RELEASE history_page");
    } catch (error) {
      this.db.exec("ROLLBACK TO history_page; RELEASE history_page");
      throw error;
    }
  }
  recordElo(guild: string, publicId: string, discordId: string | null, ladder: string, rating: number, now = Date.now()): void {
    this.recordEloBatch(guild, [{ publicId, discordId, ladder, rating }], now);
  }
  /** One captured leaderboard instant; settings, tombstones and retention are shared by the batch. */
  recordEloBatch(guild: string, observations: readonly EloObservation[], now = Date.now()): void {
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return;
    const valid = observations.filter(row => ["1v1","2v2","ffa"].includes(row.ladder) &&
      Number.isFinite(row.rating) && Math.abs(row.rating) <= Number.MAX_SAFE_INTEGER);
    if (!valid.length) return;
    const observedAt = iso(now), hourBucket = Math.floor(now / 3_600_000);
    this.savePage(() => {
      const settings = this.getSettings(guild);
      if (guild !== "dm" && !settings.player_history_enabled) return;
      const deleted = new Set(this.db.prepare(`SELECT public_id FROM history_deleted_players
        WHERE public_id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify([...new Set(valid.map(row => row.publicId))])).map(row => String(row.public_id)));
      const eligible = valid.filter(row => !deleted.has(row.publicId));
      if (!eligible.length) return;
      const insert = this.db.prepare(`INSERT INTO history_observed_elo(guild_id,public_id,discord_id,ladder,hour_bucket,observed_at,rating)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(guild_id,public_id,ladder,hour_bucket) DO UPDATE SET
        discord_id=COALESCE(excluded.discord_id,history_observed_elo.discord_id),
        observed_at=excluded.observed_at,rating=excluded.rating
        WHERE excluded.observed_at>=history_observed_elo.observed_at`);
      for (const row of eligible) insert.run(guild,row.publicId,row.discordId,row.ladder,hourBucket,observedAt,row.rating);
      const days = Number.isFinite(settings.retention_days) ? Math.max(1,Math.min(365,settings.retention_days)) : 90;
      this.db.prepare("DELETE FROM history_observed_elo WHERE guild_id=? AND observed_at<?").run(guild,iso(now-days*DAY));
    });
  }
  getEloHistory(guild: string, publicId: string, ladder: string, startISO: string, endISO: string, now = Date.now()): {at:string;rating:number}[] {
    const start = Date.parse(startISO), end = Date.parse(endISO);
    const settings = this.getSettings(guild);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) || this.isDeleted(publicId)
      || (guild !== "dm" && !settings.player_history_enabled) || !["1v1","2v2","ffa"].includes(ladder)) return [];
    const days = Number.isFinite(settings.retention_days) ? Math.max(1,Math.min(365,settings.retention_days)) : 90;
    const retainedStart = Math.max(start,now-days*DAY);
    if (end <= retainedStart) return [];
    return this.db.prepare(`SELECT observed_at,rating FROM history_observed_elo
      WHERE guild_id=? AND public_id=? AND ladder=? AND observed_at>=? AND observed_at<? ORDER BY observed_at`)
      .all(guild,publicId,ladder,iso(retainedStart),iso(end)).map(row => ({at:String(row.observed_at),rating:Number(row.rating)}));
  }
  pruneEloObservations(now = Date.now()): void {
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return;
    const guilds = this.db.prepare(`SELECT g.guild_id,s.retention_days
      FROM (SELECT DISTINCT guild_id FROM history_observed_elo) g
      LEFT JOIN history_settings s ON s.guild_id=g.guild_id`).all();
    const remove = this.db.prepare("DELETE FROM history_observed_elo WHERE guild_id=? AND observed_at<?");
    for (const row of guilds) {
      const guild = String(row.guild_id), retention = row.retention_days as number;
      const days = Number.isFinite(retention) ? Math.max(1,Math.min(365,retention)) : 90;
      remove.run(guild,iso(now-days*DAY));
    }
  }
  /** Stream ordered intervals once for a report inventory, retaining only per-subject accumulators. */
  getCoverageBySubject(guild: string, kind: "clan" | "player", subjects: readonly string[], start: string, end: string): Map<string, HistoryCoverage> {
    const unique = [...new Set(subjects.map(subject => kind === "clan" ? subject.trim().toUpperCase() : subject))];
    const from = Date.parse(start), until = Date.parse(end);
    if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from)
      return new Map(unique.map(subject => [subject, { complete: false, coveredDays: 0, totalDays: 0 }]));
    if (!unique.length) return new Map();
    const states = new Map(unique.map(subject => [subject, { cursor: from, covered: 0, complete: true }]));
    const intervals = this.db.prepare(`SELECT subject,start,end FROM history_coverage WHERE guild_id=? AND kind=?
      AND subject IN (SELECT value FROM json_each(?)) AND start<? AND end>? ORDER BY subject,start,end`)
      .iterate(guild,kind,JSON.stringify(unique),end,start);
    for (const interval of intervals) {
      const state = states.get(String(interval.subject))!;
      const lower = Math.max(from,Date.parse(String(interval.start))), upper = Math.min(until,Date.parse(String(interval.end)));
      if (lower > state.cursor) state.complete = false;
      if (upper > state.cursor) { state.covered += upper - Math.max(state.cursor,lower); state.cursor = upper; }
    }
    return new Map([...states].map(([subject, state]) => [subject, {
      complete: state.complete && state.cursor >= until,
      coveredDays: Math.min(Math.round(state.covered / DAY),Math.round((until-from)/DAY)),
      totalDays: Math.round((until-from)/DAY) || 1,
    }]));
  }
  getClanCoverage(guild: string, tag: string, start: string, end: string) {
    const normalized = tag.trim().toUpperCase();
    return this.getCoverageBySubject(guild,"clan",[normalized],start,end).get(normalized)!;
  }
  getPlayerCoverage(guild: string, publicId: string, start: string, end: string) {
    return this.getCoverageBySubject(guild,"player",[publicId],start,end).get(publicId)!;
  }
  markCoverage(job: HistoryJob, now: number) {
    this.db.prepare(`INSERT INTO history_coverage(guild_id,kind,subject,start,end,collected_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(guild_id,kind,subject,start,end) DO UPDATE SET collected_at=excluded.collected_at`)
      .run(job.guild_id,job.kind,job.subject,job.window_start,job.window_end,iso(now));
  }
  ensureJob(guild: string, kind: "clan" | "player", subject: string, now: number, discordId: string | null = null, identityVersion: string | null = null) {
    this.ensureJobs(guild,[{kind,subject,discordId,identityVersion}],now);
  }
  /** Refresh bindings without rewriting unchanged checkpoints or retry state. */
  ensureJobs(guild: string, inputs: readonly HistoryJobInput[], now: number) {
    if (!inputs.length) return;
    type Binding = Pick<HistoryJob,"kind" | "subject" | "discord_id" | "identity_version">;
    const stored = this.db.prepare(`SELECT kind,subject,discord_id,identity_version FROM history_jobs WHERE guild_id=?
      AND (kind,subject) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`)
      .all(guild,JSON.stringify(inputs.map(input=>[input.kind,input.subject]))) as unknown as Binding[];
    const bindings = new Map(stored.map(job=>[`${job.kind}:${job.subject}`,job]));
    const players = [...new Set(inputs.filter(input=>input.kind === "player").map(input=>input.subject))];
    const deleted = new Set(players.length ? this.db.prepare(`SELECT public_id FROM history_deleted_players
      WHERE public_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(players)).map(row=>String(row.public_id)) : []);
    const changes: { binding: Binding; replace: boolean }[] = [];
    // Advance the inventory for duplicate subjects in input order, just as individual ensures do.
    for (const input of inputs) {
      if (input.kind === "player" && deleted.has(input.subject)) continue;
      const key = `${input.kind}:${input.subject}`, previous = bindings.get(key);
      const binding: Binding = { kind: input.kind, subject: input.subject,
        discord_id: input.discordId ?? null, identity_version: input.identityVersion ?? null };
      if (previous && previous.discord_id === binding.discord_id && previous.identity_version === binding.identity_version) continue;
      changes.push({binding,replace:!!previous});
      bindings.set(key,binding);
    }
    if (!changes.length) return;
    const start = dayFloor(now - 7*DAY), windowStart = iso(start), windowEnd = iso(Math.min(start+DAY,now));
    const insert = this.db.prepare(`INSERT OR IGNORE INTO history_jobs(guild_id,kind,subject,discord_id,identity_version,window_start,window_end) VALUES(?,?,?,?,?,?,?)`);
    this.savePage(() => {
      for (const {binding,replace} of changes) {
        if (replace) {
          if (binding.kind === "player") this.purgeGuildPlayer(guild,binding.subject);
          else this.db.prepare("DELETE FROM history_jobs WHERE guild_id=? AND kind=? AND subject=?").run(guild,binding.kind,binding.subject);
        }
        insert.run(guild,binding.kind,binding.subject,binding.discord_id,binding.identity_version,windowStart,windowEnd);
      }
    });
  }
  getJob(guild: string, kind: string, subject: string): HistoryJob | null {
    return this.db.prepare("SELECT * FROM history_jobs WHERE guild_id=? AND kind=? AND subject=?").get(guild,kind,subject) as unknown as HistoryJob ?? null;
  }
  removeJobs(guild: string, kind: "clan" | "player") {
    this.db.prepare("DELETE FROM history_jobs WHERE guild_id=? AND kind=?").run(guild,kind);
  }
  nextJob(now: number, guilds: string[], allowPlayers = true): HistoryJob | null {
    if (!guilds.length) return null;
    return this.db.prepare(`SELECT * FROM history_jobs WHERE guild_id IN (${guilds.map(()=>"?").join(",")}) AND next_attempt<=?
      ${allowPlayers ? "" : "AND kind='clan'"} ORDER BY last_work,guild_id,kind,subject LIMIT 1`).get(...guilds,now) as unknown as HistoryJob ?? null;
  }
  touchJob(job: HistoryJob) {
    const maximum = Number(this.db.prepare("SELECT COALESCE(MAX(last_work),0) AS value FROM history_jobs").get()!.value);
    this.db.prepare("UPDATE history_jobs SET last_work=? WHERE guild_id=? AND kind=? AND subject=?").run(maximum+1,job.guild_id,job.kind,job.subject);
  }
  advancePage(job: HistoryJob, cursor: string | null, page: number) {
    this.db.prepare("UPDATE history_jobs SET cursor=?,page=?,attempts=0,last_error=NULL WHERE guild_id=? AND kind=? AND subject=?")
      .run(cursor,page,job.guild_id,job.kind,job.subject);
  }
  finishWindow(job: HistoryJob, now: number, pollMinutes: number) {
    this.markCoverage(job,now);
    const end = Date.parse(job.window_end), caughtUp = end >= now - 60_000;
    const nextStart = caughtUp ? Math.max(dayFloor(now-DAY),dayFloor(now-7*DAY)) : end;
    this.db.prepare(`UPDATE history_jobs SET window_start=?,window_end=?,page=1,cursor=NULL,next_attempt=?,attempts=0,last_error=NULL WHERE guild_id=? AND kind=? AND subject=?`)
      .run(iso(nextStart),iso(Math.min(nextStart+DAY,now)),caughtUp ? now+pollMinutes*60_000 : 0,job.guild_id,job.kind,job.subject);
  }
  retryJob(job: HistoryJob, error: string, now: number) {
    this.db.prepare("UPDATE history_jobs SET attempts=attempts+1,last_error=?,next_attempt=? WHERE guild_id=? AND kind=? AND subject=?")
      .run(error.slice(0,500),now+Math.min(3_600_000,60_000*2**Math.min(job.attempts,6)),job.guild_id,job.kind,job.subject);
  }
  pruneClans(guild: string, tags: Set<string>) {
    const stored = this.db.prepare("SELECT DISTINCT subject FROM history_jobs WHERE guild_id=? AND kind='clan'").all(guild);
    for (const row of stored) if (!tags.has(String(row.subject))) this.purgeClan(guild,String(row.subject));
    const matches = this.db.prepare("SELECT DISTINCT clan_tag FROM history_clan_matches WHERE guild_id=?").all(guild);
    for (const row of matches) if (!tags.has(String(row.clan_tag))) this.purgeClan(guild,String(row.clan_tag));
  }
  purgeClan(guild: string, tag: string) {
    const normalized = tag.trim().toUpperCase();
    this.db.prepare("DELETE FROM history_clan_matches WHERE guild_id=? AND clan_tag=?").run(guild,normalized);
    this.db.prepare("DELETE FROM history_jobs WHERE guild_id=? AND kind='clan' AND subject=?").run(guild,normalized);
    this.db.prepare("DELETE FROM history_coverage WHERE guild_id=? AND kind='clan' AND subject=?").run(guild,normalized);
    // Player windows were filtered against the old configured tag set. Rebuild their coverage with the new set.
    this.clearGuildPlayerMatches(guild);
  }
  prunePlayerMembers(guild: string, valid: {discord_id:string;openfront_id:string}[]) {
    const validMap = new Map(valid.map(link=>[link.discord_id,link.openfront_id]));
    const rows = this.db.prepare(`SELECT DISTINCT public_id,discord_id FROM history_player_matches WHERE guild_id=?
      UNION SELECT subject AS public_id,discord_id FROM history_jobs WHERE guild_id=? AND kind='player'
      UNION SELECT public_id,discord_id FROM history_observed_elo WHERE guild_id=? AND discord_id IS NOT NULL`).all(guild,guild,guild);
    for (const row of rows) if (validMap.get(String(row.discord_id)) !== String(row.public_id)) {
      this.purgeGuildPlayerMatches(guild,String(row.public_id));
      // Public profile observations have no membership association and expire through retention.
      this.db.prepare("DELETE FROM history_observed_elo WHERE guild_id=? AND public_id=? AND discord_id=?")
        .run(guild,String(row.public_id),row.discord_id);
    }
  }
  private purgeGuildPlayerMatches(guild: string, publicId: string) {
    this.db.prepare("DELETE FROM history_player_matches WHERE guild_id=? AND public_id=?").run(guild,publicId);
    this.db.prepare("DELETE FROM history_jobs WHERE guild_id=? AND kind='player' AND subject=?").run(guild,publicId);
    this.db.prepare("DELETE FROM history_coverage WHERE guild_id=? AND kind='player' AND subject=?").run(guild,publicId);
  }
  purgeGuildPlayer(guild: string, publicId: string) {
    this.purgeGuildPlayerMatches(guild,publicId);
    this.db.prepare("DELETE FROM history_observed_elo WHERE guild_id=? AND public_id=?").run(guild,publicId);
  }
  purgeMember(guild: string, discordId: string) {
    const ids = this.db.prepare(`SELECT public_id FROM history_player_matches WHERE guild_id=? AND discord_id=?
      UNION SELECT subject AS public_id FROM history_jobs WHERE guild_id=? AND discord_id=? AND kind='player'
      UNION SELECT public_id FROM history_observed_elo WHERE guild_id=? AND discord_id=?`)
      .all(guild,discordId,guild,discordId,guild,discordId);
    for (const row of ids) this.purgeGuildPlayer(guild,String(row.public_id));
  }
  purgeIdentity(discordId: string) {
    const guilds = this.db.prepare(`SELECT DISTINCT guild_id FROM history_player_matches WHERE discord_id=?
      UNION SELECT guild_id FROM history_jobs WHERE discord_id=? AND kind='player'
      UNION SELECT guild_id FROM history_observed_elo WHERE discord_id=?`).all(discordId,discordId,discordId);
    for (const row of guilds) this.purgeMember(String(row.guild_id),discordId);
  }
  purgePlayer(publicId: string, deletedAt = iso(Date.now())) {
    this.cleanup?.purgeAccount(publicId);
    this.db.prepare("INSERT INTO history_deleted_players(public_id,deleted_at) VALUES(?,?) ON CONFLICT(public_id) DO UPDATE SET deleted_at=excluded.deleted_at").run(publicId,deletedAt);
    this.db.prepare("DELETE FROM history_player_matches WHERE public_id=?").run(publicId);
    this.db.prepare("DELETE FROM history_observed_elo WHERE public_id=?").run(publicId);
    this.db.prepare("DELETE FROM history_jobs WHERE kind='player' AND subject=?").run(publicId);
    this.db.prepare("DELETE FROM history_coverage WHERE kind='player' AND subject=?").run(publicId);
  }
  isDeleted(publicId: string): boolean { return !!this.db.prepare("SELECT 1 FROM history_deleted_players WHERE public_id=?").get(publicId); }
  clearGuildPlayerMatches(guild: string) {
    this.cleanup?.clearGameEvidence(guild);
    this.db.prepare("DELETE FROM history_player_matches WHERE guild_id=?").run(guild);
    this.db.prepare("DELETE FROM history_jobs WHERE guild_id=? AND kind='player'").run(guild);
    this.db.prepare("DELETE FROM history_coverage WHERE guild_id=? AND kind='player'").run(guild);
  }
  clearGuildPlayerHistory(guild: string) {
    this.clearGuildPlayerMatches(guild);
    this.db.prepare("DELETE FROM history_observed_elo WHERE guild_id=?").run(guild);
  }
  clearAllPlayerHistory() {
    this.cleanup?.clearGameEvidence();
    this.db.exec("DELETE FROM history_player_matches; DELETE FROM history_observed_elo; DELETE FROM history_jobs WHERE kind='player'; DELETE FROM history_coverage WHERE kind='player';");
  }
  retain(guild: string, days: number, now: number) {
    const cutoff = iso(dayFloor(now-days*DAY));
    this.db.prepare("DELETE FROM history_clan_matches WHERE guild_id=? AND game_start<?").run(guild,cutoff);
    this.db.prepare("DELETE FROM history_player_matches WHERE guild_id=? AND game_start<?").run(guild,cutoff);
    this.cleanup?.retainGameEvidence?.(guild, Date.parse(cutoff));
    const eloDays = Number.isFinite(days) ? Math.max(1,Math.min(365,days)) : 90;
    this.db.prepare("DELETE FROM history_observed_elo WHERE guild_id=? AND observed_at<?").run(guild,iso(now-eloDays*DAY));
    this.db.prepare("DELETE FROM history_coverage WHERE guild_id=? AND end<?").run(guild,cutoff);
    this.db.prepare("DELETE FROM history_weekly_deliveries WHERE guild_id=? AND period_end<? AND status='sent'").run(guild,cutoff);
    // An interrupted old backfill cannot keep collecting beyond the configured retention horizon.
    this.db.prepare("UPDATE history_jobs SET window_start=?,window_end=?,page=1,cursor=NULL WHERE guild_id=? AND window_start<?")
      .run(cutoff,iso(Math.min(Date.parse(cutoff)+DAY,now)),guild,cutoff);
  }
  getMeta(key: string): string | null { return this.db.prepare("SELECT value FROM history_meta WHERE key=?").get(key)?.value as string ?? null; }
  hasEloObservations(): boolean { return !!this.db.prepare("SELECT 1 FROM history_observed_elo LIMIT 1").get(); }
  setMeta(key: string, value: string) { this.db.prepare("INSERT INTO history_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value); }
  getStatus(guild: string) {
    const count = (table: string) => Number(this.db.prepare(`SELECT count(*) AS value FROM ${table} WHERE guild_id=?`).get(guild)!.value);
    const jobs = this.db.prepare("SELECT count(*) AS pending,COALESCE(sum(attempts>0),0) AS failed FROM history_jobs WHERE guild_id=?").get(guild)!;
    const coverage = this.db.prepare("SELECT min(start) AS first,max(end) AS last,max(collected_at) AS collected FROM history_coverage WHERE guild_id=?").get(guild)!;
    const error = this.db.prepare("SELECT last_error FROM history_jobs WHERE guild_id=? AND last_error IS NOT NULL ORDER BY last_work DESC LIMIT 1").get(guild);
    const deliveryError = this.db.prepare("SELECT last_error FROM history_weekly_deliveries WHERE guild_id=? AND last_error IS NOT NULL ORDER BY period_end DESC LIMIT 1").get(guild);
    const elo = this.db.prepare("SELECT count(*) AS observations,max(observed_at) AS last FROM history_observed_elo WHERE guild_id=?").get(guild)!;
    const settings = this.getSettings(guild);
    return { clanMatches: count("history_clan_matches"),playerMatches: count("history_player_matches"),pending: Number(jobs.pending),failed: Number(jobs.failed),
      eloObservations: Number(elo.observations), eloLastObservedAt: elo.last as string | null,
      eloError: settings.collection_enabled && settings.player_history_enabled ? this.getMeta("elo_error") : null,
      lastCollectedAt: coverage.collected as string | null,lastError: (error?.last_error as string | null ?? deliveryError?.last_error as string | null ?? this.getMeta(`guild_error:${guild}`)) || this.getMeta("deletions_error"),
      coverageStart: coverage.first as string | null,coveredThrough: coverage.last as string | null };
  }
  getDelivery(guild: string, start: string, end: string): WeeklyDelivery | null {
    return this.db.prepare("SELECT * FROM history_weekly_deliveries WHERE guild_id=? AND period_start=? AND period_end=?").get(guild,start,end) as unknown as WeeklyDelivery ?? null;
  }
  ensureDelivery(guild: string, start: string, end: string, channelId: string): WeeklyDelivery {
    const nonce = createHash("sha256").update(`${guild}:${start}:${end}`).digest("hex").slice(0,24);
    this.db.prepare("INSERT OR IGNORE INTO history_weekly_deliveries(guild_id,period_start,period_end,channel_id,nonce) VALUES(?,?,?,?,?)").run(guild,start,end,channelId,nonce);
    return this.getDelivery(guild,start,end)!;
  }
  attemptDelivery(delivery: WeeklyDelivery) {
    this.db.prepare("UPDATE history_weekly_deliveries SET attempts=attempts+1,status='sending',last_error=NULL WHERE guild_id=? AND period_start=? AND period_end=?")
      .run(delivery.guild_id,delivery.period_start,delivery.period_end);
  }
  finishDelivery(delivery: WeeklyDelivery, messageId: string) {
    this.db.prepare("UPDATE history_weekly_deliveries SET status='sent',message_id=?,last_error=NULL WHERE guild_id=? AND period_start=? AND period_end=?")
      .run(messageId,delivery.guild_id,delivery.period_start,delivery.period_end);
  }
  retryDelivery(delivery: WeeklyDelivery, error: string, now: number) {
    this.db.prepare("UPDATE history_weekly_deliveries SET status=?,last_error=?,next_attempt=? WHERE guild_id=? AND period_start=? AND period_end=?")
      .run(delivery.attempts >= 5 ? "failed" : "pending",error.slice(0,500),now+Math.min(3_600_000,60_000*2**Math.min(delivery.attempts,6)),delivery.guild_id,delivery.period_start,delivery.period_end);
  }
}
