import type { DatabaseSync } from "node:sqlite";
import { DeliveryStore } from "./deliveries.js";
import { CommunitySettingsStore } from "./settings.js";
import { withCommunityTransaction } from "./transactions.js";
import * as lifecycle from "./lifecycle.js";
import { AvailabilityStore } from "./availability.js";
import { EventStore, initializeEvents } from "./events.js";
import { OnboardingStore } from "./onboarding.js";

export class CommunityStore {
  readonly deliveries: DeliveryStore;
  readonly settings: CommunitySettingsStore;
  readonly availability: AvailabilityStore;
  readonly events: EventStore;
  readonly onboarding: OnboardingStore;
  constructor(private readonly sql: DatabaseSync) {
    this.deliveries = new DeliveryStore(sql); this.settings = new CommunitySettingsStore(sql);
    this.availability = new AvailabilityStore(sql);
    this.events = new EventStore(sql);
    this.onboarding = new OnboardingStore(sql);
  }
  static initialize(sql: DatabaseSync): void {
    initializeEvents(sql);
    sql.exec(`CREATE TABLE IF NOT EXISTS community_onboarding (
      guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,clan_tag TEXT NOT NULL,enrolled_at INTEGER NOT NULL,
      completed_at INTEGER,public_id TEXT,token TEXT NOT NULL,PRIMARY KEY(guild_id,discord_id));
      CREATE INDEX IF NOT EXISTS community_onboarding_page ON community_onboarding(guild_id,enrolled_at,discord_id);
      CREATE INDEX IF NOT EXISTS community_onboarding_identity ON community_onboarding(discord_id,guild_id);
      CREATE INDEX IF NOT EXISTS community_onboarding_account ON community_onboarding(public_id);`);
    sql.exec(`CREATE TABLE IF NOT EXISTS community_availability (
      guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,timezone TEXT NOT NULL,windows TEXT,
      revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,discord_id));
      CREATE TABLE IF NOT EXISTS community_availability_changes (
      guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,changed_at INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(guild_id,discord_id));
      CREATE INDEX IF NOT EXISTS community_availability_change_time ON community_availability_changes(guild_id,changed_at,discord_id);
      CREATE TABLE IF NOT EXISTS community_settings (
      guild_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,milestones_enabled INTEGER NOT NULL DEFAULT 0,
      milestone_channel_id TEXT,game_thresholds TEXT NOT NULL,win_thresholds TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS community_deliveries (
        id TEXT PRIMARY KEY,delivery_key TEXT NOT NULL,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,
        kind TEXT NOT NULL,subject_id TEXT NOT NULL,revision INTEGER NOT NULL,due_at INTEGER NOT NULL,part INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',lease_id TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,
        message_id TEXT,last_error TEXT,next_attempt INTEGER NOT NULL,reconcile_required INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,UNIQUE(delivery_key,part));
      CREATE INDEX IF NOT EXISTS community_delivery_due ON community_deliveries(status,next_attempt,due_at);
      CREATE INDEX IF NOT EXISTS community_delivery_lease ON community_deliveries(status,lease_until);
      CREATE INDEX IF NOT EXISTS community_delivery_subject ON community_deliveries(guild_id,kind,subject_id);
      CREATE INDEX IF NOT EXISTS community_delivery_retention ON community_deliveries(status,updated_at);
      CREATE INDEX IF NOT EXISTS community_delivery_kind_due ON community_deliveries(kind,status,next_attempt,due_at);
      CREATE INDEX IF NOT EXISTS community_delivery_kind_lease ON community_deliveries(kind,status,lease_until);
      CREATE TABLE IF NOT EXISTS community_guild_work (guild_id TEXT PRIMARY KEY,last_work INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS community_guild_order ON community_guild_work(last_work);`);
  }
  transaction<T>(action: () => T): T { return withCommunityTransaction(this.sql,action); }
  purgeIdentity(discordId: string, guildId?: string): void { this.transaction(() => lifecycle.purgeIdentity(this.sql,discordId,guildId)); }
  purgeAccount(publicId: string): void { this.transaction(() => lifecycle.purgeAccount(this.sql,publicId)); }
  purgeMember(guildId: string, discordId: string): void { this.transaction(() => lifecycle.purgeMember(this.sql,guildId,discordId)); }
  purgeGuild(guildId: string): void { this.transaction(() => lifecycle.purgeGuild(this.sql,guildId)); }
  clearGameEvidence(guildId?: string): void { this.transaction(() => lifecycle.clearGameEvidence(this.sql,guildId)); }
  prune(now: number): void { this.transaction(() => lifecycle.prune(this.sql,now)); }
}
