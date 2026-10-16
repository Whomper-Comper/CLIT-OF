import { decodeJwt } from "jose";
import { CONFIG } from "./config.js";

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
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      throw new OpenFrontApiError(timeout ? "timeout" : "network");
    }
  }
  private async json(response: Response): Promise<unknown> {
    if (!response.ok) throw new OpenFrontApiError("http", response.status);
    try { return await response.json(); }
    catch { throw new OpenFrontApiError(); }
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
