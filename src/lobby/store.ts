import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CommandError } from "../commandError.js";
import { withCommunityTransaction } from "../community/transactions.js";
import { matches, normalize, type Lobby, type Rule } from "./model.js";
export interface Settings {
  guild: string;
  enabled: boolean;
  channel: string | null;
  revision: number;
}
export interface Search {
  guild: string;
  user: string;
  generation: string;
  state: string;
  pending: string | null;
  deadline: number | null;
}
const decodeSearch = (r: Record<string, unknown>): Search => ({
  guild: String(r.guild),
  user: String(r.user),
  generation: String(r.generation),
  state: String(r.state),
  pending: r.pending as string | null,
  deadline: r.deadline === null ? null : Number(r.deadline),
});
export interface Notification {
  id: string;
  guild: string;
  user: string;
  generation: string;
  revision: number;
  lobby: Lobby;
  status: string;
  attempts: number;
  next: number;
  message: string | null;
  channel: string | null;
  deadline: number | null;
  error: string | null;
}
const decodeNotification = (r: Record<string, unknown>): Notification => ({
  id: String(r.id),
  guild: String(r.guild),
  user: String(r.user),
  generation: String(r.generation),
  revision: Number(r.revision),
  lobby: JSON.parse(String(r.lobby)),
  status: String(r.status),
  attempts: Number(r.attempts),
  next: Number(r.next),
  message: r.message as string | null,
  channel: r.channel as string | null,
  deadline: r.deadline === null ? null : Number(r.deadline),
  error: r.error as string | null,
});
export class LobbyStore {
  private pruneCursor: { updated: number; id: string } | null = null;
  constructor(private readonly sql: DatabaseSync) {}
  static initialize(sql: DatabaseSync): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS lobby_settings(guild TEXT PRIMARY KEY,enabled INTEGER NOT NULL,channel TEXT,revision INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS lobby_rules(id TEXT PRIMARY KEY,guild TEXT NOT NULL,user TEXT NOT NULL,rule TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS lobby_rules_owner ON lobby_rules(guild,user);
   CREATE TABLE IF NOT EXISTS lobby_searches(guild TEXT NOT NULL,user TEXT NOT NULL,generation TEXT NOT NULL,state TEXT NOT NULL,pending TEXT,deadline INTEGER,last_work INTEGER NOT NULL,PRIMARY KEY(guild,user));
   CREATE INDEX IF NOT EXISTS lobby_search_due ON lobby_searches(state,last_work,guild,user);
   CREATE INDEX IF NOT EXISTS lobby_search_expiry ON lobby_searches(state,deadline);
   CREATE INDEX IF NOT EXISTS lobby_search_pending ON lobby_searches(pending) WHERE pending IS NOT NULL;
   CREATE TABLE IF NOT EXISTS lobby_notifications(id TEXT PRIMARY KEY,guild TEXT NOT NULL,user TEXT NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL,
    source TEXT NOT NULL,lobby_id TEXT NOT NULL,lobby TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL,
    message TEXT,channel TEXT,deadline INTEGER,error TEXT,updated INTEGER NOT NULL,UNIQUE(guild,user,source,lobby_id));
   CREATE INDEX IF NOT EXISTS lobby_notification_due ON lobby_notifications(status,next,updated);
   CREATE INDEX IF NOT EXISTS lobby_notification_owner ON lobby_notifications(guild,user);
   CREATE INDEX IF NOT EXISTS lobby_notification_retention ON lobby_notifications(updated);
   CREATE INDEX IF NOT EXISTS lobby_notification_terminal_retention ON lobby_notifications(updated,id) WHERE status IN ('sent','cancelled','review');`);
  }
  private transaction<T>(fn: () => T): T {
    return withCommunityTransaction(this.sql, fn);
  }
  settings(guild: string): Settings {
    const r = this.sql
      .prepare("SELECT * FROM lobby_settings WHERE guild=?")
      .get(guild);
    return r
      ? {
          guild,
          enabled: !!r.enabled,
          channel: r.channel as string | null,
          revision: Number(r.revision),
        }
      : { guild, enabled: false, channel: null, revision: 0 };
  }
  configure(
    guild: string,
    enabled: boolean,
    channel: string | null,
    now: number,
  ): Settings {
    if (enabled && !channel)
      throw new CommandError(
        "Configure a fallback channel before enabling lobby alerts.",
      );
    return this.transaction(() => {
      const current = this.settings(guild);
      this.sql
        .prepare(
          `INSERT INTO lobby_settings VALUES(?,?,?,?) ON CONFLICT(guild) DO UPDATE SET enabled=excluded.enabled,channel=excluded.channel,revision=excluded.revision`,
        )
        .run(guild, Number(enabled), channel, current.revision + 1);
      this.sql
        .prepare(
          `UPDATE lobby_searches SET state='stopped',pending=NULL,deadline=NULL,generation=hex(randomblob(16)) WHERE guild=?`,
        )
        .run(guild);
      this.sql
        .prepare(
          `DELETE FROM lobby_notifications WHERE guild=? AND status IN ('pending_dm','pending_fallback')`,
        )
        .run(guild);
      return this.settings(guild);
    });
  }
  rules(guild: string, user: string): Rule[] {
    return this.sql
      .prepare(
        "SELECT id,rule FROM lobby_rules WHERE guild=? AND user=? ORDER BY rowid",
      )
      .all(guild, user)
      .map((r) => ({ ...JSON.parse(String(r.rule)), id: String(r.id) }));
  }
  watch(guild: string, user: string, rule: Rule, now: number): Rule {
    if (!this.settings(guild).enabled)
      throw new CommandError(
        "Lobby alerts must be configured and enabled by a server manager first.",
      );
    if (!rule.name?.trim() || rule.name.length > 60)
      throw new CommandError("Give the rule a name of 1–60 characters.");
    if (
      !rule.map &&
      !rule.mode &&
      !rule.category &&
      rule.min === undefined &&
      rule.max === undefined
    )
      throw new CommandError("Choose at least one lobby filter.");
    if (
      [rule.map, rule.mode, rule.category].some(
        (v) =>
          v !== undefined &&
          (typeof v !== "string" || !v.trim() || v.length > 100),
      )
    )
      throw new CommandError("Choose a valid lobby filter.");
    for (const n of [rule.min, rule.max])
      if (n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > 1000))
        throw new CommandError(
          "Player counts must be whole numbers from 0 to 1000.",
        );
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max)
      throw new CommandError("Minimum players cannot exceed maximum players.");
    return this.transaction(() => {
      if (this.rules(guild, user).length >= 10)
        throw new CommandError(
          "You can save at most ten lobby rules. Remove one first.",
        );
      const clean: Rule = {
        name: rule.name!.trim(),
        map: rule.map?.trim(),
        mode: rule.mode?.trim(),
        category: rule.category?.trim(),
        min: rule.min,
        max: rule.max,
      };
      const id = randomUUID();
      this.sql
        .prepare("INSERT INTO lobby_rules VALUES(?,?,?,?)")
        .run(id, guild, user, JSON.stringify(clean));
      this.resume(guild, user, now);
      return { ...clean, id };
    });
  }
  search(guild: string, user: string): Search | null {
    const r = this.sql
      .prepare("SELECT * FROM lobby_searches WHERE guild=? AND user=?")
      .get(guild, user);
    return r ? decodeSearch(r) : null;
  }
  stop(guild: string, user: string, now: number): void {
    this.transaction(() => {
      this.sql
        .prepare(
          `UPDATE lobby_searches SET state='stopped',pending=NULL,deadline=NULL,generation=? WHERE guild=? AND user=?`,
        )
        .run(randomUUID(), guild, user);
      this.sql
        .prepare(
          `DELETE FROM lobby_notifications WHERE guild=? AND user=? AND status IN ('pending_dm','pending_fallback')`,
        )
        .run(guild, user);
    });
  }
  resume(guild: string, user: string, now: number): void {
    if (!this.settings(guild).enabled)
      throw new CommandError("Lobby alerts are not enabled in this server.");
    if (!this.rules(guild, user).length)
      throw new CommandError("Save a lobby watch rule first.");
    this.transaction(() => {
      this.stop(guild, user, now);
      this.sql
        .prepare(
          `INSERT INTO lobby_searches VALUES(?,?,?,'searching',NULL,NULL,?) ON CONFLICT(guild,user) DO UPDATE SET generation=excluded.generation,state='searching',pending=NULL,deadline=NULL,last_work=excluded.last_work`,
        )
        .run(guild, user, randomUUID(), now);
    });
  }
  remove(guild: string, user: string, id: string, now: number): void {
    this.transaction(() => {
      if (
        !this.sql
          .prepare("DELETE FROM lobby_rules WHERE id=? AND guild=? AND user=?")
          .run(id, guild, user).changes
      )
        throw new CommandError(
          "That rule does not belong to you or no longer exists.",
        );
      const remaining = this.rules(guild, user);
      if (!remaining.length) {
        this.stop(guild, user, now);
        return;
      }
      const search = this.search(guild, user);
      if (search?.state === "delivering" && search.pending) {
        const candidate = this.notification(search.pending);
        if (
          candidate &&
          !remaining.some((rule) => matches(rule, candidate.lobby, now))
        )
          this.obsolete(candidate.id, now);
      }
    });
  }
  candidates(limit: number, now: number): Search[] {
    const rows = this.sql
      .prepare(
        `SELECT * FROM lobby_searches WHERE state='searching' ORDER BY last_work,guild,user LIMIT ?`,
      )
      .all(limit);
    if (rows.length)
      this.sql
        .prepare(
          `UPDATE lobby_searches SET last_work=? WHERE (guild,user) IN
           (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`,
        )
        .run(now, JSON.stringify(rows.map((r) => [r.guild, r.user])));
    return rows.map(decodeSearch);
  }
  handledLobbies(guild: string, user: string, lobbies: Lobby[]): Set<string> {
    if (!lobbies.length) return new Set();
    // Iterate only the current snapshot and probe the unique owner/source/id index.
    const pairs = JSON.stringify(lobbies.map((l) => [l.source, l.id]));
    const rows = this.sql.prepare(`
      SELECT n.source,n.lobby_id
      FROM json_each(?) AS candidate
      CROSS JOIN lobby_notifications AS n
        ON n.guild=? AND n.user=?
        AND n.source=json_extract(candidate.value, '$[0]')
        AND n.lobby_id=json_extract(candidate.value, '$[1]')
    `).all(pairs, guild, user);
    return new Set(rows.map((r) => JSON.stringify([r.source, r.lobby_id])));
  }
  select(
    guild: string,
    user: string,
    lobby: Lobby,
    now: number,
  ): Notification | null {
    return this.transaction(() => {
      const s = this.search(guild, user),
        config = this.settings(guild);
      if (
        !s ||
        s.state !== "searching" ||
        !config.enabled ||
        !this.rules(guild, user).some((r) => matches(r, lobby, now))
      )
        return null;
      const id = randomUUID();
      const result = this.sql
        .prepare(
          `INSERT OR IGNORE INTO lobby_notifications(id,guild,user,generation,revision,source,lobby_id,lobby,status,next,updated) VALUES(?,?,?,?,?,?,?,?,'pending_dm',?,?)`,
        )
        .run(
          id,
          guild,
          user,
          s.generation,
          config.revision,
          lobby.source,
          lobby.id,
          JSON.stringify(lobby),
          now,
          now,
        );
      if (!result.changes) return null;
      this.sql
        .prepare(
          `UPDATE lobby_searches SET state='delivering',pending=?,deadline=NULL WHERE guild=? AND user=?`,
        )
        .run(id, guild, user);
      return this.notification(id);
    });
  }
  notification(id: string): Notification | null {
    const r = this.sql
      .prepare("SELECT * FROM lobby_notifications WHERE id=?")
      .get(id);
    return r ? decodeNotification(r) : null;
  }
  valid(n: Notification): boolean {
    return !!this.sql
      .prepare(
        `SELECT 1 FROM lobby_searches AS search
         JOIN lobby_settings AS config ON config.guild=search.guild
         JOIN lobby_notifications AS saved ON saved.id=search.pending
         WHERE search.guild=? AND search.user=? AND search.state='delivering'
           AND search.pending=? AND search.generation=?
           AND config.enabled<>0 AND config.revision=?
           AND saved.status IN ('pending_dm','pending_fallback','sending_dm','sending_fallback')`,
      )
      .get(n.guild, n.user, n.id, n.generation, n.revision);
  }
  due(now: number): Notification[] {
    return this.sql
      .prepare(
        `SELECT * FROM lobby_notifications WHERE status IN ('pending_dm','pending_fallback','sending_dm','sending_fallback') AND next<=? ORDER BY next,updated,id LIMIT 4`,
      )
      .all(now)
      .map(decodeNotification);
  }
  begin(id: string, fallback: boolean, now: number): boolean {
    return !!this.sql
      .prepare(
        `UPDATE lobby_notifications AS notification SET status=?,updated=?
         WHERE id=? AND status=? AND EXISTS (
           SELECT 1 FROM lobby_searches AS search
           JOIN lobby_settings AS config ON config.guild=search.guild
           WHERE search.guild=notification.guild AND search.user=notification.user
             AND search.state='delivering' AND search.pending=notification.id
             AND search.generation=notification.generation
             AND config.enabled<>0 AND config.revision=notification.revision
         )`,
      )
      .run(
        fallback ? "sending_fallback" : "sending_dm",
        now,
        id,
        fallback ? "pending_fallback" : "pending_dm",
      ).changes;
  }
  rejected(id: string, now: number): void {
    this.sql
      .prepare(
        `UPDATE lobby_notifications SET status='pending_fallback',next=?,updated=? WHERE id=? AND status IN ('pending_dm','sending_dm')`,
      )
      .run(now, now, id);
  }
  retry(id: string, error: string, now: number): void {
    const n = this.notification(id);
    if (!n) return;
    if (n.attempts >= 2) {
      this.review(id, error, now);
      return;
    }
    this.sql
      .prepare(
        `UPDATE lobby_notifications SET status=?,attempts=attempts+1,error=?,next=?,updated=? WHERE id=?`,
      )
      .run(
        n.status.endsWith("fallback") ? "pending_fallback" : "pending_dm",
        error.slice(0, 180),
        now + 5000 * 2 ** n.attempts,
        now,
        id,
      );
  }
  review(id: string, error: string, now: number): void {
    const n = this.notification(id);
    if (!n) return;
    this.sql
      .prepare(
        `UPDATE lobby_notifications SET status='review',error=?,updated=? WHERE id=?`,
      )
      .run(error.slice(0, 180), now, id);
    if (this.search(n.guild, n.user)?.generation === n.generation)
      this.stop(n.guild, n.user, now);
  }
  obsolete(id: string, now: number): void {
    const n = this.notification(id);
    if (!n) return;
    this.transaction(() => {
      // Only pending work is known not to have an uncertain send in flight.
      // Keep sending and terminal records as deduplication/recovery evidence.
      const removed = this.sql
        .prepare(
          `DELETE FROM lobby_notifications WHERE id=? AND status IN ('pending_dm','pending_fallback')`,
        )
        .run(id).changes;
      const s = this.search(n.guild, n.user);
      if (
        removed &&
        s?.generation === n.generation &&
        s.state === "delivering" &&
        s.pending === id
      )
        this.sql
          .prepare(
            `UPDATE lobby_searches SET state='searching',pending=NULL,deadline=NULL WHERE guild=? AND user=?`,
          )
          .run(n.guild, n.user);
    });
  }
  delivered(
    id: string,
    channel: string,
    message: string,
    createdAt: number,
  ): void {
    const n = this.notification(id);
    if (!n) return;
    this.transaction(() => {
      this.sql
        .prepare(
          `UPDATE lobby_notifications SET status='sent',channel=?,message=?,deadline=?,updated=? WHERE id=?`,
        )
        .run(channel, message, createdAt + 180000, createdAt, id);
      const s = this.search(n.guild, n.user);
      if (
        s?.generation === n.generation &&
        s.state === "delivering" &&
        s.pending === id
      )
        this.sql
          .prepare(
            `UPDATE lobby_searches SET state='waiting',deadline=? WHERE guild=? AND user=?`,
          )
          .run(createdAt + 180000, n.guild, n.user);
    });
  }
  continue(
    id: string,
    user: string,
    channel: string,
    message: string,
    now: number,
  ): void {
    this.expire(now);
    const n = this.notification(id);
    if (!n || n.user !== user)
      throw new CommandError("This alert does not belong to you.");
    const s = this.search(n.guild, n.user);
    if (n.channel !== channel || n.message !== message)
      throw new CommandError("This is not the delivered alert message.");
    if (
      !s ||
      s.generation !== n.generation ||
      s.state !== "waiting" ||
      s.pending !== id ||
      !n.deadline ||
      now >= n.deadline ||
      !this.settings(n.guild).enabled
    )
      throw new CommandError(
        "This continuation has expired or was already used. Use /lobby action:resume in the server.",
      );
    this.sql
      .prepare(
        `UPDATE lobby_searches SET state='searching',pending=NULL,deadline=NULL,last_work=? WHERE guild=? AND user=? AND generation=? AND pending=?`,
      )
      .run(now, n.guild, n.user, n.generation, id);
  }
  expire(now: number): void {
    this.sql
      .prepare(
        `UPDATE lobby_searches SET state='stopped',pending=NULL,deadline=NULL WHERE state='waiting' AND deadline<=?`,
      )
      .run(now);
  }
  diagnostics(guild: string): Notification[] {
    return this.sql
      .prepare(
        `SELECT * FROM lobby_notifications WHERE guild=? AND status='review' ORDER BY updated DESC LIMIT 5`,
      )
      .all(guild)
      .map(decodeNotification);
  }
  prune(now: number, live: Lobby[]): void {
    const select = this.sql.prepare(
      `SELECT id,source,lobby_id,updated FROM lobby_notifications INDEXED BY lobby_notification_terminal_retention
       WHERE updated<? AND status IN ('sent','cancelled','review') AND (updated,id)>(?,?)
       ORDER BY updated,id LIMIT 200`,
    );
    const cutoff = now - 30 * 86400000;
    const first = { updated: Number.MIN_SAFE_INTEGER, id: "" };
    const cursor = this.pruneCursor ?? first;
    let rows = select.all(cutoff, cursor.updated, cursor.id);
    if (!rows.length && this.pruneCursor) {
      this.pruneCursor = null;
      rows = select.all(cutoff, first.updated, first.id);
    }
    if (rows.length) {
      const last = rows[rows.length - 1];
      this.pruneCursor = { updated: Number(last.updated), id: String(last.id) };
    }
    const liveKeys = new Set(live.map((l) => JSON.stringify([l.source, l.id])));
    const pending = this.sql.prepare("SELECT 1 FROM lobby_searches WHERE pending=?");
    const remove = this.sql.prepare("DELETE FROM lobby_notifications WHERE id=?");
    for (const r of rows)
      if (
        !liveKeys.has(JSON.stringify([r.source, r.lobby_id])) &&
        !pending.get(r.id!)
      )
        remove.run(r.id!);
  }
}
