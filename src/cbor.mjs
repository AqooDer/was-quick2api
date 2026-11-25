// Minimal CBOR (RFC 8949) codec covering the shapes used by the gateway bidi
// transport: maps, strings, byte strings, arrays, integers, booleans, null.
import { EventStreamError } from './eventstream.mjs';

function encodeHead(major, n, out) {
  if (n < 24) {
    out.push((major << 5) | n);
  } else if (n <= 0xff) {
    out.push((major << 5) | 24, n);
  } else if (n <= 0xffff) {
    out.push((major << 5) | 25, (n >> 8) & 0xff, n & 0xff);
  } else if (n <= 0xffffffff) {
    out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  } else {
    out.push((major << 5) | 27);
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64BE(BigInt(n));
    for (const byte of b) out.push(byte);
  }
}

function encodeInto(value, out) {
  if (value === null || value === undefined) {
    out.push(0xf6);
  } else if (value === true) {
    out.push(0xf5);
  } else if (value === false) {
    out.push(0xf4);
  } else if (typeof value === 'bigint') {
    if (value >= 0n) encodeHead(0, value, out);
    else encodeHead(1, -1n - value, out);
  } else if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      encodeHead(0, value, out);
    } else if (Number.isSafeInteger(value) && value < 0) {
      encodeHead(1, -1 - value, out);
    } else {
      out.push(0xfb);
      const b = Buffer.allocUnsafe(8);
      b.writeDoubleBE(value);
      for (const byte of b) out.push(byte);
    }
  } else if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    encodeHead(3, b.length, out);
    out.push(...b);
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const b = Buffer.from(value);
    encodeHead(2, b.length, out);
    out.push(...b);
  } else if (Array.isArray(value)) {
    encodeHead(4, value.length, out);
    for (const item of value) encodeInto(item, out);
  } else if (value instanceof Map) {
    encodeHead(5, value.size, out);
    for (const [k, v] of value) {
      encodeInto(k, out);
      encodeInto(v, out);
    }
  } else if (typeof value === 'object') {
    const keys = Object.keys(value);
    encodeHead(5, keys.length, out);
    for (const k of keys) {
      encodeInto(k, out);
      encodeInto(value[k], out);
    }
  } else {
    throw new EventStreamError(`cannot CBOR-encode ${typeof value}`);
  }
}

export function cborEncode(value) {
  const out = [];
  encodeInto(value, out);
  return Buffer.from(out);
}

function readLength(data, i, info) {
  if (info < 24) return [info, i];
  if (info === 24) {
    if (i + 1 > data.length) throw new EventStreamError('truncated CBOR uint8');
    return [data[i], i + 1];
  }
  if (info === 25) {
    if (i + 2 > data.length) throw new EventStreamError('truncated CBOR uint16');
    return [data.readUInt16BE(i), i + 2];
  }
  if (info === 26) {
    if (i + 4 > data.length) throw new EventStreamError('truncated CBOR uint32');
    return [data.readUInt32BE(i), i + 4];
  }
  if (info === 27) {
    if (i + 8 > data.length) throw new EventStreamError('truncated CBOR uint64');
    const v = data.readBigUInt64BE(i);
    return [v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v, i + 8];
  }
  throw new EventStreamError(`unsupported CBOR additional info ${info}`);
}

function decodeAt(data, i) {
  if (i >= data.length) throw new EventStreamError('truncated CBOR');
  const initial = data[i];
  i += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;

  if (major === 7) {
    if (info === 20) return [false, i];
    if (info === 21) return [true, i];
    if (info === 22) return [null, i];
    if (info === 25) {
      if (i + 2 > data.length) throw new EventStreamError('truncated CBOR float16');
      return [data.readUInt16BE(i), i + 2];
    }
    if (info === 26) {
      if (i + 4 > data.length) throw new EventStreamError('truncated CBOR float32');
      return [data.readFloatBE(i), i + 4];
    }
    if (info === 27) {
      if (i + 8 > data.length) throw new EventStreamError('truncated CBOR float64');
      return [data.readDoubleBE(i), i + 8];
    }
    throw new EventStreamError(`unsupported CBOR simple value ${info}`);
  }

  const [n, next] = readLength(data, i, info);
  i = next;
  switch (major) {
    case 0:
      return [n, i];
    case 1:
      return [typeof n === 'bigint' ? -1n - n : -1 - n, i];
    case 2: {
      const end = i + Number(n);
      if (end > data.length) throw new EventStreamError('truncated CBOR bytes');
      return [Buffer.from(data.subarray(i, end)), end];
    }
    case 3: {
      const end = i + Number(n);
      if (end > data.length) throw new EventStreamError('truncated CBOR string');
      return [data.toString('utf8', i, end), end];
    }
    case 4: {
      const arr = [];
      for (let k = 0; k < Number(n); k++) {
        const [item, ni] = decodeAt(data, i);
        arr.push(item);
        i = ni;
      }
      return [arr, i];
    }
    case 5: {
      const map = {};
      for (let k = 0; k < Number(n); k++) {
        const [key, ni] = decodeAt(data, i);
        const [val, vi] = decodeAt(data, ni);
        map[String(key)] = val;
        i = vi;
      }
      return [map, i];
    }
    case 6: {
      const [, ni] = decodeAt(data, i);
      return decodeAt(data, ni);
    }
    default:
      throw new EventStreamError(`unsupported CBOR major type ${major}`);
  }
}

export function cborDecode(data) {
  return decodeAt(data, 0)[0];
}
