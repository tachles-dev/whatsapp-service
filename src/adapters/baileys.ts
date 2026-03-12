// adapters/baileys.ts — BaileysAdapter: WhatsApp Web transport via @whiskeysockets/baileys.
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
import { loadConfig } from '../config';
import { logger } from '../logger';
import { getRedis } from '../redis';
import { DeviceCache } from '../core/cache';
import {
  ServiceStatus,
  InboundMessage,
  ReactionEvent,
  ReceiptEvent,
  GroupParticipantsUpdateEvent,
  PresenceUpdateEvent,
  GroupUpdateEvent,
  CallEvent,
  GroupMember,
  ChatMetadata,
  GroupMetadata,
  GroupCreatedResult,
  ParticipantActionResult,
  OwnProfile,
  ContactStatusInfo,
  PhoneCheckResult,
  IWhatsAppAdapter,
  SendOptions,
  SentMessage,
  MediaSource,
  LocationPayload,
  ErrorCode,
  PresenceType,
  GroupSetting,
  MessageContentType,
  DeviceStatusData,
} from '../types';
import { enqueueWebhookEvent } from '../queue';
import { clientConfigManager } from '../core/client-config';
import { AppError } from '../errors';

export class BaileysAdapter implements IWhatsAppAdapter {
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

  // ── Internal helpers ───────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this.sock || this.status !== ServiceStatus.CONNECTED) {
      throw new AppError(
        ErrorCode.DEVICE_NOT_CONNECTED,
        `Device ${this.deviceId} is not connected (status: ${this.status}). Scan the QR or wait for reconnection.`,
        503,
        true,
      );
    }
  }

  /** Resolves a MediaSource to either a URL object (Baileys fetches it) or a raw Buffer. */
  private resolveMedia(media: MediaSource): { url: string } | Buffer {
    if (media.url) return { url: media.url };
    if (media.base64) return Buffer.from(media.base64, 'base64');
    throw new AppError(ErrorCode.MEDIA_ERROR, 'MediaSource must have either url or base64', 400, false);
  }

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
        this.sock!.ev.removeAllListeners('connection.update');
        this.sock!.ev.removeAllListeners('creds.update');
        this.sock!.ev.removeAllListeners('messages.upsert');
        this.sock!.ev.removeAllListeners('contacts.upsert');
        this.sock!.ev.removeAllListeners('messaging-history.set');
        this.sock!.ev.removeAllListeners('groups.upsert');
        this.sock!.ev.removeAllListeners('groups.update');
        this.sock!.ev.removeAllListeners('messages.reaction');
        this.sock!.ev.removeAllListeners('message-receipt.update');
        this.sock!.ev.removeAllListeners('group-participants.update');
        this.sock!.ev.removeAllListeners('presence.update');
        this.sock!.ev.removeAllListeners('call');
        this.sock!.end(undefined);
      } catch { /* ignore */ }
      this.sock = null;
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(): ServiceStatus { return this.status; }
  getQr(): string | null { return this.qrCode; }
  getSocket(): WASocket | null { return this.sock; }

  getStatusData(): DeviceStatusData {
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

  // ── Lifecycle ──────────────────────────────────────────────────────────────

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

    this.sock!.ev.on('creds.update', saveCreds);
    this.sock!.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(update);
    });

    this.sock!.ev.on('groups.upsert', (groups) => {
      for (const group of groups) {
        this.cache.setChat({ id: group.id, name: group.subject, notify: null, isGroup: true, phone: null });
      }
    });

    this.sock!.ev.on('groups.update', (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const existing = this.cache.getChat(update.id);
        this.cache.setChat(
          existing
            ? { ...existing, ...(update.subject ? { name: update.subject } : {}) }
            : { id: update.id, name: update.subject || update.id, notify: null, isGroup: true, phone: null },
        );

        // Emit GroupUpdateEvent if subscribed and client has groupUpdates enabled
        if (clientConfigManager.getConfig(this.clientId).events.groupUpdates && this.cache.isSubscribed(update.id)) {
          const patch: GroupUpdateEvent['updates'] = {};
          if (update.subject) patch.subject = update.subject;
          if (update.desc) patch.description = update.desc;
          if (update.announce !== undefined) patch.announce = update.announce;
          if (update.restrict !== undefined) patch.locked = update.restrict;
          const event: GroupUpdateEvent = {
            type: 'group_update',
            deviceId: this.deviceId,
            chatId: update.id,
            updates: patch,
            timestamp: Math.floor(Date.now() / 1000),
          };
          enqueueWebhookEvent(this.clientId, event).catch(() => {});
        }
      }
    });

    this.sock!.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        if (!contact.id || contact.id === 'status@broadcast') continue;
        if (contact.lid && contact.id.endsWith('@s.whatsapp.net')) {
          this.cache.setLid(contact.lid as string, contact.id);
        }
        // Prefer address book name (contact.name = what YOU saved) over push name
        // (contact.notify = what THEY set). Both are stored so either is searchable.
        this.cache.setChat({
          id: contact.id,
          name: contact.name || contact.verifiedName || contact.notify || contact.id.split('@')[0],
          notify: contact.notify || null,
          isGroup: contact.id.endsWith('@g.us'),
          phone: contact.id.endsWith('@s.whatsapp.net') ? contact.id.split('@')[0] : null,
        });
      }
    });

    this.sock!.ev.on('messaging-history.set', ({ contacts }) => {
      if (!contacts?.length) return;
      for (const contact of contacts) {
        if (!contact.id || contact.id === 'status@broadcast') continue;
        if (contact.lid && contact.id.endsWith('@s.whatsapp.net')) {
          this.cache.setLid(contact.lid as string, contact.id);
        }
        this.cache.setChat({
          id: contact.id,
          name: contact.name || contact.verifiedName || contact.notify || contact.id.split('@')[0],
          notify: contact.notify || null,
          isGroup: contact.id.endsWith('@g.us'),
          phone: contact.id.endsWith('@s.whatsapp.net') ? contact.id.split('@')[0] : null,
        });
      }
    });

    this.sock!.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) await this.handleInboundMessage(msg);
    });

    this.sock!.ev.on('messages.reaction', async (reactions: any[]) => {
      if (!clientConfigManager.getConfig(this.clientId).events.reactions) return;
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
        await enqueueWebhookEvent(this.clientId, event);
      }
    });

    this.sock!.ev.on('message-receipt.update', async (updates: any[]) => {
      if (!clientConfigManager.getConfig(this.clientId).events.receipts) return;
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
        await enqueueWebhookEvent(this.clientId, event);
      }
    });

    this.sock!.ev.on('group-participants.update', async ({ id, participants, action }) => {
      if (!clientConfigManager.getConfig(this.clientId).events.groupParticipants) return;
      const event: GroupParticipantsUpdateEvent = {
        type: 'group_participants_update',
        deviceId: this.deviceId,
        chatId: id,
        action,
        participants: participants.map((p) => {
          const resolvedJid = this.cache.resolveLid(p.id);
          return {
            jid: resolvedJid,
            phone: resolvedJid.endsWith('@s.whatsapp.net') ? resolvedJid.split('@')[0] : null,
          };
        }),
        timestamp: Math.floor(Date.now() / 1000),
      };
      await enqueueWebhookEvent(this.clientId, event);
    });

    this.sock!.ev.on('presence.update', async ({ id, presences }) => {
      if (!clientConfigManager.getConfig(this.clientId).events.presenceUpdates) return;
      for (const [participantJid, presence] of Object.entries(presences as Record<string, any>)) {
        const event: PresenceUpdateEvent = {
          type: 'presence_update',
          deviceId: this.deviceId,
          chatId: id,
          participantJid: this.cache.resolveLid(participantJid),
          presence: (presence.lastKnownPresence as PresenceType) ?? PresenceType.UNAVAILABLE,
          lastSeen: presence.lastSeen ? Number(presence.lastSeen) : null,
          timestamp: Math.floor(Date.now() / 1000),
        };
        await enqueueWebhookEvent(this.clientId, event);
      }
    });

    this.sock!.ev.on('call', async (calls: any[]) => {
      if (!clientConfigManager.getConfig(this.clientId).events.calls) return;
      for (const call of calls) {
        const event: CallEvent = {
          type: 'call',
          deviceId: this.deviceId,
          callId: call.id,
          from: this.cache.resolveLid(call.from),
          status: call.status as CallEvent['status'],
          isVideo: call.isVideo ?? false,
          timestamp: Math.floor(Date.now() / 1000),
        };
        await enqueueWebhookEvent(this.clientId, event);
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
      const rawId = this.sock?.user?.id ?? '';
      const phone = rawId.split('@')[0].split(':')[0] || null;
      this.connectedPhone = phone;

      if (phone && this.phoneVerifier) {
        const allowed = await this.phoneVerifier(phone);
        if (!allowed) {
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

    // Enrich the contact cache with the sender's push name, which is present on every
    // message. This catches contacts that never appeared in contacts.upsert — they will
    // show with a real name the first time they message rather than a bare JID/phone.
    if (msg.pushName) {
      const senderJid = msg.key.participant || remoteJid; // participant is set in group msgs
      const resolved = this.cache.resolveLid(senderJid);
      if (!resolved.endsWith('@g.us')) {
        const existing = this.cache.getChat(resolved);
        const rawId = resolved.includes('@') ? resolved.slice(0, resolved.indexOf('@')) : resolved;
        // Only overwrite name if no address-book name has been set (i.e. it's still just the number)
        const hasAddressBookName = existing && existing.name !== rawId && existing.name !== existing.phone;
        this.cache.setChat({
          id: resolved,
          name: hasAddressBookName ? existing!.name : msg.pushName,
          notify: msg.pushName,
          isGroup: false,
          phone: resolved.endsWith('@s.whatsapp.net') ? rawId : null,
        });
      }
    }

    if (msg.message) {
      const encoded = Buffer.from(proto.Message.encode(msg.message).finish()).toString('base64');
      const msgKey = `msg:${this.deviceId}:${messageId}`;
      this.setCachedMsg(msgKey, encoded);
      await getRedis().set(msgKey, encoded, 'EX', 3600);
    }

    const m = msg.message;
    let messageType = MessageContentType.UNSUPPORTED;
    let text: string | null = null;
    let mimeType: string | null = null;
    let fileName: string | null = null;
    let location: LocationPayload | null = null;

    if (m?.conversation || m?.extendedTextMessage) {
      messageType = MessageContentType.TEXT;
      text = m.conversation ?? m.extendedTextMessage?.text ?? null;
    } else if (m?.imageMessage) {
      messageType = MessageContentType.IMAGE;
      text = m.imageMessage.caption ?? null;
      mimeType = m.imageMessage.mimetype ?? null;
    } else if (m?.videoMessage) {
      messageType = MessageContentType.VIDEO;
      text = m.videoMessage.caption ?? null;
      mimeType = m.videoMessage.mimetype ?? null;
    } else if (m?.audioMessage) {
      messageType = MessageContentType.AUDIO;
      mimeType = m.audioMessage.mimetype ?? null;
    } else if (m?.documentMessage) {
      messageType = MessageContentType.DOCUMENT;
      fileName = m.documentMessage.fileName ?? null;
      mimeType = m.documentMessage.mimetype ?? null;
    } else if (m?.stickerMessage) {
      messageType = MessageContentType.STICKER;
      mimeType = m.stickerMessage.mimetype ?? null;
    } else if (m?.locationMessage) {
      messageType = MessageContentType.LOCATION;
      location = {
        degreesLatitude: m.locationMessage.degreesLatitude ?? 0,
        degreesLongitude: m.locationMessage.degreesLongitude ?? 0,
        name: m.locationMessage.name ?? undefined,
        address: m.locationMessage.address ?? undefined,
      };
    }

    const contextInfo = m?.extendedTextMessage?.contextInfo
      ?? m?.imageMessage?.contextInfo
      ?? m?.videoMessage?.contextInfo
      ?? m?.documentMessage?.contextInfo;

    const isForwarded = !!(contextInfo?.isForwarded);
    const quotedMessageId = contextInfo?.stanzaId ?? null;
    const mentionedJids = (contextInfo?.mentionedJid ?? []).filter(Boolean) as string[];

    const inbound: InboundMessage = {
      type: 'message',
      deviceId: this.deviceId,
      id: messageId,
      from: this.cache.resolveLid(msg.key.participant || remoteJid),
      chatId: remoteJid,
      messageType,
      text,
      mimeType,
      fileName,
      location,
      timestamp: msg.messageTimestamp as number,
      isGroup: remoteJid.endsWith('@g.us'),
      isForwarded,
      quotedMessageId,
      mentionedJids,
      pushName: msg.pushName || null,
    };

    if (!clientConfigManager.getConfig(this.clientId).events.messages) return;
    await enqueueWebhookEvent(this.clientId, inbound);
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  /** @deprecated Use sendTextMessage */
  async sendMessage(jid: string, text: string, quotedId?: string): Promise<string> {
    const result = await this.sendTextMessage(jid, text, { quotedMessageId: quotedId });
    return result.messageId;
  }

  async sendTextMessage(jid: string, text: string, options?: SendOptions): Promise<SentMessage> {
    this.assertConnected();
    const result = await this.sock!.sendMessage(
      jid,
      {
        text,
        ...(options?.mentionedJids?.length ? { mentions: options.mentionedJids } : {}),
      },
      {
        ...(options?.quotedMessageId
          ? { quoted: { key: { remoteJid: jid, id: options.quotedMessageId } } as any }
          : {}),
      },
    );
    return { messageId: result?.key.id ?? '', timestamp: Math.floor(Date.now() / 1000) };
  }

  async sendImageMessage(jid: string, media: MediaSource, options?: SendOptions & { caption?: string }): Promise<SentMessage> {
    this.assertConnected();
    const result = await this.sock!.sendMessage(
      jid,
      {
        image: this.resolveMedia(media) as any,
        caption: options?.caption,
        ...(options?.mentionedJids?.length ? { mentions: options.mentionedJids } : {}),
      },
      {
        ...(options?.quotedMessageId
          ? { quoted: { key: { remoteJid: jid, id: options.quotedMessageId } } as any }
          : {}),
      },
    );
    return { messageId: result?.key.id ?? '', timestamp: Math.floor(Date.now() / 1000) };
  }

  async sendVideoMessage(jid: string, media: MediaSource, options?: SendOptions & { caption?: string }): Promise<SentMessage> {
    this.assertConnected();
    const result = await this.sock!.sendMessage(
      jid,
      {
        video: this.resolveMedia(media) as any,
        caption: options?.caption,
      },
      {
        ...(options?.quotedMessageId
          ? { quoted: { key: { remoteJid: jid, id: options.quotedMessageId } } as any }
          : {}),
      },
    );
    return { messageId: result?.key.id ?? '', timestamp: Math.floor(Date.now() / 1000) };
  }

  async sendAudioMessage(jid: string, media: MediaSource, options?: SendOptions & { ptt?: boolean }): Promise<SentMessage> {
    this.assertConnected();
    const result = await this.sock!.sendMessage(
      jid,
      { audio: this.resolveMedia(media) as any, ptt: options?.ptt ?? false },
      {
        ...(options?.quotedMessageId
          ? { quoted: { key: { remoteJid: jid, id: options.quotedMessageId } } as any }
          : {}),
      },
    );
    return { messageId: result?.key.id ?? '', timestamp: Math.floor(Date.now() / 1000) };
  }

  async sendDocumentMessage(jid: string, media: MediaSource, options?: SendOptions & { fileName?: string; mimeType?: string }): Promise<SentMessage> {
    this.assertConnected();
    const result = await this.sock!.sendMessage(
      jid,
      {
        document: this.resolveMedia(media) as any,
        fileName: options?.fileName,
        mimetype: options?.mimeType ?? 'application/octet-stream',
      },
      {
        ...(options?.quotedMessageId
          ? { quoted: { key: { remoteJid: jid, id: options.quotedMessageId } } as any }
          : {}),
      },
    );
    return { messageId: result?.key.id ?? '', timestamp: Math.floor(Date.now() / 1000) };
  }

  async sendLocationMessage(jid: string, location: LocationPayload, options?: SendOptions): Promise<SentMessage> {
    this.assertConnected();
    const result = await this.sock!.sendMessage(jid, {
      location: {
        degreesLatitude: location.degreesLatitude,
        degreesLongitude: location.degreesLongitude,
        name: location.name,
        address: location.address,
      },
    });
    void options;
    return { messageId: result?.key.id ?? '', timestamp: Math.floor(Date.now() / 1000) };
  }

  async sendReactionMessage(jid: string, targetMessageId: string, emoji: string): Promise<void> {
    this.assertConnected();
    await this.sock!.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: targetMessageId } },
    });
  }

  async deleteMessage(jid: string, messageId: string, forEveryone: boolean): Promise<void> {
    this.assertConnected();
    if (forEveryone) {
      await this.sock!.sendMessage(jid, { delete: { remoteJid: jid, id: messageId, fromMe: true } });
    } else {
      await this.sock!.chatModify({ clear: true } as any, jid);
    }
  }

  // ── Contacts ───────────────────────────────────────────────────────────────

  async checkPhone(phone: string): Promise<PhoneCheckResult> {
    this.assertConnected();
    const results = await this.sock!.onWhatsApp(phone);
    if (!results?.length || !results[0].exists) return { phone, exists: false, jid: null };
    const jid = results[0].jid ?? null;
    if (jid) this.cache.setChat({ id: jid, name: phone, notify: null, isGroup: false, phone });
    logger.info({ deviceId: this.deviceId, phone, jid }, 'Phone lookup succeeded — contact cached');
    return { phone, exists: true, jid };
  }

  async getProfilePicture(jid: string): Promise<string | null> {
    this.assertConnected();
    try {
      return (await this.sock!.profilePictureUrl(jid, 'image')) ?? null;
    } catch {
      return null;
    }
  }

  async getContactStatus(jid: string): Promise<ContactStatusInfo> {
    this.assertConnected();
    try {
      const result = await this.sock!.fetchStatus(jid);
      return {
        jid,
        status: (result as any)?.status ?? null,
        setAt: (result as any)?.setAt ? Math.floor(new Date((result as any).setAt).getTime() / 1000) : null,
      };
    } catch {
      return { jid, status: null, setAt: null };
    }
  }

  async blockContact(jid: string): Promise<void> {
    this.assertConnected();
    await this.sock!.updateBlockStatus(jid, 'block');
  }

  async unblockContact(jid: string): Promise<void> {
    this.assertConnected();
    await this.sock!.updateBlockStatus(jid, 'unblock');
  }

  async getBlocklist(): Promise<string[]> {
    this.assertConnected();
    const list = await this.sock!.fetchBlocklist();
    return (list as (string | undefined)[]).filter((j): j is string => j !== undefined);
  }

  // ── Chats ──────────────────────────────────────────────────────────────────

  async getChats(query?: string, kind?: 'CONTACT' | 'GROUP', hideUnnamed?: boolean): Promise<ChatMetadata[]> {
    if (this.cache.hasCachedChats()) return this.cache.getChats(query, kind, hideUnnamed);
    this.assertConnected();
    const groups = await this.sock!.groupFetchAllParticipating();
    for (const [id, meta] of Object.entries(groups)) {
      this.cache.setChat({ id, name: meta.subject, notify: null, isGroup: true, phone: null });
    }
    logger.info({ deviceId: this.deviceId, count: Object.keys(groups).length }, 'Chat cache seeded from group fetch');
    return this.cache.getChats(query, kind, hideUnnamed);
  }

  async archiveChat(jid: string, archive: boolean): Promise<void> {
    this.assertConnected();
    await this.sock!.chatModify({ archive, lastMessages: [] }, jid);
  }

  async muteChat(jid: string, muteDurationMs: number | null): Promise<void> {
    this.assertConnected();
    await this.sock!.chatModify({ mute: muteDurationMs }, jid);
  }

  async pinChat(jid: string, pin: boolean): Promise<void> {
    this.assertConnected();
    await this.sock!.chatModify({ pin }, jid);
  }

  async markRead(jid: string, messageIds: string[]): Promise<void> {
    this.assertConnected();
    await this.sock!.readMessages(messageIds.map((id) => ({ remoteJid: jid, id })));
  }

  async deleteChat(jid: string): Promise<void> {
    this.assertConnected();
    await this.sock!.chatModify({ delete: true, lastMessages: [] }, jid);
  }

  async setEphemeralExpiration(jid: string, expirationSeconds: number): Promise<void> {
    this.assertConnected();
    await this.sock!.sendMessage(jid, { disappearingMessagesInChat: expirationSeconds } as any);
  }

  // ── Groups ─────────────────────────────────────────────────────────────────

  async getGroupMembers(jid: string): Promise<GroupMember[]> {
    this.assertConnected();
    const meta = await this.sock!.groupMetadata(jid);
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

  async getGroupMetadata(jid: string): Promise<GroupMetadata> {
    this.assertConnected();
    const meta = await this.sock!.groupMetadata(jid);
    return {
      id: meta.id,
      subject: meta.subject,
      description: meta.desc ?? null,
      ownerJid: meta.owner ?? null,
      createdAt: meta.creation ? Number(meta.creation) : null,
      participants: meta.participants.map((p) => {
        const resolvedJid = this.cache.resolveLid(p.id);
        return {
          jid: resolvedJid,
          phone: resolvedJid.endsWith('@s.whatsapp.net') ? resolvedJid.split('@')[0] : null,
          name: p.name ?? null,
          role: (p.admin === 'superadmin' ? 'superadmin' : p.admin === 'admin' ? 'admin' : 'member') as GroupMember['role'],
        };
      }),
      isAnnounceMode: meta.announce ?? false,
      isLocked: meta.restrict ?? false,
      ephemeralDuration: meta.ephemeralDuration ? Number(meta.ephemeralDuration) : null,
    };
  }

  async createGroup(subject: string, participantJids: string[]): Promise<GroupCreatedResult> {
    this.assertConnected();
    const result = await this.sock!.groupCreate(subject, participantJids);
    return { jid: result.id, subject, participants: participantJids };
  }

  async updateGroupSubject(jid: string, subject: string): Promise<void> {
    this.assertConnected();
    await this.sock!.groupUpdateSubject(jid, subject);
  }

  async updateGroupDescription(jid: string, description: string): Promise<void> {
    this.assertConnected();
    await this.sock!.groupUpdateDescription(jid, description);
  }

  async updateGroupParticipants(
    jid: string,
    participants: string[],
    action: 'add' | 'remove' | 'promote' | 'demote',
  ): Promise<ParticipantActionResult[]> {
    this.assertConnected();
    const results = await this.sock!.groupParticipantsUpdate(jid, participants, action);
    return results.map((r: any) => ({
      jid: r.jid,
      phone: r.jid?.endsWith('@s.whatsapp.net') ? r.jid.split('@')[0] : null,
      status: (r.status as ParticipantActionResult['status']) ?? 'unknown',
    }));
  }

  async updateGroupSettings(jid: string, setting: GroupSetting): Promise<void> {
    this.assertConnected();
    await this.sock!.groupSettingUpdate(jid, setting as any);
  }

  async leaveGroup(jid: string): Promise<void> {
    this.assertConnected();
    await this.sock!.groupLeave(jid);
  }

  async getGroupInviteCode(jid: string): Promise<string> {
    this.assertConnected();
    const code = await this.sock!.groupInviteCode(jid);
    return code ?? '';
  }

  async revokeGroupInviteCode(jid: string): Promise<string> {
    this.assertConnected();
    const code = await this.sock!.groupRevokeInvite(jid);
    return code ?? '';
  }

  async joinGroupViaInviteCode(code: string): Promise<GroupMetadata> {
    this.assertConnected();
    const jid = await this.sock!.groupAcceptInvite(code);
    if (!jid) throw new AppError(ErrorCode.GROUP_ERROR, 'Failed to join group — no JID returned', 500, false);
    return this.getGroupMetadata(jid);
  }

  // ── Presence ───────────────────────────────────────────────────────────────

  async sendPresence(presence: PresenceType, toJid?: string): Promise<void> {
    this.assertConnected();
    await this.sock!.sendPresenceUpdate(presence as any, toJid);
  }

  async subscribeToPresence(jid: string): Promise<void> {
    this.assertConnected();
    await this.sock!.presenceSubscribe(jid);
  }

  // ── Profile ────────────────────────────────────────────────────────────────

  async getOwnProfile(): Promise<OwnProfile> {
    this.assertConnected();
    const rawId = this.sock!.user?.id ?? '';
    const phone = rawId.split('@')[0].split(':')[0] || '';
    return { jid: rawId, phone, name: this.sock!.user?.name ?? null };
  }

  async updateDisplayName(name: string): Promise<void> {
    this.assertConnected();
    await this.sock!.updateProfileName(name);
  }

  async updateStatusText(status: string): Promise<void> {
    this.assertConnected();
    await this.sock!.updateProfileStatus(status);
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  async subscribe(jid: string): Promise<void> {
    await this.cache.subscribe(jid);
    logger.info({ deviceId: this.deviceId, jid }, 'Subscribed to chat');
  }

  async unsubscribe(jid: string): Promise<void> {
    await this.cache.unsubscribe(jid);
    logger.info({ deviceId: this.deviceId, jid }, 'Unsubscribed from chat');
  }

  getSubscribed(): string[] { return this.cache.getSubscribed(); }

  // ── Auth ───────────────────────────────────────────────────────────────────

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

/** @deprecated Import BaileysAdapter directly. */
export const ConnectionManager = BaileysAdapter;
