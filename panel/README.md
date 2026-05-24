# silno-dom panel

Local FastAPI process that serves the media panel UI (music + future media
controls) and the small REST surface that used to live in a Cloudflare Worker
(`automation/webapp/worker.js`).

Runs as a second isolated process next to the light-control server
(`web/app.py` on port 8080), on its own port so a crash in one process does
not bring down the other.

## Run

```sh
pip install -r panel/requirements.txt
uvicorn panel.app:app --host 0.0.0.0 --port 8081
```

## Env vars

None required. The app uses on-disk SQLite at `panel/data/panel.db` (auto-
created on first start). Tweak the cleanup cadence via the
`CLEANUP_INTERVAL_SEC` constant in `app.py` if needed.

## Storage

- `panel/data/panel.db` — SQLite (WAL mode).
  - `kv(key, value, expires_at)` — TTL-able key-value store used for guest /
    SC PKCE / token sessions and the shared `saved_playlists` blob.
  - `dbg_log(id, ts, ua, url, entries)` — append-only client debug log.

A background task evicts expired `kv` rows every 60 seconds; `kv_get` also
lazy-deletes expired rows on read.

## Endpoints

Static:
- `GET /` — `index.html`.
- `GET /guest` — `guest.html`.
- `GET /manifest.json`, `GET /icon.svg`, `GET /app.css`, `GET /app.js`.
- `GET /static/...` — full static directory (nested assets).

API (all under `/api/*`, CORS `*`):
- `POST /api/guest-session` — create a guest session, returns `{session_id}` (TTL 600s).
- `POST /api/guest-submit` — `{session_id, url}`, stages a URL for the tablet (TTL 60s).
- `GET  /api/guest-poll?session=...` — tablet poll; returns `{url}` once, or `null`.
- `GET  /api/resolve-url?url=...` — follow redirects, returns `{url: resolved}`.
- `GET  /api/oembed?url=...` — oEmbed proxy for SoundCloud / YouTube / Spotify.
- `POST /api/sc-session` — store PKCE `{session_id, client_id, verifier, challenge}` (TTL 300s).
- `GET  /api/sc-poll?session=...` — returns stored token JSON once, or `null`.
- `POST /api/sc-token` — proxies the SC OAuth token endpoint.
- `GET  /sc-auth?session=...[&code=...]` — SC OAuth dance; on success stores `token:{sid}` and renders the success page.
- `GET  /api/saved-list` — returns the shared playlists JSON array (`[]` default).
- `PUT  /api/saved-list` — replace the shared playlists JSON array (JSON-validated).
- `POST /api/dbg-log` — append a client debug-log entry.
- `GET  /api/dbg-log/recent` — last 30 entries, newest first.
- `GET  /healthz` — `{ok: true, service: "panel"}`.

## TODO

- **Switch to HTTPS before docker migration.** Currently the panel serves over plain HTTP on `:8081`. Before containerising this service, terminate TLS in front of it (e.g. Caddy or nginx in the same compose stack) so all media-panel traffic is encrypted at the LAN edge. Required for token-auth, SC OAuth, and future Yandex/Spotify integrations that may refuse cleartext callbacks.

- **BT disconnect button (Android APK).** Tablet Bluetooth (Xiaomi kiosk, Android 8.1) cannot be controlled from Bromite (Web Bluetooth API disabled). Plan: minimal background APK with NanoHTTPD server on `localhost:8765`; panel JS calls `GET /bt-pause` → APK disconnects connected BT devices → after 10s reconnects. Requires `BLUETOOTH_ADMIN` permission. Alternative if Termux is installed: `termux-bluetooth` API. Button location: hamburger menu, zone ГАМБАР.

- **WiFi точка у ворот (физика, завтра).** Установить AP в зоне ворот/входной двери для покрытия ESP32-CAM и прочих устройств у входа.

- **ESP32-CAM doorbell** → `projects/silno-dom-security/` (основной проект). ESP32-CAM на входной двери. Звонит НЕ на телефон, НЕ в Telegram. Только на планшет (панель). При нажатии кнопки: музыка стопается, играет звонок, всплывает overlay с RTSP-трансляцией камеры + кнопка «Открыть дверь». Протокол: ESP32 → MQTT `home/door/bell` → сервер → WebSocket/SSE → панель JS overlay. RTSP-поток подключается к lokalnому компу (voloNuk) параллельно для распознавания лиц: если свой → авто-открытие двери без звонка. Завтра ставим железо + WiFi точку у ворот.

- **Screen brightness + volume/playback controls.** Tablet (Android 8.1 kiosk) brightness and system volume cannot be set from Bromite. Same path as BT — requires APK or ADB. Panel JS can expose sliders/buttons but the actual OS call needs a local agent (Termux or custom APK). Design: sliders appear in the hamburger menu or in the controls bar. Playback control (play/pause/next) already works via panel JS; volume/brightness need Android layer.

