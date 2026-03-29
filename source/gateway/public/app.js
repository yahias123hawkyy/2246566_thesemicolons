// ── State ─────────────────────────────────────────────────────────────────────
const MAX_LIVE    = 200;
const MAX_HISTORY = 300;
let liveEvents     = [];
let activeFilter   = 'ALL';
let counts         = { EARTHQUAKE: 0, EXPLOSION: 0, NUCLEAR: 0 };
let historyRowCount = 0;

// ── Clock ─────────────────────────────────────────────────────────────────────
const clockEl = document.getElementById('clock');
setInterval(() => {
  clockEl.textContent = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}, 1000);

// ── System log ────────────────────────────────────────────────────────────────
const syslog = document.getElementById('syslog');
function log(msg, type = '') {
  const d = document.createElement('div');
  d.className = 'log-line ' + type;
  const ts = new Date().toISOString().slice(11, 19);
  d.textContent = `${ts} ${msg}`;
  syslog.prepend(d);
  if (syslog.children.length > 80) syslog.lastChild.remove();
}

// ── Connection badge ──────────────────────────────────────────────────────────
function setConn(state) {
  const dot  = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  const pill = document.getElementById('conn-pill');
  dot.className  = `dot ${state === 'live' ? 'green' : state === 'dead' ? 'red' : 'grey'}`;
  pill.className = `pill ${state === 'live' ? 'green' : state === 'dead' ? 'red' : 'grey'}`;
  text.textContent = state === 'live' ? 'Live' : state === 'dead' ? 'Disconnected' : 'Connecting…';
}

// ── Event type helpers ────────────────────────────────────────────────────────
function cssClass(type) {
  return type === 'EARTHQUAKE' ? 'eq' : type === 'EXPLOSION' ? 'ex' : type === 'NUCLEAR' ? 'nu' : '';
}
function tdClass(type) {
  return type === 'EARTHQUAKE' ? 'c-eq' : type === 'EXPLOSION' ? 'c-ex' : type === 'NUCLEAR' ? 'c-nu' : 'c-dim';
}

// ── Render alert feed ─────────────────────────────────────────────────────────
const feedEl  = document.getElementById('alert-feed');
const emptyEl = document.getElementById('alert-empty');
const countEl = document.getElementById('alert-count');

function renderFeed() {
  const visible = activeFilter === 'ALL'
    ? liveEvents
    : liveEvents.filter(e => e.event_type === activeFilter);

  while (feedEl.firstChild) feedEl.removeChild(feedEl.firstChild);

  if (visible.length === 0) {
    feedEl.appendChild(emptyEl);
    return;
  }

  for (const ev of visible) {
    const row = document.createElement('div');
    row.className = `alert ${cssClass(ev.event_type)}`;
    const ts = new Date(ev.timestamp || ev.detected_at).toISOString().replace('T', ' ').slice(0, 19);
    row.innerHTML = `
      <span class="type-tag">${ev.event_type.slice(0, 4)}</span>
      <span class="sensor-name" title="${ev.sensor_id}">${ev.sensor_id}</span>
      <span class="freq-val">${(ev.dominant_frequency ?? 0).toFixed(3)} Hz</span>
      <span class="ts-val">${ts.slice(11)}</span>`;
    feedEl.appendChild(row);
  }
}

// ── Add event ─────────────────────────────────────────────────────────────────
function addEvent(ev) {
  liveEvents.unshift(ev);
  if (liveEvents.length > MAX_LIVE) liveEvents.pop();

  if (ev.event_type in counts) counts[ev.event_type]++;
  document.getElementById('st-total').textContent = liveEvents.length;
  document.getElementById('st-eq').textContent    = counts.EARTHQUAKE;
  document.getElementById('st-ex').textContent    = counts.EXPLOSION;
  document.getElementById('st-nu').textContent    = counts.NUCLEAR;
  countEl.textContent = `${liveEvents.length} events`;

  renderFeed();
  prependHistoryRow(ev);
  log(`${ev.event_type} | ${ev.sensor_id} | ${(ev.dominant_frequency ?? 0).toFixed(3)} Hz`, 'info');
}

// ── History table ─────────────────────────────────────────────────────────────
const histBody  = document.getElementById('history-body');
const histCount = document.getElementById('history-count');

