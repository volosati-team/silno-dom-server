#!/usr/bin/env bash
# setup_wsl_user.sh — первичная настройка в Debian WSL.
# Запускать один раз от root (или через sudo) внутри WSL:
#   sudo bash setup_wsl_user.sh
#
# Создаёт пользователя mqtt-silno, клонирует репо, ставит зависимости.

set -euo pipefail

MQTT_USER="mqtt-silno"
REPO_URL="https://github.com/volosati-team/silno-dom-server"
REPO_DIR="/home/$MQTT_USER/silno-dom-server"

echo "=== Обновление пакетов ==="
apt-get update -q
apt-get install -y mosquitto python3 python3-pip git

echo "=== Создание пользователя $MQTT_USER ==="
if id "$MQTT_USER" &>/dev/null; then
    echo "  пользователь уже существует"
else
    useradd -m -s /bin/bash "$MQTT_USER"
    echo "  создан"
fi

echo "=== Клонирование репо ==="
if [ -d "$REPO_DIR/.git" ]; then
    echo "  репо уже есть, pull..."
    sudo -u "$MQTT_USER" git -C "$REPO_DIR" pull --ff-only
else
    sudo -u "$MQTT_USER" git clone "$REPO_URL" "$REPO_DIR"
fi

echo "=== Установка Python-зависимостей ==="
sudo -u "$MQTT_USER" pip3 install --user -r "$REPO_DIR/requirements.txt"

echo "=== Создание .env из примера ==="
ENV_FILE="$REPO_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    cp "$REPO_DIR/.env.example" "$ENV_FILE"
    chown "$MQTT_USER:$MQTT_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "  создан $ENV_FILE — отредактируй пароль и IP MOiO"
else
    echo "  .env уже существует"
fi

echo ""
echo "=== Готово ==="
echo "Следующий шаг: отредактируй $ENV_FILE"
echo "  sudo -u $MQTT_USER nano $ENV_FILE"
echo ""
echo "Тест запуска:"
echo "  sudo -u $MQTT_USER bash $REPO_DIR/start.sh"
