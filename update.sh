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

# Pull latest in dev directory
git pull --ff-only && echo "[$(date '+%H:%M:%S')] git pull OK" || echo "[$(date '+%H:%M:%S')] git pull FAILED"

# Also pull stable worktree so 8080 stays in sync
STABLE_DIR="$(dirname "$SCRIPT_DIR")/silno-dom-server-stable"
if [ -d "$STABLE_DIR" ]; then
    git -C "$STABLE_DIR" pull --ff-only origin main 2>&1 \
        && echo "[$(date '+%H:%M:%S')] stable worktree pull OK" \
        || echo "[$(date '+%H:%M:%S')] stable worktree pull FAILED"
fi

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
