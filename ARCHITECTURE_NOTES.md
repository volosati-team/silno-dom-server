# silno-dom-server — Architecture Notes

## 2026-05-16 (голосовая заметка)

**Идея:** нужен ещё один слой поверх Mosquitto.

- Mosquitto = MQTT-брокер для устройств (MOiO). Это только один слой, не вся архитектура.
- Всё будет опираться на KV-хранилище.
- Второй слой — Redis-подобный (Андрей не вспомнил название, сказал «Дракон»). 
  Кандидаты: Dragonfly (Redis-compatible), Valkey, KeyDB.
- Упомянуты: Unicorn (Gunicorn?), скрипты.
- Идея: скрипты / задачи координируются через этот второй слой, Mosquitto — только транспорт до устройства.

**Статус:** набросок, разбираться завтра.

---

## 2026-05-17 — Archитектурные решения

### Стек
- **Dragonfly** — source of truth, Redis-compatible, порт 6379
- **Mosquitto** — транспорт до MOiO-устройств, не трогать существующие топики
- **FastAPI bridge** (`home_mqtt_bridge.py`) — остаётся как есть, REST API сохраняется

### Схема ключей DragonFly (плоские, не JSON)
```
home:backyard:lights:spots        → 0/1   # MOiO ch1
home:backyard:lights:lightchain   → 0/1   # MOiO ch3
home:backyard:lights:spare        → 0/1   # MOiO ch2 (зарезервировано)
```
MQTT-топики зеркалят: `home/backyard/lights/spots` ↔ `home:backyard:lights:spots`

### Компоненты к разработке
1. **DragonFly install** — `scripts/install_dragonfly.sh` (готово)
2. **moio_adapter.py** — подписка на keyspace notifications DragonFly → REST `/set` MOiO
3. **mqtt_df_bridge.py** — MQTT `home/+/+/+/state` → DragonFly SET (и обратно)
4. **kv_command_daemon.py** — CF KV поллер: принимает команды (restart_bridge, update, restart_dragonfly) из CF KV, выполняет без sudo, пишет результат обратно. Использует неймспейс `fed3fe1caf3e464fbb582b03f2e5a4ab`.

### Инфраструктура
- Сервер: WSL Debian, пользователь `mqtt-silno`, sudo доступен (от отдельного admin-юзера)
- CF KV неймспейс уже используется для tunnel URL (`ag_linux_ssh_url`)

### Принцип "не сломать"
- MOiO REST API (`/state`, `/set`, `/toggle`) не меняем
- MQTT-топики MOiO (`moio/moio3ch/...`) не меняем
- Adapter — новый слой поверх, не замена существующему
