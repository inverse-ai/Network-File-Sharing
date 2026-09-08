#!/usr/bin/env node
// `nfs` — install and manage Network File Sharing as a background service.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { primaryLanAddress, lanAddresses } from '../src/net.js';
import { certAddresses, certCoversCurrentAddresses, certPaths } from '../src/cert.js';
import { toTerminal } from '../src/qr.js';
import { readState, pidAlive } from '../src/service/state.js';
import * as launchd from '../src/service/launchd.js';
import {
  PLIST_PATH, STDOUT_LOG, STDERR_LOG, CERT_DIR, LOG_DIR, SUPPORT_DIR
} from '../src/service/paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.js');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function die(message) {
  console.error(`${red('error')}  ${message}`);
  process.exit(1);
}

/** The URL a phone should be pointed at, from live state where possible. */
function currentUrl() {
  const state = readState();
  const ip = primaryLanAddress();
  if (!ip) return null;
  const port = state?.port ?? Number(process.env.PORT ?? 3000);
  const scheme = state?.scheme ?? 'https';
  return `${scheme}://${ip}:${port}`;
}

function running() {
  const info = launchd.serviceInfo();
  if (info.loaded && info.pid) return { ...info, via: 'launchd' };
  const state = readState();
  if (state && pidAlive(state.pid)) return { loaded: false, pid: state.pid, via: 'foreground' };
  return null;
}

// --- commands ---------------------------------------------------------------

async function cmdInstall(args) {
  const portArg = args.find((a) => /^--port=/.test(a));
  const port = portArg ? Number(portArg.split('=')[1]) : 3443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) die(`invalid port: ${portArg}`);

  const nodePath = process.execPath;
  console.log(`Installing the launch agent…`);
  const plist = await launchd.install({ nodePath, serverPath: SERVER, port, https: true });

  // Give launchd a moment to start it before reporting the URL.
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`${green('installed')}  ${dim(plist)}`);
  console.log(`  starts at login, restarts if it crashes`);
  console.log(`  logs: ${dim(STDOUT_LOG)}`);
  console.log(`  certificates: ${dim(CERT_DIR)}`);
  console.log('');
  await cmdStatus([]);
}

async function cmdUninstall() {
  await launchd.uninstall();
  console.log(`${green('uninstalled')}  the launch agent is removed`);
  console.log(dim(`  certificates and logs are left in place; delete ${SUPPORT_DIR} and ${LOG_DIR} to remove them`));
}

async function cmdStart() {
  if (!launchd.isInstalled()) die(`not installed — run ${bold('nfs install')} first`);
  await launchd.start();
  console.log(`${green('started')}`);
}

async function cmdStop() {
  if (!launchd.isInstalled()) die(`not installed — nothing to stop`);
  await launchd.stop();
  console.log(`${green('stopped')}`);
}

async function cmdRestart() {
  if (!launchd.isInstalled()) die(`not installed — run ${bold('nfs install')} first`);
  await launchd.restart();
  console.log(`${green('restarted')}`);
}

async function cmdStatus() {
  const info = running();
  const state = readState();
  const url = currentUrl();

  if (!launchd.isInstalled()) {
    console.log(`${yellow('not installed')}  run ${bold('nfs install')} to start it at login`);
  }
  if (info) {
    console.log(`${green('running')}  pid ${info.pid}${info.via === 'foreground' ? dim(' (foreground)') : ''}`);
  } else {
    console.log(`${red('not running')}`);
    const svc = launchd.serviceInfo();
    if (svc.loaded && svc.lastExitCode) {
      console.log(dim(`  last exit code ${svc.lastExitCode} — see ${STDERR_LOG}`));
    }
  }

  if (url) console.log(`  ${bold(url)}`);
  const addrs = lanAddresses();
  if (addrs.length > 1) console.log(dim(`  also on: ${addrs.slice(1).join(', ')}`));

  if (state?.certDir) {
    const { certPath } = certPaths(state.certDir);
    const covered = certCoversCurrentAddresses(certPath);
    console.log(covered
      ? dim(`  certificate covers ${(certAddresses(certPath) || []).join(', ')}`)
      : yellow(`  certificate is stale for this network — it reissues within 30s, or run nfs restart`));
  }
}

async function cmdUrl(args) {
  const url = currentUrl();
  if (!url) die('this machine has no LAN address — connect to Wi-Fi first');
  console.log('');
  console.log(`  ${bold(url)}`);
  console.log('');
  if (!args.includes('--no-qr')) {
    console.log(toTerminal(url));
    console.log('');
    console.log(dim('  Scan with the phone camera. Accept the certificate warning once.'));
    console.log('');
  }
}

async function cmdLogs(args) {
  const follow = args.includes('-f') || args.includes('--follow');
  const which = args.includes('--errors') ? STDERR_LOG : STDOUT_LOG;
  if (!fs.existsSync(which)) die(`no log yet at ${which}`);
  try {
    execFileSync('tail', [...(follow ? ['-f'] : []), '-n', '200', which], { stdio: 'inherit' });
  } catch {
    // tail -f exits non-zero on Ctrl-C; that is the normal way out.
  }
}

function cmdHelp() {
  console.log(`
  ${bold('nfs')} — Network File Sharing

  ${bold('nfs install')} [--port=3443]   install and start at login
  ${bold('nfs uninstall')}               remove the launch agent
  ${bold('nfs start')} | ${bold('stop')} | ${bold('restart')}
  ${bold('nfs status')}                  is it running, and on what URL
  ${bold('nfs url')} [--no-qr]           print the URL and a scannable QR code
  ${bold('nfs logs')} [-f] [--errors]    tail the service log
  ${bold('nfs menubar')} [--build]       run the menu bar app
`);
}

async function cmdMenubar(args) {
  const { runMenuBar } = await import('../src/menubar/run.js');
  await runMenuBar({ rebuild: args.includes('--build') });
}

const COMMANDS = {
  install: cmdInstall, uninstall: cmdUninstall,
  start: cmdStart, stop: cmdStop, restart: cmdRestart,
  status: cmdStatus, url: cmdUrl, logs: cmdLogs, menubar: cmdMenubar,
  help: cmdHelp, '--help': cmdHelp, '-h': cmdHelp
};

const [, , command = 'status', ...rest] = process.argv;
const handler = COMMANDS[command];
if (!handler) {
  console.error(`${red('error')}  unknown command: ${command}`);
  cmdHelp();
  process.exit(1);
}
if (process.platform !== 'darwin' && ['install', 'uninstall', 'start', 'stop', 'restart', 'menubar'].includes(command)) {
  die('the installer currently supports macOS only; run `npm run start:https` directly on other platforms');
}
try {
  await handler(rest);
} catch (err) {
  die(err.message);
}