- **Solar schedule.** Extend the light timer with sunrise/sunset data for Derbent (lat 42.05, lon 48.29). Use `suntime` or `astral` Python package to compute today's dawn/dusk times; substitute them as virtual schedule entries alongside fixed-time entries. UI: "по закату" / "по рассвету" option per entry instead of fixed time. Illuminance sensor (when hardware arrives) can further refine the on/off threshold.

- **Light timer (schedule).** Clock button in hamburger menu opens a schedule panel. Default schedule stored in SQLite KV, editable from UI:
  - 19:00 — ch1 (споты) ON
  - 19:15 — ch3 (гирлянда) ON
  - 00:00 — ch1 OFF
  - 00:15 — ch3 OFF
  Backend: APScheduler background task in panel app; reads schedule from `kv` table (`key=light_schedule`); fires internal `/api/light/set` calls. Future extension: motion sensor trigger (hardware not yet available). When motion fires during a scheduled off-window → defer turn-off by 10 min; each new trigger resets the timer.

- **Remote media control (pause / volume).** Во дворе проходят переговоры/созвоны — нужна возможность для агентов и людей управлять панелью удалённо без физического доступа к планшету: поставить на паузу, сделать тихо, убрать совсем. План: единый endpoint `POST /api/media/cmd` с телом `{"cmd": "pause"|"resume"|"volume", "level": 0-100}` → пишет KV-флаг в DragonFly (`media:cmd`) → панель JS читает через SSE или short-poll каждые 2с → вызывает `scPlayPause()` / `scSetVolume(N)`. Агент (queue_runner task type `media_cmd`) или любой HTTP-клиент на LAN/bridge дёргает эндпоинт.

## Status (2026-05-21 22:00 MSK)

Layered architecture, both layers are mandatory and independent.

### Layer 1: control + UI (this repo) — WORKING

- DragonFly KV at 127.0.0.1:6379 as the central command bus.
- `dragonfly_mqtt_bridge.py` translates `light:chN:cmd` PUBLISH events into MQTT `home/light/chN/set` and writes back `light:chN:state` from MOiO MQTT replies.
- Panel FastAPI on 8080 (main) exposes `/api/light/{state,set}` over DragonFly; serves the kiosk UI.
- Legacy Jinja light dashboard on 8081 (web/app.py) — kept as fallback, untouched.
- Light works from phone, tablet, and any LAN client (verified end-to-end through MOiO).

### Layer 2: audio streaming — DEFERRED, mandatory

The panel renders the SoundCloud / YouTube widgets but cannot reliably play audio on the iiyama kiosk (Xiaomi-OUI device on `192.168.31.85`). Bromite v108 on this hardware loads the SC Widget iframe, `widget.load()` returns, the post-load callback fires, but audio playback does not start.

**Required next step:** plug an external Bluetooth receiver into the speakers and pair the phone with it. The phone streams to the receiver; the tablet only serves UI navigation and light control. This is **not optional** and **does not replace** any future WebView upgrade — it is a separate physical layer.

### Tablet WebView upgrade — DEFERRED

Bromite SystemWebView APK is installed on the kiosk, but Android Settings → Developer Options → WebView implementation does not list it — only the default Android System WebView is selectable. Reason unknown (likely signature mismatch or Android 8.1 limitation on non-system-app WebView providers). Path forward not yet determined; the SystemWebView APK is parked in `clck.ru/3Tm5CS` for future attempts.

### Known issues (deferred)

- iOS Safari: `silno.local` and `192.168.31.50:8080/8081` time out from iPhone. Other LAN clients work. Owner explicitly deferred.
- YouTube playlist auto-generated URLs (`list=RD...`) expire within an hour or two — do not save them.
- DragonFly v1.38 does not support `notify-keyspace-events "K$"` — connector uses an explicit `light:cmd:set` pubsub channel instead. Use `redis-cli PUBLISH light:cmd:set ch1:true` for manual control, not `SET`.
- WSL2 mirrored networking + Throne VPN tunnel inside WSL: from within WSL, `curl 127.0.0.1:<port>` and `curl 192.168.31.50:<port>` return `HTTP/1.1 502 Bad Gateway` even when the service is bound and listening. External LAN clients are unaffected. Trust `pgrep` + log lines, not `curl` self-loopback.

### Pre-docker TODO

- HTTPS termination in front of panel (Caddy/nginx in the same compose stack) before containerising — required for token-auth, SC OAuth, future Yandex/Spotify integrations.
- Pair external BT receiver and document the pairing flow.
- WebView upgrade investigation — separate task, not blocking panel work.
