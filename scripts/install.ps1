# Sets up: `llama` command on PATH + tray icon auto-start at login.
# Does NOT auto-start the model itself at login (that's a manual `llama start`,
# since loading a 35B model takes ~1-2 min and ~25GB VRAM every time).

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
$CliDir = Join-Path $RootDir "cli"

# 1. Add cli\ to the user PATH so `llama` works from any cmd/PowerShell window.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$CliDir*") {
  $newPath = if ($userPath) { "$userPath;$CliDir" } else { $CliDir }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "Added $CliDir to your user PATH. Open a new terminal for it to take effect." -ForegroundColor Green
} else {
  Write-Host "cli\ already on PATH." -ForegroundColor DarkGray
}

# 2. Create a Startup shortcut that launches the tray icon (and, via the tray
#    script, the control server) silently at login.
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "Llama Stroller Tray.lnk"
$wshell = New-Object -ComObject WScript.Shell
$shortcut = $wshell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RootDir\tray\tray.ps1`""
$shortcut.WorkingDirectory = $RootDir
$shortcut.Description = "Llama Stroller tray icon + control server"
$shortcut.Save()
Write-Host "Startup shortcut created: $shortcutPath" -ForegroundColor Green

Write-Host ""
Write-Host "Done. Next login the tray icon will appear automatically." -ForegroundColor Cyan
Write-Host "To start it right now without logging out, run:" -ForegroundColor Cyan
Write-Host "  powershell -WindowStyle Hidden -File `"$RootDir\tray\tray.ps1`""
