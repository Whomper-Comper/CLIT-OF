import { Client, Guild, GuildMember, TextChannel, EmbedBuilder } from "discord.js";
import { db, GuildClanConfig, LinkedUser, managedRoles } from "./db.js";
import { openfrontApi } from "./api.js";
import { MemberLocks, PacedQueue } from "./queues.js";
import { desiredRoles } from "./roles.js";
import { configSnapshot } from "./setupConfig.js";

export interface SyncResult {
  discordId: string;
  openfrontId: string;
  linkedAt: string;
  clanTag: string;
  inClan: boolean;
  clanRole?: string;
  rolesAdded: string[];
  rolesRemoved: string[];
  error?: string;
}

export interface GuildClanSyncResult {
  config: GuildClanConfig;
  results: SyncResult[];
  /** A clan-wide failure, such as its final pending-invite roster refresh. */
  error?: string;
}

export interface JoinRoleMismatch {
  discordId: string;
  openfrontId: string;
  openfrontUsername: string | null;
  linkedAt: string | null;
  clanTag: string;
}

class StaleSyncError extends Error {}

interface SyncMemberState {
  member: GuildMember;
  needsRoleRefresh: boolean;
  refreshError?: string;
}

export class ClanSyncService {
  private client: Client;
  private timer: NodeJS.Timeout | null = null;
  private isSyncing = false;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleaning = false;
  private stopping = false;
  private readonly guildLocks = new MemberLocks();
  private readonly memberLocks = new MemberLocks();
  private readonly rolePacer = new PacedQueue(1000);
  private lastCleanupGuild: string | undefined;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Start the background periodic clan sync scheduler.
   */
  startScheduler() {
    this.stopScheduler();
    this.stopping = false;

    // Run every 1 minute to check which guilds/clans are due for sync
    this.timer = setInterval(() => {
      this.checkAndSyncAllGuilds().catch((err) => {
        console.error("[ClanSync] Periodic sync error:", err);
      });
    }, 60 * 1000);

    this.cleanupTimer = setInterval(() => {
      void this.processRoleCleanupQueue().catch((error) => console.error("[ClanSync] Cleanup worker failed:", error));
    }, 250);
    void this.processRoleCleanupQueue().catch((error) => console.error("[ClanSync] Cleanup worker failed:", error));

    console.log("[ClanSync] Periodic sync scheduler started.");
  }

