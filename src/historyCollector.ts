import { EmbedBuilder, PermissionFlagsBits, type Client, type Guild, type GuildMember } from "discord.js";
import type { OpenFrontApi } from "./api.js";
import type { BotDatabase, LinkedUser } from "./db.js";
import { DAY, type EloObservation, type HistoryJob, type HistoryJobInput, type HistorySettings } from "./historyStore.js";
import { weeklyPeriod } from "./historySchedule.js";

export interface HistoryCollectorOptions {
  buildWeeklyReport?: (guildId: string, start: string, end: string) => Promise<EmbedBuilder>;
  now?: () => number; maxRequestsPerTick?: number; tickMs?: number;
}
interface GuildSnapshot { guild: Guild; settings: HistorySettings; links: LinkedUser[]; tags: Set<string> }
const errorText = (error: unknown) => error instanceof Error ? error.message : "History collection failed; the same page will retry.";
/** A separate, bounded worker: role cleanup never waits behind history requests. */
export class HistoryCollector {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private readonly now: () => number;
  constructor(private readonly client: Client, private readonly db: BotDatabase, private readonly api: OpenFrontApi,
    private readonly options: HistoryCollectorOptions = {}) { this.now = options.now ?? Date.now; }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.collectOnce().catch(error=>console.error("[History] Background worker failed:",error)),this.options.tickMs ?? 60_000);
    void this.collectOnce().catch(error=>console.error("[History] Initial collection failed:",error));
  }
  async stop() {
    this.stopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.running;
  }
  collectOnce(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopping) return Promise.resolve();
    const run = this.tick();
    this.running = run;
    void run.finally(()=> { if (this.running === run) this.running = null; }).catch(()=>null);
    return run;
  }
  private async refreshMembers(guild: Guild): Promise<LinkedUser[]> {
    const members = await guild.members.fetch();
    if (this.stopping) return [];
    const links = this.db.getEffectiveLinks(guild.id).filter(link=> {
      const member = members.get(link.discord_id);
      return member && !member.user.bot;
    });
    this.db.history.prunePlayerMembers(guild.id,links);
    return links;
  }
  private async deletionSync(now: number): Promise<{ healthy: boolean; requests: number }> {
    const last = this.db.history.getMeta("deletions_last_success"), previous = last ? Date.parse(last) : NaN;
    const validCheckpoint = Number.isFinite(previous) && previous <= now;
    if (validCheckpoint && now-previous < DAY) return { healthy: true,requests: 0 };
    // Keep the request inside the feed's retention boundary, including transport time.
    const earliest = now-7*DAY+60_000;
    // Any interval skipped by that safety margin is a gap in deletion coverage too.
    if (!validCheckpoint || previous < earliest) this.db.history.clearAllPlayerHistory();
    try {
      const deleted = await this.api.getRecentlyDeletedPlayers(new Date(Math.max(earliest,validCheckpoint ? previous-60_000 : earliest)).toISOString(),{fresh:true});
      if (this.stopping) return {healthy:false,requests:1};
      for (const player of deleted) this.db.history.purgePlayer(player.publicId,player.deletedAt);
      this.db.history.setMeta("deletions_last_success",new Date(now).toISOString());
      this.db.history.setMeta("deletions_error","");
      return {healthy:true,requests:1};
    } catch (error) {
      if (!this.stopping) this.db.history.setMeta("deletions_error",`Player deletion sync failed: ${errorText(error)}`);
      return {healthy:false,requests:1};
    }
  }
  private async tick() {
    const now = this.now(), allSettings = this.db.history.listSettings();
    this.db.history.pruneEloObservations(now);
    for (const settings of allSettings) this.db.history.retain(settings.guild_id,settings.retention_days,now);
    let remaining = Math.max(1,Math.min(50,this.options.maxRequestsPerTick ?? 8));
    const needsDeletionSync = allSettings.some(settings=>settings.player_history_enabled) || this.db.history.hasEloObservations() ||
      this.db.community.settings.list().some(settings => settings.milestonesEnabled);
    const deletion = needsDeletionSync ? await this.deletionSync(now) : {healthy:true,requests:0};
    remaining -= deletion.requests;
    if (this.stopping) return;
    const snapshots = new Map<string,GuildSnapshot>();
    for (const settings of allSettings.filter(settings=>settings.collection_enabled)) {
      if (this.stopping) return;
      const guild = this.client.guilds.cache.get(settings.guild_id);
      if (!guild) continue;
      try {
        const links = await this.refreshMembers(guild);
        if (this.stopping || this.db.history.getSettings(guild.id).revision !== settings.revision) continue;
        const tags = new Set(this.db.getGuildConfigs(guild.id).map(config=>config.clan_tag));
        this.db.history.pruneClans(guild.id,tags);
        const inventory: HistoryJobInput[] = [];
        if (settings.clan_history_enabled) for (const tag of tags) inventory.push({kind:"clan",subject:tag});
        else this.db.history.removeJobs(guild.id,"clan");
        if (settings.player_history_enabled && tags.size && deletion.healthy) {
          for (const link of links) inventory.push({kind:"player",subject:link.openfront_id,discordId:link.discord_id,identityVersion:link.linked_at});
        } else if (!settings.player_history_enabled) this.db.history.clearGuildPlayerHistory(guild.id);
        else if (!tags.size) this.db.history.removeJobs(guild.id,"player");
        this.db.history.ensureJobs(guild.id,inventory,now);
        snapshots.set(guild.id,{guild,settings,links,tags});
        this.db.history.setMeta(`guild_error:${guild.id}`,"");
      } catch (error) {
        if (!this.stopping) this.db.history.setMeta(`guild_error:${guild.id}`,`Discord members unavailable: ${errorText(error)}`);
      }
    }
    // One shared leaderboard page covers every enabled server's linked humans.
    // Reserve collection capacity for match history and persist the scan across restarts.
    if (deletion.healthy && remaining > 2 && [...snapshots.values()].some(s=>s.settings.player_history_enabled && s.links.length) &&
      Number(this.db.history.getMeta("elo_next_attempt") ?? 0) <= this.now()) {
      remaining--;
      await this.collectEloPage(snapshots);
    }
    while (!this.stopping && remaining-- > 0) {
      const job = this.db.history.nextJob(this.now(),[...snapshots.keys()],deletion.healthy);
      if (!job) break;
      this.db.history.touchJob(job);
      const snapshot = snapshots.get(job.guild_id)!;
      try { await this.collectPage(job,snapshot); }
      catch (error) { if (this.current(job,snapshot)) this.db.history.retryJob(job,errorText(error),this.now()); }
    }
    if (this.stopping || !deletion.healthy || !this.options.buildWeeklyReport) return;
    // Discord sends are bounded too, and rotate across servers independently of collection pagination.
    const ordered = [...snapshots.values()].map(snapshot => ({
      snapshot, priority: Number(this.db.history.getMeta(`weekly_work:${snapshot.guild.id}`) ?? 0),
    })).sort((a,b) => a.priority-b.priority);
    for (const {snapshot} of ordered.slice(0,2)) {
      if (this.stopping) return;
      await this.deliverWeekly(snapshot);
      if (!this.stopping) this.db.history.setMeta(`weekly_work:${snapshot.guild.id}`,String(this.now()));
    }
  }
  private async collectEloPage(snapshots: Map<string,GuildSnapshot>) {
    const storedPage = Number(this.db.history.getMeta("elo_scan_page") ?? 1);
    const pageNumber = Number.isSafeInteger(storedPage) && storedPage >= 1 && storedPage <= 100 ? storedPage : 1;
    try {
      const page = await this.api.getRankedLeaderboardPage(pageNumber);
      if (this.stopping) return;
      const ratingsById = new Map<string,typeof page.ratings>();
      for (const rating of page.ratings) {
        const ratings = ratingsById.get(rating.publicId);
        if (ratings) ratings.push(rating);
        else ratingsById.set(rating.publicId,[rating]);
      }
      for (const snapshot of snapshots.values()) {
        const settings = this.db.history.getSettings(snapshot.guild.id);
        if (!settings.player_history_enabled || !settings.collection_enabled || settings.revision !== snapshot.settings.revision) continue;
        const observations: EloObservation[] = [];
        for (const link of snapshot.links) {
          const ratings = ratingsById.get(link.openfront_id);
          if (!ratings) continue;
          // Member removal updates this cache before the removal handler purges history.
          const member = snapshot.guild.members.cache.get(link.discord_id);
          if (!member || member.user.bot) continue;
          const current = this.db.getEffectiveLink(snapshot.guild.id,link.discord_id);
          if (!current || current.openfront_id !== link.openfront_id || current.linked_at !== link.linked_at) continue;
          for (const rating of ratings) {
            observations.push({ publicId: link.openfront_id, discordId: link.discord_id, ladder: rating.ladder, rating: rating.rating });
          }
        }
        this.db.history.recordEloBatch(snapshot.guild.id,observations,Date.parse(page.observedAt));
      }
      const continues = page.hasMore && pageNumber < 100;
      const interval = Math.min(...[...snapshots.values()].filter(s=>s.settings.player_history_enabled).map(s=>s.settings.poll_minutes));
      this.db.history.setMeta("elo_scan_page",String(continues ? pageNumber+1 : 1));
      this.db.history.setMeta("elo_next_attempt",String(this.now()+(continues ? 60_000 : Math.max(5,interval)*60_000)));
      this.db.history.setMeta("elo_attempts","0");
      this.db.history.setMeta("elo_error","");
    } catch (error) {
      if (this.stopping) return;
      const attempts = Math.min(6,Number(this.db.history.getMeta("elo_attempts") ?? 0)+1);
      this.db.history.setMeta("elo_attempts",String(attempts));
      this.db.history.setMeta("elo_next_attempt",String(this.now()+Math.min(3_600_000,60_000*2**attempts)));
      this.db.history.setMeta("elo_error",`Elo observations could not refresh: ${errorText(error)}`);
    }
  }
  private current(job: HistoryJob, snapshot: GuildSnapshot): boolean {
    if (this.stopping) return false;
    const settings = this.db.history.getSettings(job.guild_id);
    if (!settings.collection_enabled || settings.revision !== snapshot.settings.revision) return false;
    if (this.db.getGuildConfigs(job.guild_id).map(config=>config.clan_tag).sort().join("\n") !== [...snapshot.tags].sort().join("\n")) return false;
    const stored = this.db.history.getJob(job.guild_id,job.kind,job.subject);
    if (!stored || stored.identity_version !== job.identity_version || stored.window_start !== job.window_start || stored.page !== job.page || stored.cursor !== job.cursor) return false;
    if (job.kind === "clan") return !!settings.clan_history_enabled && snapshot.tags.has(job.subject);
    const link = job.discord_id ? this.db.getEffectiveLink(job.guild_id,job.discord_id) : null;
    return !!settings.player_history_enabled && !!link && link.openfront_id === job.subject && link.linked_at === job.identity_version && !this.db.history.isDeleted(job.subject);
  }
  private async memberStillPresent(snapshot: GuildSnapshot, job: HistoryJob): Promise<boolean> {
    try {
      const member: GuildMember = await snapshot.guild.members.fetch({user:job.discord_id!,force:true});
      return !member.user.bot;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 10007) {
        if (this.current(job,snapshot)) this.db.history.purgeMember(job.guild_id,job.discord_id!);
        return false;
      }
      throw error;
    }
  }
  private async collectPage(job: HistoryJob, snapshot: GuildSnapshot) {
    if (!this.current(job,snapshot)) return;
    if (job.kind === "clan") {
      const page = await this.api.getClanSessions(job.subject,{start:job.window_start,end:job.window_end,page:job.page,limit:50});
      if (!this.current(job,snapshot)) return;
      if (!page) throw new Error("Configured clan history is unavailable; verify the clan tag.");
      const lower = Date.parse(job.window_start), upper = Date.parse(job.window_end);
      if (page.results.some(match=>match.clanTag.trim().toUpperCase() !== job.subject || Date.parse(match.gameStart) < lower || Date.parse(match.gameStart) > upper))
        throw new Error("Clan history returned a row outside the requested clan or date window.");
      this.db.history.upsertClanMatches(job.guild_id,job.subject,page.results.filter(match=>Date.parse(match.gameStart)<upper));
      if (job.page*page.limit < page.total) {
        if (job.page >= 200 || !page.results.length) throw new Error("Clan history pagination could not finish this day; coverage remains incomplete.");
        this.db.history.advancePage(job,null,job.page+1);
      } else this.db.history.finishWindow(job,this.now(),snapshot.settings.poll_minutes);
    } else {
      const page = await this.api.getPlayerSessions(job.subject,{start:job.window_start,end:job.window_end,
        ...(job.cursor ? {cursor:job.cursor} : {}),type:"public",filter:"team"});
      if (!this.current(job,snapshot)) return;
      if (!page) {
        this.db.history.purgePlayer(job.subject);
        return;
      }
      if (!await this.memberStillPresent(snapshot,job) || !this.current(job,snapshot)) return;
      const lower = Date.parse(job.window_start), upper = Date.parse(job.window_end);
      if (page.results.some(match=>Date.parse(match.gameStart) < lower || Date.parse(match.gameStart) > upper))
        throw new Error("Player history returned a row outside its requested date window.");
      const matches = page.results.filter(match=> Date.parse(match.gameStart)<upper && match.gameType.toLowerCase() === "public" && match.gameMode.toLowerCase() === "team" &&
        !!match.clanTag && snapshot.tags.has(match.clanTag.trim().toUpperCase()));
      this.db.history.upsertPlayerMatches(job.guild_id,job.subject,job.discord_id!,matches);
      if (page.nextCursor) {
        if (page.nextCursor === job.cursor || job.page >= 200) throw new Error("Player history cursor stalled; this window will retry without claiming complete coverage.");
        this.db.history.advancePage(job,page.nextCursor,job.page+1);
      } else this.db.history.finishWindow(job,this.now(),snapshot.settings.poll_minutes);
    }
  }
  private async deliverWeekly(snapshot: GuildSnapshot) {
    const settings = this.db.history.getSettings(snapshot.guild.id), now = this.now();
    if (!settings.collection_enabled || !settings.weekly_enabled || !settings.channel_id || settings.revision !== snapshot.settings.revision) return;
    const period = weeklyPeriod(settings,now), enabledAt = this.db.history.getWeeklyEnabledAt(snapshot.guild.id);
    if (!enabledAt || period.scheduledAt < enabledAt) return;
    const delivery = this.db.history.ensureDelivery(snapshot.guild.id,period.start,period.end,settings.channel_id);
    if (delivery.status === "sent" || delivery.status === "failed" || delivery.next_attempt > now) return;
    if (delivery.channel_id !== settings.channel_id) {
      // A pending report never leaks to the old destination after a configuration change.
      this.db.history.retryDelivery({...delivery,attempts:5},"Weekly recap destination changed; reopen configuration before the next period.",now);
      return;
    }
    try {
      const linksBefore = await this.refreshMembers(snapshot.guild);
      if (this.stopping) return;
      const channel = await snapshot.guild.channels.fetch(settings.channel_id);
      if (this.stopping) return;
      if (!channel || !channel.isTextBased() || !channel.isSendable() || channel.isDMBased() || channel.isThread())
        throw new Error("Weekly recap channel must be a server text or announcement channel.");
      const me = snapshot.guild.members.me ?? await snapshot.guild.members.fetchMe();
      if (this.stopping) return;
      if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ReadMessageHistory]))
        throw new Error("Weekly recap channel requires View Channel, Send Messages, Embed Links and Read Message History.");
      const marker = `Report ${delivery.nonce}`;
      if (delivery.attempts > 0) {
        const recent = await channel.messages.fetch({limit:100,cache:false});
        if (this.stopping) return;
        const prior = recent.find(message=>message.author.id === this.client.user?.id && message.embeds.some(embed=>embed.footer?.text.includes(marker)));
        if (prior) { this.db.history.finishDelivery(delivery,prior.id); return; }
      }
      const report = await this.options.buildWeeklyReport!(snapshot.guild.id,period.start,period.end);
      if (this.stopping) return;
      const linksAfter = await this.refreshMembers(snapshot.guild);
      if (this.stopping) return;
      const identities = (links: LinkedUser[]) => links.map(link=>`${link.discord_id}:${link.openfront_id}:${link.linked_at}`).sort().join("\n");
      if (identities(linksBefore) !== identities(linksAfter)) return;
      const latest = this.db.history.getSettings(snapshot.guild.id);
      if (latest.revision !== settings.revision || latest.channel_id !== delivery.channel_id || !latest.weekly_enabled || !latest.collection_enabled ||
        this.db.getGuildConfigs(snapshot.guild.id).map(config=>config.clan_tag).sort().join("\n") !== [...snapshot.tags].sort().join("\n")) return;
      const footer = report.data.footer;
      report.setFooter({text:`${footer?.text ? `${footer.text} · ` : ""}${marker}`.slice(0,2048),...(footer?.icon_url ? {iconURL:footer.icon_url} : {})});
      this.db.history.attemptDelivery(delivery);
      const message = await channel.send({embeds:[report],allowedMentions:{parse:[]},nonce:delivery.nonce,enforceNonce:true});
      if (!this.stopping) this.db.history.finishDelivery(delivery,message.id);
    } catch (error) {
      if (!this.stopping) {
        const attempted = this.db.history.getDelivery(delivery.guild_id,delivery.period_start,delivery.period_end)!;
        // Permission and rendering failures also count toward the bounded retry budget.
        if (attempted.attempts === delivery.attempts) this.db.history.attemptDelivery(delivery);
        this.db.history.retryDelivery({...delivery,attempts:Math.max(delivery.attempts,attempted.attempts-1)},errorText(error),this.now());
      }
    }
  }
}
