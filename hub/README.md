# Speaker Queue Hub

The hosted meeting point. Speaker PCs (running `SpeakerQueue.exe`) connect
out to this site and register a room. People open the site from anywhere,
pick a room and get the normal queue page. The hub itself never plays or
downloads anything, it only relays, so the smallest instance is enough.

## Deploy

Any host that runs Node 18+ and allows WebSockets works. Three easy options:

**Render (free tier, good for trying it out)**
1. The repo already has a `render.yaml` blueprint at its root. On render.com:
   New → Blueprint → connect the GitHub repo → Apply. That creates a web
   service from the `hub` folder with the right build and start commands.
   (Manual alternative: New → Web Service, root directory `hub`, runtime Node,
   build `npm install`, start `node server.js`.)
2. Your hub address is `https://<service-name>.onrender.com`. Speaker PCs use
   `wss://<service-name>.onrender.com/agent`.
3. Free instances sleep after 15 min without web traffic; the first visit then
   takes about a minute to wake, and the speaker PC reconnects by itself.
   Room keys (`rooms.json`) are reset on each restart on the free plan, which
   only means the first PC to reconnect re-owns its room. For 24/7 and a
   persistent file, switch the plan to Starter and enable the disk block in
   `render.yaml` (`DATA_DIR=/data`).

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

Nothing to do when the exe was built for this hub (`hub-default.json` in the
repo root): on first start the PC joins by itself as a room named after the
PC, with a generated key, and prints the room link. Open that link on any
device, Host controls, PIN `1234` (change it), and rename the room under
**Online hub** if you like. The page follows the room to its new link.

For a hub the exe was not built for, either rebuild with
`BUILD_HUB_URL=wss://<your-hub-host>/agent node build.js`, or set it on the
PC: room page → Host controls → **Online hub** → `wss://<your-hub-host>/agent`
(`ws://` if the hub has no HTTPS), or a `config.json` next to the exe:
```json
{ "hubUrl": "wss://queue.example.com/agent", "room": "Office", "roomKey": "secret", "adminPin": "2468" }
```
or environment variables `HUB_URL`, `ROOM`, `ROOM_KEY`. `"hubUrl": ""`
switches the hub off. The key lives in `config.json`; copy the file to move a
room to another PC, and never commit it.

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