  stopScheduler() {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private async processRoleCleanupQueue() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      while (!this.stopping) {
        const job = db.nextJob(Date.now(), this.lastCleanupGuild);
        if (!job) break;
        this.lastCleanupGuild = job.guild_id;
        const key = `${job.guild_id}:${job.discord_id}`;
        try {
          await this.memberLocks.run(key, async () => {
            const latest = db.getJob(job.guild_id, job.discord_id);
            if (!latest || latest.version !== job.version) return;
            const guild = this.client.guilds.cache.get(job.guild_id);
            if (!guild) {
              db.finishJob(job);
              return;
            }
            const member = await guild.members.fetch(job.discord_id).catch((error) => {
              const code = error && typeof error === "object" && "code" in error ? error.code : null;
              if (code === 10007) return null; // Discord Unknown Member: no roles remain to clean up.
              throw error;
            });
            if (!member) {
              db.finishJob(job);
              return;
            }

            // Each pass handles at most one write, allowing unlinks and other guilds
            // to run between roles even when a linked member belongs to many clans.
            const currentLink = db.getEffectiveLink(job.guild_id, job.discord_id);
            const configs = db.getGuildConfigs(job.guild_id);
            const snapshot = configs.map(configSnapshot).join("\n");
            const remaining = JSON.parse(job.role_ids) as string[];
            const wanted = new Set<string>();
            let clans: { tag: string; role: string }[] = [];
            let username: string | undefined;
            if (currentLink) {
              if (configs.length) {
                const profile = await openfrontApi.getPlayerProfile(currentLink.openfront_id);
                if (!profile || !Array.isArray(profile.clans)) throw new Error("OpenFront clan membership is unavailable; cleanup will retry");
                clans = profile.clans;
                for (const role of desiredRoles(configs, profile.clans)) wanted.add(role);
                username = profile.username ?? undefined;
              }
            }

            const isCurrent = () => {
              const link = db.getEffectiveLink(job.guild_id, job.discord_id);
              return !this.stopping && db.getJob(job.guild_id, job.discord_id)?.version === job.version &&
                link?.openfront_id === currentLink?.openfront_id && link?.linked_at === currentLink?.linked_at &&
                db.getGuildConfigs(job.guild_id).map(configSnapshot).join("\n") === snapshot;
            };
            if (!isCurrent()) return;
            if (username) db.updateUsername(member.id, username, guild.id);
            // Revoke obsolete ranks before attempting grants that may fail.
            remaining.sort((left, right) => Number(wanted.has(left)) - Number(wanted.has(right)));
            while (remaining.length) {
              const roleId = remaining[0];
              const add = wanted.has(roleId);
              // Join approval roles are owned by server staff, including after unlink.
              if ((!add && configs.some((config) => config.join_role_id === roleId)) || member.roles.cache.has(roleId) === add) {
                remaining.shift();
                continue;
              }
              const changed = await this.rolePacer.run(async () => {
                if (!isCurrent()) return false;
                if (member.roles.cache.has(roleId) !== add) {
                  if (add) await member.roles.add(roleId);
                  else await member.roles.remove(roleId);
                }
                return true;
              }, { priority: job.priority, guildId: job.guild_id });
              if (!changed) return;
              remaining.shift();
              db.progressJob(job, remaining);
              if (currentLink) {
                const config = configs.find((config) => managedRoles([config]).includes(roleId));
                if (config) {
                  const membership = clans.find((clan) => clan.tag.toUpperCase() === config.clan_tag);
                  await this.logRoleChange(guild, config, member, { discordId: member.id, openfrontId: currentLink.openfront_id, linkedAt: currentLink.linked_at,
                    clanTag: config.clan_tag, inClan: !!membership, clanRole: membership?.role,
                    rolesAdded: add ? [roleId] : [], rolesRemoved: add ? [] : [roleId] });
                }
              }
              if (!this.stopping && !remaining.length) db.finishJob(job);
              return;
            }
            if (isCurrent()) db.finishJob(job);
          });
        } catch (error) {
          db.retryJob(job, error instanceof Error ? error.message : String(error));
          console.warn(`[ClanSync] Role cleanup for ${job.discord_id} in guild ${job.guild_id} will retry:`, error);
          // The failed job backs off; other guilds can still make progress.
        }
      }
    } finally {
      this.cleaning = false;
    }
  }

  /**
   * Checks all guild clan configurations and syncs those that are due.
   */
  async checkAndSyncAllGuilds() {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const configs = db.getAllGuildConfigs();
      const now = Date.now();

      // Group configs by guild for efficiency
      const byGuild = new Map<string, GuildClanConfig[]>();
      for (const config of configs) {
        const arr = byGuild.get(config.guild_id) ?? [];
        arr.push(config);
        byGuild.set(config.guild_id, arr);
      }

      for (const [guildId, guildConfigs] of byGuild) {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) continue;

        const dueConfigs = guildConfigs.filter((config) => {
          const parsedSync = config.last_sync_at ? new Date(config.last_sync_at).getTime() : 0;
          const lastSync = Number.isFinite(parsedSync) ? parsedSync : 0;
          const intervalMs = (config.sync_interval_mins || 10) * 60 * 1000;

          return now - lastSync >= intervalMs;
        });
        if (dueConfigs.length) {
          for (const config of dueConfigs) console.log(`[ClanSync] Auto-syncing clan [${config.clan_tag}] in guild ${guild.name}...`);
          const buckets = await this.syncGuildClans(guild, dueConfigs);
          for (const bucket of buckets) {
            if (bucket.error) console.warn(`[ClanSync] Sync failed for [${bucket.config.clan_tag}] in guild ${guild.id}:`, bucket.error);
          }
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync all linked members in a guild for a specific clan config.
   */
  async syncGuildClan(guild: Guild, config: GuildClanConfig): Promise<SyncResult[]> {
    const [bucket] = await this.syncGuildClans(guild, [config]);
    if (bucket.error) throw new Error(bucket.error);
    return bucket.results;
  }

  /** Share initial roster discovery, retaining separate results and final freshness per clan. */
  async syncGuildClans(guild: Guild, configs: readonly GuildClanConfig[]): Promise<GuildClanSyncResult[]> {
    const selected = [...new Map(configs.map((config) => [config.clan_tag, config])).values()];
    if (!selected.length) return [];
    // Every caller, including the single-clan wrapper, acquires overlapping locks
    // in the same order. Keep the caller's selected order for work and reporting.
    const lockTags = selected.map((config) => config.clan_tag).sort();
    const lock = (index: number): Promise<GuildClanSyncResult[]> => index === lockTags.length
      ? this.syncGuildClansLocked(guild, selected)
      : this.guildLocks.run(`${guild.id}:${lockTags[index]}`, () => lock(index + 1));
    return lock(0);
  }

  private async syncGuildClansLocked(guild: Guild, configs: GuildClanConfig[]): Promise<GuildClanSyncResult[]> {
    const buckets = configs.map((config) => ({ config, results: [] as SyncResult[], mismatches: [] as JoinRoleMismatch[], error: undefined as string | undefined }));
    // Failure here rejects the whole batch before any clan can be marked synced.
    const members = await guild.members.fetch();

    for (const [memberId, initialMember] of members) {
      if (initialMember.user.bot) continue;
      const state: SyncMemberState = { member: initialMember, needsRoleRefresh: false };

      const unlinkedMismatch = (bucket: typeof buckets[number]) => {
        const { member } = state;
        if (bucket.config.join_role_id && member.roles.cache.has(bucket.config.join_role_id)) {
          bucket.mismatches.push({ discordId: memberId, openfrontId: "(not linked)",
            openfrontUsername: null, linkedAt: null, clanTag: bucket.config.clan_tag });
        }
      };
      if (!db.getEffectiveLink(guild.id, memberId)) {
        // There is no await in this block: discovery is safe to share only here.
        for (const bucket of buckets) unlinkedMismatch(bucket);
        continue;
      }

      for (const bucket of buckets) {
        const { config } = bucket;
        if (state.needsRoleRefresh) await this.refreshSyncMember(state);
        const { member } = state;
        // A prior clan's profile, paced role write or logging can change the link.
        const link = db.getEffectiveLink(guild.id, memberId);
        if (!link) { unlinkedMismatch(bucket); continue; }
        // Keep the guarded helper and its normal API reads. Adjacent reads share
        // the API's short cache, but a slow await must still permit TTL expiry.
        const result = state.refreshError ? this.memberRefreshFailure(state, link, config)
          : await this.syncMemberForClan(member, link, config);
        state.needsRoleRefresh = result.rolesAdded.length > 0 || result.rolesRemoved.length > 0;
        bucket.results.push(result);

        if (result.rolesAdded.length > 0 || result.rolesRemoved.length > 0) {
          await this.logRoleChange(guild, config, member, result);
        }

        if (config.join_role_id && member.roles.cache.has(config.join_role_id) && !result.inClan && !result.error) {
          bucket.mismatches.push({ discordId: memberId, openfrontId: link.openfront_id,
            openfrontUsername: link.openfront_username, linkedAt: link.linked_at, clanTag: config.clan_tag });
        }
      }
    }

    for (const bucket of buckets) {
      try {
        await this.finishGuildClanSync(guild, bucket.config, bucket.results, bucket.mismatches);
      } catch (error) {
        // A failed final refresh cannot complete this clan or block other clans.
        bucket.error = (error instanceof Error ? error.message : String(error)) || "Clan sync failed";
      }
    }
    return buckets.map(({ config, results, error }) => ({ config, results, ...(error ? { error } : {}) }));
  }

  private async finishGuildClanSync(guild: Guild, config: GuildClanConfig, results: SyncResult[], mismatches: JoinRoleMismatch[]): Promise<void> {
    const isCurrentConfig = () => {
      const latest = db.getGuildClanConfig(guild.id, config.clan_tag);
      return guild.id === config.guild_id && latest !== null &&
        configSnapshot(latest) === configSnapshot(config);
    };
    // The member fetch and role syncs can outlive an edit to the mapping.
    if (mismatches.length > 0 && config.log_channel_id && isCurrentConfig()) {
      // Earlier entries can become stale while other members' profiles are fetched.
      // Refresh the roster once, then validate every identity and role without another await.
      const latestMembers = await guild.members.fetch();
      if (isCurrentConfig()) {
        const currentMismatches: JoinRoleMismatch[] = [];
        for (const mismatch of mismatches) {
          const member = latestMembers.get(mismatch.discordId);
          const link = db.getEffectiveLink(guild.id, mismatch.discordId);
          if (!member || member.user.bot || !config.join_role_id || !member.roles.cache.has(config.join_role_id)) continue;
          if (mismatch.linkedAt === null ? !!link :
              !link || link.openfront_id !== mismatch.openfrontId || link.linked_at !== mismatch.linkedAt) continue;
          currentMismatches.push({ ...mismatch, openfrontUsername: link?.openfront_username ?? null });
        }
        if (currentMismatches.length) await this.logJoinRoleMismatches(guild, config, currentMismatches);
      }
    }

    // Fetching members and processing their roles can outlive a configuration edit.
    // Do not postpone the replacement mapping's first sync with this stale pass.
    if (!results.some((result) => result.error) && isCurrentConfig()) {
      db.updateClanLastSync(guild.id, config.clan_tag);
    }
  }

  /**
   * Sync clan roles for a single member across ALL configured clans for their guild.
   */
  async syncMember(member: GuildMember): Promise<SyncResult[]> {
    const configs = db.getGuildConfigs(member.guild.id);
    if (configs.length === 0) return [];

    const link = db.getEffectiveLink(member.guild.id, member.id);
    if (!link) return [];

    return this.syncMemberClans(member, link, configs);
  }

  /** Sync an already-bound member across only the caller's selected mappings. */
  async syncMemberClans(member: GuildMember, link: LinkedUser, configs: readonly GuildClanConfig[]): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const state: SyncMemberState = { member, needsRoleRefresh: false };
    for (const config of configs) {
      if (state.needsRoleRefresh) await this.refreshSyncMember(state);
      const result = state.refreshError ? this.memberRefreshFailure(state, link, config)
        : await this.syncMemberForClan(state.member, link, config);
      state.needsRoleRefresh = result.rolesAdded.length > 0 || result.rolesRemoved.length > 0;
      if (result.rolesAdded.length > 0 || result.rolesRemoved.length > 0) {
        await this.logRoleChange(member.guild, config, state.member, result);
      }
      results.push(result);
    }
    return results;
  }

  /** Single-role discord.js writes return clones; the old member can lag the server. */
  private async refreshSyncMember(state: SyncMemberState): Promise<void> {
    if (state.refreshError) return;
    try {
      const latest = await state.member.guild.members.fetch({ user: state.member.id, force: true });
      if (latest.id !== state.member.id || latest.guild.id !== state.member.guild.id || latest.user?.bot) {
        throw new Error("Could not refresh the current server member after role changes");
      }
      // A REST refresh also observes intervening staff/Gateway changes. Do not
      // synthesize role state by applying the old write's clone to a newer view.
      state.member = latest;
      state.needsRoleRefresh = false;
    } catch (error) {
      // No later clan may treat the stale role cache as a successful observation.
      state.refreshError = (error instanceof Error ? error.message : String(error)) || "Member refresh failed after role changes";
    }
  }

  private memberRefreshFailure(state: SyncMemberState, link: LinkedUser, config: GuildClanConfig): SyncResult {
    return { discordId: state.member.id, openfrontId: link.openfront_id, linkedAt: link.linked_at,
      clanTag: config.clan_tag, inClan: false, rolesAdded: [], rolesRemoved: [], error: state.refreshError };
  }

  /**
   * Sync clan roles for a single member for a specific clan config.
   */
  async syncMemberForClan(
    member: GuildMember,
    link: LinkedUser,
    config: GuildClanConfig
  ): Promise<SyncResult> {
    return this.memberLocks.run(`${config.guild_id}:${member.id}`, () =>
      this.syncMemberForClanLocked(member, link, config)
    );
  }

  private async syncMemberForClanLocked(
    member: GuildMember,
    link: LinkedUser,
    config: GuildClanConfig
  ): Promise<SyncResult> {
    const result: SyncResult = {
      discordId: member.id,
      openfrontId: link.openfront_id,
      linkedAt: link.linked_at,
      clanTag: config.clan_tag,
      inClan: false,
      rolesAdded: [],
      rolesRemoved: [],
    };

    try {
      const profile = await openfrontApi.getPlayerProfile(link.openfront_id);
      if (!profile) {
        result.error = "Profile not found or API unreachable";
        return result;
      }

      const currentLink = db.getEffectiveLink(config.guild_id, member.id);
      if (!currentLink || currentLink.openfront_id !== link.openfront_id || currentLink.linked_at !== link.linked_at) {
        result.error = "Link changed while sync was running; skipped stale role updates";
        return result;
      }

      if (!Array.isArray(profile.clans)) {
        result.error = "OpenFront did not return clan membership; roles were left unchanged";
        return result;
      }
      const savedConfig = db.getGuildClanConfig(config.guild_id, config.clan_tag);
      const snapshot = configSnapshot(config);
      if (!savedConfig || configSnapshot(savedConfig) !== snapshot || member.guild.id !== config.guild_id) {
        result.error = "Clan configuration changed; skipped stale role updates";
        return result;
      }
      if (profile.username && profile.username !== link.openfront_username) db.updateUsername(link.discord_id, profile.username, config.guild_id);
      const membership = profile.clans.find((clan) => clan.tag.toUpperCase() === config.clan_tag.toUpperCase());
      result.inClan = !!membership;
      result.clanRole = membership?.role;
      const wanted = desiredRoles([config], profile.clans);
      const configs = db.getGuildConfigs(config.guild_id);
      const configsSnapshot = JSON.stringify(configs.map(configSnapshot));
      const allWanted = desiredRoles(configs, profile.clans);
      const joinRoles = new Set(configs.map((current) => current.join_role_id).filter((role): role is string => !!role));
      const operations = [...wanted].map((role) => ({ role, add: true }));
      operations.push(...managedRoles([config]).filter((role) => !allWanted.has(role) && !joinRoles.has(role)).map((role) => ({ role, add: false })));
      for (const operation of operations) {
        if (member.roles.cache.has(operation.role) === operation.add) continue;
        try {
          await this.rolePacer.run(async () => {
            const latest = db.getEffectiveLink(config.guild_id, member.id);
            const latestConfig = db.getGuildClanConfig(config.guild_id, config.clan_tag);
            if (!latest || latest.openfront_id !== link.openfront_id || latest.linked_at !== currentLink.linked_at ||
                !latestConfig || configSnapshot(latestConfig) !== snapshot ||
                JSON.stringify(db.getGuildConfigs(config.guild_id).map(configSnapshot)) !== configsSnapshot)
              throw new StaleSyncError("Link or configuration changed; skipped stale role update");
            if (member.roles.cache.has(operation.role) === operation.add) return;
            if (operation.add) { await member.roles.add(operation.role); result.rolesAdded.push(operation.role); }
            else { await member.roles.remove(operation.role); result.rolesRemoved.push(operation.role); }
          }, { guildId: config.guild_id });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.error = [result.error, message].filter(Boolean).join("; ");
          if (error instanceof StaleSyncError) break;
          console.warn(`[ClanSync] Role update failed for ${member.id} in guild ${config.guild_id}:`, message);
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * Retrieves members with the join_role who are pending in-game clan invitation.
   */
  async getPendingJoinMembers(
    guild: Guild,
    config: GuildClanConfig
  ): Promise<{
    member: GuildMember;
    link: LinkedUser | null;
    inClan: boolean;
    ofUsername: string | null;
  }[]> {
    if (!config.join_role_id) return [];

    const members = await guild.members.fetch();

    const pendingList: {
      member: GuildMember;
      link: LinkedUser | null;
      inClan: boolean;
      ofUsername: string | null;
    }[] = [];

    const targetClanTag = config.clan_tag.toUpperCase();

    for (const [, member] of members) {
      if (member.user.bot) continue;
      if (!member.roles.cache.has(config.join_role_id)) continue;

      const link = db.getEffectiveLink(member.guild.id, member.id);
      if (!link) {
        pendingList.push({
          member,
          link: null,
          inClan: false,
          ofUsername: null,
        });
        continue;
      }

      const profile = await openfrontApi.getPlayerProfile(link.openfront_id);
      if (!profile || !Array.isArray(profile.clans)) throw new Error("Could not check pending clan invites: OpenFront membership is unavailable.");
      const inClan = Boolean(
        profile.clans?.some((c) => c.tag.toUpperCase() === targetClanTag)
      );

      if (!inClan) {
        pendingList.push({
          member,
          link,
          inClan: false,
          ofUsername: profile?.username || link.openfront_username || link.openfront_id,
        });
      }
    }

    return pendingList;
  }

  /**
   * Reacts to member role additions: if a user is given a join_role, alerts
   * the log channel and checks if they can be synced.
   */
  async handleMemberRoleUpdate(oldMember: GuildMember, newMember: GuildMember) {
    const configs = db.getGuildConfigs(newMember.guild.id);
    if (configs.length === 0) return;

    for (const config of configs) {
      if (!config.join_role_id) continue;

      const hadRole = oldMember.roles.cache.has(config.join_role_id);
      const hasRole = newMember.roles.cache.has(config.join_role_id);

      // Triggered when join_role is newly added to the member
      if (!hadRole && hasRole) {
        console.log(`[ClanSync] Member ${newMember.user.tag} was given join_role for [${config.clan_tag}]`);
        const link = db.getEffectiveLink(newMember.guild.id, newMember.id);

        if (!link) {
          // Alert in log channel that they need to link
          if (config.log_channel_id) {
            const currentMember = await newMember.guild.members.fetch({ user: newMember.id, force: true }).catch(() => null);
            if (!currentMember || !this.currentApprovalNotice(currentMember, config, null)) continue;
            const channel = newMember.guild.channels.cache.get(config.log_channel_id) as TextChannel | undefined;
            if (channel?.isTextBased()) {
              const embed = new EmbedBuilder()
                .setTitle(`📢 Clan Role Assigned: [${config.clan_tag}]`)
                .setColor(0x3b82f6)
                .setDescription(
                  `<@${newMember.id}> was given the <@&${config.join_role_id}> role!\n\n` +
                    `⚠️ **Action Needed:** They have not linked their OpenFront account yet.\n` +
                    `They should run: \`/link\` with their OpenFront profile ID or Identity Token.`
                )
                .setTimestamp();
              await channel.send({ embeds: [embed] }).catch(() => null);
            }
          }
        } else {
          // Member is linked — check if already in clan or needs invite
          const result = await this.syncMemberForClan(newMember, link, config);
          if (result.inClan) {
            // Already in clan — roles granted!
            if (result.rolesAdded.length > 0) {
              await this.logRoleChange(newMember.guild, config, newMember, result);
            }
          } else if (!result.error) {
            // Needs in-game invite!
            if (config.log_channel_id) {
              const currentMember = await newMember.guild.members.fetch({ user: newMember.id, force: true }).catch(() => null);
              if (!currentMember || !this.currentApprovalNotice(currentMember, config, link)) continue;
              const channel = newMember.guild.channels.cache.get(config.log_channel_id) as TextChannel | undefined;
              if (channel?.isTextBased()) {
                const name = link.openfront_username || link.openfront_id;
                const embed = new EmbedBuilder()
                  .setTitle(`🔔 New Clan Member Approval: [${config.clan_tag}]`)
                  .setColor(0xf59e0b)
                  .setDescription(
                    `<@${newMember.id}> has been approved for **[${config.clan_tag}]** in Discord (<@&${config.join_role_id}>).\n\n` +
                      `**OpenFront Account:** [${name}](https://openfront.io/player/${link.openfront_id}) (\`${link.openfront_id}\`)\n\n` +
                      `🛡️ **Officer Action:** Please invite or accept **${name}** into the [${config.clan_tag}] clan in-game!`
                  )
                  .setTimestamp();
                await channel.send({ embeds: [embed] }).catch(() => null);
              }
            }
          }
        }
      }
    }
  }

  private currentApprovalNotice(member: GuildMember, config: GuildClanConfig, link: LinkedUser | null): boolean {
    if (!config.join_role_id || member.guild.id !== config.guild_id) return false;
    const latestConfig = db.getGuildClanConfig(member.guild.id, config.clan_tag);
    const latestLink = db.getEffectiveLink(member.guild.id, member.id);
    return member.roles.cache.has(config.join_role_id) && !!latestConfig &&
      configSnapshot(latestConfig) === configSnapshot(config) &&
      (link ? !!latestLink && latestLink.openfront_id === link.openfront_id && latestLink.linked_at === link.linked_at : !latestLink);
  }

  public async logRoleChange(
    guild: Guild,
    config: GuildClanConfig,
    member: GuildMember,
    result: SyncResult
  ) {
    if (!config.log_channel_id) return;

    // A role write can finish after the mapping or member's identity changes.
    // Do not publish stale identity details to the old destination.
    const latestConfig = db.getGuildClanConfig(guild.id, config.clan_tag);
    const latestLink = db.getEffectiveLink(guild.id, member.id);
    if (guild.id !== config.guild_id || result.discordId !== member.id || !latestConfig ||
        configSnapshot(latestConfig) !== configSnapshot(config) || !latestLink ||
        latestLink.openfront_id !== result.openfrontId || latestLink.linked_at !== result.linkedAt) return;

    try {
      const channel = guild.channels.cache.get(config.log_channel_id) as TextChannel | undefined;
      if (!channel || !channel.isTextBased()) return;

      const embed = new EmbedBuilder()
        .setTitle(`Clan Sync Update: [${config.clan_tag}]`)
        .setColor(result.inClan ? 0x22c55e : 0xef4444)
        .setDescription(`Role changes for <@${member.id}> (OF: [\`${result.openfrontId}\`](https://openfront.io/player/${result.openfrontId}))`)
        .addFields(
          {
            name: "Status",
            value: result.inClan ? `In Clan (${result.clanRole})` : "Left Clan / Not In Clan",
            inline: true,
          },
          {
            name: "Roles Added",
            value: result.rolesAdded.length > 0 ? result.rolesAdded.map((r) => `<@&${r}>`).join(", ") : "None",
            inline: true,
          },
          {
            name: "Roles Removed",
            value: result.rolesRemoved.length > 0 ? result.rolesRemoved.map((r) => `<@&${r}>`).join(", ") : "None",
            inline: true,
          }
        )
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.warn(`[ClanSync] Failed to send log to channel ${config.log_channel_id}:`, err);
    }
  }

  /**
   * Posts a summary notification when users have the join_role but are
   * not yet members of the corresponding OpenFront clan.
   */
  private async logJoinRoleMismatches(
    guild: Guild,
    config: GuildClanConfig,
    mismatches: JoinRoleMismatch[]
  ) {
    if (!config.log_channel_id || mismatches.length === 0) return;

    try {
      const channel = guild.channels.cache.get(config.log_channel_id) as TextChannel | undefined;
      if (!channel || !channel.isTextBased()) return;

      const lines = mismatches.slice(0, 20).map((m) => {
        if (m.openfrontId === "(not linked)") {
          return `• <@${m.discordId}> — *Not linked with /link yet*`;
        }
        const name = m.openfrontUsername || m.openfrontId;
        return `• <@${m.discordId}> — **[${name}](https://openfront.io/player/${m.openfrontId})** (\`${m.openfrontId}\`)`;
      });

      if (mismatches.length > 20) {
        lines.push(`… and ${mismatches.length - 20} more`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`🔔 Pending Clan Invites: [${config.clan_tag}]`)
        .setColor(0xf59e0b)
        .setDescription(
          `The following users have the <@&${config.join_role_id}> role but are **not yet in the [${config.clan_tag}] clan** on OpenFront.\n` +
            `A clan officer can invite them in-game using their profile link:\n\n${lines.join("\n")}`
        )
        .setFooter({ text: `${mismatches.length} user(s) pending clan invite` })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.warn(`[ClanSync] Failed to send join-role mismatch log:`, err);
    }
  }
}
