// connection.ts
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  ConnectionState,
  proto,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { SocksProxyAgent } from "socks-proxy-agent";
import * as fs from "fs/promises";
import * as path from "path";
import { loadConfig } from './config';
import { logger } from './logger';
import { getRedis } from './redis';
import { DeviceCache } from './cache';
import { ServiceStatus, InboundMessage, ReactionEvent, ReceiptEvent, GroupMember, ChatMetadata } from './types';
import { enqueueWebhookEvent } from './queue';

export class ConnectionManager {
  private sock: WASocket | null = null;
  private status: ServiceStatus = ServiceStatus.INITIALIZING;
  private qrCode: string | null = null;
  private connectedPhone: string | null = null;
  private connectedAt: number | null = null;
  private lastDisconnect: number | null = null;
  private startTime = Date.now();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private phoneVerifier: ((phone: string) => Promise<boolean>) | null = null;
  // In-memory cache for msg payloads — avoids Redis reads for Baileys retries/quote lookups
  private msgCache = new Map<string, { data: string; expiry: number }>();

  private getCachedMsg(key: string): string | null {
    const entry = this.msgCache.get(key);
    if (!entry || entry.expiry < Date.now()) { this.msgCache.delete(key); return null; }
    return entry.data;
  }

  private setCachedMsg(key: string, data: string): void {
    this.msgCache.set(key, { data, expiry: Date.now() + 300_000 });
    if (this.msgCache.size > 500) this.msgCache.delete(this.msgCache.keys().next().value!);
  }

  setPhoneVerifier(cb: (phone: string) => Promise<boolean>): void {
    this.phoneVerifier = cb;
  }

  getConnectedPhone(): string | null { return this.connectedPhone; }

