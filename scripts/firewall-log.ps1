# Turn Windows Firewall connection logging on or off. Run in an elevated (Administrator) PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\firewall-log.ps1          # on
#   powershell -ExecutionPolicy Bypass -File scripts\firewall-log.ps1 -Off     # back to Windows defaults
# "On" logs every ALLOWED inbound/outbound connection (time, protocol, source and destination
# IP and port; no content) to logs\firewall\pfirewall.log in this repo. Windows lets only
# SYSTEM/Administrators read that file, so a SYSTEM scheduled task (firewall-copy.ps1, every
# minute) copies the inbound lines for this repo's ports to logs\firewall\inbound.log, which
# the MCP tool llama_clients reads. Loopback (127.0.0.1) connections are logged too.
# The file is capped at 32 MB, then Windows renames it to pfirewall.log.old.
param([switch]$Off)

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Run this from an Administrator PowerShell." -ForegroundColor Red
  exit 1
}

$taskName = "llama-stroller firewall copy"

if ($Off) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  netsh advfirewall set allprofiles logging allowedconnections disable | Out-Null
  netsh advfirewall set allprofiles logging filename "%systemroot%\system32\LogFiles\Firewall\pfirewall.log" | Out-Null
  netsh advfirewall set allprofiles logging maxfilesize 4096 | Out-Null
  Write-Host "Firewall connection logging off (Windows defaults restored)." -ForegroundColor Green
  exit 0
}

$dir = Join-Path (Split-Path -Parent $PSScriptRoot) "logs\firewall"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# The firewall service writes the file as NT SERVICE\MpsSvc; it needs write access to the folder.
icacls $dir /grant "NT SERVICE\MpsSvc:(OI)(CI)M" | Out-Null

netsh advfirewall set allprofiles logging filename (Join-Path $dir "pfirewall.log") | Out-Null
netsh advfirewall set allprofiles logging maxfilesize 32767 | Out-Null
netsh advfirewall set allprofiles logging allowedconnections enable | Out-Null

# Windows makes pfirewall.log readable only by SYSTEM/MpsSvc/Administrators whatever the folder
# allows, so a SYSTEM task copies this repo's inbound lines to logs\firewall\inbound.log every minute.
$copy = Join-Path $PSScriptRoot "firewall-copy.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$copy`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

netsh advfirewall show allprofiles logging
Write-Host "Logging allowed connections to $dir\pfirewall.log" -ForegroundColor Green
Write-Host "Task '$taskName' copies inbound lines for this repo's ports to $dir\inbound.log every minute" -ForegroundColor Green
