# silno-dom-server

Серверная сторона умного дома: MQTT-мост MOiO ↔ Mosquitto + веб-панель управления освещением.

## Структура

```
silno-dom-server/
  home_mqtt_bridge.py     ← мост: MOiO broker ↔ центральный Mosquitto
  mosquitto_open.conf     ← конфиг Mosquitto (порты 1883 + 9001 websockets)
  requirements.txt
  web/
    app.py                ← FastAPI веб-панель
    templates/
      login.html
      base.html
      dashboard.html
      config.html
```

## Зависимости

Python 3.11+, Mosquitto 2.x.

```bash
pip install -r requirements.txt
```

## Конфигурация

Все параметры через переменные окружения:

| Переменная       | Описание                              | Дефолт        |
|------------------|---------------------------------------|---------------|
| `WEB_PASSWORD`   | Пароль для входа в веб-панель         | `silnodom`    |
| `SESSION_SECRET` | Секрет сессии (случайный если не задан)| auto          |
| `HOME_HOST`      | Хост центрального Mosquitto           | `localhost`   |
| `HOME_PORT`      | Порт центрального Mosquitto           | `1883`        |
| `MOIO_HOST`      | IP-адрес MOiO (его встроенный broker) | `192.168.28.160` |
| `MOIO_PORT`      | Порт MOiO broker                      | `1883`        |
| `MOIO_DEVICE_ID` | Device ID MOiO (из прошивки)          | `782184803ce4` |

## Запуск

**1. Mosquitto**

```bash
mosquitto -c mosquitto_open.conf
```

**2. MQTT-мост** (в фоне или через systemd)

```bash
python3 home_mqtt_bridge.py
```

**3. Веб-панель**

```bash
WEB_PASSWORD=yourpassword uvicorn web.app:app --host 0.0.0.0 --port 8080
```

Открыть: `http://<ip-сервера>:8080`

## Сеть

Сервер должен дотягиваться до MOiO broker на `192.168.28.160:1883`.
Если MOiO в гостевой сети, а сервер в домашней — нужен inter-VLAN маршрут:

```bash
# Разрешить трафик из домашней сети (192.168.1.0/24) к MOiO (192.168.28.160)
iptables -I FORWARD -s 192.168.1.0/24 -d 192.168.28.160 -p tcp --dport 1883 -j ACCEPT
iptables -I FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT
```

## MQTT топики

| Топик                         | Направление       | Описание                  |
|-------------------------------|-------------------|---------------------------|
| `home/light/ch1/state`        | bridge → панель   | Состояние споты (on/off)  |
| `home/light/ch3/state`        | bridge → панель   | Состояние гирлянда        |
| `home/light/ch1/set`          | панель → bridge   | Команда споты             |
| `home/light/ch3/set`          | панель → bridge   | Команда гирлянда          |

Канал ch2 физически не подключён.
