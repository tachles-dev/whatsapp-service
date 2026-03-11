// types/index.ts

export enum ServiceStatus {
  INITIALIZING = 'INITIALIZING',
  QR_READY = 'QR_READY',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  timestamp: number;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface SendMessageRequest {
  jid: string;
  text: string;
  quotedId?: string;
}

export interface GroupMember {
  /** Resolved phone JID (e.g. 972501234567@s.whatsapp.net), or @lid if unresolvable */
  jid: string;
  /** E.164-style phone number without +, or null if the JID is still a LID */
  phone: string | null;
  name: string | null;
  role: 'admin' | 'superadmin' | 'member';
}

export interface ChatMetadata {
  id: string;
  name: string;
  isGroup: boolean;
  phone: string | null;
}

export interface InboundMessage {
  type: 'message';
  deviceId: string;
  id: string;
  from: string;
  chatId: string;
  text: string | null;
  timestamp: number;
  isGroup: boolean;
  pushName: string | null;
}

export interface ReactionEvent {
  type: 'reaction';
  deviceId: string;
  /** ID of the message that was reacted to (matches the msgId returned by sendMessage). */
  messageId: string;
  /** JID of the person who reacted. */
  from: string;
  chatId: string;
  isGroup: boolean;
  pushName: string | null;
  /** The emoji used, or null/empty-string when the reaction was removed. */
  emoji: string | null;
  timestamp: number;
}

export interface ReceiptEvent {
  type: 'receipt';
  deviceId: string;
  /** ID of the message being acknowledged. */
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

export type WebhookEvent = InboundMessage | ReactionEvent | ReceiptEvent;

export interface StatusData {
  status: ServiceStatus;
  uptime: number;
  connectedAt: number | null;
  lastDisconnect: number | null;
  qr: string | null;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  /** WhatsApp phone number (digits only), set once the QR is scanned and confirmed. */
  phone: string | null;
}

export interface DeviceStatusData extends StatusData {
  deviceId: string;
  deviceName: string;
}

export interface QrData {
  qr: string;
}

export interface SendResult {
  msgId: string;
}
