#!/usr/bin/env python3
"""
silno-dom-server web UI — admin panel for smart home server.
Auth: single-user password (set WEB_PASSWORD env var, default: silnodom)
MQTT: connects to local Mosquitto, subscribes to home/light/+/state
Run: uvicorn app:app --host 0.0.0.0 --port 8080
"""

import os
import json
import secrets
import threading
import time
from pathlib import Path
from datetime import datetime

import paho.mqtt.client as mqtt
from fastapi import FastAPI, Request, Response, Form, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

# ─── CONFIG ────────────────────────────────────────────────────────────────
WEB_PASSWORD   = os.getenv("WEB_PASSWORD", "silnodom")
SESSION_SECRET = os.getenv("SESSION_SECRET", secrets.token_hex(32))
MQTT_HOST      = os.getenv("HOME_HOST",  "localhost")
MQTT_PORT      = int(os.getenv("HOME_PORT", "1883"))
CONF_PATH      = Path(__file__).parent.parent / "mosquitto_open.conf"

CHANNEL_NAMES  = {1: "Споты", 3: "Гирлянда"}
ACTIVE_CHANNELS = (1, 3)
# ────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="silno-dom server")
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

# ─── STATE ─────────────────────────────────────────────────────────────────
_state: dict = {ch: None for ch in ACTIVE_CHANNELS}   # None = unknown
_mqtt_connected = False
_sessions: dict[str, float] = {}   # token → expiry (unix)
SESSION_TTL = 8 * 3600             # 8 hours

# ─── MQTT CLIENT ───────────────────────────────────────────────────────────

def _start_mqtt():
    global _mqtt_connected

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

def _new_session() -> str:
    token = secrets.token_hex(24)
    _sessions[token] = time.time() + SESSION_TTL
    return token

def _valid_session(token: str | None) -> bool:
    if not token:
        return False
    exp = _sessions.get(token)
    if not exp:
        return False
    if time.time() > exp:
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
    return templates.TemplateResponse("login.html", {"request": request, "error": ""})

@app.post("/login")
async def login(password: str = Form(...)):
    if secrets.compare_digest(password, WEB_PASSWORD):
        token = _new_session()
        resp = RedirectResponse("/", status_code=302)
        resp.set_cookie("session", token, httponly=True, samesite="lax", max_age=SESSION_TTL)
        return resp
    return templates.TemplateResponse("login.html",
        {"request": {}, "error": "Неверный пароль"}, status_code=401)

@app.get("/logout")
async def logout(request: Request):
    token = request.cookies.get("session")
    _sessions.pop(token, None)
    resp = RedirectResponse("/login", status_code=302)
    resp.delete_cookie("session")
    return resp

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    _require_auth(request)
    lights = {
        ch: {
            "name": CHANNEL_NAMES.get(ch, f"ch{ch}"),
            "state": _state.get(ch),
        }
        for ch in ACTIVE_CHANNELS
    }
    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "lights": lights,
        "mqtt_ok": _mqtt_connected,
        "now": datetime.now().strftime("%H:%M:%S"),
    })

@app.post("/lights/{ch}/{cmd}")
async def set_light(ch: int, cmd: str, request: Request):
    _require_auth(request)
    if ch not in ACTIVE_CHANNELS or cmd not in ("on", "off"):
        raise HTTPException(400, "bad request")
    _mqtt_client.publish(f"home/light/ch{ch}/set", cmd, qos=1)
    return RedirectResponse("/", status_code=302)

@app.get("/config", response_class=HTMLResponse)
async def config_page(request: Request):
    _require_auth(request)
    conf_text = CONF_PATH.read_text() if CONF_PATH.exists() else "Файл не найден"
    return templates.TemplateResponse("config.html", {
        "request": request,
        "conf": conf_text,
        "mqtt_ok": _mqtt_connected,
        "mqtt_host": MQTT_HOST,
        "mqtt_port": MQTT_PORT,
    })

@app.get("/api/state")
async def api_state(request: Request):
    _require_auth(request)
    return {
        "mqtt_connected": _mqtt_connected,
        "lights": {f"ch{ch}": _state[ch] for ch in ACTIVE_CHANNELS},
    }
