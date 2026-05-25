"""
Media panel FastAPI app.

Port of the former Cloudflare Worker (worker.js) to a local FastAPI process.
Serves the static panel UI plus REST endpoints for the SoundCloud / guest
session flows, oEmbed proxy, URL resolver, saved-playlist storage, and a
small debug-log sink.

Run:
    uvicorn panel.app:app --host 0.0.0.0 --port 8081

Storage: SQLite file at panel/data/panel.db (created on first start).
"""

import asyncio
import json
import os
import re
import sqlite3
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
import redis

try:
    from astral import LocationInfo as _AstralLocation
    from astral.sun import sun as _astral_sun
    _ASTRAL_OK = True
except ImportError:
    _ASTRAL_OK = False
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles


# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "panel.db"

CORS_HEADERS = {"Access-Control-Allow-Origin": "*"}

SC_TOKEN_URL = "https://secure.soundcloud.com/oauth/token"
SC_AUTHORIZE_URL = "https://secure.soundcloud.com/oauth/authorize"
SC_ME_URL = "https://api.soundcloud.com/me"

CLEANUP_INTERVAL_SEC = 60


# ---------------------------------------------------------------------------
# SQLite storage (sync, stdlib)
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, isolation_level=None, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                expires_at REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS dbg_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                ua TEXT,
                url TEXT,
                entries TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv(expires_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dbg_ts ON dbg_log(ts DESC)")
    finally:
        conn.close()


# Process-wide connection. SQLite with check_same_thread=False plus
# isolation_level=None (autocommit) is safe for our low-volume workload.
_DB: Optional[sqlite3.Connection] = None


def _db() -> sqlite3.Connection:
    global _DB
    if _DB is None:
        _DB = _connect()
    return _DB


def kv_get(key: str) -> Optional[str]:
    """Return value for key, or None if missing/expired. Lazily deletes expired rows."""
    row = _db().execute(
        "SELECT value, expires_at FROM kv WHERE key = ?", (key,)
    ).fetchone()
    if row is None:
        return None
    value, expires_at = row
    if expires_at is not None and expires_at <= time.time():
        _db().execute("DELETE FROM kv WHERE key = ?", (key,))
        return None
    return value


def kv_put(key: str, value: str, ttl: Optional[int] = None) -> None:
    expires_at = time.time() + ttl if ttl is not None else None
    _db().execute(
        "INSERT INTO kv(key, value, expires_at) VALUES(?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at",
        (key, value, expires_at),
    )


def kv_delete(key: str) -> None:
    _db().execute("DELETE FROM kv WHERE key = ?", (key,))


def kv_cleanup() -> int:
    cur = _db().execute(
        "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?",
        (time.time(),),
    )
    return cur.rowcount or 0


async def _cleanup_loop() -> None:
    while True:
        try:
            await asyncio.sleep(CLEANUP_INTERVAL_SEC)
            kv_cleanup()
        except asyncio.CancelledError:
            break
        except Exception:
            # Never let the cleanup loop die silently on a transient error.
            await asyncio.sleep(CLEANUP_INTERVAL_SEC)


# ---------------------------------------------------------------------------
# Success page (ported verbatim from worker.js, minus the Cyrillic strings,
# which are kept inside an HTML template, not in source identifiers).
# The task spec says ASCII-only in source; the Cyrillic UI text from worker.js
# is therefore replaced with English equivalents that keep the same layout.
# ---------------------------------------------------------------------------

def success_page(username: str) -> str:
    safe_user = (username or "").replace("<", "&lt;").replace(">", "&gt;")
    return (
        "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<style>*{margin:0;padding:0;box-sizing:border-box}"
        "body{background:#000;color:#fff;font-family:-apple-system,sans-serif;"
        "display:flex;flex-direction:column;align-items:center;justify-content:center;"
        "height:100vh;gap:20px;text-align:center;padding:20px}"
        ".ok{font-size:64px;color:#fff500}"
        ".t{font-size:20px;font-weight:600}"
        ".s{font-size:13px;color:#555;letter-spacing:.05em;margin-top:4px}</style>"
        "</head><body>"
        "<div class=\"ok\">&#10003;</div>"
        "<div class=\"t\">SoundCloud connected</div>"
        f"<div class=\"s\">{safe_user}<br><br>You can close this page</div>"
        "</body></html>"
    )


# ---------------------------------------------------------------------------
# Lifespan + app
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    _init_db()
    _db()  # warm the connection
    task = asyncio.create_task(_cleanup_loop())
    sched_task = asyncio.create_task(_schedule_loop())
    try:
        yield
    finally:
        task.cancel()
        sched_task.cancel()
        try:
            await task
        except Exception:
            pass
        try:
            await sched_task
        except Exception:
            pass
        global _DB
        if _DB is not None:
            try:
                _DB.close()
            except Exception:
                pass
            _DB = None


app = FastAPI(title="silno-dom panel", lifespan=lifespan)

# Permissive CORS: LAN-only deployment, mirrors the worker's Access-Control-Allow-Origin: *.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def json_response(payload: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status, headers=CORS_HEADERS)


def text_response(body: str, status: int = 200, content_type: str = "application/json") -> Response:
    headers = dict(CORS_HEADERS)
    headers["Content-Type"] = content_type
    return Response(content=body, status_code=status, headers=headers)


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------

# Mount the on-disk static directory under /static for nested asset references.
if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def _serve_static(filename: str, media_type: Optional[str] = None) -> Response:
    path = STATIC_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    headers = {"Cache-Control": "no-cache, must-revalidate"}
    return FileResponse(str(path), media_type=media_type, headers=headers)


# ---------------------------------------------------------------------------
# SC OAuth callback (mirrors worker.js /sc-auth handler)
# ---------------------------------------------------------------------------

@app.get("/sc-auth")
async def sc_auth(request: Request):
    sid = request.query_params.get("session")
    code = request.query_params.get("code")
    if not sid:
        return PlainTextResponse("Bad request", status_code=400)

    raw = kv_get(f"pkce:{sid}")
    if not raw:
        return HTMLResponse(
            "Session expired. Retry on the panel.", status_code=410
        )

    try:
        pkce = json.loads(raw)
    except json.JSONDecodeError:
        return HTMLResponse("Session corrupted.", status_code=410)

    base = str(request.base_url).rstrip("/")
    redirect_uri = f"{base}/sc-auth?session={sid}"

    if not code:
        # First hit: bounce the phone to SoundCloud OAuth.
        params = {
            "client_id": pkce.get("client_id", ""),
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "code_challenge": pkce.get("challenge", ""),
            "code_challenge_method": "S256",
        }
        # httpx.QueryParams encodes values; build a clean query string via it.
        qp = httpx.QueryParams(params)
        return RedirectResponse(f"{SC_AUTHORIZE_URL}?{qp}", status_code=302)

    # Callback: exchange code for token.
    async with httpx.AsyncClient(timeout=15.0) as client:
        tr = await client.post(
            SC_TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "authorization_code",
                "client_id": pkce.get("client_id", ""),
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": pkce.get("verifier", ""),
            },
        )
        if tr.status_code >= 400:
            kv_delete(f"pkce:{sid}")
            return HTMLResponse("Auth failed", status_code=400)
        try:
            td = tr.json()
        except json.JSONDecodeError:
            kv_delete(f"pkce:{sid}")
            return HTMLResponse("Auth failed (bad token response)", status_code=400)

        username = ""
        avatar_url = ""
        try:
            mr = await client.get(
                SC_ME_URL,
                headers={"Authorization": f"OAuth {td.get('access_token', '')}"},
            )
            if mr.status_code < 400:
                me = mr.json()
                username = me.get("username", "") or ""
                avatar_url = me.get("avatar_url", "") or ""
        except Exception:
            # Best-effort identity fetch; failure is non-fatal.
            pass

    token_payload = {
        "access_token": td.get("access_token", ""),
        "refresh_token": td.get("refresh_token", "") or "",
        "username": username,
        "avatar_url": avatar_url,
    }
    kv_put(f"token:{sid}", json.dumps(token_payload), ttl=60)
    kv_delete(f"pkce:{sid}")

    return HTMLResponse(success_page(username))


