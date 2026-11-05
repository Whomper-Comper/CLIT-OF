import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { eloLineGraph } from "../dist/commands/statsLineGraph.js";

const start = Date.parse("2026-01-01T00:00:00Z");
const alternating = (count) => Array.from({ length: count }, (_, index) => ({ at: start + index * 3_600_000, rating: 1400 + index % 2 * 400 }));
const fixtures = [
  ["empty", []],
  ["invalid", [{ at: "invalid", rating: 1500 }, { at: 0, rating: NaN }, { at: Infinity, rating: 0 }]],
  ["single zero", [{ at: start, rating: 0 }]],
  ["short negative flat", [{ at: start, rating: -100 }, { at: start + 3_600_000, rating: -100 }]],
  ["dense flat", Array.from({ length: 8761 }, (_, index) => ({ at: start + index * 3_600_000, rating: 1500 }))],
  ["dense alternating spikes", alternating(8761)],
  ["sparse alternating spikes", alternating(100)],
  ["resolution boundary", alternating(774)],
  ["above resolution boundary", alternating(775)],
  ["duplicate timestamps and ratings", Array.from({ length: 2000 }, (_, index) => ({ at: start + Math.floor(index / 200) * 3_600_000, rating: [1200, 1200, 1800, 1200][index % 4] }))],
  ["ordered opposite vertical directions", Array.from({ length: 2000 }, (_, index) => ({ at: start, rating: index % 2 ? 1800 : 1200 }))],
  ["irregular reversed times", [{ at: start + 172_800_000, rating: 1711 }, { at: start + 13, rating: 600 }, { at: "invalid", rating: 10 }, { at: start, rating: 1555 }, { at: start + 14, rating: 1850 }, { at: start + 10_000_000, rating: 0 }]],
  // x = 127.49999999999999: round(x + 1) is 129, but round(x) + 1 is 128.
  ["marker floating half pixel", [{ at: 0, rating: 1000 }, ...Array.from({ length: 2000 }, () => ({ at: 35.499999999999986, rating: 1500 })), { at: 774, rating: 2000 }]],
];
let seed = 0x5eed1234;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (const count of [1, 17, 774, 775, 1000, 8761]) {
  const values = Array.from({ length: count }, (_, index) => {
    const at = start + Math.floor(random() * 500) * 3_600_000 + (index % 11 === 0 ? random() : 0);
    return { at: index % 7 === 0 ? new Date(at).toISOString() : at, rating: Math.floor(random() * 5000) - 1000 };
  });
  fixtures.push([`seeded irregular ${count}`, values.reverse()]);
}

// These literals were captured from the unmodified renderer at 1e13640.
// Hash decoded PNG rows so zlib compression changes cannot alter the expectation.
const baselineHashes = {
  "empty": null,
  "invalid": null,
  "single zero": "5c53da9ff151d41d152a30b7430d25389a73918030dfb833aa7cf54cee176073",
  "short negative flat": "85c52dcc977cfdfad717f884bff88b8bb874390367cabc9517331f6c4afb567d",
  "dense flat": "e47daf1219b61f28f7e60d5946e644b6653513e54000f17fca9409db0d7556f1",
  "dense alternating spikes": "998bccac7bd459b554265e12323d536011bb9be6e9de8354d0e40deef2b0205d",
  "sparse alternating spikes": "5ff8a5d7f62e06820be7ea1bca0ac1ba87bbeede1c7e7618fd907f278c291544",
  "resolution boundary": "c724774cb2906887d71068a26f9c5e19adf33ab471669590ae3487b129214ef6",
  "above resolution boundary": "7839ed47d2009dafeb4e0e61d9e5ee8f9083dbe447c67e33904e53a8e87dba9e",
  "duplicate timestamps and ratings": "4ef8b76d2ad70d7bfcb50e2ec5e7832b1f49a2f8bf3719f5ec0888e7f23ba00c",
  "ordered opposite vertical directions": "14648eb5e95629a802e198401bf033ac53eacc02e59387123988ed5788033e91",
  "irregular reversed times": "7139f9913bb1de2da52dcf0094556dbceff82a0581e5ccdb2beb34ed38a0ecb3",
  "marker floating half pixel": "32a1b4a754f040488796016dd35643f778bfeb8a5980d7660e95922e0cc0a733",
  "seeded irregular 1": "c2fa741eaab8b1cd40b165352b5bfea52fb633dd62a660eb4e4ba2096bda132c",
  "seeded irregular 17": "e599060d77209798c8da89693159b5c089c0615d9db73cca2987be515673fce9",
  "seeded irregular 774": "72f68c8a049988874375b8e9a1f6ff48f098c85cb7d1d7bee091c4016d6ff979",
  "seeded irregular 775": "a2bd484278c1d16e5a9ddaaa9f211762f65e24dc79d14f3f35a92fe344f6ceab",
  "seeded irregular 1000": "02d8554a422d06e2677212f75d374a7021fb6bfffeea0101adbb81df78e04de0",
  "seeded irregular 8761": "03592bcc5b4b9d6ebad6613fb26a2839c444e4645d6e32045df08426e2e9bb97",
};

function pixelHash(image) {
  if (image === null) return null;
  const chunks = [];
  for (let offset = 8; offset < image.length;) {
    const length = image.readUInt32BE(offset);
    if (image.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(image.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return createHash("sha256").update(inflateSync(Buffer.concat(chunks))).digest("hex");
}

for (const [name, values] of fixtures) test(`Elo raster preserves baseline pixels: ${name}`, () => {
  assert.equal(pixelHash(eloLineGraph(values)), baselineHashes[name]);
});

for (const [count, expectedSets] of [[1000, 0], [1548, 0], [1549, 1]]) test(`Elo segment Set allocation respects the dense threshold: ${count} points`, () => {
  const OriginalSet = globalThis.Set;
  let allocations = 0;
  globalThis.Set = class extends OriginalSet {
    constructor(...args) { super(...args); allocations++; }
  };
  try {
    assert.ok(eloLineGraph(alternating(count)));
  } finally {
    globalThis.Set = OriginalSet;
  }
  assert.equal(allocations, expectedSets);
});

test("dense Elo raster avoids repeated thick-segment pixel writes", () => {
  const allocate = Buffer.alloc;
  let writes = 0;
  // Observe real RGB assignments while preserving allocation and buffer copying.
  // This seam is local to this synchronous render; production exposes no metrics.
  Buffer.alloc = function (size, ...args) {
    const buffer = allocate(size, ...args);
    if (size !== 900 * 380 * 3) return buffer;
    return new Proxy(buffer, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, key, value) {
        if (typeof key === "string" && /^\d+$/.test(key)) writes++;
        return Reflect.set(target, key, value);
      },
    });
  };
  try {
    assert.equal(pixelHash(eloLineGraph(alternating(8761))), baselineHashes["dense alternating spikes"]);
  } finally {
    Buffer.alloc = allocate;
  }
  assert.ok(writes < 7_000_000, `dense RGB writes must stay below 7,000,000; observed ${writes}`);
});
