# Speaker Queue (BT Speaker Pooler)

A shared YouTube queue for one Bluetooth speaker. The PC connected to the
speaker runs `SpeakerQueue.exe`; everyone else on the same Wi-Fi opens a web
page, searches a song and votes. Songs play one after another through the
speaker in priority order. Audio only, no video.

Playback happens on the host PC with VLC: yt-dlp resolves the audio stream of
each YouTube video and a hidden VLC plays it to the Windows default output
device (your boAt Stone Pro). No browser tab, no YouTube embed, works with a
VPN on.

## Quick start on a new PC

1. Copy the `dist` folder anywhere on the PC (for example `C:\SpeakerQueue`).
2. Connect the Bluetooth speaker and make it the default output device.
3. Double-click `SpeakerQueue.exe`. The first run sets everything up:
   - asks once for admin rights to add the Windows Firewall rule (click **Yes**)
   - downloads yt-dlp (and Deno, used by yt-dlp for YouTube) into `bin\`
   - installs VLC through winget if it is missing (approve if asked)
   - adds a shortcut to the Startup folder, so it runs after every login
4. A console window stays open. Within seconds it prints the room's link on
   the online hub, for example `https://<hub>/r/LAPTOP-NAME/`. Open that link
   on any device, expand **Host controls**, enter the PIN `1234` and change
   it. Nothing needs to be opened on the speaker PC itself; its own page
   `http://localhost:3010` keeps working as the Wi-Fi fallback.

Windows SmartScreen may warn "unknown publisher" the first time. Click
**More info -> Run anyway**. The exe is just Node.js with this program inside.

To stop auto-start, run `Remove from Startup.bat` (or
`SpeakerQueue.exe --remove-autostart`). To run without adding the shortcut,
start with `SpeakerQueue.exe --no-autostart`.

## Fully automatic after power-on (server PC sits far away)

Three pieces make the PC come up playing without anyone touching it:

1. **Auto sign-in.** Windows must log the user in by itself, otherwise nothing
   starts. Run `enable-autologin.bat` once (asks for admin): untick "Users must
   enter a user name and password" in the window it opens and type the password.
   Also set Settings → Accounts → Sign-in options → "require sign-in again" to
   **Never**.
2. **Auto start.** The exe adds itself to the Startup folder on first run, so it
   launches right after sign-in (minimised).
3. **Never sleep.** The one-time admin step of the exe also sets: no sleep, no
   hibernate, lid close does nothing. The firewall rule is added in the same
   prompt.

