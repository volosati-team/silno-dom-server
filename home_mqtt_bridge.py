#!/usr/bin/env python3
"""
home_mqtt_bridge.py — MOiO ↔ Central Mosquitto bridge.

Запускается на сервере Макса (где Mosquitto и где LAN-доступ к MOiO).

Функции:
  1. Читает реальное состояние каналов MOiO (subscribe на moio/...)
  2. Публикует в центральный Mosquitto с чистыми топиками:
       home/light/ch1/state  → "on" / "off"
       home/light/ch3/state  → "on" / "off"
  3. Слушает команды из центрального Mosquitto:
       home/light/ch1/set    → "on" / "off"
       home/light/ch3/set    → "on" / "off"
  4. Форвардит команды на MOiO через moio/…/on/set
  5. Каждые POLL_INTERVAL секунд — подтверждает состояние (retained)

Usage:
    python3 home_mqtt_bridge.py

Env / конфиг: см. CONFIG ниже.
"""

import os
import time
import logging
import paho.mqtt.client as mqtt

# ─── CONFIG ────────────────────────────────────────────────────────────────
MOIO_BROKER_HOST  = os.getenv("MOIO_HOST",    "192.168.28.160")
MOIO_BROKER_PORT  = int(os.getenv("MOIO_PORT", "1883"))

HOME_BROKER_HOST  = os.getenv("HOME_HOST",    "localhost")   # Max's Mosquitto
HOME_BROKER_PORT  = int(os.getenv("HOME_PORT", "1883"))

MOIO_MAC          = os.getenv("MOIO_MAC",     "782184803ce4")
ACTIVE_CHANNELS   = (1, 3)          # ch2 не подключён физически
POLL_INTERVAL     = 30              # секунды — heartbeat retained publish
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

# ─── TOPIC HELPERS ─────────────────────────────────────────────────────────

def moio_state_topic(ch: int) -> str:
    return f"moio/moio3ch/{MOIO_MAC}_ch{ch}/devices.capabilities.on_off/on"

def moio_cmd_topic(ch: int) -> str:
    return f"moio/moio3ch/{MOIO_MAC}_ch{ch}/devices.capabilities.on_off/on/set"

def home_state_topic(ch: int) -> str:
    return f"home/light/ch{ch}/state"

def home_cmd_topic(ch: int) -> str:
    return f"home/light/ch{ch}/set"

# ─── STATE CACHE ───────────────────────────────────────────────────────────
_state: dict[int, bool] = {}   # ch → True/False

# ─── MOIO CLIENT ───────────────────────────────────────────────────────────

class Bridge:
    def __init__(self):
        ver = mqtt.CallbackAPIVersion.VERSION2
        self.moio = mqtt.Client(ver, client_id="bridge-moio")
        self.home = mqtt.Client(ver, client_id="bridge-home")
        self.moio.on_connect = self._moio_on_connect
        self.moio.on_message = self._moio_on_message
        self.home.on_connect = self._home_on_connect
        self.home.on_message = self._home_on_message

    def _moio_on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            log.info("[moio] connected to %s:%s", MOIO_BROKER_HOST, MOIO_BROKER_PORT)
            for ch in ACTIVE_CHANNELS:
                client.subscribe(moio_state_topic(ch), qos=0)
        else:
            log.error("[moio] connect refused: %s", reason_code)

    def _moio_on_message(self, client, userdata, msg):
        payload = msg.payload.decode().strip().lower()
        for ch in ACTIVE_CHANNELS:
            if msg.topic == moio_state_topic(ch):
                val = payload in ("true", "1", "on")
                _state[ch] = val
                home_payload = "on" if val else "off"
                self.home.publish(home_state_topic(ch), home_payload, qos=1, retain=True)
                log.info("[state] ch%d = %s → home published %s", ch, payload, home_payload)

    def _home_on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            log.info("[home] connected to %s:%s", HOME_BROKER_HOST, HOME_BROKER_PORT)
            for ch in ACTIVE_CHANNELS:
                client.subscribe(home_cmd_topic(ch), qos=1)
        else:
            log.error("[home] connect refused: %s", reason_code)

    def _home_on_message(self, client, userdata, msg):
        payload = msg.payload.decode().strip().lower()
        for ch in ACTIVE_CHANNELS:
            if msg.topic == home_cmd_topic(ch):
                moio_payload = "true" if payload in ("on", "true", "1") else "false"
                self.moio.publish(moio_cmd_topic(ch), moio_payload, qos=1)
                log.info("[cmd] ch%d → moio = %s", ch, moio_payload)

    def run(self):
        self.home.connect(HOME_BROKER_HOST, HOME_BROKER_PORT, keepalive=60)
        self.moio.connect(MOIO_BROKER_HOST, MOIO_BROKER_PORT, keepalive=60)
        self.home.loop_start()
        self.moio.loop_start()
        log.info("Bridge running. MOIO=%s:%s  HOME=%s:%s",
                 MOIO_BROKER_HOST, MOIO_BROKER_PORT,
                 HOME_BROKER_HOST, HOME_BROKER_PORT)
        last_heartbeat = 0
        while True:
            now = time.time()
            if now - last_heartbeat >= POLL_INTERVAL:
                for ch, val in _state.items():
                    self.home.publish(home_state_topic(ch), "on" if val else "off",
                                      qos=1, retain=True)
                last_heartbeat = now
            time.sleep(1)


def main():
    Bridge().run()


if __name__ == "__main__":
    main()
