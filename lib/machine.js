// This machine as a reference for remote readers: hardware, OS, memory and commit (the real
// ceiling here, since every VRAM allocation is also charged to system commit on Windows),
// pagefile, disk, GPUs and driver, the llama.cpp builds, and Windows low-memory warnings.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const manager = require('./manager');

const CACHE_MS = 30 * 1000;
let cached = null;
const versionCache = new Map(); // exe -> { mtimeMs, version }

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err && !stdout ? null : `${stdout || ''}${stderr || ''}`);
    });
  });
}

const PS = `
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$ev = Get-WinEvent -FilterHashtable @{LogName='System'; Id=2004; StartTime=(Get-Date).AddDays(-7)}
[pscustomobject]@{
  os = [pscustomobject]@{ caption = $os.Caption; version = $os.Version; lastBoot = $os.LastBootUpTime.ToUniversalTime().ToString('o') }
  board = [pscustomobject]@{ maker = $cs.Manufacturer; model = $cs.Model }
  cpu = [pscustomobject]@{ name = $cpu.Name.Trim(); cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; maxMHz = $cpu.MaxClockSpeed; loadPct = $cpu.LoadPercentage }
  dimms = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { [pscustomobject]@{ slot = $_.DeviceLocator; gb = [math]::Round($_.Capacity / 1GB, 1); mhz = $_.ConfiguredClockSpeed } })
  memKB = [pscustomobject]@{ visible = $os.TotalVisibleMemorySize; free = $os.FreePhysicalMemory; commitLimit = $os.TotalVirtualMemorySize; commitFree = $os.FreeVirtualMemory }
  pagefiles = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { [pscustomobject]@{ drive = $_.Name.Substring(0, 2); allocatedMB = $_.AllocatedBaseSize; usedMB = $_.CurrentUsage; peakMB = $_.PeakUsage } })
  autoPagefile = $cs.AutomaticManagedPagefile
  disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.FreeSpace / 1GB, 1) } })
  lowMemory7d = [pscustomobject]@{ count = @($ev).Count; last = if ($ev) { ($ev | Select-Object -First 1).TimeCreated.ToUniversalTime().ToString('o') } else { $null } }
} | ConvertTo-Json -Depth 4 -Compress
`;

async function gpus() {
  const q = await run('nvidia-smi', ['--query-gpu=index,name,memory.total,memory.used,driver_version,power.draw,power.limit,temperature.gpu,utilization.gpu,pcie.link.gen.max,pcie.link.width.current', '--format=csv,noheader,nounits'], 5000);
  const head = await run('nvidia-smi', [], 5000);
  const cuda = head && /CUDA (?:UMD )?Version:\s*([\d.]+)/.exec(head);
  const list = (q || '').trim().split('\n').filter(Boolean).map((line) => {
    const [index, name, memTotal, memUsed, driver, power, powerLimit, temp, util, pcieGen, pcieWidth] = line.split(',').map((s) => s.trim());
    return {
      index: +index, name, memTotalMiB: +memTotal, memUsedMiB: +memUsed, driver,
      powerW: +power, powerLimitW: +powerLimit, tempC: +temp, utilPct: +util,
      pcieMaxGen: +pcieGen, pcieWidthNow: +pcieWidth,
    };
  });
  return { driverCuda: cuda ? cuda[1] : null, gpus: list };
}

// llama-server --version for each build the profiles use (cached until the exe changes).
async function llamaBuilds() {
  const config = manager.loadConfig();
  const dirs = new Set([config.llamaDir, ...Object.values(config.profiles).map((p) => p.llamaDir).filter(Boolean)]);
  const out = [];
  for (const dir of dirs) {
    const exe = path.join(dir, 'llama-server.exe');
    let st;
    try { st = fs.statSync(exe); } catch (err) { out.push({ dir: path.basename(dir), error: 'llama-server.exe not found' }); continue; }
    let hit = versionCache.get(exe);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      const text = await run(exe, ['--version'], 20000);
      const m = text && /version: (\S+) \(build (\d+), commit (\w+)\)/.exec(text);
      const b = text && /built with (.+)/.exec(text);
      hit = { mtimeMs: st.mtimeMs, version: m ? { version: m[1], build: +m[2], commit: m[3], compiler: b ? b[1].trim() : null } : { error: 'could not read version' } };
      versionCache.set(exe, hit);
    }
    out.push({
      dir: path.basename(dir),
      ...hit.version,
      profiles: Object.entries(config.profiles).filter(([, p]) => (p.llamaDir || config.llamaDir) === dir).map(([n]) => n),
    });
  }
  return out;
}

const gb = (kb) => +(kb / 1024 / 1024).toFixed(1);

async function llamaMachine() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const [psText, gpu, builds] = await Promise.all([
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], 20000),
    gpus(),
    llamaBuilds(),
  ]);
  let w = null;
  try { w = JSON.parse(psText); } catch (err) { /* reported below */ }

  const data = {
    host: { name: os.hostname(), lanAddresses: Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address) },
    os: w ? w.os : { caption: os.version(), version: os.release() },
    uptimeHours: +(os.uptime() / 3600).toFixed(1),
    board: w ? w.board : null,
    cpu: w ? w.cpu : { name: os.cpus()[0].model, threads: os.cpus().length },
    memory: w ? {
      installedGB: +w.dimms.reduce((a, d) => a + d.gb, 0).toFixed(1),
      dimms: w.dimms,
      visibleGB: gb(w.memKB.visible),
      notVisibleGB: +(w.dimms.reduce((a, d) => a + d.gb, 0) - gb(w.memKB.visible)).toFixed(1),
      freeGB: gb(w.memKB.free),
      commitLimitGB: gb(w.memKB.commitLimit),
      commitUsedGB: gb(w.memKB.commitLimit - w.memKB.commitFree),
      commitFreeGB: gb(w.memKB.commitFree),
      commitUsedPct: Math.round((1 - w.memKB.commitFree / w.memKB.commitLimit) * 100),
      pagefiles: w.pagefiles,
      pagefileAutoManaged: w.autoPagefile,
    } : { visibleGB: +(os.totalmem() / 2 ** 30).toFixed(1), freeGB: +(os.freemem() / 2 ** 30).toFixed(1) },
    windowsLowMemoryWarnings7d: w ? w.lowMemory7d : null,
    disks: w ? w.disks : null,
    ...gpu,
    llamaBuilds: builds,
    note: 'Commit, not VRAM, is the limit that matters here: on Windows every VRAM allocation is also charged to system commit, and a full two-GPU profile commits ~30 GB at load. Commit limit = visible RAM + pagefile. windowsLowMemoryWarnings7d counts System event 2004 (Resource-Exhaustion-Detector). notVisibleGB = installed RAM Windows cannot use (reserved by firmware/hardware). Figures are cached for 30 s.',
    ...(w ? {} : { error: 'Windows details unavailable (PowerShell query failed); showing what Node can see' }),
  };
  cached = { at: Date.now(), data };
  return data;
}

module.exports = { llamaMachine };
