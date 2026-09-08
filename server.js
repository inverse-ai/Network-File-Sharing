// Signaling server for the WebRTC file-sharing app.
//
// ZERO external dependencies — just Node's standard library. It:
//   1. Serves the static browser client from ./public
//   2. Exposes the runtime ICE config at /config.json
//   3. Runs a minimal WebSocket signaling channel that:
//        - assigns each peer an id + friendly name
//        - groups peers into "rooms" for discovery
//            * default room = the peer's network group (public IP) => LAN auto-discovery
//            * explicit room = a user-supplied join code (cross-network / manual pairing)
//        - relays SDP offers/answers and ICE candidates between two peers
//
// File bytes NEVER pass through this server. They travel peer-to-peer over the
// browsers' DTLS-encrypted WebRTC data channel. The server only sees signaling
// metadata (device names, SDP, ICE).

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { lanAddresses, subnetKeyFor, findFreePort } from './src/net.js';
import { ensureCert, certCoversCurrentAddresses, certPaths } from './src/cert.js';
import { writeState, clearState } from './src/service/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Config: prefer a local ./config.js override, else fall back to defaults.
// ---------------------------------------------------------------------------
async function loadConfig() {
  const overridePath = path.join(__dirname, 'config.js');
  const chosen = fs.existsSync(overridePath) ? overridePath : path.join(__dirname, 'config.default.js');
  const mod = await import(pathToFileURL(chosen).href);
  return mod.default;
}

const config = await loadConfig();
const useHttps = process.argv.includes('--https');

// ---------------------------------------------------------------------------
// Friendly device names.
// ---------------------------------------------------------------------------
const ADJECTIVES = [
  'Amber', 'Azure', 'Crimson', 'Golden', 'Jade', 'Silver', 'Coral', 'Violet',
  'Cobalt', 'Scarlet', 'Teal', 'Ivory', 'Onyx', 'Copper', 'Indigo', 'Olive'
];
const ANIMALS = [
  'Falcon', 'Otter', 'Lynx', 'Heron', 'Fox', 'Bison', 'Wren', 'Panther',
  'Gecko', 'Marlin', 'Raven', 'Ibex', 'Koala', 'Puma', 'Stork', 'Yak'
];
function randomName() {
  return `${ADJECTIVES[crypto.randomInt(ADJECTIVES.length)]}-${ANIMALS[crypto.randomInt(ANIMALS.length)]}`;
}

// ---------------------------------------------------------------------------
// Network grouping: peers on the same network share a default room, giving
// AirDrop-style auto-discovery.
//
// The address we see for a peer depends on where this server sits. Behind a
// reverse proxy on the internet, x-forwarded-for carries the peer's public IP
// and peers on one LAN share it. But in the normal case -- this server running
// *on* the LAN -- every peer connects from its own private address, so keying
// the room on the raw address puts each device in a room of one and nothing is
// ever discovered. Key on the enclosing subnet instead, taken from our own
// interface netmasks so it reflects the real network rather than assuming /24.
// ---------------------------------------------------------------------------
function networkGroupFor(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = xff ? String(xff).split(',')[0].trim() : (req.socket.remoteAddress || '');
  ip = ip.replace(/^::ffff:/, '');
  if (ip === '::1') ip = '127.0.0.1';

  // A loopback peer is a browser on this very machine, which sits on every LAN
  // this host is attached to; put it with the first of them so the host's own
  // browser discovers the phones. (On a multi-homed host that is a guess --
  // open the printed Network URL rather than localhost to pin it explicitly.)
  if (ip.startsWith('127.')) {
    const [first] = lanAddresses();
    const key = first ? subnetKeyFor(first) : null;
    return `lan:${key || ip}`;
  }

  // Falls back to the bare address for public IPs and IPv6, where the
  // shared-address assumption above already holds.
  return `lan:${subnetKeyFor(ip) || ip}`;
}

// ---------------------------------------------------------------------------
// Static file serving (pure Node).
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC, pathname);
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function requestHandler(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/config.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ iceServers: config.iceServers }));
    return;
  }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, peers: peers.size, rooms: rooms.size }));
    return;
  }
  serveStatic(req, res);
}

// ---------------------------------------------------------------------------
// Minimal WebSocket server (RFC 6455) — text frames + ping/pong + close.
// Enough for JSON signaling; no third-party library needed.
// ---------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20; // 1 MB guard for signaling messages

