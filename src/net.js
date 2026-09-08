// Address helpers shared by the server, the CLI and the cert generator.
//
// Pure Node standard library, like the rest of the project.

import net from 'node:net';
import os from 'node:os';

/** Every non-internal IPv4 address this host currently holds. */
export function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

/**
 * The address a phone should actually be pointed at.
 *
 * A laptop is routinely on more than one IPv4 network at once -- Wi-Fi plus a
 * VPN, a container bridge, or a virtual-machine host interface -- and only one
 * of those is the LAN the phone shares. Prefer the RFC1918 ranges handed out by
 * home routers, and among those prefer the interface that carries the default
 * route, which is the one a phone on the same Wi-Fi can actually reach.
 */
export function primaryLanAddress() {
  const addrs = lanAddresses();
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  return [...addrs].sort((a, b) => score(a) - score(b))[0] || null;
}

export function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    n = n * 256 + byte;
  }
  return n;
}

/** The subnet of one of our own interfaces containing `ip`, as "base/mask". */
export function subnetKeyFor(ip) {
  const addr = ipv4ToInt(ip);
  if (addr === null) return null;
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const local = ipv4ToInt(iface.address);
      const mask = ipv4ToInt(iface.netmask);
      if (local === null || mask === null) continue;
      if ((local & mask) === (addr & mask)) {
        return `${(local & mask) >>> 0}/${mask >>> 0}`;
      }
    }
  }
  return null;
}

/** True when nothing is already listening on `port` at `host`. */
export function portIsFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/**
 * `preferred`, or the next free port after it.
 *
 * Dev servers cluster on the usual ports (3000 especially), and colliding with
 * one is confusing rather than fatal -- the app half-works, reachable on the
 * LAN but not on localhost, because macOS lets a 0.0.0.0 bind coexist with an
 * existing 127.0.0.1 bind on the same port.
 */
export async function findFreePort(preferred, host = '0.0.0.0', attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const port = preferred + i;
    if (await portIsFree(port, host)) return port;
  }
  throw new Error(`No free port in ${preferred}-${preferred + attempts - 1}`);
}
