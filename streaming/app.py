"""
Audio streaming resolver.

Standalone FastAPI service that resolves SoundCloud / YouTube / Yandex Music
/ Spotify URLs into a direct audio stream URL via yt-dlp. The kiosk panel
calls this through a same-origin reverse proxy (panel.app.fallthrough) and
feeds the result into a native HTML5 <audio> element, bypassing the SC
Widget iframe which cannot play audio on the iiyama kiosk's Bromite v108.

Run:
    uvicorn streaming.app:app --host 0.0.0.0 --port 8083

Dependencies: yt-dlp CLI on PATH, fastapi, uvicorn.

Architecture note: shares no in-process state with panel.app or web.app.
Each layer runs as its own uvicorn worker so a crash in one does not bring
down the others (control/audio separation, see panel/README.md).
"""

import asyncio
import json
import re
import secrets
import time
from pathlib import Path
from typing import Any, AsyncIterator, Optional
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Hosts we accept. Substring match against the URL hostname (lowercased).
ALLOWED_HOSTS = (
    "soundcloud.com",
    "snd.sc",
    "on.soundcloud.com",
    "youtube.com",
    "youtu.be",
    "music.youtube.com",
    "music.yandex.",
    "spotify.com",
)

# SoundCloud signed stream URLs expire in roughly 5 minutes. Cache slightly
# under that so we always hand out a URL with at least ~1 minute of life.
CACHE_TTL_SEC = 240
# yt-dlp can be slow on cold cache or large playlists, especially with browser
# cookies extraction. 45s is safer for SC profile enumeration + YT auth flows.
YT_DLP_TIMEOUT_SEC = 45

PLAYLIST_HINTS = ("/sets/", "/playlist/", "/album/", "list=", "/playlists/")

# Optional browser cookie source for yt-dlp. Set via env var; if non-empty,
# every yt-dlp invocation gets `--cookies-from-browser <value>`. The value is
# passed straight through, so it can be `firefox`, `brave`, or with profile
# path like `firefox:/mnt/c/.../Mozilla/Firefox/Profiles/<profile_id>`.
import os as _os
YT_DLP_COOKIES_FROM_BROWSER = _os.environ.get("YT_DLP_COOKIES_FROM_BROWSER", "").strip()


# ---------------------------------------------------------------------------
# App + CORS
# ---------------------------------------------------------------------------

