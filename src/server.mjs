import http from 'node:http';
import crypto from 'node:crypto';
import { byteLength, safeEqual, sha256Hex, uuid } from './util.mjs';
import { mapModel } from './config.mjs';
import { publicAccount } from './accounts.mjs';
import { refreshAccount } from './oauth.mjs';
import { Upstream, UpstreamError } from './upstream.mjs';
import { ConversationStore, isPrefix } from './conversations.mjs';
import {
  buildToolBridgePrompt,
  buildToolBridgeRules,
  formatTranscript,
  groupToolDefinitions,
  hasVisibleText,
  lastUserText,
  limitToolCalls,
  nativeToolCalls,
  normalizeArguments,
  normalizeMessages,
  normalizeTools,
  parseClientToolCalls,
  parseToolChoice,
  planTurns,
  splitSystemMessages,
  RELAY_NOTICE,
  systemText,
  titleFor,
  toolNameSet,
} from './translate.mjs';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

class ClientError extends Error {
  constructor(message, { status = 400, type = 'invalid_request_error', code = '' } = {}) {
    super(message);
    this.name = 'ClientError';
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function log(logger, level, message) {
  logger(level, message);
}

export class QuickProxy {
  constructor(cfg, store, { logger = () => {} } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.logger = logger;
    this.upstream = new Upstream(cfg, { logger });
    this.conversations = new ConversationStore({ ttlMs: cfg.session_ttl_ms, max: 256 });
    this.accountLocks = new Map();
  }

  server() {
    return http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log(this.logger, 'error', `unhandled request error: ${err.stack || err.message}`);
        if (!res.headersSent) sendAnthropicError(res, 500, 'api_error', 'internal proxy error');
        else res.end();
      });
    });
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    res.on('error', () => {});
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-conversation-id, x-thread-id, x-claude-code-session-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, HEAD, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/healthz' || path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', service: 'quick2api', accounts: this.store.list().length }));
      return;
    }
    if (path === '/api/hello') {
      // Claude Code probes this endpoint before its first request.
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (!this.authorized(req)) {
      sendAnthropicError(res, 401, 'authentication_error', 'invalid proxy API key');
      return;
    }
    if (path === '/v1/models') {
      this.handleModels(res);
      return;
    }
    if (path === '/v1/messages/count_tokens') {
      await this.handleCountTokens(req, res);
      return;
    }
    if (path === '/v1/messages') {
      await this.handleMessages(req, res);
      return;
    }
    sendAnthropicError(res, 404, 'not_found_error', `unknown endpoint ${path}`);
  }

  authorized(req) {
    if (!this.cfg.api_keys || this.cfg.api_keys.length === 0) return true;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const apiKey = String(req.headers['x-api-key'] || '').trim();
    return this.cfg.api_keys.some((key) => safeEqual(key, bearer) || safeEqual(key, apiKey));
  }

  handleModels(res) {
    const created = Math.floor(Date.now() / 1000);
    const ids = ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', ...this.cfg.models];
    const data = [...new Set(ids)].map((id) => ({
      type: 'model',
      id,
      display_name: id,
      created_at: new Date(created * 1000).toISOString(),
    }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    }));
  }

  async handleCountTokens(req, res) {
    if (req.method !== 'POST') {
      sendAnthropicError(res, 405, 'invalid_request_error', 'POST required');
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendAnthropicError(res, err.status || 400, 'invalid_request_error', err.message);
      return;
    }
    let messages;
    const split = splitSystemMessages(body.messages);
    try {
      messages = normalizeMessages(split.messages);
    } catch (err) {
      sendAnthropicError(res, 400, 'invalid_request_error', err.message);
      return;
    }
    const system = [systemText(body.system), split.system].filter((s) => String(s || '').trim()).join('\n\n');
    const tools = normalizeTools(body.tools);
    const chars = byteLength(system) + byteLength(JSON.stringify(messages)) + byteLength(JSON.stringify(tools));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(chars / 4)) }));
  }

  async handleMessages(req, res) {
    if (req.method !== 'POST') {
      sendAnthropicError(res, 405, 'invalid_request_error', 'POST required');
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendAnthropicError(res, err.status || 400, 'invalid_request_error', err.message);
      return;
    }

    let messages;
    let tools;
    const split = splitSystemMessages(body.messages);
    try {
      messages = normalizeMessages(split.messages);
      tools = normalizeTools(body.tools);
    } catch (err) {
      sendAnthropicError(res, 400, 'invalid_request_error', err.message);
      return;
    }

    const system = [systemText(body.system), split.system].filter((s) => String(s || '').trim()).join('\n\n');
    const choice = parseToolChoice(body.tool_choice);
    if (body.tool_choice?.disable_parallel_tool_use === true) choice.parallel = false;
    const bridge = buildToolBridgePrompt(tools, choice);
    const rules = tools.length > 0 ? buildToolBridgeRules(choice) : '';
    const instructions = [system, bridge, RELAY_NOTICE].filter((s) => String(s || '').trim()).join('\n\n');
    const instructionsHash = sha256Hex(instructions);
    // Priming sends the system prompt and each tool-schema group as complete,
    // valid JSON chunks instead of cutting one giant string mid-object.
    const instructionParts = [];
    if (system.trim()) instructionParts.push({ title: 'system instructions', text: system.trim() });
    const finalParts = [];
    if (tools.length > 0) {
      const groups = groupToolDefinitions(tools, Math.max(4096, this.cfg.prime_chunk_bytes - 1024));
      groups.forEach((group, i) => {
        finalParts.push({
          title: `caller tool definitions${groups.length > 1 ? ` (${i + 1}/${groups.length})` : ''}`,
          text: `Caller tool definitions, forwarded verbatim:\n${JSON.stringify({ tools: group })}`,
        });
      });
      finalParts.push({ title: 'tool calling protocol', text: rules });
    }
    const finalPrefix = [
      '[System instructions from the API caller were provided in the setup turns above. Follow them exactly for this turn.]',
      '',
      `[Relay note] ${RELAY_NOTICE}`,
    ].join('\n');
    const allowed = toolNameSet(tools);
    const requestedModel = String(body.model || this.cfg.default_model);
    const upstreamModel = mapModel(this.cfg, requestedModel);
    const stream = body.stream === true;
    const responseModel = requestedModel || upstreamModel;
    const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;
    const inputEstimate = Math.max(1, Math.ceil((byteLength(system) + byteLength(JSON.stringify(messages)) + byteLength(JSON.stringify(tools))) / 4));
    const start = Date.now();

    let transcript;
    try {
      transcript = formatTranscript(messages);
    } catch (err) {
      sendAnthropicError(res, 400, 'invalid_request_error', err.message);
      return;
    }

    const key = this.conversationKey(req, instructions, messages);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    log(
      this.logger,
      'info',
      `chat start model=${requestedModel}->${upstreamModel} stream=${stream} messages=${messages.length} system_bytes=${byteLength(system)} tools=${tools.length} instruction_bytes=${byteLength(instructions)}`,
    );

    if (stream) {
      this.startSse(req, res);
      writeSse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: responseModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputEstimate, output_tokens: 0 },
        },
      });
      const keepalive = setInterval(() => {
        if (res.writableEnded) return;
        try {
          res.write(': keep-alive\n\n');
        } catch {
          // client is gone; the abort signal handles cleanup
        }
      }, 15_000);
      keepalive.unref?.();
      try {
        const result = await this.runProxy({ key, messages, instructions, instructionsHash, instructionParts, finalParts, finalPrefix, transcript, model: upstreamModel, title: titleFor(lastUserText(messages)), allowed, choice, abort: abort.signal });
        this.writeMessage(res, result, { stream: true, responseModel, messageId });
        log(
          this.logger,
          'info',
          `chat done model=${responseModel} elapsed=${Date.now() - start}ms text_chars=${result.text.length} tools=${result.toolCalls.length} tokens{prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens}} account=${accountLabel(result.account)}`,
        );
      } catch (err) {
        if (!abort.signal.aborted) {
          log(this.logger, 'error', `chat failed model=${responseModel} elapsed=${Date.now() - start}ms error=${err.message}`);
          writeSse(res, 'error', {
            type: 'error',
            error: { type: errorType(err), message: err.message },
          });
        }
      } finally {
        clearInterval(keepalive);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    try {
      const result = await this.runProxy({ key, messages, instructions, instructionsHash, instructionParts, finalParts, finalPrefix, transcript, model: upstreamModel, title: titleFor(lastUserText(messages)), allowed, choice, abort: abort.signal });
      log(
        this.logger,
        'info',
        `chat done model=${responseModel} elapsed=${Date.now() - start}ms text_chars=${result.text.length} tools=${result.toolCalls.length} tokens{prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens}} account=${accountLabel(result.account)}`,
      );
      this.writeMessage(res, result, { stream: false, responseModel, messageId });
    } catch (err) {
      if (abort.signal.aborted) return;
      log(this.logger, 'error', `chat failed model=${responseModel} elapsed=${Date.now() - start}ms error=${err.message}`);
      const status = errorStatus(err);
      sendAnthropicError(res, status, errorType(err), err.message);
    }
  }

  startSse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    req.socket?.setNoDelay?.(true);
  }

  writeMessage(res, result, { stream, responseModel, messageId }) {
    const text = result.text;
    const calls = result.toolCalls;
    const stopReason = calls.length > 0 ? 'tool_use' : 'end_turn';
    const usage = {
      input_tokens: result.usage.promptTokens,
      output_tokens: result.usage.completionTokens,
      ...(result.usage.cacheReadTokens > 0 ? { cache_read_input_tokens: result.usage.cacheReadTokens } : {}),
      ...(result.usage.cacheWriteTokens > 0 ? { cache_creation_input_tokens: result.usage.cacheWriteTokens } : {}),
    };

    if (!stream) {
      const content = [];
      if (hasVisibleText(text) || calls.length === 0) content.push({ type: 'text', text });
      for (const call of calls) {
        let input;
        try {
          input = JSON.parse(call.arguments);
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: responseModel,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage,
      }));
      return;
    }

    let index = 0;
    if (hasVisibleText(text) || calls.length === 0) {
      writeSse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      if (text) writeSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
    for (const call of calls) {
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      });
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: call.arguments || '{}' },
      });
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
    writeSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    });
    writeSse(res, 'message_stop', { type: 'message_stop' });
  }

  conversationKey(req, instructions, messages) {
    for (const header of ['x-conversation-id', 'x-thread-id', 'x-claude-code-session-id']) {
      const id = String(req.headers[header] || '').trim();
      if (id) return `h:${header}:${id}`;
    }
    const firstUser = messages.find((m) => m.role === 'user');
    const firstText = firstUser ? firstUser.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    return `c:${sha256Hex([req.headers.authorization || '', instructions, firstText].join('\0'))}`;
  }

  async runProxy({ key, messages, instructions, instructionsHash, instructionParts, finalParts, finalPrefix, transcript, model, title, allowed, choice, abort }) {
    const { entry, release } = await this.conversations.lock(key);
    try {
      const maxAttempts = Math.max(1, Number(this.cfg.max_attempts) || 1);
      const excluded = new Set();
      const refreshed = new Set();
      let resume = Boolean(
        this.cfg.session_reuse &&
          entry.threadId &&
          entry.accountId &&
          entry.instructionsHash === instructionsHash &&
          isPrefix(entry.messages, messages),
      );
      let lastErr = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (abort?.aborted) throw new ClientError('request aborted', { status: 499, type: 'api_error' });
        let account = null;
        if (resume) {
          account = this.store.pickPinned(entry.accountId);
          if (!account) {
            resume = false;
            this.conversations.reset(entry);
          }
        }
        if (!account) {
          account = this.store.pick(excluded);
          if (!account && excluded.size > 0 && attempt < maxAttempts) {
            excluded.clear();
            account = this.store.pick(excluded);
          }
        }
        if (!account) {
          const available = this.store.list().filter((a) => !a.disabled).length;
          if (available > 0) {
            throw lastErr || new UpstreamError('all Quick accounts failed; run `quick2api login` or `quick2api refresh`', { status: 502, code: 'accounts_failed' });
          }
          throw new ClientError(
            'no Quick account is logged in. Run `quick2api login` first.',
            { status: 503, type: 'api_error', code: 'no_account' },
          );
        }

        try {
          account = await this.refreshIfNeeded(account);
        } catch (err) {
          account.last_error = err.message;
          this.store.update(account.id, { last_error: err.message });
          log(this.logger, 'warn', `token refresh failed for ${accountLabel(account)}: ${err.message}`);
        }

        let turns;
        let useResume = resume;
        if (useResume) {
          const delta = messages.slice(entry.messages.length);
          let deltaText = '';
          try {
            deltaText = formatTranscript(delta);
          } catch {
            deltaText = '';
          }
          if (!hasVisibleText(deltaText)) {
            useResume = false;
            this.conversations.reset(entry);
          } else {
            turns = planTurns({
              instructions: '',
              transcript: deltaText,
              maxBytes: this.cfg.max_frame_bytes - 1024,
              chunkBytes: this.cfg.prime_chunk_bytes,
            });
          }
        }
        if (!useResume) {
          turns = planTurns({
            instructions,
            transcript,
            parts: instructionParts,
            finalParts,
            finalPrefix,
            maxBytes: this.cfg.max_frame_bytes - 1024,
            chunkBytes: this.cfg.prime_chunk_bytes,
          });
        }

        const threadId = useResume ? entry.threadId : uuid();
        log(
          this.logger,
          'info',
          `chat attempt=${attempt}/${maxAttempts} account=${accountLabel(account)} resume=${useResume} thread=${threadId} turns=${turns.length} turn_bytes=${turns.map((t) => byteLength(t)).join(',')}`,
        );
        try {
          const result = await this.upstream.chat(
            account,
            {
              turns,
              model,
              threadId,
              title,
              createSession: !useResume,
              deleteSession: !this.cfg.session_reuse && !this.cfg.keep_sessions,
              timeoutMs: this.cfg.request_timeout_ms,
            },
            { signal: abort },
          );

          const parsed = this.finalizeOutput(result, allowed, choice);
          if (!hasVisibleText(parsed.text) && parsed.toolCalls.length === 0) {
            throw new UpstreamError(`upstream returned an empty response (completion_tokens=${result.usage.completionTokens})`, { code: 'empty_response' });
          }

          if (this.cfg.session_reuse && result.threadId) {
            entry.threadId = result.threadId;
            entry.accountId = account.id;
            entry.messages = JSON.parse(JSON.stringify(messages));
            entry.instructionsHash = instructionsHash;
            entry.updatedAt = Date.now();
          } else {
            this.conversations.reset(entry);
          }
          return { ...parsed, usage: result.usage, account, threadId: result.threadId };
        } catch (err) {
          lastErr = err;
          if (abort?.aborted) throw err;
          log(this.logger, 'warn', `chat attempt=${attempt} failed account=${accountLabel(account)} error=${err.message}`);
          if (useResume) {
            // A half-written thread cannot be resumed safely.
            resume = false;
            this.conversations.reset(entry);
          }
          if (err?.status === 401 || err?.status === 403) {
            if (!refreshed.has(account.id)) {
              refreshed.add(account.id);
              try {
                const updated = await this.refreshIfNeeded(account, true);
                this.store.update(account.id, { ...updated, last_error: '' });
              } catch (refreshErr) {
                this.store.update(account.id, { last_error: refreshErr.message });
                excluded.add(account.id);
              }
              attempt -= 1; // refresh does not consume an attempt
              continue;
            }
            excluded.add(account.id);
          }
          if (!isRetryable(err)) throw err;
          if (attempt < maxAttempts) await sleep(400 * attempt);
        }
      }
      throw lastErr || new UpstreamError('upstream request failed');
    } finally {
      release();
    }
  }

  finalizeOutput(result, allowed, choice) {
    let text = result.text || '';
    let calls = [];
    if (allowed.size > 0) {
      const parsed = parseClientToolCalls(text, allowed);
      text = parsed.text;
      calls = parsed.calls;
      if (calls.length === 0 && this.cfg.expose_native_tools) calls = nativeToolCalls(result.toolCalls, allowed);
      calls = calls.map((call) => ({ ...call, arguments: normalizeArguments(call.arguments) }));
      calls = limitToolCalls(calls, choice);
    }
    return { text, toolCalls: calls };
  }

  async refreshIfNeeded(account, force = false) {
    if (!account) return account;
    const expiring = !account.expires_at || account.expires_at * 1000 - Date.now() <= this.cfg.refresh_before_ms;
    if (!force && !expiring) return account;
    if (!account.refresh_token) return account;

    const previous = this.accountLocks.get(account.id) || Promise.resolve();
    let resolve;
    const current = new Promise((r) => {
      resolve = r;
    });
    const chain = previous.then(() => current);
    this.accountLocks.set(account.id, chain);
    await previous;
    try {
      const latest = this.store.get(account.id) || account;
      if (!force && latest.expires_at && latest.expires_at * 1000 - Date.now() > this.cfg.refresh_before_ms) return latest;
      const updated = await refreshAccount(latest, { logger: (msg) => log(this.logger, 'info', msg) });
      this.store.update(latest.id, { ...updated, last_error: '' });
      log(this.logger, 'info', `refreshed tokens for ${accountLabel(latest)}`);
      return this.store.get(latest.id);
    } finally {
      resolve();
      if (this.accountLocks.get(account.id) === chain) this.accountLocks.delete(account.id);
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ClientError('request body too large', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new ClientError(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', (err) => reject(new ClientError(`read error: ${err.message}`)));
  });
}

function writeSse(res, event, data) {
  if (res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // client is gone
  }
}

function sendAnthropicError(res, status, type, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({
    type: 'error',
    error: { type, message },
  }));
}

function errorStatus(err) {
  if (err instanceof UpstreamError && (err.status === 401 || err.status === 403)) return 502;
  if (err?.status && err.status >= 400) return err.status;
  if (err?.code === 'timeout') return 504;
  return 502;
}

function errorType(err) {
  if (err instanceof UpstreamError && (err.status === 401 || err.status === 403)) return 'api_error';
  if (err?.status === 429) return 'rate_limit_error';
  if (err?.status === 401) return 'authentication_error';
  if (err?.status === 400) return 'invalid_request_error';
  return 'api_error';
}

function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'ClientError') return false;
  if (err.code === 'empty_response') return true;
  if (err.code === 'timeout') return true;
  if (!err.status) return true;
  return err.status === 401 || err.status === 403 || err.status === 408 || err.status === 429 || err.status >= 500;
}

function accountLabel(account) {
  if (!account) return 'none';
  const who = publicAccount(account);
  return `${account.id}:${who.provider}:${who.email || who.display_name || '-'}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
