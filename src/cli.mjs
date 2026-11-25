import process from 'node:process';
import { AccountStore, publicAccount } from './accounts.mjs';
import { configPathFromArgs, loadConfig, parseAddr } from './config.mjs';
import { loginManual, loginWithBrowser, refreshAccount } from './oauth.mjs';
import { QuickProxy } from './server.mjs';
import { Upstream } from './upstream.mjs';
import { nowSec } from './util.mjs';

const VERSION = '0.1.0';

function usage() {
  return `quick2api ${VERSION} — Amazon Quick (QuickWork) → Anthropic Messages API for Claude Code

Usage:
  quick2api serve [--config config.json] [--addr 127.0.0.1:8080]
  quick2api login [--provider social|enterprise] [--stage prod] [--region us-east-1]
                  [--port 18080] [--manual] [--no-browser]
  quick2api accounts [--json]
  quick2api doctor             # send one tiny upstream test turn
  quick2api ccswitch           # print a CC Switch provider settings JSON
  quick2api settings           # print a Claude Code --settings JSON
  quick2api refresh
  quick2api --help | --version

Environment:
  QUICK2API_CONFIG      config file path (default ./config.json)
  QUICK2API_ADDR        override listen address
  QUICK2API_API_KEY     comma-separated proxy API keys
  QUICK2API_APP_VERSION override the Quick desktop app version
`;
}

function makeLogger(level = 'info') {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = levels[level] ?? 20;
  return (lvl, message) => {
    if ((levels[lvl] ?? 20) < min) return;
    const stamp = new Date().toISOString();
    const line = `${stamp} ${lvl.toUpperCase().padEnd(5)} ${message}`;
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function openStore(cfg) {
  return new AccountStore(cfg.accounts_file).load();
}

async function cmdLogin(argv) {
  const cfg = loadConfig(configPathFromArgs(argv));
  const store = openStore(cfg);
  const logger = makeLogger(process.env.QUICK2API_LOG || 'info');
  const provider = argValue(argv, '--provider') || 'social';
  const stage = argValue(argv, '--stage') || 'prod';
  const region = argValue(argv, '--region') || '';
  const port = Number(argValue(argv, '--port') || 18080);
  const manual = hasFlag(argv, '--manual');
  const options = {
    provider,
    stage,
    region,
    port,
    appVersion: cfg.app_version,
    logger: (msg) => logger('info', msg),
    openBrowser: !hasFlag(argv, '--no-browser'),
  };

  let account;
  if (manual) {
    account = await loginManual(options);
  } else {
    account = await loginWithBrowser(options);
  }
  const saved = store.upsert(account);
  console.log(`\nSaved account ${saved.id} (${saved.email || saved.display_name || 'unknown'})`);
  console.log(`Database: ${cfg.accounts_file}`);
  printClaudeCodeHelp(cfg);
}

async function cmdAccounts(argv) {
  const cfg = loadConfig(configPathFromArgs(argv));
  const store = openStore(cfg);
  const rows = store.list().map(publicAccount);
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No accounts. Run `quick2api login`.');
    return;
  }
  const now = nowSec();
  for (const row of rows) {
    const exp = row.expires_at ? new Date(row.expires_at * 1000).toLocaleString() : 'unknown';
    const left = row.expires_at ? Math.max(0, Math.round((row.expires_at - now) / 60)) : 0;
    console.log(
      `${row.id}  ${row.provider.padEnd(10)} ${(row.email || row.display_name || '-').padEnd(32)} ws_host=${row.ws_host || '-'} expires=${exp} (${left}m)${row.disabled ? ' DISABLED' : ''}${row.last_error ? ` error=${row.last_error}` : ''}`,
    );
  }
}

async function cmdRefresh(argv) {
  const cfg = loadConfig(configPathFromArgs(argv));
  const store = openStore(cfg);
  const logger = makeLogger(process.env.QUICK2API_LOG || 'info');
  const accounts = store.list();
  if (accounts.length === 0) {
    console.log('No accounts. Run `quick2api login`.');
    return;
  }
  for (const account of accounts) {
    if (!account.refresh_token) {
      console.log(`skip ${account.id}: no refresh_token; run login again`);
      continue;
    }
    try {
      const updated = await refreshAccount(account, { logger: (msg) => logger('info', msg) });
      store.update(account.id, updated);
      console.log(`refreshed ${account.id} (${account.email || '-'}) expires_at=${updated.expires_at}`);
    } catch (err) {
      store.update(account.id, { last_error: err.message });
      console.error(`failed ${account.id}: ${err.message}`);
    }
  }
}

async function cmdCcswitch(argv, mode = 'ccswitch') {
  const cfg = loadConfig(configPathFromArgs(argv));
  const { host, port } = parseAddr(cfg.addr);
  const shown = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
  const urlHost = shown.includes(':') ? `[${shown}]` : shown;
  const token = cfg.api_keys[0] || 'local';
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: `http://${urlHost}:${port}`,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
      CLAUDE_CODE_AUTO_MODE_SERVER: '0',
      API_TIMEOUT_MS: '600000',
    },
  };
  if (mode === 'settings') {
    console.error('# Save this as ~/.claude/quick2api.settings.json, then run:');
    console.error('#   claude --settings ~/.claude/quick2api.settings.json');
    console.error('# This overrides the CC Switch base URL without modifying ~/.claude/settings.json.');
  } else {
    console.error('# CC Switch -> Claude Code -> add provider -> custom config; paste this JSON.');
    console.error(`# Base URL must be http://${urlHost}:${port} (no /v1 suffix).`);
  }
  console.log(JSON.stringify(settings, null, 2));
}

