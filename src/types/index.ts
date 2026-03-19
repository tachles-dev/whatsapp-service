// types/index.ts — Domain types, webhook events, and adapter contract.

// ── Enums ─────────────────────────────────────────────────────────────────

export enum ServiceStatus {
  INITIALIZING = 'INITIALIZING',
  QR_READY = 'QR_READY',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
}

/**
 * Typed error codes. Used by AppError and serialised in API error responses.
 * Clients should switch on these codes rather than parsing message strings.
 */
export enum ErrorCode {
  // Auth
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  // Resources
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  LIMIT_REACHED = 'LIMIT_REACHED',
  // Input
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_JID = 'INVALID_JID',
  INVALID_PHONE = 'INVALID_PHONE',
  // Device state
  DEVICE_NOT_CONNECTED = 'DEVICE_NOT_CONNECTED',
  DEVICE_INITIALIZING = 'DEVICE_INITIALIZING',
  // WhatsApp operations
  WHATSAPP_ERROR = 'WHATSAPP_ERROR',
  NOT_ON_WHATSAPP = 'NOT_ON_WHATSAPP',
  MEDIA_ERROR = 'MEDIA_ERROR',
  GROUP_ERROR = 'GROUP_ERROR',
  // System
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
}

/** Presence states as reported / sent by WhatsApp. */
export enum PresenceType {
  AVAILABLE = 'available',
  UNAVAILABLE = 'unavailable',
  COMPOSING = 'composing',
  RECORDING = 'recording',
  PAUSED = 'paused',
}

/** Group permission settings. */
export enum GroupSetting {
  /** Only admins can send messages. */
  ANNOUNCE = 'announcement',
  /** Everyone can send messages. */
  NOT_ANNOUNCE = 'not_announcement',
  /** Only admins can edit group info (name, description, icon). */
  LOCKED = 'locked',
  /** Everyone can edit group info. */
  UNLOCKED = 'unlocked',
}

/** Coarse classification of inbound message content. */
export enum MessageContentType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  STICKER = 'sticker',
  LOCATION = 'location',
  CONTACT = 'contact',
  POLL = 'poll',
  UNSUPPORTED = 'unsupported',
}

// ── API Envelope ──────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  timestamp: number;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// ── Domain: Media ─────────────────────────────────────────────────────────

/**
 * Represents a media source. Provide exactly one of url or base64.
 * - url: Baileys fetches the resource at send time. Preferred for large files.
 * - base64: Raw media encoded as a base64 string; decoded to a Buffer internally.
 */
export interface MediaSource {
  url?: string;
  base64?: string;
}

// ── Domain: Messages ──────────────────────────────────────────────────────

export interface SendOptions {
  /** Message ID of the message to quote/reply to. */
  quotedMessageId?: string;
  /** JIDs to @mention in the message body. */
  mentionedJids?: string[];
  /** Ephemeral expiry applied to this single message (seconds). 0 = off. */
  ephemeralExpiration?: number;
}

export interface SentMessage {
  messageId: string;
  timestamp: number;
}

export enum ScheduledMessageStatus {
  SCHEDULED = 'SCHEDULED',
  PROCESSING = 'PROCESSING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface ScheduledTextMessagePayload {
  text: string;
  options?: SendOptions;
}

export interface ScheduledTextMessage {
  id: string;
  clientId: string;
  deviceId: string;
  targetJid: string;
  messageType: 'text';
  payload: ScheduledTextMessagePayload;
  status: ScheduledMessageStatus;
  sendAt: number;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  cancelledAt: number | null;
  sentMessageId: string | null;
  lastError: string | null;
  attemptCount: number;
}

export interface LocationPayload {
  degreesLatitude: number;
  degreesLongitude: number;
  /** Optional human-readable place name shown in the chat bubble. */
  name?: string;
  /** Optional address string shown below the name. */
  address?: string;
}

// ── Domain: Contacts ──────────────────────────────────────────────────────

export interface ContactInfo {
  jid: string;
  phone: string | null;
  name: string | null;
  pushName: string | null;
  verifiedName: string | null;
}

export interface PhoneCheckResult {
  phone: string;
  exists: boolean;
  jid: string | null;
}

export interface ContactStatusInfo {
  jid: string;
  /** WhatsApp "about" / status text set by the contact. */
  status: string | null;
  setAt: number | null;
}

