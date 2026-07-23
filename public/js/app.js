// App entry point — wires signaling + WebRTC + transfers to the UI.

import { Signaling } from './signaling.js';
import { RTC } from './webrtc.js';
import { Transfers } from './transfer.js';
import { loadIceServers } from './config.js';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
function fmtSpeed(bps) {
  if (!bps || !isFinite(bps)) return '';
  return `${fmtBytes(bps)}/s`;
}
function fmtEta(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 1) return 'almost done';
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  const m = Math.floor(sec / 60), s = Math.ceil(sec % 60);
  return `${m}m ${s}s left`;
}
function iconFor(mime, name) {
  const m = (mime || '').toLowerCase();
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (m.startsWith('image/')) return '🖼️';
  if (m.startsWith('video/')) return '🎬';
  if (m.startsWith('audio/')) return '🎵';
  if (m.includes('pdf') || ext === 'pdf') return '📕';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  return '📄';
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3000);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  peers: [],          // [{id, name}]
  staged: [],         // File[]
  pendingTarget: null,// peerId waiting for a file pick
  rows: new Map()     // transferId -> { li, bar, statusEl, metaEl, start, lastTime, lastBytes, size }
};

let signaling, rtc, transfers;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  const iceServers = await loadIceServers();

  signaling = new Signaling();
  rtc = new RTC(signaling, iceServers);
  transfers = new Transfers(rtc);

  wireSignaling();
  wireTransfers();
  wireUI();

  signaling.connect();
})();

// ---------------------------------------------------------------------------
// Signaling → UI
// ---------------------------------------------------------------------------
function wireSignaling() {
  signaling.on('open', () => setConn(true));
  signaling.on('close', () => setConn(false));

  signaling.on('welcome', (msg) => {
    state.peers = msg.peers;
    renderPeers();
    // Apply saved custom name, if any.
    const saved = localStorage.getItem('nfs-name');
    const input = $('#selfName');
    if (saved) { input.value = saved; signaling.rename(saved); }
    else { input.value = msg.self.name; }
    updateRoomHint(msg.room);
  });

  signaling.on('peers', (msg) => {
    state.peers = msg.peers;
    renderPeers();
  });
}

function setConn(online) {
  const box = $('#conn');
  box.classList.toggle('online', online);
  box.classList.toggle('offline', !online);
  $('#connText').textContent = online ? 'connected' : 'reconnecting…';
}

function updateRoomHint(room) {
  const hint = $('#roomHint');
  if (room && room.startsWith('code:')) {
    hint.textContent = `In room "${room.slice(5)}". Others who join this code can see you.`;
    $('#roomCode').value = room.slice(5);
  } else {
    hint.textContent = "You're on your local network. Anyone here sees you automatically.";
    $('#roomCode').value = '';
  }
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
function renderPeers() {
  const list = $('#deviceList');
  const empty = $('#devicesEmpty');
  list.innerHTML = '';
  $('#deviceCount').textContent = String(state.peers.length);

  if (state.peers.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const p of state.peers) {
    const li = el('li', 'device');
    li.dataset.peerId = p.id;
    li.innerHTML = `
      <span class="d-avatar" aria-hidden="true">💻</span>
      <div>
        <div class="d-name"></div>
        <div class="d-sub">tap to send · or drop files here</div>
      </div>
      <span class="d-send">Send ▸</span>`;
    li.querySelector('.d-name').textContent = p.name;

    li.addEventListener('click', () => onDeviceClick(p));

    // Drag files directly onto a device → send immediately.
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('dragover'); });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('dragover');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) sendTo(p, files);
    });

    list.appendChild(li);
  }
}

function onDeviceClick(peer) {
  if (state.staged.length) {
    const files = state.staged.slice();
    clearStaged();
    sendTo(peer, files);
  } else {
    // No files staged yet — remember the target and open the picker.
    state.pendingTarget = peer.id;
    $('#fileInput').click();
  }
}