function prependHistoryRow(ev) {
  const ts = new Date(ev.timestamp || ev.detected_at).toISOString().replace('T', ' ').slice(0, 19);
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="c-dim">${ts}</td>
    <td class="c-dim">${ev.sensor_id}</td>
    <td class="${tdClass(ev.event_type)}">${ev.event_type}</td>
    <td class="c-dim">${(ev.dominant_frequency ?? 0).toFixed(4)}</td>
    <td class="c-dim">${ev.replica_id ?? '—'}</td>`;
  histBody.prepend(tr);
  historyRowCount++;
  histCount.textContent = `${historyRowCount} rows`;
  if (histBody.children.length > MAX_HISTORY) histBody.lastChild.remove();
}

// ── Filters ───────────────────────────────────────────────────────────────────
const typeColors = { EARTHQUAKE: 'eq', EXPLOSION: 'ex', NUCLEAR: 'nu' };
document.querySelectorAll('.fbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fbtn').forEach(b => {
      b.classList.remove('active', 'eq', 'ex', 'nu');
    });
    btn.classList.add('active');
    const t = btn.dataset.type;
    if (t in typeColors) btn.classList.add(typeColors[t]);
    activeFilter = t;
    renderFeed();
  });
});

// ── Load history from REST ────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const r = await fetch('/api/events?limit=100');
    if (!r.ok) { log('History fetch failed: HTTP ' + r.status, 'err'); return; }
    const data = await r.json();
    log(`Loaded ${data.length} historical events`, 'ok');
    for (const ev of [...data].reverse()) addEvent(ev);
  } catch (e) {
    log('History fetch error: ' + e.message, 'err');
  }
}

// ── SSE live feed ─────────────────────────────────────────────────────────────
function connectSSE() {
  setConn('connecting');
  log('Connecting to live event stream…');
  const es = new EventSource('/api/events/stream');

  es.onopen = () => { setConn('live'); log('Live stream connected', 'ok'); };

  es.onmessage = (e) => {
    try { addEvent(JSON.parse(e.data)); } catch { /* ignore */ }
  };

  es.onerror = () => {
    setConn('dead');
    log('Stream lost — reconnecting in 5s', 'warn');
    es.close();
    setTimeout(connectSSE, 5000);
  };
}

// ── Replica status ────────────────────────────────────────────────────────────
const repList = document.getElementById('replica-list');
const repStat = document.getElementById('st-rep');

async function pollReplicas() {
  try {
    const r = await fetch('/gateway/replicas');
    if (!r.ok) return;
    const data = await r.json();
    const up = data.filter(x => x.healthy).length;
    repStat.textContent = `${up}/${data.length}`;
    repList.innerHTML = '';
    for (const rep of data) {
      const row = document.createElement('div');
      row.className = 'rep-row';
      const name = rep.url.replace(/https?:\/\//, '').split(':')[0];
      row.innerHTML = `
        <span class="dot ${rep.healthy ? 'green' : 'red'}"></span>
        <span class="rep-name">${name}</span>
        <span class="rep-status ${rep.healthy ? 'up' : 'down'}">${rep.healthy ? 'ONLINE' : 'OFFLINE'}</span>`;
      repList.appendChild(row);
    }
  } catch { /* silent */ }
}
setInterval(pollReplicas, 5000);

// ── Sensor list for injection dropdown ───────────────────────────────────────
const injSensor = document.getElementById('inj-sensor');

async function loadSensors() {
  try {
    const r = await fetch('/admin/devices');
    if (!r.ok) return;
    const sensors = await r.json();
    injSensor.innerHTML = '';
    for (const s of sensors) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.id} — ${s.name}`;
      injSensor.appendChild(opt);
    }
    log(`Loaded ${sensors.length} sensors`, 'ok');
  } catch (e) {
    log('Sensor list error: ' + e.message, 'err');
  }
}

// ── Admin: manual shutdown ────────────────────────────────────────────────────
const adminLog = document.getElementById('admin-log');

document.getElementById('btn-shutdown').addEventListener('click', async () => {
  adminLog.textContent = 'Sending…';
  try {
    const r = await fetch('/admin/shutdown', { method: 'POST' });
    const d = await r.json();
    if (r.ok) {
      adminLog.textContent = `✓ Shutdown sent at ${d.issuedAt?.slice(11, 19) ?? ''}`;
      log('Manual shutdown triggered', 'warn');
    } else {
      adminLog.textContent = `✗ ${r.status}: ${d.detail ?? JSON.stringify(d)}`;
      log('Shutdown failed: ' + r.status, 'err');
    }
  } catch (e) {
    adminLog.textContent = '✗ ' + e.message;
    log('Shutdown error: ' + e.message, 'err');
  }
});

// ── Admin: inject event ───────────────────────────────────────────────────────
const injectLog = document.getElementById('inject-log');

document.getElementById('btn-inject').addEventListener('click', async () => {
  const sid  = injSensor.value;
  const type = document.getElementById('inj-type').value;
  if (!sid) { injectLog.textContent = '✗ No sensor selected'; return; }
  injectLog.textContent = 'Injecting…';
  try {
    const r = await fetch(`/admin/sensors/${encodeURIComponent(sid)}/events`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ event_type: type }),
    });
    const d = await r.json();
    if (r.ok) {
      injectLog.textContent = `✓ ${type} injected on ${sid}`;
      log(`Injected ${type} on ${sid}`, 'ok');
    } else {
      injectLog.textContent = `✗ ${r.status}`;
      log('Inject failed: ' + r.status, 'err');
    }
  } catch (e) {
    injectLog.textContent = '✗ ' + e.message;
    log('Inject error: ' + e.message, 'err');
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
loadSensors();
pollReplicas();
loadHistory();
connectSSE();
