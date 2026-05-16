#!/usr/bin/env python3
"""Quick MQTT diagnostic — subscribe to moio/# and home/# for 10s, print all messages."""
import paho.mqtt.client as mqtt
import time, os

HOST = os.getenv("HOME_HOST", "localhost")
PORT = int(os.getenv("HOME_PORT", "1883"))
USER = os.getenv("MQTT_USER", "silnodom")
PASS = os.getenv("MQTT_PASS", "12345")

msgs = []

def on_connect(c, ud, flags, rc):
    codes = {0:"OK",1:"bad proto",2:"bad id",3:"unavailable",4:"bad creds",5:"not auth"}
    print(f"[connect] rc={rc} ({codes.get(rc,'?')})")
    if rc == 0:
        c.subscribe([("moio/#", 0), ("home/#", 0)])
        print("[subscribe] moio/# and home/#")

def on_message(c, ud, m):
    line = f"  {m.topic} = {m.payload.decode(errors='replace')}"
    msgs.append(line)
    print(line)

c = mqtt.Client()
c.username_pw_set(USER, PASS)
c.on_connect = on_connect
c.on_message = on_message

print(f"Connecting to {HOST}:{PORT} as {USER} ...")
c.connect(HOST, PORT)
c.loop_start()
print("Listening 10s — click a button in the UI now...")
time.sleep(10)
c.loop_stop()
print(f"\n--- {len(msgs)} messages received ---")
if not msgs:
    print("SILENCE — MOiO is likely disconnected from Mosquitto")
