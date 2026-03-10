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
  deviceId: string;
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
