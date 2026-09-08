// File-transfer protocol over a WebRTC data channel.
//
// Wire protocol (control frames are JSON strings; file bytes are raw ArrayBuffers
// so the receiver can tell them apart by typeof):
//
//   sender   -> { t:'offer', sender, files:[{id,name,size,mime}] }
//   receiver -> { t:'accept', flow:'ack'|'none' }  |  { t:'reject' }
//   sender   -> { t:'file-start', id }        (then N binary chunks)
//   receiver -> { t:'ack', bytes }            (disk mode only; cumulative COMMITTED bytes)
//   sender   -> { t:'file-end', id }
//   receiver -> { t:'saved', id }             (after the bytes are safely on disk / in a Blob)
//        or  -> { t:'file-error', id, msg }   (receiver failed to save)
//   sender   -> { t:'done' }                  (only after EVERY file is 'saved'); then closes
//
// Two receive modes:
//   'disk'   — File System Access API: chunks stream straight to a file/folder the
//              user picked, so multi-GB files never buffer in RAM. Requires a secure
//              context (https or localhost). Flow-controlled via 'ack' credit so the
//              unwritten queue stays bounded to ~CREDIT_WINDOW even if disk < network.
//   'memory' — fallback (unsupported API / insecure origin): chunks buffer into a
//              Blob and download at the end, as before.
//
// The sender waits for the receiver's per-file 'saved' before reporting success or
// tearing down, so a file is provably committed before the channel closes.
//
// Emits UI events: 'created', 'status', 'progress', 'complete', 'incoming', 'error'.

import {
  CHUNK_SIZE, HIGH_WATER_MARK, LOW_WATER_MARK,
  CREDIT_WINDOW, ACK_INTERVAL, ACCEPT_TIMEOUT, SAVE_TIMEOUT, CREDIT_STALL_TIMEOUT
} from './config.js';

let idSeq = 0;
const nextId = () => `f${Date.now().toString(36)}-${idSeq++}`;

