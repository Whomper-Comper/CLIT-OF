import { decodeJwt } from "jose";
import { CONFIG } from "./config.js";
import type {
  OpenFrontClanSession, OpenFrontClanSessionsPage, OpenFrontClanSessionsQuery, OpenFrontDeletedPlayer,
  OpenFrontPlayerGame, OpenFrontPlayerGamesPage, OpenFrontPlayerGamesQuery,
  OpenFrontPlayerSession, OpenFrontPlayerSessionsPage, OpenFrontPlayerSessionsQuery,
  OpenFrontPlayerLadder, OpenFrontPlayerRatings, OpenFrontRankedLeaderboardPage,
} from "./historyTypes.js";
export type * from "./historyTypes.js";

export interface OpenFrontDiscordUser {
  id: string; username: string; discriminator?: string; avatar?: string | null; global_name?: string | null;
}
export interface OpenFrontClanMembership {
  tag: string; name: string; role: "leader" | "officer" | "member"; joinedAt: string; memberCount?: number;
}
export interface OpenFrontPlayerProfile {
  createdAt: string; user?: OpenFrontDiscordUser; username?: string | null; clans?: OpenFrontClanMembership[];
  /** Kept as received: older responses can omit statistics or return null. */
  stats?: unknown;
}
export interface OpenFrontClanInfo {
  name: string; tag: string; description: string; memberCount?: number; isOpen?: boolean;
}
export class OpenFrontApiError extends Error {
  constructor(public reason: "timeout" | "network" | "http" | "invalid_response" = "invalid_response", public status?: number) {
    super("OpenFront is temporarily unavailable or returned an invalid response. Please try again later.");
  }
}
const object = (data: unknown): data is Record<string, unknown> => typeof data === "object" && data !== null && !Array.isArray(data);
const nonnegativeInteger = (data: unknown): data is number => typeof data === "number" && Number.isSafeInteger(data) && data >= 0;
const isTimeout = (error: unknown): boolean => error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
const timestamp = (data: unknown): data is string => typeof data === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data) && Number.isFinite(Date.parse(data));
const nullableString = (data: unknown): data is string | null => data === null || typeof data === "string";
const modeFilters = new Set(["ffa", "team", "hvn", "ranked"]);
const typeFilters = new Set(["public", "private", "singleplayer"]);

function historyQuery(query: OpenFrontPlayerGamesQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.filter !== undefined) {
    if (!modeFilters.has(query.filter)) throw new RangeError("Unsupported player history filter.");
    params.set("filter", query.filter);
  }
  if (query.type !== undefined) {
    if (!typeFilters.has(query.type)) throw new RangeError("Unsupported player history game type.");
    params.set("type", query.type);
  }
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || !query.cursor) throw new RangeError("History cursor must be a nonempty opaque token.");
    params.set("cursor", query.cursor);
  }
  return params;
}

function dateBound(params: URLSearchParams, key: "start" | "end", value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!timestamp(value)) throw new RangeError(`History ${key} must be an ISO timestamp.`);
  const ms = Date.parse(value);
  params.set(key, new Date(ms).toISOString());
  return ms;
}

function validPlayerGame(data: unknown): data is OpenFrontPlayerGame {
  return object(data) && typeof data.gameId === "string" && !!data.gameId && timestamp(data.start) &&
    nonnegativeInteger(data.durationSeconds) && typeof data.map === "string" && typeof data.mode === "string" &&
    typeof data.type === "string" && nullableString(data.playerTeams) && typeof data.rankedType === "string" &&
    ["victory", "defeat", "incomplete"].includes(String(data.result)) &&
    (data.totalPlayers === null || nonnegativeInteger(data.totalPlayers)) && typeof data.username === "string" && nullableString(data.clanTag);
}

function validPlayerSession(data: unknown): data is OpenFrontPlayerSession {
  return object(data) && typeof data.gameId === "string" && !!data.gameId && timestamp(data.gameStart) &&
    (data.gameEnd === null || timestamp(data.gameEnd)) && typeof data.gameType === "string" && typeof data.gameMode === "string" &&
    typeof data.gameRankedType === "string" && typeof data.clientId === "string" && typeof data.username === "string" &&
    nullableString(data.clanTag) && typeof data.hasWon === "boolean";
}

