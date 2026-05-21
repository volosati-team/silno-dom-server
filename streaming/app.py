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
import time
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


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
# yt-dlp can be slow on cold cache or large playlists. 30s matches the spec.
YT_DLP_TIMEOUT_SEC = 30

PLAYLIST_HINTS = ("/sets/", "/playlist/", "/album/", "list=", "/playlists/")


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
    return any(hint in low for hint in PLAYLIST_HINTS)


# ---------------------------------------------------------------------------
# yt-dlp wrapper
# ---------------------------------------------------------------------------

async def _run_yt_dlp(args: list[str]) -> tuple[int, bytes, bytes]:
    """Spawn yt-dlp with a hard timeout. Returns (rc, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        "yt-dlp",
        *args,
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


def _pick_stream(info: dict[str, Any]) -> Optional[str]:
    """Pull a direct audio URL out of yt-dlp's JSON metadata."""
    # Top-level url (single track via -f selection) is the happy path.
    direct = info.get("url")
    if isinstance(direct, str) and direct:
        return direct
    # Fallback: scan formats for an audio-only entry.
    formats = info.get("formats")
    if isinstance(formats, list):
        audio_only = [
            f for f in formats
            if isinstance(f, dict)
            and f.get("vcodec") in (None, "none")
            and f.get("url")
        ]
        if audio_only:
            # Prefer the one with the highest abr if reported.
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


@app.get("/api/stream/resolve")
async def resolve(url: str = Query(..., min_length=1, max_length=2048)) -> JSONResponse:
    err = _validate_url(url)
    if err is not None:
        return JSONResponse({"error": err}, status_code=400)

    cached = _cache_get(url)
    if cached is not None:
        return JSONResponse(cached)

    async with _CACHE_LOCK:
        # Double-check after acquiring the lock so concurrent requests for
        # the same URL collapse onto one yt-dlp invocation.
        cached = _cache_get(url)
        if cached is not None:
            return JSONResponse(cached)

        is_playlist = _is_playlist_url(url)
        if is_playlist:
            rc, out, errbuf = await _run_yt_dlp(
                [
                    "--flat-playlist",
                    "--no-warnings",
                    "-J",  # single JSON dump for the whole playlist
                    url,
                ]
            )
            if rc != 0:
                detail = errbuf.decode("utf-8", "replace")[:400]
                return JSONResponse(
                    {"error": "yt_dlp_failed", "detail": detail}, status_code=502
                )
            try:
                top = json.loads(out.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                return JSONResponse({"error": "bad_json"}, status_code=502)
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
            # Best-effort: also resolve the first item so the client can
            # autoplay immediately without a second round-trip.
            if items:
                try:
                    first = await _resolve_single(items[0]["url"])
                    if first.get("stream_url"):
                        payload["stream_url"] = first["stream_url"]
                        payload["duration"] = first.get("duration")
                        payload["expires_at"] = first.get("expires_at")
                        if not payload.get("title"):
                            payload["title"] = first.get("title", "")
                        if not payload.get("thumbnail"):
                            payload["thumbnail"] = first.get("thumbnail")
                except HTTPException:
                    # Don't fail the whole playlist resolve on one bad item.
                    pass
            _cache_put(url, payload)
            return JSONResponse(payload)

        payload = await _resolve_single(url)
        _cache_put(url, payload)
        return JSONResponse(payload)


async def _resolve_single(url: str) -> dict[str, Any]:
    rc, out, errbuf = await _run_yt_dlp(
        [
            "-f",
            "bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio",
            "--no-playlist",
            "--no-warnings",
            "-j",
            url,
        ]
    )
    if rc != 0:
        detail = errbuf.decode("utf-8", "replace")[:400]
        raise HTTPException(status_code=502, detail=f"yt_dlp_failed: {detail}")
    try:
        info = json.loads(out.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="bad_json")

    stream_url = _pick_stream(info)
    if not stream_url:
        raise HTTPException(status_code=404, detail="no_audio_format")

    return {
        "stream_url": stream_url,
        "title": info.get("title") or "",
        "duration": info.get("duration"),
        "thumbnail": _normalise_thumbnail(info.get("thumbnails") or info.get("thumbnail")),
        "expires_at": time.time() + CACHE_TTL_SEC,
        "is_playlist": False,
    }
