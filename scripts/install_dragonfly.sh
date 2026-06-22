#!/usr/bin/env bash
# Install DragonFly DB (Redis-compatible)
#
# Режимы:
#   --user-service         Установить как user-systemd сервис текущего юзера (без sudo)
#   --system-service USER  Установить как system-wide сервис, запускающийся от имени USER
#                          (нужен sudo, запускать от админ-юзера)
#
# Примеры:
#   # От рабочего юзера (mqtt-silno):
#   bash install_dragonfly.sh --user-service
#
#   # От судо-юзера, сервис крутится от имени mqtt-silno:
#   sudo bash install_dragonfly.sh --system-service mqtt-silno
set -euo pipefail

MODE=""
RUN_AS=""

for arg in "$@"; do
  case $arg in
    --user-service)         MODE="user" ;;
    --system-service)       MODE="system" ;;
    *)
      if [[ "$MODE" == "system" && -z "$RUN_AS" ]]; then
        RUN_AS="$arg"
      fi
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "Использование:"
  echo "  bash $0 --user-service                  # от рабочего юзера"
  echo "  sudo bash $0 --system-service <user>    # от судо-юзера, сервис = <user>"
  exit 1
fi

if [[ "$MODE" == "system" && -z "$RUN_AS" ]]; then
  echo "Ошибка: укажи имя рабочего юзера, например: sudo bash $0 --system-service mqtt-silno"
  exit 1
fi

# Определяем arch
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  DF_ARCH="x86_64" ;;
  aarch64) DF_ARCH="aarch64" ;;
  *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

echo "→ Получаем последний релиз DragonFly..."
VERSION=$(curl -fsSL https://api.github.com/repos/dragonflydb/dragonfly/releases/latest \
  | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\(.*\)".*/\1/')
echo "  Версия: $VERSION"

URL="https://github.com/dragonflydb/dragonfly/releases/download/${VERSION}/dragonfly-${DF_ARCH}.tar.gz"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

echo "→ Скачиваем $URL"
curl -fsSL "$URL" -o "$TMP/dragonfly.tar.gz"
tar -xzf "$TMP/dragonfly.tar.gz" -C "$TMP"

# === USER MODE ===
if [[ "$MODE" == "user" ]]; then
  INSTALL_DIR="$HOME/.local/bin"
  DATA_DIR="$HOME/.local/share/dragonfly"
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$UNIT_DIR"

  install -m 755 "$TMP/dragonfly-${DF_ARCH}" "$INSTALL_DIR/dragonfly"
  echo "→ Бинарь: $INSTALL_DIR/dragonfly"

  cat > "$UNIT_DIR/dragonfly.service" << EOF
[Unit]
Description=DragonFly DB
After=network.target

[Service]
ExecStart=$INSTALL_DIR/dragonfly --port 6379 --logtostderr --save_schedule "in 900 1" --dir $DATA_DIR
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable dragonfly
  systemctl --user start dragonfly
  echo "→ User-сервис запущен"
  echo "  Для автостарта без активной сессии (нужен sudo от админ-юзера):"
  echo "  sudo loginctl enable-linger $(whoami)"
fi

# === SYSTEM MODE ===
if [[ "$MODE" == "system" ]]; then
  if [[ "$EUID" -ne 0 ]]; then
    echo "Ошибка: system-service требует запуска через sudo"
    exit 1
  fi

  INSTALL_DIR="/usr/local/bin"
  DATA_DIR="/var/lib/dragonfly"
  install -m 755 "$TMP/dragonfly-${DF_ARCH}" "$INSTALL_DIR/dragonfly"
  echo "→ Бинарь: $INSTALL_DIR/dragonfly"

  # Создаём data-dir от имени рабочего юзера
  mkdir -p "$DATA_DIR"
  chown "$RUN_AS:$RUN_AS" "$DATA_DIR"

  cat > /etc/systemd/system/dragonfly.service << EOF
[Unit]
Description=DragonFly DB
After=network.target

[Service]
User=$RUN_AS
ExecStart=$INSTALL_DIR/dragonfly --port 6379 --logtostderr --save_schedule "in 900 1" --dir $DATA_DIR
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
LimitMEMLOCK=infinity

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable dragonfly
  systemctl start dragonfly
  echo "→ System-сервис запущен как юзер '$RUN_AS'"
  echo "  Автостарт при загрузке уже включён (system-level)"
fi

echo ""
echo "→ Проверка:"
echo "  redis-cli -p 6379 ping   # должен вернуть PONG"
