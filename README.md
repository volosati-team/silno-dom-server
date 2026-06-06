# silno-dom-server

Серверная сторона умного дома: MQTT-мост MOiO ↔ Mosquitto + веб-панель управления освещением.

## Архитектура

```
MOiO (физическое реле) ──MQTT──► Mosquitto (localhost:1883)
                                        │
                          home_mqtt_bridge.py (мост)
                                        │
                          web/app.py (FastAPI, :8080)
                                        │
                          cloudflared (quick tunnel)
                                        │
                          CF Worker moio-control (постоянный URL)
                          https://moio-control.voloagents.workers.dev
```

MOiO подключается к локальному Mosquitto как клиент (не имеет своего брокера).
Мост транслирует между internal-топиками (`home/light/chN/…`) и MOiO-топиками
(`moio/moio3ch/{MAC}_chN/devices.capabilities.on_off/on[/set]`).

## Структура

```
silno-dom-server/
  home_mqtt_bridge.py     ← мост: internal Mosquitto ↔ MOiO topics
  mosquitto_open.conf     ← конфиг Mosquitto (порты 1883 + 9001 websockets)
  requirements.txt
  start.sh                ← запуск всех сервисов + CF tunnel + KV update
  stop.sh
  web/
    app.py                ← FastAPI: панель + REST API
    templates/
      login.html
      base.html
      dashboard.html      ← toggle-switch UI, JS polling
      config.html
      log.html
  workers/
    moio-control/         ← CF Worker: проксирует к tunnel URL из KV
    silno-mqtt/           ← CF Worker: legacy
```

## Конфигурация

Все параметры через `.env` (скопировать из `.env.example`):

| Переменная      | Описание                              | Дефолт         |
|-----------------|---------------------------------------|----------------|
| `HOME_HOST`     | Хост Mosquitto                        | `localhost`    |
| `HOME_PORT`     | Порт Mosquitto                        | `1883`         |
| `MOIO_MAC`      | MAC-адрес MOiO (из прошивки)          | `782184803ce4` |
| `WEB_PORT`      | Порт веб-панели                       | `8080`         |
| `PASS_VOLOSATI` | Пароль пользователя volosati          | `12345`        |
| `PASS_MAX`      | Пароль пользователя max               | `12345`        |
| `PASS_GUEST`    | Пароль гостя (пустая строка = без пароля) | `""`       |
| `MQTT_USER`     | MQTT-юзер для bridge и web app        | `silnodom`     |
| `MQTT_PASS`     | MQTT-пароль                           | `12345`        |
| `CF_API_TOKEN`  | CF API токен для записи в KV          | (опц.)         |
| `CF_ACCOUNT_ID` | CF Account ID                         | (опц.)         |

## Текущие учётные данные (dev-стенд)

> Эти пароли — временные, для разработки. Перед продакшн-деплоем сменить все.

| Сервис      | Логин      | Пароль  |
|-------------|------------|---------|
| Web UI      | volosati   | 12345   |
| Web UI      | max        | 12345   |
| Web UI      | guest      | (пусто) |
| MQTT broker | silnodom   | 12345   |

Дыры, которые нужно закрыть при переезде на прод
(полный pre-prod чеклист — `panel/FEATURES.md` → «Security migration»):

- **SSH — только ключи.** `PasswordAuthentication no`, `PermitRootLogin no`
  на всех хостах (voloNuk Windows side и любом WSL guest с sshd). Никакой
  логин паролем не должен работать в принципе.
- **MQTT через TLS.** Mosquitto на `:8883` (TLS), голый username+password
  listener — удалить. Для MOiO (не поддерживает auth прошивкой) — отдельный
  listener привязанный к `127.0.0.1` за proxy панели.
- **Все секреты — в secret store** (1Password CLI / sops+age / Bitwarden).
  `MQTT_PASS`, `PASS_VOLOSATI`, `PASS_MAX`, `CF_API_TOKEN`, бридж-токен,
  SC client secret — резолвить при старте процесса, не хранить в `.env`.
- **REST API — bearer-токен на write-эндпоинты** (`/set`, `/toggle` и всё
  что меняет состояние). Ротация раз в квартал или раньше при компрометации.
  Анонимный read `/state` можно оставить, но за feature-flag.
- **HTTPS termination перед docker** (Caddy / nginx). Никакого plain HTTP
  даже на LAN edge после dev-фазы.
- **Бридж-токен ротировать и заскопить.** `AG_BRIDGE_SECRET` —
  пересоздать, привязать к dedicated Tailscale ACL. Произвольный
  `cmd.exe`-exec в проде неприемлем; заменить на узкий RPC.
- **Cloudflared — именованный tunnel или выключить.** `trycloudflare.com`
  ephemeral анонимно публичен; на проде — CF Zero Trust Access policy
  поверх named tunnel, либо никакого внешнего выхода.
- **Audit blast radius `12345`** перед flip — `mqtt_passwords`, `.env`,
  in-repo docs, `.bash_history`, бэкапы. Ротация атомарная, не по одному.

## Права доступа

| Роль        | Дашборд | Свет (UI) | Конфиг/Лог | REST API |
|-------------|---------|-----------|------------|---------|
| Анонимный   | ✓       | ✗         | ✗          | ✓       |
| Авторизованный | ✓    | ✓         | ✓          | ✓       |

