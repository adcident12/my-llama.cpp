param(
  [Parameter(Position=0)] [string]$Command = "status",
  [Parameter(Position=1)] [string]$Arg
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $RootDir "config.json"
$Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

$ControlHost = if ($Config.controlHost -eq "0.0.0.0") { "127.0.0.1" } else { $Config.controlHost }
$Base = "http://${ControlHost}:$($Config.controlPort)"

function Test-ControlServer {
  try {
    Invoke-RestMethod -Uri "$Base/api/profiles" -TimeoutSec 2 -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Start-ControlServer {
  Write-Host "Control server not reachable, starting it..." -ForegroundColor Yellow
  Start-Process -FilePath "node" -ArgumentList "`"$RootDir\server.js`"" -WindowStyle Hidden -WorkingDirectory $RootDir
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-ControlServer) { return }
  }
  throw "Could not reach control server after starting it."
}

if (-not (Test-ControlServer)) {
  Start-ControlServer
}

function Show-Status {
  $st = Invoke-RestMethod -Uri "$Base/api/status" -TimeoutSec 5
  if ($st.running -and $st.healthy) {
    Write-Host "RUNNING" -ForegroundColor Green -NoNewline
    Write-Host "  profile=$($st.profile) pid=$($st.pid) $($st.host):$($st.port) uptime=$([math]::Round($st.uptimeMs/1000))s"
  } elseif ($st.running -and $st.loading) {
    Write-Host "LOADING" -ForegroundColor Yellow -NoNewline
    Write-Host "  profile=$($st.profile) pid=$($st.pid) (model still loading into VRAM)"
  } elseif ($st.crashed) {
    Write-Host "CRASHED" -ForegroundColor Red -NoNewline
    Write-Host "  last profile=$($st.lastProfile) - check: llama logs"
  } else {
    Write-Host "STOPPED" -ForegroundColor DarkGray
  }
  if ($st.gpu) {
    foreach ($g in $st.gpu) {
      Write-Host ("  GPU {0} {1}: {2}/{3} MiB, util {4}%, {5}C" -f $g.index, $g.name, $g.memUsedMiB, $g.memTotalMiB, $g.utilPct, $g.tempC)
    }
  }
}

switch ($Command) {
  "start" {
    $body = @{ profile = $Arg } | ConvertTo-Json
    try {
      $r = Invoke-RestMethod -Uri "$Base/api/start" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10
      Write-Host "Starting profile '$($r.state.profile)' (pid $($r.state.pid))... model load can take 1-2 min for a 35B model." -ForegroundColor Cyan
    } catch {
      Write-Host "Start failed: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
  }
  "stop" {
    $r = Invoke-RestMethod -Uri "$Base/api/stop" -Method Post -TimeoutSec 10
    Write-Host "Stopped." -ForegroundColor Cyan
  }
  "restart" {
    $body = @{ profile = $Arg } | ConvertTo-Json
    try {
      $r = Invoke-RestMethod -Uri "$Base/api/restart" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10
      Write-Host "Restarting with profile '$($r.state.profile)'..." -ForegroundColor Cyan
    } catch {
      Write-Host "Restart failed: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
  }
  "status" { Show-Status }
  "logs" {
    $lines = if ($Arg) { $Arg } else { 100 }
    $r = Invoke-RestMethod -Uri "$Base/api/logs?lines=$lines" -TimeoutSec 10
    Write-Host $r.text
  }
  "profiles" {
    $r = Invoke-RestMethod -Uri "$Base/api/profiles" -TimeoutSec 10
    foreach ($p in $r.profiles) {
      $flag = if ($p.name -eq $r.defaultProfile) { " (default)" } else { "" }
      $brokenFlag = if ($p.broken) { " [BROKEN]" } else { "" }
      Write-Host "$($p.name)$flag$brokenFlag - $($p.model)"
    }
  }
  "open" {
    Start-Process "$Base"
  }
  default {
    Write-Host "Usage: llama <start [profile]|stop|restart [profile]|status|logs [n]|profiles|open>"
  }
}
