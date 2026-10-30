'use strict';
/*
 * BT Speaker Pooler - shared YouTube queue server.
 *
 * One machine (the one connected to the Bluetooth speaker) runs this server.
 * Everyone else on the LAN opens http://<host-ip>:PORT, searches songs and
 * votes. The queue is ordered by host bumps, then votes, then arrival time.
 *
 * Playback engines:
 *   vlc     (default)  audio only. yt-dlp resolves the stream URL, a headless
 *                      VLC on this PC plays it. No browser tab needed.
 *   browser            the host keeps http://localhost:PORT/player open and the
 *                      official YouTube embed plays there. Needs no yt-dlp.
 *
 * Runs as plain `node server.js` or as a single .exe (see build.js). As an exe
 * it sets itself up on a fresh Windows PC: firewall rule, yt-dlp download,
 * VLC install through winget, and a Startup shortcut.
 *
 * Zero npm dependencies: Node >= 18 built-ins only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Single-executable support -------------------------------------------------
const sea = (() => {
  try {
    const s = require('node:sea');
    return s.isSea() ? s : null;
  } catch (_) {
    return null;
  }
})();
const APP_DIR = sea ? path.dirname(process.execPath) : __dirname;
const IS_WIN = process.platform === 'win32';
const ARGS = process.argv.slice(1);

const PORT = Number(process.env.PORT) || 3010;

// Optional config.json next to the exe. Fields:
//   hubUrl   "wss://.../agent"; "" turns the hub off; missing = the hub built into this exe
//   room, roomKey   the room on the hub (roomKey is a secret: it stops another PC taking the name)
//   roomAuto true   room name was generated from this PC's name on first run
//   adminPin        host PIN set from the page (ADMIN_PIN env var overrides it)
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { /* none yet */ }
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// The hub address compiled into the exe (build.js embeds hub-default.json). Never a key.
function loadHubDefault() {
  try {
    const raw = sea ? sea.getAsset('hub-default.json', 'utf8') : fs.readFileSync(path.join(__dirname, 'hub-default.json'), 'utf8');
    const u = String(JSON.parse(raw).hubUrl || '').trim();
    return /^wss?:\/\//.test(u) ? u : '';
  } catch (_) { return ''; } // older exe without the asset, or file missing when run from source
}
const DEFAULT_HUB_URL = loadHubDefault();

let ADMIN_PIN = process.env.ADMIN_PIN || (typeof config.adminPin === 'string' && config.adminPin) || '1234';
const PIN_FIXED = Boolean(process.env.ADMIN_PIN); // set by env: cannot be changed from the page
const MAX_PENDING_PER_USER = Number(process.env.MAX_PENDING_PER_USER) || 3;
const DATA_FILE = path.join(APP_DIR, 'queue.json');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const BIN_DIR = path.join(APP_DIR, 'bin');
const VLC_PORT = Number(process.env.VLC_PORT) || PORT + 5080; // 3010 -> 8090, local only
const VLC_PASS = crypto.randomBytes(8).toString('hex');
const STREAM_URL_TTL = 4 * 60 * 60 * 1000; // resolved googlevideo URLs stay valid ~6 h
const FIREWALL_RULE = 'BT Speaker Pooler';
const APP_NAME = 'Speaker Queue';
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  queue: [],          // pending songs
  nowPlaying: null,   // song object or null
  history: [],        // last 30 played songs (newest first)
  playback: {         // reported by VLC or the /player page
    engine: 'browser',
    playerOnline: false,
    paused: false,
    position: 0,
    duration: 0,
    volume: 100,
    lastReport: 0,
    status: '',       // short human text, e.g. "resolving stream"
    setup: 'starting', // '' when ready, otherwise what the server is setting up
  },
  bluetooth: {        // Bluetooth speaker control (Windows only)
    available: false,
    speaker: null,    // name of the paired speaker to use
    autoConnect: true,
    radio: '',        // 'On' | 'Off' | 'unknown'
    devices: [],      // paired audio devices [{name, connected}]
    paired: false,
    connected: false,
    status: '',       // 'connecting' | 'disconnecting' | ''
    lastError: '',
    checkedAt: 0,
  },
  hub: {              // online hub (optional): lets people use the queue from anywhere
    configured: false,
    connected: false,
    url: '',
    room: '',
    publicUrl: '',
    lastError: '',
    roomAuto: false,  // room name was generated from this PC's name
  },
};

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state.queue = Array.isArray(saved.queue) ? saved.queue : [];
    state.nowPlaying = saved.nowPlaying || null;
    state.history = Array.isArray(saved.history) ? saved.history : [];
    if (saved.playback && typeof saved.playback.volume === 'number') {
      state.playback.volume = saved.playback.volume;
    }
    if (saved.bluetooth) {
      if (typeof saved.bluetooth.speaker === 'string') state.bluetooth.speaker = saved.bluetooth.speaker;
      if (typeof saved.bluetooth.autoConnect === 'boolean') state.bluetooth.autoConnect = saved.bluetooth.autoConnect;
    }
  } catch (_) {
    /* first run: nothing saved yet */
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {
      queue: state.queue,
      nowPlaying: state.nowPlaying,
      history: state.history,
      playback: { volume: state.playback.volume },
      bluetooth: { speaker: state.bluetooth.speaker, autoConnect: state.bluetooth.autoConnect },
    };
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), () => {});
  }, 200);
}

// ---------------------------------------------------------------------------
// Queue ordering (the "priority")
//   1. host-bumped songs first (most recent bump on top)
//   2. more votes first
//   3. earlier added first
// ---------------------------------------------------------------------------
function sortQueue() {
  state.queue.sort((a, b) => {
    if ((b.bumpedAt || 0) !== (a.bumpedAt || 0)) return (b.bumpedAt || 0) - (a.bumpedAt || 0);
    if (b.votes.length !== a.votes.length) return b.votes.length - a.votes.length;
    return a.addedAt - b.addedAt;
  });
}

function advance(reason) {
  if (state.nowPlaying) {
    state.history.unshift({ ...state.nowPlaying, endedAt: Date.now(), endReason: reason || 'ended' });
    state.history = state.history.slice(0, 30);
    state.nowPlaying = null;
  }
  sortQueue();
  if (state.queue.length) {
    state.nowPlaying = { ...state.queue.shift(), startedAt: Date.now() };
  }
  state.playback.position = 0;
  state.playback.duration = 0;
  state.playback.paused = false; // new song starts playing
  saveState();
  if (engine === vlc) {
    if (state.nowPlaying) vlc.play(state.nowPlaying);
    else vlc.stop();
  }
  broadcastState();
  prefetchNext();
}

