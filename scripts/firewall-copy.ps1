# Run by the scheduled task "llama-stroller firewall copy" as SYSTEM every minute (set up by
# firewall-log.ps1). Windows makes pfirewall.log readable only by SYSTEM, the firewall service
# and Administrators, so this copies the inbound lines for this repo's ports (llama-server
# profiles, controller, MCP) to logs\firewall\inbound.log, which the user (and the MCP) can read.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root "logs\firewall"
$config = Get-Content (Join-Path $root "config.json") -Raw | ConvertFrom-Json

$ports = @{}
foreach ($p in $config.profiles.PSObject.Properties) { $ports[[string]$p.Value.port] = $true }
$ports[[string]$config.controlPort] = $true
$ports[[string]$(if ($config.mcpPort) { $config.mcpPort } else { 4571 })] = $true

$out = New-Object System.Collections.Generic.List[string]
$header = $null
foreach ($name in @("pfirewall.log.old", "pfirewall.log")) {
  $file = Join-Path $dir $name
  if (-not (Test-Path $file)) { continue }
  # the firewall service keeps the file open for writing; open it shared
  $fs = [System.IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
  $reader = New-Object System.IO.StreamReader($fs)
  try {
    while ($null -ne ($line = $reader.ReadLine())) {
      if ($line.StartsWith("#Fields:")) { $header = $line; continue }
      if ($line.Length -eq 0 -or $line[0] -eq '#') { continue }
      $v = $line.Split(' ')
      # date time action protocol src-ip dst-ip src-port dst-port ... path
      if ($v.Length -gt 16 -and $v[2] -eq 'ALLOW' -and $v[16] -eq 'RECEIVE' -and $ports.ContainsKey($v[7])) { $out.Add($line) }
    }
  } finally { $reader.Close() }
}

if (-not $header) { $header = "#Fields: date time action protocol src-ip dst-ip src-port dst-port size tcpflags tcpsyn tcpack tcpwin icmptype icmpcode info path pid" }
$tmp = Join-Path $dir "inbound.log.tmp"
[System.IO.File]::WriteAllLines($tmp, [string[]](@("#Copied: $(Get-Date -Format s)", $header) + $out))
Move-Item -Force $tmp (Join-Path $dir "inbound.log")
