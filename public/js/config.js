// Client-side runtime config.
//
// The ICE servers are fetched from the server (/config.json) so they can be
// changed server-side without editing the client. We keep a sane fallback here
// in case that request fails.

export const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

// File-transfer tuning.
export const CHUNK_SIZE = 16 * 1024;          // 16 KB — safe across all browsers' data channels
export const HIGH_WATER_MARK = 8 * 1024 * 1024; // pause sending above 8 MB buffered
export const LOW_WATER_MARK = 1 * 1024 * 1024;  // resume when buffer drains below 1 MB

// Streaming-to-disk flow control (only engages when the receiver streams to disk).
// The receiver acks bytes it has COMMITTED to disk; the sender never runs more than
// CREDIT_WINDOW ahead of the last ack, which bounds the receiver's unwritten queue
// (RTCDataChannel offers no receive-side backpressure, so this app-level credit is
// what keeps memory flat on multi-GB transfers).
export const CREDIT_WINDOW = 8 * 1024 * 1024;   // sender stays within 8 MB of committed
export const ACK_INTERVAL = 256 * 1024;         // receiver acks at most every 256 KB
export const ACCEPT_TIMEOUT = 5 * 60 * 1000;    // give the human time to pick a save location
export const SAVE_TIMEOUT = 60 * 1000;          // wait for the receiver's per-file disk-commit ack
export const CREDIT_STALL_TIMEOUT = 30 * 1000;  // abort if the receiver stops acking entirely

// Load ICE servers from the server, falling back to the constant above.
export async function loadIceServers() {
  try {
    const res = await fetch('./config.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) return data.iceServers;
  } catch {
    /* fall through */
  }
  return FALLBACK_ICE_SERVERS;
}
