import type { OpenFrontApi } from "./api.js";
import type { OpenFrontHistoryGameType, OpenFrontPlayerGame } from "./historyTypes.js";

export type AnalyticsMode = "all" | "ffa" | "team" | "hvn" | "ranked";
export type AnalyticsPeriod = "all" | "24h" | "7d" | "30d" | "90d" | "365d";
export type AnalyticsScope = "all" | OpenFrontHistoryGameType;
export interface AnalyticsSelection {
  mode: AnalyticsMode;
  scope: AnalyticsScope;
  period: AnalyticsPeriod;
  map?: string;
}
export interface AnalyticsOptions extends AnalyticsSelection {
  now?: number;
  /** Each public API page contains at most 100 matches. */
  maxPages?: number;
  maxDurationMs?: number;
}
export interface MatchAnalysis {
  total: number;
  wins: number;
  losses: number;
  incomplete: number;
  completed: number;
  /** Win rate excludes games whose result is still incomplete. */
  winRate: string;
  averageDurationSeconds: number | null;
}
export interface PlayerAnalytics extends MatchAnalysis {
  games: OpenFrontPlayerGame[];
  maps: (MatchAnalysis & { map: string })[];
  selection: AnalyticsSelection;
  start: string | null;
  end: string;
  coverage: {
    /** Complete means all available API history for this selection was scanned, not all lifetime account games. */
    complete: boolean;
    reason: "exhausted" | "period_boundary" | "page_limit" | "cursor_loop" | "time_limit" | "api_error";
    pages: number;
    scanned: number;
    oldest: string | null;
    newest: string | null;
  };
}

const periods: Record<Exclude<AnalyticsPeriod, "all">, number> = {
  "24h": 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365,
};
const modes = new Set<AnalyticsMode>(["all", "ffa", "team", "hvn", "ranked"]);
const scopes = new Set<AnalyticsScope>(["all", "public", "private", "singleplayer"]);

export function analyticsPeriodStart(period: AnalyticsPeriod, now = Date.now()): string | null {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Invalid analytics time.");
  if (period === "all") return null;
  if (!(period in periods)) throw new RangeError("Unsupported statistics period.");
  return new Date(Math.max(0, now - periods[period] * 86_400_000)).toISOString();
}

/** Map IDs and display names can differ only in spaces, separators or case. */
export function normalizeMapName(map: string): string {
  return map.normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, "");
}

function matchesMode(game: OpenFrontPlayerGame, mode: AnalyticsMode): boolean {
  const ranked = Boolean(game.rankedType) && game.rankedType.toLowerCase() !== "unranked";
  if (mode === "all") return true;
  if (mode === "ranked") return ranked;
  if (ranked) return false;
  return game.mode === (mode === "ffa" ? "Free For All" : mode === "team" ? "Team" : "Humans Vs Nations");
}

function analyze(games: OpenFrontPlayerGame[]): MatchAnalysis {
  const wins = games.filter(game => game.result === "victory").length;
  const losses = games.filter(game => game.result === "defeat").length;
  const completed = wins + losses;
  const duration = games.reduce((sum, game) => sum + (game.result === "incomplete" ? 0 : game.durationSeconds), 0);
  return { total: games.length, wins, losses, incomplete: games.length - completed, completed,
    winRate: completed ? `${(100 * wins / completed).toFixed(1)}%` : "—",
    averageDurationSeconds: completed ? duration / completed : null };
}

/**
 * Analyze exact public-ID game history. Lifetime profile counters are never mixed
 * with a period or map sample, and the scan always has a page and time budget.
 */
export async function loadPlayerAnalytics(
  api: Pick<OpenFrontApi, "getPlayerGames">,
  publicId: string,
  options: AnalyticsOptions,
): Promise<PlayerAnalytics | null> {
  const { mode, scope, period } = options;
  if (!modes.has(mode) || !scopes.has(scope)) throw new RangeError("Unsupported statistics filter.");
  const now = options.now ?? Date.now();
  const start = analyticsPeriodStart(period, now);
  const end = new Date(now).toISOString();
  const cutoff = start === null ? 0 : Date.parse(start);
  const map = options.map?.trim();
  if (map && (map.length > 100 || !normalizeMapName(map))) throw new RangeError("Enter a map name of up to 100 characters.");
  const mapKey = map ? normalizeMapName(map) : null;
  const maxPages = options.maxPages ?? 10;
  const maxDuration = options.maxDurationMs ?? 10_000;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 ||
      !Number.isInteger(maxDuration) || maxDuration < 1 || maxDuration > 60_000) throw new RangeError("Invalid statistics scan budget.");
  const started = Date.now();
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const seen = new Set<string>();
  const games: OpenFrontPlayerGame[] = [];
  const coverage: PlayerAnalytics["coverage"] = {
    complete: false, reason: "page_limit", pages: 0, scanned: 0, oldest: null, newest: null,
  };
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && Date.now() - started >= maxDuration) { coverage.reason = "time_limit"; break; }
    let response;
    try {
      response = await api.getPlayerGames(publicId, {
        ...(mode === "all" ? {} : { filter: mode }), ...(scope === "all" ? {} : { type: scope }),
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (coverage.pages === 0) throw error;
      coverage.reason = "api_error";
      break;
    }
    if (!response) return null;
    coverage.pages++;
    let crossedBoundary = false;
    for (const game of response.results) {
      if (seen.has(game.gameId)) continue;
      seen.add(game.gameId);
      coverage.scanned++;
      if (coverage.oldest === null || game.start < coverage.oldest) coverage.oldest = game.start;
      if (coverage.newest === null || game.start > coverage.newest) coverage.newest = game.start;
      const at = Date.parse(game.start);
      if (at < cutoff) { crossedBoundary = true; continue; }
      if (at > now || !matchesMode(game, mode) ||
          (scope !== "all" && game.type.toLowerCase() !== scope) ||
          (mapKey !== null && normalizeMapName(game.map) !== mapKey)) continue;
      games.push(game);
    }
    if (!response.nextCursor) { coverage.complete = true; coverage.reason = "exhausted"; break; }
    // The official endpoint is ordered newest first; older pages cannot add to this time period.
    if (crossedBoundary && start !== null) { coverage.complete = true; coverage.reason = "period_boundary"; break; }
    if (cursors.has(response.nextCursor)) { coverage.reason = "cursor_loop"; break; }
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  games.sort((a, b) => b.start.localeCompare(a.start) || a.gameId.localeCompare(b.gameId));
  const perMap = new Map<string, { map: string; games: OpenFrontPlayerGame[] }>();
  for (const game of games) {
    const key = normalizeMapName(game.map);
    const item = perMap.get(key) ?? { map: game.map, games: [] };
    item.games.push(game);
    perMap.set(key, item);
  }
  return { ...analyze(games), games, selection: { mode, scope, period, ...(map ? { map } : {}) },
    start, end, coverage,
    maps: [...perMap.values()].map(item => ({ map: item.map, ...analyze(item.games) }))
      .sort((a, b) => b.total - a.total || a.map.localeCompare(b.map)) };
}
