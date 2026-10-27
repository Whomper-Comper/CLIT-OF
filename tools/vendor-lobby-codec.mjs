// Rebuild the standalone AGPL OpenFront lobby codec from a pinned official revision.
// Usage: node tools/vendor-lobby-codec.mjs [revision]. Requires esbuild (provided by tsx).
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const revision = process.argv[2] ?? "817c12927c4ec34ec68c74c780a74a14fb776d09";
if (!/^[a-f0-9]{40}$/.test(revision))
  throw new Error("Use a full upstream commit SHA");
const root = ".superpowers/lobby-codec";
await mkdir(root, { recursive: true });
const hashes = {};
async function source(path) {
  const response = await fetch(
    `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/${revision}/${path}`,
  );
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const text = await response.text();
  hashes[path] = createHash("sha256").update(text).digest("hex");
  return text;
}
for (const name of ["bytes", "context", "zb", "index"])
  await writeFile(
    `${root}/${name}.ts`,
    await source(`packages/zbin/src/${name}.ts`),
  );
const types = await source("packages/engine-api/src/game/GameTypes.ts");
const maps = await source("packages/engine-api/src/game/Maps.gen.ts");
const engine = await source("packages/engine-api/src/Schemas.ts");
const wire = await source("packages/shared/src/WireSchemas.ts");
const enums = [
  "Difficulty",
  "GameType",
  "GameMode",
  "RankedType",
  "GameMapSize",
  "UnitType",
]
  .map((name) => {
    const value = types.match(
      new RegExp(`export enum ${name} \\{[\\s\\S]*?\\n\\}`),
    );
    if (!value) throw new Error(name);
    return value[0];
  })
  .join("\n");
const mapEnum = maps.match(/export enum GameMapType \{[\s\S]*?\n\}/)?.[0];
if (!mapEnum) throw new Error("Map enum changed");
const config = engine.slice(
  engine.indexOf("const TEAM_COUNT_PRESETS"),
  engine.indexOf("// What a host sends in update_game_config."),
);
const lobby = wire.slice(
  wire.indexOf("export const PublicGameInfoSchema ="),
  wire.indexOf("export type PublicLobbyMessage ="),
);
const entry = `import { z } from 'zod';\nimport * as zb from './zb';\n${enums}\n${mapEnum}\nconst Duos='Duos',Trios='Trios',Quads='Quads',HumansVsNations='Humans Vs Nations';\nconst ID=z.string();\n${config}\nconst PublicGameTypeSchema=z.enum(['ffa','team','special','hosted']);\nconst LobbyLabelSchema=z.string().refine(v=>Array.from(v).length<=48);\nconst LobbyAccentSchema=z.enum(['gold','blue','green','red']);\n${lobby}\nexport const decodeLobbyMessage=bytes=>PublicLobbyMessageSchema.parseBytes(bytes);\nexport const encodeLobbyMessage=message=>PublicLobbyMessageSchema.serialize(message);\nexport const MAPS=Object.values(GameMapType);\nexport const MODES=Object.values(GameMode);\nexport const SUPPORTED_BUILD='${revision}';\n`;
await writeFile(`${root}/entry.ts`, entry);
const built = await build({
  entryPoints: [`${root}/entry.ts`],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["zod"],
  write: false,
  legalComments: "none",
});
const js = built.outputFiles[0].text;
await mkdir("src/lobby/vendor", { recursive: true });
await writeFile(
  "src/lobby/vendor/codec.ts",
  `// @ts-nocheck\n// Generated from OpenFrontIO ${revision}; AGPL-3.0. See NOTICE.md.\n${js}`,
);
await writeFile(`${root}/codec.mjs`, js);
const codec = await import(pathToFileURL(`${process.cwd()}/${root}/codec.mjs`));
const serverTime = 1800000000000;
const gameConfig = {
  gameMap: "World",
  difficulty: "Medium",
  donateGold: true,
  donateTroops: true,
  gameType: "Public",
  gameMode: "Team",
  gameMapSize: "Normal",
  nations: "default",
  bots: 0,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
  maxPlayers: 100,
};
const full = {
  type: "full",
  serverTime,
  gitCommit: revision,
  active: true,
  games: {
    team: [
      {
        gameID: "a1234567",
        numClients: 12,
        startsAt: serverTime + 60000,
        publicGameType: "team",
        gameConfig,
      },
    ],
  },
};
await mkdir("test/fixtures", { recursive: true });
await writeFile(
  "test/fixtures/lobby-wire.json",
  JSON.stringify(
    {
      revision,
      full: Buffer.from(codec.encodeLobbyMessage(full)).toString("base64"),
      counts: Buffer.from(
        codec.encodeLobbyMessage({
          type: "counts",
          serverTime,
          counts: { a1234567: 20 },
        }),
      ).toString("base64"),
    },
    null,
    2,
  ) + "\n",
);
await writeFile("src/lobby/vendor/LICENSE", await source("LICENSE"));
await writeFile(
  "src/lobby/vendor/NOTICE.md",
  `# OpenFront lobby codec\n\nGenerated from [OpenFrontIO ${revision}](https://github.com/openfrontio/OpenFrontIO/tree/${revision}), licensed AGPL-3.0 (LICENSE alongside this file). Original authors: OpenFrontIO contributors.\n\nThe generated codec contains upstream zbin and the exact ordered lobby/game configuration schemas. The generator extracts only the lobby schema and its dependencies; it does not change the wire layout. Zod is installed separately.\n\nRebuild: \`node tools/vendor-lobby-codec.mjs ${revision}\`. Builds require public GitHub access; runtime does not require a game checkout. Update the supported revision only alongside regenerated codec, binary fixtures and tests.\n\nSource SHA-256 digests:\n\n\`\`\`json\n${JSON.stringify(hashes, null, 2)}\n\`\`\`\n`,
);
console.log(`Generated pinned lobby codec ${revision} (${js.length} bytes)`);
