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
}
export interface OpenFrontClanInfo {
  name: string; tag: string; description: string; memberCount?: number; isOpen?: boolean;
}
export class OpenFrontApiError extends Error {
  constructor() { super("OpenFront is temporarily unavailable or returned an invalid response. Please try again later."); }
}
const object = (data: unknown): data is Record<string, unknown> => typeof data === "object" && data !== null;

export class OpenFrontApi {
  private base: string;
  constructor(baseUrl = CONFIG.OPENFRONT_API_BASE) { this.base = baseUrl.replace(/\/+$/, ""); }

  private async request(endpoint: string, options: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.base}${endpoint}`, { ...options,
        headers: { Accept: "application/json", ...options.headers }, signal: AbortSignal.timeout(15_000) });
    } catch { throw new OpenFrontApiError(); }
  }
  private async json(response: Response): Promise<unknown> {
    if (!response.ok) throw new OpenFrontApiError();
    try { return await response.json(); }
    catch { throw new OpenFrontApiError(); }
  }

  async getPlayerProfile(publicId: string): Promise<OpenFrontPlayerProfile | null> {
    const response = await this.request(`/public/player/${encodeURIComponent(publicId.trim())}`);
    if (response.status === 404) return null;
    const data = await this.json(response);
    if (!object(data) || (data.username !== undefined && data.username !== null && typeof data.username !== "string")) throw new OpenFrontApiError();
    if (data.user !== undefined && (!object(data.user) || typeof data.user.id !== "string")) throw new OpenFrontApiError();
    if (data.clans !== undefined && (!Array.isArray(data.clans) || data.clans.some((clan: unknown) =>
      !object(clan) || typeof clan.tag !== "string" || typeof clan.name !== "string" || !["leader", "officer", "member"].includes(String(clan.role))))) throw new OpenFrontApiError();
    return data as unknown as OpenFrontPlayerProfile;
  }

  async getClanInfo(tag: string): Promise<OpenFrontClanInfo | null> {
    const response = await this.request(`/public/clan/${encodeURIComponent(tag.trim().toUpperCase())}`);
    if (response.status === 404) return null;
    const data = await this.json(response);
    if (!object(data) || typeof data.name !== "string" || typeof data.tag !== "string" || typeof data.description !== "string") throw new OpenFrontApiError();
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
