import { WebSocket } from 'ws';
import { uuid, parseDuration, byteLength } from './util.mjs';
import { decodeInbound, encodeOutbound, isGatewayProvider } from './wire.mjs';
import { titleFor } from './translate.mjs';

const DEFAULT_WS_PATH = '/streaming/quickwork-chat-bidirectional-stream';
const DEFAULT_GATEWAY_WS_PATH = '/ws/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream';
const MAX_FRAME_BYTES = 63 * 1024;

export class UpstreamError extends Error {
  constructor(message, { status = 0, code = '', cause } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

class TimeoutError extends Error {
  constructor(message = 'upstream read timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * One upstream WebSocket connection. Frames are decoded into JSON strings and
 * queued so read loops can await the next event with a timeout.
 */
class Connection {
  constructor(ws, gateway) {
    this.ws = ws;
    this.gateway = gateway;
    this.queue = [];
    this.waiters = [];
    this.closed = null;
    this.counts = new Map();

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          for (const json of decodeInbound(Buffer.from(data), gateway)) this.push(json);
        } else {
          this.push(Buffer.from(data).toString('utf8'));
        }
      } catch (err) {
        this.fail(err);
      }
    });
    ws.on('error', (err) => this.fail(err));
    ws.on('close', (code, reason) => {
      this.fail(new UpstreamError(`upstream WebSocket closed (${code}${reason?.length ? `: ${reason.toString()}` : ''})`));
    });
    ws.on('ping', () => {
      try {
        ws.pong();
      } catch {
        // ignore
      }
    });
  }

  push(json) {
    let value;
    try {
      value = JSON.parse(json);
    } catch {
      return;
    }
    if (typeof value?.type === 'string') this.counts.set(value.type, (this.counts.get(value.type) || 0) + 1);
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else {
      this.queue.push(value);
    }
  }

