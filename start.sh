#!/usr/bin/env bash
# start.sh — запуск silno-dom-server в WSL
# Вызывается из Task Scheduler при логоне Windows.
# Переменные окружения можно переопределить в .env рядом с этим файлом.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Загрузить .env если есть
[ -f "$SCRIPT_DIR/.env" ] && set -a && source "$SCRIPT_DIR/.env" && set +a

mkdir -p logs

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a logs/start.log; }

# Windows host setup — firewall, portproxy cleanup, tinyproxy (idempotent, runs with elevated privileges via Task Scheduler)
_win_setup() {
    # Firewall: panel port 8080 must be allowed inbound
    if netsh.exe advfirewall firewall show rule name=silno-panel-8080 > /dev/null 2>&1; then
        log "WIN: firewall 8080 OK"
    else
        log "WIN: adding firewall rule for port 8080..."
        netsh.exe advfirewall firewall add rule \
            name="silno-panel-8080" dir=in action=allow protocol=TCP localport=8080 \
            > /dev/null 2>&1 \
            && log "WIN: firewall 8080 added" \
            || log "WIN WARNING: firewall 8080 add failed — panel may be unreachable from LAN"
    fi

    # Firewall: tinyproxy port 3128 must be allowed inbound (tablet LAN media proxy)
    if netsh.exe advfirewall firewall show rule name=tinyproxy-3128 > /dev/null 2>&1; then
        log "WIN: firewall 3128 OK"
    else
        log "WIN: adding firewall rule for port 3128 (tinyproxy)..."
        netsh.exe advfirewall firewall add rule \
            name="tinyproxy-3128" dir=in action=allow protocol=TCP localport=3128 \
            > /dev/null 2>&1 \
            && log "WIN: firewall 3128 added" \
            || log "WIN WARNING: firewall 3128 add failed — tablet media proxy may not work"
    fi

    # Portproxy: remove broken 8080 entry (WSL2 mirrored networking handles LAN natively)
    if netsh.exe interface portproxy show all 2>/dev/null | grep -q ":8080"; then
        log "WIN: removing stale portproxy for 8080..."
        netsh.exe interface portproxy delete v4tov4 listenport=8080 listenaddress=0.0.0.0 \
            > /dev/null 2>&1 \
            && log "WIN: portproxy 8080 removed" \
            || log "WIN WARNING: portproxy 8080 remove failed"
    fi

    # Tinyproxy: tablet LAN media proxy (port 3128, RKN bypass)
    if pgrep -x tinyproxy > /dev/null 2>&1; then
        log "WIN: tinyproxy running OK"
    else
        log "WIN: tinyproxy not running — starting via powershell..."
        powershell.exe -NonInteractive -File 'C:\Users\volosati\Scripts\tinyproxy_start.ps1' \
            > /dev/null 2>&1 \
            && log "WIN: tinyproxy start OK" \
            || log "WIN WARNING: tinyproxy start failed"
    fi
}

if command -v powershell.exe > /dev/null 2>&1; then
    _win_setup || log "WARNING: _win_setup returned errors (non-fatal)"
else
    log "powershell.exe not available — skipping Windows host setup"
fi

# MQTT password file — create from env or defaults (silnodom/12345)
export MQTT_USER="${MQTT_USER:-silnodom}"
export MQTT_PASS="${MQTT_PASS:-12345}"
if [ ! -f "$SCRIPT_DIR/mqtt_passwords" ]; then
    log "creating mqtt_passwords for user ${MQTT_USER}..."
    mosquitto_passwd -c -b "$SCRIPT_DIR/mqtt_passwords" "$MQTT_USER" "$MQTT_PASS" \
        || log "WARNING: mosquitto_passwd failed — MQTT running without auth"
    [ -f "$SCRIPT_DIR/mqtt_passwords" ] && log "mqtt_passwords created"
fi

# Mosquitto
if pgrep -x mosquitto > /dev/null; then
    log "mosquitto already running, skip"
