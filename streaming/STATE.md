# Streaming state

## Current target

YouTube and SoundCloud must resolve, connect to audio streams, pass a silent 600+ second playback/hold check, and pass a browser-side panel smoke through the native audio path.

## Current result

Live hold artifacts show the backend target passing:

- YouTube: `ok: true`, `hold_sec: 631.7692766250111`, `resolve_status: 200`, `total_bytes: 10780672`, `last_content_type: audio/mp4`.
- SoundCloud: `ok: true`, `hold_sec: 634.2241537100635`, `resolve_status: 200`, `total_bytes: 9404416`, `last_content_type: audio/mpeg`.
- `/healthz`: `200`, body `{"ok":true,"service":"streaming"}`.

Panel/UI smoke artifact: `panel/live-ui-smoke.json`.

- YouTube native audio path: `ok: true`, `src: /api/stream/proxy/CUhFYrCKYFHgx_POiZ4PUarY`, `paused: false`, `readyState: 3`, `duration: 22257.905488`, proxy response `206`, `audio/mp4`.
- SoundCloud native audio path: `ok: true`, `src: /api/stream/proxy/DsYKim0swF04_ZZMw5IBUNVV`, `paused: false`, `readyState: 3`, `duration: 383.875011`, proxy response `206`, `audio/mpeg`.

## Current approach

The stream proxy avoids long blocking upstream reads. It uses bounded upstream streaming reads (`client.stream(...)`) and closes each upstream response after the requested chunk is read. Do not use full `client.get(...)` for long audio proxy paths.

Signed stream URLs are exposed to the panel only through same-origin proxy tokens. Proxy-token state is persisted to `/tmp/silno-stream-proxy-cache.json`, so a uvicorn worker restart does not turn an already issued `/api/stream/proxy/{token}` into `404`.

## Verification

A successful check requires factual JSON/log evidence from the live host:

- YouTube result `ok: true` with `hold_sec >= 600`.
- SoundCloud result `ok: true` with `hold_sec >= 600`.
- `/healthz` on the streaming worker still returns `200` after the hold.

Do not count runner completion, wakeup notification, or expected output-file behavior as proof until the JSON/log artifacts are read.

## Fallback if stuck

If a future implementation loop stops producing a passing 600+ second hold, stop iterating on the same hypothesis. Get an outside read: ask Opus or another independent reviewer to inspect the streaming/proxy design and the live test evidence before making more changes.
