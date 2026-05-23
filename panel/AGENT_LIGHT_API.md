# Свет в доме — REST API для агентов

Доступ к управлению светом резиденции СИЛЬНО (silno-dom) в локальной сети.
Без авторизации, доступно только из локалки (через `192.168.31.50`).

> **⚠️ Временный endpoint.** После переезда панели на новый сервер IP-адрес
> сменится. Когда это произойдёт, Андрей пришлёт обновлённую инструкцию.

## Базовый URL

```
http://192.168.31.50:8080
```

## Физические каналы

| Канал | Что это | Статус |
|-------|---------|--------|
| `ch1` | Споты | подключён, рабочий |
| `ch2` | — | физически не подключён, не использовать |
| `ch3` | Гирлянда | подключён, рабочий |

## Получить текущее состояние

```
GET /api/light/state
```

Ответ:

```json
{"ch1": false, "ch3": false}
```

`true` — включён, `false` — выключен.

Пример:

```sh
curl http://192.168.31.50:8080/api/light/state
```

## Переключить канал

```
POST /api/light/set
Content-Type: application/json

{"ch1": true}
```

Тело — JSON, ключ = имя канала (`ch1` или `ch3`), значение = `true`/`false`.
Можно передавать оба сразу:

```json
{"ch1": true, "ch3": false}
```

Ответ при успехе:

```json
{"ok": true, "written": {"ch1": true}}
```

Команда уходит в DragonFly KV → MQTT → реле через облако MOiO. Состояние
обновится в `/api/light/state` через 1–3 секунды (после ack от реле).

## Примеры

### curl: включить Споты

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"ch1": true}' \
  http://192.168.31.50:8080/api/light/set
```

### curl: выключить Гирлянду

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"ch3": false}' \
  http://192.168.31.50:8080/api/light/set
```

### curl: включить всё

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"ch1": true, "ch3": true}' \
  http://192.168.31.50:8080/api/light/set
```

### Python

```python
import requests
requests.post(
    "http://192.168.31.50:8080/api/light/set",
    json={"ch1": True, "ch3": False},
    timeout=5,
)
```

### JavaScript

```js
fetch("http://192.168.31.50:8080/api/light/set", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ch1: true }),
});
```

## Ограничения

- Доступ **только** из локальной сети (WiFi / Ethernet 192.168.31.x).
  Снаружи (через интернет) endpoint не доступен.
- Без авторизации — любой клиент в LAN может переключать.
- `ch2` не использовать, физического реле нет.
- Между командой и фактическим переключением света — 1–3 секунды
  (MQTT round-trip через облако MOiO).
- Если несколько команд подряд (`set` ch1=true → сразу `set` ch1=false) —
  они могут схлопнуться. Между ними жди подтверждения через `/state`.

## Диагностика

Если переключение не срабатывает физически:

1. Проверить что реле online — глянь `/api/light/state` после команды.
   Если `state` не меняется на ожидаемое значение в течение 5 секунд —
   MQTT bridge или MOiO облако недоступны.
2. Андрей/администратор может перезапустить bridge через `bash start.sh`
   в `/home/mqtt-silno/silno-dom-server/` на сервере voloNuk.
