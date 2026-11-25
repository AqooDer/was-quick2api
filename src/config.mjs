import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDuration } from './util.mjs';

export const DEFAULT_APP_VERSION = '1.2.4757';

let cachedAppVersion = '';
/** Best-effort: match the installed Quick app on macOS. */
export function detectAppVersion() {
  if (cachedAppVersion) return cachedAppVersion;
  if (process.platform === 'darwin') {
    try {
      const value = execFileSync('defaults', ['read', '/Applications/Amazon Quick.app/Contents/Info.plist', 'CFBundleShortVersionString'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (/^\d+(?:\.\d+)+$/.test(value)) {
        cachedAppVersion = value;
        return value;
      }
    } catch {
      // App not installed or defaults unavailable.
    }
  }
  cachedAppVersion = DEFAULT_APP_VERSION;
  return cachedAppVersion;
}

function defaultSurface() {
  return process.platform === 'darwin' ? 'QUICK_WORK_DESKTOP_MAC' : 'QUICK_WORK_DESKTOP_WINDOWS';
}

function systemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultConfig() {
  return {
    addr: '127.0.0.1:8080',
    // Empty means no client authentication, which is fine for localhost use.
    api_keys: [],
    models: ['smart', 'fast', 'balanced', 'auto'],
    default_model: 'smart',
    // Claude Code model ids are mapped by substring; exact Quick modes pass through.
    model_map: {
      opus: 'smart',
      sonnet: 'smart',
      haiku: 'fast',
    },
    request_timeout: '10m',
    refresh_before: '10m',
    max_attempts: 2,
    // Must match the surface reported by the installed desktop app.
    app_version: detectAppVersion(),
    surface: defaultSurface(),
    outpost_id: '',
    working_session_id: '',
    timezone: systemTimezone(),
    locale: 'en-US',
    thinking_effort: '',
    chat_agent_id: '',
    // Native Quick tool events are not exposed to Claude Code by default:
    // Quick already executed them, so returning them as tool_use would run
    // the same action twice on the client.
    expose_native_tools: true,
    // Reuse one upstream thread per client conversation and send only new messages.
    session_reuse: true,
    keep_sessions: false,
    session_ttl: '30m',
    // Upstream rejects a single user_message above 64 KiB; stay below it.
    max_frame_bytes: 63488,
    // Target size for priming chunks when the caller's instructions do not fit.
    prime_chunk_bytes: 49152,
    accounts_file: 'data/accounts.json',
    log_level: 'info',
  };
}

export function configPathFromArgs(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const eq = argv.find((a) => a.startsWith('--config='));
  if (eq) return path.resolve(eq.slice('--config='.length));
  return path.resolve(process.env.QUICK2API_CONFIG || 'config.json');
}

export function ensureConfig(file = configPathFromArgs()) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { mode: 0o600 });
  return true;
}

export function loadConfig(file = configPathFromArgs()) {
  const created = ensureConfig(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read config ${file}: ${err.message}`);
  }
  const cfg = { ...defaultConfig(), ...raw };
  if (raw.model_map && typeof raw.model_map === 'object') cfg.model_map = raw.model_map;
  if (!Array.isArray(cfg.api_keys)) cfg.api_keys = cfg.api_keys ? [String(cfg.api_keys)] : [];
  cfg.api_keys = cfg.api_keys.map((k) => String(k).trim()).filter(Boolean);
  if (!Array.isArray(cfg.models) || cfg.models.length === 0) cfg.models = ['smart', 'fast', 'balanced', 'auto'];
  if (!cfg.models.includes(cfg.default_model)) cfg.models = [cfg.default_model, ...cfg.models];

  const dir = path.dirname(file);
  cfg.config_file = file;
  cfg.config_dir = dir;
  cfg.accounts_file = path.resolve(dir, cfg.accounts_file || 'data/accounts.json');
  cfg.request_timeout_ms = parseDuration(cfg.request_timeout, 600_000);
  cfg.refresh_before_ms = parseDuration(cfg.refresh_before, 600_000);
  cfg.session_ttl_ms = parseDuration(cfg.session_ttl, 1_800_000);
  cfg.max_frame_bytes = Number(cfg.max_frame_bytes) || 63488;
  cfg.prime_chunk_bytes = Math.min(Number(cfg.prime_chunk_bytes) || 49152, cfg.max_frame_bytes - 2048);
  cfg.created = created;

  if (process.env.QUICK2API_ADDR) cfg.addr = process.env.QUICK2API_ADDR;
  if (process.env.QUICK2API_API_KEY) cfg.api_keys = process.env.QUICK2API_API_KEY.split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.QUICK2API_APP_VERSION) cfg.app_version = process.env.QUICK2API_APP_VERSION;
  return cfg;
}

export function parseAddr(addr) {
  const value = String(addr || '127.0.0.1:8080');
  const idx = value.lastIndexOf(':');
  if (idx < 0) return { host: '127.0.0.1', port: Number(value) || 8080 };
  return { host: value.slice(0, idx).replace(/^\[|\]$/g, '') || '127.0.0.1', port: Number(value.slice(idx + 1)) || 8080 };
}

export function mapModel(cfg, requested) {
  const raw = String(requested || '').trim();
  const lower = raw.toLowerCase().replace(/^quickwork\//, '').replace(/^qw-/, '');
  if (cfg.models.includes(lower)) return lower;
  if (cfg.model_map) {
    for (const [needle, target] of Object.entries(cfg.model_map)) {
      if (lower.includes(String(needle).toLowerCase()) && cfg.models.includes(target)) return target;
    }
  }
  return cfg.default_model;
}
