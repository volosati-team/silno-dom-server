#!/usr/bin/env python3
"""
silno-dom-server web UI — smart home panel.
Auth: multi-user (USERS dict). Dashboard + lights = public. Config/log = login required.
MQTT: connects to local Mosquitto, subscribes to home/light/+/state
Run: uvicorn app:app --host 0.0.0.0 --port 8080
"""

import os
import json
import secrets
import subprocess
import threading
import time
from pathlib import Path
from datetime import datetime

import paho.mqtt.client as mqtt
from fastapi import FastAPI, Request, Response, Form, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ─── CONFIG ────────────────────────────────────────────────────────────────
SESSION_SECRET = os.getenv("SESSION_SECRET", secrets.token_hex(32))
MQTT_HOST      = os.getenv("HOME_HOST",  "localhost")
MQTT_PORT      = int(os.getenv("HOME_PORT", "1883"))
MQTT_USER      = os.getenv("MQTT_USER", "")
MQTT_PASS      = os.getenv("MQTT_PASS", "")
CONF_PATH      = Path(__file__).parent.parent / "mosquitto_open.conf"
LOG_PATH       = Path(__file__).parent.parent / "home_mqtt_bridge.log"
LOG_TAIL_LINES = 200

CHANNEL_NAMES  = {1: "Споты", 3: "Гирлянда"}
ACTIVE_CHANNELS = (1, 3)

# username → password (empty string = no password required)
USERS: dict[str, str] = {
    "volosati": os.getenv("PASS_VOLOSATI", "12345"),
    "max":      os.getenv("PASS_MAX",      "12345"),
    "guest":    os.getenv("PASS_GUEST",    ""),
}
# ────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="silno-dom server")

# CORS: allow cross-origin requests from the media panel (different port)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

# ─── STATE ─────────────────────────────────────────────────────────────────
_state: dict = {ch: None for ch in ACTIVE_CHANNELS}   # MQTT feedback from device
_cmd:   dict = {ch: None for ch in ACTIVE_CHANNELS}   # last command sent
_mqtt_connected = False
_sessions: dict[str, dict] = {}    # token → {expiry, username}
SESSION_TTL = 8 * 3600             # 8 hours

# ─── MQTT CLIENT ───────────────────────────────────────────────────────────

def _start_mqtt():
    global _mqtt_connected, _state

    def on_connect(client, userdata, flags, reason_code, properties):
        global _mqtt_connected
        _mqtt_connected = (reason_code == 0)
        if _mqtt_connected:
            for ch in ACTIVE_CHANNELS:
                client.subscribe(f"home/light/ch{ch}/state", qos=0)

    def on_disconnect(client, userdata, disconnect_flags, reason_code, properties):
        global _mqtt_connected
        _mqtt_connected = False

    def on_message(client, userdata, msg):
        for ch in ACTIVE_CHANNELS:
            if msg.topic == f"home/light/ch{ch}/state":
                _state[ch] = msg.payload.decode().strip().lower() == "on"

    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="web-ui")
    if MQTT_USER:
        c.username_pw_set(MQTT_USER, MQTT_PASS)
    c.on_connect = on_connect
    c.on_disconnect = on_disconnect
    c.on_message = on_message

    def loop():
        while True:
            try:
                c.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
                c.loop_forever()
            except Exception:
                time.sleep(5)

    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return c

_mqtt_client = _start_mqtt()

# ─── AUTH ───────────────────────────────────────────────────────────────────

def _check_credentials(username: str, password: str) -> bool:
    expected = USERS.get(username)
    if expected is None:
        return False
    return secrets.compare_digest(password, expected)

def _new_session(username: str) -> str:
    token = secrets.token_hex(24)
    _sessions[token] = {"expiry": time.time() + SESSION_TTL, "username": username}
    return token

def _valid_session(token: str | None) -> bool:
    if not token:
        return False
    sess = _sessions.get(token)
    if not sess:
        return False
    if time.time() > sess["expiry"]:
        del _sessions[token]
        return False
    return True

def _require_auth(request: Request):
    token = request.cookies.get("session")
    if not _valid_session(token):
        raise HTTPException(status_code=302, headers={"Location": "/login"})

# ─── ROUTES ─────────────────────────────────────────────────────────────────

@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html", {"error": ""})

