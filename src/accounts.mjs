import fs from 'node:fs';
import path from 'node:path';
import { nowSec, uuid, oneLine } from './util.mjs';

const EMPTY = { version: 1, accounts: [] };

/**
 * Accounts are persisted as JSON with 0600 permissions. Tokens never go to
 * logs and `publicAccount` is the only shape used for display.
 */
export class AccountStore {
  constructor(file) {
    this.file = file;
    this.accounts = [];
    this.activeId = '';
    this.loadedAt = 0;
    this.mtimeMs = 0;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
      this.activeId = typeof raw.active_id === 'string' ? raw.active_id : '';
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`cannot read accounts ${this.file}: ${err.message}`);
      this.accounts = [];
      this.activeId = '';
    }
    this.loadedAt = Date.now();
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.mtimeMs = 0;
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, active_id: this.activeId, accounts: this.accounts }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.mtimeMs = 0;
    }
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // best effort on platforms without POSIX modes
    }
  }

  /** Pick up accounts written by a separate `login` process while serving. */
  maybeReload() {
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs !== this.mtimeMs) this.load();
    } catch {
      // File removed or unreadable: keep the in-memory copy.
    }
  }

  list() {
    this.maybeReload();
    return this.accounts;
  }

  get(id) {
    this.maybeReload();
    return this.accounts.find((a) => a.id === id);
  }

  /** Insert or update by (provider, email, tenant_url) like the desktop app. */
  upsert(account) {
    const key = accountKey(account);
    const idx = this.accounts.findIndex((a) => accountKey(a) === key);
    let saved;
    if (idx >= 0) {
      saved = { ...this.accounts[idx], ...account, id: this.accounts[idx].id };
      this.accounts[idx] = saved;
    } else {
      saved = { id: uuid(), created_at: nowSec(), ...account };
      this.accounts.push(saved);
    }
    this.save();
    return saved;
  }

  update(id, patch) {
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx < 0) return null;
    this.accounts[idx] = { ...this.accounts[idx], ...patch, updated_at: nowSec() };
    this.save();
    return this.accounts[idx];
  }

  remove(id) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.activeId === id) this.activeId = '';
    if (this.accounts.length !== before) this.save();
    return before !== this.accounts.length;
  }

  getActiveId() {
    this.maybeReload();
    return this.activeId;
  }

  setActive(id) {
    this.maybeReload();
    const account = id ? this.get(id) : null;
    if (id && !account) throw new Error('account not found');
    if (account?.disabled) throw new Error('account is disabled');
    this.activeId = account ? account.id : '';
    this.save();
    return this.activeId;
  }

  /** Round-robin over enabled accounts, skipping explicit ids. */
  pick(exclude = new Set()) {
    this.maybeReload();
    if (this.activeId) {
      const active = this.get(this.activeId);
      if (active && !active.disabled && !exclude.has(active.id)) return active;
    }
    const usable = this.accounts.filter((a) => !a.disabled && !exclude.has(a.id));
    if (usable.length === 0) return null;
    const idx = (this.cursor = ((this.cursor ?? 0) + 1) % usable.length);
    return usable[idx];
  }

  pickPinned(id) {
    this.maybeReload();
    if (this.activeId && id !== this.activeId) return null;
    const acct = this.get(id);
    if (!acct || acct.disabled) return null;
    return acct;
  }
}

function accountKey(a) {
  return [a.provider || 'social', oneLine(a.email || a.display_name || ''), String(a.tenant_url || '').replace(/\/+$/, '')].join('|');
}

export function publicAccount(a) {
  if (!a) return null;
  return {
    id: a.id,
    provider: a.provider,
    email: a.email || '',
    display_name: a.display_name || '',
    account_name: a.account_name || '',
    ws_host: a.ws_host || '',
    region: a.region || '',
    expires_at: a.expires_at || 0,
    expires_in: Math.max(0, (a.expires_at || 0) - nowSec()),
    disabled: Boolean(a.disabled),
    last_error: a.last_error || '',
    created_at: a.created_at || 0,
  };
}
