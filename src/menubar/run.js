// Builds the Swift menu bar binary on first use and launches it.
//
// Compiling on demand keeps a native binary out of version control while still
// avoiding an Electron-sized dependency for what is a status icon and a menu.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SUPPORT_DIR, STATE_PATH } from '../service/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, 'MenuBar.swift');
const BIN_DIR = path.join(SUPPORT_DIR, 'bin');
const BINARY = path.join(BIN_DIR, 'MenuBar');
const NFS = path.resolve(HERE, '..', '..', 'bin', 'nfs.js');

function needsBuild() {
  if (!fs.existsSync(BINARY)) return true;
  return fs.statSync(SOURCE).mtimeMs > fs.statSync(BINARY).mtimeMs;
}

function build() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  try {
    execFileSync('swiftc', ['-O', '-o', BINARY, SOURCE], { stdio: 'pipe' });
  } catch (err) {
    const detail = (err.stderr || err.stdout || '').toString().trim();
    throw new Error(
      'could not build the menu bar app. It needs the Swift compiler from the ' +
      'Xcode Command Line Tools — install them with `xcode-select --install`.' +
      (detail ? `\n\n${detail}` : '')
    );
  }
}

export async function runMenuBar({ rebuild = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('the menu bar app is macOS only');
  if (rebuild || needsBuild()) {
    process.stdout.write('Building the menu bar app… ');
    build();
    process.stdout.write('done\n');
  }

  // Detached: the icon should outlive the terminal that started it.
  const child = spawn(BINARY, [STATE_PATH, NFS], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('Menu bar app running. Use its Quit item to stop it.');
}