// ---------------------------------------------------------------------------
// Staging + sending
// ---------------------------------------------------------------------------
function stageFiles(files) {
  state.staged.push(...files);
  renderStaged();
}
function clearStaged() {
  state.staged = [];
  renderStaged();
}
function renderStaged() {
  const ul = $('#staged');
  ul.innerHTML = '';
  state.staged.forEach((f, idx) => {
    const li = el('li');
    li.innerHTML = `
      <span aria-hidden="true">${iconFor(f.type, f.name)}</span>
      <span class="s-name"></span>
      <span class="s-size">${fmtBytes(f.size)}</span>
      <button class="s-remove" title="Remove" aria-label="Remove">×</button>`;
    li.querySelector('.s-name').textContent = f.name;
    li.querySelector('.s-remove').addEventListener('click', () => {
      state.staged.splice(idx, 1);
      renderStaged();
    });
    ul.appendChild(li);
  });

  if (state.staged.length) {
    const actions = el('div', 'staged-actions');
    const send = el('button', 'btn primary', `Send ${state.staged.length} file${state.staged.length > 1 ? 's' : ''}…`);
    send.addEventListener('click', openPicker);
    const clear = el('button', 'ghost-btn', 'Clear');
    clear.addEventListener('click', clearStaged);
    actions.append(send, clear);
    ul.appendChild(actions);
  }
}

async function sendTo(peer, files) {
  if (!signaling.self) { toast('Not connected yet.'); return; }
  await transfers.send(peer.id, peer.name, currentName(), files);
}

function currentName() {
  return $('#selfName').value.trim() || (signaling.self ? signaling.self.name : 'This device');
}

// ---------------------------------------------------------------------------
// Device picker modal
// ---------------------------------------------------------------------------
function openPicker() {
  if (!state.staged.length) return;
  if (state.peers.length === 0) { toast('No devices nearby to send to.'); return; }
  if (state.peers.length === 1) {
    const files = state.staged.slice(); clearStaged();
    sendTo(state.peers[0], files);
    return;
  }
  const list = $('#pickList');
  list.innerHTML = '';
  for (const p of state.peers) {
    const li = el('li', 'device');
    li.innerHTML = `
      <span class="d-avatar" aria-hidden="true">💻</span>
      <div><div class="d-name"></div><div class="d-sub">send here</div></div>
      <span class="d-send">Send ▸</span>`;
    li.querySelector('.d-name').textContent = p.name;
    li.addEventListener('click', () => {
      closePicker();
      const files = state.staged.slice(); clearStaged();
      sendTo(p, files);
    });
    list.appendChild(li);
  }
  $('#pickModal').hidden = false;
}
function closePicker() { $('#pickModal').hidden = true; }

// ---------------------------------------------------------------------------
// Transfers → UI
// ---------------------------------------------------------------------------
function wireTransfers() {
  transfers.on('created', (d) => addRow(d));
  transfers.on('status', (d) => setRowStatus(d));
  transfers.on('progress', (d) => setRowProgress(d));
  transfers.on('complete', (d) => completeRow(d));
  transfers.on('error', (d) => toast(d.message || 'Transfer error.'));
  transfers.on('incoming', (d) => showIncoming(d));
}

function ensureTransfersVisible() { $('#transfersCard').hidden = false; }

function addRow(d) {
  ensureTransfersVisible();
  const li = el('li', 'tr');
  li.innerHTML = `
    <div class="tr-top">
      <span class="tr-icon" aria-hidden="true">${d.direction === 'in' ? '⬇️' : '⬆️'}</span>
      <span class="tr-name"></span>
      <span class="tr-dir">${d.direction === 'in' ? 'from ' : 'to '}${escapeHtml(d.peer || '')}</span>
      <span class="tr-status">queued</span>
    </div>
    <div class="bar"><span></span></div>
    <div class="tr-meta"><span class="tr-left">${fmtBytes(d.size)}</span><span class="tr-right"></span></div>
    <div class="tr-download"></div>`;
  li.querySelector('.tr-name').textContent = d.name;
  $('#transferList').prepend(li);

  state.rows.set(d.id, {
    li,
    bar: li.querySelector('.bar > span'),
    statusEl: li.querySelector('.tr-status'),
    rightEl: li.querySelector('.tr-right'),
    dlEl: li.querySelector('.tr-download'),
    size: d.size,
    start: performance.now(),
    lastTime: 0,
    lastBytes: 0,
    lastPaint: 0
  });
}

function setRowStatus(d) {
  const r = state.rows.get(d.id);
  if (!r) return;
  r.statusEl.textContent = d.label || d.status;
  r.statusEl.classList.toggle('done', d.status === 'complete');
  r.statusEl.classList.toggle('failed', d.status === 'failed' || d.status === 'declined');
  r.li.classList.toggle('done', d.status === 'complete');
  r.li.classList.toggle('failed', d.status === 'failed' || d.status === 'declined');
}

