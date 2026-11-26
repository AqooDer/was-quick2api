import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectQuickDesktopAccount } from '../src/desktop.mjs';

test('detects the most recently used Quick desktop account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick2api-desktop-'));
  try {
    const level = path.join(dir, 'Local Storage', 'leveldb');
    fs.mkdirSync(level, { recursive: true });
    fs.writeFileSync(path.join(level, '000001.log'), [
      'quickwork.customizeLastTab.v1.111.arn:aws:quicksight:us-east-1:111:user/default/old@example.com',
      '{"tabId":"discover","updatedAt":"2026-01-01T00:00:00.000Z"}',
      'quickwork.customizeLastTab.v1.222.arn:aws:quicksight:us-east-1:222:user/default/new@example.comB',
      '{"tabId":"discover","updatedAt":"2026-02-01T00:00:00.000Z"}',
    ].join('\n'));
    const found = detectQuickDesktopAccount({ dataDir: dir, fresh: true });
    assert.equal(found.available, true);
    assert.equal(found.email, 'new@example.com');
    assert.equal(found.account_id, '222');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reports unavailable when the desktop data directory is absent', () => {
  const found = detectQuickDesktopAccount({ dataDir: path.join(os.tmpdir(), 'does-not-exist-quick2api'), fresh: true });
  assert.equal(found.available, false);
  assert.match(found.reason, /不存在|不可读/);
});
