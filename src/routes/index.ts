// routes/index.ts — Entry point: registers the global auth hook and all route sub-modules.
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config';
import { verifyClientKey } from '../core/client-config';
import { logger } from '../logger';
import { fail, ok } from './helpers';
import { registerConfigRoutes } from './config';
import { registerDeviceRoutes } from './devices';
import { registerMessageRoutes } from './messages';
import { registerContactRoutes } from './contacts';
import { registerChatRoutes } from './chats';
import { registerGroupRoutes } from './groups';
import { registerAccessRoutes } from './access';
import { registerAdminRoutes } from './admin';

// ── In-process rate limiter (sliding window per IP) ─────────────────────────────────
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const ipHits = new Map<string, number[]>();

// Clean up stale entries every 2 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of ipHits) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) ipHits.delete(ip);
    else ipHits.set(ip, recent);
  }
}, 120_000).unref();

function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let timestamps = ipHits.get(ip);
  if (!timestamps) {
    timestamps = [];
    ipHits.set(ip, timestamps);
  }
  // Remove expired entries
  while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }
  timestamps.push(now);
  return { allowed: true, remaining: RATE_LIMIT_MAX - timestamps.length };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  // ── Global auth guard ────────────────────────────────────────────────────
  // Rate limit + auth: runs on every request.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Rate limit check (before auth, before everything)
    const clientIp = request.ip;
    const { allowed, remaining } = checkRateLimit(clientIp);
    reply.header('x-ratelimit-limit', RATE_LIMIT_MAX);
    reply.header('x-ratelimit-remaining', remaining);
    if (!allowed) {
      logger.warn({ ip: clientIp, url: request.url }, 'Rate limit exceeded');
      reply.code(429).send(fail('RATE_LIMITED', 'Too many requests — try again later'));
      return;
    }

    // Public endpoints — no auth required
    if (request.url === '/api/status') return;
    if (request.url === '/') return;
    if (request.url === '/admin') return;  // Static shell — no data; prompts for key in-browser

    const masterKey = config.API_KEY;
    const providedKey = request.headers['x-api-key'] as string | undefined;

    // Master key: unrestricted access
    if (providedKey === masterKey) return;

    // Client key: allowed only on /api/clients/:clientId/* routes, for that specific client.
    // The key is verified by re-hashing the provided value — plaintext is never stored.
    const clientMatch = request.url.match(/^\/api\/clients\/([^/]+)/);
    if (clientMatch && providedKey) {
      const clientId = decodeURIComponent(clientMatch[1]);
      if (await verifyClientKey(clientId, providedKey, request.ip)) return;
    }

    reply.code(401).send(fail('UNAUTHORIZED', 'Invalid or missing API key'));
  });

  // ── Public pages (no auth) ───────────────────────────────────────────────
  app.get('/api/status', async () => ok({ status: 'ok', timestamp: Date.now() }));

  app.get('/', async (_request, reply) => {
    reply.type('text/html').send(DOCS_HTML);
  });

  // ── Domain route modules ─────────────────────────────────────────────────
  await registerConfigRoutes(app);
  await registerDeviceRoutes(app);
  await registerMessageRoutes(app);
  await registerContactRoutes(app);
  await registerChatRoutes(app);
  await registerGroupRoutes(app);
  await registerAccessRoutes(app);
  await registerAdminRoutes(app);
}

