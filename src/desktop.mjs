import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_QUICK_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'quickwork');

const cache = {
  dir: '',
  at: 0,
  value: null,
};

const EMAIL_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;
const LAST_TAB_RE = /quickwork\.customizeLastTab\.v1\.(\d+)\.arn:aws:[^:\s]+:[^:\s]+:(\d+):user\/default\/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function cleanEmail(raw) {
  let email = String(raw || '').trim();
  // LevelDB record markers can leave a trailing "B" after the email.
  if (/[A-Za-z]$/.test(email) && /\.(?:com|net|org|cn|io|ai|dev|edu|gov)b$/i.test(email)) {
    email = email.slice(0, -1);
  }
  return EMAIL_RE.test(email) ? email : '';
}

/**
 * Best-effort detection of the account last used by the Quick desktop app.
 * Quick stores a per-account "customizeLastTab" key in Chromium Local Storage
 * (LevelDB). The newest updatedAt is the best local signal; it is not an auth
 * source and no token is read or exposed.
 */
export function detectQuickDesktopAccount({ dataDir = process.env.QUICK_WORK_DESKTOP_DATA || DEFAULT_QUICK_DATA_DIR, fresh = false } = {}) {
  const dir = path.join(dataDir, 'Local Storage', 'leveldb');
  const now = Date.now();
  if (!fresh && cache.dir === dir && now - cache.at < 5_000) return cache.value;

  const unavailable = (reason) => ({
    available: false,
    email: '',
    account_id: '',
    updated_at: null,
    source: dir,
    reason,
  });

  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((name) => /\.(?:ldb|log)$/i.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          return { file, name, mtime: stat.mtimeMs, size: stat.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 16);
  } catch {
    const value = unavailable('Quick 桌面端 Local Storage 不存在或不可读；请确认已启动并登录 Quick。');
    cache.dir = dir; cache.at = now; cache.value = value;
    return value;
  }
  if (files.length === 0) {
    const value = unavailable('Quick 桌面端 Local Storage 为空。');
    cache.dir = dir; cache.at = now; cache.value = value;
    return value;
  }

  let best = null;
  for (const item of files) {
    if (item.size > 32 * 1024 * 1024) continue;
    let text = '';
    try {
      text = fs.readFileSync(item.file, 'latin1');
    } catch {
      continue;
    }
    LAST_TAB_RE.lastIndex = 0;
    let match;
    while ((match = LAST_TAB_RE.exec(text))) {
      const email = cleanEmail(match[3]);
      if (!email) continue;
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 320);
      const ts = /"updatedAt"\s*:\s*"([^"]+)"/.exec(after);
      const updatedAt = ts ? Date.parse(ts[1]) : item.mtime;
      if (!Number.isFinite(updatedAt)) continue;
      if (!best || updatedAt > best.updatedAt) {
        best = { email, accountId: match[2] || match[1], updatedAt, file: item.name };
      }
    }
  }

  const value = best
    ? {
        available: true,
        email: best.email,
        account_id: best.accountId,
        updated_at: best.updatedAt,
        source: `${dir} (${best.file})`,
        reason: '',
      }
    : unavailable('未在 Quick 桌面端 Local Storage 找到账号记录；请登录桌面端后刷新。');
  cache.dir = dir; cache.at = now; cache.value = value;
  return value;
}
