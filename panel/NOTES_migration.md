# Чеклист при переезде на новый сервер

Когда меняем хост (voloNuk → новый железо или другой провайдер), всё что
завязано на конкретный сервер придётся ротировать или переподключать.
Этот список держим актуальным.

## Credentials, требующие ротации

### YouTube Data API key
- **Где**: `.env` (`YOUTUBE_API_KEY`), также в workspace `.secrets/.env`.
- **Что**: создать новый ключ в GCP Console (или оставить старый — он не
  привязан к серверу), но **обязательно** в Application Restrictions →
  IP addresses **обновить IP** старого сервера на новый. Без этого
  YT API будет 403.
- Старый ключ можно удалить через https://console.cloud.google.com/apis/credentials

### SoundCloud OAuth client_id / token
- **Где**: `.env` (`SC_CLIENT_ID`, OAuth refresh_token в DragonFly).
- **Что**: client_id — глобальный, не привязан к серверу, переезжает как
  есть. Refresh tokens пользователей — тоже остаются валидными если
  DragonFly мигрируется со state. Если DragonFly начинает с нуля — все
  пользователи будут переподключаться через QR.

### Cloudflare API token / KV
- **Где**: `.env` (`CF_API_TOKEN`, `CF_ACCOUNT_ID`).
- **Что**: токен ротировать не нужно — он account-scoped. Но если token
  при создании был с IP restriction (которое мы умеем включать) — IP
  старого сервера обновить на новый в Cloudflare dashboard.

### AG_BRIDGE_SECRET
- **Где**: `.env` (`AG_BRIDGE_SECRET`), Windows env vars на voloNuk,
  workspace `.secrets/ag_bridge_secret`.
- **Что**: ротировать **все три точки атомарно** (или просто перенести
  существующий). Подробно — в `.secrets/CREDS_INDEX.md` под voloNuk.

### Tailscale Funnel URL
- **Где**: workspace docs ссылаются на `https://volonuk.tailf820d5.ts.net`.
- **Что**: каждый сервер с Tailscale имеет свой uniquetailnet hostname.
  При миграции новый хост получит другой `https://*.tailf820d5.ts.net`,
  нужно поменять все вхождения в:
  - `scripts/silno_log.sh`
  - workspace docs (`panel/STATE_STABLE.md`)
  - `.claude/system/system.md` (если упоминается)

## Сервисы, требующие переподключения

### MOiO 3-канальный реле
- WiFi-связь от реле в локальной сети. При смене WiFi-сети — реле снова
  спарить через MOiO app.
- MQTT bridge `home_mqtt_bridge.py` — переподключится сам если в `.env`
  тот же MQTT broker (но broker мы тоже переносим).

### Mosquitto MQTT broker
- Хранит ACL и passwd file (`mqtt_passwords`). При миграции — скопировать
  оба, иначе клиенты с auth теряют доступ.

### Bromite планшет на стене
- WiFi → новый сервер по новому IP. Локальный bookmark панели нужно
  обновить (`http://<NEW_IP>:8080/` или новое DNS-имя).

## Базы

### DragonFly KV
- Состояние: SC tokens, saved_playlists, light states. Дамп / restore
  через `redis-cli SAVE` → копировать `/tmp/dump.rdb` → восстановить.

### SQLite panel.db
- Лежит в `panel/data/panel.db`. Простое копирование файла.

## Файлы, которые точно переносить

- Весь репозиторий silno-dom-server (через git)
- `.env` (creds)
- `panel/data/panel.db`
- DragonFly dump
- `mqtt_passwords`
- `logs/` если нужны архивные логи

## Что протестировать после миграции

1. `https://<new_host>/ping` (или Tailscale) — bridge доступен
2. `http://localhost:8080/healthz` — panel живой
3. `http://localhost:8080/api/version` — отдаёт mtime
4. Свет включается через `/api/light/set` → реле срабатывает
5. SC widget грузится в saved-list
6. YT iframe плеит с `chrome://flags/#autoplay-policy = No user gesture`
7. YT search `/api/search?q=test` возвращает результаты (если ключ
   живой и IP restriction обновлён)

Когда придёт время миграции — пройти этот список и обновить любые
изменения с тех пор.