function validClanSession(data: unknown): data is OpenFrontClanSession {
  return object(data) && typeof data.gameId === "string" && !!data.gameId && typeof data.clanTag === "string" &&
    nonnegativeInteger(data.clanPlayerCount) && typeof data.hasWon === "boolean" && nonnegativeInteger(data.numTeams) &&
    nullableString(data.playerTeams) && nonnegativeInteger(data.totalPlayerCount) && timestamp(data.gameStart) &&
    typeof data.score === "number" && Number.isFinite(data.score);
}
export interface PublicReadOptions { fresh?: boolean }
interface CacheEntry { expires: number; value: unknown }
interface ApiOptions { cacheTtlMs?: number; maxCacheEntries?: number; now?: () => number }

export class OpenFrontApi {
  private base: string;
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<unknown>>();
  private generations = new Map<string, number>();
  private generation = 0;
  private cacheTtlMs: number;
  private maxCacheEntries: number;
  private now: () => number;
  constructor(baseUrl = CONFIG.OPENFRONT_API_BASE, options: ApiOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 15_000);
    this.maxCacheEntries = Math.max(0, options.maxCacheEntries ?? 500);
    this.now = options.now ?? Date.now;
  }

  /** Public reads share in-flight work and short-lived results. Verification must use fresh. */
  private async publicRead<T>(key: string, load: () => Promise<T>, options: PublicReadOptions): Promise<T> {
    const now = this.now();
    for (const [id, entry] of this.cache) if (entry.expires <= now) this.cache.delete(id);
    if (!options.fresh) {
      const cached = this.cache.get(key);
      if (cached) return structuredClone(cached.value as T);
      const pending = this.pending.get(key);
      if (pending) return structuredClone(await pending as T);
    } else {
      // A previous slow cached read must not replace a newer verification result.
      this.cache.delete(key);
    }
    const generation = ++this.generation;
    this.generations.set(key, generation);
    const task = load().then((value) => {
      if (this.generations.get(key) === generation && this.cacheTtlMs && this.maxCacheEntries) {
        while (this.cache.size >= this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { value: structuredClone(value), expires: this.now() + this.cacheTtlMs });
      }
      return value;
    });
    this.pending.set(key, task);
    try { return structuredClone(await task); }
    finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
      if (this.generations.get(key) === generation) this.generations.delete(key);
    }
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.base}${endpoint}`, { ...options,
        headers: { Accept: "application/json", ...options.headers }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new OpenFrontApiError(isTimeout(error) ? "timeout" : "network");
    }
  }
  private async json(response: Response): Promise<unknown> {
    if (!response.ok) throw new OpenFrontApiError("http", response.status);
    try { return await response.json(); }
    catch (error) { throw new OpenFrontApiError(isTimeout(error) ? "timeout" : "invalid_response"); }
  }

  async getPlayerProfile(publicId: string, options: PublicReadOptions = {}): Promise<OpenFrontPlayerProfile | null> {
    const endpoint = `/public/player/${encodeURIComponent(publicId.trim())}`;
    return this.publicRead(endpoint, () => this.loadPlayerProfile(endpoint), options);
  }

  private async loadPlayerProfile(endpoint: string): Promise<OpenFrontPlayerProfile | null> {
    const response = await this.request(endpoint);
    if (response.status === 404) return null;
    const data = await this.json(response);
    if (!object(data) || (data.username !== undefined && data.username !== null && typeof data.username !== "string")) throw new OpenFrontApiError();
    if (data.user !== undefined && (!object(data.user) || typeof data.user.id !== "string")) throw new OpenFrontApiError();
    if (data.clans !== undefined && (!Array.isArray(data.clans) || data.clans.some((clan: unknown) =>
      !object(clan) || typeof clan.tag !== "string" || typeof clan.name !== "string" || !["leader", "officer", "member"].includes(String(clan.role))))) throw new OpenFrontApiError();
    return data as unknown as OpenFrontPlayerProfile;
  }

  async getClanInfo(tag: string, options: PublicReadOptions = {}): Promise<OpenFrontClanInfo | null> {
    const endpoint = `/public/clan/${encodeURIComponent(tag.trim().toUpperCase())}`;
    return this.publicRead(endpoint, () => this.loadClanInfo(endpoint), options);
  }

  private async loadClanInfo(endpoint: string): Promise<OpenFrontClanInfo | null> {
    const response = await this.request(endpoint);
    if (response.status === 404) return null;
    const data = await this.json(response);
    if (!object(data) || typeof data.name !== "string" || typeof data.tag !== "string" || typeof data.description !== "string" ||
      (data.memberCount !== undefined && (typeof data.memberCount !== "number" || !Number.isSafeInteger(data.memberCount) || data.memberCount < 0))) throw new OpenFrontApiError();
    return data as unknown as OpenFrontClanInfo;
  }

  async getPlayerGames(publicId: string, query: OpenFrontPlayerGamesQuery = {}, options: PublicReadOptions = {}): Promise<OpenFrontPlayerGamesPage | null> {
    const params = historyQuery(query);
    const endpoint = `/public/player/${encodeURIComponent(publicId.trim())}/games${params.size ? `?${params}` : ""}`;
    return this.publicRead(endpoint, () => this.loadCursorPage(endpoint, validPlayerGame, (row) => ({
      ...row, start: new Date(row.start).toISOString(),
    })), options);
  }

  /** Source: OpenFront's client fetchPlayerLeaderboard and RankedLeaderboardResponseSchema. */
  async getRankedLeaderboardPage(page = 1, options: PublicReadOptions = {}): Promise<OpenFrontRankedLeaderboardPage> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw new RangeError("Leaderboard page must be 1–200.");
    const endpoint = `/leaderboard/ranked?page=${page}`;
    return this.publicRead(endpoint, async () => {
      const response = await this.request(endpoint);
      if (response.status === 400) {
        const data = await this.jsonForPageBounds(response);
        if (data) return { ratings: [], hasMore: false, observedAt: new Date(this.now()).toISOString() };
      }
      const data = await this.json(response);
      if (!object(data) || !Array.isArray(data["1v1"])) throw new OpenFrontApiError();
      const ratings: OpenFrontRankedLeaderboardPage["ratings"] = [];
      let hasMore = false;
      for (const ladder of ["1v1", "2v2", "ffa"] as const) {
        // Older official APIs omit newer ladders, as the upstream schema permits.
        const rows = data[ladder] ?? [];
        if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !object(row) ||
          typeof row.public_id !== "string" || !/^[A-Za-z0-9_-]{1,22}$/.test(row.public_id) ||
          typeof row.elo !== "number" || !Number.isFinite(row.elo) ||
          typeof row.rank !== "number" || !Number.isSafeInteger(row.rank) || row.rank < 1)) throw new OpenFrontApiError();
        // The public client loads 50 entries per ladder/page. A full ladder
        // may have another page; an empty next page safely terminates it.
        hasMore ||= rows.length >= 50;
        for (const row of rows) ratings.push({ publicId: row.public_id, ladder, rating: row.elo, rank: row.rank });
      }
      return { ratings, hasMore, observedAt: new Date(this.now()).toISOString() };
    }, options);
  }

  private async jsonForPageBounds(response: Response): Promise<boolean> {
    let data: unknown;
    try { data = await response.clone().json(); } catch { return false; }
    return object(data) && typeof data.message === "string" && /^Page must be between \d+ and \d+$/.test(data.message);
  }

  /** Exact public-ID matches only. A missing bounded-search result is not zero Elo. */
  async getPlayerRatings(publicId: string, options: { maxPages?: number; fresh?: boolean } = {}): Promise<OpenFrontPlayerRatings> {
    const id = publicId.trim();
    if (!/^[A-Za-z0-9_-]{1,22}$/.test(id)) throw new RangeError("Invalid OpenFront player ID.");
    const maxPages = options.maxPages ?? 3;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new RangeError("Player rating scan must use 1–5 pages.");
    const found = new Map<OpenFrontPlayerLadder, OpenFrontPlayerRatings["ratings"][number]>();
    let complete = false, pages = 0, observedAt = new Date(this.now()).toISOString();
    const started = Date.now();
    for (let page = 1; page <= maxPages; page++) {
      if (page > 1 && Date.now() - started >= 10_000) break;
      let response: OpenFrontRankedLeaderboardPage;
      try { response = await this.getRankedLeaderboardPage(page, { fresh: options.fresh }); }
      catch (error) { if (!pages) throw error; break; }
      pages++;
      observedAt = response.observedAt;
      for (const row of response.ratings) if (row.publicId === id && !found.has(row.ladder)) found.set(row.ladder, { ...row, observedAt: response.observedAt });
      if (!response.hasMore || found.size === 3) { complete = true; break; }
    }
    return { ratings: [...found.values()], complete, pages, observedAt };
  }

  async getPlayerSessions(publicId: string, query: OpenFrontPlayerSessionsQuery = {}, options: PublicReadOptions = {}): Promise<OpenFrontPlayerSessionsPage | null> {
    const params = historyQuery(query);
    const start = dateBound(params, "start", query.start), end = dateBound(params, "end", query.end);
    if (start !== undefined && end !== undefined && start >= end) throw new RangeError("History start must be before end.");
    const endpoint = `/public/player/${encodeURIComponent(publicId.trim())}/sessions${params.size ? `?${params}` : ""}`;
    return this.publicRead(endpoint, () => this.loadCursorPage(endpoint, validPlayerSession, (row) => ({
      ...row, gameStart: new Date(row.gameStart).toISOString(), gameEnd: row.gameEnd === null ? null : new Date(row.gameEnd).toISOString(),
    })), options);
  }

  private async loadCursorPage<T>(endpoint: string, validate: (value: unknown) => value is T, normalize: (value: T) => T): Promise<{ results: T[]; nextCursor: string | null } | null> {
    const response = await this.request(endpoint);
    if (response.status === 404) return null;
    const data = await this.json(response);
    if (!object(data) || !Array.isArray(data.results) || data.results.length > 100 || data.results.some((row) => !validate(row)) ||
      !nullableString(data.nextCursor) || data.nextCursor === "") throw new OpenFrontApiError();
    return { results: (data.results as T[]).map(normalize), nextCursor: data.nextCursor };
  }

  async getClanSessions(tag: string, query: OpenFrontClanSessionsQuery, options: PublicReadOptions = {}): Promise<OpenFrontClanSessionsPage | null> {
    const params = new URLSearchParams();
    const start = dateBound(params, "start", query.start), end = dateBound(params, "end", query.end);
    if (start === undefined || end === undefined || start >= end || end - start > 86_400_000) {
      throw new RangeError("Public clan history requires start/end bounds no more than one day apart.");
    }
    const page = query.page ?? 1, limit = query.limit ?? 20;
    if (!Number.isSafeInteger(page) || page < 1 || page > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError("Clan history page must be 1–200 and limit must be 1–50.");
    }
    params.set("page", String(page));
    params.set("limit", String(limit));
    const endpoint = `/public/clan/${encodeURIComponent(tag.trim().toUpperCase())}/sessions?${params}`;
    return this.publicRead(endpoint, async () => {
      const response = await this.request(endpoint);
      if (response.status === 404) return null;
      const data = await this.json(response);
      if (!object(data) || !Array.isArray(data.results) || data.results.length > limit || data.results.some((row) => !validClanSession(row)) ||
        !nonnegativeInteger(data.total) || data.page !== page || data.limit !== limit) throw new OpenFrontApiError();
      return { results: (data.results as OpenFrontClanSession[]).map((row) => ({ ...row, gameStart: new Date(row.gameStart).toISOString() })), total: data.total, page, limit };
    }, options);
  }

  /** Poll daily when retaining player history; the API exposes only the last seven days of deletions. */
  async getRecentlyDeletedPlayers(since?: string, options: PublicReadOptions = {}): Promise<OpenFrontDeletedPlayer[]> {
    const params = new URLSearchParams();
    if (since !== undefined) {
      if (!timestamp(since)) throw new RangeError("Deletion sync requires an ISO timestamp.");
      params.set("since", new Date(Date.parse(since)).toISOString());
    }
    const endpoint = `/public/players/recently-deleted${params.size ? `?${params}` : ""}`;
    return this.publicRead(endpoint, async () => {
      const data = await this.json(await this.request(endpoint));
      if (!Array.isArray(data) || data.length > 100_000 || data.some((row) => !object(row) || typeof row.publicId !== "string" || !row.publicId || !timestamp(row.deletedAt))) throw new OpenFrontApiError();
      return (data as OpenFrontDeletedPlayer[]).map((row) => ({ ...row, deletedAt: new Date(row.deletedAt).toISOString() }));
    }, options);
  }

  async verifyIdentityToken(token: string): Promise<string | null> {
    const trimmed = token.trim();
    let audience: string | undefined;
    try {
      const claims = decodeJwt(trimmed);
      audience = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    } catch { return null; }
    for (const aud of new Set([audience || "ofstats.io", "ofstats.io", "trackerfront.io"])) {
      const response = await this.request("/public/identity_token/validate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: trimmed, audience: aud }),
      });
      if ([400, 401, 403].includes(response.status)) continue;
      const data = await this.json(response);
      if (!object(data) || typeof data.publicId !== "string" || !/^[A-Za-z0-9_-]{1,22}$/.test(data.publicId)) throw new OpenFrontApiError();
      return data.publicId;
    }
    return null;
  }
}
export const openfrontApi = new OpenFrontApi();
