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
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); // e.g. https://queue.example.com (optional)
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
  const data = [...rooms.values()].map((r) => ({ name: r.name, keyHash: r.keyHash, hostName: r.hostName || '', speaker: r.speaker || '', createdAt: r.createdAt }));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFile(ROOMS_FILE, JSON.stringify(data, null, 2), () => {});
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function roomList() {
  return [...rooms.values()]
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
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#101218;color:#f1f3f8;font-size:17px}
  .wrap{max-width:560px;margin:0 auto;padding:20px 14px}
  h1{font-size:1.5rem;margin:10px 0 18px}
  a.room{display:flex;align-items:center;gap:14px;background:#1a1d26;border-radius:16px;padding:16px;margin-bottom:12px;color:inherit;text-decoration:none;border:1px solid transparent}
  a.room:hover{border-color:#4f8cff}
  a.room.off{opacity:.5}
  .dot{width:12px;height:12px;border-radius:50%;background:#2fd27d;flex-shrink:0}
  .off .dot{background:#ff5f6d}
  .t{font-weight:700;font-size:1.1rem}
  .s{color:#97a0b5;font-size:.85rem;margin-top:2px}
  .hint{color:#97a0b5;font-size:.85rem;margin-top:24px;line-height:1.5}
  code{background:#242837;padding:2px 6px;border-radius:6px}
</style></head><body><div class="wrap">
<h1>🔊 Speaker Queue · choose a room</h1>
<div id="list">Loading…</div>
<div class="hint">A room is a PC with a speaker running <b>SpeakerQueue.exe</b>. To add one: on that PC, open the queue page → Host controls → Online hub, enter this site's address as <code id="agentUrl"></code>, a room name and a secret key.</div>
</div>
<script>
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
document.getElementById('agentUrl').textContent=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/agent';
async function load(){
  try{
    const rooms=await (await fetch('rooms')).json();
    const el=document.getElementById('list');
    if(!rooms.length){el.innerHTML='<div class="s">No rooms yet.</div>';return;}
    el.innerHTML=rooms.map(r=>'<a class="room '+(r.online?'':'off')+'" href="r/'+encodeURIComponent(r.name)+'/"><div class="dot"></div><div><div class="t">'+esc(r.name)+'</div><div class="s">'+(r.online?(r.nowPlaying?'▶ '+esc(r.nowPlaying):'online, nothing playing')+' · '+r.queue+' queued':'offline')+(r.speaker?' · '+esc(r.speaker):'')+'</div></div></a>').join('');
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
