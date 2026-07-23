// File-transfer protocol over a WebRTC data channel.
//
// Wire protocol (all control frames are JSON strings; file bytes are raw
// ArrayBuffers so we can tell them apart by typeof):
//
//   sender  -> { t:'offer', sender, files:[{id,name,size,mime}] }
//   receiver-> { t:'accept' }  |  { t:'reject' }
//   sender  -> { t:'file-start', id }        (then N binary chunks)
//   sender  -> { t:'file-end', id }
//   sender  -> { t:'done' }                  (then closes the channel)
//
// Emits UI-friendly events: 'created', 'status', 'progress', 'complete',
// 'incoming', 'error'.

import { CHUNK_SIZE, HIGH_WATER_MARK, LOW_WATER_MARK } from './config.js';

let idSeq = 0;
const nextId = () => `f${Date.now().toString(36)}-${idSeq++}`;

export class Transfers extends EventTarget {
  /** @param {import('./webrtc.js').RTC} rtc */
  constructor(rtc) {
    super();
    this.rtc = rtc;
    // Incoming channels (peer initiated a send to us).
    this.rtc.on('channel', ({ peerId, channel }) => this._attachReceiver(peerId, channel));
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail));
  }
  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // -------------------------------------------------------------------------
  // SEND
  // -------------------------------------------------------------------------
  /**
   * @param {string} peerId  target peer id
   * @param {string} peerName display name (for UI)
   * @param {string} selfName our display name (sent to the receiver)
   * @param {File[]} files
   */
  async send(peerId, peerName, selfName, files) {
    const meta = files.map((f) => ({
      uid: nextId(),
      file: f,
      name: f.name,
      size: f.size,
      mime: f.type || 'application/octet-stream'
    }));

    // Create UI rows immediately (pending).
    for (const m of meta) {
      this._emit('created', {
        id: m.uid, name: m.name, size: m.size, direction: 'out', peer: peerName
      });
      this._emit('status', { id: m.uid, status: 'pending', label: 'waiting for accept…' });
    }

    let channel;
    try {
      channel = await this.rtc.openChannel(peerId, `t-${meta[0].uid}`);
    } catch (err) {
      for (const m of meta) this._emit('status', { id: m.uid, status: 'failed', label: 'connection failed' });
      this._emit('error', { message: `Could not connect to ${peerName}.` });
      return;
    }

    // Wait for the receiver's accept/reject.
    const decision = new Promise((resolve) => {
      channel.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'accept') resolve(true);
        else if (msg.t === 'reject') resolve(false);
      };
    });

    channel.send(JSON.stringify({
      t: 'offer',
      sender: selfName,
      files: meta.map((m) => ({ id: m.uid, name: m.name, size: m.size, mime: m.mime }))
    }));

    const accepted = await decision;
    if (!accepted) {
      for (const m of meta) this._emit('status', { id: m.uid, status: 'declined', label: 'declined' });
      try { channel.close(); } catch {}
      return;
    }

    // Stream each file sequentially.
    try {
      for (const m of meta) {
        this._emit('status', { id: m.uid, status: 'sending', label: 'sending' });
        channel.send(JSON.stringify({ t: 'file-start', id: m.uid }));
        await this._streamFile(channel, m);
        channel.send(JSON.stringify({ t: 'file-end', id: m.uid }));
        this._emit('progress', { id: m.uid, transferred: m.size, total: m.size });
        this._emit('status', { id: m.uid, status: 'complete', label: 'sent' });
        this._emit('complete', { id: m.uid, direction: 'out' });
      }
      channel.send(JSON.stringify({ t: 'done' }));
    } catch (err) {
      this._emit('error', { message: 'Transfer interrupted.' });
    } finally {
      // Give the buffer a moment to flush, then close.
      const closeWhenDrained = () => {
        if (channel.bufferedAmount === 0) { try { channel.close(); } catch {} }
        else setTimeout(closeWhenDrained, 100);
      };
      closeWhenDrained();
    }
  }

  async _streamFile(channel, m) {
    const { file, uid, size } = m;
    let offset = 0;
    while (offset < size) {
      if (channel.bufferedAmount > HIGH_WATER_MARK) {
        await this._drain(channel);
      }
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      channel.send(buf);
      offset += buf.byteLength;
      this._emit('progress', { id: uid, transferred: offset, total: size });
    }
  }

  _drain(channel) {
    return new Promise((resolve) => {
      channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
      const onLow = () => { channel.removeEventListener('bufferedamountlow', onLow); resolve(); };
      channel.addEventListener('bufferedamountlow', onLow);
    });
  }

  // -------------------------------------------------------------------------
  // RECEIVE
  // -------------------------------------------------------------------------
  _attachReceiver(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    const state = {
      files: new Map(),   // id -> { name, size, mime, chunks:[], received:0 }
      activeId: null,
      sender: 'A device'
    };

    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        this._onControl(channel, state, msg);
      } else {
        // Binary chunk for the active file.
        const rec = state.files.get(state.activeId);
        if (!rec) return;
        rec.chunks.push(ev.data);
        rec.received += ev.data.byteLength;
        this._emit('progress', { id: state.activeId, transferred: rec.received, total: rec.size });
      }
    };

    channel.onclose = () => {
      // Mark any unfinished files as failed.
      for (const [id, rec] of state.files) {
        if (rec.received < rec.size) {
          this._emit('status', { id, status: 'failed', label: 'connection lost' });
        }
      }
    };
  }

  _onControl(channel, state, msg) {
    switch (msg.t) {
      case 'offer': {
        state.sender = msg.sender || 'A device';
        // Stage the files but don't create rows until the user accepts.
        state.pending = msg.files;
        this._emit('incoming', {
          sender: state.sender,
          files: msg.files,
          accept: () => {
            for (const f of msg.files) {
              state.files.set(f.id, {
                name: f.name, size: f.size, mime: f.mime, chunks: [], received: 0
              });
              this._emit('created', {
                id: f.id, name: f.name, size: f.size, direction: 'in', peer: state.sender
              });
              this._emit('status', { id: f.id, status: 'pending', label: 'waiting…' });
            }
            channel.send(JSON.stringify({ t: 'accept' }));
          },
          reject: () => {
            channel.send(JSON.stringify({ t: 'reject' }));
            try { channel.close(); } catch {}
          }
        });
        break;
      }
      case 'file-start': {
        state.activeId = msg.id;
        this._emit('status', { id: msg.id, status: 'receiving', label: 'receiving' });
        break;
      }
      case 'file-end': {
        const rec = state.files.get(msg.id);
        if (rec) {
          const blob = new Blob(rec.chunks, { type: rec.mime });
          rec.chunks = []; // free memory
          const url = URL.createObjectURL(blob);
          this._emit('progress', { id: msg.id, transferred: rec.size, total: rec.size });
          this._emit('status', { id: msg.id, status: 'complete', label: 'received' });
          this._emit('complete', { id: msg.id, direction: 'in', url, name: rec.name });
        }
        state.activeId = null;
        break;
      }
      case 'done': {
        try { channel.close(); } catch {}
        break;
      }
      default:
        break;
    }
  }
}
