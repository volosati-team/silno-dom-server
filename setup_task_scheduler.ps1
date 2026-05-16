# setup_task_scheduler.ps1
# Регистрирует автозапуск silno-dom-server в WSL при логоне Windows.
# Запускать от имени Administrator один раз после клонирования репо.
#
# Использование:
#   powershell -ExecutionPolicy Bypass -File setup_task_scheduler.ps1
#
# По умолчанию ищет репо в ~/silno-dom-server внутри WSL.
# Если склонировал в другое место — исправь $WslRepoPath ниже.

param(
    [string]$WslDistro   = "Debian",
    [string]$WslUser     = "mqtt-silno",
    [string]$WslRepoPath = "/home/mqtt-silno/silno-dom-server",
    [string]$TaskName    = "silno-dom-server"
)

$userArg = if ($WslUser) { "-u $WslUser" } else { "" }
$distroArg = "-d $WslDistro"

$action  = New-ScheduledTaskAction `
    -Execute "wsl.exe" `
    -Argument "$distroArg $userArg -e bash -lc `"cd $WslRepoPath && bash start.sh`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Highest

# Удалить старую задачу если есть
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Автозапуск silno-dom-server (Mosquitto + bridge + web UI) при входе в Windows"

Write-Host ""
Write-Host "Task '$TaskName' registered." -ForegroundColor Green
Write-Host "Run now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove:   Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
