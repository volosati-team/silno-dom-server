# HANDOFF — silno-dom-server (SILNO_DOM / MOiO panel)

Rebuild-from-zero handoff for whoever takes this project over next. This is a
map, not a duplicate of the existing docs — read it first, then follow the
pointers in section 9 for depth. Everything here was verified against the
actual source (`app.py`, `start.sh`, `mosquitto_open.conf`, `.env.example`,
the MQTT/DragonFly bridges, `panel/STATE_STABLE.md`) at handoff time; treat
any conflict between this file and the code as the code being right and this
file being stale.

## 1. Overview

This is the server + wall-tablet software for a single-house smart-home
install (residence "СИЛЬНО", Derbent). It controls physical relay-switched
lighting through a MOiO 3-channel WiFi relay (2 of 3 channels wired: `ch1` =
spot lights, `ch3` = light chain; `ch2` is not physically connected), serves
a kiosk-mode media panel on a wall tablet (SoundCloud / YouTube / Yandex
Music playback plus a growing set of tablet-control features — brightness,
Bluetooth, scheduling), and is in the early stages of adding an entrance
doorbell/camera integration (owned by a sibling repo, see section 7). There
is no single "app" — it's a small constellation of Python processes on one
Debian WSL host, coordinated through MQTT and a Redis-compatible KV store
(DragonFly), fronted by a tunnel for remote access.

The project has been built iteratively and fast, directly with the owner
(Андрей / "Андрей Ким"), often live while he's standing at the tablet. Expect
scattered decisions, some reverted commits, and dev/prod boundaries that are
looser than a normal product — see section 5 for the incident history before
you touch anything blindly.

## 2. Architecture

Everything runs as separate OS processes on **one WSL2 Debian instance**
hosted on a Windows machine (internally called **voloNuk**), started by
`start.sh` and supervised only by that script's own `pgrep`-based
idempotency checks (no systemd, no process manager). Restarts happen via a
Windows Task Scheduler entry (`VoloNuk_StartSilnoServer`) that runs
`bash start.sh` on Windows logon.

Services, in the order `start.sh` brings them up:

1. **Mosquitto** (MQTT broker) — `localhost:1883` (MQTT) and `:9001`
   (websockets). Config: `mosquitto_open.conf`. Anonymous clients are
   restricted by `mqtt_acl` to the `moio/#` namespace (this is how the MOiO
   relay connects — its firmware has no MQTT auth support); the authenticated
   `silnodom` user (bridge + web app) gets full `#` access.
2. **`home_mqtt_bridge.py`** — translates between MOiO's own topic
   namespace (`moio/moio3ch/{MAC}_ch{N}/devices.capabilities.on_off/on[/set]`)
   and a simpler internal namespace (`home/light/ch{N}/state` and
   `home/light/ch{N}/set`). This is the oldest, most stable piece — do not
   change its topic contract without checking every downstream consumer.
3. **DragonFly** — Redis-compatible in-memory KV, `127.0.0.1:6379`. This is
   the single command bus every UI/API talks to; nothing in the panel talks
   to MQTT or MOiO directly anymore. Keys are flat (`light:ch1:state`, not
   JSON blobs).
4. **`dragonfly_mqtt_bridge.py`** — the connector between DragonFly and MQTT.
   Panel writes `light:chN:cmd` and publishes on the `light:cmd:set` pubsub
   channel; this daemon consumes that and republishes to
   `home/light/chN/set`. In the other direction it subscribes to
   `home/light/+/state` over MQTT and writes `light:chN:state` back into
   DragonFly. **Important gotcha**: DragonFly (as deployed) does not support
   `notify-keyspace-events`, so this uses an explicit pubsub channel instead
   of keyspace notifications — that's a deliberate design choice, not a bug
   to fix.
5. **`web/app.py`** (FastAPI) — the original/legacy light-only dashboard
   (login, toggle switches, config, log pages). Kept running as a fallback;
   "do not touch" per the port map below.
6. **`panel/app.py`** (FastAPI) — the actual product: the kiosk media panel
   (SoundCloud/YouTube/Yandex Music, saved playlists, debug console, admin
   page, light control, scheduling, brightness). This is where almost all
   active development happens. Runs from **git worktrees**, not the main
   checkout directly — see section 3.
