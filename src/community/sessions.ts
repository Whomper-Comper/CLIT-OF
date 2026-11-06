import { randomUUID } from "node:crypto";
import { CommandError } from "../commandError.js";
import type { EntityBinding } from "./types.js";
import { ExpiringSessions, sessionClock, type SessionClock } from "../expiringSessions.js";
export interface PrivateCommunitySession extends EntityBinding {
  id: string; kind: string; ownerId: string; expiresAt: number; data: unknown;
}
const reopen = () => new CommandError("This private menu is unavailable or expired. Reopen your own menu in its original server and channel.");
export class CommunitySessions {
  private readonly sessions: ExpiringSessions<PrivateCommunitySession>;
  private logicalTime: number;
  private clockTime: number;
  private operationTime?: number;
  constructor(private readonly clock: SessionClock = sessionClock) {
    this.logicalTime = this.clockTime = clock.now();
    // Callers explicitly supply time (including historical test clocks). Between
    // calls, advance in that same time domain rather than comparing to wall time.
    this.sessions = new ExpiringSessions(200, session => session.expiresAt,
      { now: () => this.operationTime ?? this.logicalTime + clock.now() - this.clockTime,
        setTimeout: (callback, delay) => clock.setTimeout(callback, delay), clearTimeout: timer => clock.clearTimeout(timer) });
  }
  private atTime<T>(now: number, operation: () => T): T {
    this.logicalTime = now; this.clockTime = this.clock.now();
    // Explicit caller time governs this entire synchronous operation, including
    // helper sweeps/lookups. Timer callbacks use elapsed clock time afterward.
    this.operationTime = now;
    try { this.sessions.sweep(); return operation(); }
    finally { this.operationTime = undefined; }
  }
  create(input: Omit<PrivateCommunitySession, "id" | "expiresAt">, now: number): PrivateCommunitySession {
    return this.atTime(now, () => {
      const session = { ...input, id: randomUUID(), expiresAt: now + 600_000 };
      this.sessions.set(session.id, session); return session;
    });
  }
  bind(id: string, messageId: string): void {
    const session = this.sessions.get(id); if (!session) throw reopen();
    if (session.messageId && session.messageId !== messageId) throw reopen();
    session.messageId = messageId;
  }
  get(id: string, ownerId: string, binding: EntityBinding, now: number): PrivateCommunitySession {
    return this.atTime(now, () => {
      const session = this.sessions.get(id);
      if (!session || session.expiresAt <= now || session.ownerId !== ownerId ||
        session.guildId !== binding.guildId || session.channelId !== binding.channelId || session.messageId !== binding.messageId) throw reopen();
      return session;
    });
  }
  delete(id: string): void { this.sessions.delete(id); }
  purgeMember(guildId: string, ownerId: string): void {
    for (const [id, session] of this.sessions.entries()) if (session.guildId === guildId && session.ownerId === ownerId) this.sessions.delete(id);
  }
  purgeGuild(guildId: string): void {
    for (const [id, session] of this.sessions.entries()) if (session.guildId === guildId) this.sessions.delete(id);
  }
}
/** All private community command menus share the same bounded cache. */
export const communitySessions = new CommunitySessions();
