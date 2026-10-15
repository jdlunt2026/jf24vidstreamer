# Registers a Task Scheduler task that starts the Activity server when Windows boots
# (no login needed). server\supervisor.js keeps it running and writes logs\server.log.
#
#   windows\autostart.cmd             install / update the task
#   windows\autostart.cmd -Uninstall  remove it
#
# Needs admin rights; it will ask for elevation.

param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$TaskName = "jf24vidstreamer"
$Root = Split-Path -Parent $PSScriptRoot

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
    IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($Uninstall) { $argList += "-Uninstall" }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
    exit
}

if ($Uninstall) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    Read-Host "Press Enter to close"
    exit
}

if (-not (Test-Path (Join-Path $Root ".env"))) {
    throw "No .env found in $Root. Run windows\setup.cmd first."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH. Run windows\setup.cmd first." }

# The supervisor restarts the server if it exits and writes logs\server.log.
$action = New-ScheduledTaskAction -Execute $node `
    -Argument "`"$Root\server\supervisor.js`"" `
    -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U = run as this user whether or not they're logged in, without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "Logs: $Root\logs\server.log"
Write-Host "Stop it:   Stop-ScheduledTask $TaskName   (or Task Scheduler > $TaskName > End)"
Write-Host "Remove it: windows\autostart.cmd -Uninstall"
Read-Host "Press Enter to close"