7. **`streaming/app.py`** (FastAPI) — a yt-dlp-based resolver that turns
   SoundCloud/YouTube/Yandex URLs into a direct audio stream URL, so the
   kiosk can play through a native HTML5 `<audio>` element instead of the
   (broken on this hardware) SoundCloud Widget iframe.
8. **`cloudflared`** (optional) — ephemeral `trycloudflare.com` quick tunnel,
   if installed. Its URL is scraped from the log and pushed into a Cloudflare
   KV namespace so a Cloudflare Worker (`workers/moio-control/`) can proxy a
   stable public URL to whatever the current tunnel URL is. This is a known
   weak point — see section 5 and section 8a.

### Port map

| Port | Service | Branch/worktree | Status |
|------|---------|-----------------|--------|
| 8080 | panel (stable) | `main`, via worktree `../silno-dom-server-stable` | primary — this is what the tablet points at |
| 8081 | web (legacy light dashboard) | `web/app.py`, main checkout | fallback, don't touch |
| 8082 | panel (dev/admin) | current dev checkout, whichever branch is active | dev + `/admin` page lives here |
| 8083 | streaming | main checkout | yt-dlp resolver, same-origin proxy from panel via `/api/stream/*` |
| 8084 | panel (logic/radio-discovery) | `logic-dev`, via worktree `../silno-dom-server-logic` | rolling out — worktree has to exist on voloNuk (`git worktree add ../silno-dom-server-logic logic-dev`) |

`start.sh` is defensive about all of this — every block checks `pgrep` first
and skips if already running, and it warns (does not fail) if a worktree
directory is missing.

## 3. Deploy from zero

Assume: a bare Windows host with WSL2 + Debian installed, and nothing else.

1. **Create the WSL user** the services run as: `mqtt-silno` (see
   `setup_wsl_user.sh` for the exact steps — creates the user, installs
   `mosquitto`, `python3`, pip deps).
2. **Clone the repo** to `/home/mqtt-silno/silno-dom-server` (this exact path
   is hardcoded in several places — `mqtt_acl`, `mosquitto_open.conf`,
   `scripts/silno_log.sh`, `README.md`). Cloning anywhere else means updating
   those paths.
3. **Create the two production worktrees** next to the main checkout (both
   are siblings of `silno-dom-server/`, not subdirectories):
   ```sh
   git worktree add ../silno-dom-server-stable main
   git worktree add ../silno-dom-server-logic logic-dev   # port 8084
   ```
   Without `../silno-dom-server-stable`, `start.sh` will **not** start
   anything on port 8080 — it just logs a warning and moves on. This is the
   single most common "why is the panel down" cause.
