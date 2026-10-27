// @ts-nocheck
// Generated from OpenFrontIO 817c12927c4ec34ec68c74c780a74a14fb776d09; AGPL-3.0. See NOTICE.md.
// .superpowers/lobby-codec/entry.ts
import { z as z2 } from "zod";

// .superpowers/lobby-codec/zb.ts
import { z } from "zod";

// .superpowers/lobby-codec/bytes.ts
var ZbEncodeError = class extends Error {
  name = "ZbEncodeError";
  constructor(message, options) {
    super(message);
    if (options?.cause !== void 0) {
      this.cause = options.cause;
    }
  }
};
var ZbDecodeError = class extends Error {
  name = "ZbDecodeError";
  constructor(message, options) {
    super(message);
    if (options?.cause !== void 0) {
      this.cause = options.cause;
    }
  }
};
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder("utf-8", { fatal: true });
var MAX_SAFE = Number.MAX_SAFE_INTEGER;
var MAX_INT_MAGNITUDE = 4503599627370495;
var MAX_BIGINT_BITS = 1024;
var MAX_DECODE_ITEMS = 1 << 20;
var MAX_DECODE_DEPTH = 64;
var ByteWriter = class {
  // Uint8Array<ArrayBuffer> (not ArrayBufferLike) so finished payloads are
  // directly accepted by WebSocket.send in the DOM typings.
  buf;
  view;
  pos = 0;
  constructor(initialCapacity = 64) {
    this.buf = new Uint8Array(Math.max(1, initialCapacity));
    this.view = new DataView(this.buf.buffer);
  }
  ensure(extra) {
    if (this.pos + extra <= this.buf.length) return;
    let cap = Math.max(this.buf.length * 2, 16);
    while (cap < this.pos + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  get length() {
    return this.pos;
  }
  // Rewind for reuse. Callers that pool a writer must treat previously
  // returned buffers as owned by the caller (finish() copies).
  reset() {
    this.pos = 0;
  }
  u8(b) {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }
  // Reserve n zeroed bytes (e.g. an object's presence-bit header) and return
  // their offset so they can be patched via orU8 after later fields are known.
  // The explicit fill matters for a pooled writer, whose backing bytes are not
  // freshly zeroed.
  reserve(n) {
    this.ensure(n);
    const at = this.pos;
    this.buf.fill(0, at, at + n);
    this.pos += n;
    return at;
  }
  orU8(offset, mask) {
    this.buf[offset] |= mask;
  }
  // Unsigned LEB128. Arithmetic (not bitwise) so values past 2^31 survive;
  // full double-precision integer range [0, 2^53).
  uint(n) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_SAFE) {
      throw new ZbEncodeError(`not an encodable unsigned integer: ${n}`);
    }
    while (n >= 128) {
      this.u8(n % 128 + 128);
      n = Math.floor(n / 128);
    }
    this.u8(n);
  }
  // Zigzag varint. |n| must stay within 2^52 so the doubled value is exact.
  int(n) {
    if (!Number.isInteger(n)) {
      throw new ZbEncodeError(`not an encodable integer: ${n}`);
    }
    if (n > MAX_INT_MAGNITUDE || n < -MAX_INT_MAGNITUDE - 1) {
      throw new ZbEncodeError(
        `integer ${n} is outside the encodable range +/-2^52`
      );
    }
    this.uint(n < 0 ? -2 * n - 1 : 2 * n);
  }
  f64(n) {
    this.ensure(8);
    this.view.setFloat64(this.pos, n, true);
    this.pos += 8;
  }
  bigint(n) {
    if (typeof n !== "bigint") {
      throw new ZbEncodeError(`not an encodable bigint: ${String(n)}`);
    }
    if (n >= -0xfffffffffffffn && n <= 0xfffffffffffffn) {
      this.int(Number(n));
      return;
    }
    let u = n < 0n ? -2n * n - 1n : 2n * n;
    if (u >> BigInt(MAX_BIGINT_BITS) !== 0n) {
      throw new ZbEncodeError(
        `bigint magnitude exceeds the ${MAX_BIGINT_BITS}-bit wire limit`
      );
    }
    while (u >= 0x80n) {
      this.u8(Number(u & 0x7fn) | 128);
      u >>= 7n;
    }
    this.u8(Number(u));
  }
  str(s) {
    if (typeof s !== "string") {
      throw new ZbEncodeError(`not an encodable string: ${String(s)}`);
    }
    const n = s.length;
    this.ensure(n * 3 + 5);
    const buf = this.buf;
    const start = this.pos;
    this.uint(n);
    const p = this.pos;
    let i = 0;
    for (; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c > 127) break;
      buf[p + i] = c;
    }
    if (i === n) {
      this.pos = p + n;
      return;
    }
    this.pos = start;
    const written = textEncoder.encodeInto(s, buf.subarray(start + 5)).written;
    this.uint(written);
    buf.copyWithin(this.pos, start + 5, start + 5 + written);
    this.pos += written;
  }
  finish() {
    return this.buf.slice(0, this.pos);
  }
};
var ByteReader = class {
  constructor(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  buf;
  view;
  pos = 0;
  items = 0;
  depth = 0;
  need(n) {
    if (this.pos + n > this.buf.length) {
      throw new ZbDecodeError("unexpected end of input");
    }
  }
  get remaining() {
    return this.buf.length - this.pos;
  }
  // Charge decoded elements against the per-message budget. Collections whose
  // elements encode to zero bytes cannot be bounded by remaining input alone.
  takeItems(n, path) {
    this.items += n;
    if (this.items > MAX_DECODE_ITEMS) {
      throw new ZbDecodeError(
        `${path}: decoded element budget of ${MAX_DECODE_ITEMS} exceeded`
      );
    }
  }
  enterDepth(path) {
    if (++this.depth > MAX_DECODE_DEPTH) {
      throw new ZbDecodeError(
        `${path}: nesting deeper than ${MAX_DECODE_DEPTH} levels`
      );
    }
  }
  exitDepth() {
    this.depth--;
  }
  expectEnd() {
    if (this.remaining !== 0) {
      throw new ZbDecodeError(`${this.remaining} trailing byte(s) after value`);
    }
  }
  u8() {
    this.need(1);
    return this.buf[this.pos++];
  }
  readBytes(n) {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  uint() {
    let result = 0;
    let mult = 1;
    for (; ; ) {
      const b = this.u8();
      result += (b & 127) * mult;
      if ((b & 128) === 0) {
        if (b === 0 && mult !== 1) {
          throw new ZbDecodeError("non-minimal varint encoding");
        }
        break;
      }
      mult *= 128;
      if (mult > MAX_SAFE) throw new ZbDecodeError("varint too large");
    }
    if (result > MAX_SAFE) throw new ZbDecodeError("varint too large");
    return result;
  }
  int() {
    const u = this.uint();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }
  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bigint() {
    let small = 0;
    let mult = 1;
    let shift = 0;
    for (; ; ) {
      const b = this.u8();
      if ((b & 128) === 0) {
        if (b === 0 && shift !== 0) {
          throw new ZbDecodeError("non-minimal varint encoding");
        }
        small += (b & 127) * mult;
        const u = BigInt(small);
        return u % 2n === 0n ? u / 2n : -(u + 1n) / 2n;
      }
      small += (b & 127) * mult;
      mult *= 128;
      shift += 7;
      if (shift >= 49) break;
    }
    let result = BigInt(small);
    let bshift = BigInt(shift);
    for (; ; ) {
      const b = this.u8();
      result |= BigInt(b & 127) << bshift;
      if ((b & 128) === 0) {
        if (b === 0) throw new ZbDecodeError("non-minimal varint encoding");
        break;
      }
      bshift += 7n;
      if (bshift > BigInt(MAX_BIGINT_BITS)) {
        throw new ZbDecodeError("bigint varint too large");
      }
    }
    return result % 2n === 0n ? result / 2n : -(result + 1n) / 2n;
  }
  str() {
    const len = this.uint();
    this.need(len);
    try {
      return textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
    } catch (e) {
      throw new ZbDecodeError("invalid UTF-8 in string", { cause: e });
    } finally {
      this.pos += len;
    }
  }
};

// .superpowers/lobby-codec/zb.ts
var explicit = /* @__PURE__ */ new WeakMap();
var derivedCache = /* @__PURE__ */ new WeakMap();
function register(schema, codec) {
  if (derivedCache.has(schema)) {
    throw new Error(
      "zbin: this schema instance was already composed into a zb root with a derived codec; register its codec before composing it"
    );
  }
  const prior = explicit.get(schema);
  if (prior !== void 0 && prior !== codec) {
    throw new Error("zbin: this schema instance already has a codec");
  }
  explicit.set(schema, codec);
  return schema;
}
function defOf(schema) {
  return schema._zod.def;
}
function schemaError(path, msg) {
  return new Error(`zbin schema at ${path}: ${msg}`);
}
var uintCodec = {
  enc: (w, v) => w.uint(v),
  dec: (r) => r.uint(),
  minBytes: 1
};
var floatCodec = {
  enc: (w, v) => w.f64(v),
  dec: (r) => r.f64(),
  minBytes: 8
};
var bigintCodec = {
  enc: (w, v) => w.bigint(v),
  dec: (r) => r.bigint(),
  minBytes: 1
};
var strCodec = {
  enc: (w, v) => w.str(v),
  dec: (r) => r.str(),
  minBytes: 1
};
var boolByteCodec = {
  enc: (w, v) => {
    if (typeof v !== "boolean") {
      throw new ZbEncodeError(`not an encodable boolean: ${String(v)}`);
    }
    w.u8(v ? 1 : 0);
  },
  dec: (r) => {
    const b = r.u8();
    if (b > 1) throw new ZbDecodeError(`invalid boolean byte ${b}`);
    return b === 1;
  },
  minBytes: 1
};
function constCodec(value, path) {
  return {
    enc: (_w, v) => {
      if (v !== value) {
        throw new ZbEncodeError(
          `${path}: expected literal ${String(value)}, got ${String(v)}`
        );
      }
    },
    dec: () => value,
    minBytes: 0
  };
}
function enumCodec(values, path) {
  const toIndex = /* @__PURE__ */ new Map();
  values.forEach((v, i) => toIndex.set(v, i));
  if (toIndex.size !== values.length) {
    throw schemaError(
      path,
      "enum has duplicate values; ordinals are ambiguous"
    );
  }
  return {
    enc: (w, v) => {
      const idx = toIndex.get(v);
      if (idx === void 0) {
        throw new ZbEncodeError(`${path}: value ${String(v)} is not a member`);
      }
      w.uint(idx);
    },
    dec: (r) => {
      const idx = r.uint();
      if (idx >= values.length) {
        throw new ZbDecodeError(`${path}: enum ordinal ${idx} out of range`);
      }
      return values[idx];
    },
    minBytes: 1
  };
}
function codecFor(schema, path) {
  const hit = explicit.get(schema) ?? derivedCache.get(schema);
  if (hit) return hit;
  const codec = derive(schema, path);
  derivedCache.set(schema, codec);
  return codec;
}
function optionsOf(schema, path) {
  const entries = defOf(schema).entries;
  if (entries === void 0) {
    const opts = schema.options;
    if (Array.isArray(opts)) return opts;
    throw schemaError(path, "enum has no introspectable members");
  }
  const reverseKeys = new Set(
    Object.values(entries).filter((v) => typeof v === "number").map(String)
  );
  return Object.entries(entries).filter(([k]) => !reverseKeys.has(k)).map(([, v]) => v);
}
function derive(schema, path) {
  const d = defOf(schema);
  switch (d.type) {
    case "string":
      return strCodec;
    case "boolean":
      return boolByteCodec;
    case "bigint":
      return bigintCodec;
    case "literal": {
      const values = d.values;
      return values.length === 1 ? constCodec(values[0], path) : enumCodec(values, path);
    }
    case "enum":
      return enumCodec(optionsOf(schema, path), path);
    case "optional":
    case "nullable":
    case "default":
      return presenceCodec(schema, path);
    case "object":
      return objectCodec(d.shape, path);
    case "array":
      return arrayCodec(d.element, path);
    case "record":
      return recordCodec(d.keyType, d.valueType, path);
    case "union":
      return d.discriminator !== void 0 ? taggedUnionCodec(d.discriminator, d.options, path) : untaggedUnionCodec(d.options, path, void 0);
    case "tuple":
      return tupleCodec(d.items, d.rest ?? null, path);
    case "lazy":
      return lazyCodec(d.getter, path);
    case "number":
      throw schemaError(
        path,
        "plain z.number() is ambiguous on the wire \u2014 use zb.uint(), zb.int(), or zb.float()"
      );
    case "intersection":
      throw schemaError(
        path,
        "z.intersection cannot be introspected \u2014 use zb.stamped()"
      );
    default:
      throw schemaError(
        path,
        `unsupported zod type "${d.type}" \u2014 use a zb builder or wrap the subtree with zb.json()`
      );
  }
}
function unwrap(schema) {
  let s = schema;
  let optionalLike = false;
  let nullable = false;
  let defaultValue;
  for (; ; ) {
    const d = defOf(s);
    if (d.type === "optional") {
      optionalLike = true;
      s = d.innerType;
    } else if (d.type === "nullable") {
      nullable = true;
      s = d.innerType;
    } else if (d.type === "default") {
      optionalLike = true;
      const dv = d.defaultValue;
      defaultValue = typeof dv === "function" ? dv : () => dv;
      s = d.innerType;
    } else {
      return { inner: s, optionalLike, nullable, defaultValue };
    }
  }
}
function presenceCodec(schema, path) {
  const { inner, optionalLike, nullable, defaultValue } = unwrap(schema);
  const innerCodec = codecFor(inner, path);
  return {
    enc: (w, v, ctx) => {
      if (v === void 0) {
        if (!optionalLike) throw new ZbEncodeError(`${path}: missing value`);
        w.u8(0);
      } else if (v === null) {
        if (!nullable) throw new ZbEncodeError(`${path}: unexpected null`);
        w.u8(1);
      } else {
        w.u8(2);
        innerCodec.enc(w, v, ctx);
      }
    },
    dec: (r, ctx) => {
      const flag = r.u8();
      switch (flag) {
        case 0:
          if (!optionalLike) {
            throw new ZbDecodeError(
              `${path}: absent flag for a required value`
            );
          }
          return defaultValue !== void 0 ? defaultValue() : void 0;
        case 1:
          if (!nullable) {
            throw new ZbDecodeError(
              `${path}: null flag for a non-nullable value`
            );
          }
          return null;
        case 2:
          return innerCodec.dec(r, ctx);
        default:
          throw new ZbDecodeError(`${path}: invalid presence flag ${flag}`);
      }
    },
    minBytes: 1
  };
}
function objectCodec(shape, path) {
  const plans = [];
  let bits = 0;
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const { inner, optionalLike, nullable, defaultValue } = unwrap(
      fieldSchema
    );
    const innerDef = defOf(inner);
    let mode = "body";
    let constValue;
    let codec = null;
    const registered = explicit.get(inner);
    if (registered !== void 0) {
      codec = registered;
    } else if (innerDef.type === "boolean") {
      mode = "bool";
    } else if (innerDef.type === "literal" && innerDef.values.length === 1) {
      mode = "const";
      constValue = innerDef.values[0];
    } else {
      codec = codecFor(inner, `${path}.${key}`);
    }
    plans.push({
      key,
      mode,
      codec,
      constValue,
      optionalLike,
      nullable,
      defaultValue,
      presenceBit: optionalLike ? bits++ : -1,
      nullBit: nullable ? bits++ : -1,
      valueBit: mode === "bool" ? bits++ : -1
    });
  }
  const headerBytes = Math.ceil(bits / 8);
  const narrowHeader = headerBytes <= 4;
  const count = plans.length;
  let minBytes = headerBytes;
  for (const p of plans) {
    if (p.mode === "body" && !p.optionalLike && p.codec !== null) {
      minBytes += p.codec.minBytes;
    }
  }
  return {
    enc: (w, v, ctx) => {
      const base = w.reserve(headerBytes);
      for (let i = 0; i < count; i++) {
        const p = plans[i];
        const value = v[p.key];
        if (value === void 0) {
          if (!p.optionalLike) {
            throw new ZbEncodeError(`${path}.${p.key}: missing required field`);
          }
          continue;
        }
        if (p.presenceBit >= 0) {
          w.orU8(base + (p.presenceBit >> 3), 1 << (p.presenceBit & 7));
        }
        if (value === null) {
          if (!p.nullable) {
            throw new ZbEncodeError(`${path}.${p.key}: unexpected null`);
          }
          w.orU8(base + (p.nullBit >> 3), 1 << (p.nullBit & 7));
          continue;
        }
        if (p.mode === "bool") {
          if (typeof value !== "boolean") {
            throw new ZbEncodeError(
              `${path}.${p.key}: expected a boolean, got ${typeof value}`
            );
          }
          if (value) w.orU8(base + (p.valueBit >> 3), 1 << (p.valueBit & 7));
        } else if (p.mode === "const") {
          if (value !== p.constValue) {
            throw new ZbEncodeError(
              `${path}.${p.key}: expected literal ${String(p.constValue)}, got ${String(value)}`
            );
          }
        } else {
          p.codec.enc(w, value, ctx);
        }
      }
    },
    dec: (r, ctx) => {
      const out = {};
      if (narrowHeader) {
        let header = 0;
        for (let i = 0; i < headerBytes; i++) header |= r.u8() << i * 8;
        for (let i = 0; i < count; i++) {
          const p = plans[i];
          if (p.presenceBit >= 0 && (header & 1 << p.presenceBit) === 0) {
            if (p.defaultValue !== void 0) out[p.key] = p.defaultValue();
            continue;
          }
          if (p.nullBit >= 0 && (header & 1 << p.nullBit) !== 0) {
            out[p.key] = null;
            continue;
          }
          if (p.mode === "bool") {
            out[p.key] = (header & 1 << p.valueBit) !== 0;
          } else if (p.mode === "const") {
            out[p.key] = p.constValue;
          } else {
            out[p.key] = p.codec.dec(r, ctx);
          }
        }
        return out;
      }
      const buf = r.readBytes(headerBytes);
      for (let i = 0; i < count; i++) {
        const p = plans[i];
        if (p.presenceBit >= 0 && (buf[p.presenceBit >> 3] & 1 << (p.presenceBit & 7)) === 0) {
          if (p.defaultValue !== void 0) out[p.key] = p.defaultValue();
          continue;
        }
        if (p.nullBit >= 0 && (buf[p.nullBit >> 3] & 1 << (p.nullBit & 7)) !== 0) {
          out[p.key] = null;
          continue;
        }
        if (p.mode === "bool") {
          out[p.key] = (buf[p.valueBit >> 3] & 1 << (p.valueBit & 7)) !== 0;
        } else if (p.mode === "const") {
          out[p.key] = p.constValue;
        } else {
          out[p.key] = p.codec.dec(r, ctx);
        }
      }
      return out;
    },
    minBytes
  };
}
function writeCount(w, n, path) {
  if (n > MAX_DECODE_ITEMS) {
    throw new ZbEncodeError(
      `${path}: ${n} elements exceeds the decode cap of ${MAX_DECODE_ITEMS}`
    );
  }
  w.uint(n);
}
function readCount(r, path, minElemBytes) {
  const n = r.uint();
  if (minElemBytes > 0 && n > r.remaining) {
    throw new ZbDecodeError(
      `${path}: ${n} elements exceeds the remaining ${r.remaining} byte(s)`
    );
  }
  r.takeItems(n, path);
  return n;
}
function arrayCodec(element, path) {
  const elem = codecFor(element, `${path}[]`);
  return {
    enc: (w, v, ctx) => {
      if (!Array.isArray(v)) {
        throw new ZbEncodeError(`${path}: expected an array`);
      }
      writeCount(w, v.length, path);
      for (const item of v) elem.enc(w, item, ctx);
    },
    dec: (r, ctx) => {
      const n = readCount(r, path, elem.minBytes);
      const out = [];
      for (let i = 0; i < n; i++) out.push(elem.dec(r, ctx));
      return out;
    },
    minBytes: 1
  };
}
function recordCodec(keyType, valueType, path) {
  const keyDef = defOf(keyType);
  if (keyDef.type !== "enum" && keyDef.type !== "string") {
    throw schemaError(
      `${path}{key}`,
      `unsupported record key type "${keyDef.type}" \u2014 keys must be strings or a z.enum`
    );
  }
  const keyCodec = keyDef.type === "enum" ? enumCodec(optionsOf(keyType, `${path}{key}`), `${path}{key}`) : strCodec;
  const valCodec = codecFor(valueType, `${path}{}`);
  const pairMin = keyCodec.minBytes + valCodec.minBytes;
  return {
    enc: (w, v, ctx) => {
      const keys = Object.keys(v);
      writeCount(w, keys.length, path);
      for (const k of keys) {
        keyCodec.enc(w, k, ctx);
        valCodec.enc(w, v[k], ctx);
      }
    },
    dec: (r, ctx) => {
      const n = readCount(r, path, pairMin);
      const out = {};
      for (let i = 0; i < n; i++) {
        const k = keyCodec.dec(r, ctx);
        if (k === "__proto__") {
          throw new ZbDecodeError(`${path}: forbidden record key "__proto__"`);
        }
        if (Object.prototype.hasOwnProperty.call(out, k)) {
          throw new ZbDecodeError(`${path}: duplicate record key ${k}`);
        }
        out[k] = valCodec.dec(r, ctx);
      }
      return out;
    },
    minBytes: 1
  };
}
function discriminatorValue(option, key, path) {
  const shape = defOf(option).shape;
  const disc = shape?.[key];
  if (disc === void 0) {
    throw schemaError(path, `variant lacks discriminator "${key}"`);
  }
  const dd = defOf(disc);
  if (dd.type !== "literal" || dd.values.length !== 1) {
    throw schemaError(
      path,
      `discriminator "${key}" must be a single-value literal`
    );
  }
  return dd.values[0];
}
function taggedUnionParts(key, options, path) {
  const byValue = /* @__PURE__ */ new Map();
  const codecs = [];
  options.forEach((option, index) => {
    const value = discriminatorValue(option, key, `${path}#${index}`);
    const codec = codecFor(option, `${path}#${String(value)}`);
    byValue.set(value, { index, codec });
    codecs.push(codec);
  });
  return { byValue, codecs };
}
function minOf(codecs) {
  let m = Infinity;
  for (const c of codecs) m = Math.min(m, c.minBytes);
  return m === Infinity ? 0 : m;
}
function taggedUnionCodec(key, options, path) {
  const { byValue, codecs } = taggedUnionParts(key, options, path);
  return {
    enc: (w, v, ctx) => {
      const variant = byValue.get(v?.[key]);
      if (variant === void 0) {
        throw new ZbEncodeError(
          `${path}: no variant for ${key}=${String(v?.[key])}`
        );
      }
      w.uint(variant.index);
      variant.codec.enc(w, v, ctx);
    },
    dec: (r, ctx) => {
      const idx = r.uint();
      if (idx >= codecs.length) {
        throw new ZbDecodeError(`${path}: union tag ${idx} out of range`);
      }
      return codecs[idx].dec(r, ctx);
    },
    minBytes: 1 + minOf(codecs)
  };
}
function untaggedUnionCodec(options, path, select) {
  const codecs = options.map((o, i) => codecFor(o, `${path}|${i}`));
  return {
    enc: (w, v, ctx) => {
      if (select !== void 0) {
        const i = select(v);
        if (!Number.isInteger(i) || i < 0 || i >= codecs.length) {
          throw new ZbEncodeError(
            `${path}: select returned invalid index ${i}`
          );
        }
        w.uint(i);
        codecs[i].enc(w, v, ctx);
        return;
      }
      for (let i = 0; i < options.length; i++) {
        if (options[i].safeParse(v).success) {
          w.uint(i);
          codecs[i].enc(w, v, ctx);
          return;
        }
      }
      throw new ZbEncodeError(`${path}: value matches no union variant`);
    },
    dec: (r, ctx) => {
      const idx = r.uint();
      if (idx >= codecs.length) {
        throw new ZbDecodeError(`${path}: union tag ${idx} out of range`);
      }
      return codecs[idx].dec(r, ctx);
    },
    minBytes: 1 + minOf(codecs)
  };
}
function tupleCodec(items, rest, path) {
  const itemCodecs = items.map((s, i) => codecFor(s, `${path}[${i}]`));
  const restCodec = rest === null ? null : codecFor(rest, `${path}[...]`);
  const arity = items.length;
  let minBytes = 0;
  for (const c of itemCodecs) minBytes += c.minBytes;
  if (restCodec !== null) minBytes += 1;
  return {
    enc: (w, v, ctx) => {
      if (!Array.isArray(v)) {
        throw new ZbEncodeError(`${path}: expected an array`);
      }
      if (restCodec === null ? v.length !== arity : v.length < arity) {
        throw new ZbEncodeError(
          `${path}: expected ${restCodec === null ? "" : "at least "}${arity} tuple element(s), got ${v.length}`
        );
      }
      for (let i = 0; i < arity; i++) itemCodecs[i].enc(w, v[i], ctx);
      if (restCodec !== null) {
        writeCount(w, v.length - arity, path);
        for (let i = arity; i < v.length; i++) restCodec.enc(w, v[i], ctx);
      }
    },
    dec: (r, ctx) => {
      const out = [];
      for (let i = 0; i < arity; i++) out.push(itemCodecs[i].dec(r, ctx));
      if (restCodec !== null) {
        const n = readCount(r, path, restCodec.minBytes);
        for (let i = 0; i < n; i++) out.push(restCodec.dec(r, ctx));
      }
      return out;
    },
    minBytes
  };
}
function lazyCodec(getter, path) {
  let inner = null;
  const resolve = () => inner ??= codecFor(getter(), `${path}<lazy>`);
  return {
    enc: (w, v, ctx) => resolve().enc(w, v, ctx),
    dec: (r, ctx) => {
      r.enterDepth(path);
      try {
        return resolve().dec(r, ctx);
      } finally {
        r.exitDepth();
      }
    },
    // A recursive schema's true minimum is not knowable here; 0 defers the
    // bound to the per-message element budget.
    minBytes: 0
  };
}
var sharedWriter = new ByteWriter(4096);
var writerInUse = false;
function decodeContract(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ZbDecodeError) throw e;
    throw new ZbDecodeError(
      `decode failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
}
function attach(schema, codec) {
  explicit.set(schema, codec);
  const methods = {
    serialize(value, ctx) {
      if (writerInUse) {
        const w = new ByteWriter();
        codec.enc(w, value, ctx);
        return w.finish();
      }
      writerInUse = true;
      try {
        sharedWriter.reset();
        codec.enc(sharedWriter, value, ctx);
        return sharedWriter.finish();
      } finally {
        writerInUse = false;
      }
    },
    decodeBytesUnvalidated(bytes, ctx) {
      return decodeContract(() => {
        const r = new ByteReader(bytes);
        const v = codec.dec(r, ctx);
        r.expectEnd();
        return v;
      });
    },
    parseBytes(bytes, ctx) {
      const v = decodeContract(() => {
        const r = new ByteReader(bytes);
        const decoded = codec.dec(r, ctx);
        r.expectEnd();
        return decoded;
      });
      return schema.parse(v);
    }
  };
  return Object.assign(schema, methods);
}
function applyNumberOpts(s, opts) {
  if (opts.min !== void 0) s = s.min(opts.min);
  if (opts.max !== void 0) s = s.max(opts.max);
  return s;
}
function uint(opts = {}) {
  return register(
    applyNumberOpts(z.number().int().nonnegative(), opts),
    uintCodec
  );
}
function float(opts = {}) {
  return register(applyNumberOpts(z.number(), opts), floatCodec);
}
var literal_ = z.literal;
var enum_ = z.enum;
function discriminatedUnion(discriminator, options) {
  const s = z.discriminatedUnion(discriminator, options);
  return attach(s, codecFor(s, "$"));
}
function union_(options, opts = {}) {
  const s = z.union(options);
  return attach(s, untaggedUnionCodec(options, "$", opts.select));
}

// .superpowers/lobby-codec/entry.ts
var Difficulty = /* @__PURE__ */ ((Difficulty2) => {
  Difficulty2["Easy"] = "Easy";
  Difficulty2["Medium"] = "Medium";
  Difficulty2["Hard"] = "Hard";
  Difficulty2["Impossible"] = "Impossible";
  return Difficulty2;
})(Difficulty || {});
var GameType = /* @__PURE__ */ ((GameType2) => {
  GameType2["Singleplayer"] = "Singleplayer";
  GameType2["Public"] = "Public";
  GameType2["Private"] = "Private";
  return GameType2;
})(GameType || {});
var GameMode = /* @__PURE__ */ ((GameMode2) => {
  GameMode2["FFA"] = "Free For All";
  GameMode2["Team"] = "Team";
  return GameMode2;
})(GameMode || {});
var RankedType = /* @__PURE__ */ ((RankedType2) => {
  RankedType2["OneVOne"] = "1v1";
  RankedType2["TwoVTwo"] = "2v2";
  RankedType2["FreeForAll"] = "ffa";
  RankedType2["ClanWars"] = "clanwars";
  return RankedType2;
})(RankedType || {});
var GameMapSize = /* @__PURE__ */ ((GameMapSize2) => {
  GameMapSize2["Compact"] = "Compact";
  GameMapSize2["Normal"] = "Normal";
  return GameMapSize2;
})(GameMapSize || {});
var UnitType = /* @__PURE__ */ ((UnitType2) => {
  UnitType2["TransportShip"] = "Transport";
  UnitType2["Warship"] = "Warship";
  UnitType2["Shell"] = "Shell";
  UnitType2["SAMMissile"] = "SAMMissile";
  UnitType2["Port"] = "Port";
  UnitType2["AtomBomb"] = "Atom Bomb";
  UnitType2["HydrogenBomb"] = "Hydrogen Bomb";
  UnitType2["TradeShip"] = "Trade Ship";
  UnitType2["MissileSilo"] = "Missile Silo";
  UnitType2["DefensePost"] = "Defense Post";
  UnitType2["SAMLauncher"] = "SAM Launcher";
  UnitType2["City"] = "City";
  UnitType2["MIRV"] = "MIRV";
  UnitType2["MIRVWarhead"] = "MIRV Warhead";
  UnitType2["Train"] = "Train";
  UnitType2["Factory"] = "Factory";
  return UnitType2;
})(UnitType || {});
var GameMapType = /* @__PURE__ */ ((GameMapType2) => {
  GameMapType2["Achiran"] = "Achiran";
  GameMapType2["Aegean"] = "Aegean";
  GameMapType2["Africa"] = "Africa";
  GameMapType2["Alps"] = "Alps";
  GameMapType2["AmazonRiver"] = "Amazon River";
  GameMapType2["Antarctica"] = "Antarctica";
  GameMapType2["ArchipelagoSea"] = "ArchipelagoSea";
  GameMapType2["Arctic"] = "Arctic";
  GameMapType2["Asia"] = "Asia";
  GameMapType2["Australia"] = "Australia";
  GameMapType2["BabelMandebStrait"] = "Bab el-Mandeb Strait";
  GameMapType2["Baikal"] = "Baikal";
  GameMapType2["BaikalNukeWars"] = "Baikal Nuke Wars";
  GameMapType2["BajaCalifornia"] = "Baja California";
  GameMapType2["Balkans"] = "Balkans";
  GameMapType2["Balkhash"] = "Balkhash";
  GameMapType2["Baltics"] = "Baltics";
  GameMapType2["Benelux"] = "Benelux";
  GameMapType2["BeringSea"] = "Bering Sea";
  GameMapType2["BeringStrait"] = "Bering Strait";
  GameMapType2["BetweenTwoSeas"] = "Between Two Seas";
  GameMapType2["BlackSea"] = "Black Sea";
  GameMapType2["BosphorusStraits"] = "Bosphorus Straits";
  GameMapType2["BrainRot"] = "Brain Rot";
  GameMapType2["BranchingPaths"] = "Branching Paths";
  GameMapType2["Britannia"] = "Britannia";
  GameMapType2["BritanniaClassic"] = "Britannia Classic";
  GameMapType2["CanaryIslands"] = "Canary Islands";
  GameMapType2["CapeCod"] = "Cape Cod";
  GameMapType2["CapeOfGoodHope"] = "Cape Of Good Hope";
  GameMapType2["Caribbean"] = "Caribbean";
  GameMapType2["CaspianSea"] = "Caspian Sea";
  GameMapType2["Caucasus"] = "Caucasus";
  GameMapType2["CentralAmerica"] = "Central America";
  GameMapType2["ChannelIslands"] = "Channel Islands";
  GameMapType2["China"] = "China";
  GameMapType2["ChoppingBlock"] = "Chopping Block";
  GameMapType2["ClearwaterLakes"] = "Clearwater Lakes";
  GameMapType2["Conakry"] = "Conakry";
  GameMapType2["Crimea"] = "Crimea";
  GameMapType2["DanishStraits"] = "Danish Straits";
  GameMapType2["DeglaciatedAntarctica"] = "Deglaciated Antarctica";
  GameMapType2["Didier"] = "Didier";
  GameMapType2["DidierFrance"] = "Didier France";
  GameMapType2["Dyslexdria"] = "Dyslexdria";
  GameMapType2["EastAsia"] = "East Asia";
  GameMapType2["Europe"] = "Europe";
  GameMapType2["EuropeClassic"] = "Europe Classic";
  GameMapType2["FalklandIslands"] = "Falkland Islands";
  GameMapType2["FaroeIslands"] = "Faroe Islands";
  GameMapType2["FingerLakes"] = "Finger Lakes";
  GameMapType2["FourIslands"] = "Four Islands";
  GameMapType2["France"] = "France";
  GameMapType2["GatewayToTheAtlantic"] = "Gateway to the Atlantic";
  GameMapType2["Germany"] = "Germany";
  GameMapType2["GiantWorldMap"] = "Giant World Map";
  GameMapType2["GreatLakes"] = "Great Lakes";
  GameMapType2["GulfOfGuinea"] = "Gulf Of Guinea";
  GameMapType2["GulfOfMexico"] = "Gulf Of Mexico";
  GameMapType2["GulfOfStLawrence"] = "Gulf of St. Lawrence";
  GameMapType2["Halkidiki"] = "Halkidiki";
  GameMapType2["Hawaii"] = "Hawaii";
  GameMapType2["Hecatestrait"] = "Hecate Strait";
  GameMapType2["HongKong"] = "Hong Kong";
  GameMapType2["HornOfAfrica"] = "Horn Of Africa";
  GameMapType2["Iceland"] = "Iceland";
  GameMapType2["IndianSubcontinent"] = "Indian Subcontinent";
  GameMapType2["IrishSea"] = "Irish Sea";
  GameMapType2["Italia"] = "Italia";
  GameMapType2["Japan"] = "Japan";
  GameMapType2["JuanDeFucaStrait"] = "Juan De Fuca Strait";
  GameMapType2["Korea"] = "Korea";
  GameMapType2["Labyrinth"] = "Labyrinth";
  GameMapType2["LasVegasStrip"] = "Las Vegas Strip";
  GameMapType2["Lemnos"] = "Lemnos";
  GameMapType2["Levant"] = "Levant";
  GameMapType2["Lisbon"] = "Lisbon";
  GameMapType2["LosAngeles"] = "Los Angeles";
  GameMapType2["Luna"] = "Luna";
  GameMapType2["Madagascar"] = "Madagascar";
  GameMapType2["Manicouagan"] = "Manicouagan";
  GameMapType2["MareNostrum"] = "Mare Nostrum";
  GameMapType2["Mars"] = "Mars";
  GameMapType2["Mena"] = "Mena";
  GameMapType2["MiddleEast"] = "Middle East";
  GameMapType2["MilkyWay"] = "MilkyWay";
  GameMapType2["MississippiRiver"] = "Mississippi River";
  GameMapType2["Montreal"] = "Montreal";
  GameMapType2["MoreThanLuck"] = "More Than Luck";
  GameMapType2["NewYorkCity"] = "New York City";
  GameMapType2["NewZealand"] = "New Zealand";
  GameMapType2["NileDelta"] = "Nile Delta";
  GameMapType2["NorthAmerica"] = "North America";
  GameMapType2["NorthwestPassage"] = "Northwest Passage";
  GameMapType2["Oceania"] = "Oceania";
  GameMapType2["Ommatrypta"] = "Ommatrypta";
  GameMapType2["Onion"] = "Onion";
  GameMapType2["Pangaea"] = "Pangaea";
  GameMapType2["Passage"] = "Passage";
  GameMapType2["Pluto"] = "Pluto";
  GameMapType2["PulicatLake"] = "Pulicat Lake";
  GameMapType2["QingChina"] = "Qing China";
  GameMapType2["RioDeJaneiro"] = "Rio de Janeiro";
  GameMapType2["Russia"] = "Russia";
  GameMapType2["SanFrancisco"] = "San Francisco";
  GameMapType2["Scandinavia"] = "Scandinavia";
  GameMapType2["Sierpinski"] = "Sierpinski";
  GameMapType2["Sol"] = "Sol";
  GameMapType2["SouthAmerica"] = "South America";
  GameMapType2["SoutheastAsia"] = "SoutheastAsia";
  GameMapType2["StraitOfGibraltar"] = "Strait of Gibraltar";
  GameMapType2["StraitOfHormuz"] = "Strait of Hormuz";
  GameMapType2["StraitOfMalacca"] = "Strait Of Malacca";
  GameMapType2["Surrounded"] = "Surrounded";
  GameMapType2["Svalmel"] = "Svalmel";
  GameMapType2["TaiwanStrait"] = "Taiwan Strait";
  GameMapType2["TheBox"] = "The Box";
  GameMapType2["TierraDelFuego"] = "Tierra Del Fuego";
  GameMapType2["Titan"] = "Titan";
  GameMapType2["Tourney1"] = "Tourney 2 Teams";
  GameMapType2["Tourney2"] = "Tourney 3 Teams";
  GameMapType2["Tourney3"] = "Tourney 4 Teams";
  GameMapType2["Tourney4"] = "Tourney 8 Teams";
  GameMapType2["TradersDream"] = "Traders Dream";
  GameMapType2["TwoLakes"] = "Two Lakes";
  GameMapType2["UnitedStates"] = "United States";
  GameMapType2["VancouverIsland"] = "Vancouver Island";
  GameMapType2["Venice"] = "Venice";
  GameMapType2["Vietnam"] = "Vietnam";
  GameMapType2["WarshipWarship"] = "Warship Warship";
  GameMapType2["World"] = "World";
  GameMapType2["WorldInverted"] = "World Inverted";
  GameMapType2["YangtzeRiver"] = "Yangtze River";
  GameMapType2["YellowSea"] = "Yellow Sea";
  GameMapType2["Yenisei"] = "Yenisei";
  return GameMapType2;
})(GameMapType || {});
var Duos = "Duos";
var Trios = "Trios";
var Quads = "Quads";
var HumansVsNations = "Humans Vs Nations";
var ID = z2.string();
var TEAM_COUNT_PRESETS = [Duos, Trios, Quads, HumansVsNations];
var TeamCountConfigSchema = union_(
  [
    uint(),
    z2.literal(Duos),
    z2.literal(Trios),
    z2.literal(Quads),
    z2.literal(HumansVsNations)
  ],
  {
    select: (v) => typeof v === "number" ? 0 : TEAM_COUNT_PRESETS.indexOf(v) + 1
  }
);
var DoomsdayClockConfigSchema = z2.object({
  enabled: z2.boolean().optional(),
  speed: z2.enum(["slow", "normal", "fast", "veryfast"]).optional()
});
var OvertimeConfigSchema = z2.object({
  enabled: z2.boolean().optional(),
  startMinutes: uint({ min: 1, max: 120 }).optional()
});
var PoolConfigSchema = z2.object({
  id: z2.string().min(1).max(64),
  // z.lazy because ID is declared further down this file, and GameConfigSchema
  // — which embeds this — is evaluated before that point.
  siblings: z2.lazy(() => ID).array().min(1).max(64)
}).refine((pool) => new Set(pool.siblings).size === pool.siblings.length, {
  error: "pool siblings must be unique",
  path: ["siblings"]
});
var GameConfigSchema = z2.object({
  gameMap: z2.enum(GameMapType),
  difficulty: z2.enum(Difficulty),
  donateGold: z2.boolean(),
  // Configures donations to humans only
  donateTroops: z2.boolean(),
  // Configures donations to humans only
  gameType: z2.enum(GameType),
  gameMode: z2.enum(GameMode),
  rankedType: z2.enum(RankedType).optional(),
  // Only set for ranked games.
  gameMapSize: z2.enum(GameMapSize),
  doomsdayClock: DoomsdayClockConfigSchema.optional(),
  overtime: OvertimeConfigSchema.optional(),
  publicGameModifiers: z2.object({
    isCompact: z2.boolean().optional(),
    isRandomSpawn: z2.boolean().optional(),
    isCrowded: z2.boolean().optional(),
    isHardNations: z2.boolean().optional(),
    startingGold: uint().optional(),
    goldMultiplier: float({ min: 0.1, max: 1e3 }).optional(),
    isAlliancesDisabled: z2.boolean().optional(),
    isPortsDisabled: z2.boolean().optional(),
    isNukesDisabled: z2.boolean().optional(),
    isSAMsDisabled: z2.boolean().optional(),
    isPeaceTime: z2.boolean().optional(),
    isWaterNukes: z2.boolean().optional(),
    isDoomsdayClock: z2.boolean().optional()
  }).optional(),
  nations: union_(
    [uint({ min: 1, max: 400 }), z2.enum(["default", "disabled"])],
    {
      select: (v) => typeof v === "number" ? 0 : 1
    }
  ),
  bots: uint({ max: 400 }),
  infiniteGold: z2.boolean(),
  infiniteTroops: z2.boolean(),
  instantBuild: z2.boolean(),
  disableNavMesh: z2.boolean().optional(),
  disableAlliances: z2.boolean().nullable().optional(),
  disableClanTags: z2.boolean().optional(),
  // Opt-in live game stats reporting for the admin bot. Off by default and has
  // no UI — the admin bot sets it when creating tournament games, since it adds
  // per-client traffic. See LiveStatsController / GameServer.handleLiveStats.
  liveStatsEnabled: z2.boolean().optional(),
  anonymizeNames: z2.boolean().optional(),
  // While anonymizeNames is on, clientIDs the host has granted real-name
  // visibility to (e.g. casters / observers). Everyone else stays anonymized.
  nameReveals: z2.string().array().optional(),
  // Like nameReveals but keyed by stable account publicId (for automated hosts
  // that only know publicIds at create_game); resolved to clientID at lookup.
  nameRevealPublicIds: z2.string().array().max(200).optional(),
  waterNukes: z2.boolean().nullable().optional(),
  randomSpawn: z2.boolean(),
  maxPlayers: uint().optional(),
  // OFM: allowlist of publicIds allowed to join (admin-only, see create_game).
  allowedPublicIds: z2.array(z2.string()).max(200).optional(),
  // Only accounts the API reports as trusted (users/@me `trustTier`) may join.
  // Enforced server-side at join (GameServer.joinClient); advertised in the
  // lobby browser so a card can show a lock. No host UI yet: set through
  // create_game / update_game_config.
  trusted: z2.boolean().optional(),
  maxTimerValue: uint({ min: 1, max: 120 }).nullable().optional(),
  // In minutes
  customAllianceDuration: uint({ max: 15 }).nullable().optional(),
  // In minutes; 0 disables alliances
  startDelay: uint({ max: 600 }).nullable().optional(),
  // In seconds
  spawnImmunityDuration: uint().nullable().optional(),
  // In ticks
  disabledUnits: z2.enum(UnitType).array().optional(),
  playerTeams: TeamCountConfigSchema.optional(),
  goldMultiplier: float({ min: 0.1, max: 1e3 }).nullable().optional(),
  startingGold: uint({ max: 1e9 }).nullable().optional(),
  hostCheats: z2.object({
    infiniteGold: z2.boolean().optional(),
    infiniteTroops: z2.boolean().optional(),
    goldMultiplier: float({ min: 0.1, max: 1e3 }).nullable().optional(),
    startingGold: uint({ max: 1e9 }).nullable().optional()
  }).optional(),
  // Stripped from gameStartInfo and from the advertised lobby config: sibling
  // ids are private lobby ids, which are join secrets.
  pool: PoolConfigSchema.optional()
});
var PublicGameTypeSchema = z2.enum(["ffa", "team", "special", "hosted"]);
var LobbyLabelSchema = z2.string().refine((v) => Array.from(v).length <= 48);
var LobbyAccentSchema = z2.enum(["gold", "blue", "green", "red"]);
var PublicGameInfoSchema = z2.object({
  gameID: z2.string(),
  numClients: uint(),
  startsAt: uint().optional(),
  gameConfig: z2.lazy(() => GameConfigSchema).optional(),
  publicGameType: PublicGameTypeSchema,
  // Featured lobbies only. Both optional so a client on an older build simply
  // renders the map name as it does today.
  label: LobbyLabelSchema.optional(),
  accent: LobbyAccentSchema.optional(),
  featured: z2.boolean().optional(),
  // Hosted lobbies only: server timestamp when the listing auto-starts, so
  // the lobby browser can show a countdown before the host presses Start.
  autoStartAt: uint().optional(),
  // A player's listed lobby (hosted, or paid into a public queue) rather
  // than one the server scheduled, so the browser can label it Custom.
  // Featured lobbies are official events and never carry it.
  custom: z2.boolean().optional()
});
var PublicGamesSchema = z2.object({
  serverTime: uint(),
  // partialRecord: every consumer already treats buckets as optional, and it
  // lets clients tolerate servers that don't send every lobby type.
  games: z2.partialRecord(PublicGameTypeSchema, z2.array(PublicGameInfoSchema))
});
var PublicLobbyFullSchema = z2.object({
  type: z2.literal("full"),
  serverTime: uint(),
  games: z2.partialRecord(PublicGameTypeSchema, z2.array(PublicGameInfoSchema)),
  // Build commit of the serving deployment. Clients on the homepage compare
  // it to their own bundle's commit to detect that a new version deployed
  // and prompt a refresh. Optional only so a server can omit it in tests; a
  // bundle built before this field cannot decode the frame at all (zbin
  // presence header shifts), which is the usual ship-together tradeoff.
  gitCommit: z2.string().max(64).optional(),
  // False when the serving deployment is draining: the load balancer routes
  // elsewhere and this one has stopped queueing public lobbies, so a pinned
  // tab would watch the list empty out. Clients respond with the same reload
  // prompt as a commit mismatch — which cannot catch this case by itself,
  // because the pinned server reports its own commit and a same-commit
  // blue/green flip keeps them equal. Absent means active.
  active: z2.boolean().optional()
});
var PublicLobbyCountsSchema = z2.object({
  type: z2.literal("counts"),
  serverTime: uint(),
  counts: z2.record(z2.string(), uint())
});
var PublicLobbyMessageSchema = discriminatedUnion("type", [
  PublicLobbyFullSchema,
  PublicLobbyCountsSchema
]);
var decodeLobbyMessage = (bytes) => PublicLobbyMessageSchema.parseBytes(bytes);
var encodeLobbyMessage = (message) => PublicLobbyMessageSchema.serialize(message);
var MAPS = Object.values(GameMapType);
var MODES = Object.values(GameMode);
var SUPPORTED_BUILD = "817c12927c4ec34ec68c74c780a74a14fb776d09";
export {
  Difficulty,
  DoomsdayClockConfigSchema,
  GameConfigSchema,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  MAPS,
  MODES,
  OvertimeConfigSchema,
  PoolConfigSchema,
  PublicGameInfoSchema,
  PublicGamesSchema,
  PublicLobbyCountsSchema,
  PublicLobbyFullSchema,
  PublicLobbyMessageSchema,
  RankedType,
  SUPPORTED_BUILD,
  UnitType,
  decodeLobbyMessage,
  encodeLobbyMessage
};
