Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
$Config = Get-Content (Join-Path $RootDir "config.json") -Raw | ConvertFrom-Json
$ControlHost = if ($Config.controlHost -eq "0.0.0.0") { "127.0.0.1" } else { $Config.controlHost }
$Base = "http://${ControlHost}:$($Config.controlPort)"

function Test-ControlServer {
  try { Invoke-RestMethod -Uri "$Base/api/profiles" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

function Start-ControlServer {
  Start-Process -FilePath "node" -ArgumentList "`"$RootDir\server.js`"" -WindowStyle Hidden -WorkingDirectory $RootDir
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-ControlServer) { return $true }
  }
  return $false
}

if (-not (Test-ControlServer)) { Start-ControlServer | Out-Null }

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Asterisk
$icon.Text = "Llama Controller - stopped"
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add("Status: unknown")
$statusItem.Enabled = $false
$menu.Items.Add("-") | Out-Null

$startMenu = New-Object System.Windows.Forms.ToolStripMenuItem("Start")
$menu.Items.Add($startMenu) | Out-Null

$stopItem = $menu.Items.Add("Stop")
$restartItem = $menu.Items.Add("Restart current")
$menu.Items.Add("-") | Out-Null
$openDashItem = $menu.Items.Add("Open Dashboard")
$openWebUiItem = $menu.Items.Add("Open Model WebUI")
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Exit tray")

$icon.ContextMenuStrip = $menu

function Refresh-Profiles {
  $startMenu.DropDownItems.Clear()
  try {
    $r = Invoke-RestMethod -Uri "$Base/api/profiles" -TimeoutSec 3
    foreach ($p in $r.profiles) {
      $label = if ($p.broken) { "$($p.name) (broken)" } else { $p.name }
      $item = $startMenu.DropDownItems.Add($label)
      if ($p.broken) { $item.Enabled = $false }
      $profName = $p.name
      $item.Add_Click({
        param($s, $e)
        Invoke-RestMethod -Uri "$Base/api/start" -Method Post -Body (@{ profile = $profName } | ConvertTo-Json) -ContentType "application/json" | Out-Null
      }.GetNewClosure())
    }
  } catch {}
}

function Refresh-Status {
  try {
    $st = Invoke-RestMethod -Uri "$Base/api/status" -TimeoutSec 3
    if ($st.running -and $st.healthy) {
      $icon.Icon = [System.Drawing.SystemIcons]::Application
      $icon.Text = "Llama Controller - running ($($st.profile) :$($st.port))"
      $statusItem.Text = "RUNNING - $($st.profile) pid $($st.pid)"
    } elseif ($st.running -and $st.loading) {
      $icon.Icon = [System.Drawing.SystemIcons]::Information
      $icon.Text = "Llama Controller - loading model..."
      $statusItem.Text = "LOADING - $($st.profile)"
    } elseif ($st.crashed) {
      $icon.Icon = [System.Drawing.SystemIcons]::Error
      $icon.Text = "Llama Controller - crashed"
      $statusItem.Text = "CRASHED - $($st.lastProfile)"
    } else {
      $icon.Icon = [System.Drawing.SystemIcons]::Asterisk
      $icon.Text = "Llama Controller - stopped"
      $statusItem.Text = "STOPPED"
    }
    $script:lastState = $st
  } catch {
    $icon.Text = "Llama Controller - control server unreachable"
  }
}

$stopItem.Add_Click({ Invoke-RestMethod -Uri "$Base/api/stop" -Method Post | Out-Null; Refresh-Status })
$restartItem.Add_Click({
  $prof = if ($script:lastState -and $script:lastState.profile) { $script:lastState.profile } else { $null }
  Invoke-RestMethod -Uri "$Base/api/restart" -Method Post -Body (@{ profile = $prof } | ConvertTo-Json) -ContentType "application/json" | Out-Null
})
$openDashItem.Add_Click({ Start-Process $Base })
$openWebUiItem.Add_Click({
  if ($script:lastState -and $script:lastState.running) {
    Start-Process "http://${ControlHost}:$($script:lastState.port)"
  }
})
$exitItem.Add_Click({
  $icon.Visible = $false
  $timer.Stop()
  [System.Windows.Forms.Application]::Exit()
})

Refresh-Profiles
Refresh-Status

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Refresh-Status })
$timer.Start()

[System.Windows.Forms.Application]::Run()
