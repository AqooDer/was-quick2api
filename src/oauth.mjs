import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import {
  base64url,
  nowSec,
  oneLine,
  randomToken,
  sleep,
} from './util.mjs';

export const GATEWAY_WS_PATH = '/ws/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream';
const ENTERPRISE_SCOPE = 'openid profile email';

const SOCIAL_DISCOVERY = {
  prod: 'https://quick.aws.com/sn',
  beta: 'https://devtest.quicksuite.aws.dev/sn',
  integ: 'https://devtest.quicksuite.aws.dev/sn',
  dev: 'https://devtest.quicksuite.aws.dev/sn',
};

const SOCIAL_DATA_PLANE = {
  prod: 'https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev',
  beta: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
  integ: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
  dev: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
};

const SOCIAL_SCOPES = {
  prod: ['quicksight:read_write'],
  beta: ['quicksight_test:read_write'],
  integ: ['quicksight_test:read_write'],
  dev: ['quicksight_test:read_write'],
};

const ENTERPRISE_DISCOVERY = {
  prod: 'https://quicksight.aws.amazon.com/sn/start/app-integrations/quickwork-enterprise-login',
  beta: 'https://spaceneedle-alpha.amazon.com/sn/start/app-integrations/quickwork-enterprise-login',
  integ: 'https://spaceneedle-beta.amazon.com/sn/start/app-integrations/quickwork-enterprise-login',
  dev: 'https://spaceneedle-alpha.amazon.com/sn/start/app-integrations/quickwork-enterprise-login',
};

export function normalizeProvider(provider) {
  const p = String(provider || '').toLowerCase().trim();
  return ['social', 'enterprise', 'gateway', 'social_gateway'].includes(p) ? p : 'social';
}

export function normalizeStage(stage) {
  const s = String(stage || '').toLowerCase().trim();
  return ['prod', 'beta', 'integ', 'dev'].includes(s) ? s : 'prod';
}

export function isEnterprise(provider) {
  const p = normalizeProvider(provider);
  return p === 'enterprise' || p === 'gateway';
}

export function scopesFor(stage) {
  return SOCIAL_SCOPES[normalizeStage(stage)] || SOCIAL_SCOPES.prod;
}

export function dataPlane(stage) {
  return SOCIAL_DATA_PLANE[normalizeStage(stage)] || SOCIAL_DATA_PLANE.prod;
}

export function OidcRegion({ idcRegion, region } = {}) {
  return String(idcRegion || region || 'us-east-1').trim() || 'us-east-1';
}

export function discoveryUrl({ provider = 'social', stage = 'prod', region = '', nonce, port, appVersion = '1.2.4660' } = {}) {
  const surface = encodeURIComponent(`desktop:${nonce}:${port}:${appVersion}`);
  const p = normalizeProvider(provider);
  const s = normalizeStage(stage);
  let base;
  if (isEnterprise(p)) {
    base = ENTERPRISE_DISCOVERY[s] || ENTERPRISE_DISCOVERY.prod;
    if (region && region !== 'dynamic' && region !== 'us-east-1') {
      const u = new URL(base);
      u.host = `${region}.${u.host}`;
      base = u.toString();
    }
  } else {
    base = SOCIAL_DISCOVERY[s] || SOCIAL_DISCOVERY.prod;
  }
  return `${base}?qwSurface=${surface}`;
}

export function redirectUri(provider, port) {
  return isEnterprise(provider) ? `http://localhost:${port}` : `http://127.0.0.1:${port}`;
}

export function userInfoBase({ provider = 'social', stage = 'prod', discovery = {}, tenantUrl = '' } = {}) {
  if (isEnterprise(provider)) return withScheme(String(discovery.tenantUrl || tenantUrl || '').replace(/\/+$/, ''));
  const tenant = withScheme(String(discovery.tenantUrl || tenantUrl || '').replace(/\/+$/, ''));
  if (tenant.includes('dp.appintegrations')) return tenant;
  return dataPlane(stage);
}

function withScheme(raw) {
  if (!raw) return '';
  return raw.includes('://') ? raw : `https://${raw}`;
}

