// connection.ts
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  ConnectionState,
  proto,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { SocksProxyAgent } from 'socks-proxy-agent';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadConfig } from './config';
import { logger } from './logger';
import { getRedis } from './redis';
import { ServiceStatus, InboundMessage, ChatMetadata } from './types';
import { isAllowedContact, isNewMessage } from './filter';
import { enqueueMessage } from './queue';

class ConnectionManager {
  private sock: WASocket | null = null;
  private status: ServiceStatus = ServiceStatus.INITIALIZING;
  private qrCode: string | null = null;
  private connectedAt: number | null = null;
  private lastDisconnect: number | null = null;
  private startTime = Date.now();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleRestart(delayMs: number): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delayMs);
  }

  private cleanupSocket(): void {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.ev.removeAllListeners('contacts.upsert');
        this.sock.ev.removeAllListeners('messaging-history.set');
        this.sock.ev.removeAllListeners('groups.upsert');
        this.sock.ev.removeAllListeners('groups.update');
        this.sock.end(undefined);
      } catch { /* ignore */ }
      this.sock = null;
    }
  }

  getStatus(): ServiceStatus {
    return this.status;
  }

  getQr(): string | null {
    return this.qrCode;
  }

  getStatusData() {
    return {
      status: this.status,
      uptime: Date.now() - this.startTime,
      connectedAt: this.connectedAt,
      lastDisconnect: this.lastDisconnect,
      qr: this.status === ServiceStatus.CONNECTED ? null : this.qrCode,
    };
  }

  getSocket(): WASocket | null {
    return this.sock;
  }

  async start(): Promise<void> {
    logger.info({ reconnectAttempts: this.reconnectAttempts }, 'start() called — initializing Baileys socket');
    // Close any existing socket before creating a new one
    this.cleanupSocket();

    const config = loadConfig();
    const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);

    const waLogger = logger.child({ module: 'baileys' });
    waLogger.level = 'info';

    const agent = config.PROXY_URL ? new SocksProxyAgent(config.PROXY_URL) : undefined;
    if (config.PROXY_URL) {
      logger.info({ proxy: config.PROXY_URL.replace(/:[^:@]+@/, ':***@') }, 'Using SOCKS5 proxy');
    }

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      logger: waLogger,
      browser: ['WhatsApp Service', 'Safari', '17.0'],
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 2000,
      agent,
      getMessage: async (key) => {
        // Try fetching from Redis message store
        const redis = getRedis();
        const stored = await redis.get(`msg:${key.id}`);
        if (stored) {
          return proto.Message.decode(Buffer.from(stored, 'base64'));
        }
        return proto.Message.fromObject({});
      },
    });

    // Persist credentials on update
    this.sock.ev.on('creds.update', saveCreds);

    // Connection state management
    this.sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(update);
    });

    // Capture contacts (private chats) as they sync
    this.sock.ev.on('contacts.upsert', async (contacts) => {
      const redis = getRedis();
      for (const contact of contacts) {
        if (!contact.id || contact.id === 'status@broadcast') continue;
        const entry: ChatMetadata = {
          id: contact.id,
          name: contact.notify || contact.verifiedName || contact.name || contact.id.split('@')[0],
          isGroup: contact.id.endsWith('@g.us'),
        };
        await redis.hset('wa:chats', contact.id, JSON.stringify(entry));
      }
      logger.info({ count: contacts.length }, 'Contacts synced to cache');
    });

    // Capture chat history on initial sync
    this.sock.ev.on('messaging-history.set', async ({ contacts, isLatest }) => {
      if (!contacts?.length) return;
      const redis = getRedis();
      const pipeline = redis.pipeline();
      for (const contact of contacts) {
        if (!contact.id || contact.id === 'status@broadcast') continue;
        const entry: ChatMetadata = {
          id: contact.id,
          name: contact.notify || contact.verifiedName || contact.name || contact.id.split('@')[0],
          isGroup: contact.id.endsWith('@g.us'),
        };
        pipeline.hset('wa:chats', contact.id, JSON.stringify(entry));
      }
      await pipeline.exec();
      logger.info({ count: contacts.length, isLatest }, 'History contacts synced to cache');
    });

    // Capture group metadata updates
    this.sock.ev.on('groups.upsert', async (groups) => {
      const redis = getRedis();
      for (const group of groups) {
        const entry: ChatMetadata = {
          id: group.id,
          name: group.subject,
          isGroup: true,
        };
        await redis.hset('wa:chats', group.id, JSON.stringify(entry));
      }
    });

    this.sock.ev.on('groups.update', async (updates) => {
      const redis = getRedis();
      for (const update of updates) {
        if (!update.id) continue;
        const existing = await redis.hget('wa:chats', update.id);
        const entry: ChatMetadata = existing
          ? { ...JSON.parse(existing), ...(update.subject ? { name: update.subject } : {}) }
          : { id: update.id, name: update.subject || update.id, isGroup: true };
        await redis.hset('wa:chats', update.id, JSON.stringify(entry));
      }
    });

    // Inbound message handler
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        await this.handleInboundMessage(msg);
      }
    });
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qrCode = qr;
      this.status = ServiceStatus.QR_READY;
      // Store QR in Redis with 120s TTL (survives one refresh cycle)
      const redis = getRedis();
      redis.set('wa:qr', qr, 'EX', 120).catch(() => {});
      logger.info({ qrLength: qr.length }, 'QR code ready — waiting for scan');
    }

    if (connection === 'close') {
      this.status = ServiceStatus.DISCONNECTED;
      this.lastDisconnect = Date.now();
      // Don't clear qrCode here — keep serving the last QR until a new one arrives or we connect

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logger.info(
        { statusCode, loggedOut, reason: (lastDisconnect?.error as Boom)?.message, error: (lastDisconnect?.error as Boom)?.output },
        'Connection closed',
      );

      if (loggedOut) {
        logger.warn('Session logged out — clearing auth and restarting for new QR');
        this.status = ServiceStatus.DISCONNECTED;

        // Cancel any pending restart
        if (this.restartTimer) {
          clearTimeout(this.restartTimer);
          this.restartTimer = null;
        }

        // Clear stale auth files so a fresh QR is generated
        const config = loadConfig();
        try {
          const files = await fs.readdir(config.AUTH_DIR);
          await Promise.all(
            files.map((f) => fs.rm(path.join(config.AUTH_DIR, f), { recursive: true, force: true })),
          );
          logger.info('Auth files cleared');
        } catch (err) {
          logger.error({ err }, 'Failed to clear auth files');
        }

        // Restart to generate a new QR code
        this.reconnectAttempts = 0;
        this.scheduleRestart(3000);
        return;
      }

      // Auto-reconnect with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
        this.reconnectAttempts++;
        logger.info(
          { attempt: this.reconnectAttempts, maxAttempts: this.maxReconnectAttempts, delayMs: delay },
          'Reconnecting...',
        );
        this.scheduleRestart(delay);
      } else {
        logger.error('Max reconnect attempts reached — entering ERROR state, will retry in 5 minutes');
        this.status = ServiceStatus.ERROR;
        this.reconnectAttempts = 0;
        // Schedule a full recovery attempt after 5 minutes
        this.scheduleRestart(5 * 60 * 1000);
      }
    }

    if (connection === 'open') {
      this.status = ServiceStatus.CONNECTED;
      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.qrCode = null;
      getRedis().del('wa:qr').catch(() => {});
      logger.info('WhatsApp connected');
    }
  }

  private async handleInboundMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (!msg.key) return;
    // Skip own messages
    if (msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid) return;

    // Rule engine: check if sender is allowed
    if (!isAllowedContact(remoteJid)) {
      logger.debug({ jid: remoteJid }, 'Message from non-allowed contact, ignoring');
      return;
    }

    const messageId = msg.key.id;
    if (!messageId) return;

    // Deduplication
    const isNew = await isNewMessage(messageId);
    if (!isNew) return;

    // Store message in Redis for getMessage callback
    if (msg.message) {
      const redis = getRedis();
      const encoded = Buffer.from(proto.Message.encode(msg.message).finish()).toString('base64');
      await redis.set(`msg:${messageId}`, encoded, 'EX', 3600);
    }

    // Extract text from various message types
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      null;

    const inbound: InboundMessage = {
      id: messageId,
      from: msg.key.participant || remoteJid,
      chatId: remoteJid,
      text,
      timestamp: msg.messageTimestamp as number,
      isGroup: remoteJid.endsWith('@g.us'),
      pushName: msg.pushName || null,
    };

    // Enqueue for reliable webhook delivery
    await enqueueMessage(inbound);
  }

  async sendMessage(jid: string, text: string, quotedId?: string): Promise<string> {
    if (!this.sock || this.status !== ServiceStatus.CONNECTED) {
      throw new Error('WhatsApp is not connected');
    }

    const quoted = quotedId
      ? { key: { remoteJid: jid, id: quotedId } } as any
      : undefined;

    const result = await this.sock.sendMessage(jid, { text }, { quoted });
    return result?.key.id || '';
  }

  async getChats(): Promise<ChatMetadata[]> {
    if (!this.sock || this.status !== ServiceStatus.CONNECTED) {
      throw new Error('WhatsApp is not connected');
    }

    const redis = getRedis();
    const cached = await redis.hgetall('wa:chats');

    // If cache has entries, return from cache (no socket call)
    if (Object.keys(cached).length > 0) {
      return Object.values(cached).map((v) => JSON.parse(v) as ChatMetadata);
    }

    // Cache is empty — do a one-time group fetch to seed it
    const groups = await this.sock.groupFetchAllParticipating();
    const chats: ChatMetadata[] = [];
    const pipeline = redis.pipeline();

    for (const [id, meta] of Object.entries(groups)) {
      const entry: ChatMetadata = { id, name: meta.subject, isGroup: true };
      chats.push(entry);
      pipeline.hset('wa:chats', id, JSON.stringify(entry));
    }

    await pipeline.exec();
    logger.info({ count: chats.length }, 'Chat cache seeded from group fetch');
    return chats;
  }

  async resetAuth(): Promise<void> {
    logger.warn('Manual auth reset requested — clearing auth files and restarting');

    // Cancel any pending restart to avoid double-starts
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Remove listeners BEFORE ending socket to prevent handleConnectionUpdate
    // from scheduling a competing restart
    this.cleanupSocket();

    // Clear auth files
    const config = loadConfig();
    try {
      const files = await fs.readdir(config.AUTH_DIR);
      await Promise.all(
        files.map((f) => fs.rm(path.join(config.AUTH_DIR, f), { recursive: true, force: true })),
      );
      logger.info({ count: files.length }, 'Auth files cleared');
    } catch { /* dir may be empty */ }

    // Clear cached QR from Redis
    await getRedis().del('wa:qr').catch(() => {});
    this.qrCode = null;
    this.reconnectAttempts = 0;
    this.status = ServiceStatus.INITIALIZING;

    // Start fresh — will produce a new QR
    this.scheduleRestart(1000);
  }

  async close(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.cleanupSocket();
    this.status = ServiceStatus.DISCONNECTED;
    logger.info('WhatsApp socket closed gracefully');
  }
}

// Singleton
export const connectionManager = new ConnectionManager();
