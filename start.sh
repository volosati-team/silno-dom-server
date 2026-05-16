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

# MQTT password file — create from env or defaults (silnodom/12345)
MQTT_USER="${MQTT_USER:-silnodom}"
MQTT_PASS="${MQTT_PASS:-12345}"
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
        truncate -s 0 logs/cf.log 2>/dev/null || true   # clear stale URLs before fresh start
        nohup cloudflared tunnel --url "http://localhost:${WEB_PORT:-8080}" >> logs/cf.log 2>&1 &
        log "cloudflared pid=$! — URL появится в logs/cf.log через ~5 сек"
    fi
fi

log "done. local: http://localhost:${WEB_PORT:-8080}"
log "cf url:  grep 'trycloudflare.com' logs/cf.log"

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