If the PC is a laptop, keep it on the charger. Set the BIOS to power on after a
power cut if the building loses power often ("AC power recovery" / "Restore on
AC power loss").

## Bluetooth speaker from any device

The page has a **Bluetooth speaker** card at the top with a **Connect** button.
Anyone on the Wi-Fi can press it; the host PC then connects to the speaker
through the Windows Bluetooth API (takes 5 to 15 seconds) and VLC switches to
it automatically.

- The speaker must be **paired once** with the host PC in Windows Settings →
  Bluetooth & devices. Do that at setup time. Nothing else is needed later.
- The host picks which paired device is "the speaker" under Host controls →
  Speaker settings. On the first run the server picks the connected audio
  device by itself.
- **Auto-connect** (on by default): every minute the server checks and, if the
  speaker is on and not connected, connects it. So in the morning somebody only
  switches the speaker on; it will be connected within a minute.
- If someone else's phone grabbed the speaker, the connect fails. The boAt
  holds one connection: disconnect it from the phone, then press Connect.
- **Disconnect** (host controls) releases the speaker on purpose and pauses
  auto-connect until the next Connect.
- If Bluetooth on the host PC is switched off, Connect switches it on first.

Tip: tell people not to pair their own laptops with the speaker any more.
Everything goes through the queue page now.

## Online hub: use the queue from anywhere and pick a room (recommended)

Instead of everyone being on the same Wi-Fi, you can host a small "hub" site.
Each speaker PC connects out to the hub and registers a **room** (for example
"Office", "Hall"). People open the hub's address from anywhere, pick the room,
and get the same queue page, including the Bluetooth Connect button. No
firewall rule and no IP problem, because the speaker PC makes the connection
outward. Searching and playing still happen on the speaker PC.

```
  phones / laptops (anywhere)  --->  hub site (cloud)  <---  SpeakerQueue.exe on speaker PC(s)
                                      /r/Office/              room "Office"
                                      /r/Hall/                room "Hall"
```

The exe has a hub built in (`hub-default.json` at build time, currently
`wss://bluetooth-speaker-pooler.onrender.com/agent`). On its first start a
speaker PC joins that hub by itself as a room named after the PC, with a
generated key, and prints the room link. From then on the host does
everything from the room page on any device:

- **Host controls → Host PIN**: change the default `1234` first.
- **Host controls → Online hub**: rename the room (for example `Office`), set
  your own key, point the PC at another hub, or leave the address empty to
  switch the hub off. A blank key keeps the current one. Renaming moves the
  room; the page follows to the new link.

Everything is stored in `config.json` next to the exe (`hubUrl`, `room`,
`roomKey`, `adminPin`). `"hubUrl": ""` means hub off; a missing `hubUrl`
means the built-in default. Environment variables `HUB_URL`, `ROOM`,
`ROOM_KEY` override the file. Copy `config.json` to a new PC to move a room.
Never commit it: the key is what stops another PC from taking the room name.

To run your own hub, deploy the `hub` folder (see `hub/README.md`; the
`render.yaml` in this repo makes Render one click) and either rebuild with
`BUILD_HUB_URL=wss://your-hub/agent node build.js` or set `hubUrl` on each PC.

The LAN address keeps working at the same time.

## How others connect on the LAN, and the changing-IP problem

Everyone must be on the same Wi-Fi / LAN as the host PC. They open any of
these in a browser, nothing to install:

| Address | Notes |
| --- | --- |
| QR code in the **Share** section | easiest for phones, regenerated live |
| `http://laptop-816sscf4.local:3010` | **permanent**: uses the PC name, survives IP changes (Windows, Android, iPhone, Mac all resolve `.local`) |
| `http://LAPTOP-816SSCF4:3010` | same idea, works from Windows PCs |
| `http://192.168.1.15:3010` | current IP, may change after a reconnect |

The PC name is printed in the console and shown in the Share section, so on
the new PC it will be that PC's name. To make the IP itself permanent too, give
the PC a fixed address in the router's DHCP reservation settings. The host page
re-reads the addresses every minute, so the QR is always current.

Checks when someone cannot connect:

- Host PC can open `http://localhost:3010` but others cannot: the firewall
  rule is missing. Run `allow-firewall.bat` as administrator, or restart the
  exe and accept the admin prompt.
- Wi-Fi network is set to **Public** in Windows: change it to Private
  (Settings -> Network & internet -> Wi-Fi -> network -> Private).
- Guest networks often isolate devices from each other. Use the normal Wi-Fi,
  or turn on Windows Mobile hotspot on the host PC and let everyone join it.
- The host's VPN does not block LAN traffic unless its kill switch is on.

## Using the page

- First visit asks for a name, once.
- Type a song name (or paste a YouTube link), press Search, tap a result.
- Vote 👍 on queued songs to move them up.
- Each person can have 3 songs waiting; adding a song already queued becomes
  a vote; you can remove only your own songs.

Queue order: host bumps first, then more votes, then earlier added. The next
song is pre-resolved while the current one plays, so there is no gap.

## Host controls

On the queue page, expand **Host controls**, enter the PIN (default `1234`).
You get Play / Pause / Skip / Clear queue / Volume, ⬆ on a song to play it
next, ✕ to remove any song, ↻ to replay from history.

Change the PIN under **Host controls → Host PIN** (4 to 8 digits). It is
stored as `adminPin` in `config.json`. Other devices must unlock again with
the new PIN (the browser-mode `/player` page too). Starting with the
`ADMIN_PIN` environment variable overrides and locks the PIN, so the page
cannot change it. Bluetooth **Disconnect** needs the PIN; **Connect** does not.

## Running from source instead of the exe

Needs Node.js 18+, VLC, and yt-dlp (`python -m pip install --user -U yt-dlp`,
or let the server download `bin\yt-dlp.exe` itself). Then `start.bat` or
`node server.js`. Build the exe with `build.bat` (needs internet once for the
`postject` helper). `BUILD_HUB_URL` overrides the hub address embedded from
`hub-default.json`.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | HTTP + Server-Sent Events server, queue logic, VLC control, yt-dlp, first-run setup |
| `public/index.html` | Queue page for everyone (search, add, vote, share QR, host controls) |
| `public/qr.js` | Dependency-free QR encoder for the Share section |
| `public/player.html` | Browser-mode player page (fallback when VLC is unavailable) |
| `public/style.css` | Styling for the player page |
| `bluetooth.ps1` | Windows Bluetooth helper (list / connect / disconnect / radio on), embedded in the exe |
| `hub-default.json` | The hub address built into the exe (URL only, never a key) |
| `config.json` | Per-PC settings written by the app: hub, room, room key, host PIN. Next to the exe; never commit it |
| `hub/` | The online hub (relay site) and its own README |
| `enable-autologin.bat` | One-time helper to make Windows sign in automatically |
| `build.js` / `build.bat` | Produce `dist\SpeakerQueue.exe` |
| `start.bat` | Run from source (adds firewall rule, stops old copies) |
| `allow-firewall.bat` | Manual firewall rule (run as admin) |
| `update-ytdlp.bat` | Update the pip-installed yt-dlp |
| `queue.json` | Auto-saved queue, now playing and history (next to the exe) |
| `bin\` | yt-dlp.exe and deno.exe, downloaded on first run; yt-dlp self-updates weekly |

Environment variables: `PORT` (3010), `ADMIN_PIN` (1234), `PLAYER` (vlc or
browser), `MAX_PENDING_PER_USER` (3), `VLC_PATH`, `VLC_PORT` (PORT+5080, local
only), `YTDLP`, and `NO_FIREWALL`, `NO_DENO`, `NO_VLC_INSTALL`, `NO_AUTOSTART`
to skip setup steps.

## API (for curiosity or scripting)

| Method | Path | Body | Who |
| --- | --- | --- | --- |
| GET | `/api/state` | | anyone |
| GET | `/api/share` | addresses and hostname | anyone |
| GET | `/api/events` | SSE stream of `state` and `cmd` events | anyone |
| POST | `/api/search` | `{q}` song name or link, returns up to 8 results | anyone |
| POST | `/api/add` | `{url, user}` (url may be a bare video id) | anyone |
| POST | `/api/vote` | `{id, user}` toggles your vote | anyone |
| POST | `/api/bt` | `{action, pin?}` connect, disconnect or refresh the Bluetooth speaker | anyone; disconnect needs the host PIN |
| POST | `/api/remove` | `{id, user, pin?}` | owner or host |
| POST | `/api/admin` | `{pin, action, id?, value?, name?}` actions: `check skip pause play volume bump unbump clear replay speaker autoconnect hub pin` | host |
| POST | `/api/player/status` | `{pin, position, duration, paused, volume}` | browser mode only |
| POST | `/api/player/ended` | `{pin, id, reason}` | browser mode only |

## Troubleshooting

- **"speaker offline" badge**: VLC is starting (give it 3 seconds) or VLC is
  not installed. The console shows `[vlc] started` when it is up.
- **Song marked "could not play" in history**: yt-dlp could not resolve it.
  Age restricted, private, or yt-dlp is outdated. The exe updates its own
  yt-dlp weekly; delete `bin\yt-dlp.updated` to force an update now.
- **Audio comes from laptop speakers**: Windows is not sending output to the
  Bluetooth speaker. Click the speaker icon in the taskbar and pick the
  speaker. VLC follows the Windows default device.
- **Song stalls while playing**: slow internet or VPN. VLC buffers 3 s; the
  server skips a song only if it never starts within 40 s.
- **Port 3010 is in use**: another copy is already running. Close the old
  console window first.

## Original request

> i have a bluetooth speaker, it is boat stone pro. currently my blue tooth is
> connected to it. currently 6-10 system is connected to bluetooth speaker. and
> everyone play song mostly from youtube. i want a pooling setup my system can
> act as a server. one site all system can access it and simply pool it. from
> every system a common setup where they can simply add a song from youtube then
> we will play it according to the priority. is it possible to implement
