#!/usr/bin/env bash
# create_mqtt_user.sh — создать WSL-пользователя mqtt-silno без пароля.
# Запускать от root внутри Debian WSL:
#   sudo bash scripts/create_mqtt_user.sh

set -euo pipefail

MQTT_USER="mqtt-silno"

if id "$MQTT_USER" &>/dev/null; then
    echo "Пользователь $MQTT_USER уже существует"
else
    useradd -m -s /bin/bash "$MQTT_USER"
    echo "Создан: $MQTT_USER"
fi

# Отключить пароль (service account, вход только через wsl -u)
passwd -l "$MQTT_USER"
echo "Пароль отключён (locked)"

# Права: нет sudo, нет специальных групп — только своя домашняя директория
# pip --user, mosquitto и python запускаются без root

echo ""
echo "Проверка:"
id "$MQTT_USER"
echo "Домашняя директория: $(getent passwd $MQTT_USER | cut -d: -f6)"
