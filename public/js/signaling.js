// WebSocket signaling client.
//
// A thin, reconnecting wrapper around the signaling WebSocket. It exposes an
// event-emitter-ish API and knows nothing about WebRTC — it just ferries
// JSON messages to/from the server.

export class Signaling extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.self = null;        // { id, name }
    this.room = null;
    this._reconnectDelay = 1000;
    this._closedByUser = false;
  }

  connect() {
    this._closedByUser = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this._reconnectDelay = 1000;
      this._emit('open');
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._handle(msg);
    });

    ws.addEventListener('close', () => {
      this._emit('close');
      if (!this._closedByUser) {
        setTimeout(() => this.connect(), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 1.6, 10000);
      }
    });

    ws.addEventListener('error', () => {
      // 'close' will follow and drive reconnection.
    });
  }

  _handle(msg) {
    switch (msg.type) {
      case 'welcome':
        this.self = msg.self;
        this.room = msg.room;
        this._emit('welcome', msg);
        break;
      case 'peers':
        this._emit('peers', msg);
        break;
      case 'signal':
        this._emit('signal', msg); // { from:{id,name}, payload }
        break;
      default:
        break;
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // Relay a WebRTC signal (SDP or ICE) to a specific peer.
  signal(toId, payload) {
    this._send({ type: 'signal', to: toId, payload });
  }

  rename(name) {
    this._send({ type: 'rename', name });
  }

  join(code) {
    this._send({ type: 'join', code });
  }

  close() {
    this._closedByUser = true;
    if (this.ws) this.ws.close();
  }

  // Tiny helper so callers can do signaling.on('signal', fn).
  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail));
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