// Start the first song as soon as something is queued and nothing is playing.
function maybeStart() {
  if (!state.nowPlaying && state.queue.length) advance('start');
}

// ---------------------------------------------------------------------------
// YouTube helpers
// ---------------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function extractVideoId(input) {
  const text = String(input || '').trim();
  if (ID_RE.test(text)) return text;
  let url;
  try {
    url = new URL(text.includes('://') ? text : 'https://' + text);
  } catch (_) {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1];
    return ID_RE.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  return null;
}

async function fetchMeta(videoId) {
  const fallback = {
    title: 'YouTube video ' + videoId,
    author: '',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
  };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + videoId),
      { signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!res.ok) return fallback;
    const j = await res.json();
    return {
      title: j.title || fallback.title,
      author: j.author_name || '',
      thumbnail: j.thumbnail_url || fallback.thumbnail,
    };
  } catch (_) {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// yt-dlp: resolve a direct audio stream URL
// ---------------------------------------------------------------------------
function findYtDlp() {
  const candidates = [
    { cmd: path.join(BIN_DIR, 'yt-dlp.exe'), args: [] },
    { cmd: 'yt-dlp', args: [] },
    { cmd: path.join(process.env.APPDATA || '', 'Python', 'Python313', 'Scripts', 'yt-dlp.exe'), args: [] },
    { cmd: 'python', args: ['-m', 'yt_dlp'] },
    { cmd: 'py', args: ['-m', 'yt_dlp'] },
  ];
  if (process.env.YTDLP) candidates.unshift({ cmd: process.env.YTDLP, args: [] });
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve(null);
      const c = candidates[i++];
      if (c.cmd.includes(path.sep) && !fs.existsSync(c.cmd)) return tryNext();
      execFile(c.cmd, [...c.args, '--version'], { windowsHide: true, timeout: 20000 }, (err, out) => {
        if (!err && /^\d{4}\.\d{2}/.test(String(out).trim())) resolve({ ...c, version: String(out).trim() });
        else tryNext();
      });
    };
    tryNext();
  });
}

let ytdlp = null;
let denoPath = null; // optional JS runtime for yt-dlp (YouTube signature solving)

function ytdlpBaseArgs() {
  const a = [...ytdlp.args, '--no-warnings'];
  if (denoPath) a.push('--js-runtimes', 'deno:' + denoPath);
  return a;
}

function hasFreshUrl(song) {
  return Boolean(song.streamUrl) && Date.now() - (song.resolvedAt || 0) < STREAM_URL_TTL;
}

function resolveStream(song) {
  if (hasFreshUrl(song)) return Promise.resolve(song.streamUrl);
  if (!ytdlp) return Promise.reject(new Error('yt-dlp not found'));
  return new Promise((resolve, reject) => {
    const args = [...ytdlpBaseArgs(), '-f', 'bestaudio[ext=m4a]/bestaudio/best', '-g', '--no-playlist',
      'https://www.youtube.com/watch?v=' + song.videoId];
    execFile(ytdlp.cmd, args, { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 }, (err, out, errOut) => {
      if (err) {
        const msg = String(errOut || err.message).split('\n').find((l) => /ERROR/.test(l)) || err.message;
        return reject(new Error(msg.replace(/^ERROR:\s*/, '').slice(0, 200)));
      }
      const url = String(out).trim().split('\n')[0];
      if (!/^https?:\/\//.test(url)) return reject(new Error('yt-dlp returned no URL'));
      song.streamUrl = url;
      song.resolvedAt = Date.now();
      saveState();
      resolve(url);
    });
  });
}

// Search YouTube by text (no API key) using yt-dlp's ytsearch. Cached for 10 min.
const searchCache = new Map();
function searchYouTube(query) {
  const q = query.trim().toLowerCase();
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return Promise.resolve(hit.results);
  if (!ytdlp) return Promise.reject(new Error('Search needs yt-dlp. Paste a YouTube link instead.'));
  return new Promise((resolve, reject) => {
    const args = [...ytdlpBaseArgs(), 'ytsearch8:' + query.trim(), '--flat-playlist', '-j'];
    execFile(ytdlp.cmd, args, { windowsHide: true, timeout: 40000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, out) => {
      if (err && !out) return reject(new Error('Search failed. Try again or paste a link.'));
      const results = [];
      for (const line of String(out).split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (!j.id || !ID_RE.test(j.id)) continue;
          if (j.duration && j.duration > 20 * 60) continue; // skip hour-long mixes
          results.push({
            videoId: j.id,
            title: j.title || j.id,
            author: j.channel || j.uploader || '',
            duration: j.duration || 0,
            thumbnail: `https://i.ytimg.com/vi/${j.id}/mqdefault.jpg`,
          });
        } catch (_) { /* skip bad line */ }
      }
      searchCache.set(q, { at: Date.now(), results });
      resolve(results);
    });
  });
}

// Resolve the top queued song in the background so it starts instantly.
let prefetching = false;
function prefetchNext() {
  if (engine !== vlc || prefetching) return;
  const next = state.queue[0];
  if (!next || hasFreshUrl(next)) return;
  prefetching = true;
  resolveStream(next)
    .then(() => console.log('[prefetch] ready:', next.title))
    .catch((e) => {
      console.log('[prefetch] failed:', next.title, '-', e.message);
      next.prefetchError = e.message; // prevents endless retries; play() will retry once more
    })
    .finally(() => {
      prefetching = false;
      // Another song may have reached the top meanwhile.
      if (state.queue[0] && !hasFreshUrl(state.queue[0]) && !state.queue[0].prefetchError) setTimeout(prefetchNext, 500);
    });
}

