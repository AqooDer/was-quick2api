import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { encodeMessage } from '../src/eventstream.mjs';

/**
 * Minimal QuickWork DataPlane mock for social/AIDP accounts.
 *
 * It accepts the proxy's plain-JSON AIDP frames and answers with AWS
 * event-stream frames carrying the inner JSON events the proxy consumes.
 */
export class MockUpstream {
  constructor({ behavior, toolCall = null } = {}) {
    this.behavior = behavior;
    this.toolCall = toolCall;
    this.toolCallPending = Boolean(toolCall);
    this.userMessages = [];
    this.frames = [];
    this.connections = [];
    this.errors = [];
  }

  async start() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    await once(this.wss, 'listening');
    this.port = this.wss.address().port;
    return this;
  }

  async close() {
    for (const ws of this.connections) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => this.wss.close(resolve));
  }

  onConnection(ws, req) {
    this.connections.push(ws);
    this.lastRequest = { url: req.url, headers: req.headers };
    ws.on('message', (data, isBinary) => {
      const raw = Buffer.from(data).toString('utf8');
      let message;
      try {
        const outer = isBinary ? JSON.parse(raw) : JSON.parse(raw);
        if (outer?.eventType === 'rawInputEvent') {
          message = JSON.parse(Buffer.from(outer.payload.payload, 'base64').toString('utf8'));
        } else {
          message = outer;
        }
      } catch (err) {
        this.errors.push(err);
        return;
      }
      this.frames.push(message);
      this.handle(ws, message);
    });
  }

  handle(ws, message) {
    const type = message?.type;
    if (type === 'session_connect' || type === 'federate_status' || type === 'session_delete') return;
    if (type === 'session_create') {
      this.session = message.payload;
      return;
    }
    if (type !== 'user_message') return;

    const text = String(message.payload?.text || '');
    this.userMessages.push(text);
    const isSetup = /setup only|Reply with exactly: ACK|reply with exactly: ACK|do not answer yet/i.test(text);
    const index = this.userMessages.length;

    let reply;
    if (this.behavior) {
      reply = this.behavior({ text, isSetup, index, mock: this });
    } else if (isSetup) {
      reply = 'ACK';
    } else if (/Tool result \(call_id=/i.test(text)) {
      reply = 'MOCK_TOOL_DONE';
    } else if (this.toolCallPending) {
      this.toolCallPending = false;
      reply = `<client_tool_call>${JSON.stringify(this.toolCall)}</client_tool_call>`;
    } else {
      reply = 'MOCK_OK';
    }
    if (reply && typeof reply === 'object' && Array.isArray(reply.nativeTools)) {
      this.sendNativeTurn(ws, reply.nativeTools);
      return;
    }
    if (reply && typeof reply === 'object') reply = reply.text ?? '';
    this.sendTurn(ws, String(reply ?? ''));
  }

  sendNativeTurn(ws, calls) {
    const send = (type, payload) => {
      const inner = JSON.stringify({ type, payload });
      const body = JSON.stringify({ payload: Buffer.from(inner, 'utf8').toString('base64') });
      const frame = encodeMessage(
        { ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' },
        Buffer.from(body, 'utf8'),
      );
      if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
    };
    send('message_start', { message_id: 'native' });
    for (const call of calls) {
      send('tool_start', { tool_id: call.id || 'call_native', tool_name: call.name, arguments: {} });
      send('tool_arguments', { tool_id: call.id || 'call_native', tool_name: call.name, arguments: call.arguments });
      send('tool_call', { tool_call_id: call.id || 'call_native', tool_name: call.name, arguments: call.arguments });
    }
    send('message_complete', {
      continuation_expected: true,
      tool_calls: calls.map((call) => ({ id: call.id || 'call_native', name: call.name, arguments: call.arguments })),
    });
    send('turn_usage', { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    // Deliberately no turn_completed: the upstream is waiting for a tool result.
  }

  sendTurn(ws, text) {
    const send = (type, payload) => {
      const inner = JSON.stringify({ type, payload });
      const body = JSON.stringify({ payload: Buffer.from(inner, 'utf8').toString('base64') });
      const frame = encodeMessage(
        { ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' },
        Buffer.from(body, 'utf8'),
      );
      if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
    };
    send('message_start', { message_id: 'm1' });
    // Emit in a couple of chunks to exercise delta reassembly.
    for (let i = 0; i < text.length; i += 7) send('text_delta', text.slice(i, i + 7));
    send('message_complete', { continuation_expected: false });
    send('turn_usage', { input_tokens: 10, output_tokens: Math.ceil(text.length / 4), total_tokens: 10 + Math.ceil(text.length / 4) });
    send('turn_completed', {});
  }
}