  fail(err) {
    if (this.closed) return;
    this.closed = err instanceof Error ? err : new UpstreamError(String(err));
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(this.closed);
    }
  }

  next(timeoutMs) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new TimeoutError());
      }, Math.max(1, timeoutMs));
      this.waiters.push(waiter);
    });
  }

  sendObject(value) {
    const json = JSON.stringify(value);
    this.ws.send(encodeOutbound(json, this.gateway), { binary: true });
  }

  ping() {
    try {
      this.ws.ping();
    } catch {
      // ignore
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

function normalizeHost(hostRaw) {
  let host = String(hostRaw || '').trim();
  if (host.startsWith('wss://') || host.startsWith('ws://')) return host.replace(/\/+$/, '');
  if (host.startsWith('https://')) return `wss://${host.slice('https://'.length)}`.replace(/\/+$/, '');
  if (host.startsWith('http://')) return `ws://${host.slice('http://'.length)}`.replace(/\/+$/, '');
  return `wss://${host.replace(/\/+$/, '')}`;
}

export function dialInfo(account, cfg) {
  const gateway = isGatewayProvider(account.provider);
  const jwt = String(account.id_token || account.access_token || '').trim();
  if (!jwt) throw new UpstreamError('account has no jwt/id_token');
  const host = normalizeHost(account.ws_host);
  if (!host) throw new UpstreamError('account has no ws_host');

  let path = String(account.ws_path || '').trim() || (gateway ? DEFAULT_GATEWAY_WS_PATH : DEFAULT_WS_PATH);
  if (/^https?:\/\//.test(path)) {
    // Absolute endpoint, used as-is.
  } else {
    if (!path.startsWith('/')) path = `/${path}`;
  }
  let url;
  if (/^https?:\/\//.test(path)) {
    url = new URL(path);
  } else {
    url = new URL(`${host}${path}`);
  }

  if (!gateway) {
    const surface = String(cfg.surface || '').trim();
    if (surface) url.searchParams.set('surfaceType', surface);
    if (cfg.outpost_id) url.searchParams.set('outpostId', cfg.outpost_id);
    if (cfg.working_session_id) url.searchParams.set('workingSessionId', cfg.working_session_id);
    if (String(account.provider).toLowerCase() === 'social') url.searchParams.set('token', jwt);
  }

  const headers = {
    authorization: `Bearer ${jwt}`,
    origin: 'file://',
    'x-surface-type': String(cfg.surface || ''),
    'x-outpost-id': String(cfg.outpost_id || ''),
    'x-agent-service-type': 'UNIFIED_QUICK',
  };
  if (cfg.working_session_id) headers['x-working-session-id'] = String(cfg.working_session_id);
  return { url: url.toString(), headers, gateway };
}

function userMessageBytes(payload) {
  return byteLength(JSON.stringify({ type: 'user_message', payload }));
}

function shrinkMiddle(s, remove) {
  const marker = '\n\n[earlier conversation trimmed to fit the upstream 64 KB frame limit]\n\n';
  const minKeep = 4096;
  let target = s.length - remove - marker.length;
  if (target < minKeep) target = minKeep;
  if (target >= s.length) return s;
  let head = Math.floor(target / 4);
  for (let i = 0; i < 8 && head > 0 && head < s.length && !isRuneStart(s, head); i++) head--;
  let tailStart = s.length - (target - head);
  if (tailStart < head) tailStart = head;
  while (tailStart < s.length && !isRuneStart(s, tailStart)) tailStart++;
  return s.slice(0, head) + marker + s.slice(tailStart);
}

function isRuneStart(s, index) {
  const code = s.charCodeAt(index);
  return !(code >= 0xdc00 && code <= 0xdfff);
}

/** Keep one user_message JSON under the upstream frame limit. */
export function fitUserMessage(payload, limit = MAX_FRAME_BYTES) {
  let size = userMessageBytes(payload);
  if (size <= limit) return size;
  const original = size;
  let text = typeof payload.text === 'string' ? payload.text : '';
  if (text.length > 4096) {
    for (let i = 0; i < 6 && size > limit; i++) {
      payload.text = shrinkMiddle(text, size - limit);
      if (payload.text === text) break;
      text = payload.text;
      size = userMessageBytes(payload);
    }
  }
  if (size > limit) throw new UpstreamError(`user_message exceeds the upstream 64 KB frame limit (${size} bytes)`);
  return original;
}

function deltaText(payload) {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    if (typeof payload.delta === 'string') return payload.delta;
    if (typeof payload.text === 'string') return payload.text;
  }
  return '';
}

function errorText(payload, fallback, code) {
  const nested = (v) => {
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) {
      for (const item of v) {
        const s = nested(item);
        if (s) return s;
      }
    }
    if (v && typeof v === 'object') {
      for (const key of ['message', 'error', 'detail', 'reason', 'description', 'title']) {
        const s = nested(v[key]);
        if (s) return s;
      }
    }
    return '';
  };
  const fromPayload = nested(payload);
  if (fromPayload) return fromPayload.slice(0, 800);
  if (payload !== undefined && payload !== null) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (body && body.trim()) return body.slice(0, 800);
  }
  return fallback || code || 'unknown upstream error';
}

function emptyUsage() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function addUsage(target, p) {
  const prompt = Math.max(0, Number(p.input_tokens) || 0);
  const completion = Math.max(0, Number(p.output_tokens) || 0);
  const cacheRead = Math.max(0, Number(p.cache_read_tokens) || 0);
  const cacheWrite = Math.max(0, Number(p.cache_write_tokens) || 0);
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += prompt + completion;
  target.cacheReadTokens += cacheRead;
  target.cacheWriteTokens += cacheWrite;
  if (Number.isFinite(p.cost_usd) && p.cost_usd >= 0) target.costUsd += Number(p.cost_usd);
}

export class Upstream {
  constructor(cfg, { logger = () => {} } = {}) {
    this.cfg = cfg;
    this.logger = logger;
  }

