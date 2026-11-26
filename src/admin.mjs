import fs from 'node:fs';
import crypto from 'node:crypto';
import { publicAccount } from './accounts.mjs';
import { LoginFlow, refreshAccount } from './oauth.mjs';
import { fetchUsage } from './usage.mjs';
import { safeEqual } from './util.mjs';

const ADMIN_HTML = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
const COOKIE = 'quick2api_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FLOW_TTL_MS = 30 * 60 * 1000;

function sendJson(res, status, value, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

function sendHtml(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function readJson(req, max = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

function isLoopback(req) {
  const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1';
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host || '');
  } catch {
    return false;
  }
}

function minutes(value) {
  if (value === null || value === undefined) return null;
  return Math.max(0, Math.round(value));
}

export class AdminPanel {
  constructor(cfg, store, { logger = () => {} } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.logger = logger;
    this.password = String(cfg.admin_password || '');
    this.sessions = new Map();
    this.flows = new Map();
    this.attempts = new Map();
  }

  needsAuth() {
    return this.password.length > 0;
  }

  authorized(req) {
    if (!this.needsAuth()) return isLoopback(req);
    const token = cookieValue(req, COOKIE);
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    session.lastSeen = Date.now();
    return true;
  }

  prune() {
    const now = Date.now();
    for (const [k, v] of this.sessions) if (v.expiresAt < now) this.sessions.delete(k);
    for (const [k, v] of this.flows) if (v.expiresAt < now) this.flows.delete(k);
  }

  state() {
    const activeId = this.store.getActiveId();
    return {
      ok: true,
      version: '0.1.0',
      auth_required: this.needsAuth(),
      active_id: activeId,
      accounts: this.store.list().map((a) => ({
        ...publicAccount(a),
        active: a.id === activeId,
        usable: !a.disabled,
        expires_in_minutes: minutes((a.expires_at || 0) - Math.floor(Date.now() / 1000)),
      })),
    };
  }

  async handle(req, res, url) {
    res.removeHeader('access-control-allow-origin');
    res.removeHeader('access-control-allow-headers');
    res.removeHeader('access-control-allow-methods');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/admin' || path === '/admin/' || path === '/admin/index.html') {
      sendHtml(res, 200, ADMIN_HTML);
      return;
    }
    if (!path.startsWith('/admin/api/')) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    this.prune();
    const sub = path.slice('/admin/api/'.length);

    if (sub === 'login' && req.method === 'POST') {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
        return;
      }
      await this.handleLogin(req, res);
      return;
    }
    if (!this.authorized(req)) {
      sendJson(res, 401, { ok: false, error: 'admin login required' });
      return;
    }
    if (req.method !== 'GET' && !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
      return;
    }
    if (req.method !== 'GET' && req.headers['x-quick2api-admin'] !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing admin request header' });
      return;
    }
    if (sub === 'state' && req.method === 'GET') {
      sendJson(res, 200, this.state());
      return;
    }
    if (sub === 'logout' && req.method === 'POST') {
      const token = cookieValue(req, COOKIE);
      if (token) this.sessions.delete(token);
      sendJson(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0` });
      return;
    }
    if (sub === 'login/start' && req.method === 'POST') {
      await this.handleLoginStart(req, res);
      return;
    }
    if (sub === 'login/complete' && req.method === 'POST') {
      await this.handleLoginComplete(req, res);
      return;
    }

    const match = /^accounts\/([^/]+)(?:\/(activate|enable|refresh|usage))?$/.exec(sub);
    if (match) {
      await this.handleAccount(req, res, decodeURIComponent(match[1]), match[2] || '');
      return;
    }
    sendJson(res, 404, { ok: false, error: 'unknown admin endpoint' });
  }

  async handleLogin(req, res) {
    if (!this.needsAuth()) {
      sendJson(res, 200, { ok: true, auth_required: false });
      return;
    }
    const ip = String(req.socket.remoteAddress || '');
    const now = Date.now();
    const attempt = this.attempts.get(ip) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > now) {
      sendJson(res, 429, { ok: false, error: 'too many attempts; wait a minute' });
      return;
    }
    let body;
    try {
      body = await readJson(req, 16 * 1024);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    if (!safeEqual(String(body.password || ''), this.password)) {
      attempt.count += 1;
      if (attempt.count >= 5) {
        attempt.count = 0;
        attempt.blockedUntil = now + 60_000;
      }
      this.attempts.set(ip, attempt);
      sendJson(res, 401, { ok: false, error: 'wrong admin password' });
      return;
    }
    this.attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { expiresAt: now + SESSION_TTL_MS, lastSeen: now });
    sendJson(res, 200, { ok: true }, {
      'set-cookie': `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    });
  }

  async handleAccount(req, res, id, action) {
    const account = this.store.get(id);
    if (!account) {
      sendJson(res, 404, { ok: false, error: 'account not found' });
      return;
    }
    if (req.method === 'DELETE' && !action) {
      this.store.remove(id);
      sendJson(res, 200, { ok: true, state: this.state() });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST required' });
      return;
    }
    let body = {};
    if (action === 'enable') {
      try {
        body = await readJson(req, 16 * 1024);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }
    }
    try {
      if (action === 'activate') {
        this.store.setActive(id);
      } else if (action === 'enable') {
        const enabled = body.enabled !== false;
        this.store.update(id, { disabled: !enabled });
        if (!enabled && this.store.getActiveId() === id) this.store.setActive('');
      } else if (action === 'refresh') {
        const updated = await refreshAccount(account, { logger: (m) => this.logger('info', m) });
        this.store.update(id, { ...updated, last_error: '' });
      } else if (action === 'usage') {
        let current = account;
        if (!current.expires_at || current.expires_at * 1000 - Date.now() < 60_000) {
          try {
            const updated = await refreshAccount(current, { logger: (m) => this.logger('info', m) });
            current = this.store.update(id, { ...updated, last_error: '' }) || updated;
          } catch (err) {
            this.logger('warn', `admin usage refresh failed: ${err.message}`);
          }
        }
        const usage = await fetchUsage(current, this.cfg);
        sendJson(res, 200, { ok: true, usage, account: publicAccount(this.store.get(id)) });
        return;
      } else {
        sendJson(res, 400, { ok: false, error: 'unknown account action' });
        return;
      }
      sendJson(res, 200, { ok: true, state: this.state() });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  async handleLoginStart(req, res) {
    let body = {};
    try {
      body = await readJson(req, 16 * 1024);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    try {
      const flow = new LoginFlow({
        provider: String(body.provider || 'social'),
        stage: String(body.stage || 'prod'),
        region: String(body.region || ''),
        port: 18080,
        appVersion: this.cfg.app_version,
        logger: (m) => this.logger('info', `admin login: ${m}`),
      });
      const token = crypto.randomBytes(24).toString('base64url');
      this.flows.set(token, { flow, expiresAt: Date.now() + FLOW_TTL_MS });
      sendJson(res, 200, {
        ok: true,
        token,
        step: 'discovery',
        login_url: flow.loginUrl,
        instructions: [
          '在浏览器打开下面的 discovery URL 并完成登录。',
          '浏览器会跳到 localhost:18080/callback?...；页面打不开是正常的，复制地址栏完整 URL 填到下面。',
        ],
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  async handleLoginComplete(req, res) {
    let body;
    try {
      body = await readJson(req, 64 * 1024);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    const saved = this.flows.get(String(body.token || ''));
    if (!saved || saved.expiresAt < Date.now()) {
      sendJson(res, 400, { ok: false, error: 'login flow expired; start again' });
      return;
    }
    let url;
    try {
      url = new URL(String(body.url || '').trim());
    } catch {
      sendJson(res, 400, { ok: false, error: 'paste the complete callback URL including ?query' });
      return;
    }
    const q = url.searchParams;
    try {
      if (q.has('nonce')) {
        const authorizeUrl = await saved.flow.handleDiscovery(q);
        sendJson(res, 200, {
          ok: true,
          step: 'authorize',
          authorize_url: authorizeUrl,
          instructions: [
            '在同一个浏览器打开下面的 authorize URL 并完成登录。',
            '浏览器会跳到 127.0.0.1:18080/?code=...；页面打不开是正常的，复制地址栏完整 URL 填到下面。',
          ],
        });
        return;
      }
      if (q.has('code')) {
        const account = await saved.flow.handleCode(q);
        const stored = this.store.upsert(account);
        this.store.setActive(stored.id);
        this.flows.delete(String(body.token));
        sendJson(res, 200, { ok: true, step: 'done', account: publicAccount(stored), state: this.state() });
        return;
      }
      if (q.has('qwSurface')) {
        sendJson(res, 400, { ok: false, error: '这是 discovery URL；请先在浏览器打开它，再粘贴浏览器跳转后的 callback URL' });
        return;
      }
      sendJson(res, 400, { ok: false, error: 'URL 里既没有 nonce 也没有 code；请粘贴浏览器跳转后的完整地址' });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  }
}
