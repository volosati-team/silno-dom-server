# install.ps1 — полная установка silno-dom-server
# Запускать от Administrator один раз.
#
# Использование:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Что делает:
#   0. Останавливает и отключает Windows-сервис Mosquitto (если установлен)
#   1. Ставит mosquitto, python3, git в WSL Debian
#   2. Создаёт WSL-пользователя mqtt-silno
#   3. Клонирует репо в /home/mqtt-silno/silno-dom-server
#   4. Устанавливает Python-зависимости
#   5. Создаёт .env из шаблона
#   6. Регистрирует задачу в Task Scheduler (автозапуск при логоне)

param(
    [string]$WslDistro = "Debian",
    [string]$MqttUser  = "mqtt-silno",
    [string]$RepoUrl   = "https://github.com/volosati-team/silno-dom-server",
    [string]$RepoDir   = "/home/mqtt-silno/silno-dom-server",
    [string]$TaskName  = "silno-dom-server"
)

$ErrorActionPreference = "Stop"

function W([string]$cmd) {
    # Запустить bash-команду в WSL как root
    $result = wsl.exe -d $WslDistro -- bash -c $cmd
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $cmd" }
    return $result
}

function WU([string]$cmd) {
    # Запустить bash-команду в WSL как mqtt-silno
    $result = wsl.exe -d $WslDistro -u $MqttUser -- bash -c $cmd
    if ($LASTEXITCODE -ne 0) { throw "WSL user command failed: $cmd" }
    return $result
}

Write-Host ""
Write-Host "=== silno-dom-server install ===" -ForegroundColor Yellow
Write-Host "Distro: $WslDistro  User: $MqttUser  Repo: $RepoDir"
Write-Host ""

# 0. Убить Windows Mosquitto (если есть)
Write-Host "[0/6] Windows Mosquitto service..." -ForegroundColor Cyan
$svc = Get-Service -Name "mosquitto" -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq "Running") {
        Stop-Service -Name "mosquitto" -Force
        Write-Host "  остановлен"
    }
    Set-Service -Name "mosquitto" -StartupType Disabled
    Write-Host "  автозапуск отключён"
} else {
    Write-Host "  сервис не найден, пропуск"
}

# 1. Пакеты + cloudflared
Write-Host "[1/6] Установка пакетов (apt)..." -ForegroundColor Cyan
W "apt-get update -q && apt-get install -y mosquitto python3 python3-pip git curl"
W @"
if ! command -v cloudflared &>/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' | tee /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q && apt-get install -y cloudflared
fi
"@

# 2. Пользователь
Write-Host "[2/6] Пользователь $MqttUser..." -ForegroundColor Cyan
W "id $MqttUser >/dev/null 2>&1 || useradd -m -s /bin/bash $MqttUser"

# 3. Клон / pull
Write-Host "[3/6] Репо..." -ForegroundColor Cyan
W "if [ -d '$RepoDir/.git' ]; then sudo -u $MqttUser git -C '$RepoDir' pull --ff-only; else sudo -u $MqttUser git clone '$RepoUrl' '$RepoDir'; fi"

# 4. Python зависимости
Write-Host "[4/6] Python deps..." -ForegroundColor Cyan
WU "pip3 install --user -q -r $RepoDir/requirements.txt"

# 5. .env
Write-Host "[5/6] Конфиг (.env)..." -ForegroundColor Cyan
W "[ -f '$RepoDir/.env' ] || (sudo -u $MqttUser cp '$RepoDir/.env.example' '$RepoDir/.env' && chmod 600 '$RepoDir/.env')"
Write-Host ""
Write-Host "  ! Отредактируй пароль и IP MOiO:" -ForegroundColor Yellow
Write-Host "    wsl -d $WslDistro -u $MqttUser nano $RepoDir/.env"
Write-Host ""

# 6. Task Scheduler
Write-Host "[6/6] Task Scheduler..." -ForegroundColor Cyan

$action = New-ScheduledTaskAction `
    -Execute "wsl.exe" `
    -Argument "-d $WslDistro -u $MqttUser -e bash -lc `"cd $RepoDir && bash start.sh`""

$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Highest

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "silno-dom-server: Mosquitto + MQTT bridge + web UI (автозапуск)" | Out-Null

Write-Host ""
Write-Host "=== Готово! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Запустить прямо сейчас (не ждать перезагрузки):"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor White
Write-Host ""
Write-Host "Веб-панель: http://localhost:8080"
Write-Host "Остановить: wsl -d $WslDistro -u $MqttUser bash $RepoDir/stop.sh"
