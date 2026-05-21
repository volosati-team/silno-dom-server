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