# ---------------------------------------------------------------------------
# Guest session API
# ---------------------------------------------------------------------------

@app.post("/api/guest-session")
async def api_guest_session():
    sid = str(uuid.uuid4())
    kv_put(f"guest:{sid}", "1", ttl=600)
    return json_response({"session_id": sid})


@app.post("/api/guest-submit")
async def api_guest_submit(request: Request):
    try:
        body = await request.json()
    except Exception:
        return json_response({}, status=400)
    session_id = body.get("session_id")
    media_url = body.get("url")
    title = body.get("title")
    if not session_id or not media_url:
        return json_response({}, status=400)
    if kv_get(f"guest:{session_id}") is None:
        return json_response({"error": "session_expired"}, status=410)
    payload = json.dumps({"url": media_url, "title": title or None})
    kv_put(f"guest:{session_id}:payload", payload, ttl=60)
    return json_response({"ok": True})


@app.get("/api/guest-poll")
async def api_guest_poll(request: Request):
    sid = request.query_params.get("session")
    if not sid:
        return text_response("null")
    payload = kv_get(f"guest:{sid}:payload")
    if payload:
        kv_delete(f"guest:{sid}:payload")
        try:
            return json_response(json.loads(payload))
        except Exception:
            return json_response({"url": payload})
    # Backwards-compat: old guest pages that submitted url-only land here.
    media_url = kv_get(f"guest:{sid}:url")
    if media_url:
        kv_delete(f"guest:{sid}:url")
        return json_response({"url": media_url})
    return text_response("null")