app = FastAPI(title="silno-dom streaming", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# In-process cache
# ---------------------------------------------------------------------------

# url -> (expires_at_epoch, payload_dict)
_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_LOCK = asyncio.Lock()
_PREWARM_TASKS: dict[str, asyncio.Task[None]] = {}
_PREWARM_ERRORS: dict[str, str] = {}

# token -> (expires_at_epoch, source_url, direct_stream_url, upstream_headers)
_STREAM_PROXY_CACHE: dict[str, tuple[float, str, str, dict[str, str], str]] = {}
_STREAM_PROXY_REFRESH_TASKS: dict[str, asyncio.Task[tuple[float, str, dict[str, str], str]]] = {}
_STREAM_PROXY_STATE_PATH = Path("/tmp/silno-stream-proxy-cache.json")
_STREAM_PROXY_CHUNK_SIZE = 512 * 1024
_STREAM_PROXY_MAX_REFRESHES = 8
_STREAM_PROXY_IDLE_TIMEOUT_SEC = 55.0
_STREAM_PROXY_REFRESH_LEAD_SEC = 60.0


def _load_proxy_state() -> None:
    try:
        raw = json.loads(_STREAM_PROXY_STATE_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return
    now = time.time()
    for token, item in raw.items():
        if not isinstance(token, str) or not isinstance(item, dict):
            continue
        expires_at = item.get("expires_at")
        source_url = item.get("source_url")
        stream_url = item.get("stream_url")
        headers = item.get("headers") or {}
        if not isinstance(expires_at, (int, float)) or not isinstance(source_url, str) or not isinstance(stream_url, str):
            continue
        if not isinstance(headers, dict):
            headers = {}
        mode = item.get("mode") if item.get("mode") in ("audio", "video") else "audio"
        if source_url and stream_url:
            _STREAM_PROXY_CACHE[token] = (float(expires_at), source_url, stream_url, {str(k): str(v) for k, v in headers.items()}, mode)


def _save_proxy_state() -> None:
    raw = {
        token: {
            "expires_at": expires_at,
            "source_url": source_url,
            "stream_url": stream_url,
            "headers": upstream_headers,
            "mode": mode,
        }
        for token, (expires_at, source_url, stream_url, upstream_headers, mode) in _STREAM_PROXY_CACHE.items()
        if source_url and stream_url
    }
    tmp = _STREAM_PROXY_STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(raw))
    tmp.replace(_STREAM_PROXY_STATE_PATH)


_load_proxy_state()


def _cache_get(url: str) -> Optional[dict[str, Any]]:
    item = _CACHE.get(url)
    if not item:
        return None
    expires_at, payload = item
    if expires_at <= time.time():
        _CACHE.pop(url, None)
        return None
    return payload


def _cache_put(url: str, payload: dict[str, Any]) -> None:
    _CACHE[url] = (time.time() + CACHE_TTL_SEC, payload)


def _cache_proxy_stream(
    source_url: str,
    stream_url: str,
    expires_at: float,
    headers: Optional[dict[str, str]] = None,
    mode: str = "audio",
) -> str:
    token = secrets.token_urlsafe(18)
    _STREAM_PROXY_CACHE[token] = (expires_at, source_url, stream_url, headers or {}, mode)
    _save_proxy_state()
    return f"/api/stream/proxy/{token}"


def _range_start(value: Optional[str]) -> int:
    start, _ = _range_bounds(value)
    return start


def _range_bounds(value: Optional[str]) -> tuple[int, Optional[int]]:
    if not value or not value.startswith("bytes="):
        return 0, None
    first = value[6:].split(",", 1)[0].split("-", 1)
    try:
        start = int(first[0].strip()) if first[0].strip() else 0
    except (IndexError, ValueError):
        start = 0
    try:
        end = int(first[1].strip()) if len(first) > 1 and first[1].strip() else None
    except ValueError:
        end = None
    return start, end


def _content_range_total(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    match = re.search(r"/(\d+)$", value)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _proxy_headers(upstream_headers: dict[str, str], request: Request, start: int, end: Optional[int]) -> dict[str, str]:
    headers = dict(upstream_headers)
    for name in ("if-range",):
        value = request.headers.get(name)
        if value:
            headers[name] = value
    headers["range"] = f"bytes={start}-{end if end is not None else ''}"
    headers.setdefault(
        "user-agent",
        "Mozilla/5.0 (Linux; Android 8.1.0) AppleWebKit/537.36 Chrome/108 Safari/537.36",
    )
    return headers


async def _refresh_stream_entry(token: str, source_url: str, mode: str) -> tuple[float, str, dict[str, str], str]:
    payload = await _resolve_single(source_url, mode)
    refreshed = payload.get("stream_url")
    if not isinstance(refreshed, str) or not refreshed.startswith("/api/stream/proxy/"):
        raise RuntimeError("refresh_failed")
    new_token = refreshed.rsplit("/", 1)[-1]
    entry = _STREAM_PROXY_CACHE.pop(new_token, None)
    if entry is None:
        raise RuntimeError("refresh_missing_entry")
    expires_at, _, stream_url, upstream_headers, refreshed_mode = entry
    _STREAM_PROXY_CACHE[token] = (expires_at, source_url, stream_url, upstream_headers, refreshed_mode)
    _save_proxy_state()
    return expires_at, stream_url, upstream_headers, refreshed_mode


def _take_refresh_task(token: str) -> Optional[asyncio.Task[tuple[float, str, dict[str, str], str]]]:
    task = _STREAM_PROXY_REFRESH_TASKS.get(token)
    if task is None or not task.done():
        return None
    return _STREAM_PROXY_REFRESH_TASKS.pop(token, None)


def _start_refresh_task(token: str, source_url: str, mode: str) -> None:
    if token in _STREAM_PROXY_REFRESH_TASKS:
        return
    _STREAM_PROXY_REFRESH_TASKS[token] = asyncio.create_task(_refresh_stream_entry(token, source_url, mode))


def _get_refresh_task(token: str, source_url: str, mode: str) -> asyncio.Task[tuple[float, str, dict[str, str], str]]:
    task = _STREAM_PROXY_REFRESH_TASKS.get(token)
    if task is None or (task.done() and task.cancelled()):
        task = asyncio.create_task(_refresh_stream_entry(token, source_url, mode))
        _STREAM_PROXY_REFRESH_TASKS[token] = task
    return task


async def _await_refresh_task(token: str, source_url: str, mode: str) -> tuple[float, str, dict[str, str], str]:
    task = _get_refresh_task(token, source_url, mode)
    try:
        return await task
    finally:
        if task.done():
            _STREAM_PROXY_REFRESH_TASKS.pop(token, None)


async def _iter_proxy_stream(
    token: str,
    source_url: str,
    expires_at: float,
    stream_url: str,
    upstream_headers: dict[str, str],
    mode: str,
    request: Request,
) -> AsyncIterator[bytes]:
    position = _range_start(request.headers.get("range"))
    total: Optional[int] = None
    refreshes = 0
    timeout = httpx.Timeout(
        connect=30.0,
        read=_STREAM_PROXY_IDLE_TIMEOUT_SEC,
        write=30.0,
        pool=30.0,
    )
    while not await request.is_disconnected():
        if source_url:
            task = _take_refresh_task(token)
            if task is not None:
                try:
                    expires_at, stream_url, upstream_headers, mode = task.result()
                    refreshes = 0
                except Exception:
                    refreshes += 1
            if expires_at - time.time() < _STREAM_PROXY_REFRESH_LEAD_SEC and refreshes < _STREAM_PROXY_MAX_REFRESHES:
                _start_refresh_task(token, source_url, mode)
        end = position + _STREAM_PROXY_CHUNK_SIZE - 1
        headers = _proxy_headers(upstream_headers, request, position, end)
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=False) as client:
                async with client.stream("GET", stream_url, headers=headers) as upstream:
                    if upstream.status_code >= 400:
                        if source_url and refreshes < _STREAM_PROXY_MAX_REFRESHES:
                            refreshes += 1
                            expires_at, stream_url, upstream_headers, mode = await _refresh_stream_entry(token, source_url, mode)
                            continue
                        return
                    content_range = upstream.headers.get("content-range")
                    if total is None:
                        total = _content_range_total(content_range)
                    sent = 0
                    async for chunk in upstream.aiter_bytes():
                        if not chunk:
                            continue
                        sent += len(chunk)
                        position += len(chunk)
                        yield chunk
                    if sent == 0:
                        if source_url and refreshes < _STREAM_PROXY_MAX_REFRESHES:
                            refreshes += 1
                            expires_at, stream_url, upstream_headers, mode = await _refresh_stream_entry(token, source_url, mode)
                            continue
                        return
                    if total is not None and position >= total:
                        return
        except (httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError, httpx.ConnectError):
            if not source_url or refreshes >= _STREAM_PROXY_MAX_REFRESHES:
                return
            task = _take_refresh_task(token)
            if task is not None:
                try:
                    expires_at, stream_url, upstream_headers, mode = task.result()
                    refreshes = 0
                    continue
                except Exception:
                    pass
            refreshes += 1
            expires_at, stream_url, upstream_headers, mode = await _refresh_stream_entry(token, source_url, mode)


# ---------------------------------------------------------------------------
# URL validation
# ---------------------------------------------------------------------------

def _validate_url(url: str) -> Optional[str]:
    """Return None if URL passes the allow-list, else a short error string."""
    if not url or len(url) > 2048:
        return "empty_or_too_long"
    try:
        parsed = urlparse(url)
    except Exception:
        return "unparseable"
    if parsed.scheme not in ("http", "https"):
        return "bad_scheme"
    host = (parsed.hostname or "").lower()
    if not host:
        return "no_host"
    for allowed in ALLOWED_HOSTS:
        if allowed in host:
            return None
    return "host_not_allowed"


def _is_playlist_url(url: str) -> bool:
    low = url.lower()
    # Yandex Music: /album/<id>/track/<id> is a single track despite the
    # `/album/` token in the URL. Without this guard, _is_playlist_url
    # returns True, we route through `--flat-playlist` and yt-dlp's Yandex
    # extractor produces a single-item bool-ish payload that crashes the
    # downstream parser.
    if "music.yandex." in low and "/track/" in low:
        return False
    if any(hint in low for hint in PLAYLIST_HINTS):
        return True
    # SoundCloud profile/feed URLs — single path segment after the host means
    # the URL points at a user, not a track. yt-dlp on `soundcloud.com/<user>`
    # tries to enumerate every upload and times out; treating it as a playlist
    # routes through --flat-playlist which is fast.
    try:
        parsed = urlparse(low)
    except Exception:
        return False
    host = (parsed.hostname or "").lstrip(".")
    if "soundcloud.com" in host:
        segments = [s for s in parsed.path.split("/") if s]
        if len(segments) <= 1:
            return True
        if len(segments) == 2 and segments[1] in {
            "likes", "reposts", "tracks", "popular-tracks", "albums", "stations",
        }:
            return True
    return False


# ---------------------------------------------------------------------------
# yt-dlp wrapper
# ---------------------------------------------------------------------------

async def _run_yt_dlp(args: list[str]) -> tuple[int, bytes, bytes]:
    """Spawn yt-dlp with a hard timeout. Returns (rc, stdout, stderr)."""
    effective_args = list(args)
    if YT_DLP_COOKIES_FROM_BROWSER:
        effective_args = ["--cookies-from-browser", YT_DLP_COOKIES_FROM_BROWSER, *effective_args]
    proc = await asyncio.create_subprocess_exec(
        "yt-dlp",
        *effective_args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=YT_DLP_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        # Drain any pending output so the pipe is closed cleanly.
        try:
            await proc.communicate()
        except Exception:
            pass
        raise HTTPException(status_code=504, detail="yt_dlp_timeout")
    return proc.returncode or 0, out, err


def _normalise_thumbnail(raw: Any) -> Optional[str]:
    if isinstance(raw, str) and raw:
        return raw
    if isinstance(raw, list) and raw:
        last = raw[-1]
        if isinstance(last, dict) and last.get("url"):
            return last["url"]
    return None


def _pick_stream(info: dict[str, Any], mode: str = "audio") -> Optional[str]:
    direct = info.get("url")
    if isinstance(direct, str) and direct:
        return direct
    formats = info.get("formats")
    if not isinstance(formats, list):
        return None
    if mode == "video":
        video = [
            f for f in formats
            if isinstance(f, dict)
            and f.get("vcodec") not in (None, "none")
            and f.get("acodec") not in (None, "none")
            and f.get("url")
            and f.get("ext") == "mp4"
            and not str(f.get("protocol") or "").startswith("m3u8")
        ]
        if video:
            def score(f: dict[str, Any]) -> tuple[int, int, int]:
                height = int(f.get("height") or 0)
                mp4 = 1 if f.get("ext") == "mp4" else 0
                h264 = 1 if str(f.get("vcodec") or "").startswith("avc1") else 0
                bounded = height if height <= 720 else 0
                return (mp4, h264, bounded or -height)
            video.sort(key=score, reverse=True)
            return video[0].get("url")
        return None
    audio_only = [
        f for f in formats
        if isinstance(f, dict)
        and f.get("vcodec") in (None, "none")
        and f.get("url")
    ]
    if audio_only:
        audio_only.sort(key=lambda f: f.get("abr") or 0, reverse=True)
        return audio_only[0].get("url")
    return None


def _flat_items(payload: bytes) -> list[dict[str, Any]]:
    """Parse --flat-playlist NDJSON output into [{title, url, thumbnail}]."""
    items: list[dict[str, Any]] = []
    for line in payload.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        url = entry.get("url") or entry.get("webpage_url")
        if not url:
            continue
        items.append(
            {
                "title": entry.get("title") or "",
                "url": url,
                "thumbnail": _normalise_thumbnail(entry.get("thumbnails") or entry.get("thumbnail")),
            }
        )
    return items


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True, "service": "streaming"}


async def _fetch_proxy_chunk(
    stream_url: str,
    headers: dict[str, str],
    timeout: httpx.Timeout,
    max_bytes: int,
) -> tuple[int, dict[str, str], bytes]:
    data = bytearray()
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=False) as client:
        async with client.stream("GET", stream_url, headers=headers) as upstream:
            async for chunk in upstream.aiter_bytes():
                if not chunk:
                    continue
                remaining = max_bytes - len(data)
                data.extend(chunk[:remaining])
                if len(data) >= max_bytes:
                    break
            return upstream.status_code, dict(upstream.headers), bytes(data)


