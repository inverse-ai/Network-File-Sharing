// A small state file so `nfs status`, the menu bar app and anything else can
// see what the running server chose without having to probe ports blindly.

import fs from 'node:fs';
import path from 'node:path';
import { STATE_PATH, SUPPORT_DIR } from './paths.js';

export function writeState(state) {
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, STATE_PATH); // atomic, so a reader never sees a half-written file
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function clearState() {
  try { fs.unlinkSync(STATE_PATH); } catch { /* already gone */ }
}

/** Whether a recorded pid is still alive (signal 0 tests without delivering). */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