// ── Domain: Chats ─────────────────────────────────────────────────────────

export interface ChatMetadata {
  id: string;
  /** Address book name (contact.name) if available, otherwise push name (contact.notify). */
  name: string;
  /** Raw WhatsApp push name — stored separately so both fields are searchable. */
  notify: string | null;
  isGroup: boolean;
  phone: string | null;
}

// ── Domain: Groups ────────────────────────────────────────────────────────

export interface GroupMember {
  /** Resolved phone JID (e.g. 972501234567@s.whatsapp.net), or @lid if unresolvable */
  jid: string;
  /** E.164-style phone number without +, or null if the JID is still a LID */
  phone: string | null;
  name: string | null;
  role: 'admin' | 'superadmin' | 'member';
}

export interface GroupMetadata {
  id: string;
  subject: string;
  description: string | null;
  ownerJid: string | null;
  createdAt: number | null;
  participants: GroupMember[];
  /** true = only admins can send messages */
  isAnnounceMode: boolean;
  /** true = only admins can edit group info */
  isLocked: boolean;
  /** Disappearing message duration in seconds. null = disabled. */
  ephemeralDuration: number | null;
}

export interface GroupCreatedResult {
  jid: string;
  subject: string;
  participants: string[];
}

export interface ParticipantActionResult {
  jid: string;
  phone: string | null;
  /** Baileys action outcome code. */
  status: 'ok' | 'not-authorized' | 'not-on-whatsapp' | 'already-in-group' | 'unknown';
}

// ── Domain: Profile ───────────────────────────────────────────────────────

export interface OwnProfile {
  jid: string;
  phone: string;
  name: string | null;
}

// ── Domain: Device ────────────────────────────────────────────────────────

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  /** WhatsApp phone number (digits only), set once the QR is scanned and confirmed. */
  phone: string | null;
}

export interface DeviceStatusData {
  deviceId: string;
  phone: string | null;
  status: ServiceStatus;
  uptime: number;
  connectedAt: number | null;
  lastDisconnect: number | null;
  qr: string | null;
  ownerInstanceId?: string;
  reconnectAttempts?: number;
  nextReconnectAt?: number | null;
  recovering?: boolean;
}

// ── Webhook Events ────────────────────────────────────────────────────────

export interface InboundMessage {
  type: 'message';
  deviceId: string;
  id: string;
  /** For groups: participant JID. For DMs: same as chatId. */
  from: string;
  chatId: string;
  /** Coarse message type for content-based routing. */
  messageType: MessageContentType;
  /** Text body, or caption for image/video. */
  text: string | null;
  /** MIME type for media messages (e.g. 'image/jpeg', 'video/mp4'). */
  mimeType: string | null;
  /** Original filename for document messages. */
  fileName: string | null;
  /** Location coordinates for location messages. */
  location: LocationPayload | null;
  timestamp: number;
  isGroup: boolean;
  /** True if this message was forwarded from another conversation. */
  isForwarded: boolean;
  /** ID of the message being replied to, if this is a quoted reply. */
  quotedMessageId: string | null;
  /** JIDs mentioned via @ in this message. */
  mentionedJids: string[];
  pushName: string | null;
}

export interface ReactionEvent {
  type: 'reaction';
  deviceId: string;
  /** ID of the message that was reacted to. */
  messageId: string;
  from: string;
  chatId: string;
  isGroup: boolean;
  pushName: string | null;
  /** Emoji used, or null/empty when the reaction was removed. */
  emoji: string | null;
  timestamp: number;
}

export interface ReceiptEvent {
  type: 'receipt';
  deviceId: string;
  messageId: string;
  chatId: string;
  isGroup: boolean;
  receipts: {
    participantJid: string;
    /** 'READ' | 'DELIVERY' | 'PLAYED' | 'SERVER_ACK' */
    type: string;
    readTimestamp?: number;
    receiptTimestamp?: number;
  }[];
  timestamp: number;
}

export interface GroupParticipantsUpdateEvent {
  type: 'group_participants_update';
  deviceId: string;
  chatId: string;
  /** 'add' | 'remove' | 'promote' | 'demote' */
  action: string;
  participants: {
    jid: string;
    phone: string | null;
  }[];
  timestamp: number;
}

