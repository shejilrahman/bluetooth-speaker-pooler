'use strict';
/*
 * Speaker Queue HUB - the hosted part.
 *
 * Speaker PCs run SpeakerQueue.exe with a hub URL + room name; the exe opens an
 * outbound WebSocket to /agent and registers its room. People open this site,
 * pick a room and get the normal queue page. Every API call from the page is
 * relayed to that room's agent (the speaker PC), and the agent's live events
 * are fanned out to the page as Server-Sent Events. Nothing plays here; the
 * hub is only a meeting point, so it runs fine on the smallest free instance.
 *
 *   npm install && node server.js        (PORT, PUBLIC_URL, DATA_DIR env vars)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3020;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''); // e.g. https://queue.example.com (optional; Render sets RENDER_EXTERNAL_URL)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, '..', 'public');
const RELAY_TIMEOUT = 45000;
const ROOM_RE = /^[\w][\w \-]{0,39}$/;

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map(); // key: lower-case name

function loadRooms() {
  try {
    const saved = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    for (const r of saved) rooms.set(r.name.toLowerCase(), { ...r, agent: null, lastState: null, sse: new Set(), pending: new Map(), onlineSince: 0 });
  } catch (_) { /* first run */ }
}

function saveRooms() {
  const data = [...rooms.values()].map((r) => ({ name: r.name, keyHash: r.keyHash, hostName: r.hostName || '', speaker: r.speaker || '', createdAt: r.createdAt, lastSeen: r.lastSeen || 0 }));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFile(ROOMS_FILE, JSON.stringify(data, null, 2), () => {});
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const HIDE_AFTER = 60 * 60 * 1000;          // offline rooms disappear from the list after 1 hour
const FORGET_AFTER = 7 * 24 * 60 * 60 * 1000; // and are deleted (name becomes free) after 7 days

function pruneRooms() {
  let changed = false;
  for (const [k, r] of rooms) {
    if (!r.agent && Date.now() - (r.lastSeen || r.createdAt || 0) > FORGET_AFTER) { rooms.delete(k); changed = true; console.log(`[room] forgot "${r.name}" (offline for a week)`); }
  }
  if (changed) saveRooms();
}

function roomList() {
  return [...rooms.values()]
    .filter((r) => r.agent || Date.now() - (r.lastSeen || r.createdAt || 0) < HIDE_AFTER)
    .map((r) => ({
      name: r.name,
      online: Boolean(r.agent),
      hostName: r.hostName || '',
      speaker: r.speaker || '',
      nowPlaying: r.lastState && r.lastState.nowPlaying ? r.lastState.nowPlaying.title : '',
      queue: r.lastState ? r.lastState.queue.length : 0,
      viewers: r.sse.size,
    }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  return `${proto}://${req.headers.host}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function relay(room, method, apiPath, body) {
  return new Promise((resolve) => {
    if (!room.agent || room.agent.readyState !== 1) return resolve({ status: 503, body: { error: 'The speaker PC for this room is offline right now.' } });
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { room.pending.delete(id); resolve({ status: 504, body: { error: 'The speaker PC did not answer in time.' } }); }, RELAY_TIMEOUT);
    room.pending.set(id, { resolve, timer });
    room.agent.send(JSON.stringify({ type: 'http', id, method, path: apiPath, body }));
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function roomsPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Speaker Queue</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#101218;color:#f1f3f8;font-size:17px;line-height:1.45}
  .wrap{max-width:600px;margin:0 auto;padding:20px 14px 60px}
  h1{font-size:1.5rem;margin:10px 0 4px}
  .sub{color:#97a0b5;margin:0 0 20px}
  h2{font-size:1.05rem;margin:28px 0 10px;color:#f1f3f8}
  a.room{display:flex;align-items:center;gap:14px;background:#1a1d26;border-radius:16px;padding:16px;margin-bottom:12px;color:inherit;text-decoration:none;border:1px solid transparent}
  a.room:hover{border-color:#4f8cff}
  a.room.off{opacity:.5}
  .dot{width:12px;height:12px;border-radius:50%;background:#2fd27d;flex-shrink:0}
  .off .dot{background:#ff5f6d}
  .t{font-weight:700;font-size:1.1rem}
  .s{color:#97a0b5;font-size:.85rem;margin-top:2px}
  .card{background:#1a1d26;border-radius:16px;padding:16px 18px;margin-bottom:12px}
  .empty{border:1px dashed #3a3f52;color:#97a0b5;text-align:center;padding:22px}
  .flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:8px;align-items:center;text-align:center;font-size:.9rem}
  .flow .box{background:#242837;border-radius:12px;padding:10px 6px}
  .flow .box b{display:block;font-size:1.4rem;margin-bottom:2px}
  .flow .arr{color:#4f8cff;font-size:1.2rem}
  .flow .cap{color:#97a0b5;font-size:.78rem;margin-top:2px}
  ol{padding-left:22px;margin:8px 0}
  li{margin:8px 0}
  .muted{color:#97a0b5;font-size:.9rem}
  code{background:#242837;padding:2px 6px;border-radius:6px;word-break:break-all}
  .copy{display:inline-flex;align-items:center;gap:10px;background:#242837;border-radius:10px;padding:8px 10px;margin:6px 0;max-width:100%}
  .copy code{background:none;padding:0}
  button{background:#4f8cff;color:#fff;border:0;border-radius:8px;padding:6px 10px;font:inherit;font-size:.85rem;cursor:pointer;flex-shrink:0}
  details{margin-top:8px}
  summary{cursor:pointer;color:#4f8cff}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  td{padding:6px 8px;border-top:1px solid #2a2f3f;vertical-align:top}
  td:first-child{color:#97a0b5;white-space:nowrap}
  @media (max-width:420px){.flow{grid-template-columns:1fr;}.flow .arr{transform:rotate(90deg)}}
</style></head><body><div class="wrap">
<h1>🔊 Speaker Queue</h1>
<p class="sub">A shared music queue for a Bluetooth speaker. Anyone with the link can add songs from anywhere.</p>

<h2>Rooms</h2>
<div id="list"><div class="card empty">Loading…</div></div>
<p class="muted">Tap a room to see its queue, search YouTube and add songs. A room is one speaker. Green means it is online now.</p>

<h2>How it works</h2>
<div class="card">
  <div class="flow">
    <div class="box"><b>📱</b>You, anywhere<div class="cap">phone or laptop, any network</div></div>
    <div class="arr">→</div>
    <div class="box"><b>☁️</b>This site<div class="cap">only passes messages</div></div>
    <div class="arr">→</div>
    <div class="box"><b>💻</b>PC by the speaker<div class="cap">plays the music over Bluetooth</div></div>
  </div>
  <p class="muted" style="margin:14px 0 0">This website never plays anything. Each room is a Windows PC sitting next to a Bluetooth speaker. That PC runs <b>SpeakerQueue.exe</b>, connects out to this site, and does the searching and playing. So listeners do not need to be on the same Wi-Fi as the speaker, but one PC must be within Bluetooth range of it.</p>
</div>

<h2>Set up a speaker (adds a room here)</h2>
<div class="card">
  <ol>
    <li><b>Pick the PC</b> that will stay next to the speaker. Pair the Bluetooth speaker with it in Windows settings, as you would for any laptop.</li>
    <li><b>Run SpeakerQueue.exe</b> on that PC (the <code>dist</code> folder from the project). On first start it installs VLC, adds itself to Startup, keeps the PC awake, and <b>joins this site by itself</b>. Allow the one admin prompt. Nothing to type on that PC.</li>
    <li><b>Within a few seconds a room appears in the list above</b>, named after that PC (its Windows computer name, for example <code>LAPTOP-816SSCF4</code>). Open it from any phone or laptop.</li>
    <li>Open <b>Host controls</b> on the room page and enter the PIN (default <code>1234</code>). <b>Change the PIN straight away</b> in the Host PIN box: this room is reachable by anyone on the internet who knows the link.</li>
    <li>Optional: in <b>Online hub</b> give the room a friendlier name such as <code>Office</code> and your own key, then Save. The page moves to the new room link.</li>
    <li><b>Share</b> the room link, or the QR code from the Share section on the room page.</li>
  </ol>
  <details>
    <summary>Using your own hub, or prefer a file?</summary>
    <p class="muted">Speaker PCs connect to this site at <span class="copy"><code id="agentUrl"></code><button onclick="copyText('agentUrl',this)">Copy</button></span></p>
    <p class="muted">To set everything from a file, create <code>config.json</code> next to <code>SpeakerQueue.exe</code> before starting it:</p>
    <div class="copy"><code id="cfgJson"></code><button onclick="copyText('cfgJson',this)">Copy</button></div>
    <p class="muted"><code>"hubUrl": ""</code> switches the hub off for that PC. <code>"adminPin": "2468"</code> sets the host PIN. Keep <code>roomKey</code> secret: it is what stops another PC from taking over the room name, and copying the file to a new PC moves the room there.</p>
  </details>
</div>

<h2>Good to know</h2>
<div class="card muted">
  <ul style="margin:0;padding-left:20px">
    <li>Anyone with a room link can search and add songs. Skipping, removing and settings need the host PIN of that PC.</li>
    <li>The speaker PC reconnects on its own after restarts or internet drops. If this site restarts, the PC rejoins by itself, usually within a minute.</li>
    <li>One PC equals one room. For another speaker in another place, run the exe on another PC; it gets its own room.</li>
    <li>Renaming a room moves it. The old name drops off this list after an hour and is freed after a week.</li>
    <li>Room address: <code id="roomExample"></code></li>
  </ul>
</div>
</div>
<script>
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const agentUrl=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/agent';
document.getElementById('agentUrl').textContent=agentUrl;
document.getElementById('cfgJson').textContent='{ "hubUrl": "'+agentUrl+'", "room": "Office", "roomKey": "your-secret", "adminPin": "2468" }';
document.getElementById('roomExample').textContent=location.origin+'/r/Office/';
function copyText(id,btn){navigator.clipboard.writeText(document.getElementById(id).textContent).then(()=>{btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy',1500);});}
async function load(){
  try{
    const rooms=await (await fetch('rooms')).json();
    const el=document.getElementById('list');
    if(!rooms.length){el.innerHTML='<div class="card empty">No speaker is connected yet.<br>Run SpeakerQueue.exe on the PC by the speaker; its room appears here within seconds.</div>';return;}
    el.innerHTML=rooms.map(r=>'<a class="room '+(r.online?'':'off')+'" href="r/'+encodeURIComponent(r.name)+'/"><div class="dot"></div><div><div class="t">'+esc(r.name)+'</div><div class="s">'+(r.online?(r.nowPlaying?'▶ '+esc(r.nowPlaying):'online, nothing playing')+' · '+r.queue+' queued':'offline, the speaker PC is not connected')+(r.speaker?' · '+esc(r.speaker):'')+'</div></div></a>').join('');
  }catch(e){}
}
load();setInterval(load,10000);
</script></body></html>`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') return html(res, 200, roomsPage());
  if (p === '/rooms') return json(res, 200, roomList());
  if (p === '/health') return json(res, 200, { ok: true, rooms: rooms.size, online: [...rooms.values()].filter((r) => r.agent).length });

  const m = p.match(/^\/r\/([^/]+)(\/.*)?$/);
  if (!m) return json(res, 404, { error: 'not found' });
  const roomName = decodeURIComponent(m[1]);
  const room = rooms.get(roomName.toLowerCase());
  if (!room) return html(res, 404, `<!DOCTYPE html><meta charset="utf-8"><body style="font-family:system-ui;background:#101218;color:#eee;padding:30px"><h2>Room "${esc(roomName)}" does not exist.</h2><a style="color:#4f8cff" href="/">Back to room list</a></body>`);
  const rest = m[2] || '';
  if (rest === '') { res.writeHead(302, { Location: `/r/${encodeURIComponent(room.name)}/` }); return res.end(); }

  // --- API relayed to the agent -------------------------------------------
  if (rest.startsWith('/api/')) {
    const apiPath = rest;
    if (req.method === 'GET' && apiPath === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      room.sse.add(res);
      if (room.lastState) res.write(`event: state\ndata: ${JSON.stringify(room.lastState)}\n\n`);
      req.on('close', () => room.sse.delete(res));
      return;
    }
    if (req.method === 'GET' && apiPath === '/api/share') {
      const u = `${baseUrl(req)}/r/${encodeURIComponent(room.name)}/`;
      return json(res, 200, { hub: true, url: u, room: room.name, port: 0, hostname: room.hostName || '', hostnameUrl: u, localUrl: u, ipUrls: [{ url: u, adapter: 'online hub', virtual: false }] });
    }
    if (req.method === 'GET' && apiPath === '/api/state') {
      if (room.lastState) return json(res, 200, room.lastState);
      const r = await relay(room, 'GET', apiPath, undefined);
      return json(res, r.status, r.body);
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    let body;
    try { body = await readBody(req); } catch (_) { return json(res, 400, { error: 'bad JSON body' }); }
    const r = await relay(room, 'POST', apiPath, body);
    return json(res, r.status, r.body);
  }

  // --- static page files ------------------------------------------------------
  let file = rest === '/' ? 'index.html' : path.posix.basename(rest);
  if (rest === '/player') file = 'player.html';
  if (!/^[\w.-]+$/.test(file)) return json(res, 404, { error: 'not found' });
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket: agents (speaker PCs)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/agent', maxPayload: 1024 * 1024 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.room = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (_) { return; }

    if (m.type === 'register') {
      const name = String(m.room || '').trim();
      if (!ROOM_RE.test(name)) { ws.send(JSON.stringify({ type: 'error', error: 'Room name: letters, numbers, spaces, - or _ (max 40).' })); return ws.close(4000, 'bad room name'); }
      const keyHash = hash(m.key || '');
      let room = rooms.get(name.toLowerCase());
      if (!room) {
        room = { name, keyHash, agent: null, lastState: null, sse: new Set(), pending: new Map(), onlineSince: 0, createdAt: Date.now() };
        rooms.set(name.toLowerCase(), room);
        console.log(`[room] created "${name}"`);
      } else if (room.keyHash !== keyHash) {
        ws.send(JSON.stringify({ type: 'error', error: `Room "${room.name}" exists and the key is wrong. Pick another room name or use the right key.` }));
        return ws.close(4001, 'wrong key');
      }
      if (room.agent && room.agent !== ws) { try { room.agent.close(4002, 'replaced by a new connection'); } catch (_) { /* ignore */ } }
      room.agent = ws;
      room.hostName = String(m.name || '').slice(0, 60);
      room.speaker = String(m.speaker || '').slice(0, 60);
      room.onlineSince = Date.now();
      room.lastSeen = Date.now();
      ws.room = room;
      ws.isAlive = true;
      saveRooms();
      const publicUrl = `${baseUrl(req)}/r/${encodeURIComponent(room.name)}/`;
      ws.send(JSON.stringify({ type: 'registered', room: room.name, publicUrl }));
      console.log(`[room] "${room.name}" online from ${room.hostName} (${req.socket.remoteAddress})`);
      return;
    }

    const room = ws.room;
    if (!room) return;
    if (m.type === 'event') {
      if (m.event === 'state') {
        room.lastState = m.data;
        if (m.data && m.data.bluetooth && m.data.bluetooth.speaker && m.data.bluetooth.speaker !== room.speaker) { room.speaker = m.data.bluetooth.speaker; saveRooms(); }
      }
      const frame = `event: ${m.event}\ndata: ${JSON.stringify(m.data)}\n\n`;
      for (const res of room.sse) res.write(frame);
    } else if (m.type === 'http-res') {
      const pending = room.pending.get(m.id);
      if (pending) { clearTimeout(pending.timer); room.pending.delete(m.id); pending.resolve({ status: m.status || 200, body: m.body }); }
    } else if (m.type === 'pong') {
      ws.isAlive = true;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (room && room.agent === ws) {
      room.agent = null;
      room.lastSeen = Date.now();
      saveRooms();
      console.log(`[room] "${room.name}" offline`);
      if (room.lastState) {
        room.lastState = { ...room.lastState, playback: { ...room.lastState.playback, playerOnline: false, setup: 'speaker PC offline' } };
        const frame = `event: state\ndata: ${JSON.stringify(room.lastState)}\n\n`;
        for (const res of room.sse) res.write(frame);
      }
      for (const [id, pnd] of room.pending) { clearTimeout(pnd.timer); pnd.resolve({ status: 503, body: { error: 'The speaker PC went offline.' } }); room.pending.delete(id); }
    }
  });
});

setInterval(pruneRooms, 60 * 60 * 1000);

// keep-alive: drop dead agents, keep SSE viewers alive
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); ws.send(JSON.stringify({ type: 'ping' })); } catch (_) { /* ignore */ }
  }
  for (const room of rooms.values()) for (const res of room.sse) res.write(': ping\n\n');
}, 25000);

loadRooms();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Speaker Queue hub listening on port ${PORT}`);
  console.log(`  rooms page : http://localhost:${PORT}/`);
  console.log(`  agents use : ws://<this-host>:${PORT}/agent  (wss:// when behind https)`);
  if (PUBLIC_URL) console.log(`  public URL : ${PUBLIC_URL}`);
});
