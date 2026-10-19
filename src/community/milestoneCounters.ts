import { CommandError } from '../commandError.js';
import { summarizePlayerStats } from '../playerStats.js';

export interface MilestoneCounters {
  games: bigint;
  wins: bigint;
  losses: bigint;
}
export interface MilestoneThresholds { games: string[]; wins: string[] }
export interface MilestoneState {
  counters: MilestoneCounters | null;
  initialized: Set<string>;
  earned: Set<string>;
}
export interface MilestoneAward {
  metric: 'games' | 'wins';
  threshold: string;
  total: string;
  announce: boolean;
}
export interface MilestoneEvaluation { awards: MilestoneAward[]; initialized: string[] }
const metrics = ['games', 'wins'] as const;

function validCounters(value: MilestoneCounters): boolean {
  return metrics.every(metric => typeof value[metric] === 'bigint' && value[metric] >= 0n) &&
    typeof value.losses === 'bigint' && value.losses >= 0n && value.wins + value.losses <= value.games;
}

/** Read only disjoint public Team buckets, using the existing exact counter parser. */
export function readMilestoneCounters(stats: unknown): MilestoneCounters | null {
  const summary = summarizePlayerStats(stats, 'teams', { type: 'public' });
  if (!summary || summary.partial) return null;
  // A contradictory bucket cannot be repaired by an offsetting contradiction elsewhere.
  const team = (stats as { Public?: { Team?: Record<string, unknown> } }).Public?.Team;
  for (const difficulty of ['Easy', 'Medium', 'Hard', 'Impossible']) {
    if (team?.[difficulty] === undefined) continue;
    const bucket = summarizePlayerStats({ Public: { Team: { [difficulty]: team[difficulty] } } }, 'teams', { type: 'public' });
    if (!bucket || bucket.partial || !validCounters(bucket)) return null;
  }
  return validCounters(summary) ? { games: summary.games, wins: summary.wins, losses: summary.losses } : null;
}

export function validateMilestoneThresholds(input: MilestoneThresholds): MilestoneThresholds {
  for (const metric of metrics) {
    const values = input?.[metric];
    if (!Array.isArray(values) || values.length > 10 ||
        values.some((value, index) => typeof value !== 'string' || !/^[1-9]\d*$/.test(value) ||
          (index > 0 && BigInt(values[index - 1]) >= BigInt(value)))) {
      throw new CommandError('Choose up to ten ascending, unique positive integer thresholds for each metric.');
    }
  }
  return { games: [...input.games], wins: [...input.wins] };
}

export function evaluateMilestones(state: MilestoneState, current: MilestoneCounters, thresholds: MilestoneThresholds): MilestoneEvaluation {
  validateMilestoneThresholds(thresholds);
  if (!validCounters(current)) throw new CommandError('Complete, consistent public Team statistics are unavailable.');
  const result: MilestoneEvaluation = { awards: [], initialized: [] };
  for (const metric of metrics) {
    for (const threshold of thresholds[metric]) {
      const key = `${metric}:${threshold}`;
      const initialized = state.initialized.has(key);
      if (!initialized) result.initialized.push(key);
      if (state.earned.has(key) || current[metric] < BigInt(threshold)) continue;
      const announce = state.counters !== null && initialized;
      if (announce && state.counters![metric] >= BigInt(threshold)) continue;
      result.awards.push({ metric, threshold, total: current[metric].toString(), announce });
    }
  }
  return result;
}