// Strip anything the OS/filesystem rejects from a sender-supplied filename.
function sanitizeName(name) {
  let n = String(name || 'file')
    .replace(/[/\\]/g, '_')          // path separators
    .replace(/[\x00-\x1f<>:"|?*]/g, '_') // control + Windows-illegal chars
    .replace(/^\.+/, '')             // leading dots
    .trim();
  if (!n) n = 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(n)) n = '_' + n; // reserved
  return n.slice(0, 200);
}

// Pick a name that collides neither with an earlier file in this batch NOR with a
// file already on disk in the chosen directory, so we never silently clobber the
// user's existing files (showDirectoryPicker grants folder write with no per-file
// overwrite prompt, unlike showSaveFilePicker).
async function freeNameInDir(dirHandle, used, name) {
  const taken = async (n) => {
    if (used.has(n.toLowerCase())) return true;
    try { await dirHandle.getFileHandle(n); return true; }   // resolves => already exists
    catch (e) { return !(e && e.name === 'NotFoundError'); } // NotFound => free; else play safe
  };
  const base = sanitizeName(name);
  if (!(await taken(base))) { used.add(base.toLowerCase()); return base; }
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let i = 1, cand;
  do { cand = `${stem} (${i++})${ext}`; } while (await taken(cand));
  used.add(cand.toLowerCase());
  return cand;
}

export class Transfers extends EventTarget {
  /** @param {import('./webrtc.js').RTC} rtc */
  constructor(rtc) {
    super();
    this.rtc = rtc;
    this.rtc.on('channel', ({ peerId, channel }) => this._attachReceiver(peerId, channel));
  }

  on(type, handler) { this.addEventListener(type, (e) => handler(e.detail)); }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      promise.then(
        (v) => { clearTimeout(to); resolve(v); },
        (e) => { clearTimeout(to); reject(e); }
      );
    });
  }

  // =========================================================================
  // SEND
  // =========================================================================
  async send(peerId, peerName, selfName, files) {
    const meta = files.map((f) => ({
      uid: nextId(), file: f, name: f.name, size: f.size,
      mime: f.type || 'application/octet-stream'
    }));

    for (const m of meta) {
      this._emit('created', { id: m.uid, name: m.name, size: m.size, direction: 'out', peer: peerName });
      this._emit('status', { id: m.uid, status: 'pending', label: 'waiting for accept…' });
    }

    let channel;
    try {
      channel = await this.rtc.openChannel(peerId, `t-${meta[0].uid}`);
    } catch {
      for (const m of meta) this._emit('status', { id: m.uid, status: 'failed', label: 'connection failed' });
      this._emit('error', { message: `Could not connect to ${peerName}.` });
      return;
    }

    // Wait for accept/reject (also bail if the channel closes first).
    const decision = new Promise((resolve) => {
      channel.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'accept') resolve(msg);
        else if (msg.t === 'reject') resolve(false);
      };
      channel.addEventListener('close', () => resolve(false));
    });

    channel.send(JSON.stringify({
      t: 'offer', sender: selfName,
      files: meta.map((m) => ({ id: m.uid, name: m.name, size: m.size, mime: m.mime }))
    }));

    let accepted;
    try {
      accepted = await this._withTimeout(decision, ACCEPT_TIMEOUT, 'accept');
    } catch {
      for (const m of meta) this._emit('status', { id: m.uid, status: 'failed', label: 'no response' });
      this._emit('error', { message: `${peerName} didn't respond.` });
      try { channel.close(); } catch {}
      return;
    }
    if (!accepted) {
      for (const m of meta) this._emit('status', { id: m.uid, status: 'declined', label: 'declined' });
      try { channel.close(); } catch {}
      return;
    }

    // ---- Post-acceptance channel controller (acks, saved-confirmations, close) ----
    const ctl = {
      flowAck: accepted.flow === 'ack',
      sent: 0, acked: 0, closed: false,
      lastAckAt: performance.now(),
      creditWaiters: [],
      savedWaiters: new Map()
    };
    const wakeCredit = () => { const w = ctl.creditWaiters; ctl.creditWaiters = []; w.forEach((fn) => fn()); };

    channel.onmessage = (ev) => {
      // Receiver never sends anything until it has our 'file-start', which we send
      // only after this handler is installed — so no ack/saved can be missed above.
      if (typeof ev.data !== 'string') return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'ack') {
        if (msg.bytes > ctl.acked) { ctl.acked = msg.bytes; ctl.lastAckAt = performance.now(); }
        wakeCredit();
      } else if (msg.t === 'saved') {
        const w = ctl.savedWaiters.get(msg.id);
        if (w) { ctl.savedWaiters.delete(msg.id); w.resolve(); }
      } else if (msg.t === 'file-error') {
        const w = ctl.savedWaiters.get(msg.id);
        if (w) { ctl.savedWaiters.delete(msg.id); w.reject(new Error(msg.msg || 'receiver could not save the file')); }
      }
    };

    const onClose = () => {
      if (ctl.closed) return;
      ctl.closed = true;
      wakeCredit();                                   // release a parked credit-wait
      for (const [, w] of ctl.savedWaiters) w.reject(new Error('connection closed'));
      ctl.savedWaiters.clear();
    };
    channel.addEventListener('close', onClose);
    channel.addEventListener('error', onClose);

    const done = new Set();
    try {
      for (const m of meta) {
        // Register the saved-waiter BEFORE sending bytes so the 'saved' can't slip past.
        const savedPromise = new Promise((resolve, reject) => ctl.savedWaiters.set(m.uid, { resolve, reject }));

        this._emit('status', { id: m.uid, status: 'sending', label: 'sending' });
        channel.send(JSON.stringify({ t: 'file-start', id: m.uid }));
        await this._streamFile(channel, m, ctl);
        channel.send(JSON.stringify({ t: 'file-end', id: m.uid }));

        this._emit('status', { id: m.uid, status: 'sending', label: 'finishing…' });
        await this._withTimeout(savedPromise, SAVE_TIMEOUT, 'save'); // receiver committed it

        done.add(m.uid);
        this._emit('progress', { id: m.uid, transferred: m.size, total: m.size });
        this._emit('status', { id: m.uid, status: 'complete', label: 'sent' });
        this._emit('complete', { id: m.uid, direction: 'out' });
      }
      channel.send(JSON.stringify({ t: 'done' }));
    } catch {
      for (const m of meta) if (!done.has(m.uid)) this._emit('status', { id: m.uid, status: 'failed', label: 'failed' });
      this._emit('error', { message: 'Transfer interrupted.' });
    } finally {
      const closeWhenDrained = () => {
        if (ctl.closed || channel.bufferedAmount === 0) { try { channel.close(); } catch {} }
        else setTimeout(closeWhenDrained, 100);
      };
      closeWhenDrained();
    }
  }

  async _streamFile(channel, m, ctl) {
    const { file, uid, size } = m;
    let offset = 0;
    while (offset < size) {
      if (ctl.closed) throw new Error('connection closed');

      // Credit-based flow control (disk mode): don't outrun the receiver's disk.
      if (ctl.flowAck) {
        while (!ctl.closed && ctl.sent - ctl.acked > CREDIT_WINDOW) {
          if (performance.now() - ctl.lastAckAt > CREDIT_STALL_TIMEOUT) throw new Error('receiver stalled');
          // No await between the condition check and the push below => no lost wakeup.
          await new Promise((res) => {
            const to = setTimeout(res, 2000);                 // periodic re-check for stall
            ctl.creditWaiters.push(() => { clearTimeout(to); res(); });
          });
        }
        if (ctl.closed) throw new Error('connection closed');
      }

      // Sender-side send-buffer backpressure — but never park here on a dead channel.
      if (channel.bufferedAmount > HIGH_WATER_MARK) {
        let lastBuf = channel.bufferedAmount;
        let lastProgress = performance.now();
        while (channel.bufferedAmount > HIGH_WATER_MARK) {
          if (ctl.closed) throw new Error('connection closed');
          await this._drain(channel, ctl);
          if (ctl.closed) throw new Error('connection closed');
          const b = channel.bufferedAmount;
          if (b < lastBuf) { lastBuf = b; lastProgress = performance.now(); }
          else if (performance.now() - lastProgress > CREDIT_STALL_TIMEOUT) throw new Error('send stalled');
        }
      }

      const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      if (ctl.closed) throw new Error('connection closed');
      if (buf.byteLength === 0) throw new Error('file shorter than its declared size');
      channel.send(buf);
      offset += buf.byteLength;
      ctl.sent += buf.byteLength;
      this._emit('progress', { id: uid, transferred: offset, total: size });
    }
  }

  // Resolve when the send buffer drains — OR the channel closes/errors, OR after a
  // short interval so the caller can re-check. Never an unbreakable wait.
  _drain(channel, ctl) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        channel.removeEventListener('bufferedamountlow', finish);
        channel.removeEventListener('close', finish);
        channel.removeEventListener('error', finish);
        resolve();
      };
      channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
      const to = setTimeout(finish, 1000);
      channel.addEventListener('bufferedamountlow', finish);
      channel.addEventListener('close', finish);
      channel.addEventListener('error', finish);
      if (ctl && ctl.closed) finish();
    });
  }

  // =========================================================================
  // RECEIVE
  // =========================================================================
  _attachReceiver(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    const emit = (t, d) => this._emit(t, d);

    const state = {
      files: new Map(),
      activeId: null,
      sender: 'A device',
      mode: 'memory',       // 'disk' once a destination is picked
      fileHandle: null,     // single-file save handle
      dirHandle: null,      // batch directory handle
      usedNames: new Set(),
      committed: 0,         // cumulative bytes flushed to disk (basis for acks)
      lastAckSent: 0,
      pickerCancelled: false
    };

    const maybeAck = (force) => {
      if (state.mode !== 'disk') return;
      if (force || state.committed - state.lastAckSent >= ACK_INTERVAL) {
        state.lastAckSent = state.committed;
        try { channel.send(JSON.stringify({ t: 'ack', bytes: state.committed })); } catch {}
      }
    };

    const failFile = (rec, err) => {
      if (rec.failed || rec.done) return;
      rec.failed = true;
      if (rec.writable) { try { rec.writable.abort(); } catch {} }
      emit('status', { id: rec.id, status: 'failed', label: 'save failed' });
      try { channel.send(JSON.stringify({ t: 'file-error', id: rec.id, msg: String((err && err.message) || err) })); } catch {}
    };

    const finalize = async (rec) => {
      if (rec.done || rec.failed) return;
      try {
        await rec.writable.close();          // the ONLY FSA commit point
        rec.done = true;
        maybeAck(true);
        emit('progress', { id: rec.id, transferred: rec.size, total: rec.size });
        emit('status', { id: rec.id, status: 'complete', label: 'saved' });
        emit('complete', { id: rec.id, direction: 'in', savedToDisk: true, name: rec.name, savedName: rec.savedName || rec.name });
        try { channel.send(JSON.stringify({ t: 'saved', id: rec.id })); } catch {}
      } catch (err) {
        failFile(rec, err);
      }
    };

    // Single serialized consumer per file: drains the queue in arrival order,
    // applying real backpressure (we only ack bytes actually written).
    const pump = (rec) => {
      if (rec.pumping || rec.failed) return;
      rec.pumping = (async () => {
        const w = await rec.ready;
        while (rec.queue.length) {
          const chunk = rec.queue.shift();
          await w.write(chunk);
          rec.written += chunk.byteLength;
          state.committed += chunk.byteLength;
          emit('progress', { id: rec.id, transferred: rec.written, total: rec.size });
          maybeAck(false);
        }
      })().then(() => {
        rec.pumping = null;
        if (rec.queue.length) pump(rec);       // chunks that arrived at the tail
        else if (rec.ended) finalize(rec);
      }).catch((err) => {
        rec.pumping = null;
        failFile(rec, err);
      });
    };

    const acquireSink = async (files) => {
      const FSA = self.isSecureContext
        && typeof window.showSaveFilePicker === 'function'
        && typeof window.showDirectoryPicker === 'function';
      if (!FSA) { state.mode = 'memory'; return; }
      try {
        if (files.length === 1) {
          state.fileHandle = await window.showSaveFilePicker({ suggestedName: sanitizeName(files[0].name) });
        } else {
          state.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        }
        state.mode = 'disk';
      } catch (err) {
        state.mode = 'memory';
        if (err && err.name === 'AbortError') state.pickerCancelled = true; // user backed out
      }
    };

    const onControl = (msg) => {
      switch (msg.t) {
        case 'offer': {
          state.sender = msg.sender || 'A device';
          emit('incoming', {
            sender: state.sender,
            files: msg.files,
            // Runs inside the accept-button click; acquireSink's picker MUST be the
            // first await so it keeps the user gesture (see app.js showIncoming).
            accept: async () => {
              await acquireSink(msg.files);
              if (state.pickerCancelled) {
                // Don't silently buffer GBs in RAM after the user cancelled — decline.
                try { channel.send(JSON.stringify({ t: 'reject' })); } catch {}
                try { channel.close(); } catch {}
                return;
              }
              if (channel.readyState !== 'open') {
                // Sender gave up (ACCEPT_TIMEOUT) or disconnected while we were
                // choosing a location — abandon quietly rather than orphaning rows.
                return;
              }
              for (const f of msg.files) {
                state.files.set(f.id, {
                  id: f.id, name: f.name, size: f.size, mime: f.mime,
                  received: 0, written: 0,
                  chunks: state.mode === 'memory' ? [] : null,
                  queue: [], pumping: null, ended: false,
                  ready: null, writable: null, savedName: null,
                  done: false, failed: false
                });
                emit('created', { id: f.id, name: f.name, size: f.size, direction: 'in', peer: state.sender });
                emit('status', { id: f.id, status: 'pending', label: 'waiting…' });
              }
              try { channel.send(JSON.stringify({ t: 'accept', flow: state.mode === 'disk' ? 'ack' : 'none' })); } catch {}
            },
            reject: () => {
              try { channel.send(JSON.stringify({ t: 'reject' })); } catch {}
              try { channel.close(); } catch {}
            }
          });
          break;
        }

        case 'file-start': {
          state.activeId = msg.id;
          const rec = state.files.get(msg.id);
          if (!rec) break;
          emit('status', { id: msg.id, status: 'receiving', label: 'receiving' });
          if (state.mode === 'disk') {
            // Assigned synchronously so every subsequent chunk chains off it.
            rec.ready = (async () => {
              let handle;
              if (state.fileHandle) {
                handle = state.fileHandle;
              } else {
                const name = await freeNameInDir(state.dirHandle, state.usedNames, rec.name);
                rec.savedName = name;
                handle = await state.dirHandle.getFileHandle(name, { create: true });
              }
              const w = await handle.createWritable();
              rec.writable = w;
              return w;
            })();
          }
          break;
        }

        case 'file-end': {
          const rec = state.files.get(msg.id);
          if (rec) {
            if (state.mode === 'disk') {
              rec.ended = true;
              pump(rec);                          // finalizes once the queue drains
            } else {
              const blob = new Blob(rec.chunks, { type: rec.mime });
              rec.chunks = null;
              rec.done = true;
              const url = URL.createObjectURL(blob);
              emit('progress', { id: msg.id, transferred: rec.size, total: rec.size });
              emit('status', { id: msg.id, status: 'complete', label: 'received' });
              emit('complete', { id: msg.id, direction: 'in', url, name: rec.name });
              try { channel.send(JSON.stringify({ t: 'saved', id: msg.id })); } catch {}
            }
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
    };

    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        onControl(msg);
      } else {
        const rec = state.files.get(state.activeId);
        if (!rec || rec.failed) return;
        rec.received += ev.data.byteLength;
        if (state.mode === 'disk') {
          rec.queue.push(ev.data);
          pump(rec);
        } else {
          rec.chunks.push(ev.data);
          emit('progress', { id: rec.id, transferred: rec.received, total: rec.size });
        }
      }
    };

    channel.onclose = () => {
      // Only files that haven't cleanly finished are casualties of a lost connection.
      // On a graceful transfer every file is already 'done' (sender waits for 'saved'
      // before 'done'/close), so nothing here fires.
      for (const [, rec] of state.files) {
        if (!rec.done && !rec.failed) {
          if (rec.writable) { try { rec.writable.abort(); } catch {} }
          emit('status', { id: rec.id, status: 'failed', label: 'connection lost' });
        }
      }
    };
  }
}