  constructor(
    readonly deviceId: string,
    readonly clientId: string,
    private readonly authDir: string,
    private readonly cache: DeviceCache,
  ) {}

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
        this.sock.ev.removeAllListeners('messages.reaction');
        this.sock.ev.removeAllListeners('message-receipt.update');
        this.sock.end(undefined);
      } catch { /* ignore */ }
      this.sock = null;
    }
  }

  getStatus(): ServiceStatus { return this.status; }
  getQr(): string | null { return this.qrCode; }
  getSocket(): WASocket | null { return this.sock; }

  getStatusData() {
    return {
      deviceId: this.deviceId,
      phone: this.connectedPhone,
      status: this.status,
      uptime: Date.now() - this.startTime,
      connectedAt: this.connectedAt,
      lastDisconnect: this.lastDisconnect,
      qr: this.status === ServiceStatus.CONNECTED ? null : this.qrCode,
    };
  }

  async start(): Promise<void> {
    logger.info({ deviceId: this.deviceId, reconnectAttempts: this.reconnectAttempts }, 'start() called');
    this.cleanupSocket();

    const config = loadConfig();
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const waLogger = logger.child({ module: 'baileys', deviceId: this.deviceId });
    waLogger.level = 'info';

    const agent = config.PROXY_URL ? new SocksProxyAgent(config.PROXY_URL) : undefined;

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      version: [2, 3000, 1033893291],
      logger: waLogger,
      browser: ['Chrome', 'Windows', '110.0.5481.177'],
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 2000,
      agent,
      getMessage: async (key) => {
        const cacheKey = `msg:${this.deviceId}:${key.id}`;
        const stored = this.getCachedMsg(cacheKey) ?? await getRedis().get(cacheKey);
        if (stored) return proto.Message.decode(Buffer.from(stored, 'base64'));
        return proto.Message.fromObject({});
      },
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(update);
    });

    this.sock.ev.on('groups.upsert', (groups) => {
      for (const group of groups) {
        this.cache.setChat({ id: group.id, name: group.subject, isGroup: true, phone: null });
      }
    });

    this.sock.ev.on('groups.update', (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const existing = this.cache.getChat(update.id);
        this.cache.setChat(
          existing
            ? { ...existing, ...(update.subject ? { name: update.subject } : {}) }
            : { id: update.id, name: update.subject || update.id, isGroup: true, phone: null },
        );
      }
    });

    this.sock.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        if (!contact.id || contact.id === 'status@broadcast') continue;
        // Map LID → phone JID so we can resolve participant @lid JIDs later
        if (contact.lid && contact.id.endsWith('@s.whatsapp.net')) {
          this.cache.setLid(contact.lid as string, contact.id);
        }
        this.cache.setChat({
          id: contact.id,
          name: contact.notify || contact.verifiedName || contact.name || contact.id.split('@')[0],
          isGroup: contact.id.endsWith('@g.us'),
          phone: contact.id.endsWith('@s.whatsapp.net') ? contact.id.split('@')[0] : null,
        });
      }
    });

    this.sock.ev.on('messaging-history.set', ({ contacts }) => {
      if (!contacts?.length) return;
      for (const contact of contacts) {
        if (!contact.id || contact.id === 'status@broadcast') continue;
        if (contact.lid && contact.id.endsWith('@s.whatsapp.net')) {
          this.cache.setLid(contact.lid as string, contact.id);
        }
        this.cache.setChat({
          id: contact.id,
          name: contact.notify || contact.verifiedName || contact.name || contact.id.split('@')[0],
          isGroup: contact.id.endsWith('@g.us'),
          phone: contact.id.endsWith('@s.whatsapp.net') ? contact.id.split('@')[0] : null,
        });
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) await this.handleInboundMessage(msg);
    });

    // Track reactions. We forward all of them and let the webhook handler decide
    // if the messageId matches a known outbound message.
    // key = the original message's key; reaction.key = the reaction message's key (reactor JID)
    this.sock.ev.on('messages.reaction', async (reactions: any[]) => {
      for (const { key, reaction } of reactions) {
        if (!key?.id) continue;
        const rawFrom = reaction?.key?.participant || reaction?.key?.remoteJid || key.remoteJid || '';
        const event: ReactionEvent = {
          type: 'reaction',
          deviceId: this.deviceId,
          messageId: key.id,
          from: this.cache.resolveLid(rawFrom),
          chatId: key.remoteJid || '',
          isGroup: (key.remoteJid || '').endsWith('@g.us'),
          pushName: null,
          emoji: reaction?.text ?? null,
          timestamp: Math.floor((Number(reaction?.senderTimestampMs) || Date.now()) / 1000),
        };
        await enqueueWebhookEvent(event);
      }
    });

    // Track delivery/read receipts for messages WE sent (key.fromMe === true).
    // MessageUserReceiptUpdate = { key: WAMessageKey, receipt: MessageUserReceipt }
    this.sock.ev.on('message-receipt.update', async (updates: any[]) => {
      // Group receipts by message key to batch them into one event per message
      const byKey = new Map<string, { key: any; receipts: any[] }>();
      for (const { key, receipt } of updates) {
        if (!key?.id) continue;
        const existing = byKey.get(key.id);
        if (existing) existing.receipts.push(receipt);
        else byKey.set(key.id, { key, receipts: [receipt] });
      }
      for (const { key, receipts } of byKey.values()) {
        const event: ReceiptEvent = {
          type: 'receipt',
          deviceId: this.deviceId,
          messageId: key.id,
          chatId: key.remoteJid || '',
          isGroup: (key.remoteJid || '').endsWith('@g.us'),
          receipts: receipts.map((r: any) => ({
            participantJid: this.cache.resolveLid(r.userJid || ''),
            type: r.readTimestamp ? 'READ' : r.playedTimestamp ? 'PLAYED' : r.receiptTimestamp ? 'DELIVERY' : 'SERVER_ACK',
            readTimestamp: r.readTimestamp ? Number(r.readTimestamp) : undefined,
            receiptTimestamp: r.receiptTimestamp ? Number(r.receiptTimestamp) : undefined,
          })),
          timestamp: Math.floor(Date.now() / 1000),
        };
        await enqueueWebhookEvent(event);
      }
    });
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qrCode = qr;
      this.status = ServiceStatus.QR_READY;
      logger.info({ deviceId: this.deviceId, qrLength: qr.length }, 'QR code ready — waiting for scan');
    }

    if (connection === 'close') {
      this.status = ServiceStatus.DISCONNECTED;
      this.lastDisconnect = Date.now();
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logger.info({ deviceId: this.deviceId, statusCode, loggedOut, reason: (lastDisconnect?.error as Boom)?.message }, 'Connection closed');

      if (loggedOut) {
        logger.warn({ deviceId: this.deviceId }, 'Session logged out — clearing auth and restarting for new QR');
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
        this.cleanupSocket();
        try {
          const files = await fs.readdir(this.authDir);
          await Promise.all(files.map((f) => fs.rm(path.join(this.authDir, f), { recursive: true, force: true })));
        } catch { /* ignore */ }
        this.reconnectAttempts = 0;
        this.scheduleRestart(3000);
        return;
      }

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
        this.reconnectAttempts++;
        logger.info({ deviceId: this.deviceId, attempt: this.reconnectAttempts, maxAttempts: this.maxReconnectAttempts, delayMs: delay }, 'Reconnecting...');
        this.scheduleRestart(delay);
      } else {
        logger.error({ deviceId: this.deviceId }, 'Max reconnect attempts reached — entering ERROR state, will retry in 5 minutes');
        this.status = ServiceStatus.ERROR;
        this.reconnectAttempts = 0;
        this.scheduleRestart(5 * 60 * 1000);
      }
    }

    if (connection === 'open') {
      // Extract phone from sock.user.id format: "972501234567:13@s.whatsapp.net"
      const rawId = this.sock?.user?.id ?? '';
      const phone = rawId.split('@')[0].split(':')[0] || null;
      this.connectedPhone = phone;

      if (phone && this.phoneVerifier) {
        const allowed = await this.phoneVerifier(phone);
        if (!allowed) {
          // phoneVerifier already logged the reason; close silently
          await this.close();
          return;
        }
      }

      this.status = ServiceStatus.CONNECTED;
      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.qrCode = null;
      logger.info({ deviceId: this.deviceId, phone }, 'WhatsApp connected');
    }
  }

  private async handleInboundMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (!msg.key) return;
    if (msg.key.fromMe) return;
    const remoteJid = msg.key.remoteJid;
    if (!remoteJid) return;

    if (!this.cache.isSubscribed(remoteJid)) {
      logger.debug({ deviceId: this.deviceId, jid: remoteJid }, 'Message from non-subscribed chat, ignoring');
      return;
    }

    const messageId = msg.key.id;
    if (!messageId) return;
    if (!this.cache.isNewMessage(messageId)) return;

    if (msg.message) {
      const encoded = Buffer.from(proto.Message.encode(msg.message).finish()).toString('base64');
      const msgKey = `msg:${this.deviceId}:${messageId}`;
      this.setCachedMsg(msgKey, encoded);
      await getRedis().set(msgKey, encoded, 'EX', 3600);
    }

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      null;

    const inbound: InboundMessage = {
      type: 'message',
      deviceId: this.deviceId,
      id: messageId,
      from: msg.key.participant || remoteJid,
      chatId: remoteJid,
      text,
      timestamp: msg.messageTimestamp as number,
      isGroup: remoteJid.endsWith('@g.us'),
      pushName: msg.pushName || null,
    };

    await enqueueWebhookEvent(inbound);
  }

  async sendMessage(jid: string, text: string, quotedId?: string): Promise<string> {
    if (!this.sock || this.status !== ServiceStatus.CONNECTED) {
      throw new Error('WhatsApp is not connected');
    }
    const quoted = quotedId ? ({ key: { remoteJid: jid, id: quotedId } } as any) : undefined;
    const result = await this.sock.sendMessage(jid, { text }, { quoted });
    return result?.key.id || '';
  }

  async getGroupMembers(jid: string): Promise<GroupMember[]> {
    if (!this.sock || this.status !== ServiceStatus.CONNECTED) throw new Error('WhatsApp is not connected');
    const meta = await this.sock.groupMetadata(jid);
    return meta.participants.map((p) => {
      const resolvedJid = this.cache.resolveLid(p.id);
      const isPhone = resolvedJid.endsWith('@s.whatsapp.net');
      return {
        jid: resolvedJid,
        phone: isPhone ? resolvedJid.split('@')[0] : null,
        name: p.name ?? null,
        role: (p.admin === 'superadmin' ? 'superadmin' : p.admin === 'admin' ? 'admin' : 'member') as GroupMember['role'],
      };
    });
  }

  async getChats(query?: string): Promise<ChatMetadata[]> {
    if (this.cache.hasCachedChats()) return this.cache.getChats(query);
    if (!this.sock || this.status !== ServiceStatus.CONNECTED) throw new Error('WhatsApp is not connected');
    const groups = await this.sock.groupFetchAllParticipating();
    for (const [id, meta] of Object.entries(groups)) {
      this.cache.setChat({ id, name: meta.subject, isGroup: true, phone: null });
    }
    logger.info({ deviceId: this.deviceId, count: Object.keys(groups).length }, 'Chat cache seeded from group fetch');
    return this.cache.getChats(query);
  }

  async subscribe(jid: string): Promise<void> {
    await this.cache.subscribe(jid);
    logger.info({ deviceId: this.deviceId, jid }, 'Subscribed to chat');
  }

  async unsubscribe(jid: string): Promise<void> {
    await this.cache.unsubscribe(jid);
    logger.info({ deviceId: this.deviceId, jid }, 'Unsubscribed from chat');
  }

  getSubscribed(): string[] { return this.cache.getSubscribed(); }

  async resetAuth(): Promise<void> {
    logger.warn({ deviceId: this.deviceId }, 'Auth reset requested');
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.cleanupSocket();
    try {
      const files = await fs.readdir(this.authDir);
      await Promise.all(files.map((f) => fs.rm(path.join(this.authDir, f), { recursive: true, force: true })));
      logger.info({ deviceId: this.deviceId, count: files?.length }, 'Auth files cleared');
    } catch { /* dir may be empty */ }
    this.qrCode = null;
    this.reconnectAttempts = 0;
    this.status = ServiceStatus.INITIALIZING;
    this.scheduleRestart(1000);
  }

  async close(): Promise<void> {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.cleanupSocket();
    this.status = ServiceStatus.DISCONNECTED;
    logger.info({ deviceId: this.deviceId }, 'Connection closed gracefully');
  }
}
