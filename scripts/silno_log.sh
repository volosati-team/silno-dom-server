#!/usr/bin/env bash
# Pull the latest panel dbg-log entries from voloNuk via the bridge.
# Usage: silno_log.sh [LIMIT]  (default 20, max ~100)
set -euo pipefail
LIMIT="${1:-20}"
TOKEN_FILE="${AG_BRIDGE_SECRET_FILE:-/home/superlisa/workspace/.secrets/ag_bridge_secret}"
TOKEN="$(cat "$TOKEN_FILE")"
URL="https://volonuk.tailf820d5.ts.net/exec"
BODY=$(printf '{"cmd":"wsl -d Debian -u mqtt-silno -- curl -s -m 5 http://localhost:8080/api/dbg-log/recent?limit=%s"}' "$LIMIT")
curl -s -m 25 -H "X-Bridge-Token: $TOKEN" -H "Content-Type: application/json" -d "$BODY" "$URL" \
  | python3 -c "
import sys, json, time
r = json.loads(sys.stdin.read())
inner = r.get('stdout','')
try:
    j = json.loads(inner)
except json.JSONDecodeError:
    print('bridge returned non-json:', inner[:300])
    sys.exit(1)
items = sorted(j.get('items', []), key=lambda x: x.get('ts', 0))
now = time.time()
for it in items:
    age = int(now - it.get('ts', 0))
    iid = it.get('id', '?')
    for e in it.get('entries', []):
        kind = e.get('type', '?')
        args = e.get('args') or [e.get('msg', '')] or []
        body = ' | '.join(str(a)[:240] for a in args)
        print(f'  id={iid} age={age}s {kind}: {body[:320]}')
"
