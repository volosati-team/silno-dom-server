#!/usr/bin/env python3
"""Read tunnel URL from cf.log and push it to Cloudflare KV."""
import os, re, sys, urllib.request, urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CF_LOG = os.path.join(SCRIPT_DIR, "logs", "cf.log")
CF_API_TOKEN = os.getenv("CF_API_TOKEN", "")
CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
KV_NAMESPACE = "fed3fe1caf3e464fbb582b03f2e5a4ab"
KV_KEY = "ag_linux_ssh_url"

if not CF_API_TOKEN or not CF_ACCOUNT_ID:
    print("ERROR: CF_API_TOKEN and CF_ACCOUNT_ID must be set in .env")
    sys.exit(1)

try:
    with open(CF_LOG) as f:
        text = f.read()
except FileNotFoundError:
    print(f"ERROR: {CF_LOG} not found — cloudflared not running?")
    sys.exit(1)

urls = re.findall(r'https://[a-z0-9-]+\.trycloudflare\.com', text)
if not urls:
    print("ERROR: no trycloudflare.com URL found in cf.log")
    sys.exit(1)

tunnel_url = urls[-1]
print(f"Found URL: {tunnel_url}")

api_url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NAMESPACE}/values/{KV_KEY}"
req = urllib.request.Request(
    api_url,
    data=tunnel_url.encode(),
    headers={
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "text/plain",
    },
    method="PUT",
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"KV updated: {tunnel_url}  (HTTP {r.status})")
except urllib.error.HTTPError as e:
    print(f"KV update failed: HTTP {e.code} {e.reason}")
    sys.exit(1)
