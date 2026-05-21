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
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import httpx
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
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
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
    return FileResponse(str(path), media_type=media_type)


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
    if not session_id or not media_url:
        return json_response({}, status=400)
    if kv_get(f"guest:{session_id}") is None:
        return json_response({"error": "session_expired"}, status=410)
    kv_put(f"guest:{session_id}:url", media_url, ttl=60)
    return json_response({"ok": True})


@app.get("/api/guest-poll")
async def api_guest_poll(request: Request):
    sid = request.query_params.get("session")
    if not sid:
        return text_response("null")
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

@app.get("/", include_in_schema=False)
async def root_index():
    return _serve_static("index.html", media_type="text/html; charset=utf-8")


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