@app.get("/api/stream/proxy/{token}")
async def proxy_stream(token: str, request: Request):
    entry = _STREAM_PROXY_CACHE.get(token)
    if entry is None:
        return JSONResponse({"error": "stream_not_found"}, status_code=404)

    expires_at, source_url, stream_url, upstream_headers, mode = entry
    if source_url and expires_at - time.time() < _STREAM_PROXY_REFRESH_LEAD_SEC:
        _get_refresh_task(token, source_url, mode)
    if expires_at <= time.time():
        if not source_url:
            _STREAM_PROXY_CACHE.pop(token, None)
            return JSONResponse({"error": "stream_expired"}, status_code=410)
        try:
            expires_at, stream_url, upstream_headers, mode = await _await_refresh_task(token, source_url, mode)
        except Exception as exc:
            return JSONResponse({"error": "stream_refresh_failed", "detail": str(exc)}, status_code=502)

    start, requested_end = _range_bounds(request.headers.get("range"))
    max_end = start + _STREAM_PROXY_CHUNK_SIZE - 1
    end = min(requested_end, max_end) if requested_end is not None else max_end
    max_bytes = end - start + 1
    timeout = httpx.Timeout(connect=30.0, read=_STREAM_PROXY_IDLE_TIMEOUT_SEC, write=30.0, pool=30.0)
    headers = _proxy_headers(upstream_headers, request, start, end)
    try:
        status_code, response_headers, content = await _fetch_proxy_chunk(stream_url, headers, timeout, max_bytes)
    except Exception as exc:
        return JSONResponse({"error": "stream_proxy_failed", "detail": str(exc)}, status_code=502)

    if (status_code in (403, 410, 416) or not content) and source_url:
        try:
            expires_at, stream_url, upstream_headers, mode = await _await_refresh_task(token, source_url, mode)
            headers = _proxy_headers(upstream_headers, request, start, end)
            status_code, response_headers, content = await _fetch_proxy_chunk(stream_url, headers, timeout, max_bytes)
        except Exception as exc:
            return JSONResponse({"error": "stream_refresh_failed", "detail": str(exc)}, status_code=502)

    passthrough: dict[str, str] = {
        "cache-control": "no-store",
        "accept-ranges": "bytes",
        "content-length": str(len(content)),
    }
    content_type = response_headers.get("content-type")
    if content_type:
        passthrough["content-type"] = content_type
    content_range = response_headers.get("content-range")
    if content_range:
        passthrough["content-range"] = content_range

    return Response(
        content=content,
        status_code=206 if status_code < 400 else status_code,
        headers=passthrough,
        media_type=content_type,
    )


