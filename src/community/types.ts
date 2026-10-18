import type { MessageCreateOptions } from "discord.js";

export interface EntityBinding { guildId: string; channelId: string; messageId: string | null }
export interface IdentityBinding { guildId: string; discordId: string; publicId: string; linkedAt: string }
export interface DeliveryInput {
  key: string; guildId: string; channelId: string; kind: string; subjectId: string;
  revision: number; dueAt: number; part: number;
}
export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "paused" | "needs_review" | "cancelled";
export interface DeliveryJob extends DeliveryInput {
  id: string; status: DeliveryStatus; leaseId: string | null; leaseUntil: number | null;
  attempts: number; messageId: string | null; lastError: string | null; nextAttempt: number;
  /** An interrupted/uncertain send must be reconciled, never automatically reposted. */
  reconcileRequired: boolean;
}
export interface PreparedDelivery { payload: MessageCreateOptions; messageId?: string }
export interface CommunityTick { now: number; takeRequest(): boolean; stopping(): boolean }
export interface CommunityDeliveryHandler {
  prepare(job: DeliveryJob, now?: number): Promise<PreparedDelivery | null>;
  /** Synchronous binding only: runs in the same savepoint as delivery completion. */
  delivered?(job: DeliveryJob, messageId: string): void;
}
