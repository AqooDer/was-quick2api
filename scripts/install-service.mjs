#!/usr/bin/env node
/**
 * Install quick2api as a per-user macOS LaunchAgent so direct connections do
 * not depend on a terminal window staying open.
 *
 *   node scripts/install-service.mjs --dry-run
 *   node scripts/install-service.mjs install
 *   node scripts/install-service.mjs status
 *   node scripts/install-service.mjs uninstall
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'io.github.quick2api';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const plistDir = path.join(home, 'Library', 'LaunchAgents');
const plistPath = path.join(plistDir, `${LABEL}.plist`);
const logDir = path.join(home, 'Library', 'Logs');
const configPath = path.join(root, 'config.json');
const command = process.argv[2] || 'install';
const dryRun = process.argv.includes('--dry-run');

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(root, 'bin', 'quick2api.mjs'))}</string>
    <string>serve</string>
    <string>--config</string>
    <string>${xml(configPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logDir, 'quick2api.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logDir, 'quick2api.err.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>QUICK2API_LOG</key>
    <string>info</string>
  </dict>
</dict>
</plist>
`;
}

function run(args, { inherit = false } = {}) {
  return execFileSync('launchctl', args, { stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8' });
}

function bootout() {
  try {
    run(['bootout', `gui/${process.getuid()}/${LABEL}`]);
  } catch {
    // Not loaded yet.
  }
}

function install() {
  if (process.platform !== 'darwin') {
    throw new Error('launchd installation is macOS-only');
  }
  fs.mkdirSync(plistDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(plistPath, plist(), { mode: 0o644 });
  bootout();
  run(['bootstrap', `gui/${process.getuid()}`, plistPath]);
  run(['enable', `gui/${process.getuid()}/${LABEL}`]);
  console.log(`installed ${plistPath}`);
  console.log(`logs: ${path.join(logDir, 'quick2api.log')} / quick2api.err.log`);
  console.log(`health: curl http://127.0.0.1:8080/healthz`);
}

function uninstall() {
  bootout();
  fs.rmSync(plistPath, { force: true });
  console.log(`removed ${plistPath}`);
}

if (command === '--dry-run' || (command === 'install' && dryRun)) {
  console.log(plist());
  process.exit(0);
}

switch (command) {
  case 'install':
    install();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'status':
    run(['print', `gui/${process.getuid()}/${LABEL}`], { inherit: true });
    break;
  default:
    console.error('usage: node scripts/install-service.mjs [install|uninstall|status] [--dry-run]');
    process.exit(2);
}