4. **Copy `.env.example` to `.env`** and fill it in. Required/important vars:
   - `WEB_PORT` (default 8081), `HOME_HOST`/`HOME_PORT` (Mosquitto,
     `localhost:1883`), `MOIO_MAC` (the relay's MAC, currently
     `782184803ce4` — read off the relay via the MOiO app when it's paired).
   - `PASS_VOLOSATI` / `PASS_MAX` / `PASS_GUEST` — legacy web-dashboard login
     passwords. Currently all `12345` (dev-only, see section 5).
   - `MQTT_USER` / `MQTT_PASS` — must match whatever's in `mqtt_passwords`
     (see step 5).
   - `CF_API_TOKEN` / `CF_ACCOUNT_ID` — optional, only needed if you want
     `start.sh` to auto-push the tunnel URL into Cloudflare KV.
   - `GITHUB_VOLOSATI_TOKEN` — a GitHub PAT. **Required on any host where git
     has no saved credentials** (this is voloNuk's WSL guest by default —
     see the git-auth incident in section 5). `start.sh` and `update.sh` both
     use it to rewrite `origin` to an HTTPS URL with embedded credentials if
     it's set.
   - Not in `.env.example` but referenced elsewhere: `YOUTUBE_API_KEY` (YT
     Data API search), `AG_BRIDGE_SECRET` (remote exec bridge token, see
     section 8a) — both need to be added manually to `.env` (or Windows env
     vars, per historical notes) before those features work.
5. **Mosquitto password file** — `start.sh` auto-creates
   `mqtt_passwords` from `MQTT_USER`/`MQTT_PASS` on first run via
   `mosquitto_passwd -c -b`, if the file doesn't exist yet. Not automated:
   the `mqtt_acl` file itself (already checked into the repo, should not need
   editing) and any TLS setup (there is none currently — plain MQTT, see
   section 5 pre-prod checklist).
6. **DragonFly** — `start.sh` just execs `dragonfly --bind 127.0.0.1 --port
   6379 --dir /tmp` if it's not already running. DragonFly itself has to be
   installed separately beforehand — check `ARCHITECTURE_NOTES.md` for the
   install path and confirm it's current before relying on it. State lives
   in `/tmp` by default, i.e. **it does not survive a host reboot** unless
   you change `--dir` to something persistent — there is no
   migration/backup step for this in `start.sh`.
7. **Windows-side setup done by `start.sh` itself** (idempotent, runs with
   the elevated Task Scheduler context): opens firewall port 8080 inbound,
   opens firewall port 3128 (tinyproxy, used as a LAN media proxy for the
   tablet — believed related to regional content-blocking workarounds),
   removes stale `netsh portproxy` entries (WSL2 mirrored networking makes
   these unnecessary and they break things if stale), and starts `tinyproxy`
   via a PowerShell script on the Windows host if it isn't running.
8. **Run it**: `bash start.sh`. It is safe to re-run — everything it starts
   is guarded by a `pgrep` check first.
9. **Auto-update loop** — `start.sh` also backgrounds a loop that does
   `git fetch origin` every `AUTOUPDATE_INTERVAL` seconds (default 300) and,
   if HEAD has drifted from the tracked branch's origin ref, runs
   `update.sh` (which pulls, pulls the worktrees too, kills all the uvicorn
   processes + mosquitto + cloudflared, and re-runs `start.sh`). This is
   convenient but has bitten the project before when git credentials weren't
   configured (silent no-op fetch, see section 5) — verify `git fetch`
   actually reaches GitHub after any host-level change.

**What's explicitly NOT automated**: initial DragonFly install, initial
Mosquitto install, TLS/HTTPS anywhere, secret rotation, and — critically —
git credentials for whichever user runs `start.sh` non-interactively if you
don't set `GITHUB_VOLOSATI_TOKEN`. `git pull` from a cron-like context with
no stored credentials just fails silently; there's no alerting on it.

## 4. Tablet & debug panel

**Hardware**: a wall-mounted touchscreen — referred to in the docs as both
"iiyama" and a "Xiaomi-OUI device" (same physical unit, `192.168.31.85` on
the LAN) — running **Android 8.1** with **Bromite v108** as the kiosk
browser. This is old, low-power hardware with real limits: no Web Bluetooth
API, no OS-level brightness/volume control from the browser, autoplay
policies that must be manually flipped in `chrome://flags`
(`#autoplay-policy = No user gesture is required` — without this neither the
SoundCloud nor YouTube iframes will autoplay). App-pinning is currently the
manual workaround for keeping the browser locked to the panel URL; a real
kiosk-lock/auto-launch/wake-lock setup is still on the roadmap (see
`panel/FEATURES.md`).

**In-page debug console.** Because there's no F12/devtools access on the
kiosk browser, the panel ships its own console overlay:
`_lisaConsoleEnabled()` / `_lisaSetConsoleEnabled()` / `_lisaToggleConsole()`
(all defined in `panel/static/app.js`) toggle an on-screen pane that captures
`console.*`, `window.onerror`, unhandled promise rejections, and `fetch`
calls. It's hidden by default, toggled from the hamburger menu
(`#menu-console-toggle`) for logged-in users, and lays out as a side pane in
landscape / bottom pane in portrait.

Every captured entry is also shipped server-side:
- `POST /api/dbg-log` — the client posts a batch of entries (JSON body:
  timestamp, user-agent, URL, and the entries array); stored in SQLite
  (`panel/data/panel.db`, table `dbg_log`).
- `GET /api/dbg-log/recent` — last 30 entries, newest first. This is the
  primary way to see what actually happened on the tablet without physical
  access — `scripts/silno_log.sh` wraps this over the remote-exec bridge
  (see section 8a) for pulling logs from outside the LAN.

**Bluetooth agent APK.** Bromite has Web Bluetooth disabled, so there is no
way to toggle the tablet's Bluetooth from the browser. The workaround is a
small standalone Android app (`android/bt-agent/` — plain Java, Gradle
project, an HTTP server, no external dependencies) that runs as a foreground
service and listens on `localhost:8765`. The panel's Bluetooth toggle (when
present in the UI) calls `http://localhost:8765/bt-toggle` directly from JS.
Check `panel/STATE_STABLE.md` for the current install status on the
physical tablet before assuming it's live — this has flipped between
"built" and "installed" across sessions. A debug APK
(`panel/static/bt-agent-debug.apk`) is checked into the repo and
downloadable from the tablet via the `/admin` page or a menu link. If you
install it: confirm the notification shade shows the agent listening on
:8765, and watch for MIUI-style battery optimization killing the service —
it needs to be exempted plus set to auto-start, or it won't survive a
tablet reboot.

