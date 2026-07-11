const badge = document.getElementById('status-badge');
const detail = document.getElementById('status-detail');
const gpuList = document.getElementById('gpu-list');
const logView = document.getElementById('log-view');
const profileSelect = document.getElementById('profile-select');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnRestart = document.getElementById('btn-restart');
const btnOpen = document.getElementById('btn-open');

let lastState = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}

async function loadProfiles() {
  const { profiles, defaultProfile } = await api('/api/profiles');
  profileSelect.innerHTML = '';
  profiles.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.broken ? `${p.name} (broken)` : p.name;
    if (p.broken) opt.disabled = true;
    if (p.name === defaultProfile) opt.selected = true;
    profileSelect.appendChild(opt);
  });
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

async function refreshStatus() {
  const st = await api('/api/status');
  lastState = st;

  let label = 'stopped';
  if (st.running && st.healthy) label = 'running';
  else if (st.running && st.loading) label = 'loading';
  else if (st.crashed) label = 'crashed';

  badge.textContent = label.toUpperCase();
  badge.className = `badge ${label}`;

  if (st.running) {
    detail.innerHTML = `profile: <b>${st.profile}</b> &middot; pid ${st.pid} &middot; ${st.host}:${st.port} &middot; uptime ${fmtUptime(st.uptimeMs)}`;
  } else if (st.crashed) {
    detail.innerHTML = `last profile <b>${st.lastProfile}</b> exited unexpectedly. Check the log below.`;
  } else {
    detail.textContent = 'not running';
  }

  btnStart.disabled = !!st.running;
  btnStop.disabled = !st.running;
  btnRestart.disabled = false;
  btnOpen.disabled = !(st.running && st.healthy);

  gpuList.innerHTML = '';
  (st.gpu || []).forEach((g) => {
    const pct = Math.round((g.memUsedMiB / g.memTotalMiB) * 100);
    const div = document.createElement('div');
    div.className = 'gpu-card';
    div.innerHTML = `
      <div>GPU ${g.index} &middot; ${g.name}</div>
      <div class="gpu-bar-bg"><div class="gpu-bar-fill" style="width:${pct}%"></div></div>
      <div>${g.memUsedMiB} / ${g.memTotalMiB} MiB &middot; util ${g.utilPct}% &middot; ${g.tempC}&deg;C</div>
    `;
    gpuList.appendChild(div);
  });
}

async function refreshLogs() {
  const { text } = await api('/api/logs?lines=200');
  const atBottom = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 20;
  logView.textContent = text || '(no log yet)';
  if (atBottom) logView.scrollTop = logView.scrollHeight;
}

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  await api('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: profileSelect.value }) });
  refreshStatus();
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  await api('/api/stop', { method: 'POST' });
  refreshStatus();
});

btnRestart.addEventListener('click', async () => {
  await api('/api/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: profileSelect.value }) });
  refreshStatus();
});

btnOpen.addEventListener('click', () => {
  if (lastState && lastState.running) {
    window.open(`http://${location.hostname}:${lastState.port}`, '_blank');
  }
});

loadProfiles();
refreshStatus();
refreshLogs();
setInterval(refreshStatus, 3000);
setInterval(refreshLogs, 3000);
