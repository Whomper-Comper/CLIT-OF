import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, inflateSync } from "node:zlib";
import { eloLineGraph } from "../dist/commands/statsLineGraph.js";

function pixels(image) {
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const compressed = [];
  let width, height, ended = false;
  for (let offset = 8; offset < image.length;) {
    const length = image.readUInt32BE(offset), type = image.toString("ascii", offset + 4, offset + 8);
    const data = image.subarray(offset + 8, offset + 8 + length);
    assert.equal(data.length, length);
    assert.equal(image.readUInt32BE(offset + 8 + length), crc32(image.subarray(offset + 4, offset + 8 + length)), `${type} checksum must be valid`);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 2); }
    if (type === "IDAT") compressed.push(data);
    if (type === "IEND") ended = true;
    offset += length + 12;
  }
  assert.ok(ended);
  const rows = inflateSync(Buffer.concat(compressed));
  assert.equal(rows.length, (width * 3 + 1) * height);
  for (let row = 0; row < height; row++) assert.equal(rows[row * (width * 3 + 1)], 0);
  return { rows, width, height };
}

test("no valid observations produce no Elo chart instead of a fabricated zero", () => {
  assert.equal(eloLineGraph([]), null);
  assert.equal(eloLineGraph([{ at: "invalid", rating: 1500 }, { at: 0, rating: NaN }]), null);
});

for (const [name, values] of [
  ["single zero rating", [{ at: "2026-10-16T10:00:00Z", rating: 0 }]],
  ["flat negative ratings", [{ at: "2026-10-16T10:00:00Z", rating: -100 }, { at: "2026-10-16T11:00:00Z", rating: -100 }]],
  ["repeated timestamps", [{ at: "2026-10-16T10:00:00Z", rating: 1000 }, { at: "2026-10-16T10:00:00Z", rating: 1200 }]],
  ["long collection gap", [{ at: "2026-01-01T00:00:00Z", rating: 1400 }, { at: "2026-10-16T10:00:00Z", rating: 1500 }]],
]) test(`Elo chart produces a complete decodable PNG for ${name}`, () => {
  const { rows, width, height } = pixels(eloLineGraph(values));
  // The central plot contains background, grid and data, without labels or axes.
  // Check that observations are visible without pinning the chart's RGB palette.
  const colors = new Set();
  for (let y = Math.ceil(height * 0.2); y < height * 0.8; y++) {
    for (let x = Math.ceil(width * 0.2); x < width * 0.8; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      colors.add(rows.readUIntBE(offset, 3));
    }
  }
  assert.ok(colors.size >= 3, "the plot must contain data as well as background and grid");
});

test("the plotted trace reflects observation order even when axis ranges are identical", () => {
  const dates = ["2026-10-16T10:00:00Z", "2026-10-16T11:00:00Z", "2026-10-16T12:00:00Z"];
  const rising = dates.map((at, index) => ({ at, rating: [1000, 1100, 1200][index] }));
  const falling = dates.map((at, index) => ({ at, rating: [1200, 1100, 1000][index] }));
  const first = pixels(eloLineGraph(rising)), second = pixels(eloLineGraph(falling));
  assert.equal(first.width, second.width);
  assert.equal(first.height, second.height);
  // Same dates, min/max and labels: a blank chart cannot satisfy this assertion.
  assert.equal(first.rows.equals(second.rows), false, "different observations must produce different traces");
  assert.equal(pixels(eloLineGraph([...rising].reverse())).rows.equals(first.rows), true, "input order must not change chronological plotting");
});
