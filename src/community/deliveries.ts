import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { CommandError } from "../commandError.js";
import { withCommunityTransaction } from "./transactions.js";
import type { DeliveryInput, DeliveryJob } from "./types.js";
export type { DeliveryInput, DeliveryJob } from "./types.js";

const hash = (job: Pick<DeliveryInput, "key" | "part">) => createHash("sha256").update(JSON.stringify([job.key, job.part])).digest("hex");
export const deliveryMarker = (job: Pick<DeliveryInput, "key" | "part">): string => `community:${hash(job).slice(0, 24)}`;
export const deliveryNonce = (job: Pick<DeliveryInput, "key" | "part">): string => BigInt(`0x${hash(job).slice(0, 16)}`).toString();
function decode(row: Record<string, unknown>): DeliveryJob {
  return { id: String(row.id), key: String(row.delivery_key), guildId: String(row.guild_id), channelId: String(row.channel_id),
    kind: String(row.kind), subjectId: String(row.subject_id), revision: Number(row.revision), dueAt: Number(row.due_at), part: Number(row.part),
    status: row.status as DeliveryJob["status"], leaseId: row.lease_id as string | null, leaseUntil: row.lease_until as number | null,
    attempts: Number(row.attempts), messageId: row.message_id as string | null, lastError: row.last_error as string | null,
    nextAttempt: Number(row.next_attempt), reconcileRequired: !!row.reconcile_required };
}
export class DeliveryStore {
  constructor(private readonly sql: DatabaseSync) {}
  enqueue(input: DeliveryInput): DeliveryJob {
    if ([input.key,input.guildId,input.channelId,input.kind,input.subjectId].some(value => typeof value !== "string" || !value) ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 || !Number.isSafeInteger(input.part) || input.part < 0 || !Number.isSafeInteger(input.dueAt)) throw new Error("Invalid community delivery.");
    return withCommunityTransaction(this.sql, () => {
      this.sql.prepare(`INSERT OR IGNORE INTO community_deliveries(id,delivery_key,guild_id,channel_id,kind,subject_id,revision,due_at,part,next_attempt,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),input.key,input.guildId,input.channelId,input.kind,input.subjectId,input.revision,input.dueAt,input.part,input.dueAt,input.dueAt);
      const row = this.sql.prepare("SELECT * FROM community_deliveries WHERE delivery_key=? AND part=?").get(input.key,input.part)!;
      const job = decode(row);
      if (job.guildId !== input.guildId || job.kind !== input.kind || job.subjectId !== input.subjectId || job.channelId !== input.channelId || job.revision !== input.revision) throw new Error("Delivery key already belongs to another destination or revision.");
      return job;
    });
  }
  claim(now: number, limit: number): DeliveryJob[] {
    const jobs: DeliveryJob[] = [];
    const take = Math.max(0, Math.min(50, Math.floor(limit)));
    return withCommunityTransaction(this.sql, () => {
      for (let n = 0; n < take; n++) {
        const row = this.sql.prepare(`SELECT d.* FROM community_deliveries d LEFT JOIN community_guild_work w ON w.guild_id=d.guild_id
          WHERE (d.status='pending' AND d.due_at<=? AND d.next_attempt<=?) OR (d.status='sending' AND d.lease_until<=?)
          ORDER BY COALESCE(w.last_work,0), d.guild_id, d.due_at, d.rowid LIMIT 1`).get(now,now,now);
        if (!row) break;
        const lease = randomUUID();
        this.sql.prepare(`UPDATE community_deliveries SET reconcile_required=CASE WHEN status='sending' THEN 1 ELSE reconcile_required END,
          status='sending',lease_id=?,lease_until=?,updated_at=? WHERE id=?`).run(lease,now+300_000,now,row.id!);
        const order = Number(this.sql.prepare("SELECT COALESCE(MAX(last_work),0)+1 AS next FROM community_guild_work").get()!.next);
        this.sql.prepare(`INSERT INTO community_guild_work(guild_id,last_work) VALUES(?,?)
          ON CONFLICT(guild_id) DO UPDATE SET last_work=excluded.last_work`).run(row.guild_id!,order);
        jobs.push(this.get(String(row.id))!);
      }
      return jobs;
    });
  }
  get(id: string): DeliveryJob | null {
    const row = this.sql.prepare("SELECT * FROM community_deliveries WHERE id=?").get(id); return row ? decode(row) : null;
  }
  hasDue(kind: string, now: number): boolean {
    return !!this.sql.prepare(`SELECT 1 FROM community_deliveries WHERE kind=? AND status='pending'
      AND due_at<=? AND next_attempt<=? LIMIT 1`).get(kind,now,now) ||
      !!this.sql.prepare(`SELECT 1 FROM community_deliveries WHERE kind=? AND status='sending'
      AND lease_until<=? LIMIT 1`).get(kind,now);
  }
  defer(id: string, leaseId: string, nextAttempt: number, now: number): void {
    this.sql.prepare(`UPDATE community_deliveries SET status='pending',lease_id=NULL,lease_until=NULL,
      next_attempt=?,updated_at=? WHERE id=? AND status='sending' AND lease_id=?`).run(nextAttempt,now,id,leaseId);
  }
  owns(job: DeliveryJob): boolean {
    const current = this.get(job.id);
    return !!current && current.status === "sending" && current.leaseId === job.leaseId;
  }
  finish(id: string, leaseId: string, messageId: string, now?: number): boolean {
    return Number(this.sql.prepare(`UPDATE community_deliveries SET status='sent',message_id=?,lease_id=NULL,lease_until=NULL,
      last_error=NULL,reconcile_required=0,updated_at=COALESCE(?,updated_at) WHERE id=? AND status='sending' AND lease_id=?`).run(messageId,now ?? null,id,leaseId).changes) > 0;
  }
  fail(id: string, leaseId: string, outcome: "transient" | "paused" | "needs_review", error: string, now: number): void {
    withCommunityTransaction(this.sql, () => {
      const job = this.get(id); if (!job || job.status !== "sending" || job.leaseId !== leaseId) return;
      const attempts = job.attempts + (outcome === "transient" || outcome === "paused" ? 1 : 0);
      const status = outcome === "transient" ? attempts >= 10 ? "paused" : "pending" : outcome;
      const next = now + Math.min(30, 2 ** Math.min(Math.max(attempts - 1, 0), 5)) * 60_000;
      this.sql.prepare(`UPDATE community_deliveries SET status=?,attempts=?,last_error=?,next_attempt=?,lease_id=NULL,lease_until=NULL,
        reconcile_required=CASE WHEN ?='needs_review' THEN 1 ELSE reconcile_required END,updated_at=? WHERE id=? AND lease_id=?`)
        .run(status,attempts,error.slice(0,500),next,outcome,now,id,leaseId);
    });
  }
  cancel(id: string, leaseId: string, now = Date.now()): void {
    this.sql.prepare("UPDATE community_deliveries SET status='cancelled',lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND lease_id=?").run(now,id,leaseId);
  }
  cancelSubject(guildId: string, kind: string, subjectId: string, now = Date.now()): void {
    this.sql.prepare(`UPDATE community_deliveries SET status='cancelled',lease_id=NULL,lease_until=NULL,updated_at=?
      WHERE guild_id=? AND kind=? AND subject_id=? AND status NOT IN ('sent','cancelled')`).run(now,guildId,kind,subjectId);
  }
  list(guildId: string): DeliveryJob[] {
    return this.sql.prepare("SELECT * FROM community_deliveries WHERE guild_id=? ORDER BY due_at,rowid").all(guildId).map(decode);
  }
  /** One extra row answers Next without decoding the guild's retained delivery history. */
  diagnosticsPage(guildId: string, kind: string, page: number): { jobs: DeliveryJob[]; hasNext: boolean } {
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(page * 10)) {
      throw new CommandError("Choose a valid delivery diagnostics page.");
    }
    const rows = this.sql.prepare(`SELECT * FROM community_deliveries
      WHERE guild_id=? AND kind=? AND status IN ('failed','paused','needs_review')
      ORDER BY due_at,rowid LIMIT 11 OFFSET ?`).all(guildId, kind, page * 10);
    return { jobs: rows.slice(0, 10).map(decode), hasNext: rows.length > 10 };
  }
  retry(guildId: string, jobId: string, expectedRevision: number, now: number): void {
    if (!this.sql.prepare(`UPDATE community_deliveries SET status='pending',attempts=0,next_attempt=?,updated_at=?,last_error=NULL
      WHERE guild_id=? AND id=? AND revision=? AND status IN ('failed','paused','needs_review')`).run(now,now,guildId,jobId,expectedRevision).changes) {
      throw new CommandError("This delivery changed or is unavailable. Reopen the management menu.");
    }
  }
}
