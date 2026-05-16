# install.ps1 - full silno-dom-server setup
# Run as Administrator once.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Steps:
#   0. Stop and disable Windows Mosquitto service (if installed)
#   1. Install mosquitto, python3, git, cloudflared in WSL Debian
#   2. Create WSL user mqtt-silno
#   3. Clone repo to /home/mqtt-silno/silno-dom-server
#   4. Install Python dependencies
#   5. Create .env from template
#   6. Register Task Scheduler task (autostart at logon)

param(
    [string]$WslDistro = "Debian",
    [string]$MqttUser  = "mqtt-silno",
    [string]$RepoUrl   = "https://github.com/volosati-team/silno-dom-server",
    [string]$RepoDir   = "/home/mqtt-silno/silno-dom-server",
    [string]$TaskName  = "silno-dom-server"
)

$ErrorActionPreference = "Stop"

function W([string]$cmd) {
    $result = wsl.exe -d $WslDistro -u root -- bash -c $cmd
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $cmd" }
    return $result
}

function WU([string]$cmd) {
    $result = wsl.exe -d $WslDistro -u $MqttUser -- bash -c $cmd
    if ($LASTEXITCODE -ne 0) { throw "WSL user command failed: $cmd" }
    return $result
}

Write-Host ""
Write-Host "=== silno-dom-server install ===" -ForegroundColor Yellow
Write-Host "Distro: $WslDistro  User: $MqttUser  Repo: $RepoDir"
Write-Host ""

# 0. Stop Windows Mosquitto
Write-Host "[0/6] Windows Mosquitto service..." -ForegroundColor Cyan
$svc = Get-Service -Name "mosquitto" -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq "Running") {
        Stop-Service -Name "mosquitto" -Force
        Write-Host "  stopped"
    }
    Set-Service -Name "mosquitto" -StartupType Disabled
    Write-Host "  autostart disabled"
} else {
    Write-Host "  service not found, skip"
}

# 1. Packages + cloudflared
Write-Host "[1/6] Installing packages (apt)..." -ForegroundColor Cyan
W "apt-get update -q && apt-get install -y mosquitto python3 python3-pip git curl"
W "command -v cloudflared >/dev/null 2>&1 || (curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null && echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' | tee /etc/apt/sources.list.d/cloudflared.list && apt-get update -q && apt-get install -y cloudflared)"

# 2. User
Write-Host "[2/6] User $MqttUser..." -ForegroundColor Cyan
W "id $MqttUser >/dev/null 2>&1 || useradd -m -s /bin/bash $MqttUser"

# 3. Clone / pull
Write-Host "[3/6] Repo..." -ForegroundColor Cyan
W "if [ -d '$RepoDir/.git' ]; then sudo -u $MqttUser git -C '$RepoDir' pull --ff-only; else sudo -u $MqttUser git clone '$RepoUrl' '$RepoDir'; fi"

# 4. Python deps
Write-Host "[4/6] Python deps..." -ForegroundColor Cyan
WU "pip3 install --user -q --break-system-packages -r $RepoDir/requirements.txt"

# 5. .env
Write-Host "[5/6] Config (.env)..." -ForegroundColor Cyan
W "if [ ! -f '$RepoDir/.env' ]; then sudo -u $MqttUser cp '$RepoDir/.env.example' '$RepoDir/.env' && chmod 600 '$RepoDir/.env'; fi"
Write-Host ""
Write-Host "  ! Edit password and MOiO IP:" -ForegroundColor Yellow
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
    -Description "silno-dom-server: Mosquitto + MQTT bridge + web UI" | Out-Null

Write-Host ""
Write-Host "=== Done! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Start now (no reboot needed):"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor White
Write-Host ""
Write-Host "Web panel: http://localhost:8080"
Write-Host "Stop: wsl -d $WslDistro -u $MqttUser bash $RepoDir/stop.sh"
