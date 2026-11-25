import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { MockUpstream } from './mock-upstream.mjs';
import { QuickProxy } from '../src/server.mjs';
import { AccountStore } from '../src/accounts.mjs';
import { defaultConfig } from '../src/config.mjs';
import { byteLength } from '../src/util.mjs';

const SYSTEM = 'You are a test agent. Follow the caller instructions.';
const TOOLS = [
  {
    name: 'Bash',
    description: 'Run a shell command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
  },
];

async function startStack({ toolCall, system = SYSTEM } = {}) {
  const mock = await new MockUpstream({
    toolCall: toolCall === undefined ? { name: 'Bash', arguments: { command: 'echo hi-from-mock', description: 'echo' } } : toolCall,
  }).start();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick2api-test-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const cfg = {
    ...defaultConfig(),
    accounts_file: accountsFile,
    api_keys: [],
    session_reuse: true,
    keep_sessions: false,
    max_attempts: 1,
    request_timeout_ms: 30_000,
    refresh_before_ms: 600_000,
    session_ttl_ms: 1_800_000,
    max_frame_bytes: 63_488,
    prime_chunk_bytes: 49_152,
    log_level: 'error',
  };
  const store = new AccountStore(accountsFile);
  store.accounts = [
    {
      id: 'acct-1',
      provider: 'social',
      email: 'test@example.com',
      id_token: 'header.payload.signature',
      access_token: 'access',
      ws_host: `ws://127.0.0.1:${mock.port}`,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  ];
  store.save();

  const proxy = new QuickProxy(cfg, store, { logger: () => {} });
  const server = proxy.server();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  return {
    mock,
    proxy,
    store,
    cfg,
    port,
    system,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function postMessages(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

function parseSse(text) {
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
      const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        // keep null
      }
      return { event, data: parsed };
    });
}

function textOf(events) {
  return events
    .filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
}

test('streams a client tool call and resumes the thread for its result', async () => {
  const stack = await startStack();
  try {
    const first = await postMessages(stack.port, {
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      stream: true,
      system: stack.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'run echo' }] }],
      tools: TOOLS,
    });
    assert.equal(first.status, 200, first.text);
    const events = parseSse(first.text);
    assert.equal(events[0].event, 'message_start');
    const startBlock = events.find((e) => e.event === 'content_block_start' && e.data?.content_block?.type === 'tool_use');
    assert.ok(startBlock, 'expected a tool_use block');
    assert.equal(startBlock.data.content_block.name, 'Bash');
    const delta = events.find((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta');
    assert.deepEqual(JSON.parse(delta.data.delta.partial_json), { command: 'echo hi-from-mock', description: 'echo' });
    const messageDelta = events.find((e) => e.event === 'message_delta');
    assert.equal(messageDelta.data.delta.stop_reason, 'tool_use');
    assert.equal(events.at(-1).event, 'message_stop');

    const toolId = startBlock.data.content_block.id;
    const second = await postMessages(stack.port, {
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      stream: true,
      system: stack.system,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'run echo' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'echo hi-from-mock', description: 'echo' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'hi-from-mock' }] },
      ],
      tools: TOOLS,
    });
    assert.equal(second.status, 200, second.text);
    const events2 = parseSse(second.text);
    assert.equal(textOf(events2), 'MOCK_TOOL_DONE');
    assert.equal(events2.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'end_turn');
    assert.equal(stack.mock.userMessages.length, 2, 'expected one turn per request');
    assert.match(stack.mock.userMessages[1], /Tool result \(call_id=/);
    assert.doesNotMatch(stack.mock.userMessages[1], /You are a test agent/);
  } finally {
    await stack.close();
  }
});

test('primes oversized instructions once, then sends deltas only', async () => {
  const hugeSystem = `HEAD ${'z'.repeat(90_000)} TAIL`;
  const stack = await startStack({ system: hugeSystem, toolCall: null });
  try {
    const first = await postMessages(stack.port, {
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      stream: true,
      system: hugeSystem,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'start the task' }] }],
      tools: TOOLS,
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(textOf(parseSse(first.text)), 'MOCK_OK');
    const turns = [...stack.mock.userMessages];
    assert.ok(turns.length >= 3, `expected priming turns, got ${turns.length}`);
    for (const turn of turns) assert.ok(byteLength(turn) <= 63_488, `frame too large: ${byteLength(turn)}`);
    assert.match(turns[0], /setup only/);
    assert.match(turns.at(-1), /start the task/);

    const before = stack.mock.userMessages.length;
    const second = await postMessages(stack.port, {
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      stream: true,
      system: hugeSystem,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'start the task' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'MOCK_OK' }] },
        { role: 'user', content: [{ type: 'text', text: 'continue now' }] },
      ],
      tools: TOOLS,
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(stack.mock.userMessages.length, before + 1, 'resume must send only the delta');
    const delta = stack.mock.userMessages.at(-1);
    assert.match(delta, /continue now/);
    assert.doesNotMatch(delta, /zzzz/);
    assert.doesNotMatch(delta, /setup only/);
  } finally {
    await stack.close();
  }
});