export interface PresenceUpdateEvent {
  type: 'presence_update';
  deviceId: string;
  /** Chat or contact JID this presence is scoped to. */
  chatId: string;
  participantJid: string;
  presence: PresenceType;
  /** Unix timestamp (seconds) of last seen, if available. */
  lastSeen: number | null;
  timestamp: number;
}

export interface GroupUpdateEvent {
  type: 'group_update';
  deviceId: string;
  chatId: string;
  updates: {
    subject?: string;
    description?: string;
    announce?: boolean;
    locked?: boolean;
    ephemeralDuration?: number | null;
  };
  timestamp: number;
}

export interface CallEvent {
  type: 'call';
  deviceId: string;
  callId: string;
  from: string;
  /** offer = incoming ring, terminate = call ended, reject = declined, accept = answered */
  status: 'offer' | 'terminate' | 'reject' | 'accept';
  isVideo: boolean;
  timestamp: number;
}

export type WebhookEvent =
  | InboundMessage
  | ReactionEvent
  | ReceiptEvent
  | GroupParticipantsUpdateEvent
  | PresenceUpdateEvent
  | GroupUpdateEvent
  | CallEvent;

// ── Adapter interface ─────────────────────────────────────────────────────

/**
 * Full contract every WhatsApp transport adapter must satisfy.
 *
 * Today: BaileysAdapter (unofficial WebSocket via @whiskeysockets/baileys)
 * Planned: CloudApiAdapter (official Meta Cloud API)
 *
 * All routes and DeviceManager work exclusively through this interface so
 * swapping the underlying transport requires no changes outside the adapter.
 */
export interface IWhatsAppAdapter {
  readonly deviceId: string;
  readonly clientId: string;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  start(): Promise<void>;
  close(): Promise<void>;
  resetAuth(): Promise<void>;

  // ── Status ─────────────────────────────────────────────────────────────────
  getStatus(): ServiceStatus;
  getStatusData(): DeviceStatusData;
  getConnectedPhone(): string | null;
  getQr(): string | null;
  setPhoneVerifier(cb: (phone: string) => Promise<boolean>): void;

  // ── Messaging ──────────────────────────────────────────────────────────────
  /** @deprecated Use sendTextMessage */
  sendMessage(jid: string, text: string, quotedId?: string): Promise<string>;
  sendTextMessage(jid: string, text: string, options?: SendOptions): Promise<SentMessage>;
  sendImageMessage(jid: string, media: MediaSource, options?: SendOptions & { caption?: string }): Promise<SentMessage>;
  sendVideoMessage(jid: string, media: MediaSource, options?: SendOptions & { caption?: string }): Promise<SentMessage>;
  sendAudioMessage(jid: string, media: MediaSource, options?: SendOptions & { ptt?: boolean }): Promise<SentMessage>;
  sendDocumentMessage(jid: string, media: MediaSource, options?: SendOptions & { fileName?: string; mimeType?: string }): Promise<SentMessage>;
  sendLocationMessage(jid: string, location: LocationPayload, options?: SendOptions): Promise<SentMessage>;
  sendReactionMessage(jid: string, targetMessageId: string, emoji: string): Promise<void>;
  deleteMessage(jid: string, messageId: string, forEveryone: boolean): Promise<void>;

  // ── Contacts ───────────────────────────────────────────────────────────────
  checkPhone(phone: string): Promise<PhoneCheckResult>;
  getProfilePicture(jid: string): Promise<string | null>;
  getContactStatus(jid: string): Promise<ContactStatusInfo>;
  blockContact(jid: string): Promise<void>;
  unblockContact(jid: string): Promise<void>;
  getBlocklist(): Promise<string[]>;

  // ── Chats ──────────────────────────────────────────────────────────────────
  getChats(query?: string, kind?: 'CONTACT' | 'GROUP', hideUnnamed?: boolean): Promise<ChatMetadata[]>;
  archiveChat(jid: string, archive: boolean): Promise<void>;
  muteChat(jid: string, muteDurationMs: number | null): Promise<void>;
  pinChat(jid: string, pin: boolean): Promise<void>;
  markRead(jid: string, messageIds: string[]): Promise<void>;
  deleteChat(jid: string): Promise<void>;
  setEphemeralExpiration(jid: string, expirationSeconds: number): Promise<void>;

