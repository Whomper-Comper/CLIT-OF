import { EmbedBuilder, type Client, type Guild } from 'discord.js';
import { openfrontApi, type OpenFrontApi, type OpenFrontPlayerProfile } from '../api.js';
import type { BotDatabase } from '../db.js';
import { readMilestoneCounters } from './milestoneCounters.js';
import type { CommunityService } from './service.js';
import type { CommunityTick, DeliveryJob, IdentityBinding, PreparedDelivery } from './types.js';
import { CommunityBudgetExhaustedError } from './types.js';

export function milestoneHealth(db: BotDatabase, now: number): boolean {
  const checkpoint = Date.parse(db.history.getMeta('deletions_last_success') ?? '');
  return Number.isFinite(checkpoint) && checkpoint <= now && now - checkpoint < 86_400_000 &&
    !db.history.getMeta('deletions_error');
}
export function milestoneBinding(db: BotDatabase, guildId: string, discordId: string): IdentityBinding | null {
  const link = db.getEffectiveLink(guildId, discordId);
  return link ? { guildId, discordId, publicId: link.openfront_id, linkedAt: link.linked_at } : null;
}
export function milestoneIdentityCurrent(db: BotDatabase, binding: IdentityBinding): boolean {
  const current = milestoneBinding(db, binding.guildId, binding.discordId);
  return !!current && current.publicId === binding.publicId && current.linkedAt === binding.linkedAt &&
    !db.history.isDeleted(binding.publicId);
}
export function milestoneClanEligible(db: BotDatabase, guildId: string, profile: OpenFrontPlayerProfile | null): boolean {
  const tags = new Set(db.getGuildConfigs(guildId).map(config => config.clan_tag));
  return !!profile?.clans?.some(clan => tags.has(clan.tag.trim().toUpperCase()));
}
const proofKey = (binding: IdentityBinding) => binding.publicId;
interface ProfileEvidence { profile: OpenFrontPlayerProfile | null; fetchedAt: number }
type Evidence = Map<string, ProfileEvidence>;
const PROFILE_FRESHNESS = 60_000;
function take(tick?: CommunityTick): void {
  if (tick && !tick.takeRequest()) throw new CommunityBudgetExhaustedError('Milestone validation deferred until the next tick.');
}

/** Repeated prepare calls share only same-tick profile evidence; membership is always refreshed. */
export async function prepareMilestoneDelivery(job: DeliveryJob, guild: Guild, db: BotDatabase, now: number,
  tick?: CommunityTick, api: OpenFrontApi = openfrontApi, evidence: Evidence = new Map()): Promise<PreparedDelivery | null> {
  const store = db.community.milestones;
  const intent = store.getIntent(job.subjectId);
  if (!intent || job.kind !== 'milestone' || guild.id !== job.guildId) return null;
  const clock = () => tick?.currentTime?.() ?? now;
  const current = () => {
    const settings = db.community.settings.get(job.guildId);
    if (tick?.stopping() || !milestoneHealth(db, clock())) {
      throw new CommunityBudgetExhaustedError('Milestone delivery waits for a healthy deletion feed and active service.');
    }
    if (!store.getIntent(intent.id) || !settings.milestonesEnabled || settings.revision !== job.revision ||
      intent.settingsRevision !== job.revision || settings.milestoneChannelId !== job.channelId ||
      intent.binding.guildId !== job.guildId || !milestoneIdentityCurrent(db, intent.binding)) return false;
    try {
      return intent.generation === null || store.candidateGeneration(intent.binding) === intent.generation;
    } catch { return false; }
  };
  if (!current()) return null;
  const key = proofKey(intent.binding);
  const cached = evidence.get(key);
  if (cached && (clock() - cached.fetchedAt > PROFILE_FRESHNESS || clock() < cached.fetchedAt)) evidence.delete(key);
  if (!evidence.has(key)) {
    take(tick);
    const fetchedAt = clock();
    const profile = await api.getPlayerProfile(intent.binding.publicId, { fresh: true });
    if (!current()) return null;
    evidence.set(key, { profile, fetchedAt });
  }
  if (!Array.isArray(evidence.get(key)?.profile?.clans)) {
    throw new Error('Current clan membership is unavailable. The earned card remains queued for retry.');
  }
  take(tick);
  const member = await guild.members.fetch({ user: intent.binding.discordId, force: true });
  if (!current()) return null;
  const proof = evidence.get(key)!;
  if (clock() - proof.fetchedAt > PROFILE_FRESHNESS || clock() < proof.fetchedAt) {
    throw new CommunityBudgetExhaustedError('Milestone profile evidence expired during validation. Retry on the next tick.');
  }
  if (member.user.bot || !milestoneClanEligible(db, guild.id, proof.profile)) return null;
  const embed = new EmbedBuilder().setColor(0xf1c40f).setTitle('Clan milestone reached')
    .setDescription(`Member: <@${intent.binding.discordId}> · [Public profile](https://openfront.io/player/${encodeURIComponent(intent.binding.publicId)})`)
    .setFooter({ text: 'Public Team lifetime counters · Observed, not a historical achievement date' })
    .setTimestamp(intent.observedAt);
  for (const metric of ['games', 'wins'] as const) {
    const awards = intent.awards.filter(award => award.metric === metric);
    if (awards.length) embed.addFields({ name: metric === 'games' ? 'Games played' : 'Wins',
      value: `Thresholds: ${awards.map(award => award.threshold).join(', ')}\nObserved total: ${awards[0].total}` });
  }
  return { payload: { embeds: [embed], allowedMentions: { parse: [] } } };
}

