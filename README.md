# Network File Sharing

Send files **directly between devices** — Mac, Windows, Linux, phones — over your
local network, with nothing to install on the receiving machine and no SMB shares,
mounted drives, or OS permissions to fight.

It uses **WebRTC data channels**: once two browsers are introduced, files travel
**peer-to-peer and DTLS-encrypted** straight between the devices. On a LAN they
connect directly (full local speed). A tiny Node server only plays matchmaker —
**it never sees your files**.

> Built to solve a specific pain: reaching files on a Windows box from macOS/Ubuntu
> keeps tripping over services and permissions. Connecting the devices over the LAN
> with WebRTC sidesteps all of that.

---

## Quick start

Requires **Node.js 18+** and **nothing else** — there are no dependencies to install.

```bash
node server.js
# or, equivalently:  npm start
```

Then open the printed URL. The server prints both a local and a network address:

```
  Local:    http://localhost:3000
  Network:  http://192.168.1.42:3000
```

- On **this machine**, open `http://localhost:3000`.
- On **another device on the same Wi‑Fi/LAN**, open the `Network` URL (e.g.
  `http://192.168.1.42:3000`). The two devices appear to each other automatically
  under **Nearby devices**.
- **Send:** drop files onto a device card (or click a device, or use the drop
  zone and pick a target). The receiver gets an **Accept / Decline** prompt, then
  the file transfers directly.

## HTTPS mode (recommended for phones / Safari / iOS)

WebRTC needs a *secure context* in some browsers (notably Safari and iOS) when the
page isn't served from `localhost`. Run the HTTPS server, which generates a
self‑signed certificate on first launch:

```bash
npm run start:https
```

Open the `https://<lan-ip>:3000` URL on each device and **accept the one‑time
certificate warning** (it's your own machine). Chrome and Firefox on desktop
generally work over plain `http://<lan-ip>` too, so try `node server.js` first there.

> HTTPS mode generates the self‑signed cert with **OpenSSL** (bundled with Git for
> Windows). If OpenSSL isn't on your PATH, install it or drop your own
> `certs/key.pem` + `certs/cert.pem`.

---

## How it works

```
Device A (browser) ── WebSocket signaling ──► Signaling server ◄── signaling ── Device B (browser)
        │                                     (Node: Express+ws)                      │
        │                                  relays SDP / ICE only                      │
        │                                  never sees file bytes                      │
        └════════════ WebRTC DTLS data channel — the file bytes ═════════════════════┘
                        direct on the LAN via local ICE candidates
```

1. Each browser opens a WebSocket to the signaling server and is put in a **room**.
   By default the room is your network group (devices sharing a public IP — i.e. the
   same LAN — see each other automatically). A **Join by code** box lets you pair
   devices explicitly (and is the hook for cross‑network use later).
2. To send, the sender's browser opens a WebRTC connection to the target and a
   dedicated **data channel**, exchanging SDP/ICE through the signaling server.
3. The receiver approves the transfer; then the file streams over the encrypted
   data channel in **16 KB chunks** with backpressure, progress, speed and ETA.

### Receiving large files (streaming to disk)

When the receiver's browser supports the **File System Access API** in a secure
context (that means **HTTPS**, or `localhost`), an accepted file streams **straight
to disk** as it arrives — you pick a destination up front (a file for a single
transfer, a folder for a batch), and chunks are written and freed immediately.
Peak memory stays around a few MB regardless of file size, so multi‑GB transfers
don't blow up the tab.

To keep the receiver's disk from being outrun by a fast network, the receiver acks
bytes it has actually **committed to disk**, and the sender never streams more than
a small window (8 MB) ahead of those acks. The sender also waits for a per‑file
"saved" confirmation before reporting success, so a file is provably on disk before
the channel closes.

Where the API isn't available (Firefox, Safari, or plain `http://<lan-ip>`), the
receiver **falls back** to buffering the file in memory and offering it as a normal
download — fine for everyday files, but this is the case to avoid for very large
ones, so **serve over HTTPS** (`npm run start:https`) when you need to move big
files reliably.

### Project layout

| Path | Role |
|------|------|
| `server.js` | Static host + WebSocket signaling (rooms, LAN grouping, SDP/ICE relay); HTTP & HTTPS modes. Pure Node stdlib — no dependencies |
| `config.default.js` | Port, bind host, ICE (STUN) servers — copy to `config.js` to override |
| `public/index.html` · `public/css/style.css` | UI |
| `public/js/signaling.js` | Reconnecting WebSocket signaling client |
| `public/js/webrtc.js` | `RTCPeerConnection` management (perfect‑negotiation, glare‑safe) |
| `public/js/transfer.js` | Chunked send/receive protocol, progress, and streaming‑to‑disk with credit‑based flow control |
| `public/js/app.js` | UI state and wiring |

## Configuration

Copy `config.default.js` to `config.js` (gitignored) to change the port, bind host,
or ICE servers without touching version control. For example, add a TURN server for
harder NATs:

```js
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
]
```

## Requirements

- **Node.js 18+**
- Both devices reachable on the same network for LAN transfers (or a shared room
  code for manual pairing). If they can't see each other, check the host firewall
  allows inbound connections on the port (default `3000`).

## Security notes

- File data is **end‑to‑end DTLS‑encrypted** by WebRTC and flows peer‑to‑peer.
- The signaling server only handles connection metadata (device names, SDP, ICE) —
  never file names or contents.
- Every incoming transfer requires **explicit acceptance** on the receiving device.

---

## Roadmap

- **URL access without the app** — an HTTP share‑link so someone without the app can
  download a file from a plain browser URL. *(Not in v1. Note: it's HTTP, not FTP —
  browsers removed `ftp://` support, so an FTP server wouldn't open in a browser.)*
- **Cross‑network** — a deployable public signaling server plus TURN credentials, and
  shareable room links so two people on different networks can pair.
- **Bluetooth + native** — a Tauri/Electron companion using an OS Bluetooth stack
  (RFCOMM/OBEX) for offline PC‑to‑PC transfer, plus native filesystem and a
  background service. *(Browsers can't do PC‑to‑PC Bluetooth; Web Bluetooth only
  talks to BLE peripherals, so this needs a native app.)*

## License

MIT © Inverse.AI
