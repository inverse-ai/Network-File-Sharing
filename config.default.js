// Server + client configuration.
//
// Copy this file to `config.js` to override any values locally without
// touching version control (config.js is gitignored). If config.js is
// absent, these defaults are used.

export default {
  // Port the HTTP/HTTPS server listens on.
  port: process.env.PORT ? Number(process.env.PORT) : 3000,

  // Host to bind. 0.0.0.0 makes the app reachable from other devices on the
  // LAN (needed for cross-device transfers). Use 127.0.0.1 to restrict to this
  // machine only.
  host: process.env.HOST || '0.0.0.0',

  // ICE servers handed to the browser's RTCPeerConnection.
  //
  // STUN is enough for same-LAN transfers (peers usually connect directly via
  // local host candidates) and for many cross-network cases. TURN is only
  // required when BOTH peers sit behind symmetric NAT — add credentials below
  // when you stand up a TURN server (roadmap: cross-network phase).
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // Example TURN entry (fill in when you have a TURN server):
    // {
    //   urls: 'turn:turn.example.com:3478',
    //   username: 'user',
    //   credential: 'pass'
    // }
  ]
};
