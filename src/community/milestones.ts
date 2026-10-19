import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CommandError } from '../commandError.js';
import { DeliveryStore } from './deliveries.js';
import { CommunitySettingsStore } from './settings.js';
import { withCommunityTransaction } from './transactions.js';
import type { IdentityBinding } from './types.js';

import { evaluateMilestones } from './milestoneCounters.js';
import type { MilestoneCounters, MilestoneThresholds, MilestoneState, MilestoneEvaluation, MilestoneAward } from './milestoneCounters.js';
export { readMilestoneCounters, validateMilestoneThresholds, evaluateMilestones } from './milestoneCounters.js';
export type { MilestoneCounters, MilestoneThresholds, MilestoneState, MilestoneEvaluation, MilestoneAward } from './milestoneCounters.js';

export interface MilestoneIntent {
  id: string;
  binding: IdentityBinding;
  generation: string | null;
  settingsRevision: number;
  observedAt: number;
  awards: MilestoneAward[];
}
const POLL_INTERVAL = 15 * 60_000;
const changed = () => new CommandError('Milestone identity or membership changed. Reopen /milestones view.');

export class MilestoneStore {
  constructor(private readonly sql: DatabaseSync, private readonly identityCurrent?: (binding: IdentityBinding) => boolean) {}

  static initialize(sql: DatabaseSync): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS community_milestone_observations (
      guild_id TEXT NOT NULL,public_id TEXT NOT NULL,discord_id TEXT NOT NULL,linked_at TEXT NOT NULL,
      games TEXT NOT NULL,wins TEXT NOT NULL,losses TEXT NOT NULL,observed_at INTEGER NOT NULL,
      PRIMARY KEY(guild_id,public_id));
      CREATE INDEX IF NOT EXISTS community_milestone_observation_identity ON community_milestone_observations(discord_id,guild_id);
      CREATE INDEX IF NOT EXISTS community_milestone_observation_account ON community_milestone_observations(public_id);
      CREATE TABLE IF NOT EXISTS community_milestone_thresholds (
      guild_id TEXT NOT NULL,public_id TEXT NOT NULL,metric TEXT NOT NULL,threshold TEXT NOT NULL,
      total TEXT,observed_at INTEGER,PRIMARY KEY(guild_id,public_id,metric,threshold));
      CREATE INDEX IF NOT EXISTS community_milestone_threshold_account ON community_milestone_thresholds(public_id);
      CREATE TABLE IF NOT EXISTS community_milestone_candidates (
      guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,public_id TEXT NOT NULL,linked_at TEXT NOT NULL,
      generation TEXT NOT NULL,next_attempt INTEGER NOT NULL,failures INTEGER NOT NULL DEFAULT 0,last_success INTEGER,
      PRIMARY KEY(guild_id,discord_id));
      CREATE INDEX IF NOT EXISTS community_milestone_due ON community_milestone_candidates(guild_id,next_attempt,discord_id);
      CREATE INDEX IF NOT EXISTS community_milestone_candidate_account ON community_milestone_candidates(public_id);
      CREATE INDEX IF NOT EXISTS community_milestone_candidate_identity ON community_milestone_candidates(discord_id,guild_id);
      CREATE TABLE IF NOT EXISTS community_milestone_account_attempts (
      public_id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,next_attempt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS community_milestone_account_due ON community_milestone_account_attempts(next_attempt,public_id);
      CREATE INDEX IF NOT EXISTS community_milestone_account_identity ON community_milestone_account_attempts(discord_id,guild_id);
      CREATE INDEX IF NOT EXISTS community_milestone_account_guild ON community_milestone_account_attempts(guild_id);
      CREATE TABLE IF NOT EXISTS community_milestone_intents (
      id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,public_id TEXT NOT NULL,linked_at TEXT NOT NULL,
      generation TEXT,settings_revision INTEGER NOT NULL,observed_at INTEGER NOT NULL,awards TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS community_milestone_intent_identity ON community_milestone_intents(discord_id,guild_id);
      CREATE INDEX IF NOT EXISTS community_milestone_intent_account ON community_milestone_intents(public_id);
      CREATE INDEX IF NOT EXISTS community_milestone_intent_guild ON community_milestone_intents(guild_id);
      CREATE INDEX IF NOT EXISTS community_milestone_intent_retention ON community_milestone_intents(observed_at);`);
  }

  private assertCurrent(binding: IdentityBinding, generation?: string): void {
    if (this.identityCurrent && !this.identityCurrent(binding)) throw changed();
    if (generation !== undefined) {
      const candidate = this.sql.prepare(`SELECT generation,public_id,linked_at FROM community_milestone_candidates
        WHERE guild_id=? AND discord_id=?`).get(binding.guildId, binding.discordId);
      if (!candidate || candidate.generation !== generation || candidate.public_id !== binding.publicId ||
          candidate.linked_at !== binding.linkedAt) throw changed();
    }
  }

  private candidateWriter(): (binding: IdentityBinding, now: number) => void {
    const observation = this.sql.prepare(`SELECT observed_at FROM community_milestone_observations
      WHERE guild_id=? AND public_id=? AND discord_id=?`);
    const upsert = this.sql.prepare(`INSERT INTO community_milestone_candidates
      (guild_id,discord_id,public_id,linked_at,generation,next_attempt,last_success) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(guild_id,discord_id) DO UPDATE SET public_id=excluded.public_id,linked_at=excluded.linked_at,
      generation=excluded.generation WHERE community_milestone_candidates.public_id<>excluded.public_id
      OR community_milestone_candidates.linked_at<>excluded.linked_at`);
    return (binding, now) => {
      const prior = observation.get(binding.guildId, binding.publicId, binding.discordId);
      const lastSuccess = prior ? Number(prior.observed_at) : null;
      const next = lastSuccess === null ? now : Math.max(now, lastSuccess + POLL_INTERVAL);
      upsert.run(binding.guildId, binding.discordId, binding.publicId, binding.linkedAt, randomUUID(), next, lastSuccess);
    };
  }

  /** Supply one fresh eligible guild inventory. Removed candidates invalidate captured generations. */
  syncCandidates(guildId: string, bindings: IdentityBinding[], now: number): void {
    withCommunityTransaction(this.sql, () => {
      const present = new Set<string>();
      const writeCandidate = this.candidateWriter();
      for (const binding of bindings) {
        if (binding.guildId !== guildId) throw changed();
        if (this.identityCurrent && !this.identityCurrent(binding)) continue;
        present.add(binding.discordId);
        writeCandidate(binding, now);
      }
      const current = this.sql.prepare('SELECT discord_id FROM community_milestone_candidates WHERE guild_id=?').all(guildId);
      for (const row of current) {
        if (!present.has(String(row.discord_id))) {
          this.sql.prepare('DELETE FROM community_milestone_candidates WHERE guild_id=? AND discord_id=?').run(guildId, row.discord_id!);
        }
      }
    });
  }

  /** For private reads after fresh eligibility checks. Does not attest Discord/clan membership.
   * Automatic polling must full-sync the fresh eligible inventory before selecting due members. */
  prepareObservation(binding: IdentityBinding, now: number): string {
    return withCommunityTransaction(this.sql, () => {
      this.assertCurrent(binding);
      this.candidateWriter()(binding, now);
      return this.candidateGeneration(binding);
    });
  }

  /** Capture before any awaited member/profile request; pass this to observe afterward. */
  candidateGeneration(binding: IdentityBinding): string {
    const row = this.sql.prepare(`SELECT generation FROM community_milestone_candidates
      WHERE guild_id=? AND discord_id=? AND public_id=? AND linked_at=?`)
      .get(binding.guildId, binding.discordId, binding.publicId, binding.linkedAt);
    if (!row) throw changed();
    const generation = String(row.generation);
    this.assertCurrent(binding, generation);
    return generation;
  }

  dueMembers(guildId: string, now: number, limit: number): string[] {
    const take = Number.isFinite(limit) ? Math.max(0, Math.min(200, Math.floor(limit))) : 0;
    return this.sql.prepare(`SELECT discord_id FROM community_milestone_candidates
      WHERE guild_id=? AND next_attempt<=? ORDER BY next_attempt,discord_id LIMIT ?`)
      .all(guildId, now, take).map(row => String(row.discord_id));
  }

  /** Exclude globally reserved accounts before LIMIT so blocked members cannot starve later ones.
   * Fresh same-tick profile evidence may be applied to another guild without another profile request. */
  duePollingMembers(guildId: string, now: number, limit: number, freshPublicIds: string[] = []): string[] {
    const take = Number.isFinite(limit) ? Math.max(0, Math.min(200, Math.floor(limit))) : 0;
    return this.sql.prepare(`SELECT c.discord_id FROM community_milestone_candidates c
      LEFT JOIN community_milestone_account_attempts a ON a.public_id=c.public_id
      WHERE c.guild_id=? AND c.next_attempt<=? AND
      (a.public_id IS NULL OR a.next_attempt<=? OR c.public_id IN (SELECT value FROM json_each(?)))
      ORDER BY c.next_attempt,c.discord_id LIMIT ?`)
      .all(guildId, now, now, JSON.stringify(freshPublicIds), take).map(row => String(row.discord_id));
  }

  /** The account gate and guild reservation commit together, before any automatic profile fetch.
   * A blocked account leaves the guild's durable backoff unchanged. No profile payload is retained. */
  markPollingAttempt(binding: IdentityBinding, now: number, generation = this.candidateGeneration(binding), reuseFreshProfile = false): boolean {
    return withCommunityTransaction(this.sql, () => {
      this.assertCurrent(binding, generation);
      const account = this.sql.prepare('SELECT next_attempt FROM community_milestone_account_attempts WHERE public_id=?').get(binding.publicId);
      if (!reuseFreshProfile && account && Number(account.next_attempt) > now) return false;
      if (!this.markAttempt(binding, now, generation)) return false;
      if (!reuseFreshProfile) {
        this.sql.prepare(`INSERT INTO community_milestone_account_attempts(public_id,guild_id,discord_id,next_attempt) VALUES(?,?,?,?)
          ON CONFLICT(public_id) DO UPDATE SET next_attempt=excluded.next_attempt,
          guild_id=excluded.guild_id,discord_id=excluded.discord_id`)
          .run(binding.publicId, binding.guildId, binding.discordId, now + POLL_INTERVAL);
      }
      return true;
    });
  }

  /** Persist before fetching: failures wait 15m, 30m, 1h ... capped at 6h. Success resets backoff. */
  markAttempt(binding: IdentityBinding, now: number, generation = this.candidateGeneration(binding)): boolean {
    return withCommunityTransaction(this.sql, () => {
      this.assertCurrent(binding, generation);
      const row = this.sql.prepare(`SELECT failures,next_attempt FROM community_milestone_candidates
        WHERE guild_id=? AND discord_id=?`).get(binding.guildId, binding.discordId)!;
      if (Number(row.next_attempt) > now) return false;
      const failures = Math.min(6, Number(row.failures) + 1);
      const next = now + Math.min(6 * 60 * 60_000, POLL_INTERVAL * 2 ** (failures - 1));
      this.sql.prepare(`UPDATE community_milestone_candidates SET failures=?,next_attempt=?
        WHERE guild_id=? AND discord_id=?`).run(failures, next, binding.guildId, binding.discordId);
      return true;
    });
  }

  getState(guildId: string, publicId: string): MilestoneState {
    const row = this.sql.prepare('SELECT games,wins,losses FROM community_milestone_observations WHERE guild_id=? AND public_id=?').get(guildId, publicId);
    const records = this.sql.prepare('SELECT metric,threshold,total FROM community_milestone_thresholds WHERE guild_id=? AND public_id=?').all(guildId, publicId);
    return {
      counters: row ? { games: BigInt(String(row.games)), wins: BigInt(String(row.wins)), losses: BigInt(String(row.losses)) } : null,
      initialized: new Set(records.map(record => `${record.metric}:${record.threshold}`)),
      earned: new Set(records.filter(record => record.total !== null).map(record => `${record.metric}:${record.threshold}`)),
    };
  }

  listAwards(guildId: string, publicId: string): { metric: 'games' | 'wins'; threshold: string; total: string; observedAt: number }[] {
    return this.sql.prepare(`SELECT metric,threshold,total,observed_at FROM community_milestone_thresholds
      WHERE guild_id=? AND public_id=? AND total IS NOT NULL ORDER BY metric,length(threshold),threshold`)
      .all(guildId, publicId).map(row => ({ metric: row.metric as 'games' | 'wins', threshold: String(row.threshold),
        total: String(row.total), observedAt: Number(row.observed_at) }));
  }

  getIntent(id: string): MilestoneIntent | null {
    const row = this.sql.prepare('SELECT * FROM community_milestone_intents WHERE id=?').get(id);
    return row ? {
      id, binding: { guildId: String(row.guild_id), discordId: String(row.discord_id), publicId: String(row.public_id), linkedAt: String(row.linked_at) },
      generation: row.generation === null ? null : String(row.generation), settingsRevision: Number(row.settings_revision),
      observedAt: Number(row.observed_at), awards: JSON.parse(String(row.awards)),
    } : null;
  }

  /** Four arguments are synchronous compatibility only. Network callers must supply the captured generation
   * and settings revision, then freshly validate eligibility immediately before this synchronous call. */
  observe(binding: IdentityBinding, counters: MilestoneCounters, thresholds: MilestoneThresholds, now: number,
    generation?: string, settingsRevision?: number): MilestoneEvaluation {
    return withCommunityTransaction(this.sql, () => {
      this.assertCurrent(binding, generation);
      const settings = new CommunitySettingsStore(this.sql).get(binding.guildId);
      if (settingsRevision !== undefined && settings.revision !== settingsRevision) throw changed();
      const result = evaluateMilestones(this.getState(binding.guildId, binding.publicId), counters, thresholds);
      this.sql.prepare(`INSERT INTO community_milestone_observations
        (guild_id,public_id,discord_id,linked_at,games,wins,losses,observed_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(guild_id,public_id) DO UPDATE SET discord_id=excluded.discord_id,linked_at=excluded.linked_at,
        games=excluded.games,wins=excluded.wins,losses=excluded.losses,observed_at=excluded.observed_at`)
        .run(binding.guildId, binding.publicId, binding.discordId, binding.linkedAt,
          counters.games.toString(), counters.wins.toString(), counters.losses.toString(), now);
      for (const key of result.initialized) {
        const [metric, threshold] = key.split(':');
        this.sql.prepare(`INSERT OR IGNORE INTO community_milestone_thresholds(guild_id,public_id,metric,threshold)
          VALUES(?,?,?,?)`).run(binding.guildId, binding.publicId, metric, threshold);
      }
      for (const award of result.awards) {
        this.sql.prepare(`UPDATE community_milestone_thresholds SET total=?,observed_at=?
          WHERE guild_id=? AND public_id=? AND metric=? AND threshold=? AND total IS NULL`)
          .run(award.total, now, binding.guildId, binding.publicId, award.metric, award.threshold);
      }
      this.sql.prepare(`UPDATE community_milestone_candidates SET failures=0,last_success=?,next_attempt=?
        WHERE guild_id=? AND discord_id=? AND public_id=? AND linked_at=?`)
        .run(now, now + POLL_INTERVAL, binding.guildId, binding.discordId, binding.publicId, binding.linkedAt);
      const announced = result.awards.filter(award => award.announce);
      if (announced.length && settings.milestonesEnabled && settings.milestoneChannelId) {
        const id = randomUUID();
        this.sql.prepare(`INSERT INTO community_milestone_intents
          (id,guild_id,discord_id,public_id,linked_at,generation,settings_revision,observed_at,awards)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(id, binding.guildId, binding.discordId, binding.publicId, binding.linkedAt,
          generation ?? null, settings.revision, now, JSON.stringify(announced));
        new DeliveryStore(this.sql).enqueue({ key: `milestone:${id}`, kind: 'milestone', subjectId: id,
          guildId: binding.guildId, channelId: settings.milestoneChannelId, revision: settings.revision, dueAt: now, part: 0 });
      }
      return result;
    });
  }
}

