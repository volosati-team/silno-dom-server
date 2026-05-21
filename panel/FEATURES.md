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

## Security migration — pre-prod gates

Current dev-stand passwords (`12345` everywhere — see root `README.md`) are
temporary. Before this stack is exposed beyond the LAN or carries anything
sensitive, the following are **mandatory** — no exceptions, no "later":

- **No password auth for shell.** SSH on every host (voloNuk Windows side
  and any WSL guest with sshd) — `PasswordAuthentication no`, key-only.
  Disable root login (`PermitRootLogin no`). Audit `authorized_keys` per
  user; remove anything stale.
- **MQTT over TLS, client certs preferred.** Mosquitto on `:8883` (TLS),
  username+password listener killed. MOiO firmware that doesn't support
  auth stays on its own listener bound to `127.0.0.1` only, behind the
  panel proxy. No bare `silnodom/12345` listener anywhere reachable from
  the LAN.
- **No naked secrets in `.env`.** Move every credential
  (`MQTT_PASS`, `PASS_VOLOSATI`, `PASS_MAX`, `CF_API_TOKEN`, bridge
  token, SC client secret) into a real secret store
  (1Password CLI / sops + age / Bitwarden) and resolve at process start.
  `.env` only holds non-secret config.
- **REST API tokens, rotated.** `/api/light/set`, `/api/light/toggle` and
  every write surface require a bearer token. Tokens rotated quarterly
  or sooner on compromise. Anonymous read of `/state` stays open by
  design but can be flipped off behind a feature flag.
- **HTTPS termination before docker.** Caddy or nginx in front of every
  internal service — no plain HTTP exposed even on the LAN edge once
  the project leaves dev. SC OAuth, Yandex / Spotify callbacks require
  this anyway.
- **Bridge token rotated, scoped.** Tailscale Funnel `http_exec_bridge`
  token (`AG_BRIDGE_SECRET`) rotated and scoped to a dedicated
  Tailscale ACL. No `cmd.exe`-style arbitrary exec on prod — replace
  with a narrow RPC surface (`pull`, `restart`, `read-log`,
  `read-dbg-log`).
- **Cloudflared tunnel scoped or killed.** `trycloudflare.com` ephemeral
  tunnels are fine for dev but anyone with the URL hits the panel.
  Move to named CF tunnel + Access-policy (Cloudflare Zero Trust), or
  drop public exposure entirely.
- **Audit the legacy `12345` blast radius before flip.** Inventory every
  place the old creds live: `mqtt_passwords`, `.env`, in-repo docs,
  any host's `.bash_history`, any backups. Rotate atomically, not
  one-by-one.

This block becomes the pre-prod checklist. No production traffic — anything
broader than a single Andrey-owned LAN — until every item is checked.

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