# ---------------------------------------------------------------------------
# URL resolver + oEmbed proxy
# ---------------------------------------------------------------------------

@app.get("/api/resolve-url")
async def api_resolve_url(request: Request):
    target_url = request.query_params.get("url")
    if not target_url:
        return json_response({"url": target_url})
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
            r = await client.get(target_url)
            return json_response({"url": str(r.url)})
    except Exception:
        return json_response({"url": target_url})


@app.get("/api/oembed")
async def api_oembed(request: Request):
    target_url = request.query_params.get("url")
    if not target_url:
        return text_response("{}")

    low = target_url.lower()
    if "soundcloud.com" in low:
        oembed_url = "https://soundcloud.com/oembed"
        params = {"url": target_url, "format": "json"}
    elif "youtube.com" in low or "youtu.be" in low:
        oembed_url = "https://www.youtube.com/oembed"
        params = {"url": target_url, "format": "json"}
    elif "spotify.com" in low:
        oembed_url = "https://open.spotify.com/oembed"
        params = {"url": target_url}
    else:
        return text_response("{}")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(oembed_url, params=params)
            return text_response(r.text)
    except Exception:
        return text_response("{}")


# ---------------------------------------------------------------------------
# Music search (YouTube Data API v3)
# ---------------------------------------------------------------------------

YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY")


@app.get("/api/search")
async def api_search(request: Request):
    q = (request.query_params.get("q") or "").strip()
    src = (request.query_params.get("src") or "youtube").strip().lower()
    if not q:
        return json_response({"results": [], "error": "empty_query"})
    if src != "youtube":
        # SC search and others — added in later phases
        return json_response({"results": [], "error": "source_not_implemented"})
    if not YOUTUBE_API_KEY:
        return json_response({"results": [], "error": "missing_api_key"}, status=503)

    params = {
        "part": "snippet",
        "q": q,
        "type": "video",
        "videoCategoryId": "10",  # Music
        "maxResults": "12",
        "key": YOUTUBE_API_KEY,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                "https://www.googleapis.com/youtube/v3/search",
                params=params,
            )
            if r.status_code != 200:
                return json_response(
                    {"results": [], "error": f"yt_http_{r.status_code}",
                     "detail": r.text[:300]},
                    status=502,
                )
            data = r.json()
    except Exception as e:
        return json_response({"results": [], "error": "fetch_failed",
                              "detail": str(e)[:200]}, status=502)

    raw = []
    for it in data.get("items", []):
        vid = (it.get("id") or {}).get("videoId")
        sn = it.get("snippet") or {}
        if not vid:
            continue
        thumbs = (sn.get("thumbnails") or {})
        thumb = (thumbs.get("medium") or thumbs.get("high")
                 or thumbs.get("default") or {}).get("url", "")
        raw.append({
            "id": vid,
            "url": f"https://www.youtube.com/watch?v={vid}",
            "service": "youtube",
            "title": sn.get("title", ""),
            "channel": sn.get("channelTitle", ""),
            "thumbnail": thumb,
        })

    # Second-pass: pull part=status,contentDetails for the cheap heuristic.
    # YT Data API status.embeddable is unreliable (returns true for label-
    # locked videos like Despacito). Combine multiple cheap signals — see
    # panel/tests/test_yt_filter.py for the validation harness.
    drop_reasons = {}  # video_id → reason string (or absent → keep)
    if raw:
        ids_csv = ",".join(v["id"] for v in raw)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                vr = await client.get(
                    "https://www.googleapis.com/youtube/v3/videos",
                    params={
                        "part": "status,contentDetails",
                        "id": ids_csv,
                        "key": YOUTUBE_API_KEY,
                    },
                )
                if vr.status_code == 200:
                    vdata = vr.json()
                    by_id = {it.get("id"): it for it in vdata.get("items", [])}
                else:
                    by_id = {}
        except Exception:
            by_id = {}

        for v in raw:
            vid = v["id"]
            it = by_id.get(vid)
            channel = v.get("channel") or ""
            # 1. VEVO channels are almost always label-locked.
            if "VEVO" in channel.upper():
                drop_reasons[vid] = "vevo-channel"
                continue
            if not it:
                continue  # videos.list failed for this id — keep
            st = it.get("status") or {}
            cd = it.get("contentDetails") or {}
            region = cd.get("regionRestriction") or {}
            rating = cd.get("contentRating") or {}
            # 2. status.embeddable=false → uploader explicitly blocked embed.
            if not st.get("embeddable", True):
                drop_reasons[vid] = "embeddable-false"
                continue
            # 3. privacyStatus other than public/unlisted → not playable.
            ps = st.get("privacyStatus")
            if ps and ps not in ("public", "unlisted"):
                drop_reasons[vid] = f"privacy-{ps}"
                continue
            # 4. ytAgeRestricted → embed kicks to YouTube proper, useless.
            if rating.get("ytRating") == "ytAgeRestricted":
                drop_reasons[vid] = "age-restricted"
                continue
            # 5. regionRestriction.blocked includes our region (RU). The wall
            #    panel is in Russia; if RU is in the blocked list — drop.
            blocked = region.get("blocked") or []
            if "RU" in blocked:
                drop_reasons[vid] = "region-blocked-RU"
                continue
            # 6. regionRestriction.allowed exists and doesn't include RU.
            allowed = region.get("allowed") or []
            if allowed and "RU" not in allowed:
                drop_reasons[vid] = "region-not-allowed-RU"
                continue

    filtered = [v for v in raw if v["id"] not in drop_reasons]
    return json_response({
        "results": filtered,
        "dropped": len(raw) - len(filtered),
        "dropped_ids": drop_reasons,
    })


