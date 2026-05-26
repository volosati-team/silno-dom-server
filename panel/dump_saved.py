#!/usr/bin/env python3
"""Dump saved_playlists from SQLite KV to seed file.

Usage: python3 panel/dump_saved.py [--out panel/data/seed_saved_playlists.json]

Default: prints to stdout.
"""
import json
import sqlite3
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "panel.db"


def main() -> None:
    out_path = None
    if len(sys.argv) >= 3 and sys.argv[1] == "--out":
        out_path = Path(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] != "--help":
        out_path = Path(sys.argv[1])

    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT value FROM kv WHERE key = 'saved_playlists'").fetchone()
    conn.close()

    if row is None:
        print("[]" if out_path is None else "no data", file=sys.stderr)
        sys.exit(0)

    raw = row[0]
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        print(raw)
        sys.exit(0)

    pretty = json.dumps(parsed, ensure_ascii=False, indent=2) + "\n"

    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(pretty)
        print(f"Wrote {len(parsed)} items → {out_path}")
    else:
        print(pretty)


if __name__ == "__main__":
    main()