/** Remove payloads and delivery diagnostics together so personal cleanup leaves no profile data behind. */
export function purgeMilestones(sql: DatabaseSync, scope: 'identity' | 'account' | 'guild', id: string, guildId?: string): void {
  const column = scope === 'identity' ? 'discord_id' : scope === 'account' ? 'public_id' : 'guild_id';
  const clause = `${column}=?${guildId === undefined ? '' : ' AND guild_id=?'}`;
  const args = guildId === undefined ? [id] : [id, guildId];
  // Origin IDs let unlink/departure clear a failed attempt even after inventory removed its candidate.
  const accounts = scope === 'account' ? [{ public_id: id }] : sql.prepare(`
    SELECT public_id FROM community_milestone_candidates WHERE ${clause}
    UNION SELECT public_id FROM community_milestone_observations WHERE ${clause}
    UNION SELECT public_id FROM community_milestone_intents WHERE ${clause}
    UNION SELECT public_id FROM community_milestone_account_attempts WHERE ${clause}`)
    .all(...args, ...args, ...args, ...args);
  sql.prepare(`DELETE FROM community_deliveries WHERE kind='milestone' AND subject_id IN
    (SELECT id FROM community_milestone_intents WHERE ${clause})`).run(...args);
  sql.prepare(`DELETE FROM community_milestone_thresholds WHERE (guild_id,public_id) IN
    (SELECT guild_id,public_id FROM community_milestone_observations WHERE ${clause})`).run(...args);
  for (const table of ['community_milestone_observations', 'community_milestone_candidates', 'community_milestone_intents']) {
    sql.prepare(`DELETE FROM ${table} WHERE ${clause}`).run(...args);
  }
  const affected = JSON.stringify(accounts.map(account => account.public_id));
  // Transfer minimal ownership metadata to a remaining candidate; retain no departed origin IDs.
  sql.prepare(`UPDATE community_milestone_account_attempts SET (guild_id,discord_id)=(
    SELECT c.guild_id,c.discord_id FROM community_milestone_candidates c
    WHERE c.public_id=community_milestone_account_attempts.public_id ORDER BY c.guild_id,c.discord_id LIMIT 1)
    WHERE public_id IN (SELECT value FROM json_each(?)) AND EXISTS
    (SELECT 1 FROM community_milestone_candidates c WHERE c.public_id=community_milestone_account_attempts.public_id)`)
    .run(affected);
  // Other guilds still sharing this account retain their live cadence reservation.
  sql.prepare(`DELETE FROM community_milestone_account_attempts
    WHERE public_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS
    (SELECT 1 FROM community_milestone_candidates c WHERE c.public_id=community_milestone_account_attempts.public_id)`)
    .run(affected);
}