else
    log "starting mosquitto..."
    mosquitto -c mosquitto_open.conf -d
fi

# MQTT bridge
if pgrep -f home_mqtt_bridge.py > /dev/null; then
    log "bridge already running, skip"
else
    log "starting bridge..."
    nohup python3 home_mqtt_bridge.py >> logs/bridge.log 2>&1 &
    log "bridge pid=$!"
fi

# DragonFly (Redis-compatible KV) - master state store for light cmd/state
if pgrep -x dragonfly > /dev/null; then
    log "dragonfly already running, skip"
else
    log "starting dragonfly..."
    nohup dragonfly --bind 127.0.0.1 --port "${REDIS_PORT:-6379}" --dir /tmp >> logs/dragonfly.log 2>&1 &
    log "dragonfly pid=$!"
fi

# Web UI
if pgrep -f "uvicorn web.app:app" > /dev/null; then
    log "web already running, skip"
else
    log "starting web UI..."
    nohup python3 -m uvicorn web.app:app --host 0.0.0.0 --port "${WEB_PORT:-8081}" >> logs/web.log 2>&1 &
    log "web pid=$!"
fi

# Media panel — stable (port 8080) — runs from git worktree locked to main
STABLE_DIR="$(dirname "$SCRIPT_DIR")/silno-dom-server-stable"
if pgrep -f "panel.app:app.*--port ${PANEL_PORT:-8080}" > /dev/null; then
    log "panel (stable) already running on ${PANEL_PORT:-8080}, skip"
elif [ -d "$STABLE_DIR" ]; then
    log "starting stable panel from worktree $STABLE_DIR (port ${PANEL_PORT:-8080})..."
    mkdir -p "$STABLE_DIR/logs"
    (cd "$STABLE_DIR" && nohup python3 -m uvicorn panel.app:app --host 0.0.0.0 --port "${PANEL_PORT:-8080}" >> logs/panel.log 2>&1) &
    log "panel (stable) pid=$!"
else
    log "WARNING: worktree $STABLE_DIR not found — stable panel NOT started on 8080"
    log "  Run: git worktree add ../silno-dom-server-stable main"
fi

# Media panel — dev (port 8082) — runs from current dev directory
if pgrep -f "panel.app:app.*--port ${DEV_PANEL_PORT:-8082}" > /dev/null; then
    log "panel (dev) already running on ${DEV_PANEL_PORT:-8082}, skip"
else
    log "starting dev panel (port ${DEV_PANEL_PORT:-8082})..."
    nohup python3 -m uvicorn panel.app:app --host 0.0.0.0 --port "${DEV_PANEL_PORT:-8082}" >> logs/panel-dev.log 2>&1 &
    log "dev panel pid=$!"
fi

# DragonFly <-> MQTT bridge (translates light:chN:cmd keyspace events to MQTT)
if pgrep -f dragonfly_mqtt_bridge.py > /dev/null; then
    log "dragonfly bridge already running, skip"
else
    log "starting dragonfly bridge..."
    nohup python3 dragonfly_mqtt_bridge.py >> logs/dragonfly_bridge.log 2>&1 &
    log "dragonfly bridge pid=$!"
fi

# Media panel — logic-dev (port 8084) — runs from git worktree locked to logic-dev
LOGIC_DIR="$(dirname "$SCRIPT_DIR")/silno-dom-server-logic"
LOGIC_PORT="${LOGIC_PANEL_PORT:-8084}"
if pgrep -f "panel.app:app.*--port ${LOGIC_PORT}" > /dev/null; then
    log "panel (logic) already running on ${LOGIC_PORT}, skip"
elif [ -d "$LOGIC_DIR" ]; then
    log "starting logic panel from worktree $LOGIC_DIR (port ${LOGIC_PORT})..."
    mkdir -p "$LOGIC_DIR/logs"
    (cd "$LOGIC_DIR" && nohup python3 -m uvicorn panel.app:app --host 0.0.0.0 --port "${LOGIC_PORT}" >> logs/panel-logic.log 2>&1) &
    log "logic panel pid=$!"
