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
    };
  }

  getSocket(): WASocket | null {
    return this.sock;
  }

  async start(): Promise<void> {
    const config = loadConfig();
    const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);

    const waLogger = logger.child({ module: 'baileys' });
    waLogger.level = 'warn';

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      logger: waLogger,
      printQRInTerminal: true,
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

    // Inbound message handler
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        await this.handleInboundMessage(msg);
      }
    });
  }

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qrCode = qr;
      this.status = ServiceStatus.QR_READY;
      // Store QR in Redis with 60s TTL
      const redis = getRedis();
      redis.set('wa:qr', qr, 'EX', 60).catch(() => {});
      logger.info('QR code ready for scanning');
    }

    if (connection === 'close') {
      this.status = ServiceStatus.DISCONNECTED;
      this.lastDisconnect = Date.now();
      this.qrCode = null;

      const error = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = error === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.warn('Session logged out — requires new QR scan');
        this.status = ServiceStatus.ERROR;
        return;
      }

      // Auto-reconnect with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
        this.reconnectAttempts++;
        logger.info(
          { attempt: this.reconnectAttempts, delayMs: delay },
          'Reconnecting...',
        );
        setTimeout(() => this.start(), delay);
      } else {
        logger.error('Max reconnect attempts reached');
        this.status = ServiceStatus.ERROR;
      }
    }

    if (connection === 'open') {
      this.status = ServiceStatus.CONNECTED;
      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.qrCode = null;
      logger.info('WhatsApp connected');
    }
  }

  private async handleInboundMessage(msg: proto.IWebMessageInfo): Promise<void> {
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
      ? { key: { remoteJid: jid, id: quotedId } } as proto.IWebMessageInfo
      : undefined;

    const result = await this.sock.sendMessage(jid, { text }, { quoted });
    return result?.key.id || '';
  }

  async getChats(): Promise<ChatMetadata[]> {
    if (!this.sock || this.status !== ServiceStatus.CONNECTED) {
      throw new Error('WhatsApp is not connected');
    }

    const groups = await this.sock.groupFetchAllParticipating();
    const chats: ChatMetadata[] = Object.entries(groups).map(([id, meta]) => ({
      id,
      name: meta.subject,
      isGroup: true,
    }));

    return chats;
  }

  async close(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
      this.status = ServiceStatus.DISCONNECTED;
      logger.info('WhatsApp socket closed gracefully');
    }
  }
}

// Singleton
export const connectionManager = new ConnectionManager();