export function registerMilestoneWork(service: CommunityService, client: Client, db: BotDatabase, api: OpenFrontApi): void {
  const evidenceByTick = new WeakMap<CommunityTick, Evidence>();
  // Service task and delivery contexts are separate objects, but have the same tick timestamp.
  let evidence: Evidence = new Map();
  let evidenceAt = NaN;
  const forTick = (tick?: CommunityTick) => {
    if (!tick) return new Map<string, ProfileEvidence>();
    if (evidenceByTick.has(tick)) return evidenceByTick.get(tick)!;
    if (evidenceAt !== tick.now) {
      evidence = new Map();
      evidenceAt = tick.now;
    }
    evidenceByTick.set(tick, evidence);
    return evidence;
  };
  service.registerDelivery('milestone', {
    requestBudget: 3,
    async prepare(job, now = Date.now(), tick) {
      const guild = client.guilds.cache.get(job.guildId);
      return guild ? prepareMilestoneDelivery(job, guild, db, now, tick, api, forTick(tick)) : null;
    },
  });
  let guildOffset = 0;
  service.registerTask('milestones', async tick => {
    // A new task invocation always starts a new tick, even with a deterministic/frozen clock.
    evidence = new Map();
    evidenceAt = tick.now;
    evidenceByTick.set(tick, evidence);
    const clock = () => tick.currentTime?.() ?? tick.now;
    if (!milestoneHealth(db, clock()) || tick.stopping()) return;
    const settings = db.community.settings.list().filter(s => s.milestonesEnabled && s.milestoneChannelId &&
      (s.gameThresholds.length || s.winThresholds.length) && client.guilds.cache.has(s.guildId));
    if (!settings.length) return;
    const offset = guildOffset++ % settings.length;
    for (let n = 0; n < settings.length && !tick.stopping(); n++) {
      const saved = settings[(offset + n) % settings.length];
      const guild = client.guilds.cache.get(saved.guildId)!;
      if (!tick.takeRequest()) return;
      try {
        const roster = await guild.members.fetch({ withPresences: false });
        const active = () => !tick.stopping() && milestoneHealth(db, clock()) &&
          db.community.settings.get(guild.id).revision === saved.revision &&
          db.community.settings.get(guild.id).milestonesEnabled;
        if (!active()) continue;
        const candidates = db.getEffectiveLinks(guild.id).filter(link => {
          const member = roster.get(link.discord_id);
          return member && !member.user.bot && !db.history.isDeleted(link.openfront_id);
        }).map(link => ({ guildId: guild.id, discordId: link.discord_id, publicId: link.openfront_id, linkedAt: link.linked_at }));
        db.community.milestones.syncCandidates(guild.id, candidates, clock());
        const byId = new Map(candidates.map(binding => [binding.discordId, binding]));
        const freshIds = [...evidence].filter(([, proof]) => clock() >= proof.fetchedAt &&
          clock() - proof.fetchedAt <= PROFILE_FRESHNESS).map(([id]) => id);
        for (const id of db.community.milestones.duePollingMembers(guild.id, clock(), 8, freshIds)) {
          const binding = byId.get(id)!;
          const prior = evidence.get(proofKey(binding));
          const reuse = !!prior && clock() >= prior.fetchedAt && clock() - prior.fetchedAt <= PROFILE_FRESHNESS;
          // Reserve both requests before making a durable attempt; budget deferral is not failure.
          if (!tick.takeRequest() || (!reuse && !tick.takeRequest())) return;
          const generation = db.community.milestones.candidateGeneration(binding);
          if (!active() || !db.community.milestones.markPollingAttempt(binding, clock(), generation, reuse)) continue;
          try {
            const fetchedAt = reuse ? prior!.fetchedAt : clock();
            const profile = reuse ? prior!.profile : await api.getPlayerProfile(binding.publicId, { fresh: true });
            if (!active() || !milestoneIdentityCurrent(db, binding)) continue;
            // Keep raw account evidence independent of the first guild's clan/membership eligibility.
            if (clock() >= fetchedAt && clock() - fetchedAt <= PROFILE_FRESHNESS) {
              evidence.set(proofKey(binding), { profile, fetchedAt });
            }
            const member = await guild.members.fetch({ user: id, force: true });
            if (!active() || member.user.bot || !milestoneIdentityCurrent(db, binding) ||
              !milestoneClanEligible(db, guild.id, profile) || clock() - fetchedAt > PROFILE_FRESHNESS ||
              clock() < fetchedAt) continue;
            evidence.set(proofKey(binding), { profile, fetchedAt });
            const counters = readMilestoneCounters(profile?.stats);
            if (counters) db.community.milestones.observe(binding, counters,
              { games: saved.gameThresholds, wins: saved.winThresholds }, clock(), generation, saved.revision);
          } catch { /* Durable attempt reservation backs off upstream and stale-identity failures. */ }
        }
      } catch { /* A failed roster never licenses automatic candidates or observations. */ }
    }
  });
}