# ---------------------------------------------------------------------------
# SC PKCE QR session
# ---------------------------------------------------------------------------

@app.post("/api/sc-session")
async def api_sc_session(request: Request):
    try:
        body = await request.json()
    except Exception:
        return json_response({}, status=400)
    session_id = body.get("session_id")
    if not session_id:
        return json_response({}, status=400)
    payload = {
        "client_id": body.get("client_id", ""),
        "verifier": body.get("verifier", ""),
        "challenge": body.get("challenge", ""),
    }
    kv_put(f"pkce:{session_id}", json.dumps(payload), ttl=300)
    return text_response("\"ok\"")


@app.get("/api/sc-poll")
async def api_sc_poll(request: Request):
    sid = request.query_params.get("session")
    if not sid:
        return text_response("null")
    token = kv_get(f"token:{sid}")
    if token:
        kv_delete(f"token:{sid}")
        return text_response(token)
    return text_response("null")


@app.post("/api/sc-token")
async def api_sc_token(request: Request):
    body_bytes = await request.body()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                SC_TOKEN_URL,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                content=body_bytes,
            )
        return text_response(resp.text, status=resp.status_code)
    except Exception as exc:
        return json_response({"error": "upstream_failed", "detail": str(exc)}, status=502)


# ---------------------------------------------------------------------------
# Saved playlists (shared across devices)
# ---------------------------------------------------------------------------

@app.get("/api/saved-list")
async def api_saved_list_get():
    raw = kv_get("saved_playlists")
    return text_response(raw if raw is not None else "[]")


@app.put("/api/saved-list")
async def api_saved_list_put(request: Request):
    body_bytes = await request.body()
    try:
        body_text = body_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return text_response("bad json", status=400, content_type="text/plain")
    try:
        parsed = json.loads(body_text)
    except json.JSONDecodeError:
        return text_response("bad json", status=400, content_type="text/plain")
    if not isinstance(parsed, list):
        return text_response("bad json", status=400, content_type="text/plain")
    kv_put("saved_playlists", body_text)
    return text_response("\"ok\"")


# ---------------------------------------------------------------------------
# Debug log
# ---------------------------------------------------------------------------

@app.post("/api/dbg-log")
async def api_dbg_log(request: Request):
    try:
        body = await request.json()
    except Exception:
        return text_response("bad json", status=400, content_type="text/plain")
    ts = body.get("ts")
    try:
        ts_val = float(ts) if ts is not None else time.time()
    except (TypeError, ValueError):
        ts_val = time.time()
    ua = body.get("ua") or ""
    url = body.get("url") or ""
    entries = body.get("entries") or []
    entries_json = json.dumps(entries)
    _db().execute(
        "INSERT INTO dbg_log(ts, ua, url, entries) VALUES(?, ?, ?, ?)",
        (ts_val, ua, url, entries_json),
    )
    return text_response("\"ok\"")


