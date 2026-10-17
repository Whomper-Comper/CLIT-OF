import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { HistoryStore } from "../dist/historyStore.js";

// Run after npm run build: node tools/benchmark-history.mjs
// Compare the previous row-at-a-time algorithm with production page batching.
// Both paths use today's schema/indexes and identical rows, isolating batching.
// This measures local disk writes, not Discord/API latency or whole-bot throughput.
const root = resolve(".deploy");
mkdirSync(root, { recursive: true });
const folder = mkdtempSync(join(root, "history-benchmark-"));
const pages = 20, pageSize = 50, rounds = 3;
const at = "2026-10-16T12:00:00.000Z";
const samples = { clan: { before: [], after: [] }, player: { before: [], after: [] } };
try {
  for (let round = 0; round < rounds; round++) {
    for (const kind of ["clan", "player"]) {
      for (const mode of round % 2 ? ["after", "before"] : ["before", "after"]) {
        const raw = new DatabaseSync(join(folder, `${round}-${kind}-${mode}.db`));
        try {
          raw.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
          HistoryStore.initialize(raw);
          const history = new HistoryStore(raw);
          const rows = Array.from({ length: pages }, (_, p) => Array.from({ length: pageSize }, (_, i) => kind === "clan"
            ? { gameId: `${p}-${i}`, clanTag: "MARS", gameStart: at, clanPlayerCount: 2, hasWon: true, numTeams: 2, playerTeams: "2", totalPlayerCount: 20, score: 1 }
            : { gameId: `${p}-${i}`, gameStart: at, gameEnd: at, gameType: "Public", gameMode: "Team", gameRankedType: "Unranked", clientId: "client", username: "Player", clanTag: "MARS", hasWon: true }));
          const started = performance.now();
          for (const page of rows) {
            if (mode === "after") {
              if (kind === "clan") history.upsertClanMatches("g", "MARS", page);
              else history.upsertPlayerMatches("g", "public", "discord", page);
            } else if (kind === "clan") {
              const statement = raw.prepare(`INSERT INTO history_clan_matches(guild_id,clan_tag,game_id,game_start,payload) VALUES(?,?,?,?,?)
                ON CONFLICT(guild_id,clan_tag,game_id) DO UPDATE SET game_start=excluded.game_start,payload=excluded.payload`);
              for (const match of page) if (match.clanTag.trim().toUpperCase() === "MARS")
                statement.run("g", "MARS", match.gameId, new Date(Date.parse(match.gameStart)).toISOString(), JSON.stringify(match));
            } else {
              if (history.isDeleted("public")) continue;
              const statement = raw.prepare(`INSERT INTO history_player_matches(guild_id,public_id,discord_id,game_id,game_start,payload) VALUES(?,?,?,?,?,?)
                ON CONFLICT(guild_id,public_id,game_id) DO UPDATE SET discord_id=excluded.discord_id,game_start=excluded.game_start,payload=excluded.payload`);
              for (const match of page)
                statement.run("g", "public", "discord", match.gameId, new Date(Date.parse(match.gameStart)).toISOString(), JSON.stringify(match));
            }
          }
          samples[kind][mode].push(Number((performance.now() - started).toFixed(2)));
          const table = kind === "clan" ? "history_clan_matches" : "history_player_matches";
          if (Number(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get().n) !== pages * pageSize) throw new Error("Missing benchmark rows");
        } finally { raw.close(); }
      }
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const comparison = Object.fromEntries(Object.entries(samples).map(([kind, values]) => {
    const beforeMs = median(values.before), afterMs = median(values.after);
    return [kind, { beforeMs, afterMs, speedup: Number((beforeMs / afterMs).toFixed(2)),
      timeReductionPercent: Number((100 * (1 - afterMs / beforeMs)).toFixed(2)) }];
  }));
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    pages, pageSize, rounds, journal: "DELETE", synchronous: "FULL", milliseconds: samples, comparison }, null, 2));
} finally {
  if (!folder.startsWith(root + "\\") && !folder.startsWith(root + "/")) throw new Error("Unexpected benchmark directory");
  rmSync(folder, { recursive: true, force: true });
}
