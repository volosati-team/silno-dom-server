# silno-dom panel — features & roadmap

Captured from owner intent (2026-05-21). README.md tracks current state; this
file tracks **what the panel should become**, grouped by status. Keep entries
short — each item is one user-facing capability or constraint.

---

## ✅ Done

- **DragonFly as central command bus.** Every device control path goes through
  Redis KV + pubsub at `127.0.0.1:6379`. UI never talks to MQTT or MOiO
  directly. New devices plug in by adding a connector that subscribes to its
  own pubsub channel and writes its state key.
- **Light control over DragonFly.** `light:cmd:set` PUBLISH → MQTT →
  MOiO 3-channel relay → physical light. State surfaced via `light:chN:state`.
  Works from phone, tablet, any LAN client.
- **Single-page kiosk UI on `:8080`.** SoundCloud / YouTube / Yandex Music
  embeds, light sliders, saved playlists, all in one screen.
- **Saved playlists in SQLite.** Replaces Cloudflare KV. Shared list across
  clients. `GET/PUT /api/saved-list`.
- **Yandex Music handler.** Recognises `music.yandex.ru/album/.../track/...`
  URLs, renders the `/iframe/#track/<trk>/<alb>` embed.
- **Inline debug console pane in the UI.** No F12 on the kiosk browser, so
  the panel exposes its own console: captures `console.*`, `window.onerror`,
  unhandled promise rejections, `fetch` requests, and button taps. Toggleable
  (`_lisaToggleConsole`), responsive (side pane in landscape, bottom in
  portrait), hidden by default in portrait mode.
- **Phone as universal remote.** Phone browser hitting the panel can control
  light and feed playlists.

---

## 🔄 In progress

- **Plan A — own streaming server (`:8083`).** yt-dlp resolves SoundCloud /
  YouTube / Yandex Music to a direct audio URL; panel plays it through a
  native HTML5 `<audio>` element. Bypasses the broken SC Widget iframe on
  Bromite v108 / Android 8.1 (kiosk hardware). 4-min in-memory cache because
  SC URLs are short-lived. Fallthrough route `/api/stream/*` → `:8083` keeps
  the surface same-origin.

---

## 📋 Roadmap — required, not yet built

### Hard requirement: tablet stays on, in the panel, forever

The iiyama touch panel must boot, open the panel UI, and never leave it.
No sleep, no notification shade pulling focus, no app launcher. Today this
is a manual App-Pinning workaround. Required pieces:

- Auto-launch the browser at boot pointing at the panel.
- Kiosk lock that prevents accidental navigation away.
- Wake-lock so the screen never sleeps while the panel is on.
- Auto-update path so a panel change rolls out without unlocking the device.

### Audio out — mandatory parallel layer

The browser cannot be the only audio path. Even after Plan A works, the
panel needs a **physical audio layer** that is independent of the kiosk
browser:

- Pair an external Bluetooth receiver with the room speakers.
- Any phone in the room pairs with the receiver and plays directly.
- The tablet panel is the controller (queue, light, navigation), not the
  speaker.

This is a parallel layer, not a replacement for Plan A. Both must exist.

### Update from UI

A button on the panel that:

- Pulls latest from `main` on the host.
- Restarts only what changed (panel / streaming / connector — not the
  whole stack).
- Surfaces success/failure in the UI without needing a terminal.

This is what makes "push to main = pre-approved merge" actually safe — the
owner can roll forward without leaving the kiosk.

### HTTPS termination before dockerisation

Caddy or nginx in front of every internal service. Required for SC OAuth,
future Yandex/Spotify callbacks, and any token-auth flow. Mandatory before
the stack gets containerised.

### WebView upgrade on the kiosk

Bromite SystemWebView APK is installed but not selectable in Developer
Options. Path forward unknown. Independent task — does not block panel
work, but unlocks better streaming options if solved.

---

## 💡 Open ideas — explore later

- **Own streaming "refuge" / library.** Self-hosted media library (likely
  MPD/Mopidy/Navidrome-class) on a dedicated port (`:8084` candidate). Local
  files + playlists + scrobbling. Useful when external streaming is broken
  or offline. Decision deferred — Plan A first.
- **Per-source isolated sub-app.** Move each provider (SC, YT, YaMusic) into
  its own small FastAPI service on its own port behind the panel proxy.
  Crash isolation, independent deploys. Decision deferred.
- **Dedicated user account for the panel on the host.** Right now everything
  runs under `ag-linux`. A panel-only system user reduces blast radius.
  Decision deferred.

---

## ❌ Deferred — known not-working, not-fixing-now

- **iOS Safari LAN access.** Both `silno.local` and `192.168.31.50:80{80,81}`
  time out from iPhone Safari. Other LAN clients work. Likely VLAN /
  Private-Address / cleartext-HTTP issue. Owner deferred; revisit after
  HTTPS migration.
- **mDNS multicast across VLANs.** `silno.local` resolves on the same VLAN
  but not from a guest network. Out of scope for the panel.
- **YouTube auto-generated playlists (`list=RD...`).** Expire within hours.
  Do not save them.
- **DragonFly keyspace notifications.** v1.38 ignores `notify-keyspace-events`.
  Use explicit pubsub channels (`light:cmd:set`) instead. Not a bug to fix —
  a design rule.
- **WSL2 self-loopback through Throne VPN.** `curl 127.0.0.1` returns 502
  from inside WSL. External clients are fine. Trust `pgrep` + logs, not
  self-curl.

---

## Architecture invariants

These are not features — they are constraints any new feature must respect.

- **DragonFly is the only command bus.** No direct HTTP from UI to a
  connector. New device = new connector + new pubsub channel.
- **Control layer (this panel) and audio layer (BT receiver) are
  independent.** Either can be down without taking the other.
- **English everywhere except Telegram replies.** Code, comments, commits,
  issues, PRs, docs — all English. Russian only in TG messages to the
  owner.
- **Panel-scoped merges are pre-approved.** Push to `main` directly for
  anything under `panel/` and related plumbing. `web/` (light UI) still
  requires owner heads-up — do not break light control.
- **Plain HTTP only until HTTPS migration is done.** Do not add OAuth
  callbacks or token-auth surfaces that require HTTPS until Caddy/nginx is
  in front.