@app.get("/api/stream/resolve")
async def resolve(url: str = Query(..., min_length=1, max_length=2048), mode: str = Query("audio")) -> JSONResponse:
    err = _validate_url(url)
    if err is not None:
        return JSONResponse({"error": err}, status_code=400)

    if mode not in ("audio", "video"):
        return JSONResponse({"error": "bad_mode"}, status_code=400)
    cache_key = f"{mode}:{url}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return JSONResponse(cached)

    async with _CACHE_LOCK:
        cached = _cache_get(cache_key)
        if cached is not None:
            return JSONResponse(cached)
        payload = await _resolve_uncached(url, mode)
        _cache_put(cache_key, payload)
        _PREWARM_ERRORS.pop(url, None)
        return JSONResponse(payload)


@app.post("/api/stream/prewarm")
async def prewarm(request: Request) -> JSONResponse:
    body = await request.json()
    urls = body.get("urls")
    if isinstance(urls, str):
        urls = [urls]
    if not isinstance(urls, list):
        return JSONResponse({"error": "bad_urls"}, status_code=400)

    accepted: list[str] = []
    for raw_url in urls[:50]:
        if not isinstance(raw_url, str):
            continue
        url = raw_url.strip()
        if not url or len(url) > 2048 or _validate_url(url) is not None:
            continue
        accepted.append(url)
        cache_key = f"audio:{url}"
        if _cache_get(cache_key) is None and url not in _PREWARM_TASKS:
            _PREWARM_TASKS[url] = asyncio.create_task(_prewarm_url(url))
    return JSONResponse({"ok": True, "accepted": accepted})


