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
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// Network grouping: peers sharing a public IP are (almost always) on the same
// LAN, so we use that as the default room => AirDrop-style auto-discovery.
// ---------------------------------------------------------------------------
function networkGroupFor(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = xff ? String(xff).split(',')[0].trim() : (req.socket.remoteAddress || '');
  ip = ip.replace(/^::ffff:/, '');
  if (ip === '::1') ip = '127.0.0.1';
  return `lan:${ip}`;
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
let server;
if (useHttps) {
  const { key, cert } = ensureCert();
  server = https.createServer({ key, cert }, requestHandler);
} else {
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
// Self-signed certificate for HTTPS mode (via OpenSSL, cached in ./certs).
// ---------------------------------------------------------------------------
function ensureCert() {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '825', '-subj', '/CN=network-file-sharing.local'
    ], { stdio: 'ignore' });
  } catch {
    console.error(
      '\n  HTTPS mode needs OpenSSL to generate a self-signed certificate, but it\n' +
      '  was not found on PATH. Either install OpenSSL (Git for Windows ships it),\n' +
      '  or drop your own certs at certs/key.pem and certs/cert.pem.\n'
    );
    process.exit(1);
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

// ---------------------------------------------------------------------------
// Listen + print reachable URLs.
// ---------------------------------------------------------------------------
function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(config.port, config.host, () => {
  const scheme = useHttps ? 'https' : 'http';
  const lines = [
    '',
    '  Network File Sharing  —  WebRTC peer-to-peer',
    '  ------------------------------------------------',
    `  Local:    ${scheme}://localhost:${config.port}`
  ];
  for (const ip of lanAddresses()) lines.push(`  Network:  ${scheme}://${ip}:${config.port}`);
  lines.push('');
  if (!useHttps) {
    lines.push('  Tip: for Safari/iOS or hardened browsers, run with --https');
    lines.push('       (accept the one-time self-signed certificate warning).');
    lines.push('');
  }
  console.log(lines.join('\n'));
});
