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

# Configure git HTTPS auth from env (needed on voloNuk where git config has no stored credentials)
if [ -n "${GITHUB_VOLOSATI_TOKEN:-}" ]; then
    git remote set-url origin \
        "https://volosati:${GITHUB_VOLOSATI_TOKEN}@github.com/volosati-team/silno-dom-server.git" \
        2>/dev/null || true
fi

# Pull latest in dev directory
git pull --ff-only && echo "[$(date '+%H:%M:%S')] git pull OK" || echo "[$(date '+%H:%M:%S')] git pull FAILED"

# Also pull worktrees so all ports stay in sync
for _wt_name in stable logic; do
    case "$_wt_name" in
        stable) _wt_dir="$(dirname "$SCRIPT_DIR")/silno-dom-server-stable"; _wt_branch="main" ;;
        logic)  _wt_dir="$(dirname "$SCRIPT_DIR")/silno-dom-server-logic"; _wt_branch="logic-dev" ;;
    esac
    if [ -d "$_wt_dir" ]; then
        git -C "$_wt_dir" pull --ff-only "origin" "$_wt_branch" 2>&1 \
            && echo "[$(date '+%H:%M:%S')] $_wt_name worktree pull OK" \
            || echo "[$(date '+%H:%M:%S')] $_wt_name worktree pull FAILED"
    fi
done

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
