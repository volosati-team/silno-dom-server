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

# Web UI
if pgrep -f "uvicorn web.app:app" > /dev/null; then
    log "web already running, skip"
else
    log "starting web UI..."
    nohup python3 -m uvicorn web.app:app --host 0.0.0.0 --port "${WEB_PORT:-8080}" >> logs/web.log 2>&1 &
    log "web pid=$!"
fi

# CF Tunnel (если cloudflared установлен)
if command -v cloudflared &>/dev/null; then
    if pgrep -x cloudflared > /dev/null; then
        log "cloudflared already running, skip"
    else
        log "starting CF tunnel..."
        nohup cloudflared tunnel --url "http://localhost:${WEB_PORT:-8080}" >> logs/cf.log 2>&1 &
        log "cloudflared pid=$! — URL появится в logs/cf.log через ~5 сек"
    fi
fi

log "done. local: http://localhost:${WEB_PORT:-8080}"
log "cf url:  grep 'trycloudflare.com' logs/cf.log"