@app.get("/api/stream/ready")
async def ready(url: str = Query(..., min_length=1, max_length=2048)) -> JSONResponse:
    err = _validate_url(url)
    if err is not None:
        return JSONResponse({"ready": False, "error": err}, status_code=400)
    cache_key = f"audio:{url}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return JSONResponse({"ready": True, "payload": cached})
    if url in _PREWARM_TASKS:
        return JSONResponse({"ready": False, "pending": True})
    error = _PREWARM_ERRORS.get(url)
    if error:
        return JSONResponse({"ready": False, "error": error}, status_code=502)
    return JSONResponse({"ready": False})


async def _prewarm_url(url: str) -> None:
    cache_key = f"audio:{url}"
    try:
        async with _CACHE_LOCK:
            if _cache_get(cache_key) is None:
                _cache_put(cache_key, await _resolve_uncached(url))
            _PREWARM_ERRORS.pop(url, None)
    except Exception as exc:
        _PREWARM_ERRORS[url] = str(exc)[:240]
    finally:
        _PREWARM_TASKS.pop(url, None)


async def _resolve_uncached(url: str, mode: str = "audio") -> dict[str, Any]:
    is_playlist = _is_playlist_url(url)
    if is_playlist:
        rc, out, errbuf = await _run_yt_dlp(
            [
                "--flat-playlist",
                "--no-warnings",
                "-J",
                url,
            ]
        )
        if rc != 0:
            detail = errbuf.decode("utf-8", "replace")[:400]
            raise HTTPException(status_code=502, detail=f"yt_dlp_failed: {detail}")
        try:
            top = json.loads(out.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            raise HTTPException(status_code=502, detail="bad_json")
        entries = top.get("entries") or []
        items: list[dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            item_url = entry.get("url") or entry.get("webpage_url")
            if not item_url:
                continue
            items.append(
                {
                    "title": entry.get("title") or "",
                    "url": item_url,
                    "thumbnail": _normalise_thumbnail(
                        entry.get("thumbnails") or entry.get("thumbnail")
                    ),
                }
            )
        payload: dict[str, Any] = {
            "is_playlist": True,
            "title": top.get("title") or "",
            "thumbnail": _normalise_thumbnail(top.get("thumbnails") or top.get("thumbnail")),
            "items": items,
        }
        if items:
            try:
                first = await _resolve_single(items[0]["url"], mode)
                if first.get("stream_url"):
                    payload["stream_url"] = first["stream_url"]
                    payload["duration"] = first.get("duration")
                    payload["expires_at"] = first.get("expires_at")
                    if not payload.get("title"):
                        payload["title"] = first.get("title", "")
                    if not payload.get("thumbnail"):
                        payload["thumbnail"] = first.get("thumbnail")
            except HTTPException:
                pass
        return payload

    return await _resolve_single(url, mode)

async def _resolve_single(url: str, mode: str = "audio") -> dict[str, Any]:
    fmt = (
        "best[ext=mp4][acodec!=none][vcodec!=none][protocol^=http][height<=720]/"
        "best[ext=mp4][acodec!=none][vcodec!=none][protocol^=http]"
        if mode == "video"
        else "bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio/best"
    )
    rc, out, errbuf = await _run_yt_dlp([
        "-f", fmt, "--no-playlist", "--no-warnings", "-j", url,
    ])
    if rc != 0:
        detail = errbuf.decode("utf-8", "replace")[:400]
        raise HTTPException(status_code=502, detail=f"yt_dlp_failed: {detail}")
    try:
        info = json.loads(out.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="bad_json")
    stream_url = _pick_stream(info, mode)
    if not stream_url:
        raise HTTPException(status_code=404, detail="no_video_format" if mode == "video" else "no_audio_format")
    expires_at = time.time() + CACHE_TTL_SEC
    upstream_headers = {
        str(k).lower(): str(v)
        for k, v in (info.get("http_headers") or {}).items()
        if isinstance(k, str) and isinstance(v, str)
    }
    return {
        "stream_url": _cache_proxy_stream(url, stream_url, expires_at, upstream_headers, mode),
        "title": info.get("title") or "",
        "duration": info.get("duration"),
        "thumbnail": _normalise_thumbnail(info.get("thumbnails") or info.get("thumbnail")),
        "expires_at": expires_at,
        "is_playlist": False,
        "stream_kind": mode,
    }