class WSConn extends EventEmitter {
  constructor(socket) {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.socket = socket;
    this._buf = Buffer.alloc(0);
    this._fragOpcode = null;
    this._fragments = [];
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  _onData(data) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, data]) : data;
    this._parse();
  }

  _parse() {
    while (true) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset); offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const hi = buf.readUInt32BE(offset);
        const lo = buf.readUInt32BE(offset + 4);
        len = hi * 2 ** 32 + lo; offset += 8;
      }
      if (len > MAX_FRAME) { this.close(); return; }

      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4); offset += 4;
      }
      if (buf.length < offset + len) return; // wait for the rest of the payload

      let payload = buf.subarray(offset, offset + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      this._buf = buf.subarray(offset + len);

      // Control frames
      if (opcode === 0x8) { this.close(); return; }        // close
      if (opcode === 0x9) { this._frame(0xA, payload); continue; } // ping -> pong
      if (opcode === 0xA) { continue; }                    // pong

      // Data frames (0x0 continuation, 0x1 text, 0x2 binary)
      if (opcode === 0x0) {
        this._fragments.push(payload);
      } else {
        this._fragOpcode = opcode;
        this._fragments = [payload];
      }
      if (fin) {
        const full = Buffer.concat(this._fragments);
        const op = this._fragOpcode;
        this._fragments = [];
        this._fragOpcode = null;
        if (op === 0x1) this.emit('message', full.toString('utf8'));
        // binary (0x2) is unused by our protocol -> ignored
      }
    }
  }

  _frame(opcode, payload) {
    if (this.readyState !== 1) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { /* ignore */ }
  }

  send(str) {
    this._frame(0x1, Buffer.from(str, 'utf8'));
  }

  close() {
    // If we're not open, just make sure the socket is torn down. Do NOT set
    // readyState here — _closed() owns that transition and the 'close' emit.
    if (this.readyState !== 1) { try { this.socket.end(); } catch {} return; }
    try { this._frame(0x8, Buffer.alloc(0)); } catch {}
    try { this.socket.end(); } catch {}
    this._closed();
  }
}

// ---------------------------------------------------------------------------
// HTTP(S) server bootstrap.
// ---------------------------------------------------------------------------
// Certificates live outside the checkout when running as an installed service,
// so an upgrade or a fresh clone does not invalidate the trust each device has
// already granted. --cert-dir is how the launch agent points us at them.
const certDirArg = process.argv.indexOf('--cert-dir');
const CERT_DIR = certDirArg !== -1 && process.argv[certDirArg + 1]
  ? path.resolve(process.argv[certDirArg + 1])
  : path.join(__dirname, 'certs');

let server;
if (useHttps) {
  let material;
  try {
    material = ensureCert(CERT_DIR);
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
  if (material.regenerated === 'address-change') {
    console.log('\n  This machine\'s address changed, so the certificate was reissued.');
    console.log('  Devices will show the trust prompt once more.\n');
  }
  server = https.createServer({ key: material.key, cert: material.cert }, requestHandler);
}
else {
  server = http.createServer(requestHandler);
}

// WebSocket upgrade handshake.
server.on('upgrade', (req, socket, head) => {
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const ws = new WSConn(socket);
  if (head && head.length) ws._onData(head);
  onConnection(ws, req);
});

// ---------------------------------------------------------------------------
// Signaling state + logic.
// ---------------------------------------------------------------------------
/** @type {Map<string, {id:string,name:string,room:string,defaultRoom:string,ws:WSConn}>} */
const peers = new Map();
/** @type {Map<string, Set<string>>} room -> set of peer ids */
const rooms = new Map();

function joinRoom(peer, room) {
  leaveRoom(peer);
  peer.room = room;
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(peer.id);
}
function leaveRoom(peer) {
  if (!peer.room) return;
  const set = rooms.get(peer.room);
  if (set) {
    set.delete(peer.id);
    if (set.size === 0) rooms.delete(peer.room);
  }
  peer.room = null;
}
function roommates(peer) {
  const set = rooms.get(peer.room);
  if (!set) return [];
  return [...set].filter((id) => id !== peer.id).map((id) => peers.get(id)).filter(Boolean);
}
function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function peerInfo(p) {
  return { id: p.id, name: p.name };
}
function broadcastRoster(room) {
  const set = rooms.get(room);
  if (!set) return;
  for (const id of set) {
    const p = peers.get(id);
    if (!p) continue;
    const others = [...set].filter((x) => x !== id).map((x) => peerInfo(peers.get(x)));
    send(p.ws, { type: 'peers', peers: others });
  }
}

function onConnection(ws, req) {
  const peer = {
    id: crypto.randomUUID(),
    name: randomName(),
    room: null,
    defaultRoom: networkGroupFor(req),
    ws
  };
  peers.set(peer.id, peer);
  joinRoom(peer, peer.defaultRoom);

  send(ws, {
    type: 'welcome',
    self: peerInfo(peer),
    room: peer.room,
    peers: roommates(peer).map(peerInfo)
  });
  broadcastRoster(peer.room);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'signal': {
        const target = peers.get(msg.to);
        if (!target || target.room !== peer.room) return; // only within the same room
        send(target.ws, { type: 'signal', from: peerInfo(peer), payload: msg.payload });
        break;
      }
      case 'rename': {
        if (typeof msg.name === 'string' && msg.name.trim()) {
          peer.name = msg.name.trim().slice(0, 40);
          broadcastRoster(peer.room);
        }
        break;
      }
      case 'join': {
        const code = typeof msg.code === 'string' ? msg.code.trim() : '';
        const target = code ? `code:${code.toLowerCase()}` : peer.defaultRoom;
        const prevRoom = peer.room;
        joinRoom(peer, target);
        send(ws, {
          type: 'welcome',
          self: peerInfo(peer),
          room: peer.room,
          peers: roommates(peer).map(peerInfo)
        });
        // Notify BOTH the room we left (so they drop us) and the room we joined.
        if (prevRoom && prevRoom !== peer.room) broadcastRoster(prevRoom);
        broadcastRoster(peer.room);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    const room = peer.room;
    leaveRoom(peer);
    peers.delete(peer.id);
    if (room) broadcastRoster(room);
  });
}

