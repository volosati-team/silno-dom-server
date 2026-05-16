#!/usr/bin/env bash
# stop.sh — остановить все процессы silno-dom-server

pkill -f home_mqtt_bridge.py 2>/dev/null && echo "bridge stopped" || echo "bridge not running"
pkill -f "uvicorn web.app:app" 2>/dev/null && echo "web stopped" || echo "web not running"
pkill -x mosquitto 2>/dev/null && echo "mosquitto stopped" || echo "mosquitto not running"
