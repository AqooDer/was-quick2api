import crypto from 'node:crypto';

export function uuid() {
  return crypto.randomUUID();
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Parse "500ms", "30s", "5m", "1h" or a plain number of milliseconds. */
export function parseDuration(value, fallbackMs) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
    if (m) {
      const n = Number(m[1]);
      const unit = (m[2] || 'ms').toLowerCase();
      return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]);
    }
  }
  return fallbackMs;
}

export function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

/**
 * Split text into chunks of at most maxBytes UTF-8 bytes. Prefers newline
 * boundaries so instructions and JSON keep their shape, then falls back to
 * code-point boundaries.
 */
export function chunkByBytes(text, maxBytes) {
  const chunks = [];
  let rest = String(text);
  while (byteLength(rest) > maxBytes) {
    let cut = 0;
    let bytes = 0;
    // Walk code points until the byte budget is reached.
    for (const ch of rest) {
      const n = Buffer.byteLength(ch, 'utf8');
      if (bytes + n > maxBytes) break;
      bytes += n;
      cut += ch.length;
    }
    if (cut === 0) cut = 1;
    const windowStart = Math.max(0, cut - 2048);
    const window = rest.slice(windowStart, cut);
    const nl = window.lastIndexOf('\n');
    if (nl >= 0) cut = windowStart + nl + 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function oneLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

export function isLoopback(addr) {
  const host = String(addr || '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