function setRowProgress(d) {
  const r = state.rows.get(d.id);
  if (!r) return;
  const pct = d.total ? (d.transferred / d.total) * 100 : 0;

  const now = performance.now();
  // Throttle DOM paints to ~12/s to avoid layout thrash on fast transfers.
  if (now - r.lastPaint < 80 && d.transferred < d.total) return;
  r.lastPaint = now;

  r.bar.style.width = `${pct.toFixed(1)}%`;

  if (r.lastTime) {
    const dt = (now - r.lastTime) / 1000;
    const db = d.transferred - r.lastBytes;
    if (dt > 0) {
      const speed = db / dt;
      const remaining = (d.total - d.transferred) / speed;
      r.rightEl.textContent = d.transferred < d.total
        ? `${fmtSpeed(speed)} · ${fmtEta(remaining)}`
        : '';
    }
  }
  r.lastTime = now;
  r.lastBytes = d.transferred;
  r.li.querySelector('.tr-left').textContent =
    `${fmtBytes(d.transferred)} / ${fmtBytes(d.total)}`;
}

function completeRow(d) {
  const r = state.rows.get(d.id);
  if (!r) return;
  r.bar.style.width = '100%';
  r.rightEl.textContent = '';
  if (d.direction === 'in' && d.url) {
    const a = el('a');
    a.href = d.url;
    a.download = d.name;
    a.textContent = `⬇ Save “${d.name}”`;
    r.dlEl.appendChild(a);
    // Auto-trigger the download; browsers may still prompt/save silently.
    a.click();
    toast(`Received “${d.name}”.`);
  } else if (d.direction === 'out') {
    toast('Sent.');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Incoming transfer prompt
// ---------------------------------------------------------------------------
function showIncoming(d) {
  const total = d.files.reduce((s, f) => s + f.size, 0);
  const names = d.files.map((f) => f.name).join(', ');
  $('#incomingBody').innerHTML =
    `<strong>${escapeHtml(d.sender)}</strong> wants to send you ` +
    `<strong>${d.files.length}</strong> file${d.files.length > 1 ? 's' : ''} ` +
    `(${fmtBytes(total)}):<br><span class="muted">${escapeHtml(names)}</span>`;

  const modal = $('#incomingModal');
  modal.hidden = false;

  const accept = $('#acceptBtn');
  const reject = $('#rejectBtn');
  const cleanup = () => {
    modal.hidden = true;
    accept.onclick = null;
    reject.onclick = null;
  };
  accept.onclick = () => { cleanup(); d.accept(); };
  reject.onclick = () => { cleanup(); d.reject(); toast('Declined.'); };
}

// ---------------------------------------------------------------------------
// UI wiring (dropzone, name, room, modals)
// ---------------------------------------------------------------------------
function wireUI() {
  const dz = $('#dropzone');
  const fileInput = $('#fileInput');

  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { stageFiles(files); openPicker(); }
  });

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length) return;

    if (state.pendingTarget) {
      const peer = state.peers.find((p) => p.id === state.pendingTarget);
      state.pendingTarget = null;
      if (peer) { sendTo(peer, files); return; }
    }
    stageFiles(files);
    openPicker();
  });

  // Prevent the browser from opening files dropped outside the zones.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // Rename
  $('#saveName').addEventListener('click', saveName);
  $('#selfName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });

  // Room join
  $('#joinRoom').addEventListener('click', () => {
    signaling.join($('#roomCode').value.trim());
  });
  $('#roomCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') signaling.join($('#roomCode').value.trim());
  });

  // Modals
  $('#pickCancel').addEventListener('click', closePicker);
  $('#pickModal').addEventListener('click', (e) => { if (e.target.id === 'pickModal') closePicker(); });

  $('#clearDone').addEventListener('click', () => {
    for (const [id, r] of state.rows) {
      if (r.li.classList.contains('done') || r.li.classList.contains('failed')) {
        r.li.remove();
        state.rows.delete(id);
      }
    }
    if (state.rows.size === 0) $('#transfersCard').hidden = true;
  });
}

function saveName() {
  const name = $('#selfName').value.trim();
  if (!name) return;
  localStorage.setItem('nfs-name', name);
  signaling.rename(name);
  toast('Name saved.');
}
