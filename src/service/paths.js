// Where the installed service keeps its files, following macOS conventions so
// the app is legible to anyone poking around with Console.app or Finder.

import os from 'node:os';
import path from 'node:path';

export const LABEL = 'ai.inverse.network-file-sharing';

const home = os.homedir();

export const SUPPORT_DIR = path.join(home, 'Library', 'Application Support', 'NetworkFileSharing');
export const LOG_DIR = path.join(home, 'Library', 'Logs', 'NetworkFileSharing');
export const AGENTS_DIR = path.join(home, 'Library', 'LaunchAgents');

export const PLIST_PATH = path.join(AGENTS_DIR, `${LABEL}.plist`);
export const STATE_PATH = path.join(SUPPORT_DIR, 'state.json');
export const CERT_DIR = path.join(SUPPORT_DIR, 'certs');
export const STDOUT_LOG = path.join(LOG_DIR, 'server.log');
export const STDERR_LOG = path.join(LOG_DIR, 'server.error.log');
