// routes/admin.ts — Admin dashboard: live stats page + JSON stats endpoint.
//
//   GET  /admin            Self-contained HTML dashboard (no API key needed in header —
//                          the page prompts for it on first load and stores in sessionStorage)
//   GET  /api/admin/stats  JSON stats payload (requires x-api-key header)

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { deviceManager } from '../core/device-manager';
import { getWebhookQueue } from '../queue/index';
import { ServiceStatus } from '../types';
import { ok } from './helpers';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // ── JSON stats API ──────────────────────────────────────────────────────────
  app.get('/api/admin/stats', async () => {
    const allDevices = deviceManager.getAllInfos();

    const byStatus: Record<string, number> = {
      [ServiceStatus.CONNECTED]: 0,
      [ServiceStatus.QR_READY]: 0,
      [ServiceStatus.DISCONNECTED]: 0,
      [ServiceStatus.INITIALIZING]: 0,
      [ServiceStatus.ERROR]: 0,
    };

    const byClient: Record<string, { deviceId: string; name: string; phone: string | null; status: ServiceStatus }[]> = {};

    for (const info of allDevices) {
      const status = deviceManager.getManager(info.id)?.getStatus() ?? ServiceStatus.DISCONNECTED;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      if (!byClient[info.clientId]) byClient[info.clientId] = [];
      byClient[info.clientId].push({ deviceId: info.id, name: info.name, phone: info.phone ?? null, status });
    }

    const queue = getWebhookQueue();
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return ok({
      devices: { total: allDevices.length, byStatus, byClient },
      queue: { waiting, active, completed, failed, delayed },
      uptime: Math.floor(process.uptime()),
      timestamp: Date.now(),
    });
  });

  // ── HTML dashboard ──────────────────────────────────────────────────────────
  app.get('/admin', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/html').send(DASHBOARD_HTML);
  });
}

