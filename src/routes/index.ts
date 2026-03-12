// routes/index.ts — Entry point: registers the global auth hook and all route sub-modules.
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config';
import { verifyClientKey } from '../core/client-config';
import { fail, ok } from './helpers';
import { registerConfigRoutes } from './config';
import { registerDeviceRoutes } from './devices';
import { registerMessageRoutes } from './messages';
import { registerContactRoutes } from './contacts';
import { registerChatRoutes } from './chats';
import { registerGroupRoutes } from './groups';
import { registerAccessRoutes } from './access';
import { registerAdminRoutes } from './admin';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  // ── Global auth guard ────────────────────────────────────────────────────
  // All routes require x-api-key except the public health check.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
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
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --text: #e2e8f0; --muted: #94a3b8; --accent: #25d366;
    --method-get: #3b82f6; --method-post: #22c55e;
    --method-put: #f59e0b; --method-delete: #ef4444;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); line-height: 1.6; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 1rem 2rem; display: flex; align-items: center; gap: 1rem; }
  header .logo { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
  header .sub  { color: var(--muted); font-size: 0.875rem; }
  header .badge { margin-left: auto; background: #1a3a27; color: var(--accent); border: 1px solid var(--accent); padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; }

  main { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem; }
  section { margin-bottom: 2.5rem; }
  h2 { font-size: 1.1rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
  h3 { font-size: 1rem; font-weight: 600; margin-bottom: 0.4rem; }
  p, li { color: var(--muted); font-size: 0.9rem; margin-bottom: 0.4rem; }
  ul { padding-left: 1.2rem; }
  code { font-family: 'SF Mono', Menlo, monospace; font-size: 0.82rem; background: #0d1117; padding: 0.15rem 0.4rem; border-radius: 4px; color: #e2e8f0; }
  pre { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; overflow-x: auto; margin: 0.75rem 0; }
  pre code { background: none; padding: 0; font-size: 0.82rem; }

  .endpoint { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 0.75rem; }
  .endpoint-header { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 0.4rem; }
  .method { font-family: monospace; font-size: 0.75rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 4px; min-width: 56px; text-align: center; }
  .GET    { background: #1e3a5f; color: var(--method-get); }
  .POST   { background: #14371f; color: var(--method-post); }
  .PUT    { background: #3d2e0a; color: var(--method-put); }
  .DELETE { background: #3d1212; color: var(--method-delete); }
  .path { font-family: monospace; font-size: 0.9rem; }
  .desc { color: var(--muted); font-size: 0.85rem; }

  .callout { background: #1a2533; border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; padding: 0.75rem 1rem; margin: 1rem 0; font-size: 0.875rem; color: var(--muted); }
  .callout strong { color: var(--text); }
  footer { text-align: center; color: var(--border); font-size: 0.75rem; padding: 2rem; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<header>
  <span class="logo">&#128262; WA Gateway</span>
  <span class="sub">WhatsApp HTTP API</span>
  <span class="badge">v1</span>
</header>
<main>

<section>
  <h2>Overview</h2>
  <p>A multi-tenant WhatsApp gateway. Each <strong>client</strong> can register one or more <strong>devices</strong> (phone numbers). Messages, reactions, receipts, and other events are forwarded to a per-client webhook URL.</p>
  <p>All requests must be authenticated. There are two key tiers:</p>
  <ul>
    <li><strong>Master key</strong> — full access to all clients &amp; admin endpoints. Set in server config. Share only with trusted operators.</li>
    <li><strong>Client key</strong> — scoped to a single <code>:clientId</code>. Issue one per tenant so they can manage only their own devices.</li>
  </ul>
</section>

<section>
  <h2>Authentication</h2>
  <p>Pass your API key in every request as an HTTP header:</p>
  <pre><code>x-api-key: &lt;your-key&gt;</code></pre>
  <div class="callout"><strong>Client keys</strong> are only accepted on routes scoped to their own <code>:clientId</code>. Attempting to access another client's data returns <code>401</code>.</div>
</section>

<section>
  <h2>Base URL</h2>
  <pre><code>https://wa.tachles.dev</code></pre>
  <p>All endpoints are prefixed with <code>/api</code>. Responses are JSON in the shape:</p>
  <pre><code>{ "success": true,  "data": { ... } }           // ok\n{ "success": false, "error": { "code": "...", "message": "..." } }  // error</code></pre>
</section>

<section>
  <h2>Client Keys</h2>
  <div class="endpoint">
    <div class="endpoint-header"><span class="method POST">POST</span><span class="path">/api/clients/:clientId/key</span></div>
    <p class="desc">Issue a new API key. Requires master key. Returns plaintext once — store it immediately, it cannot be retrieved again. Optional body: <code>{"ttlDays": 90}</code> (max 365).</p>
  </div>
  <div class="endpoint">
    <div class="endpoint-header"><span class="method POST">POST</span><span class="path">/api/clients/:clientId/key/rotate</span></div>
    <p class="desc">Rotate the key. Supply the current client key (or master key) in <code>x-api-key</code>. Old key is invalidated immediately. Optional body: <code>{"ttlDays": 90}</code>.</p>
  </div>
  <div class="endpoint">
    <div class="endpoint-header"><span class="method DELETE">DELETE</span><span class="path">/api/clients/:clientId/key</span></div>
    <p class="desc">Revoke the key immediately. Requires master key.</p>
  </div>
</section>

<section>
  <h2>Client Config</h2>
  <div class="endpoint">
    <div class="endpoint-header"><span class="method GET">GET</span><span class="path">/api/clients/:clientId/config</span></div>
    <p class="desc">Read current config (webhook URL, event toggles, device limit). Key hash is never exposed — response shows <code>key.hasKey</code>, <code>key.expiresAt</code>, <code>key.lastUsedAt</code>.</p>
  </div>
  <div class="endpoint">
    <div class="endpoint-header"><span class="method PUT">PUT</span><span class="path">/api/clients/:clientId/config</span></div>
    <p class="desc">Partial update. Send only the fields you want to change. Null-able fields (<code>webhookUrl</code>, <code>webhookApiKey</code>) accept <code>null</code> to revert to the global default.</p>
    <pre><code>{
  "webhookUrl": "https://yourapp.com/hooks/whatsapp",
  "webhookApiKey": "secret",
  "events": { "receipts": false, "presenceUpdates": false },
  "maxDevices": 3
}</code></pre>
  </div>
  <div class="endpoint">
    <div class="endpoint-header"><span class="method DELETE">DELETE</span><span class="path">/api/clients/:clientId/config</span></div>
    <p class="desc">Reset to defaults.</p>
  </div>
</section>

<section>
  <h2>Devices</h2>
  <div class="endpoint"><div class="endpoint-header"><span class="method GET">GET</span><span class="path">/api/clients/:clientId/devices</span></div><p class="desc">List all devices for a client with their current status.</p></div>
  <div class="endpoint"><div class="endpoint-header"><span class="method POST">POST</span><span class="path">/api/clients/:clientId/devices</span></div><p class="desc">Register a new device. Body: <code>{"deviceId": "my-phone"}</code>. Returns QR code to scan.</p></div>
  <div class="endpoint"><div class="endpoint-header"><span class="method GET">GET</span><span class="path">/api/clients/:clientId/devices/:deviceId/qr</span></div><p class="desc">Fetch the current QR code (base64 PNG) for a device in QR_READY state.</p></div>
  <div class="endpoint"><div class="endpoint-header"><span class="method DELETE">DELETE</span><span class="path">/api/clients/:clientId/devices/:deviceId</span></div><p class="desc">Disconnect and remove a device.</p></div>
</section>

<section>
  <h2>Messages</h2>
  <div class="endpoint"><div class="endpoint-header"><span class="method POST">POST</span><span class="path">/api/clients/:clientId/devices/:deviceId/send/text</span></div><p class="desc">Send a text message. Body: <code>{"to": "972501234567", "text": "Hello"}</code>.</p></div>
  <div class="endpoint"><div class="endpoint-header"><span class="method POST">POST</span><span class="path">/api/clients/:clientId/devices/:deviceId/send/image</span></div><p class="desc">Send an image. Body: <code>{"to": "...", "url": "https://...", "caption": "..."}</code>.</p></div>
  <div class="endpoint"><div class="endpoint-header"><span class="method POST">POST</span><span class="path">/api/clients/:clientId/devices/:deviceId/send/document</span></div><p class="desc">Send a file. Body: <code>{"to": "...", "url": "https://...", "fileName": "report.pdf"}</code>.</p></div>
  <div class="endpoint"><div class="endpoint-header"><span class="method POST">POST</span><span class="path">/api/clients/:clientId/devices/:deviceId/send/reaction</span></div><p class="desc">React to a message. Body: <code>{"to": "...", "messageId": "...", "emoji": "\u{1F44D}"}</code>.</p></div>
</section>

<section>
  <h2>Webhook Events</h2>
  <p>When an event occurs, a <code>POST</code> is sent to the client's <code>webhookUrl</code> with <code>x-api-key</code> set to <code>webhookApiKey</code>. The payload is always:</p>
  <pre><code>{
  "event": "message" | "reaction" | "receipt" | "presence_update" | "group_update" | "group_participants_update" | "call",
  "clientId": "...",
  "deviceId": "...",
  "data": { /* event-specific fields */ }
}</code></pre>
  <p>Toggle individual event types per-client via <code>PUT /config</code> → <code>events</code>.</p>
</section>

<section>
  <h2>Contacts &amp; Chats</h2>
  <div class="endpoint"><div class="endpoint-header"><span class="method GET">GET</span><span class="path">/api/clients/:clientId/devices/:deviceId/contacts</span></div><p class="desc">List contacts.</p></div>
  <div class="endpoint"><div class="endpoint-header"><span class="method GET">GET</span><span class="path">/api/clients/:clientId/devices/:deviceId/chats</span></div><p class="desc">List recent chats.</p></div>
  <div class="endpoint"><div class="endpoint-header"><span class="method GET">GET</span><span class="path">/api/clients/:clientId/devices/:deviceId/chats/:chatId/messages</span></div><p class="desc">Retrieve message history for a chat.</p></div>
</section>

<section>
  <h2>Status &amp; Admin</h2>
  <div class="endpoint"><div class="endpoint-header"><span class="method GET">GET</span><span class="path">/api/status</span></div><p class="desc">Public health check — no auth required.</p></div>
  <div class="endpoint"><div class="endpoint-header"><span class="method GET">GET</span><span class="path">/admin</span></div><p class="desc">Live dashboard — device statuses, queue metrics, per-client view. Requires master key (prompted in browser). <a href="/admin">Open dashboard &#8599;</a></p></div>
</section>

</main>
<footer>WhatsApp Gateway &mdash; wa.tachles.dev</footer>
</body>
</html>`;