// ---------------------------------------------------------------------------
// VLC engine (headless VLC controlled over its local HTTP interface)
// ---------------------------------------------------------------------------
function findVlc() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    process.env.VLC_PATH,
    path.join(pf, 'VideoLAN', 'VLC', 'vlc.exe'),
    path.join(pf86, 'VideoLAN', 'VLC', 'vlc.exe'),
    path.join(APP_DIR, 'vlc', 'vlc.exe'),
    '/Applications/VLC.app/Contents/MacOS/VLC',
    '/usr/bin/vlc',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const vlc = {
  exe: null,
  proc: null,
  token: null,        // id of the song we asked VLC to play
  started: false,     // VLC reported real playback for this token
  loadedAt: 0,
  stopping: false,
  auth: 'Basic ' + Buffer.from(':' + VLC_PASS).toString('base64'),

  async cmd(query) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(`http://127.0.0.1:${VLC_PORT}/requests/status.json${query ? '?' + query : ''}`,
        { headers: { Authorization: this.auth }, signal: ctrl.signal });
      if (!r.ok) throw new Error('VLC HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  },

  start() {
    if (this.proc) return;
    const args = ['-I', 'dummy', '--dummy-quiet', '--extraintf', 'http', '--http-host', '127.0.0.1',
      '--http-port', String(VLC_PORT), '--http-password', VLC_PASS, '--no-video', '--no-one-instance',
      '--http-reconnect', '--network-caching', '3000'];
    this.proc = spawn(this.exe, args, { windowsHide: true, stdio: 'ignore' });
    console.log('[vlc] started (pid ' + this.proc.pid + ')');
    this.proc.on('exit', (code) => {
      console.log('[vlc] exited with code', code);
      this.proc = null;
      state.playback.playerOnline = false;
      broadcastState();
      if (!this.stopping) setTimeout(() => this.start(), 3000);
    });
    this.proc.on('error', (e) => console.log('[vlc] error:', e.message));
    // Apply saved volume once the interface is up, then resume whatever was playing.
    setTimeout(async () => {
      try {
        await this.setVolume(state.playback.volume);
        if (state.nowPlaying) this.play(state.nowPlaying);
      } catch (_) { /* poll loop will report offline */ }
    }, 2500);
  },

  async play(song) {
    const token = song.id;
    this.token = token;
    this.started = false;
    this.loadedAt = Date.now();
    state.playback.status = 'resolving stream';
    broadcastState();
    let url;
    try {
      url = await resolveStream(song);
    } catch (e) {
      if (this.token !== token) return; // skipped meanwhile
      console.log('[vlc] cannot resolve', song.title, '-', e.message);
      state.playback.status = '';
      this.token = null;
      state.nowPlaying.error = e.message;
      advance('error');
      return;
    }
    if (this.token !== token) return; // skipped meanwhile
    try {
      await this.cmd('command=pl_empty');
      await this.cmd('command=in_play&input=' + encodeURIComponent(url));
      this.loadedAt = Date.now();
      state.playback.status = 'buffering';
      console.log('[vlc] playing:', song.title);
    } catch (e) {
      console.log('[vlc] play failed:', e.message);
      state.playback.status = 'VLC not responding';
    }
    broadcastState();
  },

  async stop() {
    this.token = null;
    this.started = false;
    state.playback.status = '';
    try { await this.cmd('command=pl_stop'); } catch (_) { /* ignore */ }
  },

  async pause() { await this.cmd('command=pl_forcepause'); state.playback.paused = true; },
  async resume() { await this.cmd('command=pl_forceresume'); state.playback.paused = false; },
  async setVolume(v) { await this.cmd('command=volume&val=' + Math.round((v / 100) * 256)); },

  async poll() {
    if (!this.proc) return;
    let s;
    try {
      s = await this.cmd();
    } catch (_) {
      if (state.playback.playerOnline) { state.playback.playerOnline = false; broadcastState(); }
      return;
    }
    const p = state.playback;
    const snapshot = () => JSON.stringify([p.playerOnline, p.paused, p.position, p.duration, p.volume, p.status]);
    const before = snapshot();
    p.playerOnline = true;
    p.lastReport = Date.now();
    p.volume = Math.round((s.volume / 256) * 100);
    if (this.token) {
      p.paused = s.state === 'paused';
      p.position = Math.max(0, s.time || 0);
      p.duration = s.length > 0 ? s.length : 0;
      if (s.state === 'playing' && s.time > 0) {
        this.started = true;
        p.status = '';
      }
      if (this.started && s.state === 'stopped') {
        // Song finished.
        this.token = null;
        this.started = false;
        advance('ended');
        return;
      }
      if (!this.started && p.status === 'buffering' && Date.now() - this.loadedAt > 40000) {
        console.log('[vlc] stream never started, skipping');
        this.token = null;
        if (state.nowPlaying) state.nowPlaying.error = 'stream did not start';
        advance('error');
        return;
      }
    } else {
      p.paused = false;
      p.position = 0;
      p.duration = 0;
    }
    if (snapshot() !== before) broadcastState();
  },

  // Kill VLC; the exit handler starts a fresh one that picks up the current
  // default audio device and resumes the current song.
  restart() {
    if (this.proc) { try { this.proc.kill(); } catch (_) { /* ignore */ } }
  },

  shutdown() {
    this.stopping = true;
    if (this.proc) { try { this.proc.kill(); } catch (_) { /* ignore */ } }
  },
};

let engine = null; // vlc object or null (browser mode)

// ---------------------------------------------------------------------------
// Bluetooth speaker control (Windows). Uses bluetooth.ps1 (Windows Bluetooth API)
// so anyone on the page can (re)connect the speaker to this PC.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bt = {
  script: path.join(BIN_DIR, 'bluetooth.ps1'),
  busy: false,
  pausedUntilConnect: false, // after a manual disconnect, stop auto-connecting
  lastAttempt: 0,

  init() {
    if (!IS_WIN) return;
    try {
      const src = sea ? Buffer.from(sea.getAsset('bluetooth.ps1')) : fs.readFileSync(path.join(APP_DIR, 'bluetooth.ps1'));
      fs.mkdirSync(BIN_DIR, { recursive: true });
      fs.writeFileSync(this.script, src);
      state.bluetooth.available = true;
    } catch (e) {
      console.log('[bt] helper unavailable: ' + e.message);
    }
  },

  async exec(args, timeout) {
    const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script, ...args], { timeout: timeout || 60000 });
    const last = r.out.trim().split('\n').pop();
    try {
      return JSON.parse(last);
    } catch (_) {
      return { ok: false, error: (r.err || r.out || 'no output from Bluetooth helper').trim().slice(0, 200) };
    }
  },

  async refresh() {
    const b = state.bluetooth;
    if (!b.available || this.busy) return;
    this.busy = true;
    try {
      const r = await this.exec(['list'], 30000);
      if (r.ok) {
        b.radio = r.radio || 'unknown';
        const audio = (r.devices || []).filter((d) => d.audio);
        b.devices = audio.map((d) => ({ name: d.name, connected: d.connected }));
        if (!b.speaker) {
          // First run: use the connected audio device, else something that sounds like a speaker.
          const pick = audio.find((d) => d.connected) || audio.find((d) => /stone|boat|speaker|jbl|sound|box/i.test(d.name));
          if (pick) { b.speaker = pick.name; saveState(); console.log('[bt] using speaker: ' + pick.name); }
        }
        const dev = audio.find((d) => d.name === b.speaker);
        b.paired = Boolean(dev);
        b.connected = Boolean(dev && dev.connected);
        b.lastError = '';
      } else {
        b.lastError = r.error || 'Bluetooth check failed';
      }
      b.checkedAt = Date.now();
    } finally {
      this.busy = false;
    }
    broadcastState();
  },

  async connect() {
    const b = state.bluetooth;
    if (!b.available) throw new Error('Bluetooth control works only on the Windows host.');
    if (!b.speaker) throw new Error('No speaker chosen yet. Host: pick it under Host controls.');
    if (this.busy) throw new Error('Bluetooth is busy, try again in a few seconds.');
    this.busy = true;
    this.pausedUntilConnect = false;
    this.lastAttempt = Date.now();
    b.status = 'connecting';
    broadcastState();
    try {
      if (b.radio && b.radio !== 'On' && b.radio !== 'unknown') {
        const rr = await this.exec(['radio', 'on'], 30000);
        if (!rr.ok) throw new Error('Bluetooth is off and could not be switched on: ' + rr.error);
        await sleep(3000);
      }
      const r = await this.exec(['connect', b.speaker], 60000);
      if (!r.ok) throw new Error(r.error || 'Could not connect.');
      b.connected = true;
      b.lastError = '';
      if (!r.note && engine === vlc) {
        // New audio endpoint appeared: restart VLC so sound goes to the speaker.
        setTimeout(() => vlc.restart(), 1500);
      }
      return r;
    } catch (e) {
      b.lastError = e.message;
      throw e;
    } finally {
      b.status = '';
      this.busy = false;
      broadcastState();
      setTimeout(() => this.refresh(), 2500);
    }
  },

  async disconnect() {
    const b = state.bluetooth;
    if (!b.available || !b.speaker) throw new Error('No speaker to disconnect.');
    if (this.busy) throw new Error('Bluetooth is busy, try again in a few seconds.');
    this.busy = true;
    b.status = 'disconnecting';
    broadcastState();
    try {
      const r = await this.exec(['disconnect', b.speaker], 30000);
      if (!r.ok) throw new Error(r.error || 'Could not disconnect.');
      this.pausedUntilConnect = true; // let someone else use the speaker until Connect is pressed
      b.connected = false;
      return r;
    } finally {
      b.status = '';
      this.busy = false;
      broadcastState();
      setTimeout(() => this.refresh(), 2000);
    }
  },

  // Every 20 s: refresh status; if the speaker is paired but not connected, try to
  // connect at most once a minute. Covers "speaker switched on in the morning".
  async tick() {
    const b = state.bluetooth;
    if (!b.available) return;
    await this.refresh();
    if (b.autoConnect && !this.pausedUntilConnect && b.speaker && b.paired && !b.connected
        && Date.now() - this.lastAttempt > 60000) {
      try {
        await this.connect();
        console.log('[bt] auto-connected ' + b.speaker);
      } catch (_) { /* speaker is probably switched off; try again later */ }
    }
  },
};