@app.post("/login")
async def login(request: Request, username: str = Form(...), password: str = Form("")):
    if _check_credentials(username.strip().lower(), password):
        token = _new_session(username.strip().lower())
        resp = RedirectResponse("/", status_code=302)
        resp.set_cookie("session", token, httponly=True, samesite="lax", max_age=SESSION_TTL)
        return resp
    return templates.TemplateResponse(request, "login.html", {"error": "Неверный логин или пароль"}, status_code=401)

@app.get("/logout")
async def logout(request: Request):
    token = request.cookies.get("session")
    _sessions.pop(token, None)
    resp = RedirectResponse("/login", status_code=302)
    resp.delete_cookie("session")
    return resp

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    lights = {
        ch: {
            "name": CHANNEL_NAMES.get(ch, f"ch{ch}"),
            "state": _state.get(ch),
            "cmd":   _cmd.get(ch),
        }
        for ch in ACTIVE_CHANNELS
    }
    return templates.TemplateResponse(request, "dashboard.html", {
        "lights": lights,
        "mqtt_ok": _mqtt_connected,
        "now": datetime.now().strftime("%H:%M:%S"),
        "logged_in": _valid_session(request.cookies.get("session")),
    })

@app.post("/lights/{ch}/{cmd}")
async def set_light(ch: int, cmd: str, request: Request):
    if ch not in ACTIVE_CHANNELS or cmd not in ("on", "off"):
        raise HTTPException(400, "bad request")
    _cmd[ch] = (cmd == "on")
    _mqtt_client.publish(f"home/light/ch{ch}/set", cmd, qos=1)
    return RedirectResponse("/", status_code=302)

@app.get("/config", response_class=HTMLResponse)
async def config_page(request: Request):
    _require_auth(request)
    conf_text = CONF_PATH.read_text() if CONF_PATH.exists() else "Файл не найден"
    try:
        git_hash = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(CONF_PATH.parent), text=True
        ).strip()
    except Exception:
        git_hash = "unknown"
    return templates.TemplateResponse(request, "config.html", {
        "conf": conf_text,
        "mqtt_ok": _mqtt_connected,
        "mqtt_host": MQTT_HOST,
        "mqtt_port": MQTT_PORT,
        "git_hash": git_hash,
        "logged_in": True,
    })

UPDATE_SCRIPT = Path(__file__).parent.parent / "update.sh"

@app.post("/admin/update")
async def admin_update(request: Request):
    _require_auth(request)
    if not UPDATE_SCRIPT.exists():
        raise HTTPException(500, "update.sh not found")
    subprocess.Popen(
        ["bash", str(UPDATE_SCRIPT)],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return JSONResponse({"status": "started"})

@app.get("/log", response_class=HTMLResponse)
async def log_page(request: Request):
    _require_auth(request)
    if LOG_PATH.exists():
        lines = LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-LOG_TAIL_LINES:]
    else:
        lines = []
    return templates.TemplateResponse(request, "log.html", {
        "lines": lines,
        "log_path": str(LOG_PATH),
        "logged_in": True,
    })

@app.get("/api/state")
async def api_state(request: Request):
    _require_auth(request)
    return {
        "mqtt_connected": _mqtt_connected,
        "lights": {f"ch{ch}": _state[ch] for ch in ACTIVE_CHANNELS},
    }

# ─── PUBLIC REST API (no auth) ──────────────────────────────────────────────

class SetPayload(BaseModel):
    ch1: bool | None = None
    ch3: bool | None = None

class TogglePayload(BaseModel):
    ch: str

@app.get("/state")
async def public_state():
    return {f"ch{ch}": _state.get(ch) for ch in ACTIVE_CHANNELS}

@app.post("/set")
async def public_set(payload: SetPayload):
    mapping = {1: payload.ch1, 3: payload.ch3}
    for ch, val in mapping.items():
        if val is not None:
            _cmd[ch] = val
            _mqtt_client.publish(f"home/light/ch{ch}/set", "on" if val else "off", qos=1)
    return {f"ch{ch}": _state.get(ch) for ch in ACTIVE_CHANNELS}

@app.post("/toggle")
async def public_toggle(payload: TogglePayload):
    try:
        ch = int(payload.ch.replace("ch", ""))
    except ValueError:
        raise HTTPException(400, "bad channel")
    if ch not in ACTIVE_CHANNELS:
        raise HTTPException(400, "unknown channel")
    current = _state.get(ch)
    cmd = "off" if current else "on"
    _cmd[ch] = (cmd == "on")
    _mqtt_client.publish(f"home/light/ch{ch}/set", cmd, qos=1)
    return {"ch": payload.ch, "cmd": cmd}