test('accepts system messages forwarded inside messages (CC Switch style)', async () => {
  const stack = await startStack({ toolCall: null });
  try {
    const res = await postMessages(stack.port, {
      model: 'claude-opus-5-5',
      max_tokens: 256,
      stream: true,
      system: 'TOP LEVEL SYSTEM',
      messages: [
        { role: 'system', content: 'MESSAGE LEVEL SYSTEM' },
        { role: 'user', content: '你好' },
      ],
      tools: [],
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(textOf(parseSse(res.text)), 'MOCK_OK');
    const sent = stack.mock.userMessages.at(-1);
    assert.match(sent, /TOP LEVEL SYSTEM/);
    assert.match(sent, /MESSAGE LEVEL SYSTEM/);
  } finally {
    await stack.close();
  }
});

test('non-streaming responses and token counting work', async () => {
  const stack = await startStack();
  try {
    const count = await fetch(`http://127.0.0.1:${stack.port}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        system: 'system text',
        messages: [{ role: 'user', content: 'hello' }],
        tools: TOOLS,
      }),
    });
    assert.equal(count.status, 200);
    const counted = await count.json();
    assert.ok(counted.input_tokens > 0);

    const res = await postMessages(stack.port, {
      model: 'claude-sonnet-4-5',
      max_tokens: 512,
      stream: false,
      system: stack.system,
      messages: [{ role: 'user', content: 'run it' }],
      tools: TOOLS,
    });
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text);
    assert.equal(body.type, 'message');
    assert.equal(body.stop_reason, 'tool_use');
    const tool = body.content.find((b) => b.type === 'tool_use');
    assert.ok(tool);
    assert.equal(tool.name, 'Bash');
    assert.deepEqual(tool.input, { command: 'echo hi-from-mock', description: 'echo' });
  } finally {
    await stack.close();
  }
});

test('returns an Anthropic error when no account is logged in', async () => {
  const stack = await startStack();
  try {
    stack.store.accounts = [];
    const res = await postMessages(stack.port, {
      model: 'claude-sonnet-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOLS,
    });
    assert.equal(res.status, 503);
    const body = JSON.parse(res.text);
    assert.equal(body.type, 'error');
    assert.match(body.error.message, /quick2api login/);
  } finally {
    await stack.close();
  }
});

test('real Claude Code completes a tool loop through the proxy', { timeout: 150_000 }, async (t) => {
  const claudeBin = process.env.QUICK2API_TEST_CLAUDE || 'claude';
  if (process.env.QUICK2API_TEST_CLAUDE === '0') return t.skip('Claude Code test disabled');
  const probe = spawnSync(claudeBin, ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) return t.skip('Claude Code CLI not installed');
  const stack = await startStack();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick2api-cc-'));
  try {
    const env = {
      ...process.env,
      HOME: path.join(workdir, 'home'),
      CLAUDE_CONFIG_DIR: path.join(workdir, 'home', '.claude'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${stack.port}`,
      ANTHROPIC_AUTH_TOKEN: 'local',
      ANTHROPIC_API_KEY: 'local',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
    };
    fs.mkdirSync(env.HOME, { recursive: true });
    const child = spawn(claudeBin, ['-p', 'run the echo command from the mock', '--model', 'claude-sonnet-4-5', '--dangerously-skip-permissions'], {
      cwd: workdir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    let timeoutTimer;
    const [code] = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error('claude timed out')), 120_000);
      }),
    ]).finally(() => clearTimeout(timeoutTimer));
    assert.equal(code, 0, `claude failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /MOCK_TOOL_DONE/, `unexpected output:\n${stdout}\n${stderr}`);
    // System prompt + 12 tool schemas overflow one upstream frame, so Claude
    // Code's first request must be primed before the real turn.
    assert.ok(stack.mock.userMessages.length >= 3, `expected priming turns, got ${stack.mock.userMessages.length}`);
    assert.match(stack.mock.userMessages[0], /setup only/);
    assert.ok(stack.mock.userMessages.some((m) => /Tool result \(call_id=/.test(m)));
    const last = stack.mock.userMessages.at(-1);
    assert.ok(byteLength(last) < 4096, `resumed delta should be small, got ${byteLength(last)}`);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
    await stack.close();
  }
});