// ── Dashboard HTML (self-contained, no external dependencies) ─────────────────
const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp Gateway — Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0f1117;
      --surface: #1a1d27;
      --border: #2a2d3a;
      --text: #e2e8f0;
      --muted: #64748b;
      --green: #22c55e;
      --yellow: #eab308;
      --red: #ef4444;
      --blue: #3b82f6;
      --orange: #f97316;
      --purple: #a855f7;
    }

    body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; font-size: 14px; min-height: 100vh; }

    header { padding: 20px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    header h1 { font-size: 18px; font-weight: 600; }
    header h1 span { color: var(--green); }
    #meta { color: var(--muted); font-size: 12px; text-align: right; line-height: 1.7; }

    main { padding: 24px 32px; display: flex; flex-direction: column; gap: 28px; max-width: 1200px; }

    h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin-bottom: 12px; }

    /* Stat cards */
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 8px; }
    .card .value { font-size: 28px; font-weight: 700; line-height: 1; }
    .card.green .value { color: var(--green); }
    .card.yellow .value { color: var(--yellow); }
    .card.red .value { color: var(--red); }
    .card.blue .value { color: var(--blue); }
    .card.orange .value { color: var(--orange); }
    .card.purple .value { color: var(--purple); }
    .card.neutral .value { color: var(--text); }

    /* Queue bar */
    .queue-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; }

    /* Clients table */
    .client-block { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .client-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; font-weight: 600; }
    .client-id { font-family: monospace; font-size: 13px; }
    .device-count { margin-left: auto; font-size: 12px; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 8px 16px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); border-bottom: 1px solid var(--border); }
    td { padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    td:first-child { font-family: monospace; color: var(--muted); font-size: 12px; }

    .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .badge.CONNECTED    { color: var(--green);  background: #14532d33; }
    .badge.QR_READY     { color: var(--yellow); background: #78350f33; }
    .badge.DISCONNECTED { color: var(--muted);  background: #1e293b;   }
    .badge.INITIALIZING { color: var(--blue);   background: #1e3a5f33; }
    .badge.ERROR        { color: var(--red);    background: #7f1d1d33; }

    #login-overlay { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .login-box { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 32px; width: 340px; }
    .login-box h2 { color: var(--text); margin-bottom: 8px; font-size: 16px; }
    .login-box p { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
    .login-box input { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font-size: 14px; outline: none; }
    .login-box input:focus { border-color: var(--blue); }
    .login-box button { margin-top: 12px; width: 100%; background: var(--blue); border: none; border-radius: 8px; padding: 10px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
    .login-box button:hover { opacity: .9; }
    .login-box .error { color: var(--red); font-size: 12px; margin-top: 8px; display: none; }

    #refresh-bar { height: 2px; background: var(--blue); transition: width .3s linear; width: 100%; position: fixed; top: 0; left: 0; }
    .empty { color: var(--muted); padding: 16px; font-style: italic; }
  </style>
</head>
<body>

<div id="refresh-bar"></div>

<div id="login-overlay">
  <div class="login-box">
    <h2>Admin Dashboard</h2>
    <p>Enter your API key to continue.</p>
    <input id="key-input" type="password" placeholder="x-api-key" autocomplete="off" />
    <button onclick="submitKey()">Sign in</button>
    <div class="error" id="key-error">Invalid API key — try again.</div>
  </div>
</div>

<header>
  <h1>WhatsApp Gateway <span>Admin</span></h1>
  <div id="meta">
    <div id="uptime-label">Uptime: —</div>
    <div id="last-updated">Last updated: —</div>
  </div>
</header>

<main>
  <section id="device-section">
    <h2>Devices</h2>
    <div class="cards" id="device-cards">
      <div class="card neutral"><div class="label">Total</div><div class="value" id="d-total">—</div></div>
      <div class="card green"><div class="label">Connected</div><div class="value" id="d-connected">—</div></div>
      <div class="card yellow"><div class="label">QR Ready</div><div class="value" id="d-qr">—</div></div>
      <div class="card neutral"><div class="label">Disconnected</div><div class="value" id="d-disc">—</div></div>
      <div class="card blue"><div class="label">Initializing</div><div class="value" id="d-init">—</div></div>
      <div class="card red"><div class="label">Error</div><div class="value" id="d-error">—</div></div>
    </div>
  </section>

  <section id="queue-section">
    <h2>Webhook Queue</h2>
    <div class="queue-grid">
      <div class="card blue"><div class="label">Active</div><div class="value" id="q-active">—</div></div>
      <div class="card orange"><div class="label">Waiting</div><div class="value" id="q-waiting">—</div></div>
      <div class="card purple"><div class="label">Delayed</div><div class="value" id="q-delayed">—</div></div>
      <div class="card green"><div class="label">Completed</div><div class="value" id="q-completed">—</div></div>
      <div class="card red"><div class="label">Failed</div><div class="value" id="q-failed">—</div></div>
    </div>
  </section>

  <section id="clients-section">
    <h2>Clients</h2>
    <div id="clients-list"></div>
  </section>
</main>

<script>
  const REFRESH_INTERVAL = 5000;
  let apiKey = sessionStorage.getItem('wga_key') || '';
  let refreshTimer = null;
  let refreshProgressTimer = null;
  let refreshStart = null;

  if (apiKey) startDashboard();

  function submitKey() {
    const val = document.getElementById('key-input').value.trim();
    if (!val) return;
    apiKey = val;
    fetchStats().then(ok => {
      if (ok) {
        sessionStorage.setItem('wga_key', apiKey);
        document.getElementById('login-overlay').style.display = 'none';
        startDashboard();
      } else {
        document.getElementById('key-error').style.display = 'block';
      }
    });
  }

  document.getElementById('key-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitKey();
  });

  function startDashboard() {
    document.getElementById('login-overlay').style.display = 'none';
    fetchStats();
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    clearInterval(refreshProgressTimer);
    refreshStart = Date.now();
    animateBar();
    refreshTimer = setTimeout(() => {
      fetchStats();
      scheduleRefresh();
    }, REFRESH_INTERVAL);
  }

  function animateBar() {
    const bar = document.getElementById('refresh-bar');
    refreshProgressTimer = setInterval(() => {
      const elapsed = Date.now() - refreshStart;
      const pct = Math.min(100, (elapsed / REFRESH_INTERVAL) * 100);
      bar.style.width = pct + '%';
      if (pct >= 100) clearInterval(refreshProgressTimer);
    }, 50);
  }

  async function fetchStats() {
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { 'x-api-key': apiKey }
      });
      if (res.status === 401) return false;
      const json = await res.json();
      renderStats(json.data);
      return true;
    } catch (e) {
      return false;
    }
  }

  function renderStats(data) {
    const { devices, queue, uptime, timestamp } = data;
    const bs = devices.byStatus;

    // Device cards
    document.getElementById('d-total').textContent     = devices.total;
    document.getElementById('d-connected').textContent = bs['CONNECTED']    ?? 0;
    document.getElementById('d-qr').textContent        = bs['QR_READY']     ?? 0;
    document.getElementById('d-disc').textContent      = bs['DISCONNECTED'] ?? 0;
    document.getElementById('d-init').textContent      = bs['INITIALIZING'] ?? 0;
    document.getElementById('d-error').textContent     = bs['ERROR']        ?? 0;

    // Queue cards
    document.getElementById('q-active').textContent    = queue.active;
    document.getElementById('q-waiting').textContent   = queue.waiting;
    document.getElementById('q-delayed').textContent   = queue.delayed;
    document.getElementById('q-completed').textContent = queue.completed;
    document.getElementById('q-failed').textContent    = queue.failed;

    // Uptime
    const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = uptime % 60;
    document.getElementById('uptime-label').textContent =
      'Uptime: ' + [h && h+'h', m && m+'m', s+'s'].filter(Boolean).join(' ');
    document.getElementById('last-updated').textContent =
      'Updated: ' + new Date(timestamp).toLocaleTimeString();

    // Clients
    const container = document.getElementById('clients-list');
    const clients = devices.byClient;
    const ids = Object.keys(clients);

    if (ids.length === 0) {
      container.innerHTML = '<div class="empty">No clients registered yet.</div>';
      return;
    }

    container.innerHTML = ids.map(clientId => {
      const devs = clients[clientId];
      const rows = devs.map(d => \`
        <tr>
          <td>\${d.deviceId}</td>
          <td>\${esc(d.name)}</td>
          <td>\${d.phone ?? '<span style="color:var(--muted)">—</span>'}</td>
          <td><span class="badge \${d.status}">\${d.status.replace('_', ' ')}</span></td>
        </tr>
      \`).join('');
      return \`
        <div class="client-block" style="margin-bottom:12px">
          <div class="client-header">
            <span class="client-id">\${esc(clientId)}</span>
            <span class="device-count">\${devs.length} device\${devs.length !== 1 ? 's' : ''}</span>
          </div>
          <table>
            <thead><tr><th>Device ID</th><th>Name</th><th>Phone</th><th>Status</th></tr></thead>
            <tbody>\${rows}</tbody>
          </table>
        </div>
      \`;
    }).join('');
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
</script>
</body>
</html>`;
