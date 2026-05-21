#!/usr/bin/env python3
"""
DragonFly <-> MQTT connector daemon.

Architecture:
  panel UI -> POST /api/light/set
    -> DragonFly SET light:chN:cmd (audit/last-value)
    -> DragonFly PUBLISH light:cmd:set "chN:true|false" (trigger)
    -> bridge SUBSCRIBE light:cmd:set
    -> MQTT publish home/light/chN/set on|off
  MQTT home/light/+/state -> DragonFly SET light:chN:state true|false
    -> panel UI GET /api/light/state -> MGET light:ch1:state light:ch3:state

DragonFly's CONFIG SET notify-keyspace-events is read-only (only Ex supported
at startup), so we use an explicit pubsub channel instead of keyspace events.

Lives alongside (not replacing) home_mqtt_bridge.py and web/app.py.
"""

import logging
import os
import re
import threading
import time
from pathlib import Path

import paho.mqtt.client as mqtt
import redis

LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_PATH = LOG_DIR / "dragonfly_bridge.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_PATH), logging.StreamHandler()],
)
log = logging.getLogger("dragonfly_bridge")

REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_USER = os.environ.get("MQTT_USER", "silnodom")
MQTT_PASS = os.environ.get("MQTT_PASS", "12345")

CMD_PAYLOAD_PATTERN = re.compile(r"^(ch\d+):(true|false)$")
STATE_TOPIC_PATTERN = re.compile(r"^home/light/(ch\d+)/state$")
CMD_CHANNEL = "light:cmd:set"

_r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
_mqtt = mqtt.Client(client_id="dragonfly_bridge", clean_session=True)
if MQTT_USER:
    _mqtt.username_pw_set(MQTT_USER, MQTT_PASS)


def on_mqtt_connect(client, userdata, flags, rc):
    log.info("mqtt connected rc=%s", rc)
    client.subscribe("home/light/+/state", qos=0)


def on_mqtt_message(client, userdata, msg):
    m = STATE_TOPIC_PATTERN.match(msg.topic)
    if not m:
        return
    ch = m.group(1)
    payload = msg.payload.decode(errors="replace").strip().lower()
    val = "true" if payload == "on" else "false" if payload == "off" else None
    if val is None:
        log.warning("unknown payload on %s: %r", msg.topic, payload)
        return
    _r.set(f"light:{ch}:state", val)
    log.info("state %s=%s", ch, val)


def cmd_listener():
    pubsub = _r.pubsub()
    pubsub.subscribe(CMD_CHANNEL)
    log.info("subscribed to redis channel %s", CMD_CHANNEL)
    for ev in pubsub.listen():
        if ev.get("type") != "message":
            continue
        data = ev.get("data")
        if not isinstance(data, str):
            continue
        m = CMD_PAYLOAD_PATTERN.match(data.strip())
        if not m:
            log.warning("bad cmd payload: %r", data)
            continue
        ch, val = m.group(1), m.group(2)
        payload = "on" if val == "true" else "off"
        _mqtt.publish(f"home/light/{ch}/set", payload, qos=1)
        log.info("cmd %s=%s -> mqtt", ch, payload)


def main():
    log.info("starting dragonfly_mqtt_bridge redis=%s mqtt=%s:%s", REDIS_URL, MQTT_HOST, MQTT_PORT)
    _mqtt.on_connect = on_mqtt_connect
    _mqtt.on_message = on_mqtt_message
    _mqtt.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    t = threading.Thread(target=cmd_listener, daemon=True)
    t.start()
    _mqtt.loop_forever()


if __name__ == "__main__":
    while True:
        try:
            main()
        except Exception as exc:
            log.exception("bridge crashed: %s", exc)
            time.sleep(5)
