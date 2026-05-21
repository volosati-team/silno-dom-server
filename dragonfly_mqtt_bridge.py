#!/usr/bin/env python3
"""
DragonFly <-> MQTT connector daemon.

Architecture:
  panel UI -> POST /api/light/set -> DragonFly SET light:chN:cmd
    -> keyspace notification __keyspace@0__:light:*:cmd
    -> publish MQTT home/light/chN/set on|off
  MQTT home/light/+/state -> DragonFly SET light:chN:state true|false
    -> panel UI GET /api/light/state -> MGET light:ch1:state light:ch3:state

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

CH_PATTERN = re.compile(r"^light:(ch\d+):cmd$")
STATE_TOPIC_PATTERN = re.compile(r"^home/light/(ch\d+)/state$")

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


def keyspace_listener():
    log.info("enabling keyspace notifications")
    _r.config_set("notify-keyspace-events", "K$")
    pubsub = _r.pubsub()
    pubsub.psubscribe("__keyspace@0__:light:*:cmd")
    log.info("subscribed to keyspace events")
    for ev in pubsub.listen():
        if ev.get("type") != "pmessage":
            continue
        if ev.get("data") != "set":
            continue
        key = ev["channel"].split(":", 1)[1]
        m = CH_PATTERN.match(key)
        if not m:
            continue
        ch = m.group(1)
        val = _r.get(key)
        payload = "on" if str(val).lower() == "true" else "off"
        _mqtt.publish(f"home/light/{ch}/set", payload, qos=1)
        log.info("cmd %s=%s -> mqtt", ch, payload)


def main():
    log.info("starting dragonfly_mqtt_bridge redis=%s mqtt=%s:%s", REDIS_URL, MQTT_HOST, MQTT_PORT)
    _mqtt.on_connect = on_mqtt_connect
    _mqtt.on_message = on_mqtt_message
    _mqtt.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    t = threading.Thread(target=keyspace_listener, daemon=True)
    t.start()
    _mqtt.loop_forever()


if __name__ == "__main__":
    while True:
        try:
            main()
        except Exception as exc:
            log.exception("bridge crashed: %s", exc)
            time.sleep(5)