// ---------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------
const sseClients = new Set();

function publicState() {
  return {
    queue: state.queue,
    nowPlaying: state.nowPlaying,
    history: state.history.slice(0, 10),
    playback: state.playback,
    bluetooth: state.bluetooth,
    hub: state.hub,
    pinFixed: PIN_FIXED,
    maxPendingPerUser: MAX_PENDING_PER_USER,
    serverTime: Date.now(),
  };
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastState() {
  const payload = publicState();
  for (const res of sseClients) sseSend(res, 'state', payload);
  hub.send({ type: 'event', event: 'state', data: payload });
}

function broadcastCommand(cmd) {
  for (const res of sseClients) sseSend(res, 'cmd', cmd);
  hub.send({ type: 'event', event: 'cmd', data: cmd });
}

// ---------------------------------------------------------------------------
// Hub client: outbound WebSocket to the hosted hub (hub/server.js). The hub
// relays API calls from its web page to us and fans our events out to viewers.
// Uses Node's built-in WebSocket client (Node 22+), no dependencies.
// ---------------------------------------------------------------------------
const hub = {
  ws: null,
  timer: null,
  backoff: 2000,
  stopped: false,

  settings() {
    return {
      // env > config.json > the hub built into this exe. An explicit "" in config.json means off.
      url: process.env.HUB_URL || (typeof config.hubUrl === 'string' ? config.hubUrl : DEFAULT_HUB_URL),
      room: process.env.ROOM || config.room || '',
      key: process.env.ROOM_KEY || config.roomKey || '',
    };
  },

  // First run with a hub address but no room: name the room after this PC and make a key,
  // so the host never has to touch this PC's local page. Skipped on non-Windows unless
  // HUB_URL is set explicitly (a copy deployed to a server by mistake must not register rooms).
  ensureRoom() {
    const s = this.settings();
    if (!s.url || s.room) return;
    if (!IS_WIN && !process.env.HUB_URL) return;
    config.room = roomNameFromHost();
    if (!s.key) config.roomKey = crypto.randomBytes(12).toString('base64url');
    config.roomAuto = true;
    saveConfig();
    console.log(`[hub] first run: joining the hub as room "${config.room}" (rename it under Host controls -> Online hub)`);
  },

  configure(url, room, key) {
    config.hubUrl = url;
    config.room = room;
    config.roomKey = key;
    delete config.roomAuto;
    saveConfig();
    state.hub.lastError = '';
    this.renamed = false;
    // This call may itself have arrived through the hub: let the reply leave before the socket closes.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reconnect(), 500);
  },

  reconnect() {
    if (this.ws) { try { this.ws.close(); } catch (_) { /* ignore */ } }
    clearTimeout(this.timer);
    this.backoff = 2000;
    this.connect();
  },

  connect() {
    const s = this.settings();
    state.hub.configured = Boolean(s.url && s.room);
    state.hub.url = s.url;
    state.hub.room = s.room;
    state.hub.roomAuto = Boolean(config.roomAuto);
    if (!state.hub.configured || this.stopped) { broadcastState(); return; }
    if (typeof WebSocket === 'undefined') {
      state.hub.lastError = 'Node 22 or newer is needed for the hub connection.';
      console.log('[hub] ' + state.hub.lastError);
      return;
    }
    let ws;
    try {
      ws = new WebSocket(s.url);
    } catch (e) {
      state.hub.lastError = 'bad hub URL: ' + e.message;
      broadcastState();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 2000;
      ws.send(JSON.stringify({ type: 'register', room: s.room, key: s.key, name: os.hostname(), speaker: state.bluetooth.speaker || '' }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      this.onMessage(m).catch((e) => console.log('[hub] handler error: ' + e.message));
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = state.hub.connected;
      state.hub.connected = false;
      state.hub.publicUrl = '';
      if (was) console.log('[hub] disconnected' + (ev && ev.reason ? ': ' + ev.reason : ''));
      if (ev && ev.code === 4001 && config.roomAuto && !this.renamed) {
        // The auto-generated name is already owned by another PC: add a short suffix, once per run.
        this.renamed = true;
        const base = String(config.room).replace(/-[A-Z0-9]{3}$/, '').slice(0, 36);
        config.room = base + '-' + crypto.randomBytes(2).toString('hex').slice(0, 3).toUpperCase();
        saveConfig();
        state.hub.lastError = '';
        console.log(`[hub] room name is taken, trying "${config.room}" instead`);
        broadcastState();
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.connect(), 1000);
        return;
      }
      const wait = this.backoff;
      if (!state.hub.lastError || /retry/.test(state.hub.lastError)) {
        state.hub.lastError = (ev && ev.reason && ev.code !== 1006 ? ev.reason : 'cannot reach the hub (no internet, wrong address, or the hub is waking up)')
          + `, retry in ${Math.round(wait / 1000)} s`;
        console.log('[hub] ' + state.hub.lastError);
      }
      broadcastState();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.connect(), wait);
      this.backoff = Math.min(this.backoff * 2, 60000);
    };
  },

  async onMessage(m) {
    if (m.type === 'registered') {
      state.hub.connected = true;
      state.hub.publicUrl = m.publicUrl || '';
      state.hub.lastError = '';
      console.log('[hub] connected, room page: ' + state.hub.publicUrl);
      if (this.announced !== state.hub.publicUrl) {
        this.announced = state.hub.publicUrl;
        console.log('');
        console.log(`  Manage it from any device: ${state.hub.publicUrl}  ->  Host controls, PIN ${ADMIN_PIN}`);
        console.log('  Anyone with that link can add songs.' + (config.roomAuto ? ' The room is named after this PC; rename it under Online hub.' : ''));
        console.log('');
      }
      broadcastState();
    } else if (m.type === 'error') {
      state.hub.lastError = m.error || 'hub error';
      console.log('[hub] ' + state.hub.lastError);
      broadcastState();
    } else if (m.type === 'http') {
      const r = await localApi(m.method || 'POST', m.path, m.body);
      this.send({ type: 'http-res', id: m.id, status: r.status, body: r.body });
    } else if (m.type === 'ping') {
      this.send({ type: 'pong' });
    }
  },

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch (_) { /* ignore */ }
    }
  },
};

