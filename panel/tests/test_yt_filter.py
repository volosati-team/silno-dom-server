"""TDD probe: which YT video IDs are «embeddable» according to YT Data API.

Used to validate the backend heuristic filter in panel/app.py. Requires
YOUTUBE_API_KEY in env. Run from project root:

    python3 -m pytest panel/tests/test_yt_filter.py -v

or stand-alone:

    YOUTUBE_API_KEY=... python3 panel/tests/test_yt_filter.py
"""

from __future__ import annotations

import os
import sys
import json
import urllib.request
import urllib.parse


KNOWN_OK = {
    # Embeddable, plays in iframe everywhere known.
    "3nQNiWdeH2Q": "Janji — Heroes Tonight (NCS)",
    "n61ULEU7CO0": "Best of lofi hip hop 2021 (Lofi Girl)",
    "CIImA2gVoCc": "Dark Jazz & Cinematic Trip-Hop",
}

KNOWN_BLOCKED = {
    # Label-locked, owner reports «Video unavailable» in iframe.
    "4aeETEoNfOg": "Smashing Pumpkins — 1979",
    "kJQP7kiw5Fk": "Luis Fonsi — Despacito",
    "9bZkp7q19f0": "PSY — Gangnam Style",
}


def fetch_metadata(video_ids):
    """Return {video_id: dict(channelTitle, embeddable, regionBlocked, ytAgeRestricted)}."""
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        raise SystemExit("YOUTUBE_API_KEY required")
    ids_csv = ",".join(video_ids)
    url = (
        "https://www.googleapis.com/youtube/v3/videos?"
        + urllib.parse.urlencode({
            "part": "snippet,status,contentDetails",
            "id": ids_csv,
            "key": key,
        })
    )
    with urllib.request.urlopen(url, timeout=15) as r:
        data = json.loads(r.read().decode())
    out = {}
    for it in data.get("items", []):
        vid = it.get("id")
        sn = it.get("snippet") or {}
        st = it.get("status") or {}
        cd = it.get("contentDetails") or {}
        region = (cd.get("regionRestriction") or {})
        rating = (cd.get("contentRating") or {})
        out[vid] = {
            "channelTitle": sn.get("channelTitle", ""),
            "embeddable": st.get("embeddable", True),
            "privacyStatus": st.get("privacyStatus", ""),
            "regionBlocked": sorted(region.get("blocked") or []),
            "regionAllowed": sorted(region.get("allowed") or []),
            "ytRating": rating.get("ytRating", ""),
        }
    return out


def should_drop(meta):
    """Heuristic: should this result be filtered out before showing to user."""
    if not meta.get("embeddable", True):
        return ("embeddable=false",)
    ps = meta.get("privacyStatus")
    if ps and ps not in ("public", "unlisted"):
        return (f"privacyStatus={ps}",)
    if meta.get("ytRating") == "ytAgeRestricted":
        return ("age-restricted",)
    if "VEVO" in (meta.get("channelTitle") or "").upper():
        return ("VEVO-channel",)
    # regionRestriction.blocked includes RU for many label-locked — drop those
    # since the wall panel is in Russia.
    if "RU" in meta.get("regionBlocked", []):
        return ("region-blocked-RU",)
    return None


def main():
    all_ids = list(KNOWN_OK) + list(KNOWN_BLOCKED)
    meta = fetch_metadata(all_ids)

    fp_ok = []  # OK videos that we mistakenly drop
    fn_bad = []  # bad videos that we keep
    for vid, label in KNOWN_OK.items():
        m = meta.get(vid, {})
        reason = should_drop(m)
        status = "KEEP" if not reason else f"DROP({','.join(reason)})"
        print(f"  OK  {vid:11}  {label:40}  → {status}  [{m.get('channelTitle')}]")
        if reason:
            fp_ok.append((vid, label, reason, m))
    for vid, label in KNOWN_BLOCKED.items():
        m = meta.get(vid, {})
        reason = should_drop(m)
        status = "KEEP" if not reason else f"DROP({','.join(reason)})"
        print(f"  BAD {vid:11}  {label:40}  → {status}  [{m.get('channelTitle')}]")
        if not reason:
            fn_bad.append((vid, label, m))

    print()
    print(f"false positives (OK dropped): {len(fp_ok)}")
    print(f"false negatives (bad kept):   {len(fn_bad)}")
    if fn_bad:
        print("\nfalse negatives details:")
        for vid, label, m in fn_bad:
            print(f"  {vid} {label}: {json.dumps(m, ensure_ascii=False)}")
    return 0 if not fp_ok and not fn_bad else 1


if __name__ == "__main__":
    sys.exit(main())
