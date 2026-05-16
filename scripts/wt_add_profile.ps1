# wt_add_profile.ps1 — добавить профиль mqtt-silno в Windows Terminal.
# Запускать от обычного пользователя (не Admin).
#
# Использование:
#   powershell -ExecutionPolicy Bypass -File scripts\wt_add_profile.ps1

param(
    [string]$WslDistro = "Debian",
    [string]$WslUser   = "mqtt-silno",
    [string]$RepoDir   = "/home/mqtt-silno/silno-dom-server"
)

# Найти settings.json Windows Terminal
$wtPaths = @(
    "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json",
    "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json",
    "$env:APPDATA\Microsoft\Windows Terminal\settings.json"
)

$settingsPath = $null
foreach ($p in $wtPaths) {
    if (Test-Path $p) { $settingsPath = $p; break }
}

if (-not $settingsPath) {
    Write-Error "Windows Terminal settings.json не найден. Установи Windows Terminal из Microsoft Store."
    exit 1
}

Write-Host "Файл настроек: $settingsPath"

# Читать JSON
$settings = Get-Content $settingsPath -Raw | ConvertFrom-Json

# Проверить, нет ли уже такого профиля
$exists = $settings.profiles.list | Where-Object { $_.name -eq "$WslUser @ $WslDistro" }
if ($exists) {
    Write-Host "Профиль '$WslUser @ $WslDistro' уже существует." -ForegroundColor Yellow
    exit 0
}

# Новый профиль
$newProfile = [PSCustomObject]@{
    guid              = "{" + [System.Guid]::NewGuid().ToString() + "}"
    name              = "$WslUser @ $WslDistro"
    commandline       = "wsl.exe -d $WslDistro -u $WslUser"
    startingDirectory = $RepoDir
    hidden            = $false
}

# Добавить в список профилей
$settings.profiles.list += $newProfile

# Сохранить (с отступами)
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8

Write-Host ""
Write-Host "Профиль '$($newProfile.name)' добавлен." -ForegroundColor Green
Write-Host "Открой Windows Terminal — новый профиль появится в выпадающем меню."