  // ── Groups ─────────────────────────────────────────────────────────────────
  getGroupMembers(jid: string): Promise<GroupMember[]>;
  getGroupMetadata(jid: string): Promise<GroupMetadata>;
  createGroup(subject: string, participantJids: string[]): Promise<GroupCreatedResult>;
  updateGroupSubject(jid: string, subject: string): Promise<void>;
  updateGroupDescription(jid: string, description: string): Promise<void>;
  updateGroupParticipants(jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote'): Promise<ParticipantActionResult[]>;
  updateGroupSettings(jid: string, setting: GroupSetting): Promise<void>;
  leaveGroup(jid: string): Promise<void>;
  getGroupInviteCode(jid: string): Promise<string>;
  revokeGroupInviteCode(jid: string): Promise<string>;
  joinGroupViaInviteCode(code: string): Promise<GroupMetadata>;

  // ── Presence ───────────────────────────────────────────────────────────────
  sendPresence(presence: PresenceType, toJid?: string): Promise<void>;
  subscribeToPresence(jid: string): Promise<void>;

  // ── Profile ────────────────────────────────────────────────────────────────
  getOwnProfile(): Promise<OwnProfile>;
  updateDisplayName(name: string): Promise<void>;
  updateStatusText(status: string): Promise<void>;

  // ── Subscriptions (webhook event routing) ─────────────────────────────────
  subscribe(jid: string): Promise<void>;
  unsubscribe(jid: string): Promise<void>;
  getSubscribed(): string[];
}

// ── Client config ─────────────────────────────────────────────────────────

export interface ClientConfig {
  /**
   * HMAC-SHA256 hash of the client's API key.
   * The plaintext key is returned once on generation and never stored.
   * Verified at request time by re-hashing the provided key.
   */
  apiKeyHash?: string;
  /** Unix ms — key is rejected after this timestamp. */
  apiKeyExpiresAt?: number;
  /** Unix ms — timestamp of the last successful authenticated request. */
  apiKeyLastUsedAt?: number;
  /** IP address of the last successful authenticated request. */
  apiKeyLastUsedIp?: string;
  /** Per-client webhook URL. Falls back to global WEBHOOK_URL env var if absent. */
  webhookUrl?: string;
  /** Per-client webhook API key. Falls back to global WEBHOOK_API_KEY env var if absent. */
  webhookApiKey?: string;
  /** Control which event types are forwarded to the client's webhook. */
  events: {
    messages: boolean;
    reactions: boolean;
    /** Delivery/read receipts — disabled by default (high volume). */
    receipts: boolean;
    groupParticipants: boolean;
    /** Contact presence updates (typing, online, last seen). */
    presenceUpdates: boolean;
    /** Group metadata changes (subject, description, settings). */
    groupUpdates: boolean;
    /** Incoming call events. */
    calls: boolean;
  };
  /** Default behaviour for GET /chats queries (can be overridden per-request). */
  chats: {
    defaultKind?: 'CONTACT' | 'GROUP';
    hideUnnamed: boolean;
  };
  /** Maximum number of devices this client may register. */
  maxDevices: number;
}

export interface ClientMetadata {
  status: 'active' | 'suspended' | 'offboarding';
  externalRef?: string;
  notes?: string;
  tags: string[];
  plan?: {
    code?: string;
    name?: string;
    storageSoftLimitMb?: number;
  };
  contact?: {
    companyName?: string;
    personName?: string;
    email?: string;
    phone?: string;
  };
  limits?: {
    clientSendsPerWindow?: number;
    deviceSendsPerWindow?: number;
  };
}

// ── Legacy types (kept for backward compat) ───────────────────────────────

/** @deprecated Use DeviceStatusData */
export interface StatusData {
  status: ServiceStatus;
  uptime: number;
  connectedAt: number | null;
  lastDisconnect: number | null;
  qr: string | null;
}

export interface SendMessageRequest {
  jid: string;
  text: string;
  quotedId?: string;
}

export interface QrData {
  qr: string;
}

export interface SendResult {
  msgId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function isPhoneJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net');
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

export function phoneFromJid(jid: string): string | null {
  return isPhoneJid(jid) ? jid.split('@')[0] : null;
}