@app.get("/api/dbg-log/recent")
async def api_dbg_log_recent():
    rows = _db().execute(
        "SELECT id, ts, ua, url, entries FROM dbg_log ORDER BY ts DESC LIMIT 30"
    ).fetchall()
    items = []
    for row_id, ts_val, ua, url, entries_json in rows:
        try:
            entries = json.loads(entries_json) if entries_json else []
        except json.JSONDecodeError:
            entries = []
        items.append(
            {
                "id": row_id,
                "ts": ts_val,
                "ua": ua,
                "url": url,
                "entries": entries,
            }
        )
    return json_response({"count": len(items), "items": items})


# ---------------------------------------------------------------------------
# Top-level static routes (root index, guest, manifest, icon, css, js).
# Mounted after the API so /api/* takes precedence.
# ---------------------------------------------------------------------------

@app.get("/api/build", include_in_schema=False)
async def api_build():
    import subprocess
    try:
        out = subprocess.check_output(
            ["git", "log", "-1", "--format=%h %cI"],
            cwd=str(BASE_DIR), text=True, timeout=3
        ).strip()
        parts = out.split(" ", 1)
        return json_response({"commit": parts[0], "date": parts[1] if len(parts) > 1 else ""})
    except Exception:
        return json_response({"commit": "unknown", "date": ""})


@app.get("/api/version", include_in_schema=False)
async def api_version():
    # Used by the panel JS to detect server-side asset changes and trigger
    # an automatic page reload without manual cache busting.
    return json_response({
        "app_js": int((STATIC_DIR / "app.js").stat().st_mtime),
        "app_css": int((STATIC_DIR / "app.css").stat().st_mtime),
        "index_html": int((STATIC_DIR / "index.html").stat().st_mtime),
    })


@app.get("/", include_in_schema=False)
async def root_index():
    # Rewrite static-asset cache keys to the current mtime so Bromite (and any
    # other aggressive HTML5 cache) re-fetches app.css/app.js whenever we
    # actually changed them. Without this the wall panel keeps running stale
    # JS until the user manually force-reloads.
    path = STATIC_DIR / "index.html"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    html = path.read_text(encoding="utf-8")
    css_v = int((STATIC_DIR / "app.css").stat().st_mtime)
    js_v = int((STATIC_DIR / "app.js").stat().st_mtime)
    html = re.sub(r"app\.css\?v=\d+", f"app.css?v={css_v}", html)
    html = re.sub(r"app\.js\?v=\d+", f"app.js?v={js_v}", html)
    # no-store + no-cache combo bypasses Bromite's back-forward cache, which
    # otherwise keeps a stale SPA tab alive forever even on revalidation.
    return Response(content=html, media_type="text/html; charset=utf-8",
                    headers={
                        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                        "Pragma": "no-cache",
                        "Expires": "0",
                    })


@app.get("/guest", include_in_schema=False)
async def guest_page():
    return _serve_static("guest.html", media_type="text/html; charset=utf-8")


@app.get("/manifest.json", include_in_schema=False)
async def manifest():
    return _serve_static("manifest.json", media_type="application/manifest+json")


@app.get("/icon.svg", include_in_schema=False)
async def icon():
    return _serve_static("icon.svg", media_type="image/svg+xml")


@app.get("/app.css", include_in_schema=False)
async def app_css():
    return _serve_static("app.css", media_type="text/css; charset=utf-8")


@app.get("/app.js", include_in_schema=False)
async def app_js():
    return _serve_static("app.js", media_type="application/javascript; charset=utf-8")


# ---------------------------------------------------------------------------
# Health probe (handy when supervising the process from start.sh).
# ---------------------------------------------------------------------------

@app.get("/healthz", include_in_schema=False)
async def healthz():
    return json_response({"ok": True, "service": "panel"})


# ---------------------------------------------------------------------------
# Light control via DragonFly (Redis-compatible KV).
#
# Flow:
#   POST /api/light/set body {"ch1": true, "ch3": false}
#     -> SET light:ch1:cmd "true", SET light:ch3:cmd "false"
#     -> dragonfly_mqtt_bridge.py picks up keyspace events and publishes MQTT.
#   GET /api/light/state
#     -> MGET light:ch1:state light:ch3:state -> {"ch1": bool|null, "ch3": bool|null}
#
# DragonFly is reached via REDIS_URL (default redis://127.0.0.1:6379/0).
# Tiny payloads, sync client is fine; FastAPI runs it in a threadpool.
# ---------------------------------------------------------------------------

REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
LIGHT_CHANNELS = ("ch1", "ch3")
LIGHT_CMD_PUBSUB_CHANNEL = "light:cmd:set"
_REDIS: Optional[redis.Redis] = None

# ---------------------------------------------------------------------------
# Light schedule
# ---------------------------------------------------------------------------

MSK = timezone(timedelta(hours=3))
SCHEDULE_KV_KEY = "light_schedule"

_DERBENT = None
if _ASTRAL_OK:
    try:
        _DERBENT = _AstralLocation("Derbent", "Russia", "Europe/Moscow", 42.0567, 48.292)
    except Exception:
        pass


def _sun_time(kind: str) -> tuple:
    """Return (hour, minute) in MSK for today's sunrise or sunset. Falls back to fixed defaults."""
    fallback = (19, 0) if kind == "sunset" else (5, 30)
    if _DERBENT is None:
        return fallback
    try:
        s = _astral_sun(_DERBENT.observer, date=datetime.now(tz=MSK).date(), tzinfo=MSK)
        dt = s.get(kind)
        if dt is None:
            return fallback
        return (dt.hour, dt.minute)
    except Exception:
        return fallback


DEFAULT_SCHEDULE: dict = {
    "enabled": True,
    "entries": [
        {"id": "on-ch1",  "label": "Споты вкл",    "channel": "ch1", "state": True,  "mode": "sunset",       "enabled": True},
        {"id": "on-ch3",  "label": "Гирлянда вкл", "channel": "ch3", "state": True,  "mode": "sunset",       "enabled": True},
        {"id": "off-ch1", "label": "Споты выкл",   "channel": "ch1", "state": False, "hour": 4, "minute": 0,  "enabled": True},
        {"id": "off-ch3", "label": "Гирлянда выкл","channel": "ch3", "state": False, "hour": 4, "minute": 0,  "enabled": True},
    ],
}


def _load_schedule() -> dict:
    raw = kv_get(SCHEDULE_KV_KEY)
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    return DEFAULT_SCHEDULE


async def _schedule_loop() -> None:
    while True:
        try:
            await asyncio.sleep(30)
            sched = _load_schedule()
            if not sched.get("enabled"):
                continue
            now = datetime.now(tz=MSK)
            hh, mm, day_key = now.hour, now.minute, now.strftime("%Y-%m-%d")
            for entry in sched.get("entries", []):
                if not entry.get("enabled"):
                    continue
                mode = entry.get("mode")
                if mode:
                    target_hh, target_mm = _sun_time(mode)
                else:
                    target_hh = entry.get("hour", -1)
                    target_mm = entry.get("minute", -1)
                if target_hh != hh or target_mm != mm:
                    continue
                fired_key = f"sched_fired:{day_key}:{hh:02d}:{mm:02d}:{entry['id']}"
                if kv_get(fired_key) is not None:
                    continue
                ch = entry.get("channel")
                state = entry.get("state")
                if ch not in LIGHT_CHANNELS or not isinstance(state, bool):
                    continue
                try:
                    rdb = _redis()
                    text = "true" if state else "false"
                    rdb.set(f"light:{ch}:cmd", text)
                    rdb.publish(LIGHT_CMD_PUBSUB_CHANNEL, f"{ch}:{text}")
                    kv_put(fired_key, "1", ttl=120)
                except Exception:
                    pass
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(30)


def _redis() -> redis.Redis:
    global _REDIS
    if _REDIS is None:
        _REDIS = redis.Redis.from_url(REDIS_URL, decode_responses=True, socket_timeout=2.0)
    return _REDIS


def _parse_state_value(raw: Optional[str]) -> Optional[bool]:
    if raw is None:
        return None
    v = raw.strip().lower()
    if v == "true":
        return True
    if v == "false":
        return False
    return None


@app.post("/api/light/set", include_in_schema=False)
async def api_light_set(request: Request):
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "bad_json"}, status=400)
    if not isinstance(body, dict):
        return json_response({"ok": False, "error": "bad_body"}, status=400)
    written = {}
    try:
        client = _redis()
        for ch, val in body.items():
            if ch not in LIGHT_CHANNELS:
                continue
            if not isinstance(val, bool):
                continue
            text = "true" if val else "false"
            # SET stores last-known cmd (audit / read-back).
            client.set(f"light:{ch}:cmd", text)
            # PUBLISH triggers the bridge (DragonFly has no SET keyspace events).
            client.publish(LIGHT_CMD_PUBSUB_CHANNEL, f"{ch}:{text}")
            written[ch] = val
    except redis.RedisError as exc:
        return json_response({"ok": False, "error": "redis_unreachable", "detail": str(exc)}, status=502)
    if not written:
        return json_response({"ok": False, "error": "no_valid_channels"}, status=400)
    return json_response({"ok": True, "written": written})