## 5. Known issues / why it lags

- **Brightness-filter compositing bug — fixed.** Setting
  `document.documentElement.style.filter = 'brightness(X%)'` (plus a CSS
  `transition: filter` on `<html>`) created a new compositing context on
  Android Chromium. Every `position: fixed` descendant lost correct
  viewport positioning and touch stopped landing where it visually appeared.
  Fix: replace the `html { filter }` approach with a dedicated
  `#dim-overlay` — a `position: fixed; pointer-events: none` div with an
  `rgba(...)` background, alpha computed as `(100 - brightness) / 100`.
  **Rule going forward: never apply `filter` to `<html>` or `<body>`.**
- **MQTT state polling instead of push — open.** The browser currently polls
  `/state` a few times right after a toggle (0.5s/1.0s/1.5s) then falls back
  to a plain 5-second poll loop. The intended fix (documented, not built) is
  Server-Sent Events or WebSocket so MQTT state changes push straight to the
  browser.
- **WSL2 loopback `curl` returns 502 — false negative, not a real outage.**
  From inside the WSL guest (with the Throne VPN tunnel active), `curl
  127.0.0.1:<port>` or `curl 192.168.31.50:<port>` can return `HTTP/1.1 502
  Bad Gateway` even though the service is up and reachable fine from any
  external LAN client. Diagnose with `pgrep` and the service's own logs, not
  self-curl.
- **iOS Safari LAN access — deferred, not fixed.** Both `silno.local` and
  `192.168.31.50:808{0,1}` time out specifically from iPhone Safari; every
  other LAN client (Android, desktop) works fine. Likely a VLAN /
  Private-Address / cleartext-HTTP interaction. Owner explicitly deferred
  this — revisit after the HTTPS migration lands, not before.
- **Git auto-update credential gotcha.** `git fetch origin` run
  non-interactively as the service user (`mqtt-silno` in WSL) silently does
  nothing if that user has no stored git credentials — no error, the
  auto-update loop just never finds new commits. Set
  `GITHUB_VOLOSATI_TOKEN` in `.env` (both `start.sh` and `update.sh` will use
  it to rewrite the remote URL with embedded credentials), or run `git
  config --global credential.helper store` + one interactive `git pull` as
  that user to seed `~/.git-credentials`.
- **Cloudflare tunnel URL goes stale on rotation — open, tracked as
  `lisa-core#421`.** The `moio-control` Cloudflare Worker's backend URL is
  read from Cloudflare KV, which `start.sh` updates whenever `cloudflared`
  hands out a fresh ephemeral `trycloudflare.com` URL. If `cloudflared`
  restarts (or the tunnel drops) between deploys, the Worker keeps
  forwarding to a dead URL until the KV value is refreshed. Recommended fix
  (not yet done): move to a named persistent Cloudflare tunnel, or drop
  Cloudflare entirely in favor of the Tailscale Funnel path (see 8a), which
  doesn't have this rotation problem.

## 6. MQTT & DragonFly

**MQTT topics** (all through the local Mosquitto broker):

