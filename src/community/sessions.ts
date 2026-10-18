import { randomUUID } from "node:crypto";
import { CommandError } from "../commands/support.js";
import type { EntityBinding } from "./types.js";
export interface PrivateCommunitySession extends EntityBinding {
  id: string; kind: string; ownerId: string; expiresAt: number; data: unknown;
}
const reopen = () => new CommandError("This private menu is unavailable or expired. Reopen your own menu in its original server and channel.");
export class CommunitySessions {
  private readonly sessions = new Map<string, PrivateCommunitySession>();
  create(input: Omit<PrivateCommunitySession, "id" | "expiresAt">, now: number): PrivateCommunitySession {
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
    while (this.sessions.size >= 200) this.sessions.delete(this.sessions.keys().next().value!);
    const session = { ...input, id: randomUUID(), expiresAt: now + 600_000 };
    this.sessions.set(session.id, session); return session;
  }
  bind(id: string, messageId: string): void {
    const session = this.sessions.get(id); if (!session) throw reopen();
    if (session.messageId && session.messageId !== messageId) throw reopen();
    session.messageId = messageId;
  }
  get(id: string, ownerId: string, binding: EntityBinding, now: number): PrivateCommunitySession {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= now || session.ownerId !== ownerId ||
      session.guildId !== binding.guildId || session.channelId !== binding.channelId || session.messageId !== binding.messageId) throw reopen();
    return session;
  }
  delete(id: string): void { this.sessions.delete(id); }
  purgeMember(guildId: string, ownerId: string): void {
    for (const [id, session] of this.sessions) if (session.guildId === guildId && session.ownerId === ownerId) this.sessions.delete(id);
  }
  purgeGuild(guildId: string): void {
    for (const [id, session] of this.sessions) if (session.guildId === guildId) this.sessions.delete(id);
  }
}
/** All private community command menus share the same bounded cache. */
export const communitySessions = new CommunitySessions();