// Run an API call in-process (used for requests relayed by the hub).
function localApi(method, pathname, body) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      _status: 200,
      writeHead(status) { this._status = status; this.headersSent = true; },
      write() {},
      end(str) {
        let parsed = null;
        try { parsed = str ? JSON.parse(str) : null; } catch (_) { parsed = { raw: String(str) }; }
        resolve({ status: this._status, body: parsed });
      },
    };
    handleApi({ method }, res, pathname, body === undefined ? {} : body)
      .catch((e) => { console.error(e); resolve({ status: 500, body: { error: 'server error' } }); });
  });
}

setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
  // Browser player considered offline if it has not reported for 10 s.
  if (engine !== vlc && state.playback.playerOnline && Date.now() - state.playback.lastReport > 10000) {
    state.playback.playerOnline = false;
    broadcastState();
  }
}, 5000);

// ---------------------------------------------------------------------------
// Share addresses (the IP may change; the hostname does not)
// ---------------------------------------------------------------------------
const VIRTUAL_RE = /vpn|tap|tun|vethernet|virtual|vmware|hyper-v|loopback|docker|wsl|bluetooth/i;

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, virtual: VIRTUAL_RE.test(name) });
    }
  }
  // real Wi-Fi / Ethernet first
  out.sort((x, y) => Number(x.virtual) - Number(y.virtual));
  return out;
}

