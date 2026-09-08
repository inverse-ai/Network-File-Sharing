// WebRTC connection manager.
//
// Maintains one RTCPeerConnection per remote peer and implements the standard
// "perfect negotiation" pattern so that two peers trying to connect at the same
// time can't deadlock (glare-safe). Transfers get their own dedicated data
// channel; incoming channels are surfaced via a 'channel' event.
//
// This module carries NO file logic — it just gives you open data channels.

export class RTC extends EventTarget {
  /**
   * @param {import('./signaling.js').Signaling} signaling
   * @param {RTCIceServer[]} iceServers
   */
  constructor(signaling, iceServers) {
    super();
    this.signaling = signaling;
    this.iceServers = iceServers;
    /** @type {Map<string, any>} peerId -> connection record */
    this.conns = new Map();

    // Route inbound signaling messages to the right peer connection.
    this.signaling.on('signal', (msg) => this._onSignal(msg));
  }

  get selfId() {
    return this.signaling.self ? this.signaling.self.id : '';
  }

  _record(peerId) {
    let rec = this.conns.get(peerId);
    if (rec) return rec;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    rec = {
      pc,
      peerId,
      // Deterministic politeness: the peer with the larger id is "polite".
      polite: this.selfId > peerId,
      makingOffer: false,
      ignoreOffer: false
    };
    this.conns.set(peerId, rec);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signaling.signal(peerId, { candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        rec.makingOffer = true;
        await pc.setLocalDescription();
        this.signaling.signal(peerId, { description: pc.localDescription });
      } catch (err) {
        console.error('negotiation error', err);
      } finally {
        rec.makingOffer = false;
      }
    };

    pc.ondatachannel = (ev) => {
      this.dispatchEvent(new CustomEvent('channel', {
        detail: { peerId, channel: ev.channel, incoming: true }
      }));
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.dispatchEvent(new CustomEvent('connectionstate', {
          detail: { peerId, state: pc.connectionState }
        }));
      }
    };

    return rec;
  }

  async _onSignal(msg) {
    const peerId = msg.from.id;
    const { description, candidate } = msg.payload || {};
    const rec = this._record(peerId);
    const { pc } = rec;

    try {
      if (description) {
        const offerCollision =
          description.type === 'offer' &&
          (rec.makingOffer || pc.signalingState !== 'stable');

        rec.ignoreOffer = !rec.polite && offerCollision;
        if (rec.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.signaling.signal(peerId, { description: pc.localDescription });
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!rec.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('signal handling error', err);
    }
  }

  /**
   * Open an outbound data channel to a peer for a transfer session.
   * Resolves once the channel is open and ready to use.
   * @returns {Promise<RTCDataChannel>}
   */
  openChannel(peerId, label) {
    const { pc } = this._record(peerId);
    const channel = pc.createDataChannel(label, { ordered: true });
    channel.binaryType = 'arraybuffer';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Connection timed out')), 30000);
      channel.onopen = () => { clearTimeout(timer); resolve(channel); };
      channel.onerror = (e) => { clearTimeout(timer); reject(e.error || new Error('Channel error')); };
    });
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail));
  }
}
