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
  details: { name: string; value: bigint; partial?: boolean }[];
  buildings: { name: string; value: bigint | null; partial: boolean }[];
}
export type PlayerGameMode = "ffa" | "teams" | "hvn";
export type PlayerStatsFilter = PlayerGameMode | "ranked";
export type PlayerStatsType = "all" | "public" | "private" | "singleplayer";
export interface PlayerStatsOptions { type?: PlayerStatsType; includeRanked?: boolean }

/** BigInt arithmetic keeps counters accurate above Number.MAX_SAFE_INTEGER. */
export function winRate(wins: bigint, games: bigint): string {
  if (games <= 0n) return "—";
  const tenths = (wins * 1000n + games / 2n) / games;
  return `${tenths / 10n}.${tenths % 10n}%`;
}

export function summarizePlayerStats(stats: unknown, gameMode?: PlayerStatsFilter, options: PlayerStatsOptions = {}): PlayerStatsSummary | null {
  if (!record(stats)) return null;
  const type = options.type ?? "all";
  const selectedTypes = type === "all" ? ["Public", "Private", "Singleplayer"]
    : [type === "public" ? "Public" : type === "private" ? "Private" : "Singleplayer"];
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
  const selectedModes = gameMode === "ffa" ? ["Free For All"]
    : gameMode === "teams" ? ["Team"]
    : gameMode === "hvn" ? ["Humans Vs Nations"]
    : gameMode === "ranked" ? []
    : ["Free For All", "Team", "Humans Vs Nations"];
  for (const type of selectedTypes) {
    const node = stats[type];
    if (node === undefined) continue;
    if (!record(node)) { partial = true; continue; }
    for (const mode of selectedModes) {
      const difficulties = node[mode];
      if (difficulties === undefined) continue;
      if (!record(difficulties)) { partial = true; continue; }
      for (const difficulty of ["Easy", "Medium", "Hard", "Impossible"]) {
        if (difficulties[difficulty] !== undefined) leaf(difficulties[difficulty]);
      }
    }
  }
  const includeRanked = (gameMode === undefined && (type === "all" || (options.includeRanked && type === "public")))
    || (gameMode === "ranked" && (type === "public" || type === "all"));
  if (includeRanked && stats.Ranked !== undefined) {
    if (!record(stats.Ranked)) partial = true;
    else for (const value of Object.values(stats.Ranked)) leaf(value);
  }
  if (!leaves.length) return null;
  const summary: PlayerStatsSummary = { wins: 0n, losses: 0n, games: 0n, partial, recent: null, details: [], buildings: [] };
  const slot = (value: unknown, index: number): unknown => Array.isArray(value) ? value[index] : undefined;
  for (const item of leaves) {
    summary.wins += count(item.wins)!;
    summary.losses += count(item.losses)!;
    summary.games += count(item.total)!;
  }
  // Recent aggregates are newest-100 windows, not additive counters. Only use
  // the exact selection's aggregate; all modes/types would mislabel a tab.
  let recentTree: unknown;
  if (record(stats.recent)) {
    if (gameMode === "ranked") recentTree = record(stats.recent.Ranked) ? stats.recent.Ranked.all : undefined;
    else if (type === "all") recentTree = gameMode === undefined ? stats.recent.all : undefined;
    else if (!(gameMode === undefined && options.includeRanked && type === "public")) {
      const typeRecent = stats.recent[selectedTypes[0]];
      if (record(typeRecent)) {
        const modeRecent = gameMode === undefined ? typeRecent : typeRecent[selectedModes[0]];
        recentTree = record(modeRecent) ? modeRecent.all : undefined;
      }
    }
  }
  const recent = recentTree ?? (leaves.length === 1 ? leaves[0].recent : undefined);
  if (record(recent) && typeof recent.games === "number" && Number.isInteger(recent.games) && recent.games >= 0 && recent.games <= 100 &&
    typeof recent.wins === "number" && Number.isInteger(recent.wins) && recent.wins >= 0 && recent.wins <= recent.games) {
    summary.recent = { games: recent.games, wins: recent.wins };
  }
  const aggregate = (values: (bigint | null)[]) => {
    const known = values.filter((value): value is bigint => value !== null);
    return { value: known.length ? known.reduce((total, value) => total + value, 0n) : null,
      partial: partial || known.length !== leaves.length };
  };
  // Wire counters use slot zero for built units. Missing buckets are not zero builds.
  summary.buildings = [["city", "Cities"], ["port", "Ports"], ["defp", "Defense posts"], ["fact", "Factories"], ["silo", "Missile silos"]].map(([key, name]) => {
    const values = leaves.map(item => record(item.stats) && record(item.stats.units) ? count(slot(item.stats.units[key], 0)) : null);
    return { name, ...aggregate(values) };
  });
  summary.details = summary.buildings.filter((item): item is typeof item & { value: bigint } => item.value !== null)
    .map(({ name, value, partial }) => ({ name: `${name} built`, value, ...(partial ? { partial: true } : {}) }));
  const extraMetrics: [string, (detail: Record<string, unknown>) => bigint | null][] = [
    ["Warships built", detail => record(detail.units) ? count(slot(detail.units.wshp, 0)) : null],
    ["Nukes launched", detail => {
      if (!record(detail.bombs)) return null;
      // Bomb records are sparse. mirvw are MIRV submunitions, not launches.
      let total = 0n;
      for (const key of ["abomb", "hbomb", "mirv"]) {
        if (detail.bombs[key] === undefined) continue;
        const value = count(slot(detail.bombs[key], 0));
        if (value === null) return null;
        total += value;
      }
      return total;
    }],
    ["Troops sent", detail => count(slot(detail.attacks, 0))],
    ["Trade gold earned", detail => count(slot(detail.gold, 2))],
  ];
  for (const [name, valueFrom] of extraMetrics) {
    const metric = aggregate(leaves.map(item => record(item.stats) ? valueFrom(item.stats) : null));
    if (metric.value !== null) summary.details.push({ name, value: metric.value, ...(metric.partial ? { partial: true } : {}) });
  }
  return summary;
}
