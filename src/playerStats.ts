/** The public profile's disjoint game-type/mode/difficulty buckets, matching OpenFront's PlayerStatsTree. */
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): bigint | null => {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^\d{1,100}$/.test(value)) return BigInt(value);
  return null;
};

export interface PlayerStatsSummary {
  wins: bigint; losses: bigint; games: bigint; partial: boolean;
  recent: { games: number; wins: number } | null;
  details: { name: string; value: bigint }[];
}

/** BigInt arithmetic keeps counters accurate above Number.MAX_SAFE_INTEGER. */
export function winRate(wins: bigint, games: bigint): string {
  if (games <= 0n) return "—";
  const tenths = (wins * 1000n + games / 2n) / games;
  return `${tenths / 10n}.${tenths % 10n}%`;
}

export function summarizePlayerStats(stats: unknown): PlayerStatsSummary | null {
  if (!record(stats)) return null;
  const leaves: Record<string, unknown>[] = [];
  let partial = false;
  const leaf = (value: unknown) => {
    if (!record(value) || count(value.wins) === null || count(value.losses) === null || count(value.total) === null) {
      partial = true;
      return;
    }
    leaves.push(value);
  };
  // Never recursively sum every object: stats.recent contains overlapping aggregates.
  for (const type of ["Public", "Private", "Singleplayer"]) {
    const node = stats[type];
    if (node === undefined) continue;
    if (!record(node)) { partial = true; continue; }
    for (const mode of ["Free For All", "Team", "Humans Vs Nations"]) {
      const difficulties = node[mode];
      if (difficulties === undefined) continue;
      if (!record(difficulties)) { partial = true; continue; }
      for (const difficulty of ["Easy", "Medium", "Hard", "Impossible"]) {
        if (difficulties[difficulty] !== undefined) leaf(difficulties[difficulty]);
      }
    }
  }
  if (stats.Ranked !== undefined) {
    if (!record(stats.Ranked)) partial = true;
    else for (const value of Object.values(stats.Ranked)) leaf(value);
  }
  if (!leaves.length) return null;
  const summary: PlayerStatsSummary = { wins: 0n, losses: 0n, games: 0n, partial, recent: null, details: [] };
  const detailTotals = new Map<string, bigint>();
  const add = (name: string, value: unknown) => {
    const parsed = count(value);
    if (parsed !== null) detailTotals.set(name, (detailTotals.get(name) ?? 0n) + parsed);
  };
  const slot = (value: unknown, index: number): unknown => Array.isArray(value) ? value[index] : undefined;
  for (const item of leaves) {
    summary.wins += count(item.wins)!;
    summary.losses += count(item.losses)!;
    summary.games += count(item.total)!;
    if (!record(item.stats)) continue;
    const detail = item.stats;
    if (record(detail.units)) {
      add("Cities built", slot(detail.units.city, 0));
      add("Warships built", slot(detail.units.wshp, 0));
    }
    if (record(detail.bombs)) {
      // mirvw are MIRV submunitions; counting them again would inflate launches.
      for (const type of ["abomb", "hbomb", "mirv"]) add("Nukes launched", slot(detail.bombs[type], 0));
    }
    add("Troops sent", slot(detail.attacks, 0));
    add("Trade gold earned", slot(detail.gold, 2));
  }
  const recentTree = record(stats.recent) ? stats.recent.all : undefined;
  const recent = recentTree ?? (leaves.length === 1 ? leaves[0].recent : undefined);
  if (record(recent) && typeof recent.games === "number" && Number.isInteger(recent.games) && recent.games >= 0 && recent.games <= 100 &&
    typeof recent.wins === "number" && Number.isInteger(recent.wins) && recent.wins >= 0 && recent.wins <= recent.games) {
    summary.recent = { games: recent.games, wins: recent.wins };
  }
  summary.details = [...detailTotals].map(([name, value]) => ({ name, value }));
  return summary;
}
