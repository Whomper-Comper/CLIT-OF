# OpenFront lobby codec

Generated from [OpenFrontIO 817c12927c4ec34ec68c74c780a74a14fb776d09](https://github.com/openfrontio/OpenFrontIO/tree/817c12927c4ec34ec68c74c780a74a14fb776d09), licensed AGPL-3.0 (LICENSE alongside this file). Original authors: OpenFrontIO contributors.

The generated codec contains upstream zbin and selected lobby/game configuration schema definitions. The generator also supplies some definitions and constants itself, so compatibility with the upstream wire layout must be verified independently. Zod is installed separately. The saved binary fixtures are synthetic messages encoded by this generated codec, not independent upstream captures.

Rebuild: `node tools/vendor-lobby-codec.mjs 817c12927c4ec34ec68c74c780a74a14fb776d09`. Builds require public GitHub access; runtime does not require a game checkout. Update the supported revision only alongside regenerated codec, binary fixtures and tests.

Source SHA-256 digests:

```json
{
  "packages/zbin/src/bytes.ts": "ee39a290ab0a8eb23d7bc745aad6c6ddb541021556f0c0a593d3a363e91cfab9",
  "packages/zbin/src/context.ts": "48cc04db4c832c92b7aa0bebcfb92429c4fd09577f7512c988c647ef45480e92",
  "packages/zbin/src/zb.ts": "d0cae5ded991ba8c050c85a2d5f828af739f39d6a100e40b01fd182843b7d840",
  "packages/zbin/src/index.ts": "bf47041e3723431d1acb2ced6af44150e22e03a00725cf2335d548e2fa28cce4",
  "packages/engine-api/src/game/GameTypes.ts": "99ebb76d597157501b8dc5803108914770a63f222e37f8859185acf31dabd0bd",
  "packages/engine-api/src/game/Maps.gen.ts": "84b01c85e6456b18c371e04d3627b824b65eee88cac92313a924c280bc3eb9cb",
  "packages/engine-api/src/Schemas.ts": "4043cd153a259bb8ae4f389aa77f7b9a048c0414c68a2ad98faea3abe803ede3",
  "packages/shared/src/WireSchemas.ts": "690492f276a576e49e0d33058dfe2c1b786041de65e395a0eb98e40ad55d1e57",
  "LICENSE": "1eaad12c953bb15580a6ae797f2a697b72fc1102f6b5bdc11f6a3a9335cfde2b"
}
```
