export interface Rule {
  id?: string;
  name?: string;
  map?: string;
  mode?: string;
  category?: string;
  min?: number;
  max?: number;
}
export interface Lobby {
  source: string;
  id: string;
  map: string | null;
  mode: string | null;
  category: string;
  players: number;
  capacity: number | null;
  startsAt: number | null;
  restricted: boolean;
}
export interface LobbySnapshot {
  observedAt: number;
  lobbies: Lobby[];
}
export const normalize = (s: string): string => s.trim().toLowerCase();
export function normalizeLobby(
  raw: any,
  source: string,
  serverTime: number,
  now: number,
): Lobby {
  const config = raw.gameConfig;
  const deadline =
    raw.startsAt ??
    (raw.publicGameType === "hosted" ? raw.autoStartAt : undefined);
  return {
    source,
    id: raw.gameID,
    map: typeof config?.gameMap === "string" ? config.gameMap : null,
    mode:
      typeof config?.playerTeams === "string" &&
      config.playerTeams === "Humans Vs Nations"
        ? "Humans Vs Nations"
        : typeof config?.gameMode === "string"
          ? config.gameMode
          : null,
    category: raw.publicGameType,
    players: raw.numClients,
    capacity:
      Number.isSafeInteger(config?.maxPlayers) && config.maxPlayers > 0
        ? config.maxPlayers
        : null,
    startsAt: Number.isSafeInteger(deadline)
      ? now + deadline - serverTime
      : null,
    restricted:
      config?.trusted === true || (config?.allowedPublicIds?.length ?? 0) > 0,
  };
}
export function matches(rule: Rule, lobby: Lobby, now: number): boolean {
  if (
    lobby.restricted ||
    lobby.capacity === null ||
    lobby.players >= lobby.capacity ||
    lobby.startsAt === null ||
    lobby.startsAt <= now
  )
    return false;
  return (
    (!rule.map ||
      (lobby.map !== null && normalize(rule.map) === normalize(lobby.map))) &&
    (!rule.mode ||
      (lobby.mode !== null &&
        normalize(rule.mode) === normalize(lobby.mode))) &&
    (!rule.category ||
      normalize(rule.category) === normalize(lobby.category)) &&
    (rule.min === undefined || lobby.players >= rule.min) &&
    (rule.max === undefined || lobby.players <= rule.max)
  );
}
