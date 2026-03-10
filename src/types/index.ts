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

export interface ChatMetadata {
  id: string;
  name: string;
  isGroup: boolean;
  phone: string | null;
}

export interface InboundMessage {
  id: string;
  from: string;
  chatId: string;
  text: string | null;
  timestamp: number;
  isGroup: boolean;
  pushName: string | null;
}

export interface StatusData {
  status: ServiceStatus;
  uptime: number;
  connectedAt: number | null;
  lastDisconnect: number | null;
  qr: string | null;
}

export interface QrData {
  qr: string;
}

export interface SendResult {
  msgId: string;
}