// ── API reference page ───────────────────────────────────────────────────────
const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Gateway — API Reference</title>
<style>
:root {
  --bg:#0f1117; --surface:#1a1d27; --surface2:#13161e; --border:#2a2d3a;
  --text:#e2e8f0; --muted:#94a3b8; --faint:#4a5568;
  --accent:#25d366;
  --blue:#3b82f6; --green:#22c55e; --yellow:#f59e0b; --red:#ef4444; --orange:#f97316;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-size:14px;display:flex;min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:'SF Mono',Menlo,monospace;font-size:.8rem;background:#0d1117;border:1px solid var(--border);padding:.1rem .35rem;border-radius:4px;color:#e2e8f0}
pre{background:#0d1117;border:1px solid var(--border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:.8rem;line-height:1.7;margin:.6rem 0}
pre code{background:none;border:none;padding:0}
p{color:var(--muted);line-height:1.65;margin-bottom:.5rem}
h2{font-size:1.2rem;font-weight:700;color:var(--text);border-bottom:1px solid var(--border);padding-bottom:.5rem;margin-bottom:1rem;margin-top:0}
h3{font-size:.95rem;font-weight:600;color:var(--text);margin:.9rem 0 .4rem}
ul,ol{padding-left:1.3rem;color:var(--muted);line-height:1.8;margin-bottom:.5rem}

/* ── Sidebar ── */
.sidebar{width:218px;min-width:218px;height:100vh;position:sticky;top:0;overflow-y:auto;background:var(--surface);border-right:1px solid var(--border);padding:1.25rem 0;flex-shrink:0}
.sb-brand{padding:.25rem 1rem 1rem;border-bottom:1px solid var(--border);margin-bottom:.4rem}
.sb-name{font-size:.95rem;font-weight:700;color:var(--accent)}
.sb-sub{font-size:.7rem;color:var(--muted);margin-top:2px}
.sb-group{padding:.55rem 1rem .15rem;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--faint)}
.sb-link{display:block;padding:.28rem 1rem;font-size:.8rem;color:var(--muted)}
.sb-link:hover{color:var(--text);background:rgba(255,255,255,.04);text-decoration:none}

/* ── Main content ── */
.content{flex:1;min-width:0;padding:2rem 2.5rem;max-width:830px}
section{margin-bottom:2.75rem}

/* ── Method badges ── */
.m{display:inline-block;font-family:monospace;font-size:.68rem;font-weight:700;padding:.15rem .45rem;border-radius:4px;min-width:54px;text-align:center;vertical-align:middle}
.GET{background:#1e3a5f;color:var(--blue)}
.POST{background:#14371f;color:var(--green)}
.PUT{background:#3d2e0a;color:var(--yellow)}
.DELETE{background:#3d1212;color:var(--red)}

/* ── Endpoint accordion (pure HTML details/summary) ── */
.ep{border:1px solid var(--border);border-radius:10px;margin-bottom:.85rem;overflow:hidden}
details>summary{list-style:none}
details>summary::-webkit-details-marker{display:none}
.ep summary{background:var(--surface);padding:.65rem 1.1rem;cursor:pointer;display:flex;align-items:center;gap:.6rem;user-select:none}
.ep summary:hover{background:#1e2133}
.ep-path{font-family:monospace;font-size:.87rem;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ep-note{font-size:.75rem;color:var(--muted);flex-shrink:0}
.ep-body{background:var(--surface2);padding:.9rem 1.1rem;border-top:1px solid var(--border)}
.ep-lbl{font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);margin-bottom:.3rem;margin-top:.75rem}
.ep-lbl:first-child{margin-top:0}

/* ── Auth badge ── */
.ab{font-size:.65rem;padding:.12rem .38rem;border-radius:4px;border:1px solid;font-weight:600;flex-shrink:0}
.ab-pub{border-color:var(--green);color:var(--green)}
.ab-master{border-color:var(--orange);color:var(--orange)}
.ab-any{border-color:var(--blue);color:var(--blue)}

/* ── Tables ── */
table{width:100%;border-collapse:collapse;font-size:.8rem;margin:.4rem 0}
th{text-align:left;padding:.35rem .6rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border);font-size:.7rem;text-transform:uppercase;letter-spacing:.06em}
td{padding:.32rem .6rem;border-bottom:1px solid var(--border);vertical-align:top;color:var(--text)}
td.f{font-family:monospace;font-size:.78rem;color:#7dd3fc}
td.t{font-family:monospace;font-size:.75rem;color:var(--yellow)}
td.req{color:var(--red);font-size:.72rem;font-weight:700}
td.opt{color:var(--faint);font-size:.72rem}
tr:last-child td{border-bottom:none}

/* ── Callout ── */
.callout{background:#1a1d27;border-left:3px solid var(--accent);border-radius:0 8px 8px 0;padding:.6rem 1rem;margin:.7rem 0;font-size:.83rem;color:var(--muted)}
.callout.warn{border-color:var(--yellow)}
.callout.info{border-color:var(--blue)}
.callout strong{color:var(--text)}

/* ── Event pill ── */
.ev{display:inline-block;background:var(--surface);border:1px solid var(--border);border-radius:4px;font-family:monospace;font-size:.75rem;padding:.15rem .45rem;margin:.2rem .1rem}

footer{padding:2rem;text-align:center;color:var(--faint);font-size:.75rem;border-top:1px solid var(--border)}
</style>
</head>
<body>

<nav class="sidebar">
  <div class="sb-brand">
    <div class="sb-name">&#128262; WA Gateway</div>
    <div class="sb-sub">API Reference &mdash; v1</div>
  </div>
  <div class="sb-group">Basics</div>
  <a class="sb-link" href="#overview">Overview</a>
  <a class="sb-link" href="#auth">Authentication</a>
  <a class="sb-link" href="#responses">Responses &amp; Errors</a>
  <a class="sb-link" href="#rate-limiting">Rate Limiting</a>
  <div class="sb-group">API</div>
  <a class="sb-link" href="#health">Health</a>
  <a class="sb-link" href="#keys">Client Keys</a>
  <a class="sb-link" href="#config">Client Config</a>
  <a class="sb-link" href="#devices">Devices</a>
  <a class="sb-link" href="#messages">Messages</a>
  <a class="sb-link" href="#contacts">Contacts</a>
  <a class="sb-link" href="#chats">Chats</a>
  <a class="sb-link" href="#groups">Groups</a>
  <a class="sb-link" href="#access">Access Control</a>
  <div class="sb-group">Events &amp; Admin</div>
  <a class="sb-link" href="#webhooks">Webhook Events</a>
  <a class="sb-link" href="#admin">Admin</a>
</nav>

<div class="content">

<!-- OVERVIEW -->
<section id="overview">
  <h2>Overview</h2>
  <p>A multi-tenant WhatsApp gateway. Each <strong>client</strong> (tenant) registers one or more <strong>devices</strong> (paired phone numbers). Inbound messages, reactions, receipts, and presence events are forwarded to a per-client webhook URL in real time.</p>
  <div class="callout"><strong>Base URL:</strong> <code>https://wa.tachles.dev</code> &mdash; all API routes start with <code>/api</code>.</div>
  <h3>JID Format</h3>
  <p>WhatsApp addresses users and groups with JIDs (Jabber IDs):</p>
  <table>
    <tr><th>Type</th><th>Format</th><th>Example</th></tr>
    <tr><td>Individual</td><td class="f">&lt;phone&gt;@s.whatsapp.net</td><td class="f">972501234567@s.whatsapp.net</td></tr>
    <tr><td>Group</td><td class="f">&lt;id&gt;@g.us</td><td class="f">120363012340000001@g.us</td></tr>
  </table>
  <p>Send endpoints accept either a full <code>jid</code> <em>or</em> a <code>phone</code> (E.164 digits without <code>+</code>). When <code>phone</code> is used, the individual JID is derived automatically.</p>
</section>

<!-- AUTH -->
<section id="auth">
  <h2>Authentication</h2>
  <p>Include your API key as a header on every request:</p>
  <pre>x-api-key: &lt;your-key&gt;</pre>
  <table>
    <tr><th>Tier</th><th>Scope</th><th>Notes</th></tr>
    <tr><td class="f">Master key</td><td>All clients, admin endpoints</td><td>Set in server env. Operators only.</td></tr>
    <tr><td class="f">Client key</td><td>One <code>:clientId</code> only</td><td>Issue one per tenant via <a href="#keys">POST /key</a>.</td></tr>
  </table>
  <div class="callout warn"><strong>Client keys</strong> are scoped — they are only accepted on routes under <code>/api/clients/:clientId</code> for their own ID. Accessing a different client returns <code>401</code>.</div>
</section>

<!-- RESPONSES -->
<section id="responses">
  <h2>Responses &amp; Errors</h2>
  <p>All responses are JSON. Success wraps the result in <code>data</code>; errors include an <code>error</code> object.</p>
  <pre>// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Provide either jid or phone" } }</pre>
  <h3>Error Codes</h3>
  <table>
    <tr><th>HTTP</th><th>Code</th><th>Meaning</th></tr>
    <tr><td>400</td><td class="f">VALIDATION_ERROR</td><td>Request body or params failed schema validation</td></tr>
    <tr><td>401</td><td class="f">UNAUTHORIZED</td><td>Missing or invalid <code>x-api-key</code></td></tr>
    <tr><td>404</td><td class="f">NOT_FOUND</td><td>Device, client, or resource does not exist</td></tr>
    <tr><td>404</td><td class="f">QR_NOT_AVAILABLE</td><td>QR not yet generated &mdash; wait for initialization</td></tr>
    <tr><td>409</td><td class="f">DEVICE_LIMIT_EXCEEDED</td><td>Client has reached its <code>maxDevices</code> cap</td></tr>
    <tr><td>409</td><td class="f">ALREADY_EXISTS</td><td>Duplicate resource</td></tr>
    <tr><td>422</td><td class="f">NOT_CONNECTED</td><td>Device is not in CONNECTED state</td></tr>
    <tr><td>429</td><td class="f">RATE_LIMITED</td><td>30 req/min per IP exceeded</td></tr>
    <tr><td>500</td><td class="f">INTERNAL_ERROR</td><td>Unexpected server error</td></tr>
  </table>
</section>

<!-- RATE LIMITING -->
<section id="rate-limiting">
  <h2>Rate Limiting</h2>
  <p>Sliding-window limiter: <strong>30 requests / IP / 60 s</strong>. Response headers report usage:</p>
  <pre>x-ratelimit-limit: 30
x-ratelimit-remaining: 24</pre>
  <p>Exceeding the limit returns HTTP <code>429</code> with code <code>RATE_LIMITED</code>.</p>
</section>

<!-- HEALTH -->
<section id="health">
  <h2>Health</h2>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/api/status</span><span class="ab ab-pub">public</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div>
        <pre>{ "success": true, "data": { "status": "ok", "timestamp": 1741824000000 } }</pre>
      </div>
    </details>
  </div>
</section>

<!-- KEYS -->
<section id="keys">
  <h2>Client Keys</h2>
  <p>All key operations require the <strong>master key</strong>. A new key is returned <em>once</em> in plaintext &mdash; store it immediately. Only one active key per client exists at a time.</p>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/api/clients/:clientId/key</span><span class="ep-note">Issue key</span><span class="ab ab-master">master</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body (optional)</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">ttlDays</td><td class="t">number</td><td class="opt">opt</td><td>1&ndash;365 days. Omit for no expiry.</td></tr>
        </table>
        <div class="ep-lbl">Response</div>
        <pre>{ "key": "wgk_…", "expiresAt": 1757000000000 }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/api/clients/:clientId/key/rotate</span><span class="ep-note">Rotate key</span><span class="ab ab-any">master or client</span></summary>
      <div class="ep-body">
        <p>Invalidates the current key and issues a new one. Supply the existing client key (or master) in <code>x-api-key</code>.</p>
        <div class="ep-lbl">Body (optional)</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">ttlDays</td><td class="t">number</td><td class="opt">opt</td><td>1&ndash;365</td></tr>
        </table>
        <div class="ep-lbl">Response</div>
        <pre>{ "key": "wgk_…", "expiresAt": 1757000000000 }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/api/clients/:clientId/key</span><span class="ep-note">Revoke key</span><span class="ab ab-master">master</span></summary>
      <div class="ep-body">
        <p>Revokes immediately. Subsequent requests using the old key return <code>401</code>.</p>
        <div class="ep-lbl">Response</div>
        <pre>{ "revoked": true }</pre>
      </div>
    </details>
  </div>
</section>

<!-- CONFIG -->
<section id="config">
  <h2>Client Config</h2>
  <p>Per-client webhook settings, event toggles, chat defaults, and device cap. All fields are optional on PUT. Setting nullable fields (<code>webhookUrl</code>, <code>webhookApiKey</code>) to <code>null</code> reverts them to server-wide defaults.</p>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/api/clients/:clientId/config</span><span class="ab ab-any">master or client</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div>
        <pre>{
  "webhookUrl": "https://app.example.com/hooks/wa",
  "webhookApiKey": null,
  "events": {
    "messages": true, "reactions": true, "receipts": true,
    "groupParticipants": true, "presenceUpdates": false,
    "groupUpdates": true, "calls": true
  },
  "chats": { "defaultKind": null, "hideUnnamed": false },
  "maxDevices": 5,
  "key": { "hasKey": true, "expiresAt": null, "lastUsedAt": 1741800000000 }
}</pre>
        <div class="callout info"><strong>Note:</strong> The raw key hash is never returned. Only <code>key.hasKey</code>, <code>key.expiresAt</code>, and <code>key.lastUsedAt</code> are exposed.</div>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m PUT">PUT</span><span class="ep-path">/api/clients/:clientId/config</span><span class="ep-note">Partial update</span><span class="ab ab-any">master or client</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body fields (all optional)</div>
        <table>
          <tr><th>Field</th><th>Type</th><th>Description</th></tr>
          <tr><td class="f">webhookUrl</td><td class="t">string | null</td><td>Destination for event POSTs.</td></tr>
          <tr><td class="f">webhookApiKey</td><td class="t">string | null</td><td>Sent as <code>x-api-key</code> on webhook calls.</td></tr>
          <tr><td class="f">events.messages</td><td class="t">boolean</td><td>Inbound message events.</td></tr>
          <tr><td class="f">events.reactions</td><td class="t">boolean</td><td>Reaction events.</td></tr>
          <tr><td class="f">events.receipts</td><td class="t">boolean</td><td>Delivery and read receipt events.</td></tr>
          <tr><td class="f">events.groupParticipants</td><td class="t">boolean</td><td>Group member change events.</td></tr>
          <tr><td class="f">events.presenceUpdates</td><td class="t">boolean</td><td>Typing / online presence events.</td></tr>
          <tr><td class="f">events.groupUpdates</td><td class="t">boolean</td><td>Group subject / description change events.</td></tr>
          <tr><td class="f">events.calls</td><td class="t">boolean</td><td>Incoming call events.</td></tr>
          <tr><td class="f">chats.defaultKind</td><td class="t">"CONTACT"|"GROUP"|null</td><td>Default filter for chat list.</td></tr>
          <tr><td class="f">chats.hideUnnamed</td><td class="t">boolean</td><td>Omit chats without a name.</td></tr>
          <tr><td class="f">maxDevices</td><td class="t">number</td><td>1&ndash;20. Hard cap on device registrations.</td></tr>
        </table>
        <div class="ep-lbl">Response</div>
        <p>Full updated config object (same shape as GET).</p>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/api/clients/:clientId/config</span><span class="ep-note">Reset to defaults</span><span class="ab ab-master">master</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div><p>Full reset config object.</p>
      </div>
    </details>
  </div>
</section>

<!-- DEVICES -->
<section id="devices">
  <h2>Devices</h2>
  <p>A device is a WhatsApp-paired phone number within a client. After registration, scan the QR code once to link a phone. The session is persisted &mdash; no re-scan after restarts.</p>
  <p>Base path: <code>/api/clients/:clientId/devices</code></p>

  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/</span><span class="ep-note">List devices</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div>
        <pre>[{
  "id": "my-phone", "clientId": "acme", "name": "Sales Phone", "phone": "972501234567",
  "status": { "status": "CONNECTED", "connectedAt": 1741800000000, "lastDisconnect": null, "qr": null }
}]</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/</span><span class="ep-note">Register device</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">name</td><td class="t">string</td><td class="req">req</td><td>Human label, 1&ndash;100 chars.</td></tr>
        </table>
        <p>After creation the device enters INITIALIZING &rarr; QR_READY. Fetch and scan the QR to connect.</p>
        <div class="ep-lbl">Response (201)</div>
        <pre>{ "id": "my-phone", "clientId": "acme", "name": "Sales Phone", "phone": null }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/:deviceId</span><span class="ep-note">Remove device</span></summary>
      <div class="ep-body">
        <p>Disconnects and permanently deletes the device. Session credentials are wiped.</p>
        <div class="ep-lbl">Response</div><pre>{ "deleted": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/:deviceId/status</span><span class="ep-note">Connection status</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Status values</div>
        <table>
          <tr><th>Value</th><th>Meaning</th></tr>
          <tr><td class="f">INITIALIZING</td><td>Socket starting up</td></tr>
          <tr><td class="f">QR_READY</td><td>QR available &mdash; awaiting scan</td></tr>
          <tr><td class="f">CONNECTED</td><td>Phone is linked and online</td></tr>
          <tr><td class="f">DISCONNECTED</td><td>No active connection</td></tr>
          <tr><td class="f">ERROR</td><td>Fatal error &mdash; check server logs</td></tr>
        </table>
        <div class="ep-lbl">Response</div>
        <pre>{ "status": "CONNECTED", "connectedAt": 1741800000000, "lastDisconnect": null, "qr": null }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/:deviceId/auth/qr</span><span class="ep-note">Get QR code</span></summary>
      <div class="ep-body">
        <p>Returns a base64 PNG when the device is in <code>QR_READY</code> state. Returns <code>{ "qr": null, "message": "Already connected" }</code> when <code>CONNECTED</code>. Returns <code>404 QR_NOT_AVAILABLE</code> if init hasn't run yet.</p>
        <div class="ep-lbl">Response</div>
        <pre>{ "qr": "data:image/png;base64,iVBORw0KGgo…" }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:deviceId/auth/reset</span><span class="ep-note">Clear session &amp; re-QR</span></summary>
      <div class="ep-body">
        <p>Wipes stored credentials and forces a new QR scan. Use when the phone was logged out or replaced.</p>
        <div class="ep-lbl">Response</div>
        <pre>{ "message": "Auth cleared. New QR will be generated shortly." }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:deviceId/disconnect</span><span class="ep-note">Graceful disconnect</span></summary>
      <div class="ep-body">
        <p>Closes the socket without wiping credentials. Resume with <code>/reconnect</code>.</p>
        <div class="ep-lbl">Response</div><pre>{ "disconnected": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:deviceId/reconnect</span><span class="ep-note">Re-initiate connection</span></summary>
      <div class="ep-body">
        <p>Restarts the connection using stored credentials. If credentials are missing, a new QR is generated.</p>
        <div class="ep-lbl">Response</div><pre>{ "reconnecting": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/:deviceId/profile</span><span class="ep-note">Own WhatsApp profile</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div>
        <pre>{ "jid": "972501234567@s.whatsapp.net", "name": "Sales Bot", "status": "Available" }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m PUT">PUT</span><span class="ep-path">/:deviceId/profile/name</span><span class="ep-note">Update display name</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">name</td><td class="t">string</td><td class="req">req</td><td>1&ndash;25 chars</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "updated": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m PUT">PUT</span><span class="ep-path">/:deviceId/profile/status</span><span class="ep-note">Update status text</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">status</td><td class="t">string</td><td class="req">req</td><td>Max 139 chars</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "updated": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:deviceId/presence</span><span class="ep-note">Broadcast presence</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">presence</td><td class="t">string</td><td class="req">req</td><td><code>available</code> | <code>unavailable</code> | <code>composing</code> | <code>recording</code> | <code>paused</code></td></tr>
          <tr><td class="f">toJid</td><td class="t">string</td><td class="opt">opt</td><td>Target JID. Omit to broadcast globally.</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "sent": true }</pre>
      </div>
    </details>
  </div>
</section>

<!-- MESSAGES -->
<section id="messages">
  <h2>Messages</h2>
  <p>Base path: <code>/api/clients/:clientId/devices/:deviceId/messages</code></p>
  <p>All send endpoints require exactly one of <code>jid</code> (full WhatsApp JID) or <code>phone</code> (E.164 digits, no <code>+</code>).</p>
  <p><strong>Common <code>options</code> object</strong> (optional on all text/media sends):</p>
  <table>
    <tr><th>Field</th><th>Type</th><th>Description</th></tr>
    <tr><td class="f">quotedMessageId</td><td class="t">string</td><td>Reply to / quote a message by its ID.</td></tr>
    <tr><td class="f">mentionedJids</td><td class="t">string[]</td><td>JIDs to @-mention in the message.</td></tr>
  </table>

  <div class="ep">
    <details open>
      <summary><span class="m POST">POST</span><span class="ep-path">/send-text</span><span class="ep-note">Send text</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">jid</td><td class="t">string</td><td class="opt">jid|phone</td><td>Full WhatsApp JID</td></tr>
          <tr><td class="f">phone</td><td class="t">string</td><td class="opt">jid|phone</td><td>E.164 digits without <code>+</code></td></tr>
          <tr><td class="f">text</td><td class="t">string</td><td class="req">req</td><td>1&ndash;10,000 chars</td></tr>
          <tr><td class="f">options</td><td class="t">object</td><td class="opt">opt</td><td>quotedMessageId, mentionedJids</td></tr>
        </table>
        <div class="ep-lbl">Example request</div>
        <pre>POST /api/clients/acme/devices/my-phone/messages/send-text
{ "phone": "972501234567", "text": "Hello from WA Gateway!" }</pre>
        <div class="ep-lbl">Response</div>
        <pre>{ "messageId": "3EB0C0A1B2C3D4E5F6", "timestamp": 1741800000 }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/send-image</span><span class="ep-note">Send image</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">jid / phone</td><td class="t">string</td><td class="req">req</td><td>Recipient (one required)</td></tr>
          <tr><td class="f">media.url</td><td class="t">string</td><td class="opt">url|b64</td><td>Public image URL</td></tr>
          <tr><td class="f">media.base64</td><td class="t">string</td><td class="opt">url|b64</td><td>Base64-encoded bytes (max 20 MB)</td></tr>
          <tr><td class="f">caption</td><td class="t">string</td><td class="opt">opt</td><td>Max 1,024 chars</td></tr>
          <tr><td class="f">options</td><td class="t">object</td><td class="opt">opt</td><td>quotedMessageId, mentionedJids</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "messageId": "3EB0…", "timestamp": 1741800000 }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/send-video</span><span class="ep-note">Send video</span></summary>
      <div class="ep-body">
        <p>Same body shape as <code>/send-image</code>: <code>jid|phone</code>, <code>media.url|base64</code>, optional <code>caption</code> and <code>options</code>.</p>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/send-audio</span><span class="ep-note">Send audio / voice note</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">jid / phone</td><td class="t">string</td><td class="req">req</td><td>Recipient</td></tr>
          <tr><td class="f">media.url / .base64</td><td class="t">string</td><td class="req">req</td><td>Audio source (one required)</td></tr>
          <tr><td class="f">ptt</td><td class="t">boolean</td><td class="opt">opt</td><td><code>true</code> to send as voice note (plays inline)</td></tr>
          <tr><td class="f">options</td><td class="t">object</td><td class="opt">opt</td><td>quotedMessageId, mentionedJids</td></tr>
        </table>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/send-document</span><span class="ep-note">Send file / document</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">jid / phone</td><td class="t">string</td><td class="req">req</td><td>Recipient</td></tr>
          <tr><td class="f">media.url / .base64</td><td class="t">string</td><td class="req">req</td><td>File source (one required)</td></tr>
          <tr><td class="f">fileName</td><td class="t">string</td><td class="opt">opt</td><td>Displayed filename, e.g. <code>report.pdf</code></td></tr>
          <tr><td class="f">mimeType</td><td class="t">string</td><td class="opt">opt</td><td>MIME type hint, e.g. <code>application/pdf</code></td></tr>
          <tr><td class="f">options</td><td class="t">object</td><td class="opt">opt</td><td>quotedMessageId, mentionedJids</td></tr>
        </table>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/send-location</span><span class="ep-note">Send GPS location</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">jid / phone</td><td class="t">string</td><td class="req">req</td><td>Recipient</td></tr>
          <tr><td class="f">latitude</td><td class="t">number</td><td class="req">req</td><td>&minus;90 to 90</td></tr>
          <tr><td class="f">longitude</td><td class="t">number</td><td class="req">req</td><td>&minus;180 to 180</td></tr>
          <tr><td class="f">name</td><td class="t">string</td><td class="opt">opt</td><td>Location name</td></tr>
          <tr><td class="f">address</td><td class="t">string</td><td class="opt">opt</td><td>Address line</td></tr>
        </table>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/send-reaction</span><span class="ep-note">React to a message</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">jid / phone</td><td class="t">string</td><td class="req">req</td><td>Chat containing the message</td></tr>
          <tr><td class="f">targetMessageId</td><td class="t">string</td><td class="req">req</td><td>ID of the message to react to</td></tr>
          <tr><td class="f">emoji</td><td class="t">string</td><td class="req">req</td><td>Single emoji (max 8 chars). Empty string removes the reaction.</td></tr>
        </table>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/:messageId</span><span class="ep-note">Delete a message</span></summary>
      <div class="ep-body">
        <p>Deletes the message for everyone if within WhatsApp's time window, otherwise only for yourself. Only your own messages can be deleted.</p>
        <div class="ep-lbl">Response</div><pre>{ "deleted": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/broadcast</span><span class="ep-note">Send text to multiple chats</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">jids</td><td class="t">string[]</td><td class="req">req</td><td>Target JIDs, 1&ndash;100</td></tr>
          <tr><td class="f">text</td><td class="t">string</td><td class="req">req</td><td>1&ndash;10,000 chars</td></tr>
        </table>
        <div class="callout warn"><strong>Note:</strong> Broadcast uses individual sends. WhatsApp spam detection still applies.</div>
        <div class="ep-lbl">Response</div>
        <pre>[
  { "jid": "972501234567@s.whatsapp.net", "messageId": "3EB0…" },
  { "jid": "972509999999@s.whatsapp.net", "error": "not on WhatsApp" }
]</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/../send</span><span class="ep-note">Legacy text send (deprecated)</span></summary>
      <div class="ep-body">
        <p>Kept for backward compatibility. Prefer <code>/messages/send-text</code> for new integrations.</p>
        <p>Full path: <code>/api/clients/:clientId/devices/:deviceId/send</code></p>
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">jid / phone</td><td class="t">string</td><td class="req">req</td><td>Recipient (one required)</td></tr>
          <tr><td class="f">text</td><td class="t">string</td><td class="req">req</td><td>1&ndash;10,000 chars</td></tr>
          <tr><td class="f">quotedId</td><td class="t">string</td><td class="opt">opt</td><td>Reply to a message</td></tr>
        </table>
      </div>
    </details>
  </div>
</section>

<!-- CONTACTS -->
<section id="contacts">
  <h2>Contacts</h2>
  <p>Base path: <code>/api/clients/:clientId/devices/:deviceId/contacts</code></p>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/check?phone=&lt;number&gt;</span><span class="ep-note">Check WhatsApp registration</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Query params</div>
        <table>
          <tr><th>Param</th><th>Description</th></tr>
          <tr><td class="f">phone</td><td>E.164 digits without <code>+</code> (required)</td></tr>
        </table>
        <div class="ep-lbl">Response</div>
        <pre>{ "phone": "972501234567", "jid": "972501234567@s.whatsapp.net", "isOnWhatsApp": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/check-bulk</span><span class="ep-note">Check up to 100 numbers</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">phones</td><td class="t">string[]</td><td class="req">req</td><td>1&ndash;100 phone numbers (E.164 digits, no <code>+</code>)</td></tr>
        </table>
        <div class="ep-lbl">Response</div><p>Array of check results, same shape as single check.</p>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/blocklist</span><span class="ep-note">Get blocked contacts</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div><pre>["972501234567@s.whatsapp.net", "…"]</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/:jid/profile-picture</span><span class="ep-note">Get profile photo URL</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div><pre>{ "url": "https://pps.whatsapp.net/…" }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/:jid/status</span><span class="ep-note">Get status text</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div><pre>{ "status": "Available", "setAt": 1741700000000 }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:jid/block</span><span class="ep-note">Block a contact</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div><pre>{ "blocked": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/:jid/block</span><span class="ep-note">Unblock a contact</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div><pre>{ "blocked": false }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:jid/subscribe-presence</span><span class="ep-note">Subscribe to presence updates</span></summary>
      <div class="ep-body">
        <p>Opt-in to receive <code>presence_update</code> webhook events for this JID. Requires <code>events.presenceUpdates</code> to be enabled in config.</p>
        <div class="ep-lbl">Response</div><pre>{ "subscribed": true }</pre>
      </div>
    </details>
  </div>
</section>

<!-- CHATS -->
<section id="chats">
  <h2>Chats</h2>
  <p>Base path: <code>/api/clients/:clientId/devices/:deviceId/chats</code></p>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/</span><span class="ep-note">List chats</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Query params</div>
        <table>
          <tr><th>Param</th><th>Values</th><th>Description</th></tr>
          <tr><td class="f">kind</td><td><code>all</code> | <code>individual</code> | <code>group</code></td><td>Filter by chat type (default: all)</td></tr>
          <tr><td class="f">hideUnnamed</td><td><code>1</code> | <code>true</code></td><td>Omit chats without a name</td></tr>
        </table>
        <div class="ep-lbl">Response</div>
        <pre>[{
  "jid": "972501234567@s.whatsapp.net", "name": "Alice",
  "isGroup": false, "unreadCount": 3, "lastMessage": { … }
}]</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:jid/archive</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "archived": true }</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/:jid/archive</span><span class="ep-note">Unarchive</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "archived": false }</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:jid/mute</span><span class="ep-note">Mute notifications</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">duration</td><td class="t">number</td><td class="req">req</td><td>Seconds to mute. <code>0</code> = unmute.</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "muted": true, "duration": 3600 }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/:jid/mute</span><span class="ep-note">Unmute</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "muted": false }</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:jid/pin</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "pinned": true }</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/:jid/pin</span><span class="ep-note">Unpin</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "pinned": false }</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:jid/read</span><span class="ep-note">Mark chat as read</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "read": true }</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/:jid</span><span class="ep-note">Delete chat history (own side only)</span></summary>
      <div class="ep-body">
        <p>Clears local message history. Does not affect the other party's view.</p>
        <div class="ep-lbl">Response</div><pre>{ "deleted": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m PUT">PUT</span><span class="ep-path">/:jid/ephemeral</span><span class="ep-note">Set disappearing messages</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">expiration</td><td class="t">number</td><td class="req">req</td><td><code>0</code> (off) | <code>86400</code> (1 day) | <code>604800</code> (7 days) | <code>7776000</code> (90 days)</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "expiration": 604800 }</pre>
      </div>
    </details>
  </div>
</section>

<!-- GROUPS -->
<section id="groups">
  <h2>Groups</h2>
  <p>Base path: <code>/api/clients/:clientId/devices/:deviceId/groups</code></p>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/subscribed</span><span class="ep-note">List subscribed groups</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div><pre>["120363012345678901@g.us", "…"]</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:jid/subscribe</span><span class="ep-note">Subscribe to group events</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "subscribed": true }</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/:jid/subscribe</span><span class="ep-note">Unsubscribe</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "subscribed": false }</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/:jid/metadata</span><span class="ep-note">Group info &amp; settings</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div>
        <pre>{
  "jid": "120363012345678901@g.us", "subject": "Team Alpha", "desc": "…",
  "owner": "972501234567@s.whatsapp.net", "creation": 1700000000,
  "participants": [{ "jid": "…", "isAdmin": true }],
  "announce": false, "restrict": false
}</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/:jid/members</span><span class="ep-note">List group members</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div>
        <pre>[{ "jid": "972501234567@s.whatsapp.net", "isAdmin": true, "isSuperAdmin": false }]</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/</span><span class="ep-note">Create group</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">subject</td><td class="t">string</td><td class="req">req</td><td>Group name, 1&ndash;100 chars</td></tr>
          <tr><td class="f">participants</td><td class="t">string[]</td><td class="req">req</td><td>JIDs to add (at least 1)</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "jid": "120363012345678901@g.us", "subject": "New Group" }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m PUT">PUT</span><span class="ep-path">/:jid/subject</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table><tr><th>Field</th><th>Type</th><th></th><th></th></tr>
          <tr><td class="f">subject</td><td class="t">string</td><td class="req">req</td><td>1&ndash;100 chars</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "updated": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m PUT">PUT</span><span class="ep-path">/:jid/description</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table><tr><th>Field</th><th>Type</th><th></th><th></th></tr>
          <tr><td class="f">description</td><td class="t">string</td><td class="req">req</td><td>Max 500 chars</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "updated": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m PUT">PUT</span><span class="ep-path">/:jid/participants</span><span class="ep-note">Bulk participant action</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">action</td><td class="t">string</td><td class="req">req</td><td><code>add</code> | <code>remove</code> | <code>promote</code> | <code>demote</code></td></tr>
          <tr><td class="f">participants</td><td class="t">string[]</td><td class="req">req</td><td>1&ndash;256 JIDs</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "results": [{ "jid": "…", "status": "200" }] }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m PUT">PUT</span><span class="ep-path">/:jid/settings</span><span class="ep-note">Update group settings</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">setting</td><td class="t">GroupSetting</td><td class="req">req</td><td><code>announcement</code> (only admins send) | <code>not_announcement</code> | <code>locked</code> (only admins edit info) | <code>unlocked</code></td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "updated": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:jid/leave</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "left": true }</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/:jid/invite-code</span><span class="ep-note">Get invite link</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div><pre>{ "inviteCode": "AbCd1234", "inviteLink": "https://chat.whatsapp.com/AbCd1234" }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/:jid/invite-code/revoke</span><span class="ep-note">Revoke invite link</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Response</div><pre>{ "inviteCode": "XyZ9…", "inviteLink": "https://chat.whatsapp.com/XyZ9…" }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/join</span><span class="ep-note">Join via invite code</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table>
          <tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">inviteCode</td><td class="t">string</td><td class="req">req</td><td>Code from the invite URL, min 8 chars</td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "jid": "120363012345678901@g.us" }</pre>
      </div>
    </details>
  </div>
</section>

<!-- ACCESS CONTROL -->
<section id="access">
  <h2>Access Control</h2>
  <p>Per-client phone-number ban and allow lists. Base path: <code>/api/clients/:clientId</code></p>

  <h3>Banned Numbers</h3>
  <p>Inbound messages from banned numbers are silently dropped before webhook delivery.</p>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/banned-numbers</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>["972501234567", "…"]</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/banned-numbers</span><span class="ep-note">Add ban</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table><tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">phone</td><td class="t">string</td><td class="req">req</td><td>E.164 digits without <code>+</code></td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "phone": "972501234567", "banned": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/banned-numbers/:phone</span><span class="ep-note">Remove ban</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "phone": "972501234567", "banned": false }</pre></div>
    </details>
  </div>

  <h3>Allowed Numbers</h3>
  <p>When the allowed list is non-empty, the gateway operates in allowlist mode &mdash; only listed numbers can send inbound messages. An empty list means open mode (all numbers allowed).</p>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/allowed-numbers</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>["972501234567", "…"]</pre></div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m POST">POST</span><span class="ep-path">/allowed-numbers</span><span class="ep-note">Add to allowlist</span></summary>
      <div class="ep-body">
        <div class="ep-lbl">Body</div>
        <table><tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>
          <tr><td class="f">phone</td><td class="t">string</td><td class="req">req</td><td>E.164 digits without <code>+</code></td></tr>
        </table>
        <div class="ep-lbl">Response</div><pre>{ "phone": "972501234567", "allowed": true }</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m DELETE">DELETE</span><span class="ep-path">/allowed-numbers/:phone</span><span class="ep-note">Remove from allowlist</span></summary>
      <div class="ep-body"><div class="ep-lbl">Response</div><pre>{ "phone": "972501234567", "allowed": false }</pre></div>
    </details>
  </div>
</section>

<!-- WEBHOOKS -->
<section id="webhooks">
  <h2>Webhook Events</h2>
  <p>When an event occurs, the server <code>POST</code>s to the client's <code>webhookUrl</code> with <code>x-api-key: &lt;webhookApiKey&gt;</code>.</p>
  <p>Toggle event types per client via <a href="#config">PUT /config</a> &rarr; <code>events</code> object.</p>

  <h3>Envelope</h3>
  <pre>{
  "event": "&lt;event-type&gt;",
  "clientId": "acme",
  "deviceId": "my-phone",
  "data": { /* event-specific payload */ }
}</pre>

  <h3>Event Types</h3>
  <div class="ep">
    <details open>
      <summary><span class="ev">message</span> &nbsp; Inbound message received</summary>
      <div class="ep-body">
        <pre>{
  "id": "3EB0C0A1B2C3D4E5F6",
  "from": "972501234567@s.whatsapp.net",
  "chatId": "972501234567@s.whatsapp.net",
  "pushName": "Alice",
  "text": "Hello!",
  "timestamp": 1741800000,
  "isGroup": false,
  "quoted": null,
  "media": null
}</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="ev">reaction</span> &nbsp; Emoji reaction to a message</summary>
      <div class="ep-body">
        <pre>{
  "from": "972501234567@s.whatsapp.net",
  "targetMessageId": "3EB0…",
  "emoji": "&#128516;",
  "timestamp": 1741800010
}</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="ev">receipt</span> &nbsp; Delivery or read receipt</summary>
      <div class="ep-body">
        <pre>{
  "messageIds": ["3EB0…"],
  "from": "972501234567@s.whatsapp.net",
  "type": "read",
  "timestamp": 1741800020
}</pre>
        <p><code>type</code>: <code>delivered</code> | <code>read</code> | <code>played</code></p>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="ev">presence_update</span> &nbsp; Typing / online status</summary>
      <div class="ep-body">
        <p>Emitted only for JIDs subscribed via <code>POST /contacts/:jid/subscribe-presence</code>.</p>
        <pre>{
  "jid": "972501234567@s.whatsapp.net",
  "presence": "composing",
  "lastSeen": null
}</pre>
        <p><code>presence</code>: <code>available</code> | <code>unavailable</code> | <code>composing</code> | <code>recording</code> | <code>paused</code></p>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="ev">group_update</span> &nbsp; Group metadata changed</summary>
      <div class="ep-body">
        <pre>{
  "jid": "120363012345678901@g.us",
  "field": "subject",
  "value": "New Group Name",
  "author": "972501234567@s.whatsapp.net"
}</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="ev">group_participants_update</span> &nbsp; Members added / removed / promoted</summary>
      <div class="ep-body">
        <pre>{
  "jid": "120363012345678901@g.us",
  "action": "add",
  "participants": ["972501234567@s.whatsapp.net"]
}</pre>
        <p><code>action</code>: <code>add</code> | <code>remove</code> | <code>promote</code> | <code>demote</code></p>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="ev">call</span> &nbsp; Incoming call notification</summary>
      <div class="ep-body">
        <pre>{
  "callId": "…",
  "from": "972501234567@s.whatsapp.net",
  "status": "offer",
  "isVideo": false,
  "timestamp": 1741800000
}</pre>
        <p><code>status</code>: <code>offer</code> | <code>accept</code> | <code>timeout</code> | <code>reject</code></p>
      </div>
    </details>
  </div>
</section>

<!-- ADMIN -->
<section id="admin">
  <h2>Admin</h2>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/api/admin/stats</span><span class="ab ab-master">master</span></summary>
      <div class="ep-body">
        <p>JSON snapshot of all device statuses and webhook queue depth.</p>
        <div class="ep-lbl">Response</div>
        <pre>{
  "devices": {
    "total": 12,
    "byStatus": { "CONNECTED": 10, "QR_READY": 1, "DISCONNECTED": 1, "INITIALIZING": 0, "ERROR": 0 },
    "byClient": {
      "acme": [{ "deviceId": "my-phone", "name": "Sales Phone", "phone": "972501234567", "status": "CONNECTED" }]
    }
  },
  "queue": { "waiting": 0, "active": 2, "completed": 18432, "failed": 3, "delayed": 0 },
  "uptime": 86400,
  "timestamp": 1741800000000
}</pre>
      </div>
    </details>
  </div>
  <div class="ep">
    <details>
      <summary><span class="m GET">GET</span><span class="ep-path">/admin</span><span class="ep-note">Live dashboard</span><span class="ab ab-master">master (browser prompt)</span></summary>
      <div class="ep-body">
        <p>Self-contained HTML dashboard. The API key is prompted in-browser and stored in <code>sessionStorage</code> &mdash; no header required. Auto-refreshes every 5 s, shows per-client device statuses and queue metrics. <a href="/admin">Open &nearr;</a></p>
      </div>
    </details>
  </div>
</section>

<footer>WhatsApp Gateway &mdash; wa.tachles.dev</footer>
</div>
</body>
</html>`;

