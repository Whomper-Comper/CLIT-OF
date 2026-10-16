/** Public history models. These do not use the authenticated clan roster/game API. */
export type OpenFrontHistoryFilter = "ffa" | "team" | "hvn" | "ranked";
export type OpenFrontHistoryGameType = "public" | "private" | "singleplayer";
export type OpenFrontGameResult = "victory" | "defeat" | "incomplete";

export interface OpenFrontPlayerGame {
  gameId: string;
  start: string;
  durationSeconds: number;
  map: string;
  mode: string;
  type: string;
  playerTeams: string | null;
  rankedType: string;
  result: OpenFrontGameResult;
  totalPlayers: number | null;
  /** The identity recorded in this match, which can differ from the current profile. */
  username: string;
  clanTag: string | null;
}

export interface OpenFrontPlayerGamesQuery {
  filter?: OpenFrontHistoryFilter;
  type?: OpenFrontHistoryGameType;
  /** Opaque API token: preserve verbatim and keep the other filters unchanged. */
  cursor?: string;
}

export interface OpenFrontPlayerGamesPage {
  results: OpenFrontPlayerGame[];
  nextCursor: string | null;
}

export interface OpenFrontPlayerSession {
  gameId: string;
  gameStart: string;
  gameEnd: string | null;
  gameType: string;
  gameMode: string;
  gameRankedType: string;
  clientId: string;
  username: string;
  clanTag: string | null;
  hasWon: boolean;
}

export interface OpenFrontPlayerSessionsQuery extends OpenFrontPlayerGamesQuery {
  start?: string;
  end?: string;
}

export interface OpenFrontPlayerSessionsPage {
  results: OpenFrontPlayerSession[];
  nextCursor: string | null;
}

/** Public clan sessions describe a tagged team appearance, not an identified roster. */
export interface OpenFrontClanSession {
  gameId: string;
  clanTag: string;
  clanPlayerCount: number;
  hasWon: boolean;
  numTeams: number;
  playerTeams: string | null;
  totalPlayerCount: number;
  gameStart: string;
  /** API contribution score; losses can be negative. */
  score: number;
}

export interface OpenFrontClanSessionsQuery {
  /** The deployed public API requires both bounds and at most one day per request. */
  start: string;
  end: string;
  page?: number;
  limit?: number;
}

export interface OpenFrontClanSessionsPage {
  results: OpenFrontClanSession[];
  total: number;
  page: number;
  limit: number;
}

export interface OpenFrontDeletedPlayer {
  publicId: string;
  deletedAt: string;
}

/** Player ladders are independent; clan-wars Elo belongs to the clan. */
export type OpenFrontPlayerLadder = "1v1" | "2v2" | "ffa";
export interface OpenFrontPlayerRating {
  publicId: string;
  ladder: OpenFrontPlayerLadder;
  rating: number;
  rank: number | null;
  /** Preserves the fetch time when a player lookup combines cached pages. */
  observedAt?: string;
}
export interface OpenFrontRankedLeaderboardPage {
  ratings: OpenFrontPlayerRating[];
  hasMore: boolean;
  /** When this API response was read, rather than an inferred match date. */
  observedAt: string;
}
export interface OpenFrontPlayerRatings {
  ratings: OpenFrontPlayerRating[];
  /** False when the bounded leaderboard scan could have missed another ladder. */
  complete: boolean;
  pages: number;
  observedAt: string;
}
