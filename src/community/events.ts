import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CommandError } from "../commandError.js";
import { withCommunityTransaction } from "./transactions.js";
import { DeliveryStore } from "./deliveries.js";
import type { DeliveryJob } from "./types.js";
export interface EventDraftInput {
  guildId: string;
  channelId: string;
  creatorId: string;
  title: string;
  description: string;
  startAt: number;
  durationMinutes: number;
  capacity: number;
  squads: {
    id: string;
    name: string;
    capacity: number;
  }[];
  reminderMinutes: 0 | 15 | 30 | 60;
  settingsText?: string;
}
export interface EventRecord extends EventDraftInput {
  id: string;
  messageId: string | null;
  status: 'draft' | 'scheduled' | 'cancelled' | 'finished';
  revision: number;
  createdAt: number;
}
export interface EventSignup {
  discordId: string;
  squadId: string | null;
  state: 'confirmed' | 'reserve';
  sequence: number;
  reminder: boolean;
}
export interface EventParticipants {
  entries: EventSignup[];
  total: number;
  confirmed: number;
  squadConfirmed: Record<string, number>;
  page: number;
}
const signupRow = (r: Record<string, unknown>): EventSignup => ({
  discordId: String(r.discord_id),
  squadId: r.squad_id as string | null,

  state: r.state as EventSignup['state'],
  sequence: Number(r.sequence),
  reminder: !!r.reminder,
});
const changed = () => new CommandError("This event changed or is unavailable. Reopen /event view or edit.");
const decode = (row: Record<string, unknown>): EventRecord => ({
  ...JSON.parse(String(row.data)),
  id: String(row.id),
  messageId: row.message_id as string | null,

  status: row.status,
  revision: Number(row.revision),
  createdAt: Number(row.created_at)
});
export function initializeEvents(sql: DatabaseSync): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS community_events (
    id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,
    start_at INTEGER NOT NULL,created_at INTEGER NOT NULL,revision INTEGER NOT NULL,message_id TEXT,
    next_sequence INTEGER NOT NULL DEFAULT 1,card_version INTEGER NOT NULL DEFAULT 0,promotion_due INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS community_event_guild_start ON community_events(guild_id,start_at,id);
    CREATE INDEX IF NOT EXISTS community_event_due ON community_events(status,promotion_due,start_at);
    CREATE TABLE IF NOT EXISTS community_event_signups (
    guild_id TEXT NOT NULL,event_id TEXT NOT NULL,discord_id TEXT NOT NULL,squad_id TEXT,state TEXT NOT NULL,
    sequence INTEGER NOT NULL,reminder INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(event_id,discord_id),UNIQUE(event_id,sequence));
    CREATE INDEX IF NOT EXISTS community_signup_capacity ON community_event_signups(event_id,squad_id,state,sequence);
    CREATE INDEX IF NOT EXISTS community_signup_member ON community_event_signups(guild_id,discord_id,event_id);`);
  // Compatible upgrade for event records saved before background work was introduced.
  const columns = new Set(sql.prepare('PRAGMA table_info(community_events)').all().map(r => r.name));
  for (const [name, definition] of [
    ['end_at', 'INTEGER NOT NULL DEFAULT 0'], ['retire_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['reminder_at', 'INTEGER'], ['closed_card', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!columns.has(name)) {
      sql.exec(`ALTER TABLE community_events ADD COLUMN ${name} ${definition}`);
    }
  }
  if (!columns.has('end_at')) {
    sql.exec(`UPDATE community_events SET end_at=start_at+json_extract(data,'$.durationMinutes')*60000,
      retire_at=start_at+json_extract(data,'$.durationMinutes')*60000,
      reminder_at=CASE WHEN json_extract(data,'$.reminderMinutes')>0
        THEN start_at-json_extract(data,'$.reminderMinutes')*60000 END`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS community_signup_page ON community_event_signups(event_id,guild_id,sequence);
    CREATE INDEX IF NOT EXISTS community_signup_counts ON community_event_signups(event_id,guild_id,state,squad_id);
    CREATE INDEX IF NOT EXISTS community_event_reminder_due ON community_events(guild_id,status,reminder_at,id);
    CREATE INDEX IF NOT EXISTS community_event_close_due ON community_events(guild_id,status,closed_card,start_at);
    CREATE INDEX IF NOT EXISTS community_event_end_due ON community_events(guild_id,status,end_at);
    CREATE INDEX IF NOT EXISTS community_event_retention ON community_events(retire_at,id) WHERE status IN ('scheduled','finished','cancelled');
    CREATE INDEX IF NOT EXISTS community_event_promotion ON community_events(guild_id,status,promotion_due,start_at);
    CREATE TABLE IF NOT EXISTS community_event_reminder_parts (
      guild_id TEXT NOT NULL,event_id TEXT NOT NULL,revision INTEGER NOT NULL,part INTEGER NOT NULL,
      recipients TEXT NOT NULL,PRIMARY KEY(event_id,revision,part));
    CREATE INDEX IF NOT EXISTS community_reminder_parts_guild ON community_event_reminder_parts(guild_id,event_id);`);
}
function validate(input: EventDraftInput, now: number, checkTime = true): EventDraftInput {
  const value = {
    ...input,
    durationMinutes: input.durationMinutes ?? 120,
    capacity: input.capacity ?? 20,
    reminderMinutes: input.reminderMinutes ?? 0,
    squads: input.squads ?? []
  };
  const textFields: [string, number, boolean][] = [
    [value.title, 100, false],
    [value.description, 1000, true],
    [value.settingsText ?? '', 500, true],
  ];
  for (const [text, max, empty] of textFields) {
    if (typeof text !== 'string' || text.length > max || (!empty && !text.trim())) {
      throw new CommandError("Use a title of 1–100 characters, description up to 1000 and settings up to 500.");
    }
  }
  if ([value.guildId, value.channelId, value.creatorId].some(v => typeof v !== 'string' || !v)) {
    throw new CommandError("Invalid event destination or creator.");
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(value.startAt) || (checkTime && (value.startAt <= now || value.startAt > now + 365 * 86400000))) {
    throw new CommandError("Choose an event start in the next 365 days.");
  }
  if (!Number.isInteger(value.durationMinutes) || value.durationMinutes < 15 || value.durationMinutes > 720) {
    throw new CommandError("Duration must be 15–720 minutes.");
  }
  if (!Number.isInteger(value.capacity) || value.capacity < 1 || value.capacity > 100) {
    throw new CommandError("Capacity must be 1–100 members.");
  }
  if (![0, 15, 30, 60].includes(value.reminderMinutes)) {
    throw new CommandError("Reminder lead must be off, 15, 30 or 60 minutes.");
  }
  const invalidSquad = (s: EventDraftInput['squads'][number]) =>
    !s || typeof s.id !== 'string' || !/^[-\w]{1,32}$/.test(s.id) ||
    typeof s.name !== 'string' || !s.name.trim() || s.name.length > 60 ||
    !Number.isInteger(s.capacity) || s.capacity < 1 || s.capacity > 100;
  if (!Array.isArray(value.squads) || value.squads.length > 20 || value.squads.some(invalidSquad)) {
    throw new CommandError("Define at most 20 unique squads, with capacities adding up to event capacity.");
  }
  const duplicateSquad = new Set(value.squads.map(s => s.id)).size !== value.squads.length;
  const squadCapacity = value.squads.reduce((n, s) => n + s.capacity, 0);
  if (duplicateSquad || (value.squads.length && squadCapacity !== value.capacity)) {
    throw new CommandError("Define at most 20 unique squads, with capacities adding up to event capacity.");
  }
  return value;
}
export class EventStore {
  private readonly deliveries: DeliveryStore;
  constructor(private readonly sql: DatabaseSync) {
    this.deliveries = new DeliveryStore(sql);
  }
  /** Signup evidence is independent of the capped UI list and excludes rows awaiting retention cleanup. */
  hasConfirmedSignup(guildId:string,discordId:string,now:number):boolean {
    return !!this.sql.prepare(`SELECT 1 FROM community_event_signups s INDEXED BY community_signup_member
      JOIN community_events e ON e.id=s.event_id AND e.guild_id=s.guild_id
      WHERE s.guild_id=? AND s.discord_id=? AND s.state='confirmed'
      AND e.status IN ('scheduled','finished') AND e.retire_at>=? LIMIT 1`).get(guildId,discordId,now-90*86400000);
  }
  createDraft(input: EventDraftInput, now: number): EventRecord {
    const data = validate(input, now);
    const id = randomUUID();
    this.sql.prepare(`INSERT INTO community_events(id,guild_id,channel_id,data,status,start_at,created_at,revision,end_at,retire_at,reminder_at) VALUES(?,?,?,?,'draft',?,?,1,?,?,?)`)
      .run(id, data.guildId, data.channelId, JSON.stringify(data), data.startAt, now, data.startAt + data.durationMinutes * 60000, data.startAt + data.durationMinutes * 60000, data.reminderMinutes ? data.startAt - data.reminderMinutes * 60000 : null);
    return this.get(data.guildId, id)!;
  }
  get(guildId: string, eventId: string): EventRecord | null {
    const row = this.sql.prepare("SELECT * FROM community_events WHERE guild_id=? AND id=?").get(guildId, eventId);
    return row ? decode(row) : null;
  }
  list(guildId: string): EventRecord[] {
    return this.sql.prepare("SELECT * FROM community_events WHERE guild_id=? ORDER BY start_at DESC,id LIMIT 100").all(guildId).map(decode);
  }
  listPublished(guildId: string): EventRecord[] {
    return this.sql.prepare("SELECT * FROM community_events WHERE guild_id=? AND status<>'draft' ORDER BY start_at DESC,id LIMIT 100").all(guildId).map(decode);
  }
  publishedPage(guildId: string, page: number): { entries: EventRecord[]; pages: number } {
    const total = Number(this.sql.prepare(`SELECT count(*) AS n FROM (
      SELECT 1 FROM community_events WHERE guild_id=? AND status<>'draft' LIMIT 100
    )`).get(guildId)!.n);
    const pages = Math.max(1, Math.ceil(total / 10));
    if (!Number.isInteger(page) || page < 1 || page > pages) {
      throw new CommandError('Choose an existing event page.');
    }
    const entries = this.sql.prepare(`SELECT * FROM community_events WHERE guild_id=? AND status<>'draft'
      ORDER BY start_at DESC,id LIMIT 10 OFFSET ?`).all(guildId, (page - 1) * 10).map(decode);
    return { entries, pages };
  }
  deliveryJobs(guildId: string, eventId: string): DeliveryJob[] {
    const rows = this.sql.prepare(`SELECT id FROM community_deliveries WHERE guild_id=? AND kind IN ('event_publish','event_update','event_reminder')
      AND subject_id=? AND status NOT IN ('sent','cancelled') ORDER BY updated_at DESC,id DESC LIMIT 5`).all(guildId, eventId);
    return rows.map(row => this.deliveries.get(String(row.id))!);
  }
  signups(guildId: string, eventId: string): EventSignup[] {
    return this.sql.prepare("SELECT * FROM community_event_signups WHERE event_id=? AND guild_id=? ORDER BY sequence").all(eventId, guildId)
      .map(r => ({
        discordId: String(r.discord_id),
        squadId: r.squad_id as string | null,
        state: r.state as EventSignup['state'],
        sequence: Number(r.sequence),
        reminder: !!r.reminder
      }));
  }
  participants(guildId: string, eventId: string, requestedPage = 1): EventParticipants {
    const counts = this.sql.prepare(`SELECT state,squad_id,COUNT(*) AS n FROM community_event_signups
      WHERE event_id=? AND guild_id=? GROUP BY state,squad_id`).all(eventId, guildId);
    let total = 0;
    let confirmed = 0;
    const squadConfirmed: Record<string, number> = Object.create(null);
    for (const row of counts) {
      total += Number(row.n);
      if (row.state === 'confirmed') {
        confirmed += Number(row.n);
        if (row.squad_id !== null) {
          squadConfirmed[String(row.squad_id)] = Number(row.n);
        }
      }
    }
    const page = Math.max(1, Math.min(Math.ceil(total / 20) || 1, Math.floor(requestedPage) || 1));
    const entries = this.sql.prepare(`SELECT * FROM community_event_signups WHERE event_id=? AND guild_id=?
      ORDER BY sequence LIMIT ? OFFSET ?`).all(eventId, guildId, 20, (page - 1) * 20).map(signupRow);
    return {
      entries,
      total,
      confirmed,
      squadConfirmed,
      page
    };
  }
  private require(guildId: string, id: string, revision?: number): EventRecord {
    const e = this.get(guildId, id);
    if (!e || (revision !== undefined && e.revision !== revision)) {
      throw changed();
    }
    return e;
  }
  private open(guildId: string, id: string, now: number): EventRecord {
    const e = this.require(guildId, id);
    if (e.status !== 'scheduled' || now >= e.startAt) {
      throw new CommandError("Event signups are closed at the start instant or while unpublished/cancelled.");
    }
    return e;
  }
  private publicationLocked(e: EventRecord): boolean {
    return !!this.sql.prepare("SELECT 1 FROM community_deliveries WHERE guild_id=? AND kind='event_publish' AND subject_id=? AND status NOT IN ('cancelled','sent') LIMIT 1").get(e.guildId, e.id);
  }
  publish(guildId: string, id: string, revision: number, messageId: string): EventRecord {
    return withCommunityTransaction(this.sql, () => {
      const e = this.require(guildId, id, revision);
      if (e.status === 'scheduled' && e.messageId === messageId) {
        return e;
      }
      if (e.status !== 'draft' || !messageId) {
        throw changed();
      }
      this.sql.prepare("UPDATE community_events SET status='scheduled',message_id=? WHERE id=?").run(messageId, id);
      return this.require(guildId, id);
    });
  }
  requestPublish(guildId: string, id: string, revision: number, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const e = this.require(guildId, id, revision);
      if (e.status !== 'draft' || e.startAt <= now) {
        throw changed();
      }
      this.deliveries.enqueue({
        key: `event_publish:${id}:${revision}`,
        guildId,
        channelId: e.channelId,
        kind: 'event_publish',
        subjectId: id,
        revision,
        dueAt: now,
        part: 0
      });
    });
  }
  edit(guildId: string, id: string, revision: number, changes: Partial<EventDraftInput>, now: number): EventRecord {
    return withCommunityTransaction(this.sql, () => {
      const e = this.require(guildId, id, revision);
      if (!['draft', 'scheduled'].includes(e.status) || e.startAt <= now || this.publicationLocked(e)) {
        throw new CommandError("Event closed or publication pending. Reopen management and resolve delivery first.");
      }
      if ((changes.guildId && changes.guildId !== e.guildId) || (changes.creatorId && changes.creatorId !== e.creatorId) || (changes.channelId && changes.channelId !== e.channelId)) {
        throw new CommandError("Event creator and destination cannot change.");
      }
      const data = validate({ ...e, ...changes }, now);
      const occupancy = this.participants(guildId, id);
      if (occupancy.confirmed > data.capacity) {
        throw new CommandError("Capacity is below confirmed occupancy.");
      }
      const occupied = this.sql.prepare('SELECT DISTINCT squad_id FROM community_event_signups WHERE event_id=? AND guild_id=?').all(id, guildId);
      for (const s of occupied) {
        if (s.squad_id !== null && !data.squads.some(t => t.id === s.squad_id)) {
          throw new CommandError("An occupied squad cannot be removed.");
        }
        if (s.squad_id === null && data.squads.length) {
          throw new CommandError("Move existing members before introducing squads.");
        }
      }
      for (const squad of data.squads) {
        if ((occupancy.squadConfirmed[squad.id] ?? 0) > squad.capacity) {
          throw new CommandError("Squad capacity is below confirmed occupancy.");
        }
      }
      this.sql.prepare(`UPDATE community_events SET data=?,start_at=?,revision=revision+1,promotion_due=1,
      end_at=?,retire_at=?,reminder_at=?,closed_card=0 WHERE id=?`).run(JSON.stringify(data), data.startAt, data.startAt + data.durationMinutes * 60000, data.startAt + data.durationMinutes * 60000, data.reminderMinutes ? data.startAt - data.reminderMinutes * 60000 : null, id);
      this.deliveries.cancelSubject(guildId, 'event_reminder', id, now);
      this.deliveries.cancelSubject(guildId, 'event_update', id, now);
      this.queueUpdate(guildId, id, now);
      return this.require(guildId, id);
    });
  }
  cancel(guildId: string, id: string, revision: number, now: number): EventRecord {
    return withCommunityTransaction(this.sql, () => {
      const e = this.require(guildId, id, revision);
      if (e.status === 'cancelled') {
        return e;
      }
      if (this.publicationLocked(e)) {
        throw new CommandError("Resolve pending publication in event management before cancellation.");
      }
      this.sql.prepare("UPDATE community_events SET status='cancelled',revision=revision+1,promotion_due=0,retire_at=?,reminder_at=NULL WHERE id=?").run(now, id);
      this.deliveries.cancelSubject(guildId, 'event_reminder', id, now);
      this.deliveries.cancelSubject(guildId, 'event_update', id, now);
      this.queueUpdate(guildId, id, now);
      return this.require(guildId, id);
    });
  }
  private capacity(e: EventRecord, squadId: string | null): number {
    if (!e.squads.length) {
      if (squadId !== null) {
        throw new CommandError("This event has no squads.");
      }
      return e.capacity;
    }
    const squad = e.squads.find(s => s.id === squadId);
    if (!squad) {
      throw new CommandError("Choose an existing squad before joining.");
    }
    return squad.capacity;
  }
  private confirmed(id: string, squadId: string | null): number {
    return Number(this.sql.prepare("SELECT COUNT(*) AS n FROM community_event_signups WHERE event_id=? AND squad_id IS ? AND state='confirmed'").get(id, squadId)!.n);
  }
  private hasReserve(id: string, squadId: string | null): boolean {
    return !!this.sql.prepare("SELECT 1 FROM community_event_signups WHERE event_id=? AND squad_id IS ? AND state='reserve' LIMIT 1").get(id, squadId);
  }
  join(guildId: string, id: string, userId: string, squadId: string | null, now: number): EventSignup {
    return withCommunityTransaction(this.sql, () => {
      const e = this.open(guildId, id, now);
      const capacity = this.capacity(e, squadId);
      const existing = this.signup(guildId, id, userId);
      if (existing) {
        return existing;
      }
      if (!userId) {
        throw new CommandError("Invalid member.");
      }
      const sequence = Number(this.sql.prepare("UPDATE community_events SET next_sequence=next_sequence+1 WHERE id=? RETURNING next_sequence-1 AS n").get(id)!.n);
      this.sql.prepare("INSERT INTO community_event_signups(guild_id,event_id,discord_id,squad_id,state,sequence) VALUES(?,?,?,?,?,?)").run(guildId, id, userId, squadId, this.confirmed(id, squadId) < capacity && !this.hasReserve(id, squadId) ? 'confirmed' : 'reserve', sequence);
      this.queueUpdate(guildId, id, now);
      return this.signup(guildId, id, userId)!;
    });
  }
  withdraw(guildId: string, id: string, userId: string, eligibleMembers: Set<string>, now: number): void {
    withCommunityTransaction(this.sql, () => {
      this.open(guildId, id, now);
      this.sql.prepare("DELETE FROM community_event_signups WHERE event_id=? AND discord_id=?").run(id, userId);
      this.promote(guildId, id, eligibleMembers, now);
    });
  }
  move(guildId: string, id: string, userId: string, squadId: string, eligibleMembers: Set<string>, now: number): EventSignup {
    return withCommunityTransaction(this.sql, () => {
      const e = this.open(guildId, id, now);
      const capacity = this.capacity(e, squadId);
      const existing = this.signup(guildId, id, userId);
      if (!existing) {
        throw new CommandError("Member must join before moving squads.");
      }
      if (!eligibleMembers.has(userId)) {
        throw new CommandError("Member is no longer in this server.");
      }
      if (existing.squadId === squadId) {
        return existing;
      }
      this.sql.prepare("UPDATE community_event_signups SET squad_id=?,state=?,reminder=0 WHERE event_id=? AND discord_id=?").run(squadId, this.confirmed(id, squadId) < capacity && !this.hasReserve(id, squadId) ? 'confirmed' : 'reserve', id, userId);
      this.promote(guildId, id, eligibleMembers, now);
      return this.signup(guildId, id, userId)!;
    });
  }
  signup(guildId: string, id: string, userId: string): EventSignup | null {
    const r = this.sql.prepare("SELECT * FROM community_event_signups WHERE event_id=? AND discord_id=? AND guild_id=?").get(id, userId, guildId);
    return r ? {
      discordId: String(r.discord_id),
      squadId: r.squad_id as string | null,
      state: r.state as EventSignup['state'],
      sequence: Number(r.sequence),
      reminder: !!r.reminder
    } : null;
  }
  setReminder(guildId: string, id: string, userId: string, enabled: boolean, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const e = this.open(guildId, id, now);
      if (!e.reminderMinutes && enabled) {
        throw new CommandError("This event has no reminder lead time configured.");
      }
      if (!this.sql.prepare("UPDATE community_event_signups SET reminder=? WHERE event_id=? AND discord_id=?").run(enabled ? 1 : 0, id, userId).changes) {
        throw new CommandError("Join this event before choosing reminders.");
      }
    });
  }
  promote(guildId: string, id: string, eligibleMembers: Set<string>, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const e = this.open(guildId, id, now);
      // Confirmed occupancy is capped at 100; inspect at most 200 FIFO reserves per pass.
      const confirmed = this.sql.prepare("SELECT discord_id FROM community_event_signups WHERE event_id=? AND guild_id=? AND state='confirmed' LIMIT 100").all(id, guildId);
      for (const s of confirmed) {
        if (!eligibleMembers.has(String(s.discord_id))) {
          this.sql.prepare("DELETE FROM community_event_signups WHERE event_id=? AND discord_id=?").run(id, s.discord_id!);
        }
      }
      let remaining = 200;
      let more = false;
      for (const squad of e.squads.length ? e.squads : [{ id: null, capacity: e.capacity }]) {
        let seats = squad.capacity - this.confirmed(id, squad.id);
        if (seats <= 0) {
          continue;
        }
        const candidates = this.sql.prepare("SELECT discord_id FROM community_event_signups WHERE event_id=? AND squad_id IS ? AND state='reserve' ORDER BY sequence LIMIT ?").all(id, squad.id, remaining);
        for (const s of candidates) {
          if (seats <= 0) {
            break;
          }
          remaining--;
          if (!eligibleMembers.has(String(s.discord_id))) {
            this.sql.prepare("DELETE FROM community_event_signups WHERE event_id=? AND discord_id=?").run(id, s.discord_id!);
          }
          else {
            this.sql.prepare("UPDATE community_event_signups SET state='confirmed' WHERE event_id=? AND discord_id=?").run(id, s.discord_id!);
            seats--;
          }
        }
        if (seats > 0 && this.hasReserve(id, squad.id)) {
          more = true;
        }
      }
      this.sql.prepare("UPDATE community_events SET promotion_due=? WHERE id=?").run(more ? 1 : 0, id);
      this.queueUpdate(guildId, id, now);
    });
  }
  promotionDue(guildId: string, limit = 50): EventRecord[] {
    return this.sql.prepare("SELECT * FROM community_events WHERE status='scheduled' AND promotion_due=1 AND guild_id=? ORDER BY start_at LIMIT ?").all(guildId, Math.max(1, Math.min(100, limit))).map(decode);
  }
  reminderDue(guildId: string, now: number, limit = 20): EventRecord[] {
    return this.sql.prepare(`SELECT * FROM community_events WHERE guild_id=? AND status='scheduled'
      AND reminder_at<=? ORDER BY reminder_at,id LIMIT ?`).all(guildId, now, Math.min(20, Math.max(1, limit))).map(decode);
  }
  queueReminders(guildId: string, id: string, revision: number, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const e = this.require(guildId, id, revision);
      const dueAt = e.startAt - e.reminderMinutes * 60000;
      if (e.status !== 'scheduled' || !e.reminderMinutes || dueAt > now) {
        return;
      }
      if (!this.sql.prepare('UPDATE community_events SET reminder_at=NULL WHERE id=? AND reminder_at IS NOT NULL').run(id).changes) {
        return;
      }
      if (e.startAt <= now) {
        this.deliveries.cancelSubject(guildId, 'event_reminder', id, now);
        return;
      }
      const users = this.sql.prepare(`SELECT discord_id FROM community_event_signups WHERE event_id=? AND guild_id=?
        AND state='confirmed' AND reminder=1 ORDER BY sequence LIMIT 100`).all(id, guildId).map(r => String(r.discord_id));
      for (let offset = 0;offset < users.length;offset += 40) {
        const part = offset / 40;
        this.sql.prepare('INSERT INTO community_event_reminder_parts VALUES(?,?,?,?,?)').run(guildId, id, revision, part, JSON.stringify(users.slice(offset, offset + 40)));
        this.deliveries.enqueue({
          key: `event_reminder:${id}:${revision}`,
          guildId,
          channelId: e.channelId,

          kind: 'event_reminder',
          subjectId: id,
          revision,
          dueAt,
          part
        });
      }
    });
  }
  reminderRecipients(job: DeliveryJob): string[] {
    return this.sql.prepare(`SELECT s.discord_id FROM community_event_reminder_parts p,json_each(p.recipients) r
      JOIN community_event_signups s ON s.event_id=p.event_id AND s.discord_id=r.value
      WHERE p.guild_id=? AND p.event_id=? AND p.revision=? AND p.part=?
      AND s.guild_id=p.guild_id AND s.state='confirmed' AND s.reminder=1 ORDER BY CAST(r.key AS INTEGER) LIMIT 40`)
      .all(job.guildId, job.subjectId, job.revision, job.part).map(row => String(row.discord_id));
  }
  maintain(guildId: string, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const closing = this.sql.prepare(`SELECT id FROM community_events WHERE guild_id=? AND status='scheduled'
        AND closed_card=0 AND start_at<=? ORDER BY start_at LIMIT 20`).all(guildId, now);
      for (const row of closing) {
        const id = String(row.id);
        this.sql.prepare('UPDATE community_events SET closed_card=1,promotion_due=0,reminder_at=NULL WHERE id=?').run(id);
        this.deliveries.cancelSubject(guildId, 'event_reminder', id, now);
        this.queueUpdate(guildId, id, now);
      }
      const ending = this.sql.prepare(`SELECT id FROM community_events WHERE guild_id=? AND status='scheduled'
        AND end_at<=? ORDER BY end_at LIMIT 20`).all(guildId, now);
      for (const row of ending) {
        const id = String(row.id);
        this.sql.prepare("UPDATE community_events SET status='finished',closed_card=1,promotion_due=0,reminder_at=NULL WHERE id=?").run(id);
        this.deliveries.cancelSubject(guildId, 'event_reminder', id, now);
        this.queueUpdate(guildId, id, now);
      }
    });
  }
  queueUpdate(guildId: string, id: string, now: number): void {
    const e = this.require(guildId, id);
    if (!e.messageId) {
      return;
    }
    const version = Number(this.sql.prepare("UPDATE community_events SET card_version=card_version+1 WHERE id=? RETURNING card_version").get(id)!.card_version);
    // Coalesce pending cards; never cancel a send already in flight or awaiting reconciliation.
    this.sql.prepare("UPDATE community_deliveries SET status='cancelled',updated_at=? WHERE guild_id=? AND kind='event_update' AND subject_id=? AND status='pending'").run(now, guildId, id);
    this.deliveries.enqueue({
      key: `event_update:${id}:${e.revision}:${version}`,
      guildId,
      channelId: e.channelId,
      kind: 'event_update',
      subjectId: id,
      revision: e.revision,
      dueAt: now,
      part: 0
    });
  }
}
