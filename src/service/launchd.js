// launchd integration: install the server as a per-user LaunchAgent.
//
// A LaunchAgent (not a daemon) is the right unit here. The server only matters
// while someone is logged in, it needs no privileges, and keeping it in the
// user domain means installing and uninstalling never asks for a password.

import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  LABEL, PLIST_PATH, AGENTS_DIR, LOG_DIR, SUPPORT_DIR,
  CERT_DIR, STDOUT_LOG, STDERR_LOG
} from './paths.js';

const run = promisify(execFile);

const escape = (str) =>
  String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plistContents({ nodePath, serverPath, port, https = true }) {
  const args = [nodePath, serverPath];
  if (https) args.push('--https');
  args.push('--cert-dir', CERT_DIR);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escape(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${escape(port)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escape(STDOUT_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(STDERR_LOG)}</string>
  <key>WorkingDirectory</key>
  <string>${escape(SUPPORT_DIR)}</string>
</dict>
</plist>
`;
}

const uid = () => process.getuid();
const target = () => `gui/${uid()}`;
const service = () => `gui/${uid()}/${LABEL}`;

/** launchctl, but tolerant: most subcommands fail loudly when already in the
 *  desired state, which is not an error for install/uninstall to care about. */
async function launchctl(args, { tolerate = [] } = {}) {
  try {
    const { stdout } = await run('launchctl', args);
    return { ok: true, stdout };
  } catch (err) {
    const text = `${err.stderr || ''}${err.stdout || ''}`;
    if (tolerate.some((code) => text.includes(code) || err.code === code)) {
      return { ok: false, tolerated: true, stdout: text };
    }
    throw new Error(`launchctl ${args.join(' ')} failed: ${text.trim() || err.message}`);
  }
}

export async function install({ nodePath, serverPath, port, https = true }) {
  for (const dir of [AGENTS_DIR, LOG_DIR, SUPPORT_DIR, CERT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PLIST_PATH, plistContents({ nodePath, serverPath, port, https }));

  // Replace any previous registration before loading the new definition.
  await launchctl(['bootout', service()], { tolerate: ['No such process', 'not find', 'NOT_FOUND', 3, 113] });
  await launchctl(['bootstrap', target(), PLIST_PATH]);
  await launchctl(['enable', service()], { tolerate: ['No such process'] });
  return PLIST_PATH;
}

export async function uninstall() {
  await launchctl(['bootout', service()], { tolerate: ['No such process', 'not find', 'NOT_FOUND', 3, 113] });
  try { fs.unlinkSync(PLIST_PATH); } catch { /* never installed */ }
}

export async function start() {
  await launchctl(['kickstart', service()]);
}

export async function stop() {
  await launchctl(['kill', 'SIGTERM', service()], { tolerate: ['No such process', 'not find', 3, 113] });
}

export async function restart() {
  await launchctl(['kickstart', '-k', service()]);
}

export function isInstalled() {
  return fs.existsSync(PLIST_PATH);
}

/** launchctl's view of the job: pid and last exit status, or null if unloaded. */
export function serviceInfo() {
  try {
    const out = execFileSync('launchctl', ['print', service()], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
    const pid = /\bpid = (\d+)/.exec(out);
    const status = /last exit code = (\d+)/.exec(out);
    return { loaded: true, pid: pid ? Number(pid[1]) : null, lastExitCode: status ? Number(status[1]) : null };
  } catch {
    return { loaded: false, pid: null, lastExitCode: null };
  }
}
