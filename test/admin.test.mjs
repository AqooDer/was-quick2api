import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { QuickProxy } from '../src/server.mjs';
import { AccountStore } from '../src/accounts.mjs';
import { defaultConfig } from '../src/config.mjs';

async function stack({ password = 'secret' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick2api-admin-'));
  const cfg = {
    ...defaultConfig(),
    accounts_file: path.join(dir, 'accounts.json'),
    admin_password: password,
    api_keys: [],
    max_attempts: 1,
    request_timeout_ms: 30_000,
    refresh_before_ms: 600_000,
    session_ttl_ms: 1_800_000,
    max_frame_bytes: 63_488,
    prime_chunk_bytes: 49_152,
  };
  const store = new AccountStore(cfg.accounts_file);
  store.accounts = [
    { id: 'old-id', provider: 'social', email: 'old@example.com', access_token: 'old', expires_at: Math.floor(Date.now() / 1000) + 3600 },
    { id: 'new-id', provider: 'social', email: 'new@example.com', access_token: 'new', expires_at: Math.floor(Date.now() / 1000) + 3600 },
  ];
  store.save();
  const proxy = new QuickProxy(cfg, store, { logger: () => {} });
  const server = proxy.server();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    cfg, store, server, port,
    async close() {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function url(s, p) { return `http://127.0.0.1:${s.port}${p}`; }

test('admin requires a password and can switch the active account', async () => {
  const s = await stack();
  try {
    const page = await fetch(url(s, '/admin'));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Quick2API/);

    const denied = await fetch(url(s, '/admin/api/state'));
    assert.equal(denied.status, 401);

    const bad = await fetch(url(s, '/admin/api/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-quick2api-admin': '1' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(bad.status, 401);

    const login = await fetch(url(s, '/admin/api/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-quick2api-admin': '1' },
      body: JSON.stringify({ password: 'secret' }),
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /quick2api_admin=/);

    const state = await (await fetch(url(s, '/admin/api/state'), { headers: { cookie } })).json();
    assert.equal(state.accounts.length, 2);
    assert.equal(state.active_id, '');

    const activated = await fetch(url(s, '/admin/api/accounts/new-id/activate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-quick2api-admin': '1', cookie },
      body: '{}',
    });
    assert.equal(activated.status, 200);
    assert.equal(s.store.getActiveId(), 'new-id');
    assert.equal(s.store.pick().id, 'new-id');

    const disabled = await fetch(url(s, '/admin/api/accounts/old-id/enable'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-quick2api-admin': '1', cookie },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    assert.equal(s.store.get('old-id').disabled, true);
  } finally {
    await s.close();
  }
});

test('admin login wizard starts a flow without requiring a callback server', async () => {
  const s = await stack({ password: '' });
  try {
    const start = await fetch(url(s, '/admin/api/login/start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-quick2api-admin': '1' },
      body: JSON.stringify({ provider: 'social', stage: 'prod' }),
    });
    assert.equal(start.status, 200);
    const body = await start.json();
    assert.equal(body.step, 'discovery');
    assert.match(body.login_url, /^https:\/\/quick\.aws\.com\/sn\?qwSurface=/);
    assert.ok(body.token);
  } finally {
    await s.close();
  }
});
