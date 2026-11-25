// AWS event-stream framing used by the Quick DataPlane bidi transport.
// [total_len:4][headers_len:4][prelude_crc:4][headers][payload][message_crc:4]
import { crc32 } from 'node:zlib';

const HV_BOOL_TRUE = 0;
const HV_BOOL_FALSE = 1;
const HV_BYTE = 2;
const HV_SHORT = 3;
const HV_INT = 4;
const HV_LONG = 5;
const HV_BYTES = 6;
const HV_STRING = 7;
const HV_TIMESTAMP = 8;
const HV_UUID = 9;

const MAX_FRAME = 16 * 1024 * 1024;

function encodeHeaders(headers) {
  const parts = [];
  for (const name of Object.keys(headers).sort()) {
    const value = headers[name];
    if (value === undefined || value === null) continue;
    const nameBuf = Buffer.from(name, 'utf8');
    const valueBuf = Buffer.from(String(value), 'utf8');
    if (nameBuf.length > 255) throw new Error('event-stream header name too long');
    if (valueBuf.length > 65535) throw new Error('event-stream header value too long');
    const head = Buffer.alloc(1 + nameBuf.length + 1 + 2);
    head[0] = nameBuf.length;
    nameBuf.copy(head, 1);
    head[1 + nameBuf.length] = HV_STRING;
    head.writeUInt16BE(valueBuf.length, 1 + nameBuf.length + 1);
    parts.push(head, valueBuf);
  }
  return Buffer.concat(parts);
}

export function encodeMessage(headers, payload) {
  const headerBuf = encodeHeaders(headers);
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const total = 4 + 4 + 4 + headerBuf.length + body.length + 4;
  const msg = Buffer.allocUnsafe(total);
  msg.writeUInt32BE(total, 0);
  msg.writeUInt32BE(headerBuf.length, 4);
  msg.writeUInt32BE(crc32(msg.subarray(0, 8)) >>> 0, 8);
  headerBuf.copy(msg, 12);
  body.copy(msg, 12 + headerBuf.length);
  msg.writeUInt32BE(crc32(msg.subarray(0, total - 4)) >>> 0, total - 4);
  return msg;
}

export class EventStreamError extends Error {}

function decodeHeaders(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const nameLen = buf[i];
    i += 1;
    if (i + nameLen > buf.length) throw new EventStreamError('truncated header name');
    const name = buf.toString('utf8', i, i + nameLen);
    i += nameLen;
    if (i >= buf.length) throw new EventStreamError('truncated header type');
    const type = buf[i];
    i += 1;
    switch (type) {
      case HV_BOOL_TRUE:
        out[name] = true;
        break;
      case HV_BOOL_FALSE:
        out[name] = false;
        break;
      case HV_BYTE:
        if (i + 1 > buf.length) throw new EventStreamError('truncated byte header');
        out[name] = buf[i];
        i += 1;
        break;
      case HV_SHORT:
        if (i + 2 > buf.length) throw new EventStreamError('truncated short header');
        out[name] = buf.readUInt16BE(i);
        i += 2;
        break;
      case HV_INT:
        if (i + 4 > buf.length) throw new EventStreamError('truncated int header');
        out[name] = buf.readUInt32BE(i);
        i += 4;
        break;
      case HV_LONG:
      case HV_TIMESTAMP: {
        if (i + 8 > buf.length) throw new EventStreamError('truncated long header');
        const v = buf.readBigUInt64BE(i);
        out[name] = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        i += 8;
        break;
      }
      case HV_BYTES: {
        if (i + 2 > buf.length) throw new EventStreamError('truncated bytes header');
        const n = buf.readUInt16BE(i);
        i += 2;
        if (i + n > buf.length) throw new EventStreamError('truncated bytes header value');
        out[name] = buf.subarray(i, i + n);
        i += n;
        break;
      }
      case HV_STRING: {
        if (i + 2 > buf.length) throw new EventStreamError('truncated string header');
        const n = buf.readUInt16BE(i);
        i += 2;
        if (i + n > buf.length) throw new EventStreamError('truncated string header value');
        out[name] = buf.toString('utf8', i, i + n);
        i += n;
        break;
      }
      case HV_UUID:
        if (i + 16 > buf.length) throw new EventStreamError('truncated uuid header');
        out[name] = buf.subarray(i, i + 16);
        i += 16;
        break;
      default:
        throw new EventStreamError(`unsupported event header type ${type}`);
    }
  }
  return out;
}

/**
 * Decode every complete message in buf.
 * @returns {{messages: Array<{headers: object, payload: Buffer}>, consumed: number, error?: Error}}
 */
export function decodeMessages(buf) {
  const messages = [];
  let pos = 0;
  try {
    while (pos + 16 <= buf.length) {
      const total = buf.readUInt32BE(pos);
      if (total < 16 || total > MAX_FRAME) {
        return { messages, consumed: pos, error: new EventStreamError(`invalid frame length ${total}`) };
      }
      if (pos + total > buf.length) break;
      const headersLen = buf.readUInt32BE(pos + 4);
      const hstart = pos + 12;
      const hend = hstart + headersLen;
      if (hend > pos + total - 4 || hend < hstart) {
        return { messages, consumed: pos, error: new EventStreamError(`invalid header length ${headersLen}`) };
      }
      const headers = decodeHeaders(buf.subarray(hstart, hend));
      const payload = Buffer.from(buf.subarray(hend, pos + total - 4));
      messages.push({ headers, payload });
      pos += total;
    }
  } catch (err) {
    return { messages, consumed: pos, error: err };
  }
  return { messages, consumed: pos };
}

export function headerString(headers, key) {
  const v = headers?.[key];
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return '';
}
