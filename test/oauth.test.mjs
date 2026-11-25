import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  LoginFlow,
  applySession,
  loginWithBrowser,
  createPkce,
  decodeJwt,
  discoveryUrl,
  normalizeUserInfo,
  redirectUri,
} from '../src/oauth.mjs';

function fakeJwt(claims) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.sig`;
}

function withFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const result = await handler(String(url), opts);
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('discovery URLs encode the desktop surface', () => {
  const url = new URL(discoveryUrl({ provider: 'social', stage: 'prod', nonce: 'n1', port: 18080, appVersion: '1.2.3' }));
  assert.equal(url.origin + url.pathname, 'https://quick.aws.com/sn');
  assert.equal(url.searchParams.get('qwSurface'), 'desktop:n1:18080:1.2.3');

  const ent = new URL(discoveryUrl({ provider: 'enterprise', stage: 'prod', region: 'eu-west-1', nonce: 'n2', port: 9, appVersion: '1.2.3' }));
  assert.equal(ent.host, 'eu-west-1.quicksight.aws.amazon.com');
  assert.equal(ent.searchParams.get('qwSurface'), 'desktop:n2:9:1.2.3');
});

test('redirect URI differs between social and enterprise', () => {
  assert.equal(redirectUri('social', 18080), 'http://127.0.0.1:18080');
  assert.equal(redirectUri('enterprise', 18080), 'http://localhost:18080');
});

test('PKCE challenge is S256 of the verifier', () => {
  const { verifier, challenge } = createPkce();
  assert.equal(verifier.length, 43);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
});

test('normalizes nested user info', () => {
  const info = normalizeUserInfo({
    userInfo: { email: 'a@example.com', displayName: 'A', userArn: 'arn:x', accountId: '123', accountName: 'Acme' },
  });
  assert.equal(info.email, 'a@example.com');
  assert.equal(info.display_name, 'A');
  assert.equal(info.user_arn, 'arn:x');
  assert.equal(info.aws_account_id, '123');
  assert.equal(info.account_name, 'Acme');
});

test('applySession derives ws_host, jwt and expiry', () => {
  const expires = Math.floor(Date.now() / 1000) + 1200;
  const idToken = fakeJwt({ sub: 'arn:aws:quicksight:us-east-1:1:user/x', exp: expires, region: 'us-east-1' });
  const account = applySession(
    { provider: 'social', build_stage: 'prod', tenant_url: 'https://tenant.example/', region: '' },
    { access_token: 'access', id_token: idToken, refresh_token: 'refresh', expires_in: 3600 },
    { email: 'a@example.com', user_arn: 'arn:from-profile' },
  );
  assert.equal(account.ws_host, 'tenant.example');
  assert.equal(account.id_token, idToken);
  assert.equal(account.refresh_token, 'refresh');
  assert.equal(account.actor_arn, 'arn:from-profile');
  assert.equal(account.expires_at, expires);
  assert.equal(account.tenant_url, 'https://tenant.example');
  assert.equal(decodeJwt(idToken).sub, 'arn:aws:quicksight:us-east-1:1:user/x');
});

test('social login flow registers a client, authorizes and exchanges the code', async (t) => {
  const calls = [];
  withFetch(t, async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body });
    const u = new URL(url);
    if (u.pathname === '/client/register') return { body: { clientId: 'cid', clientSecret: 'sec' } };
    if (u.pathname === '/token') {
      return {
        body: {
          access_token: 'access-token',
          id_token: fakeJwt({ sub: 'arn:aws:quicksight:us-east-1:1:user/x', exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'refresh-token',
          expires_in: 3600,
        },
      };
    }
    if (u.pathname === '/integration/quick-work/user-info') {
      return { body: { email: 'user@example.com', userArn: 'arn:profile', accountName: 'Acme' } };
    }
    return { status: 404, body: { message: 'unexpected' } };
  });

  const flow = new LoginFlow({ provider: 'social', stage: 'prod', port: 18080, appVersion: '1.2.4757' });
  const authorize = await flow.handleDiscovery(
    new URLSearchParams({
      nonce: flow.nonce,
      issuerUrl: 'https://issuer.example',
      tenantUrl: 'https://tenant.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev',
      idcRegion: 'us-east-1',
    }),
  );
  const auth = new URL(authorize);
  assert.equal(auth.host, 'oidc.us-east-1.amazonaws.com');
  assert.equal(auth.searchParams.get('client_id'), 'cid');
  assert.equal(auth.searchParams.get('state'), flow.state);
  assert.equal(auth.searchParams.get('code_challenge'), flow.challenge);
  assert.equal(auth.searchParams.get('scope'), 'quicksight:read_write');

  const account = await flow.handleCode(new URLSearchParams({ code: 'the-code', state: flow.state }));
  assert.equal(account.email, 'user@example.com');
  assert.equal(account.ws_host, 'tenant.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev');
  assert.equal(account.refresh_token, 'refresh-token');
  assert.equal(account.provider, 'social');
  const tokenCall = calls.find((c) => c.url.endsWith('/token'));
  assert.match(tokenCall.body, /"grantType":"authorization_code"/);
  assert.match(tokenCall.body, /"codeVerifier":"/);
});

test('login rejects a nonce or state mismatch', async () => {
  const flow = new LoginFlow({ provider: 'social', stage: 'prod', port: 18080 });
  await assert.rejects(flow.handleDiscovery(new URLSearchParams({ nonce: 'nope' })), /nonce mismatch/);
  await assert.rejects(flow.handleCode(new URLSearchParams({ code: 'x', state: 'nope' })), /state mismatch/);
});

test('browser login server handles discovery and code callbacks', { timeout: 15_000 }, async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.hostname === '127.0.0.1') return originalFetch(url, opts);
    let body = {};
    if (u.pathname === '/client/register') body = { clientId: 'cid', clientSecret: 'sec' };
    else if (u.pathname === '/token') {
      body = {
        access_token: 'access-token',
        id_token: fakeJwt({ sub: 'arn:aws:quicksight:us-east-1:1:user/x', exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'refresh-token',
        expires_in: 3600,
      };
    } else if (u.pathname === '/integration/quick-work/user-info') {
      body = { email: 'browser@example.com', userArn: 'arn:profile' };
    } else {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const logs = [];
  const pending = loginWithBrowser({
    provider: 'social',
    stage: 'prod',
    port: 0,
    appVersion: '1.2.4757',
    openBrowser: false,
    timeoutMs: 10_000,
    logger: (line) => logs.push(line),
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !logs.some((l) => l.includes('listening=127.0.0.1:'))) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const listening = logs.find((l) => l.includes('listening=127.0.0.1:'));
  assert.ok(listening, logs.join('\n'));
  const port = Number(/listening=127\.0\.0\.1:(\d+)/.exec(listening)[1]);
  const loginUrl = logs.find((l) => l.startsWith('https://quick.aws.com/sn?'));
  assert.ok(loginUrl);
  const nonce = new URL(loginUrl).searchParams.get('qwSurface').split(':')[1];

  const discovery = await originalFetch(
    `http://127.0.0.1:${port}/callback?nonce=${encodeURIComponent(nonce)}&issuerUrl=${encodeURIComponent('https://issuer.example')}&tenantUrl=${encodeURIComponent('https://tenant.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev')}&idcRegion=us-east-1`,
    { redirect: 'manual' },
  );
  assert.equal(discovery.status, 302);
  const authorize = new URL(discovery.headers.get('location'));
  const state = authorize.searchParams.get('state');
  assert.ok(state);

  const done = await originalFetch(`http://127.0.0.1:${port}/?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(done.status, 200);
  const account = await pending;
  assert.equal(account.email, 'browser@example.com');
  assert.equal(account.ws_host, 'tenant.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev');
  assert.equal(account.refresh_token, 'refresh-token');
});