  async connect(account, { timeoutMs = 20_000 } = {}) {
    const { url, headers, gateway } = dialInfo(account, this.cfg);
    const ws = new WebSocket(url, {
      headers,
      handshakeTimeout: timeoutMs,
      perMessageDeflate: false,
      maxPayload: 32 * 1024 * 1024,
    });
    let status = 0;
    ws.on('unexpected-response', (_req, res) => {
      status = res.statusCode;
      res.resume();
    });
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(new UpstreamError(`upstream WebSocket dial failed${status ? ` HTTP ${status}` : ''}: ${err.message}`, { status }));
      };
      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('error', onError);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
    return new Connection(ws, gateway);
  }

  /**
   * Send one or more user turns on a fresh or resumed thread. Returns the
   * result of the final turn; setup turns only wait for completion.
   */
  async chat(account, input, { signal } = {}) {
    const gateway = isGatewayProvider(account.provider);
    const threadId = String(input.threadId || '').trim() || uuid();
    const title = String(input.title || '').trim() || titleFor(input.turns?.[0] || '');
    const conn = await this.connect(account);
    const deadline = Date.now() + (input.timeoutMs || this.cfg.request_timeout_ms || 600_000);
    let pingTimer = null;
    let failed = false;

    try {
      if (signal?.aborted) throw new UpstreamError('request aborted');
      const onAbort = () => conn.close();
      signal?.addEventListener('abort', onAbort, { once: true });
      pingTimer = setInterval(() => {
        conn.ping();
        // Some Quick deployments count only data frames toward the 95s
        // client-idle limit; the control ping alone is not enough.
        try {
          conn.sendObject({ type: 'ping', payload: {} });
        } catch {
          // connection is closing
        }
      }, 20_000);
      pingTimer.unref?.();

      if (gateway) {
        conn.sendObject({ type: 'session_connect', session_id: this.cfg.outpost_id || '' });
      } else {
        conn.sendObject({
          type: 'session_connect',
          payload: {
            actor_id: account.actor_arn || '',
            surfaceType: account.surface || this.cfg.surface,
            outpostId: this.cfg.outpost_id || '',
            appVersion: this.cfg.app_version,
            external_agent_sign_in: 1,
            recents_promotion: 1,
          },
        });
      }
      conn.sendObject({ type: 'federate_status', payload: {} });
      if (input.createSession) {
        conn.sendObject({ type: 'session_create', payload: { session_id: threadId, title } });
      }

      let last = null;
      const turns = input.turns?.length ? input.turns : [input.text || ''];
      for (let i = 0; i < turns.length; i++) {
        if (signal?.aborted) throw new UpstreamError('request aborted');
        const isLast = i === turns.length - 1;
        last = await this.runTurn(conn, {
          text: turns[i],
          model: input.model,
          threadId,
          deadline,
          collect: isLast,
          allowedTools: input.allowedTools,
          signal,
        });
      }

      if (input.deleteSession) {
        try {
          conn.sendObject({ type: 'session_delete', payload: { session_id: threadId } });
        } catch {
          // best effort
        }
      }
      return { ...last, threadId };
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      if (failed && input.deleteSessionOnError && input.createSession) {
        try {
          conn.sendObject({ type: 'session_delete', payload: { session_id: threadId } });
        } catch {
          // connection already closed
        }
      }
      if (pingTimer) clearInterval(pingTimer);
      conn.close();
    }
  }

  async runTurn(conn, { text, model, threadId, deadline, collect, allowedTools, signal }) {
    const messageId = uuid();
    const traceId = uuid();
    const payload = {
      text,
      send_origin: 'programmatic',
      had_physical_input: false,
      surfaceType: this.cfg.surface,
      outpostId: this.cfg.outpost_id || '',
      appVersion: this.cfg.app_version,
      traceId,
      message_id: messageId,
      thread_id: threadId,
      agent_mode: model,
      user_timezone: this.cfg.timezone,
      user_locale: this.cfg.locale,
      chat_agent_id: this.cfg.chat_agent_id || null,
      auto_routing: false,
      web_search_enabled: false,
      pre_approved_tools: [],
      preload_skills: [],
      panel_edits: [],
      custom_prompt: null,
    };
    if (this.cfg.thinking_effort) payload.thinking_effort = this.cfg.thinking_effort;
    fitUserMessage(payload, this.cfg.max_frame_bytes || MAX_FRAME_BYTES);
    conn.sendObject({ type: 'user_message', payload });

    const result = { text: '', toolCalls: [], usage: emptyUsage() };
    let turnText = '';
    let sawMessageComplete = false;
    let completeDeadline = 0;
    const toolMap = new Map();
    const toolOrder = [];
    const rawArgs = new Map();
    const argsPartial = new Map();
    let nativeDeadline = 0;
    let sawNative = false;
    const matchesAllowed = (name) => {
      const n = String(name || '').trim().toLowerCase();
      if (!n || !allowedTools) return false;
      for (const tool of allowedTools) {
        const t = String(tool).toLowerCase();
        if (n === t || n.endsWith(`.${t}`) || n.endsWith(`/${t}`) || n.endsWith(`_${t}`) || n.endsWith(`-${t}`)) return true;
      }
      return false;
    };

    const getTool = (idRaw, nameRaw) => {
      let id = String(idRaw || '').trim();
      if (!id) id = `call_${uuid().replace(/-/g, '')}`;
      let tc = toolMap.get(id);
      if (!tc) {
        tc = { id, name: '', arguments: '{}' };
        toolMap.set(id, tc);
        toolOrder.push(id);
      }
      if (nameRaw && String(nameRaw).trim()) tc.name = String(nameRaw).trim();
      return tc;
    };
    const setArgs = (tc, raw) => {
      if (tc == null || raw === undefined || raw === null) return;
      const textArgs = typeof raw === 'string' ? raw : JSON.stringify(raw);
      rawArgs.set(tc.id, textArgs);
      argsPartial.set(tc.id, false);
      tc.arguments = normalizeJsonArgs(textArgs);
    };
    const appendArgs = (tc, delta) => {
      if (!tc || !delta) return;
      if (!argsPartial.get(tc.id) && tc.arguments && tc.arguments !== '{}') return;
      rawArgs.set(tc.id, (rawArgs.get(tc.id) || '') + delta);
      argsPartial.set(tc.id, true);
      tc.arguments = normalizeJsonArgs(rawArgs.get(tc.id));
    };

    for (;;) {
      if (signal?.aborted) throw new UpstreamError('request aborted');
      if (Date.now() > deadline) throw new UpstreamError('upstream turn timed out', { code: 'timeout' });
      let wait = 120_000;
      if (sawMessageComplete && completeDeadline) wait = Math.max(0, completeDeadline - Date.now());
      if (nativeDeadline) wait = Math.min(wait, Math.max(0, nativeDeadline - Date.now()));
      if (wait <= 0) break;

      let frame;
      try {
        frame = await conn.next(Math.min(wait, Math.max(1, deadline - Date.now())));
      } catch (err) {
        // A close or a read timeout after message_complete still leaves a
        // complete turn; do not discard the collected answer.
        if (sawNative && nativeDeadline && Date.now() >= nativeDeadline) break;
        if (sawMessageComplete && completeDeadline) break;
        if (err instanceof TimeoutError && sawMessageComplete) break;
        throw err instanceof TimeoutError ? new UpstreamError('upstream read timed out', { code: 'timeout', cause: err }) : err;
      }

      const type = String(frame?.type || '');
      switch (type) {
        case 'message_start':
          sawMessageComplete = false;
          completeDeadline = 0;
          break;
        case 'text_delta': {
          const delta = deltaText(frame.payload);
          if (!delta) break;
          sawMessageComplete = false;
          completeDeadline = 0;
          if (collect) {
            turnText += delta;
            result.text = turnText;
          }
          break;
        }
        case 'text_complete': {
          if (collect && !turnText) {
            const p = frame.payload || {};
            const value = typeof p === 'string' ? p : p.text || '';
            if (value) {
              turnText += value;
              result.text = turnText;
            }
          }
          sawMessageComplete = true;
          break;
        }
        case 'turn_usage':
          if (frame.payload && typeof frame.payload === 'object') addUsage(result.usage, frame.payload);
          break;
        case 'tool_start':
        case 'tool_arguments':
        case 'tool_arguments_edited': {
          const p = frame.payload || {};
          if (type === 'tool_start') {
            sawMessageComplete = false;
            completeDeadline = 0;
          }
          const tc = getTool(p.tool_id || p.tool_call_id, p.tool_name);
          setArgs(tc, p.arguments);
          if (collect && matchesAllowed(tc.name)) {
            sawNative = true;
            nativeDeadline = Date.now() + 5000;
            this.logger('info', `native tool ${type} name=${tc.name} id=${tc.id} thread=${threadId}`);
          }
          break;
        }
        case 'tool_progress': {
          const p = frame.payload || {};
          const tc = getTool(p.tool_id || p.tool_call_id, p.tool_name);
          appendArgs(tc, p.input_delta || p.progress?.input_delta || '');
          break;
        }
        case 'tool_call':
        case 'tool_call_update':
        case 'tool_complete': {
          const p = frame.payload || {};
          const tc = getTool(p.tool_id || p.tool_call_id || p.toolCallId, p.tool_name || p.title);
          setArgs(tc, p.rawInput ?? p.raw_input ?? p.arguments);
          if (collect && matchesAllowed(tc.name)) {
            sawNative = true;
            nativeDeadline = Date.now() + 3000;
            this.logger('info', `native tool ${type} name=${tc.name} id=${tc.id} thread=${threadId}`);
          }
          break;
        }
        case 'message_complete': {
          const p = frame.payload || {};
          for (const item of Array.isArray(p.tool_calls) ? p.tool_calls : []) {
            const tc = getTool(item.id || item.tool_call_id, item.name || item.tool_name || item.function?.name);
            setArgs(tc, item.arguments ?? item.function?.arguments);
          }
          const nativeCalls = (Array.isArray(p.tool_calls) ? p.tool_calls : []).filter((item) =>
            matchesAllowed(item?.name || item?.tool_name || item?.function?.name),
          );
          if (nativeCalls.length > 0) {
            sawNative = true;
            nativeDeadline = Date.now() + 1000;
          }
          if (p.continuation_expected) {
            sawMessageComplete = false;
            completeDeadline = 0;
            if (sawNative) break;
          } else {
            sawMessageComplete = true;
            completeDeadline = Date.now() + 5000;
          }
          break;
        }
        case 'turn_aborted':
          throw new UpstreamError('upstream turn was aborted', { code: 'turn_aborted' });
        case 'error':
        case 'session_error':
        case 'stream_error':
        case 'turn_failed': {
          const p = frame.payload || {};
          const code = frame.code || frame.error_code || p.code || p.error_code || '';
          const status = Number(p.status_code || p.status || 0);
          const message = errorText(frame.payload, frame.message || frame.error, code);
          throw new UpstreamError(`upstream ${type}: ${message}`, { status, code });
        }
        case 'ping':
          try {
            conn.ws.pong();
          } catch {
            // ignore
          }
          break;
        default:
          if (['turn_completed', 'turn_ended', 'stream_ended', 'chat_complete'].includes(type)) {
            sawMessageComplete = true;
            completeDeadline = 0;
          }
          break;
      }
      if (['turn_completed', 'turn_ended', 'stream_ended', 'chat_complete'].includes(type)) break;
    }

    if (collect) {
      result.text = turnText;
      result.native = sawNative;
      result.toolCalls = [];
      for (const id of toolOrder) {
        const tc = toolMap.get(id);
        if (!tc) continue;
        const raw = (rawArgs.get(id) || '').trim();
        if (raw) tc.arguments = normalizeJsonArgs(raw);
        if (!tc.name) tc.name = 'unknown';
        if (!tc.arguments) tc.arguments = '{}';
        result.toolCalls.push({ ...tc });
      }
    }
    return result;
  }
}

function normalizeJsonArgs(raw) {
  let value = raw;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || s === 'null') return '{}';
    try {
      value = JSON.parse(s);
    } catch {
      return '{}';
    }
  }
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

export { parseDuration };