// ---------------------------------------------------------------------------
// Listen + print reachable URLs.
// ---------------------------------------------------------------------------
const scheme = useHttps ? 'https' : 'http';

// Dev servers cluster on the usual ports, and losing to one is confusing rather
// than fatal: on macOS a 0.0.0.0 bind happily coexists with an existing
// 127.0.0.1 bind on the same port, so the app comes up reachable from phones
// but dead on localhost. Step aside instead.
const port = await findFreePort(config.port, config.host);

server.listen(port, config.host, () => {
  if (port !== config.port) {
    console.log(`\n  Port ${config.port} was busy; using ${port} instead.`);
  }
  const lines = [
    '',
    '  Network File Sharing  —  WebRTC peer-to-peer',
    '  ------------------------------------------------',
    `  Local:    ${scheme}://localhost:${port}`
  ];
  for (const ip of lanAddresses()) lines.push(`  Network:  ${scheme}://${ip}:${port}`);
  lines.push('');
  if (!useHttps) {
    lines.push('  Tip: for Safari/iOS or hardened browsers, run with --https');
    lines.push('       (accept the one-time self-signed certificate warning).');
    lines.push('');
  }
  console.log(lines.join('\n'));

  writeState({ pid: process.pid, port, scheme, https: useHttps, certDir: useHttps ? CERT_DIR : null });
});

// ---------------------------------------------------------------------------
// Keep the certificate valid as the machine moves between networks.
// ---------------------------------------------------------------------------
// A laptop changes address constantly -- new DHCP lease, different Wi-Fi, a VPN
// coming up -- and each time, a certificate minted for the old address stops
// validating for the new one. Rather than make that the user's problem, watch
// for the drift and swap the material in place: setSecureContext re-arms the
// listener without dropping it, so the server never goes down for this.
if (useHttps) {
  const CHECK_INTERVAL_MS = 30_000;
  let known = lanAddresses().join(',');

  const timer = setInterval(() => {
    const current = lanAddresses();
    if (current.join(',') === known) return;
    known = current.join(',');

    const { certPath } = certPaths(CERT_DIR);
    if (certCoversCurrentAddresses(certPath, current)) return;

    try {
      const fresh = ensureCert(CERT_DIR, { addresses: current, force: true });
      server.setSecureContext({ key: fresh.key, cert: fresh.cert });
      console.log(`\n  Address changed to ${current.join(', ')} — certificate reissued.`);
      for (const ip of current) console.log(`  Network:  ${scheme}://${ip}:${port}`);
      console.log('  Devices will show the trust prompt once more.\n');
      writeState({ pid: process.pid, port, scheme, https: true, certDir: CERT_DIR });
    } catch (err) {
      console.error(`  Could not reissue the certificate: ${err.message}`);
    }
  }, CHECK_INTERVAL_MS);
  timer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { clearState(); process.exit(0); });
}
