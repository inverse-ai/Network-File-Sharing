// Self-signed certificate lifecycle for HTTPS mode.
//
// Browsers match a hostname against the certificate's subjectAltName and ignore
// the legacy CN fallback (Chrome dropped it in v58), so the cert has to name
// every address the app is reached by -- including the LAN IPs, which is how
// phones connect. Those IPs come from DHCP, so they change: a cert minted on
// 192.168.1.207 stops validating the moment the router hands out .156, and the
// user is back to a warning page they cannot always bypass on Android.
//
// So the cert is not a build-time artifact. It is derived state that has to be
// re-derived whenever the host's addresses drift.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lanAddresses } from './net.js';

export const CERT_SUBJECT = '/CN=network-file-sharing.local';

/** The SAN entries a cert must carry to cover how this host is reached today. */
export function desiredAltNames(addresses = lanAddresses()) {
  const names = ['DNS:network-file-sharing.local', 'DNS:localhost', 'IP:127.0.0.1'];
  for (const addr of addresses) names.push(`IP:${addr}`);
  return names;
}

export function certPaths(dir) {
  return { dir, keyPath: path.join(dir, 'key.pem'), certPath: path.join(dir, 'cert.pem') };
}

/** IP entries actually present in an existing cert, or null if unreadable. */
export function certAddresses(certPath) {
  try {
    const x509 = new crypto.X509Certificate(fs.readFileSync(certPath));
    const san = x509.subjectAltName || '';
    // Node renders entries as "DNS:foo, IP Address:1.2.3.4".
    return san
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith('IP Address:'))
      .map((entry) => entry.slice('IP Address:'.length).trim());
  } catch {
    return null;
  }
}

/**
 * Whether the cert on disk still covers every address we are reachable at.
 *
 * Deliberately one-directional: a cert naming an address we no longer hold is
 * harmless (the browser only checks the address it dialled), but one *missing*
 * a current address breaks that connection outright. Regenerating on the
 * harmless case too would churn the cert on every VPN connect and force a fresh
 * trust prompt on every device each time.
 */
export function certCoversCurrentAddresses(certPath, addresses = lanAddresses()) {
  const present = certAddresses(certPath);
  if (present === null) return false;
  return addresses.every((addr) => present.includes(addr));
}

function generate({ keyPath, certPath, dir }, addresses) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '825', '-subj', CERT_SUBJECT,
      '-addext', `subjectAltName=${desiredAltNames(addresses).join(',')}`
    ], { stdio: 'ignore' });
  } catch {
    const err = new Error(
      'HTTPS mode needs OpenSSL 1.1.1+ to generate a self-signed certificate, ' +
      'but it was not found on PATH (or is too old for -addext). Install ' +
      'OpenSSL, or drop your own certs at certs/key.pem and certs/cert.pem.'
    );
    err.code = 'ENOOPENSSL';
    throw err;
  }
}

/**
 * Load the cert, minting a new one when it is missing or has gone stale.
 *
 * Returns the material plus why it was (re)generated, so callers can tell the
 * user their devices are about to see a one-time warning again.
 */
export function ensureCert(dir, { addresses = lanAddresses(), force = false } = {}) {
  const paths = certPaths(dir);
  const { keyPath, certPath } = paths;

  const exists = fs.existsSync(keyPath) && fs.existsSync(certPath);
  let reason = null;
  if (force) reason = 'forced';
  else if (!exists) reason = 'missing';
  else if (!certCoversCurrentAddresses(certPath, addresses)) reason = 'address-change';

  if (reason) generate(paths, addresses);

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    regenerated: reason,
    addresses: certAddresses(certPath) || []
  };
}