@app.get("/api/light/state", include_in_schema=False)
async def api_light_state():
    try:
        client = _redis()
        keys = [f"light:{ch}:state" for ch in LIGHT_CHANNELS]
        values = client.mget(keys)
    except redis.RedisError as exc:
        return json_response({"error": "redis_unreachable", "detail": str(exc)}, status=502)
    out = {ch: _parse_state_value(v) for ch, v in zip(LIGHT_CHANNELS, values)}
    return json_response(out)


# ---------------------------------------------------------------------------
# Streaming proxy for /api/stream/* — forwards to the yt-dlp resolver service
# on port 8083 so the kiosk can hit a same-origin URL. Kept explicit (not
# part of the generic fallthrough) because the target backend differs.
# ---------------------------------------------------------------------------

STREAMING_BACKEND = "http://127.0.0.1:8083"


@app.api_route(
    "/api/stream/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    include_in_schema=False,
)
async def fallthrough_streaming_proxy(path: str, request: Request):
    target = f"{STREAMING_BACKEND}/api/stream/{path}"
    qs = request.url.query
    if qs:
        target = f"{target}?{qs}"
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length")
    }
    body = await request.body()
    try:
        # trust_env=False so httpx does not route loopback calls through the
        # host's HTTP_PROXY=http://127.0.0.1:2080 (Throne VPN). NO_PROXY for
        # IP literals is unreliable across httpx versions; bypassing the env
        # entirely is the safe call for in-host proxying.
        async with httpx.AsyncClient(timeout=35.0, trust_env=False) as client:
            r = await client.request(request.method, target, headers=headers, content=body)
    except Exception as exc:
        return JSONResponse({"error": "streaming_unreachable", "detail": str(exc)}, status_code=502)
    resp_headers = {
        k: v
        for k, v in r.headers.items()
        if k.lower() not in ("content-length", "transfer-encoding", "connection")
    }
    return Response(
        content=r.content,
        status_code=r.status_code,
        headers=resp_headers,
        media_type=r.headers.get("content-type"),
    )


# ---------------------------------------------------------------------------
# Bluetooth toggle (proxies to Android APK/Termux agent on localhost:8765)
# ---------------------------------------------------------------------------

BT_AGENT_URL = "http://127.0.0.1:8765"


def _http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient()


@app.post("/api/bt/toggle", include_in_schema=False)
async def api_bt_toggle():
    try:
        r = await _http_client().get(f"{BT_AGENT_URL}/bt-toggle", timeout=3.0)
        return json_response({"ok": True, "agent": r.json()})
    except Exception as exc:
        return json_response({"ok": False, "error": "bt_agent_unreachable", "detail": str(exc)}, status=503)


# ---------------------------------------------------------------------------
# Display brightness settings
# ---------------------------------------------------------------------------

DISPLAY_KV_KEY = "display_settings"
DISPLAY_DEFAULTS: dict = {"brightness": 100, "night_dim": 50, "enabled": True}


@app.get("/api/display/settings", include_in_schema=False)
async def api_display_settings_get():
    raw = kv_get(DISPLAY_KV_KEY)
    if raw:
        try:
            return json_response({**DISPLAY_DEFAULTS, **json.loads(raw)})
        except Exception:
            pass
    return json_response(DISPLAY_DEFAULTS)


@app.put("/api/display/settings", include_in_schema=False)
async def api_display_settings_put(request: Request):
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "bad_json"}, status=400)
    if not isinstance(body, dict):
        return json_response({"ok": False, "error": "invalid_schema"}, status=400)
    merged = {**DISPLAY_DEFAULTS, **{k: body[k] for k in ("brightness", "night_dim", "enabled") if k in body}}
    kv_put(DISPLAY_KV_KEY, json.dumps(merged))
    return json_response({"ok": True})


@app.get("/admin", include_in_schema=False)
async def admin_page():
    path = STATIC_DIR / "admin.html"
    return FileResponse(str(path), media_type="text/html")


# ── Auth ──────────────────────────────────────────────────────────────────────
# Passwords stored in .env as PANEL_PASS_<USERNAME> (plain text for now;
# migrate to hashes when moving to a new server).

_PROD_USERS = ["volosati", "max"]
_PANEL_ENV = BASE_DIR / ".env"


def _is_dev_branch() -> bool:
    try:
        branch = subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(BASE_DIR), text=True, timeout=2
        ).strip()
        return branch != "main"
    except Exception:
        return False


