# Speaker Queue Hub

The hosted meeting point. Speaker PCs (running `SpeakerQueue.exe`) connect
out to this site and register a room. People open the site from anywhere,
pick a room and get the normal queue page. The hub itself never plays or
downloads anything, it only relays, so the smallest instance is enough.

## Deploy

Any host that runs Node 18+ and allows WebSockets works. Three easy options:

**Render (free tier, good for trying it out)**
1. Push this `hub` folder to a GitHub repository (it must be the repo root, or
   set the root directory to `hub`).
2. On render.com: New → Web Service → connect the repo. Runtime Node, build
   command `npm install`, start command `node server.js`.
3. Add a disk (1 GB) mounted at `/data` and set env var `DATA_DIR=/data` so
   room keys survive restarts. Optional: `PUBLIC_URL=https://<your-app>.onrender.com`.
4. Free instances sleep after 15 min without web traffic; the first visit then
   takes about a minute to wake. Paid tier or another host avoids that.

**Railway / Fly.io / any Docker host**
- The `Dockerfile` is ready: `docker build -t speaker-hub . && docker run -p 8080:8080 -v hubdata:/data speaker-hub`.

**Your own VPS (most reliable, about 4 to 5 USD a month, or Oracle Cloud free tier)**
```
sudo apt install -y nodejs npm
git clone <your repo> && cd hub && npm install
PORT=8080 PUBLIC_URL=https://queue.example.com node server.js
```
Put Caddy or nginx in front for HTTPS; WebSockets need the usual upgrade
headers (Caddy does it automatically: `reverse_proxy localhost:8080`).

## Connect a speaker PC

On the speaker PC open `http://localhost:3010`, Host controls (PIN), **Online
hub**: enter `wss://<your-hub-host>/agent` (use `ws://` if the hub has no
HTTPS), a room name such as `Office`, and a secret key. Save. The status line
shows the room's public page, for example `https://<hub>/r/Office/`.

The same can be done with `config.json` next to the exe:
```json
{ "hubUrl": "wss://queue.example.com/agent", "room": "Office", "roomKey": "secret" }
```
or environment variables `HUB_URL`, `ROOM`, `ROOM_KEY`.

The first PC to register a room name owns it; the key protects it from being
taken over. Anyone with the room link can add songs; host actions still need
the host PIN of that PC.

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` | room picker |
| `/rooms` | JSON list of rooms |
| `/r/<room>/` | queue page for a room (same page as on the LAN) |
| `/r/<room>/api/*` | relayed to the room's speaker PC |
| `/r/<room>/api/events` | live updates (Server-Sent Events) |
| `/agent` | WebSocket for speaker PCs |
| `/health` | status JSON |

Env: `PORT` (3020), `PUBLIC_URL`, `DATA_DIR` (where `rooms.json` is kept).