function shareInfo() {
  const host = os.hostname();
  const ips = lanAddresses();
  return {
    port: PORT,
    hostname: host,
    hostnameUrl: `http://${host}:${PORT}`,
    localUrl: `http://${host.toLowerCase()}.local:${PORT}`,
    ipUrls: ips.map((a) => ({ url: `http://${a.address}:${PORT}`, adapter: a.name, virtual: a.virtual })),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function isAdmin(body) {
  return typeof body.pin === 'string' && body.pin === ADMIN_PIN;
}

const ROOM_RE = /^[\w][\w \-]{0,39}$/; // same rule as the hub

// Room name from this PC's name: letters, digits, space, - or _, max 36 (leaves room for a suffix).
function roomNameFromHost() {
  const n = os.hostname().replace(/\.local$/i, '').replace(/[^\w \-]+/g, '-').replace(/^[^\w]+/, '').slice(0, 36).trim();
  return n || 'Speaker-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 24);
  return n || 'Anonymous';
}

// Static files come from public/ on disk, or from embedded assets in the exe.
function readStatic(name, cb) {
  if (sea) {
    try {
      return cb(null, Buffer.from(sea.getAsset(name)));
    } catch (e) {
      return cb(e);
    }
  }
  fs.readFile(path.join(PUBLIC_DIR, name), cb);
}

const PRIVATE_ASSETS = new Set(['bluetooth.ps1', 'hub-default.json']); // embedded, but not web pages

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/player') pathname = '/player.html';
  const name = path.posix.basename(pathname);
  if (!/^[\w.-]+$/.test(name) || pathname !== '/' + name) return json(res, 404, { error: 'not found' });
  if (PRIVATE_ASSETS.has(name)) return json(res, 404, { error: 'not found' });
  readStatic(name, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname, presetBody) {
  if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, publicState());
  if (req.method === 'GET' && pathname === '/api/share') return json(res, 200, shareInfo());

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    sseSend(res, 'state', publicState());
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  let body = presetBody;
  if (body === undefined) {
    try {
      body = await readBody(req);
    } catch (_) {
      return json(res, 400, { error: 'bad JSON body' });
    }
  }
  if (!body || typeof body !== 'object') body = {};

  switch (pathname) {
    // Anyone: search by song name or link ---------------------------------------
    case '/api/search': {
      const q = String(body.q || '').trim();
      if (q.length < 2) return json(res, 400, { error: 'Type a song name or paste a link.' });
      const videoId = extractVideoId(q);
      if (videoId) {
        const meta = await fetchMeta(videoId);
        return json(res, 200, { results: [{ videoId, ...meta, duration: 0 }] });
      }
      try {
        return json(res, 200, { results: await searchYouTube(q) });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // Anyone: add a song -------------------------------------------------------
    case '/api/add': {
      const user = cleanName(body.user);
      const videoId = extractVideoId(body.url);
      if (!videoId) return json(res, 400, { error: 'That does not look like a YouTube link or video ID.' });

      const existing = state.queue.find((s) => s.videoId === videoId);
      if (existing) {
        if (!existing.votes.includes(user)) existing.votes.push(user);
        sortQueue();
        saveState();
        broadcastState();
        prefetchNext();
        return json(res, 200, { ok: true, duplicate: true, message: 'Already in queue, your vote was added instead.' });
      }
      if (state.nowPlaying && state.nowPlaying.videoId === videoId) {
        return json(res, 409, { error: 'That song is playing right now.' });
      }
      const pending = state.queue.filter((s) => s.addedBy === user).length;
      if (pending >= MAX_PENDING_PER_USER && !isAdmin(body)) {
        return json(res, 429, { error: `You already have ${pending} songs waiting. Wait for one to play first.` });
      }

      const meta = await fetchMeta(videoId);
      const song = {
        id: crypto.randomUUID(),
        videoId,
        title: meta.title,
        author: meta.author,
        thumbnail: meta.thumbnail,
        addedBy: user,
        addedAt: Date.now(),
        votes: [user],
        bumpedAt: 0,
      };
      state.queue.push(song);
      sortQueue();
      saveState();
      maybeStart();
      broadcastState();
      prefetchNext();
      return json(res, 200, { ok: true, song });
    }

    // Anyone: toggle vote ------------------------------------------------------
    case '/api/vote': {
      const user = cleanName(body.user);
      const song = state.queue.find((s) => s.id === body.id);
      if (!song) return json(res, 404, { error: 'Song not in queue any more.' });
      const i = song.votes.indexOf(user);
      if (i >= 0) song.votes.splice(i, 1);
      else song.votes.push(user);
      sortQueue();
      saveState();
      broadcastState();
      prefetchNext();
      return json(res, 200, { ok: true, voted: i < 0 });
    }

    // Owner or host: remove from queue ----------------------------------------
    case '/api/remove': {
      const user = cleanName(body.user);
      const idx = state.queue.findIndex((s) => s.id === body.id);
      if (idx < 0) return json(res, 404, { error: 'Song not in queue any more.' });
      if (state.queue[idx].addedBy !== user && !isAdmin(body)) {
        return json(res, 403, { error: 'Only the person who added it (or the host) can remove it.' });
      }
      state.queue.splice(idx, 1);
      saveState();
      broadcastState();
      prefetchNext();
      return json(res, 200, { ok: true });
    }

    // Anyone: Bluetooth speaker ---------------------------------------------------
    case '/api/bt': {
      try {
        if (body.action === 'connect') return json(res, 200, { ok: true, result: await bt.connect() });
        if (body.action === 'disconnect') {
          if (!isAdmin(body)) return json(res, 403, { error: 'Only the host can disconnect the speaker (PIN needed).' });
          return json(res, 200, { ok: true, result: await bt.disconnect() });
        }
        if (body.action === 'refresh') { await bt.refresh(); return json(res, 200, { ok: true, bluetooth: state.bluetooth }); }
        return json(res, 400, { error: 'unknown action' });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // Host only ----------------------------------------------------------------
    case '/api/admin': {
      if (!isAdmin(body)) return json(res, 403, { error: 'Wrong host PIN.' });
      try {
        switch (body.action) {
          case 'check':
            return json(res, 200, { ok: true });
          case 'speaker': {
            const name = String(body.name || '').trim();
            if (!name) return json(res, 400, { error: 'speaker name required' });
            state.bluetooth.speaker = name;
            bt.pausedUntilConnect = false;
            saveState();
            bt.refresh();
            return json(res, 200, { ok: true });
          }
          case 'autoconnect':
            state.bluetooth.autoConnect = Boolean(body.value);
            saveState();
            broadcastState();
            return json(res, 200, { ok: true });
          case 'hub': {
            const url = String(body.url || '').trim();
            const room = String(body.room || '').trim().slice(0, 40);
            const key = String(body.key || '').trim() || hub.settings().key; // blank keeps the current key
            if (url && !/^wss?:\/\//.test(url)) return json(res, 400, { error: 'Hub URL must start with ws:// or wss://' });
            if (url && !room) return json(res, 400, { error: 'Room name required' });
            if (url && !ROOM_RE.test(room)) return json(res, 400, { error: 'Room name: letters, numbers, spaces, - or _ (max 40).' });
            hub.configure(url, room, key);
            return json(res, 200, { ok: true, url, room });
          }
          case 'pin': {
            if (PIN_FIXED) return json(res, 409, { error: 'The PIN is fixed by the ADMIN_PIN environment variable on the speaker PC.' });
            const newPin = String(body.newPin || '').trim();
            if (!/^\d{4,8}$/.test(newPin)) return json(res, 400, { error: 'PIN must be 4 to 8 digits.' });
            ADMIN_PIN = newPin;
            config.adminPin = newPin;
            saveConfig();
            console.log(`  Host PIN changed from the page. New PIN: ${newPin}`);
            return json(res, 200, { ok: true });
          }
          case 'skip':
            advance('skipped');
            return json(res, 200, { ok: true });
          case 'pause':
          case 'play':
            if (engine === vlc) {
              if (body.action === 'pause') await vlc.pause();
              else await vlc.resume();
            } else {
              state.playback.paused = body.action === 'pause';
              broadcastCommand({ type: body.action });
            }
            broadcastState();
            return json(res, 200, { ok: true });
          case 'volume': {
            const v = Math.max(0, Math.min(100, Number(body.value)));
            if (Number.isNaN(v)) return json(res, 400, { error: 'bad volume' });
            state.playback.volume = v;
            if (engine === vlc) await vlc.setVolume(v);
            else broadcastCommand({ type: 'volume', value: v });
            saveState();
            broadcastState();
            return json(res, 200, { ok: true });
          }
          case 'bump': {
            const song = state.queue.find((s) => s.id === body.id);
            if (!song) return json(res, 404, { error: 'Song not in queue any more.' });
            song.bumpedAt = Date.now();
            sortQueue();
            saveState();
            broadcastState();
            prefetchNext();
            return json(res, 200, { ok: true });
          }
          case 'unbump': {
            const song = state.queue.find((s) => s.id === body.id);
            if (!song) return json(res, 404, { error: 'Song not in queue any more.' });
            song.bumpedAt = 0;
            sortQueue();
            saveState();
            broadcastState();
            prefetchNext();
            return json(res, 200, { ok: true });
          }
          case 'clear':
            state.queue = [];
            saveState();
            broadcastState();
            return json(res, 200, { ok: true });
          case 'replay': {
            const song = state.history.find((s) => s.id === body.id);
            if (!song) return json(res, 404, { error: 'Not in history.' });
            const copy = { ...song, id: crypto.randomUUID(), addedAt: Date.now(), votes: [song.addedBy], bumpedAt: Date.now() };
            delete copy.endedAt;
            delete copy.endReason;
            delete copy.startedAt;
            delete copy.error;
            delete copy.prefetchError;
            state.queue.push(copy);
            sortQueue();
            saveState();
            maybeStart();
            broadcastState();
            prefetchNext();
            return json(res, 200, { ok: true });
          }
          default:
            return json(res, 400, { error: 'unknown action' });
        }
      } catch (e) {
        return json(res, 502, { error: 'VLC did not respond: ' + e.message });
      }
    }

    // Browser player page (only in browser mode) ---------------------------------
    case '/api/player/status': {
      if (!isAdmin(body)) return json(res, 403, { error: 'Wrong host PIN.' });
      if (engine === vlc) return json(res, 409, { error: 'This server plays through VLC. The /player page is not needed.' });
      const p = state.playback;
      const wasOnline = p.playerOnline;
      p.playerOnline = true;
      p.lastReport = Date.now();
      if (typeof body.position === 'number') p.position = body.position;
      if (typeof body.duration === 'number') p.duration = body.duration;
      if (typeof body.paused === 'boolean') p.paused = body.paused;
      if (typeof body.volume === 'number') p.volume = body.volume;
      if (!wasOnline) maybeStart();
      broadcastState();
      return json(res, 200, { ok: true });
    }

    case '/api/player/ended': {
      if (!isAdmin(body)) return json(res, 403, { error: 'Wrong host PIN.' });
      if (engine === vlc) return json(res, 409, { error: 'This server plays through VLC.' });
      // Ignore stale reports for a song that is no longer current.
      if (!state.nowPlaying || state.nowPlaying.id !== body.id) return json(res, 200, { ok: true, ignored: true });
      advance(body.reason || 'ended');
      return json(res, 200, { ok: true });
    }

    default:
      return json(res, 404, { error: 'unknown endpoint' });
  }
}

// ---------------------------------------------------------------------------
// First-run setup helpers (Windows). Everything here is best effort: a failure
// is logged and the server keeps running with what it has.
// ---------------------------------------------------------------------------
// Full paths so setup works even when PATH is unusual (e.g. started from a shortcut).
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = fs.existsSync(path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  ? path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
const NETSH = fs.existsSync(path.join(SYS32, 'netsh.exe')) ? path.join(SYS32, 'netsh.exe') : 'netsh';

function run(cmd, args, opts) {
  if (cmd === 'powershell') cmd = POWERSHELL;
  if (cmd === 'netsh') cmd = NETSH;
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10 * 60 * 1000, ...opts }, (err, out, errOut) => {
      resolve({ ok: !err, out: String(out || ''), err: String(errOut || err?.message || '') });
    });
  });
}

function setSetup(text) {
  state.playback.setup = text;
  if (text) console.log('[setup] ' + text);
  broadcastState();
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

// One elevated step (single UAC prompt): firewall rule + never sleep + lid does nothing.
async function ensureAdminSetup() {
  if (!IS_WIN || process.env.NO_FIREWALL) return;
  const stamp = path.join(BIN_DIR, 'admin-setup.done');
  const check = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE}`]);
  const haveRule = check.ok && check.out.includes(String(PORT));
  if (haveRule && fs.existsSync(stamp)) return;
  setSetup('one-time Windows setup: firewall rule, no sleep, lid does nothing (click Yes on the admin prompt)');
  const script = path.join(BIN_DIR, 'admin-setup.ps1');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(script, [
    `netsh advfirewall firewall delete rule name="${FIREWALL_RULE}" | Out-Null`,
    `netsh advfirewall firewall add rule name="${FIREWALL_RULE}" dir=in action=allow protocol=TCP localport=${PORT} profile=private,domain,public | Out-Null`,
    '# keep the PC awake: no sleep/hibernate on power or battery, closing the lid does nothing',
    'powercfg /change standby-timeout-ac 0',
    'powercfg /change standby-timeout-dc 0',
    'powercfg /change hibernate-timeout-ac 0',
    'powercfg /change hibernate-timeout-dc 0',
    'powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0',
    'powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0',
    'powercfg /setactive SCHEME_CURRENT',
    `Set-Content -Path '${stamp}' -Value (Get-Date)`,
  ].join('\r\n'));
  const r = await run('powershell', ['-NoProfile', '-Command',
    `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"'`]);
  if (!r.ok || !fs.existsSync(stamp)) console.log('[setup] admin step not completed (prompt declined?). Other devices may not reach the page and the PC may sleep.');
}

async function ensureYtDlp() {
  ytdlp = await findYtDlp();
  if (!ytdlp && IS_WIN) {
    setSetup('downloading yt-dlp (one time, ~18 MB)');
    try {
      await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', path.join(BIN_DIR, 'yt-dlp.exe'));
      ytdlp = await findYtDlp();
    } catch (e) {
      console.log('[setup] yt-dlp download failed: ' + e.message);
    }
  }
  // Keep our own copy fresh: YouTube changes break old versions. Update weekly in the background.
  if (ytdlp && ytdlp.cmd === path.join(BIN_DIR, 'yt-dlp.exe')) {
    const stamp = path.join(BIN_DIR, 'yt-dlp.updated');
    let last = 0;
    try { last = fs.statSync(stamp).mtimeMs; } catch (_) { /* never */ }
    if (Date.now() - last > 7 * 24 * 3600 * 1000) {
      execFile(ytdlp.cmd, ['-U'], { windowsHide: true, timeout: 120000 }, () => {
        fs.writeFile(stamp, new Date().toISOString(), () => {});
        findYtDlp().then((y) => { if (y) { ytdlp = y; console.log('[setup] yt-dlp now ' + y.version); } });
      });
    }
  }
}

async function ensureDeno() {
  if (!IS_WIN || process.env.NO_DENO) return;
  const exe = path.join(BIN_DIR, 'deno.exe');
  if (fs.existsSync(exe)) { denoPath = exe; return; }
  setSetup('downloading Deno for YouTube playback (one time, ~40 MB)');
  const zip = path.join(BIN_DIR, 'deno.zip');
  try {
    await download('https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip', zip);
    const r = await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${BIN_DIR}' -Force`]);
    if (fs.existsSync(exe)) denoPath = exe;
    else console.log('[setup] deno extract failed: ' + r.err.slice(0, 200));
  } catch (e) {
    console.log('[setup] deno download failed (optional): ' + e.message);
  } finally {
    try { fs.unlinkSync(zip); } catch (_) { /* ignore */ }
  }
}

async function ensureVlc() {
  vlc.exe = findVlc();
  if (vlc.exe || !IS_WIN || process.env.NO_VLC_INSTALL) return;
  setSetup('installing VLC with winget (approve the prompt if asked)');
  await run('winget', ['install', '--id', 'VideoLAN.VLC', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements']);
  vlc.exe = findVlc();
  if (!vlc.exe) {
    console.log('[setup] VLC still not found. Install it from https://www.videolan.org/vlc/ and restart.');
    run('cmd', ['/c', 'start', '', 'https://www.videolan.org/vlc/']);
  }
}

function startupShortcutPath() {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', APP_NAME + '.lnk');
}

async function ensureAutostart() {
  if (!IS_WIN || !sea) return; // only meaningful for the packaged exe
  const lnk = startupShortcutPath();
  if (ARGS.includes('--remove-autostart')) {
    try { fs.unlinkSync(lnk); console.log('Removed Startup shortcut: ' + lnk); } catch (_) { console.log('No Startup shortcut to remove.'); }
    process.exit(0);
  }
  if (ARGS.includes('--no-autostart') || process.env.NO_AUTOSTART) return;
  if (fs.existsSync(lnk)) return;
  setSetup('adding Startup shortcut so the queue runs after every login');
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}');` +
    `$s.TargetPath='${process.execPath}';$s.WorkingDirectory='${APP_DIR}';$s.WindowStyle=7;` +
    `$s.Description='Shared YouTube queue for the Bluetooth speaker';$s.Save()`;
  const r = await run('powershell', ['-NoProfile', '-Command', ps]);
  if (!r.ok) console.log('[setup] could not create Startup shortcut: ' + r.err.slice(0, 200));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function printBanner() {
  const info = shareInfo();
  console.log('');
  console.log('  ' + APP_NAME + ' is running');
  console.log('  ---------------------------');
  console.log(`  Host PIN           : ${ADMIN_PIN}  ${PIN_FIXED ? '(fixed by the ADMIN_PIN env var)' : '(change it on the page: Host controls -> Change PIN)'}`);
  console.log(`  Playback engine    : ${engine === vlc ? 'VLC (audio only, yt-dlp ' + ytdlp.version + (denoPath ? ', deno' : '') + ')' : 'browser (open /player here)'}`);
  console.log(`  Queue page here    : http://localhost:${PORT}/`);
  console.log('  Share with others  :');
  console.log(`      ${info.localUrl}   (permanent, works even if the IP changes)`);
  for (const a of info.ipUrls) console.log(`      ${a.url}   (${a.adapter}${a.virtual ? ', virtual' : ''})`);
  console.log('');
  if (engine === vlc) console.log('  Audio goes to the Windows default output device (your Bluetooth speaker).');
  else console.log('  Keep the /player tab open on this PC; its audio goes to the Bluetooth speaker.');
  if (state.bluetooth.available) console.log(`  Bluetooth speaker  : ${state.bluetooth.speaker || '(none chosen yet, host picks it on the page)'}${state.bluetooth.autoConnect ? ', auto-connect on' : ''}`);
  const hs = hub.settings();
  if (hs.url) console.log(`  Online hub         : ${hs.url}  room "${hs.room}"${config.roomAuto ? ' (named after this PC)' : ''} (connecting... the room link is printed when connected)`);
  else console.log('  Online hub         : off ("hubUrl": "" in config.json). Turn it on under Host controls -> Online hub.');
  console.log('  Open the Share section on the queue page to show a QR code to the room.');
  console.log('');
}

async function boot() {
  if (ARGS.includes('--help') || ARGS.includes('-h')) {
    console.log(`${APP_NAME}\n  --no-autostart       do not add a Startup shortcut\n  --remove-autostart   remove the Startup shortcut and exit\n  env: PORT ADMIN_PIN PLAYER=vlc|browser MAX_PENDING_PER_USER VLC_PATH YTDLP NO_FIREWALL NO_DENO NO_VLC_INSTALL NO_AUTOSTART\n       HUB_URL ROOM ROOM_KEY (or config.json: hubUrl, room, roomKey, roomAuto, adminPin)`);
    process.exit(0);
  }
  loadState();
  sortQueue();
  hub.ensureRoom();

  // Serve the page right away so the host sees setup progress.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url.pathname).catch((err) => {
        console.error(err);
        if (!res.headersSent) json(res, 500, { error: 'server error' });
      });
    } else {
      serveStatic(req, res, url.pathname);
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`\n  Port ${PORT} is already in use. Is another copy of ${APP_NAME} running? Close it first.\n`);
      setTimeout(() => process.exit(1), 8000);
    } else {
      console.error(e);
      process.exit(1);
    }
  });
  await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));
  console.log(`  Listening on http://localhost:${PORT}  (setting up...)`);

  await ensureAutostart();
  await ensureAdminSetup();
  bt.init();
  bt.refresh(); // in the background; the page shows the result when ready

  const wanted = (process.env.PLAYER || 'vlc').toLowerCase();
  if (wanted === 'vlc') {
    await ensureYtDlp();
    await ensureDeno();
    await ensureVlc();
    if (vlc.exe && ytdlp) {
      engine = vlc;
      state.playback.engine = 'vlc';
    } else {
      console.log('');
      if (!vlc.exe) console.log('  !! VLC not found. Install it from https://www.videolan.org or set VLC_PATH.');
      if (!ytdlp) console.log('  !! yt-dlp not found. Run:  python -m pip install --user -U yt-dlp');
      console.log('  Falling back to browser mode (keep /player open).');
    }
  }
  // Deployed to a cloud host by mistake (this app only makes sense on the Windows PC with the speaker)?
  const WRONG_HOST = !IS_WIN
    ? 'This is the speaker app, not the hub, and it is running on a Linux server where it cannot search, play or use Bluetooth. Deploy the "hub" folder here instead (on Render set Root Directory to hub) and run SpeakerQueue.exe on the Windows PC with the speaker'
    : '';
  setSetup(WRONG_HOST);
  if (WRONG_HOST) console.log('\n  !! ' + WRONG_HOST + '\n');
  printBanner();

  if (engine === vlc) {
    vlc.start();
    setInterval(() => vlc.poll(), 1000);
    prefetchNext();
  }
  if (state.bluetooth.available) setInterval(() => bt.tick(), 20000);
  hub.connect();
}

function shutdown() {
  hub.stopped = true;
  if (engine === vlc) vlc.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { if (engine === vlc) vlc.shutdown(); });

boot().catch((e) => {
  console.error(e);
  process.exit(1);
});
