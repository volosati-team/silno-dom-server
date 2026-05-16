#!/usr/bin/env python3
"""Send a test SET command to the web app and print the response."""
import urllib.request, json, os

PORT = os.getenv("WEB_PORT", "8080")
url = f"http://localhost:{PORT}/set"
data = json.dumps({"ch3": True}).encode()
req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=5) as r:
        print(f"HTTP {r.status}: {r.read().decode()}")
except Exception as e:
    print(f"ERROR: {e}")
