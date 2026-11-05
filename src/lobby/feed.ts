import {
  decodeLobbyMessage,
  SUPPORTED_BUILD,
  MAPS,
  MODES as GAME_MODES,
} from "./vendor/codec.js";
import { normalizeLobby, type Lobby, type LobbySnapshot } from "./model.js";
export { SUPPORTED_BUILD, MAPS };
export const MODES: string[] = [...GAME_MODES, "Humans Vs Nations"] as string[];
export const CATEGORIES = ["ffa", "team", "special", "hosted"];
export function decodeFrame(bytes: Uint8Array): any {
  if (bytes.length > 1_048_576) throw new Error("Lobby frame too large");
  return decodeLobbyMessage(bytes);
}
const compatible = (version: unknown) =>
  typeof version === "string" &&
  /^[a-f0-9]{7,40}$/i.test(version) &&
  SUPPORTED_BUILD.toLowerCase().startsWith(version.toLowerCase());
interface Options {
  now?: () => number;
  fetch?: typeof fetch;
  socket?: (url: string) => WebSocket;
  apiBase?: string;
  site?: string;
}
/** One shared broadcast connection. Unsupported deployments fail closed until the codec is updated. */
export class LobbyFeed {
  private current: LobbySnapshot | null = null;
  private readonly lobbyIndex = new Map<string, Lobby>();
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private generation = 0;
  private failures = 0;
  private connecting: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private readonly now: () => number;
  status = "Lobby feed has not connected yet.";
  constructor(private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
  }
  snapshot(): LobbySnapshot | null {
    return this.current && this.now() - this.current.observedAt < 30_000
      ? structuredClone(this.current)
      : null;
  }
  /** Fresh point lookup; normalized lobbies contain only scalar fields. */
  getLobby(source: string, id: string): Lobby | null {
    if (!this.current || this.now() - this.current.observedAt >= 30_000)
      return null;
    const lobby = this.lobbyIndex.get(JSON.stringify([source, id]));
    return lobby ? { ...lobby } : null;
  }
  accept(message: any, source: string): void {
    try {
      if (!message || !Number.isSafeInteger(message.serverTime))
        throw new Error("Invalid lobby frame");
      const now = this.now();
      if (message.type === "full") {
        this.current = null;
        this.lobbyIndex.clear();
        if (!compatible(message.gitCommit))
          throw new Error(
            "Unsupported OpenFront lobby build; regenerate the pinned codec.",
          );
        if (message.active === false)
          throw new Error("OpenFront lobby deployment is draining.");
        if (!message.games || typeof message.games !== "object")
          throw new Error("Invalid lobby list");
        const raw = Object.values(message.games).flat() as any[];
        if (
          raw.length > 2000 ||
          raw.some(
            (l) =>
              !l ||
              typeof l.gameID !== "string" ||
              !/^[a-zA-Z0-9_-]{1,100}$/.test(l.gameID) ||
              !CATEGORIES.includes(l.publicGameType) ||
              !Number.isSafeInteger(l.numClients) ||
              l.numClients < 0,
          )
        )
          throw new Error("Invalid lobby list");
        this.current = {
          observedAt: now,
          lobbies: raw.map((l) =>
            normalizeLobby(l, source, message.serverTime, now),
          ),
        };
      } else if (message.type === "counts") {
        if (!this.current) return;
        if (
          !message.counts ||
          Object.values(message.counts).some(
            (n) => !Number.isSafeInteger(n) || Number(n) < 0,
          )
        )
          throw new Error("Invalid lobby counts");
        this.current = {
          observedAt: now,
          lobbies: this.current.lobbies.map((l) => ({
            ...l,
            players: message.counts[l.id] ?? l.players,
          })),
        };
      } else throw new Error("Invalid lobby frame type");
      this.lobbyIndex.clear();
      for (const lobby of this.current.lobbies) {
        const key = JSON.stringify([lobby.source, lobby.id]);
        // Match Array.find's first-duplicate behavior used by delivery checks.
        if (!this.lobbyIndex.has(key)) this.lobbyIndex.set(key, lobby);
      }
      this.status = "Connected";
      this.failures = 0;
    } catch (e) {
      this.current = null;
      this.lobbyIndex.clear();
      throw e;
    }
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation++;
    this.launch();
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.current = null;
    this.lobbyIndex.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.ws?.close();
    this.ws = null;
    this.status = "Lobby feed stopped.";
  }
  private launch(): void {
    this.connecting = this.connect()
      .catch(() => {})
      .finally(() => {
        this.connecting = null;
      });
  }
  private schedule(error: unknown): void {
    this.current = null;
    this.lobbyIndex.clear();
    this.status =
      error instanceof Error
        ? error.message.slice(0, 180)
        : "Lobby feed unavailable.";
    const old = this.ws;
    this.ws = null;
    old?.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const delay = Math.min(60_000, 3000 * 2 ** Math.min(this.failures++, 5));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.launch();
    }, delay);
    this.timer.unref?.();
  }
  private async connect(): Promise<void> {
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation;
    try {
      const controller = new AbortController();
      this.controller = controller;
      const timer = setTimeout(() => controller.abort(), 8000);
      let list: any;
      try {
        const response = await (this.options.fetch ?? fetch)(
          `${this.options.apiBase ?? "https://api.openfront.io"}/cluster.json?site=${encodeURIComponent(this.options.site ?? "openfront.io")}`,
          { signal: controller.signal },
        );
        if (!current()) return;
        if (!response.ok)
          throw new Error(
            `OpenFront discovery unavailable (HTTP ${response.status}).`,
          );
        list = await response.json();
      } finally {
        clearTimeout(timer);
      }
      if (!current()) return;
      const servers = Object.values(list?.servers ?? {}) as any[];
      const supported = servers.filter(
        (s) => s?.state === "open" && compatible(s.version),
      );
      if (!supported.length)
        throw new Error(
          "No supported OpenFront lobby build is available; update the pinned codec.",
        );
      const server = supported.find(
        (s) =>
          Number.isSafeInteger(s.numWorkers) &&
          s.numWorkers >= 1 &&
          s.numWorkers <= 100 &&
          typeof s.host === "string" &&
          /^[a-z0-9.-]+\.openfront\.io$/.test(s.host),
      );
      if (!server)
        throw new Error("Invalid OpenFront discovery server.");
      const source = `https://${server.host}`;
      const ws = (this.options.socket ?? ((url) => new WebSocket(url)))(
        `wss://${server.host}/w0/lobbies?platform=web`,
      );
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      let received = this.now();
      const active = () => current() && this.ws === ws;
      ws.addEventListener("message", (event) => {
        if (!active()) return;
        try {
          if (!(event.data instanceof ArrayBuffer))
            throw new Error("Unsupported lobby frame");
          this.accept(decodeFrame(new Uint8Array(event.data)), source);
          received = this.now();
        } catch (e) {
          this.schedule(e);
        }
      });
      ws.addEventListener("error", () => {
        if (active())
          this.schedule(new Error("OpenFront lobby connection failed."));
      });
      ws.addEventListener("close", () => {
        if (active())
          this.schedule(new Error("OpenFront lobby connection closed."));
      });
      const check = () => {
        if (!active()) return;
        if (this.now() - received >= 30_000) {
          this.schedule(new Error("OpenFront lobby feed is stale."));
          return;
        }
        this.timer = setTimeout(() => {
          this.timer = null;
          check();
        }, 10_000);
        this.timer.unref?.();
      };
      check();
    } catch (e) {
      if (current()) this.schedule(e);
    }
  }
}
export const lobbyFeed = new LobbyFeed();