```
moio/moio3ch/{MAC}_ch{N}/devices.capabilities.on_off/on        MOiO → bridge  (device state)
moio/moio3ch/{MAC}_ch{N}/devices.capabilities.on_off/on/set    bridge → MOiO  (command)
home/light/ch{N}/state                                          bridge → panel (internal state, retained)
home/light/ch{N}/set                                            panel → bridge (internal command)
```
`{MAC}` is the relay's MAC (`782184803ce4` in `.env.example`), `{N}` is
1 or 3 (2 is unused — no relay wired to that channel). `home_mqtt_bridge.py`
owns this translation and republishes retained state periodically as a
heartbeat.

**DragonFly keys** (flat strings, not JSON — this is a deliberate
convention, keep following it):

```
light:ch1:state / light:ch3:state   current confirmed device state ("true"/"false")
light:ch1:cmd   / light:ch3:cmd     last commanded value (audit/last-value)
light:cmd:set                        pubsub channel — payload "chN:true|false", the actual trigger
```
`dragonfly_mqtt_bridge.py` is the only thing that reads `light:cmd:set` and
the only thing that writes `light:chN:state`. If you add a new device, wire
it the same way: a connector script that subscribes to its own channel and
writes its own state key, not a shared blob (see section 8b — this is the
"invariant" the panel docs are strict about).

Manual poke for testing, since DragonFly here has no working keyspace
notifications:
```sh
redis-cli PUBLISH light:cmd:set ch1:true
```
`SET`-ing the key directly does **not** trigger anything downstream — only
the pubsub channel does.

## 7. API surface & adding new devices

**Current light REST API** (served by `panel/app.py` on :8080, no auth —
see section 5's pre-prod checklist for why that's currently accepted):

```
GET  /api/light/state           -> {"ch1": bool, "ch3": bool}
POST /api/light/set   {"ch1": bool, "ch3": bool}   (null = leave channel alone)
POST /api/light/toggle {"ch": "ch3"}   -> {"ch": "ch3", "cmd": "on"}
```
Commands go panel → DragonFly (`light:cmd:set` PUBLISH) → MQTT → MOiO relay;
expect 1-3 seconds of round-trip before `/api/light/state` reflects it.
Older/parallel light dashboard on :8081 (`web/app.py`) exposes the same
shape (`/state`, `/set`, `/toggle`) as a fallback UI — don't remove it, it's
the "everything else is on fire" light switch.

**Worked example of adding a new external device: the doorbell/camera.**
This is being built in a **separate, sibling repo**,
`silno-dom-gate-repo`/`silno-dom-gate` (GATE owns the entrance camera,
recognition, and relay/open path; this panel repo only owns the tablet-side
overlay). It has not been merged into this panel yet — treat it purely as
the reference pattern for "how the next device gets integrated," documented
in `panel-doorbell-contract.md` in that repo:

- GATE runs its own small FastAPI service (a fake/MVP demo stand-in before
  real ESP32-CAM hardware exists) and publishes typed events to a DragonFly
  pubsub channel, `doorbell:event`, plus session state under
  `doorbell:session:<id>` and `doorbell:active` — same DragonFly-as-command-
  bus pattern as light, new channel and keys per device, no shared blob.
- GATE exposes a narrow local HTTP API for commands (`POST
  /api/door/open`, `POST /api/door/end`, `GET /api/door/active`, `GET
  /api/door/events`, plus device-ingest endpoints like `POST
  /api/device/doorbell/ring` for the ESP32 firmware).
- Panel's job in this pattern is UI only: subscribe/poll the event surface,
  duck media, show a full-screen overlay with a browser-playable video
  stream (MJPEG preferred for this old-Android hardware — no raw RTSP to the
  tablet), and forward operator taps (`Open`/`End call`) back to GATE's
  command API. Panel never does recognition or access decisions — that stays
  in GATE.
- The contract doc explicitly requires each side to update it (not memory,
  not chat) whenever the event schema or API surface changes, and requires
  both topics to agree in Telegram before a breaking change.

**Generic pattern for the next device you add** (there is no framework for
this yet — see section 8b): new MQTT/hardware layer if needed → its own
DragonFly pubsub channel + state keys → its own narrow local HTTP API if the
UI needs commands, not raw hardware protocol → a UI overlay or button that
consumes only that API. Follow the doorbell contract's shape even for
things that aren't cameras.

