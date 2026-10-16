import { deflateSync } from "node:zlib";

export interface RatingGraphPoint { at: string | number; rating: number }

/** A small dependency-free PNG, so Discord can display a real line chart as an attachment. */
export function eloLineGraph(values: RatingGraphPoint[]): Buffer | null {
  const points = values.map((point) => ({ at: typeof point.at === "number" ? point.at : Date.parse(point.at), rating: point.rating }))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.rating)).sort((a, b) => a.at - b.at);
  if (!points.length) return null;
  const width = 900, height = 380, left = 92, right = 34, top = 40, bottom = 68;
  const pixels = Buffer.alloc(width * height * 3);
  const background = [22, 27, 38], grid = [58, 68, 87], text = [203, 213, 225], line = [96, 165, 250];
  for (let offset = 0; offset < pixels.length; offset += 3) { pixels[offset] = background[0]; pixels[offset + 1] = background[1]; pixels[offset + 2] = background[2]; }
  const pixel = (x: number, y: number, color: number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (Math.round(y) * width + Math.round(x)) * 3;
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
  };
  const drawLine = (x0: number, y0: number, x1: number, y1: number, color: number[], thick = false) => {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      pixel(x0, y0, color); if (thick) { pixel(x0, y0 + 1, color); pixel(x0 + 1, y0, color); }
      if (x0 === x1 && y0 === y1) break;
      const twice = 2 * error;
      if (twice >= dy) { error += dy; x0 += sx; }
      if (twice <= dx) { error += dx; y0 += sy; }
    }
  };
  const write = (value: string, x: number, y: number, scale = 2) => {
    for (const char of value.toUpperCase()) {
      const glyph = font[char] ?? font[" "];
      glyph.forEach((row, iy) => [...row].forEach((cell, ix) => { if (cell === "1") for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) pixel(x + ix * scale + a, y + iy * scale + b, text); }));
      x += 6 * scale;
    }
  };
  let minimum = Math.min(...points.map((point) => point.rating)), maximum = Math.max(...points.map((point) => point.rating));
  const margin = Math.max(10, (maximum - minimum) * 0.12);
  minimum = Math.floor(minimum - margin); maximum = Math.ceil(maximum + margin);
  const first = points[0].at, last = points[points.length - 1].at;
  const x = (time: number) => last === first ? (left + width - right) / 2 : left + (time - first) / (last - first) * (width - left - right);
  const y = (rating: number) => height - bottom - (rating - minimum) / (maximum - minimum) * (height - top - bottom);
  for (let index = 0; index <= 4; index++) {
    const rating = minimum + (maximum - minimum) * index / 4, at = y(rating);
    drawLine(left, at, width - right, at, grid);
    const label = Math.round(rating).toString(); write(label, left - label.length * 12 - 14, at - 6);
  }
  drawLine(left, top, left, height - bottom, text); drawLine(left, height - bottom, width - right, height - bottom, text);
  write("ELO", left, 12); write("UTC", width - right - 36, 12);
  const date = (time: number) => new Date(time).toISOString().slice(0, 10);
  write(date(first), left, height - bottom + 16);
  if (last !== first) write(date(last), width - right - 120, height - bottom + 16);
  if (last - first < 48 * 3_600_000) {
    const time = (at: number) => new Date(at).toISOString().slice(11,16);
    write(time(first),left,height-bottom+36);
    if (last !== first) write(time(last),width-right-60,height-bottom+36);
  }
  for (let index = 1; index < points.length; index++) drawLine(x(points[index - 1].at), y(points[index - 1].rating), x(points[index].at), y(points[index].rating), line, true);
  for (const point of points) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) if (dx * dx + dy * dy <= 10) pixel(x(point.at) + dx, y(point.rating) + dy, line);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) pixels.copy(rows, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); body.copy(result, 4);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return result;
}

const font: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
};