export function createPkce() {
  const verifier = randomToken(32);
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function decodeJwt(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function claimString(claims, key) {
  const v = claims?.[key];
  return typeof v === 'string' ? v : '';
}

function claimInt(claims, key) {
  const v = Number(claims?.[key]);
  return Number.isFinite(v) ? v : 0;
}

export function normalizeUserInfo(raw) {
  let value = raw && typeof raw === 'object' ? raw : {};
  if (value.userInfo && typeof value.userInfo === 'object') value = value.userInfo;
  const pick = (...keys) => {
    for (const key of keys) {
      const v = value[key];
      if (typeof v === 'string' && v.trim() !== '') return oneLine(v);
    }
    return '';
  };
  return {
    email: pick('email', 'emailAddress'),
    user_name: pick('userName', 'user_name', 'username'),
    display_name: pick('displayName', 'display_name'),
    user_arn: pick('userArn', 'user_arn'),
    quicksight_external_user_arn: pick('quicksightExternalUserArn', 'quicksight_external_user_arn'),
    aws_account_id: pick('awsAccountId', 'aws_account_id', 'accountId'),
    account_name: pick('accountName', 'account_name'),
    role: pick('role'),
    identity_type: pick('identityType', 'identity_type'),
    raw: value,
  };
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

function safeSnippet(text, max = 300) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function postJson(url, payload, headers = {}) {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${safeSnippet(res.text)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`invalid JSON from ${new URL(url).host}`);
  }
}

async function postForm(url, form) {
  const res = await request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${safeSnippet(res.text)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`invalid JSON from ${new URL(url).host}`);
  }
}

function tokensFrom(raw) {
  return {
    access_token: firstString(raw, 'access_token', 'accessToken'),
    refresh_token: firstString(raw, 'refresh_token', 'refreshToken'),
    id_token: firstString(raw, 'id_token', 'idToken'),
    expires_in: Number(firstString(raw, 'expires_in', 'expiresIn')) || 0,
  };
}

function firstString(raw, ...keys) {
  for (const key of keys) {
    const v = raw?.[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

export async function registerIdcClient({ oidcBase, issuerUrl, redirectUri: redirect, stage }) {
  const raw = await postJson(`${String(oidcBase).replace(/\/+$/, '')}/client/register`, {
    clientName: 'AmazonQuick-Desktop',
    clientType: 'public',
    scopes: scopesFor(stage),
    grantTypes: ['authorization_code', 'refresh_token'],
    redirectUris: [redirect],
    issuerUrl,
  });
  return {
    clientId: firstString(raw, 'clientId', 'client_id'),
    clientSecret: firstString(raw, 'clientSecret', 'client_secret'),
  };
}

async function fetchUserInfo({ provider, stage, discovery, tenantUrl, accessToken }) {
  if (!accessToken) throw new Error('token response has no access_token');
  const base = userInfoBase({ provider, stage, discovery, tenantUrl });
  if (!base) throw new Error('discovery response has no tenant_url');
  const raw = await postJson(`${base}/integration/quick-work/user-info`, {}, { authorization: `Bearer ${accessToken}` });
  return normalizeUserInfo(raw);
}

/** Fill runtime session fields on an account from a token response + profile. */
export function applySession(account, tokens, info = {}) {
  const access = String(tokens.access_token || '').trim();
  const idToken = String(tokens.id_token || account.id_token || '').trim();
  const jwt = idToken || access;
  if (!jwt) throw new Error('token response has no id_token/access_token');

  let tenant = String(account.tenant_url || '').trim() || dataPlane(account.build_stage);
  tenant = tenant.replace(/\/+$/, '');
  if (!tenant.includes('://')) tenant = `https://${tenant}`;
  let parsed;
  try {
    parsed = new URL(tenant);
  } catch {
    throw new Error(`cannot derive ws_host from tenant_url ${JSON.stringify(tenant)}`);
  }
  if (!parsed.host) throw new Error(`cannot derive ws_host from tenant_url ${JSON.stringify(tenant)}`);

  const claims = decodeJwt(idToken);
  let actorArn = info.user_arn || '';
  if (!actorArn) {
    const sub = claimString(claims, 'sub');
    if (sub.startsWith('arn:')) actorArn = sub;
  }
  let region = String(account.region || '').trim() || claimString(claims, 'region');
  if (!region) region = 'us-east-1';

  let expiresAt = 0;
  if (Number(tokens.expires_in) > 0) expiresAt = nowSec() + Number(tokens.expires_in);
  const jwtExp = claimInt(claims, 'exp');
  if (jwtExp > 0 && (expiresAt === 0 || jwtExp < expiresAt)) expiresAt = jwtExp;
  const refreshToken = String(tokens.refresh_token || account.refresh_token || '').trim();
  if (!expiresAt && refreshToken) expiresAt = nowSec() + 50 * 60;

  return {
    ...account,
    email: info.email || account.email || '',
    display_name: info.display_name || account.display_name || '',
    account_name: info.account_name || account.account_name || '',
    aws_account_id: info.aws_account_id || claimString(claims, 'aws_account_id') || account.aws_account_id || '',
    tenant_url: tenant,
    ws_host: parsed.host,
    ws_path: ['gateway', 'social_gateway'].includes(String(account.provider || '').toLowerCase()) ? GATEWAY_WS_PATH : '',
    access_token: access,
    refresh_token: refreshToken,
    id_token: idToken,
    actor_arn: actorArn || account.actor_arn || '',
    region,
    expires_at: expiresAt,
    obtained_at: nowSec(),
    last_error: '',
  };
}

/** One native Amazon Quick login flow (discovery + PKCE + callback). */
export class LoginFlow {
  constructor({
    provider = 'social',
    stage = 'prod',
    region = '',
    port = 18080,
    appVersion = '1.2.4660',
    timeoutMs = 60 * 60 * 1000,
    logger = () => {},
  } = {}) {
    this.provider = normalizeProvider(provider);
    this.stage = normalizeStage(stage);
    this.region = String(region || '').trim();
    this.port = port;
    this.appVersion = appVersion;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.state = randomToken(32);
    this.nonce = randomToken(32);
    const pkce = createPkce();
    this.verifier = pkce.verifier;
    this.challenge = pkce.challenge;
    this.redirectUri = redirectUri(this.provider, port);
    this.discovery = {};
    this.clientId = '';
    this.clientSecret = '';
    this.authorizeUrl = '';
    this.discoveryDone = false;
  }

  get loginUrl() {
    return discoveryUrl({
      provider: this.provider,
      stage: this.stage,
      region: this.region,
      nonce: this.nonce,
      port: this.port,
      appVersion: this.appVersion,
    });
  }

  oidcBase() {
    return `https://oidc.${OidcRegion({ idcRegion: this.discovery.idcRegion, region: this.region })}.amazonaws.com`;
  }

  /**
   * Handle the browser's discovery callback and return the authorize URL the
   * browser must open next.
   */
  async handleDiscovery(query) {
    const gotNonce = String(query.get('nonce') || '');
    if (!gotNonce || gotNonce !== this.nonce) throw new Error('discovery nonce mismatch');
    const err = query.get('error');
    if (err) throw new Error(`login failed: ${err} ${query.get('error_description') || ''}`.trim());
    if (this.discoveryDone) return this.authorizeUrl;

    if (isEnterprise(this.provider)) {
      this.discovery = {
        authEndpoint: firstQuery(query, 'authEndpoint', 'auth_endpoint'),
        tokenEndpoint: firstQuery(query, 'tokenEndpoint', 'token_endpoint'),
        issuerUrl: firstQuery(query, 'issuer'),
        tenantUrl: firstQuery(query, 'tenantUrl', 'tenant_url'),
        clientId: firstQuery(query, 'clientId', 'client_id'),
        clientSecret: firstQuery(query, 'clientSecret', 'client_secret'),
        region: firstQuery(query, 'region'),
      };
      if (!this.discovery.authEndpoint || !this.discovery.tokenEndpoint) {
        throw new Error('discovery response is missing authEndpoint/tokenEndpoint');
      }
      this.clientId = this.discovery.clientId;
      this.clientSecret = this.discovery.clientSecret;
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        scope: ENTERPRISE_SCOPE,
        state: this.state,
        code_challenge: this.challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      });
      this.authorizeUrl = appendQuery(this.discovery.authEndpoint, params);
      this.discoveryDone = true;
      this.logger(`discovery: tenant=${this.discovery.tenantUrl || '-'} region=${this.discovery.region || '-'}`);
      return this.authorizeUrl;
    }

    const issuerUrl = firstQuery(query, 'issuerUrl', 'issuer_url', 'issuer');
    const tenantUrl = firstQuery(query, 'tenantUrl', 'tenant_url');
    const idcRegion = firstQuery(query, 'idcRegion', 'idc_region') || this.region || 'us-east-1';
    if (!issuerUrl) throw new Error('discovery callback did not provide issuerUrl');
    this.discovery = { issuerUrl, tenantUrl, idcRegion, region: this.region };

    const client = await registerIdcClient({
      oidcBase: this.oidcBase(),
      issuerUrl,
      redirectUri: this.redirectUri,
      stage: this.stage,
    });
    if (!client.clientId) throw new Error('client registration returned no clientId');
    this.clientId = client.clientId;
    this.clientSecret = client.clientSecret;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: scopesFor(this.stage).join(' '),
      state: this.state,
      code_challenge: this.challenge,
      code_challenge_method: 'S256',
    });
    this.authorizeUrl = appendQuery(`${this.oidcBase()}/authorize`, params);
    this.discoveryDone = true;
    this.logger(`discovery: tenant=${this.discovery.tenantUrl || '-'} idc_region=${idcRegion}`);
    return this.authorizeUrl;
  }

  /** Exchange the OAuth code and fetch the profile. Returns an account object. */
  async handleCode(query) {
    const err = query.get('error');
    if (err) throw new Error(`login failed: ${err} ${query.get('error_description') || ''}`.trim());
    const gotState = String(query.get('state') || '');
    if (!gotState || gotState !== this.state) throw new Error('OAuth state mismatch');
    const code = String(query.get('code') || '');
    if (!code) throw new Error('OAuth callback has no code');

    let tokens;
    if (isEnterprise(this.provider)) {
      const form = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: this.verifier,
      };
      if (this.clientSecret) form.client_secret = this.clientSecret;
      tokens = tokensFrom(await postForm(this.discovery.tokenEndpoint, form));
    } else {
      tokens = tokensFrom(
        await postJson(`${this.oidcBase()}/token`, {
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          grantType: 'authorization_code',
          code,
          redirectUri: this.redirectUri,
          codeVerifier: this.verifier,
        }),
      );
    }
    if (!tokens.access_token) throw new Error('token response has no access_token');

    const info = await fetchUserInfo({
      provider: this.provider,
      stage: this.stage,
      discovery: this.discovery,
      tenantUrl: this.discovery.tenantUrl,
      accessToken: tokens.access_token,
    });

    let account = {
      provider: this.provider,
      build_stage: this.stage,
      region: this.discovery.region || this.region || '',
      tenant_url: this.discovery.tenantUrl || '',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      issuer_url: this.discovery.issuerUrl || '',
      idc_region: this.discovery.idcRegion || '',
      auth_endpoint: this.discovery.authEndpoint || '',
      token_endpoint: this.discovery.tokenEndpoint || '',
      redirect_uri: this.redirectUri,
      id_token: '',
      refresh_token: '',
    };
    if (!account.token_endpoint && !isEnterprise(this.provider)) {
      account.token_endpoint = `${this.oidcBase()}/token`;
    }
    account = applySession(account, tokens, info);
    this.logger(`login ok: ${info.email || info.display_name || '(unknown)'} ws_host=${account.ws_host} expires=${account.expires_at}`);
    return account;
  }
}