## 8. Open roadmap (not yet implemented)

Read this section as a to-do list handed to you, not as a status report.
Nothing here is done.

**(a) VPN-on-tablet with auto key-pull.** Proposed idea, not built: give the
tablet (or the panel host) a VPN client that pulls its connection key
automatically from a URL/address rather than manual provisioning. This does
not exist today. **Current remote-access reality**, for context: outbound
remote access to the voloNuk host goes through a **Tailscale Funnel**
endpoint (`volonuk.tailf820d5.ts.net`) backed by a local `http_exec_bridge`
service, gated by a shared secret, `AG_BRIDGE_SECRET` (stored in `.env`, in
Windows env vars on voloNuk, and mirrored in the workspace secrets store —
rotate all three places together, never just one). `scripts/silno_log.sh` is
the reference client for this bridge. Separately, the **Cloudflare
quick-tunnel** path (`cloudflared` → `trycloudflare.com` → Cloudflare Worker
reading the current URL from KV) has a known stale-URL bug on tunnel
rotation, tracked as **`lisa-core#421`** — do not treat it as reliable
remote access until that's fixed or replaced.

**(b) Generic external-device registration.** There is currently **no
mechanism** for onboarding a new device (entrance camera, a future sensor,
anything else) without hand-wiring it: today that means manually adding an
MQTT subscription (if it needs one), a DragonFly key/channel mapping, and a
UI button/overlay, one at a time, in whatever files happen to touch that
area. The doorbell integration contract in `silno-dom-gate-repo` (section 7
above) is the closest thing to an established pattern — new team should
either formalize that pattern into a real "connector" abstraction, or at
minimum keep replicating its shape (own channel, own keys, own narrow HTTP
API, UI never touches raw hardware/MQTT) for anything new.

Also still open from the existing docs, worth carrying forward: HTTPS
termination before any Docker migration (section 5's pre-prod checklist in
`panel/FEATURES.md` is the authoritative list — SSH key-only auth, MQTT over
TLS, secrets out of `.env` and into a real secret store, bearer tokens on
write endpoints, named Cloudflare tunnel or drop public exposure, full
`12345`-password audit before any of this goes beyond a single LAN); tablet
kiosk lock/auto-launch/wake-lock; a real external Bluetooth-receiver audio
path (parallel to, not replacing, in-browser playback); and the `:8084`
radio/discovery layer (`logic-dev` branch) getting a stable production
worktree on voloNuk.

## 9. Where to look next

This file is a map. For the actual depth, go to:

- **`README.md`** (repo root) — architecture diagram, `.env` variable
  reference, current dev credentials, MQTT security notes, full light REST
  API reference.
- **`ARCHITECTURE_NOTES.md`** — the original decision log for why DragonFly
  was introduced as the command bus and the key-naming scheme.
- **`panel/FEATURES.md`** — the authoritative feature roadmap: done / in
  progress / required-but-not-built / open-ideas / deferred, plus the
  pre-prod security checklist and the architecture invariants (DragonFly as
  the only command bus, panel vs. audio-layer independence, English-only
  code convention, merge policy for `panel/` vs `web/`).
- **`panel/STATE_STABLE.md`** — the session-by-session deploy log: exact
  commits deployed vs. not-yet-deployed on voloNuk at various points, the
  brightness incident write-up in full, BT Agent deployment status, port map
  history. This is the closest thing to a "what actually happened" ledger
  and is worth skimming in full before making changes near the tablet.
- **`panel/AGENT_LIGHT_API.md`** — the external-agent-facing version of the
  light REST API (same endpoints as section 7 here, written for a third-party
  agent audience, includes the LAN-only IP caveat and troubleshooting steps).
- **`panel/NOTES_migration.md`** — the host-migration checklist (which
  credentials rotate, which don't, what to re-test) — read this before
  moving off voloNuk to different hardware.
- **`silno-dom-gate-repo/panel-doorbell-contract.md`** and its `README.md` —
  full doorbell/camera contract and the fake demo service, for when the
  camera integration actually starts landing in this repo.