else
    log "WARNING: worktree $LOGIC_DIR not found — logic panel NOT started on ${LOGIC_PORT}"
    log "  Run: git worktree add ../silno-dom-server-logic logic-dev"
fi

# Audio streaming resolver (yt-dlp wrapper for kiosk native <audio>)
if pgrep -f "uvicorn streaming.app:app" > /dev/null; then
    log "streaming already running, skip"
else
    log "starting streaming server..."
    nohup python3 -m uvicorn streaming.app:app --host 0.0.0.0 --port "${STREAMING_PORT:-8083}" >> logs/streaming.log 2>&1 &
    log "streaming pid=$!"
fi

# CF Tunnel (если cloudflared установлен)
if command -v cloudflared &>/dev/null; then
    if pgrep -x cloudflared > /dev/null; then
        log "cloudflared already running, skip"
    else
        log "starting CF tunnel..."
        truncate -s 0 logs/cf.log 2>/dev/null || true   # clear stale URLs before fresh start
        nohup cloudflared tunnel --url "http://localhost:${PANEL_PORT:-8080}" >> logs/cf.log 2>&1 &
        log "cloudflared pid=$! — URL появится в logs/cf.log через ~5 сек"
    fi
fi

log "done. stable panel: http://localhost:${PANEL_PORT:-8080}"
log "done.    dev panel: http://localhost:${DEV_PANEL_PORT:-8082}"
log "done.  logic panel: http://localhost:${LOGIC_PORT:-8084}"
log "done.  light panel: http://localhost:${WEB_PORT:-8081}"
log "cf url:  grep 'trycloudflare.com' logs/cf.log"

# Auto-update: poll GitHub every 5 min, run update.sh when HEAD drifts from origin
if [ -f "$SCRIPT_DIR/logs/autoupdate.pid" ]; then
    _old=$(cat "$SCRIPT_DIR/logs/autoupdate.pid" 2>/dev/null)
    [ -n "$_old" ] && kill "$_old" 2>/dev/null || true
fi
(
    _branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    while true; do
        sleep "${AUTOUPDATE_INTERVAL:-300}"
        git fetch origin --quiet 2>/dev/null || continue
        _local=$(git rev-parse HEAD 2>/dev/null)
        _remote=$(git rev-parse "origin/$_branch" 2>/dev/null)
        [ -z "$_local" ] || [ -z "$_remote" ] && continue
        if [ "$_local" != "$_remote" ]; then
            echo "[$(date '+%H:%M:%S')] HEAD $_local → $_remote, running update.sh" \
                >> "$SCRIPT_DIR/logs/autoupdate.log"
            bash "$SCRIPT_DIR/update.sh"
            exit 0
        fi
    done
) >> logs/autoupdate.log 2>&1 &
echo "$!" > logs/autoupdate.pid
log "auto-update pid=$(cat logs/autoupdate.pid) interval=${AUTOUPDATE_INTERVAL:-300}s branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"

# Write tunnel URL to CF KV so workers pick it up automatically
if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_ACCOUNT_ID:-}" ]; then
    log "waiting for tunnel URL..."
    for i in $(seq 1 12); do
        TUNNEL_URL=$(grep -m1 'trycloudflare.com' logs/cf.log 2>/dev/null | grep -oP 'https://[^\s]+' | head -1)
        [ -n "$TUNNEL_URL" ] && break
        sleep 5
    done
    if [ -n "$TUNNEL_URL" ]; then
        curl -sf -X PUT \
            "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/fed3fe1caf3e464fbb582b03f2e5a4ab/values/ag_linux_ssh_url" \
            -H "Authorization: Bearer ${CF_API_TOKEN}" \
            -H "Content-Type: text/plain" \
            --data "$TUNNEL_URL" > /dev/null \
        && log "KV updated: $TUNNEL_URL" \
        || log "KV update failed"
    else
        log "tunnel URL not found in log, KV not updated"
    fi
fi
