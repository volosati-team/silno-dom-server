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
| `CF_API_TOKEN`  | CF API токен для записи в KV          | (опц.)         |
| `CF_ACCOUNT_ID` | CF Account ID                         | (опц.)         |

## Права доступа

| Роль        | Дашборд | Свет | Конфиг/Лог |
|-------------|---------|------|------------|
| Анонимный   | ✓       | ✗    | ✗          |
| Авторизованный | ✓    | ✓    | ✓          |

> Управление светом через кнопки UI требует логина.
> REST API (`/set`, `/toggle`, `/state`) открыт без авторизации.

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