def _allowed_users() -> list:
    users = list(_PROD_USERS)
    if _is_dev_branch():
        users = [""] + users  # empty = quick-login dev user
    return users


def _get_pass(username: str) -> str:
    return os.environ.get(f"PANEL_PASS_{username.upper()}", "")


def _set_pass(username: str, new_pass: str) -> None:
    key = f"PANEL_PASS_{username.upper()}"
    os.environ[key] = new_pass  # immediate effect
    lines = _PANEL_ENV.read_text().splitlines() if _PANEL_ENV.exists() else []
    prefix = f"{key}="
    lines = [l for l in lines if not l.startswith(prefix)]
    lines.append(f"{key}={new_pass}")
    _PANEL_ENV.write_text("\n".join(lines) + "\n")


@app.post("/api/auth/login", include_in_schema=False)
async def auth_login(request: Request):
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "bad_json"}, status=400)
    username = body.get("username", "").lower()
    password = body.get("password", "")
    if username not in _allowed_users():
        return json_response({"ok": False, "error": "invalid"}, status=401)
    if username == "":
        if password != "":
            return json_response({"ok": False, "error": "invalid"}, status=401)
        return json_response({"ok": True, "name": "dev"})
    if password != _get_pass(username):
        return json_response({"ok": False, "error": "invalid"}, status=401)
    return json_response({"ok": True, "name": username})


@app.post("/api/auth/change-password", include_in_schema=False)
async def auth_change_password(request: Request):
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "bad_json"}, status=400)
    username = body.get("username", "").lower()
    old_pass = body.get("old_password", "")
    new_pass = body.get("new_password", "")
    if username == "" or username not in _PROD_USERS:
        return json_response({"ok": False, "error": "invalid_user"}, status=400)
    if old_pass != _get_pass(username):
        return json_response({"ok": False, "error": "wrong_password"}, status=401)
    _set_pass(username, new_pass)
    return json_response({"ok": True})


@app.get("/api/sun/times", include_in_schema=False)
async def api_sun_times():
    now = datetime.now(tz=MSK)
    sunset_h, sunset_m = _sun_time("sunset")
    sunrise_h, sunrise_m = _sun_time("sunrise")
    now_min = now.hour * 60 + now.minute
    sunset_min = sunset_h * 60 + sunset_m
    is_night = now_min >= sunset_min or now_min < 4 * 60
    return json_response({
        "sunset": f"{sunset_h:02d}:{sunset_m:02d}",
        "sunrise": f"{sunrise_h:02d}:{sunrise_m:02d}",
        "now_msk": f"{now.hour:02d}:{now.minute:02d}",
        "is_night": is_night,
    })


# ---------------------------------------------------------------------------
# Light schedule endpoints
# ---------------------------------------------------------------------------

@app.get("/api/light/schedule", include_in_schema=False)
async def api_light_schedule_get():
    return json_response(_load_schedule())


@app.put("/api/light/schedule", include_in_schema=False)
async def api_light_schedule_put(request: Request):
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "bad_json"}, status=400)
    if not isinstance(body, dict) or "entries" not in body:
        return json_response({"ok": False, "error": "invalid_schema"}, status=400)
    kv_put(SCHEDULE_KV_KEY, json.dumps(body))
    return json_response({"ok": True})


# ---------------------------------------------------------------------------
# Fallthrough proxy for unhandled /api/* paths.
# Mirrors the old worker.js MOIO fallback: strip "/api" prefix and forward
# to the light-control FastAPI on port 8080. Used by the panel UI to read
# `/api/state` (light status) without exposing the light backend directly.
# ---------------------------------------------------------------------------

LIGHT_BACKEND = "http://127.0.0.1:8081"


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"], include_in_schema=False)
async def fallthrough_light_proxy(path: str, request: Request):
    target = f"{LIGHT_BACKEND}/{path}"
    qs = request.url.query
    if qs:
        target = f"{target}?{qs}"
    headers = {k: v for k, v in request.headers.items() if k.lower() not in ("host", "content-length")}
    body = await request.body()
    try:
        r = await _http_client().request(request.method, target, headers=headers, content=body, timeout=10.0)
    except Exception as exc:
        return JSONResponse({"error": "upstream_unreachable", "detail": str(exc)}, status_code=502)
    resp_headers = {k: v for k, v in r.headers.items() if k.lower() not in ("content-length", "transfer-encoding", "connection")}
    return Response(content=r.content, status_code=r.status_code, headers=resp_headers, media_type=r.headers.get("content-type"))
