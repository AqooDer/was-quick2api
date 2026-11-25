import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, decodeMessages, EventStreamError } from '../src/eventstream.mjs';
import { cborEncode, cborDecode } from '../src/cbor.mjs';
import { aidpEncode, aidpDecode, gatewayEncode, gatewayDecode } from '../src/wire.mjs';

function aidpFrame(type, payload) {
  const inner = JSON.stringify({ type, payload });
  const body = JSON.stringify({ payload: Buffer.from(inner).toString('base64') });
  return encodeMessage({ ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' }, Buffer.from(body));
}

test('event-stream round trips headers and payload', () => {
  const frame = encodeMessage({ ':message-type': 'event', ':event-type': 'text_delta', flag: 'yes' }, Buffer.from('hello'));
  const { messages, consumed, error } = decodeMessages(frame);
  assert.equal(error, undefined);
  assert.equal(consumed, frame.length);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].headers[':event-type'], 'text_delta');
  assert.equal(messages[0].headers.flag, 'yes');
  assert.equal(messages[0].payload.toString(), 'hello');
});

test('event-stream decodes multiple frames and keeps partial data', () => {
  const a = encodeMessage({ ':event-type': 'a' }, Buffer.from('one'));
  const b = encodeMessage({ ':event-type': 'b' }, Buffer.from('two'));
  const joined = Buffer.concat([a, b, b.subarray(0, 5)]);
  const { messages, consumed } = decodeMessages(joined);
  assert.equal(messages.length, 2);
  assert.equal(consumed, a.length + b.length);
  assert.equal(messages[1].payload.toString(), 'two');
});

test('event-stream rejects a bad frame length', () => {
  const bad = Buffer.alloc(20);
  bad.writeUInt32BE(4, 0);
  const { error } = decodeMessages(bad);
  assert.ok(error instanceof EventStreamError);
});

test('cbor round trips maps, bytes and arrays', () => {
  const encoded = cborEncode({ payload: Buffer.from('{"a":1}'), n: 42, ok: true, list: [1, 'x', null] });
  const decoded = cborDecode(encoded);
  assert.equal(decoded.payload.toString(), '{"a":1}');
  assert.equal(decoded.n, 42);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.list, [1, 'x', null]);
});

test('AIDP encodes and decodes a turn', () => {
  const out = aidpEncode('{"type":"user_message","payload":{"text":"hi"}}');
  const outer = JSON.parse(out.toString());
  assert.equal(outer.eventType, 'rawInputEvent');
  assert.equal(Buffer.from(outer.payload.payload, 'base64').toString(), '{"type":"user_message","payload":{"text":"hi"}}');

  const decoded = aidpDecode(aidpFrame('text_delta', 'hello'));
  assert.deepEqual(decoded, ['{"type":"text_delta","payload":"hello"}']);
});

test('AIDP surfaces upstream error headers', () => {
  const frame = encodeMessage(
    { ':message-type': 'error', ':error-code': 'AccessDenied', ':error-message': 'nope' },
    Buffer.from('{}'),
  );
  assert.throws(() => aidpDecode(frame), /AccessDenied/);
});

test('gateway frames round trip', () => {
  const frame = gatewayEncode('{"type":"text_delta","payload":"yo"}');
  assert.deepEqual(gatewayDecode(frame), ['{"type":"text_delta","payload":"yo"}']);
});