async function cmdDoctor(argv) {
  const cfg = loadConfig(configPathFromArgs(argv));
  const store = openStore(cfg);
  const logger = makeLogger(process.env.QUICK2API_LOG || 'info');
  const accounts = store.list();
  if (accounts.length === 0) {
    console.error('No accounts. Run `quick2api login` first.');
    process.exitCode = 1;
    return;
  }
  let account = accounts[0];
  if (account.refresh_token && (!account.expires_at || account.expires_at * 1000 - Date.now() <= cfg.refresh_before_ms)) {
    try {
      const updated = await refreshAccount(account, { logger: (msg) => logger('info', msg) });
      store.update(account.id, updated);
      account = store.get(account.id);
    } catch (err) {
      logger('warn', `refresh failed (trying the existing token): ${err.message}`);
    }
  }
  console.log(`account: ${account.email || account.display_name || account.id}`);
  console.log(`ws_host: ${account.ws_host || '-'}  provider: ${account.provider}  expires_at: ${account.expires_at || 0}`);
  const upstream = new Upstream(cfg, { logger });
  const started = Date.now();
  const result = await upstream.chat(account, {
    turns: ['Reply with exactly: OK'],
    model: cfg.default_model,
    title: 'quick2api doctor',
    createSession: true,
    deleteSession: true,
    timeoutMs: 60_000,
  });
  const elapsed = Date.now() - started;
  const text = String(result.text || '').trim();
  console.log(`upstream reply in ${elapsed}ms: ${text ? JSON.stringify(text.slice(0, 200)) : '(empty)'}`);
  console.log(`usage: prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} cache_read=${result.usage.cacheReadTokens}`);
  if (!text) {
    console.error('The upstream connection worked but returned no text.');
    process.exitCode = 1;
  }
}

async function cmdServe(argv) {
  const cfg = loadConfig(configPathFromArgs(argv));
  const store = openStore(cfg);
  const logger = makeLogger(process.env.QUICK2API_LOG || cfg.log_level || 'info');
  const addr = argValue(argv, '--addr') || cfg.addr;
  const { host, port } = parseAddr(addr);
  cfg.addr = addr;
  const proxy = new QuickProxy(cfg, store, { logger });
  const server = proxy.server();

  if (store.list().length === 0) {
    logger('warn', 'no Quick account yet; run `quick2api login` before sending requests');
  }
  if (cfg.api_keys.length === 0) {
    logger('warn', 'no api_keys configured: the proxy accepts any client token (fine on localhost only)');
  }
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' && cfg.api_keys.length === 0) {
    logger('warn', `listening on ${host} without api_keys is unsafe`);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const urlHost = shownHost.includes(':') ? `[${shownHost}]` : shownHost;
  logger('info', `quick2api ${VERSION} listening on http://${urlHost}:${port}`);
  logger('info', `config=${cfg.config_file} accounts=${cfg.accounts_file} (${store.list().length} account(s))`);
  logger('info', `Anthropic base URL: http://${urlHost}:${port}  ·  model aliases: ${cfg.models.join(', ')}`);
  logger('info', `request timeout=${Math.round(cfg.request_timeout_ms / 1000)}s session_reuse=${cfg.session_reuse} max_frame=${cfg.max_frame_bytes}`);
  printClaudeCodeHelp(cfg, urlHost, port, logger);

  const shutdown = () => {
    logger('info', 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function printClaudeCodeHelp(cfg, host = '127.0.0.1', port = parseAddr(cfg.addr).port, logger = null) {
  const base = `http://${host}:${port}`;
  const token = cfg.api_keys[0] || 'local';
  const lines = [
    'Point Claude Code at this proxy:',
    `  export ANTHROPIC_BASE_URL=${base}`,
    `  export ANTHROPIC_AUTH_TOKEN=${token}`,
    '  export ANTHROPIC_MODEL=claude-sonnet-4-5',
    '  claude',
  ];
  if (logger) for (const line of lines) logger('info', line);
  else console.log(`\n${lines.join('\n')}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h') || argv[0] === 'help') {
    console.log(usage());
    return;
  }
  if (hasFlag(argv, '--version') || hasFlag(argv, '-v')) {
    console.log(VERSION);
    return;
  }
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'serve';
  switch (command) {
    case 'login':
      await cmdLogin(argv);
      break;
    case 'accounts':
      await cmdAccounts(argv);
      break;
    case 'refresh':
      await cmdRefresh(argv);
      break;
    case 'doctor':
      await cmdDoctor(argv);
      break;
    case 'ccswitch':
      await cmdCcswitch(argv, 'ccswitch');
      break;
    case 'settings':
      await cmdCcswitch(argv, 'settings');
      break;
    case 'serve':
    case 'server':
      await cmdServe(argv);
      break;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(usage());
      process.exitCode = 2;
  }
}