function firstQuery(query, ...keys) {
  for (const key of keys) {
    const v = query.get(key);
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

function appendQuery(endpoint, params) {
  const u = new URL(endpoint);
  for (const [k, v] of params) u.searchParams.set(k, v);
  return u.toString();
}

export function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // The URL is printed anyway.
  }
}

function successHtml(who) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Login complete</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem}code{background:#eee;padding:.1rem .25rem}</style></head>
<body><h2>Login complete</h2>${who ? `<p>${escapeHtml(who)}</p>` : ''}
<p>You can close this window and return to the terminal.</p></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Browser login with a loopback callback listener. Returns the account object.
 */
export async function loginWithBrowser(options = {}) {
  const port = Number(options.port) || 18080;
  const logger = options.logger || (() => {});
  let flow;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    res.setHeader('cache-control', 'no-store');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/callback') {
      flow
        .handleDiscovery(url.searchParams)
        .then((authorizeUrl) => {
          logger('Open this URL to continue signing in:');
          logger(authorizeUrl);
          res.writeHead(302, { location: authorizeUrl }).end();
        })
        .catch((err) => {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(err.message);
          rejectDone(err);
        });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      flow
        .handleCode(url.searchParams)
        .then((account) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(successHtml(account.email || account.display_name));
          resolveDone(account);
        })
        .catch((err) => {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(err.message);
          rejectDone(err);
        });
      return;
    }
    res.writeHead(404).end('not found');
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (err) {
    throw new Error(`cannot listen on 127.0.0.1:${port}: ${err.message}. Retry with --port <free port>.`);
  }
  const actualPort = server.address().port;
  flow = new LoginFlow({ ...options, port: actualPort, logger });
  const timeoutMs = options.timeoutMs || 60 * 60 * 1000;
  const timer = setTimeout(() => rejectDone(new Error('timed out waiting for browser callback')), timeoutMs);
  timer.unref?.();

  logger(`provider=${flow.provider} stage=${flow.stage} listening=127.0.0.1:${actualPort}`);
  logger('Open this URL to sign in:');
  logger(flow.loginUrl);
  logger(`waiting for login (timeout ${Math.round(timeoutMs / 60000)}m)`);
  if (options.openBrowser !== false) openBrowser(flow.loginUrl);

  try {
    return await done;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Headless login: print the discovery URL, then accept the browser callback
 * URLs on stdin. Works on servers where the loopback port is not reachable.
 */
export async function loginManual(options = {}) {
  const logger = options.logger || (() => {});
  const flow = new LoginFlow({ ...options, port: Number(options.port) || 18080, logger });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  logger('Manual login mode. The local callback port does not need to be reachable.');
  logger('1) Open this discovery URL in any browser and finish signing in:');
  logger(flow.loginUrl);

  try {
    for (;;) {
      const answer = (await rl.question('\nPaste the full URL from the browser address bar (or press Ctrl+C): ')).trim();
      if (!answer) continue;
      let url;
      try {
        url = new URL(answer);
      } catch {
        console.log('Not a URL. Paste the complete address, including https:// and the query string.');
        continue;
      }
      if (url.hash) {
        // Fragments are not needed; keep the query only.
        url.hash = '';
      }
      if (url.searchParams.has('nonce')) {
        const authorizeUrl = await flow.handleDiscovery(url.searchParams);
        logger('\n2) Open this authorize URL in the same browser:');
        logger(authorizeUrl);
        logger('After signing in the browser will redirect to localhost with ?code=...; copy that URL next.');
        continue;
      }
      if (url.searchParams.has('code')) {
        const account = await flow.handleCode(url.searchParams);
        logger(`\nLOGIN_OK ${account.email || account.display_name || '(unknown)'}`);
        logger(`SESSION_SAVED ws_host=${account.ws_host} expires_at=${account.expires_at}`);
        return account;
      }
      if (url.searchParams.has('qwSurface')) {
        console.log('That is the discovery URL. Open it first, then paste the URL the browser redirects to.');
        continue;
      }
      console.log('URL has neither nonce (discovery callback) nor code (login callback). Paste the redirected URL.');
    }
  } finally {
    rl.close();
  }
}

/** Refresh one account's tokens. Returns a new object; the caller persists it. */
export async function refreshAccount(account, { logger = () => {} } = {}) {
  if (!account) throw new Error('account is nil');
  const provider = normalizeProvider(account.provider);
  if (!account.refresh_token) throw new Error('no refresh_token stored; run login again');

  let raw;
  if (isEnterprise(provider)) {
    if (!account.token_endpoint) throw new Error('account has no token_endpoint; run login again');
    const form = {
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
      client_id: account.client_id,
    };
    if (account.client_secret) form.client_secret = account.client_secret;
    raw = await postForm(account.token_endpoint, form);
  } else {
    let endpoint = account.token_endpoint;
    if (!endpoint) {
      const region = OidcRegion({ idcRegion: account.idc_region, region: account.region });
      endpoint = `https://oidc.${region}.amazonaws.com/token`;
    }
    raw = await postJson(endpoint, {
      clientId: account.client_id,
      clientSecret: account.client_secret,
      grantType: 'refresh_token',
      refreshToken: account.refresh_token,
    });
  }

  const tokens = tokensFrom(raw);
  if (!tokens.access_token) throw new Error('refresh returned no access_token');
  if (!tokens.refresh_token) tokens.refresh_token = account.refresh_token;

  let info = {};
  try {
    info = await fetchUserInfo({
      provider,
      stage: account.build_stage,
      discovery: { tenantUrl: account.tenant_url },
      tenantUrl: account.tenant_url,
      accessToken: tokens.access_token,
    });
  } catch (err) {
    logger(`profile refresh failed (keeping stored identity): ${err.message}`);
    info = {
      email: account.email,
      display_name: account.display_name,
      user_arn: account.actor_arn,
      aws_account_id: account.aws_account_id,
      account_name: account.account_name,
    };
  }
  return applySession(account, tokens, info);
}

/** Refresh accounts shortly before expiry; used by the CLI and the server. */
export async function refreshIfNeeded(account, cfg, { logger = () => {} } = {}) {
  if (!account) return account;
  const before = cfg.refresh_before_ms ?? 600_000;
  if (account.expires_at && account.expires_at * 1000 - Date.now() > before) return account;
  if (!account.refresh_token) return account;
  logger(`refreshing tokens for ${account.email || account.id}`);
  const updated = await refreshAccount(account, { logger });
  return updated;
}

// Retained for callers that want a small delay between DLP polls.
export { sleep };
