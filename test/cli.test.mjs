import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MockUpstream } from './mock-upstream.mjs';

async function freePort() {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function waitFor(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

test('CLI serve loads config/accounts and answers Anthropic requests', { timeout: 30_000 }, async () => {
  const mock = await new MockUpstream({ toolCall: { name: 'Bash', arguments: { command: 'echo hi' } } }).start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick2api-cli-'));
  const port = await freePort();
  try {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify(
        {
          addr: `127.0.0.1:${port}`,
          api_keys: ['test-key'],
          accounts_file: 'accounts.json',
          max_attempts: 1,
          request_timeout: '20s',
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(dir, 'accounts.json'),
      JSON.stringify(
        {
          version: 1,
          accounts: [
            {
              id: 'cli-account',
              provider: 'social',
              id_token: 'x.y.z',
              ws_host: `ws://127.0.0.1:${mock.port}`,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        },
        null,
        2,
      ),
    );

    const child = spawn(process.execPath, ['bin/quick2api.mjs', 'serve', '--config', path.join(dir, 'config.json')], {
      cwd: process.cwd(),
      env: { ...process.env, QUICK2API_LOG: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    try {
      await waitFor(`http://127.0.0.1:${port}/healthz`);

      const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
      assert.equal(health.status, 'ok');
      assert.equal(health.accounts, 1);

      const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(unauthorized.status, 401);

      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 512,
          stream: true,
          system: 'test',
          messages: [{ role: 'user', content: 'run it' }],
          tools: [{ name: 'Bash', description: 'sh', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /"type":"tool_use"/);
      assert.match(body, /"name":"Bash"/);
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
    }
    assert.equal(stderr.includes('unhandled'), false, stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});