> Управление через UI-кнопки требует логина.
> REST API (`/set`, `/toggle`, `/state`) намеренно открыт: security-by-obscurity через ephemeral tunnel URL.
> Долгосрочный план: прикрутить как Telegram Mini App или закрыть анонимный доступ,
> оставив только guest-режим (просмотр без управления).

## MQTT безопасность

Mosquitto использует ACL-файл (`mqtt_acl`):
- Аутентифицированные клиенты (bridge, web app) — полный доступ ко всем топикам.
- Анонимные клиенты (MOiO — не поддерживает MQTT credentials) — только `moio/#`.

Для активации:
1. Создать файл паролей: `mosquitto_passwd -c mqtt_passwords silnodom`
2. Добавить в `.env`: `MQTT_USER=silnodom`, `MQTT_PASS=<пароль>`
3. Перезапустить Mosquitto.

## Запуск (Windows + WSL Debian)

```powershell
# От пользователя mqtt-silno в WSL
wsl -d Debian -u mqtt-silno -- bash -c "cd /home/mqtt-silno/silno-dom-server && bash start.sh"
```

Или полный рестарт + git pull + KV update:

```powershell
powershell -ExecutionPolicy Bypass -File ".\restart_silno.ps1"
```

## REST API (без авторизации)

### GET /state

Текущее состояние каналов (MQTT feedback от устройства).

```json
{"ch1": true, "ch3": false}
```

### POST /set

```json
{"ch1": true, "ch3": false}
```

`null` — не трогать канал. Возвращает текущий state.

### POST /toggle

```json
{"ch": "ch3"}
```

Возвращает: `{"ch": "ch3", "cmd": "on"}`.

## MQTT топики

| Топик                                         | Направление     | Описание               |
|-----------------------------------------------|-----------------|------------------------|
| `home/light/ch1/state`                        | MOiO → панель   | Состояние (on/off)     |
| `home/light/ch3/state`                        | MOiO → панель   | Состояние              |
| `home/light/ch1/set`                          | панель → MOiO   | Команда                |
| `home/light/ch3/set`                          | панель → MOiO   | Команда                |

Канал ch2 физически не подключён.

Реальные MOiO-топики (MAC `782184803ce4`):

```
moio/moio3ch/782184803ce4_ch1/devices.capabilities.on_off/on        ← state
moio/moio3ch/782184803ce4_ch1/devices.capabilities.on_off/on/set    ← cmd
```

## Cloudflare Worker

Постоянный URL: `https://moio-control.voloagents.workers.dev`

Worker читает актуальный tunnel URL из CF KV (`silno_agents / ag_linux_ssh_url`).
`start.sh` обновляет KV при старте если задан `CF_API_TOKEN`.

## Состояние в UI: cmd vs state

Панель хранит два независимых значения:

- **cmd** — последняя отправленная команда (мгновенный отклик в UI)
- **state** — реальное состояние, подтверждённое MOiO по MQTT

При загрузке страницы toggle показывает `cmd` (или `state` если `cmd` неизвестен).
Индикатор "устройство:" показывает `state`. Расхождение — сигнал что команда не прошла.

## Обновление состояния в браузере

После клика по toggle: запросы к `/state` через 0.5, 1.0, 1.5 сек (ловим подтверждение от устройства),
затем пассивный поллинг каждые 5 сек.

**TODO:** заменить поллинг на Server-Sent Events (SSE) или WebSocket — MQTT-события должны пушиться
в браузер напрямую, без периодических запросов.


---

## Ops notes — как должно быть / как не надо

### Stable worktree (8080) должен существовать до запуска start.sh

start.sh ожидает git worktree ../silno-dom-server-stable (привязан к main).
Если worktree нет — 8080 не стартует, лог пишет WARNING.

  git worktree add ../silno-dom-server-stable main   # создать
  git worktree list                                  # проверить

Не надо: ждать что start.sh создаст его сам.

---

### httpx + HTTP_PROXY: trust_env=False обязателен для loopback

voloNuk задаёт HTTP_PROXY=http://127.0.0.1:2080 глобально. httpx 0.28+ гонит
через него все запросы включая loopback 127.0.0.1:8081. Паттерн no_proxy=127.*
wildcard не работает ни в httpx, ни в curl.

Правильно:
  def _http_client() -> httpx.AsyncClient:
      return httpx.AsyncClient(trust_env=False)

Не надо: httpx.AsyncClient() без trust_env=False — 502 + detail:"".

Диагностика: /api/state -> {"error":"upstream_unreachable","detail":""} ->
проверить trust_env в _http_client().

---

### web.app (8081) — обязательная зависимость panel.app

panel/app.py: catch-all /api/{path} -> 127.0.0.1:8081/{path}.
Если web.app упал — все /api/* кроме /api/light/state вернут 502.

Порядок старта: web.app (8081) -> panel stable (8080) -> panel dev (8082).
start.sh соблюдает. При ручном рестарте панели: curl -s localhost:8081/state

---

### git auth на WSL: Windows env vars не наследуются

GITHUB_VOLOSATI_TOKEN и другие Windows User/Machine env не передаются в WSL
без явного WSLENV.

Правильно (один раз):
  git config --global credential.helper \
    '/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe'
  git config --global core.autocrlf input

Не надо: полагаться на Windows env в WSL git.

---

### CRLF/LF: мнимые изменения на весь репо

core.autocrlf не задан -> git видит 9k изменённых строк где их нет.
git pull --ff-only падает с "local changes would be overwritten".

Сброс:
  git config --global core.autocrlf input
  git checkout -- .
  git pull --ff-only
