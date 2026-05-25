#!/usr/bin/env bash
# update.sh — pull latest code and restart all services
# Called by web UI: POST /admin/update (runs detached from server process)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p logs
exec >> logs/update.log 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] === update started ==="

# Wait for HTTP response to reach browser
sleep 2

# Load env
[ -f "$SCRIPT_DIR/.env" ] && set -a && source "$SCRIPT_DIR/.env" && set +a

# Pull latest
git pull --ff-only && echo "[$(date '+%H:%M:%S')] git pull OK" || echo "[$(date '+%H:%M:%S')] git pull FAILED"

# Stop services
pkill -f cloudflared 2>/dev/null; pkill -f home_mqtt_bridge 2>/dev/null
pkill -f "uvicorn web.app" 2>/dev/null
pkill -f "uvicorn panel.app" 2>/dev/null
pkill -f "uvicorn streaming.app" 2>/dev/null
pkill -x mosquitto 2>/dev/null
sleep 2

# Start all
bash "$SCRIPT_DIR/start.sh"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] === update done ==="
