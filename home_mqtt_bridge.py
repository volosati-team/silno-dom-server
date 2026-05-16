#!/usr/bin/env python3
"""
home_mqtt_bridge.py — MOiO ↔ home topics bridge on a single local Mosquitto.

MOiO connects to localhost as a client. No separate broker needed.
Topics:
  moio/moio3ch/{MAC}_ch{N}/devices.capabilities.on_off/on     ← MOiO state (true/false)
  moio/moio3ch/{MAC}_ch{N}/devices.capabilities.on_off/on/set → commands (true/false)
  home/light/ch{N}/state   → bridge publishes for web UI (on/off)
  home/light/ch{N}/set     ← web UI publishes commands (on/off)
"""

import os
import time
import logging
import paho.mqtt.client as mqtt

# ─── CONFIG ────────────────────────────────────────────────────────────────
HOME_BROKER_HOST  = os.getenv("HOME_HOST",     "localhost")
HOME_BROKER_PORT  = int(os.getenv("HOME_PORT", "1883"))
MOIO_MAC          = os.getenv("MOIO_MAC",      "782184803ce4")
MQTT_USER         = os.getenv("MQTT_USER",     "")
MQTT_PASS         = os.getenv("MQTT_PASS",     "")
ACTIVE_CHANNELS   = (1, 3)
POLL_INTERVAL     = 30
# ────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler("home_mqtt_bridge.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)

def moio_state_topic(ch: int) -> str:
    return f"moio/moio3ch/{MOIO_MAC}_ch{ch}/devices.capabilities.on_off/on"

def moio_cmd_topic(ch: int) -> str:
    return f"moio/moio3ch/{MOIO_MAC}_ch{ch}/devices.capabilities.on_off/on/set"

def home_state_topic(ch: int) -> str:
    return f"home/light/ch{ch}/state"

def home_cmd_topic(ch: int) -> str:
    return f"home/light/ch{ch}/set"

_state: dict[int, bool] = {}


class Bridge:
    def __init__(self):
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="bridge")
        if MQTT_USER:
            self.client.username_pw_set(MQTT_USER, MQTT_PASS)
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code != 0:
            log.error("[bridge] connect refused: %s", reason_code)
            return
        log.info("[bridge] connected to %s:%s", HOME_BROKER_HOST, HOME_BROKER_PORT)
        for ch in ACTIVE_CHANNELS:
            t_state = moio_state_topic(ch)
            t_cmd   = home_cmd_topic(ch)
            client.subscribe(t_state, qos=0)
            client.subscribe(t_cmd,   qos=1)
            log.info("[subscribe] %s  |  %s", t_state, t_cmd)

    def _on_message(self, client, userdata, msg):
        payload = msg.payload.decode().strip().lower()
        for ch in ACTIVE_CHANNELS:
            if msg.topic == moio_state_topic(ch):
                val = payload in ("true", "1", "on")
                _state[ch] = val
                home_payload = "on" if val else "off"
                client.publish(home_state_topic(ch), home_payload, qos=1, retain=True)
                log.info("[state] ch%d = %s → home %s", ch, payload, home_payload)
            elif msg.topic == home_cmd_topic(ch):
                moio_payload = "true" if payload in ("on", "true", "1") else "false"
                client.publish(moio_cmd_topic(ch), moio_payload, qos=1)
                log.info("[cmd] ch%d → moio %s = %s", ch, moio_cmd_topic(ch), moio_payload)

    def run(self):
        self.client.connect(HOME_BROKER_HOST, HOME_BROKER_PORT, keepalive=60)
        self.client.loop_start()
        log.info("Bridge running. broker=%s:%s  MAC=%s", HOME_BROKER_HOST, HOME_BROKER_PORT, MOIO_MAC)
        last_heartbeat = 0
        while True:
            now = time.time()
            if now - last_heartbeat >= POLL_INTERVAL:
                for ch, val in _state.items():
                    self.client.publish(home_state_topic(ch), "on" if val else "off",
                                        qos=1, retain=True)
                last_heartbeat = now
            time.sleep(1)


def main():
    Bridge().run()


if __name__ == "__main__":
    main()
