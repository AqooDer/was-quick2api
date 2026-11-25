// QuickWork DataPlane bidi transports.
//
// AIDP (social / enterprise):
//   outbound: UTF-8 JSON {"eventType":"rawInputEvent","payload":{"payload":b64}}
//   inbound:  AWS event-stream whose body is {"payload": b64(json)}
// Gateway (gateway / social_gateway):
//   outbound/inbound: AWS event-stream + CBOR {"payload": <json bytes>}
import { encodeMessage, decodeMessages, headerString } from './eventstream.mjs';
import { cborEncode, cborDecode } from './cbor.mjs';

export function isGatewayProvider(provider) {
  const p = String(provider || '').toLowerCase();
  return p === 'gateway' || p === 'social_gateway';
}

export function aidpEncode(jsonString) {
  const b64 = Buffer.from(jsonString, 'utf8').toString('base64');
  return Buffer.from(JSON.stringify({ eventType: 'rawInputEvent', payload: { payload: b64 } }), 'utf8');
}

function errorFromHeaders(headers) {
  const messageType = headerString(headers, ':message-type');
  if (messageType !== 'error' && messageType !== 'exception') return null;
  const code = headerString(headers, ':error-code') || headerString(headers, ':exception-type');
  const detail = headerString(headers, ':error-message');
  return new Error(`upstream error [${code}] ${detail}`.trim());
}

export function aidpDecode(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const { messages, error } = decodeMessages(buf);
  if (messages.length === 0) {
    // Some servers answer with a plain JSON text frame.
    try {
      return [JSON.parse(buf.toString('utf8'))].map((v) => JSON.stringify(v));
    } catch {
      throw error || new Error('decode AIDP event-stream: empty frame');
    }
  }
  const out = [];
  let firstError = null;
  for (const msg of messages) {
    const err = errorFromHeaders(msg.headers);
    if (err) {
      firstError ??= err;
      continue;
    }
    let outer;
    try {
      outer = JSON.parse(msg.payload.toString('utf8'));
    } catch (e) {
      firstError ??= new Error(`decode AIDP body: ${e.message}`);
      continue;
    }
    if (!outer || typeof outer.payload !== 'string' || outer.payload === '') {
      firstError ??= new Error('AIDP body has no payload');
      continue;
    }
    out.push(Buffer.from(outer.payload, 'base64').toString('utf8'));
  }
  if (out.length === 0 && firstError) throw firstError;
  return out;
}

export function gatewayEncode(jsonString) {
  const inner = cborEncode({ payload: Buffer.from(jsonString, 'utf8') });
  return encodeMessage(
    {
      ':event-type': 'rawInputEvent',
      ':content-type': 'application/cbor',
      ':message-type': 'event',
    },
    inner,
  );
}

export function gatewayDecode(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const { messages, error } = decodeMessages(buf);
  if (messages.length === 0) throw error || new Error('decode gateway event-stream: empty frame');
  const out = [];
  let firstError = null;
  for (const msg of messages) {
    const err = errorFromHeaders(msg.headers);
    if (err) {
      firstError ??= err;
      continue;
    }
    let value;
    try {
      value = cborDecode(msg.payload);
    } catch (e) {
      firstError ??= new Error(`decode gateway CBOR: ${e.message}`);
      continue;
    }
    if (!value || typeof value !== 'object') {
      firstError ??= new Error('gateway CBOR is not a map');
      continue;
    }
    const inner = value.payload;
    if (Buffer.isBuffer(inner)) out.push(inner.toString('utf8'));
    else if (typeof inner === 'string') out.push(inner);
    else firstError ??= new Error('gateway CBOR has no payload');
  }
  if (out.length === 0 && firstError) throw firstError;
  return out;
}

export function encodeOutbound(jsonString, gateway) {
  return gateway ? gatewayEncode(jsonString) : aidpEncode(jsonString);
}

export function decodeInbound(data, gateway) {
  return gateway ? gatewayDecode(data) : aidpDecode(data);
}
