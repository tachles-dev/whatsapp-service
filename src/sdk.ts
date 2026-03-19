import { createHmac, timingSafeEqual } from 'crypto';
import type { LoadSnapshot } from './load-monitor';
import type {
  ChatMetadata,
  ClientMetadata,
  ContactStatusInfo,
  DeviceInfo,
  DeviceStatusData,
  GroupCreatedResult,
  GroupMetadata,
  GroupSetting,
  MediaSource,
  OwnProfile,
  ParticipantActionResult,
  PhoneCheckResult,
  PresenceType,
  ScheduledMessageStatus,
  ScheduledTextMessage,
  SendOptions,
  SentMessage,
  WebhookEvent,
} from './types';

export const DEFAULT_API_BASE_PATH = '/api/v1';

export interface GatewayEnvelope<T> {
  success: boolean;
  timestamp: number;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface GatewayClientOptions {
  baseUrl: string;
  apiBasePath?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export interface GatewayRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ClientEventsPatch {
  messages?: boolean;
  reactions?: boolean;
  receipts?: boolean;
  groupParticipants?: boolean;
  presenceUpdates?: boolean;
  groupUpdates?: boolean;
  calls?: boolean;
}

export interface ClientChatsPatch {
  defaultKind?: 'CONTACT' | 'GROUP' | null;
  hideUnnamed?: boolean;
}

export interface ClientConfigPatch {
  webhookUrl?: string | null;
  webhookApiKey?: string | null;
  events?: ClientEventsPatch;
  chats?: ClientChatsPatch;
  maxDevices?: number;
}

export interface ClientConfig extends ClientConfigPatch {
  events?: Required<ClientEventsPatch>;
  chats?: Required<ClientChatsPatch>;
}

export interface ApiOverviewGroup {
  id: string;
  title: string;
  description: string;
  scope: 'system' | 'client' | 'device' | 'admin';
  endpoints: number;
}

export interface ApiOverview {
  service: {
    name: string;
    packageName: string;
    basePath: string;
    preferredBasePath?: string;
    legacyBasePath?: string;
  };
  links: {
    overview: string;
    agent?: string;
    reference: string;
    openapi?: string;
    docs: string;
    legacyOverview?: string;
  };
  totals: {
    groups: number;
    endpoints: number;
  };
  auth: Array<{ mode: string; description: string }>;
  groups: ApiOverviewGroup[];
}

export interface ApiReferenceEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  summary: string;
  auth: string;
  scope: string;
  description?: string;
  query?: string[];
  body?: string[];
  legacy?: boolean;
}

export interface ApiReferenceGroup {
  id: string;
  title: string;
  description: string;
  scope: string;
  endpoints: ApiReferenceEndpoint[];
}

export interface ApiReference {
  service: ApiOverview['service'];
  links: ApiOverview['links'];
  auth: ApiOverview['auth'];
  totals: ApiOverview['totals'];
  groups: ApiReferenceGroup[];
}

export interface AgentTaskRoute {
  task: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  auth: string;
  notes: string;
}

export interface AgentWorkflowStep {
  title: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  auth: string;
  notes: string;
  body?: Record<string, unknown>;
}

export interface AgentWorkflow {
  id: string;
  title: string;
  outcome: string;
  steps: AgentWorkflowStep[];
}

export interface AgentRequestExample {
  id: string;
  title: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface AgentContext {
  kind: 'wgs-agent-context/v1';
  service: ApiOverview['service'] & { sdkPackage: string };
  links: Required<Pick<ApiOverview['links'], 'overview' | 'reference' | 'docs'>> & ApiOverview['links'] & { agent: string };
  instructions: string[];
  auth: {
    header: 'x-api-key';
    adminCookie: 'wga_admin';
    modes: ApiOverview['auth'];
  };
  conventions: {
    preferredBasePath: string;
    legacyBasePath: string;
    requestContentType: 'application/json';
    responseEnvelope: string[];
    rateLimitHeaders: string[];
    pathRules: string[];
  };
  taskRoutes: AgentTaskRoute[];
  workflows: AgentWorkflow[];
  examples: AgentRequestExample[];
  endpointIndex: Array<ApiReferenceEndpoint & { groupId: string; groupTitle: string }>;
}

export type GatewayWebhookEvent = WebhookEvent;

export interface WebhookVerificationResult {
  valid: boolean;
  expectedSignature: string;
  providedSignature: string | null;
}

export interface DeviceListEntry extends DeviceInfo {
  status: DeviceStatusData | null;
}

export type AdminDeviceEntry = {
  deviceId: string;
  name: string;
  phone: string | null;
  status: DeviceStatusData['status'];
};

export interface AdminStats {
  devices: {
    total: number;
    byStatus: Record<string, number>;
    byClient: Record<string, AdminDeviceEntry[]>;
  };
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  scheduledQueue?: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  uptime: number;
  load?: LoadSnapshot;
  timestamp: number;
}

export interface ChatsPage {
  items: ChatMetadata[];
  total: number;
  limit: number;
  offset: number;
}

export interface MessageTarget {
  jid?: string;
  phone?: string;
}

export interface SendTextInput extends MessageTarget {
  text: string;
  options?: SendOptions;
}

export interface SendImageInput extends MessageTarget {
  media: MediaSource;
  caption?: string;
  options?: SendOptions;
}

export interface SendVideoInput extends MessageTarget {
  media: MediaSource;
  caption?: string;
  options?: SendOptions;
}

export interface SendAudioInput extends MessageTarget {
  media: MediaSource;
  ptt?: boolean;
  options?: SendOptions;
}

export interface SendDocumentInput extends MessageTarget {
  media: MediaSource;
  fileName?: string;
  mimeType?: string;
  options?: SendOptions;
}

export interface SendLocationInput extends MessageTarget {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface SendReactionInput extends MessageTarget {
  targetMessageId: string;
  emoji: string;
}

export interface BroadcastInput {
  jids: string[];
  text: string;
}

export interface BroadcastResult {
  jid: string;
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface ScheduleTextInput extends MessageTarget {
  text: string;
  sendAt: string | number | Date;
  options?: SendOptions;
}

export interface ChatListOptions {
  kind?: 'individual' | 'group';
  hideUnnamed?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MuteChatInput {
  duration: number;
}

export interface CreateGroupInput {
  subject: string;
  participants: string[];
}

export interface GroupParticipantsInput {
  action: 'add' | 'remove' | 'promote' | 'demote';
  participants: string[];
}

export interface KeyResponse {
  key: string;
  warning: string;
}

export interface SafeClientConfigView {
  webhookUrl?: string;
  webhookApiKey?: string;
  events?: Required<ClientEventsPatch>;
  chats?: Required<ClientChatsPatch>;
  maxDevices?: number;
  key: {
    hasKey: boolean;
    expiresAt?: number;
    lastUsedAt?: number;
    lastUsedIp?: string;
  };
}

export interface ControlPlaneBootstrapInput {
  deviceName: string;
  ttlDays?: number;
  rotateKey?: boolean;
  config?: ClientConfigPatch;
}

export interface ControlPlaneBootstrapResult {
  clientId: string;
  key: KeyResponse;
  device: DeviceInfo;
  config: SafeClientConfigView;
  onboardingPath: string;
}

export interface ControlPlaneOnboardingState {
  clientId: string;
  deviceId: string;
  status: DeviceStatusData;
  qr: string | null;
  config: SafeClientConfigView;
  links: {
    status: string;
    qr: string;
    resetAuth: string;
  };
}

export interface ManagedClientSummary {
  clientId: string;
  metadata: ClientMetadata;
  config: SafeClientConfigView;
  deviceCount: number;
  devices: Array<{ deviceId: string; name: string; phone: string | null; status: DeviceStatusData['status']; ownerInstanceId: string | null }>;
  storage: {
    authBytes: number;
    storageSoftLimitMb: number | null;
  };
  quotas: {
    windowMs: number;
    clientLimit: number;
    deviceLimit: number;
    clientUsed: number;
    devicesUsed: Record<string, number>;
  };
}

export interface ManagedClientDetail extends ManagedClientSummary {
  allowedNumbers: string[];
  bannedNumbers: string[];
}

export interface ManagedInstanceSummary {
  instance: {
    instanceId: string;
    version: string;
    basePath: string;
    profile: string | null;
  };
  totals: {
    clients: number;
    devices: number;
    authStorageBytes: number;
  };
  limits: {
    defaultClientSendsPerWindow: number;
    defaultDeviceSendsPerWindow: number;
    windowMs: number;
  };
}

function summarizeResponseBody(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (!compact) return '<empty body>';
  return compact.slice(0, 200);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function toIsoDate(value: string | number | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeApiBasePath(value: string | undefined): string {
  const raw = value && value.trim().length > 0 ? value.trim() : DEFAULT_API_BASE_PATH;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

function serializeWebhookPayload(payload: string | GatewayWebhookEvent): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

export function createWebhookSignature(secret: string, payload: string | GatewayWebhookEvent): string {
  const digest = createHmac('sha256', secret).update(serializeWebhookPayload(payload)).digest('hex');
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(secret: string, payload: string | GatewayWebhookEvent, signatureHeader: string | null | undefined): WebhookVerificationResult {
  const expectedSignature = createWebhookSignature(secret, payload);
  if (!signatureHeader) {
    return { valid: false, expectedSignature, providedSignature: null };
  }

  const expected = Buffer.from(expectedSignature, 'utf8');
  const provided = Buffer.from(signatureHeader, 'utf8');
  const valid = expected.length === provided.length && timingSafeEqual(expected, provided);
  return { valid, expectedSignature, providedSignature: signatureHeader };
}

export function parseWebhookEvent(payload: string): GatewayWebhookEvent {
  return JSON.parse(payload) as GatewayWebhookEvent;
}

export class WhatsAppGatewayClient {
  private readonly baseUrl: string;
  private readonly apiBasePath: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.apiBasePath = normalizeApiBasePath(options.apiBasePath);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.defaultHeaders = options.headers ?? {};
  }

  async request<T>(path: string, options: GatewayRequestOptions = {}): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }

    const url = `${this.baseUrl}${path}${query.size > 0 ? `?${query.toString()}` : ''}`;
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options.headers,
    };

    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const rawBody = await response.text();
    let payload: GatewayEnvelope<T> | null = null;

    if (rawBody.length > 0) {
      try {
        payload = JSON.parse(rawBody) as GatewayEnvelope<T>;
      } catch {
        throw new Error(`HTTP ${response.status} from ${path}: invalid JSON response (${summarizeResponseBody(rawBody)})`);
      }
    }

    if (!response.ok) {
      if (payload?.error?.message) {
        const code = payload.error.code ?? `HTTP_${response.status}`;
        throw new Error(`${code}: ${payload.error.message}`);
      }
      throw new Error(`HTTP ${response.status} from ${path}: ${summarizeResponseBody(rawBody)}`);
    }

    if (!payload) {
      throw new Error(`HTTP ${response.status} from ${path}: empty response body`);
    }

    if (!payload.success) {
      const code = payload.error?.code ?? 'UNKNOWN_ERROR';
      const message = payload.error?.message ?? `Request failed for ${path}`;
      throw new Error(`${code}: ${message}`);
    }
    return payload.data as T;
  }

  async getApiOverview(): Promise<ApiOverview> {
    return this.request<ApiOverview>(this.apiBasePath);
  }

  async getApiReference(): Promise<ApiReference> {
    return this.request<ApiReference>(`${this.apiBasePath}/reference`);
  }

  async getAgentContext(): Promise<AgentContext> {
    return this.request<AgentContext>(`${this.apiBasePath}/agent`);
  }

  async getOpenApiDocument(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`${this.apiBasePath}/openapi.json`);
  }

  async getStatus(): Promise<LoadSnapshot> {
    return this.request<LoadSnapshot>(`${this.apiBasePath}/status`);
  }

  async getLiveStatus(): Promise<{ live: true; timestamp: number }> {
    return this.request<{ live: true; timestamp: number }>(`${this.apiBasePath}/status/live`);
  }

  async getReadyStatus(): Promise<LoadSnapshot> {
    return this.request<LoadSnapshot>(`${this.apiBasePath}/status/ready`);
  }

  async getClientConfig(clientId: string): Promise<ClientConfig> {
    return this.request<ClientConfig>(`${this.clientPath(clientId)}/config`);
  }

  async updateClientConfig(clientId: string, patch: ClientConfigPatch): Promise<ClientConfig> {
    return this.request<ClientConfig>(`${this.clientPath(clientId)}/config`, { method: 'PUT', body: patch });
  }

  async resetClientConfig(clientId: string): Promise<{ reset: true }> {
    return this.request<{ reset: true }>(`${this.clientPath(clientId)}/config`, { method: 'DELETE' });
  }

  async createClientKey(clientId: string, ttlDays?: number): Promise<KeyResponse> {
    return this.request<KeyResponse>(`${this.clientPath(clientId)}/key`, { method: 'POST', body: ttlDays === undefined ? {} : { ttlDays } });
  }

  async bootstrapTenant(clientId: string, input: ControlPlaneBootstrapInput): Promise<ControlPlaneBootstrapResult> {
    return this.request<ControlPlaneBootstrapResult>(`${this.controlPlanePath()}/clients/${encodePathSegment(clientId)}/bootstrap`, { method: 'POST', body: input });
  }

  async getManagedInstance(): Promise<ManagedInstanceSummary> {
    return this.request<ManagedInstanceSummary>(`${this.controlPlanePath()}/instance`);
  }

  async listManagedClients(): Promise<ManagedClientSummary[]> {
    return this.request<ManagedClientSummary[]>(`${this.controlPlanePath()}/clients`);
  }

  async getManagedClient(clientId: string): Promise<ManagedClientDetail> {
    return this.request<ManagedClientDetail>(`${this.controlPlanePath()}/clients/${encodePathSegment(clientId)}`);
  }

  async updateManagedClientMetadata(clientId: string, patch: Record<string, unknown>): Promise<ManagedClientDetail> {
    return this.request<ManagedClientDetail>(`${this.controlPlanePath()}/clients/${encodePathSegment(clientId)}/metadata`, { method: 'PUT', body: patch });
  }

  async deleteManagedClient(clientId: string): Promise<{ deleted: true; removedDevices: number }> {
    return this.request<{ deleted: true; removedDevices: number }>(`${this.controlPlanePath()}/clients/${encodePathSegment(clientId)}`, { method: 'DELETE' });
  }

  async getOnboardingState(clientId: string, deviceId: string): Promise<ControlPlaneOnboardingState> {
    return this.request<ControlPlaneOnboardingState>(`${this.controlPlanePath()}/clients/${encodePathSegment(clientId)}/devices/${encodePathSegment(deviceId)}/onboarding`);
  }

  async reissueOnboardingQr(clientId: string, deviceId: string): Promise<{ message: string; onboardingPath: string }> {
    return this.request<{ message: string; onboardingPath: string }>(`${this.controlPlanePath()}/clients/${encodePathSegment(clientId)}/devices/${encodePathSegment(deviceId)}/reissue-qr`, { method: 'POST' });
  }

  async rotateClientKey(clientId: string, ttlDays?: number): Promise<KeyResponse> {
    return this.request<KeyResponse>(`${this.clientPath(clientId)}/key/rotate`, { method: 'POST', body: ttlDays === undefined ? {} : { ttlDays } });
  }

  async revokeClientKey(clientId: string): Promise<{ revoked: true }> {
    return this.request<{ revoked: true }>(`${this.clientPath(clientId)}/key`, { method: 'DELETE' });
  }

  async listDevices(clientId: string): Promise<DeviceListEntry[]> {
    return this.request<DeviceListEntry[]>(`${this.clientPath(clientId)}/devices`);
  }

  async createDevice(clientId: string, name: string): Promise<DeviceInfo> {
    return this.request<DeviceInfo>(`${this.clientPath(clientId)}/devices`, { method: 'POST', body: { name } });
  }

  async deleteDevice(clientId: string, deviceId: string): Promise<{ deleted: true }> {
    return this.request<{ deleted: true }>(this.devicePath(clientId, deviceId), { method: 'DELETE' });
  }

  async getDeviceStatus(clientId: string, deviceId: string): Promise<DeviceStatusData> {
    return this.request<DeviceStatusData>(`${this.devicePath(clientId, deviceId)}/status`);
  }

  async getDeviceQr(clientId: string, deviceId: string): Promise<{ qr: string | null; message?: string }> {
    return this.request<{ qr: string | null; message?: string }>(`${this.devicePath(clientId, deviceId)}/auth/qr`);
  }

  async resetDeviceAuth(clientId: string, deviceId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`${this.devicePath(clientId, deviceId)}/auth/reset`, { method: 'POST' });
  }

  async disconnectDevice(clientId: string, deviceId: string): Promise<{ disconnected: true }> {
    return this.request<{ disconnected: true }>(`${this.devicePath(clientId, deviceId)}/disconnect`, { method: 'POST' });
  }

  async reconnectDevice(clientId: string, deviceId: string): Promise<{ reconnecting: true }> {
    return this.request<{ reconnecting: true }>(`${this.devicePath(clientId, deviceId)}/reconnect`, { method: 'POST' });
  }

  async flushDeviceCache(clientId: string, deviceId: string): Promise<{ flushed: true; message: string }> {
    return this.request<{ flushed: true; message: string }>(`${this.devicePath(clientId, deviceId)}/cache/flush`, { method: 'POST' });
  }

  async getOwnProfile(clientId: string, deviceId: string): Promise<OwnProfile> {
    return this.request<OwnProfile>(`${this.devicePath(clientId, deviceId)}/profile`);
  }

  async updateProfileName(clientId: string, deviceId: string, name: string): Promise<{ updated: true }> {
    return this.request<{ updated: true }>(`${this.devicePath(clientId, deviceId)}/profile/name`, { method: 'PUT', body: { name } });
  }

  async updateProfileStatus(clientId: string, deviceId: string, status: string): Promise<{ updated: true }> {
    return this.request<{ updated: true }>(`${this.devicePath(clientId, deviceId)}/profile/status`, { method: 'PUT', body: { status } });
  }

  async sendPresence(clientId: string, deviceId: string, presence: PresenceType, toJid?: string): Promise<{ sent: true }> {
    return this.request<{ sent: true }>(`${this.devicePath(clientId, deviceId)}/presence`, { method: 'POST', body: { presence, toJid } });
  }

  async sendText(clientId: string, deviceId: string, input: SendTextInput): Promise<SentMessage> {
    return this.request<SentMessage>(`${this.devicePath(clientId, deviceId)}/messages/send-text`, { method: 'POST', body: input });
  }

  async sendImage(clientId: string, deviceId: string, input: SendImageInput): Promise<SentMessage> {
    return this.request<SentMessage>(`${this.devicePath(clientId, deviceId)}/messages/send-image`, { method: 'POST', body: input });
  }

  async sendVideo(clientId: string, deviceId: string, input: SendVideoInput): Promise<SentMessage> {
    return this.request<SentMessage>(`${this.devicePath(clientId, deviceId)}/messages/send-video`, { method: 'POST', body: input });
  }

  async sendAudio(clientId: string, deviceId: string, input: SendAudioInput): Promise<SentMessage> {
    return this.request<SentMessage>(`${this.devicePath(clientId, deviceId)}/messages/send-audio`, { method: 'POST', body: input });
  }

  async sendDocument(clientId: string, deviceId: string, input: SendDocumentInput): Promise<SentMessage> {
    return this.request<SentMessage>(`${this.devicePath(clientId, deviceId)}/messages/send-document`, { method: 'POST', body: input });
  }

  async sendLocation(clientId: string, deviceId: string, input: SendLocationInput): Promise<SentMessage> {
    return this.request<SentMessage>(`${this.devicePath(clientId, deviceId)}/messages/send-location`, { method: 'POST', body: input });
  }

  async sendReaction(clientId: string, deviceId: string, input: SendReactionInput): Promise<{ sent: true }> {
    return this.request<{ sent: true }>(`${this.devicePath(clientId, deviceId)}/messages/send-reaction`, { method: 'POST', body: input });
  }

  async deleteMessage(clientId: string, deviceId: string, messageId: string, target: MessageTarget & { forEveryone?: boolean }): Promise<{ deleted: true }> {
    return this.request<{ deleted: true }>(`${this.devicePath(clientId, deviceId)}/messages/${encodePathSegment(messageId)}`, {
      method: 'DELETE',
      query: {
        jid: target.jid,
        phone: target.phone,
        forEveryone: target.forEveryone,
      },
    });
  }

  async broadcastText(clientId: string, deviceId: string, input: BroadcastInput): Promise<BroadcastResult[]> {
    return this.request<BroadcastResult[]>(`${this.devicePath(clientId, deviceId)}/messages/broadcast`, { method: 'POST', body: input });
  }

  async sendLegacyText(clientId: string, deviceId: string, input: MessageTarget & { text: string; quotedId?: string }): Promise<{ msgId: string }> {
    return this.request<{ msgId: string }>(`${this.devicePath(clientId, deviceId)}/send`, { method: 'POST', body: input });
  }

  async scheduleText(clientId: string, deviceId: string, input: ScheduleTextInput): Promise<ScheduledTextMessage> {
    return this.request<ScheduledTextMessage>(`${this.devicePath(clientId, deviceId)}/messages/schedule-text`, {
      method: 'POST',
      body: {
        ...input,
        sendAt: toIsoDate(input.sendAt),
      },
    });
  }

  async listScheduledMessages(clientId: string, deviceId: string, status?: ScheduledMessageStatus): Promise<ScheduledTextMessage[]> {
    return this.request<ScheduledTextMessage[]>(`${this.devicePath(clientId, deviceId)}/messages/scheduled`, { query: { status } });
  }

  async getScheduledMessage(clientId: string, deviceId: string, scheduleId: string): Promise<ScheduledTextMessage> {
    return this.request<ScheduledTextMessage>(`${this.devicePath(clientId, deviceId)}/messages/scheduled/${encodePathSegment(scheduleId)}`);
  }

  async rescheduleMessage(clientId: string, deviceId: string, scheduleId: string, sendAt: string | number | Date): Promise<ScheduledTextMessage> {
    return this.request<ScheduledTextMessage>(`${this.devicePath(clientId, deviceId)}/messages/scheduled/${encodePathSegment(scheduleId)}/reschedule`, {
      method: 'POST',
      body: { sendAt: toIsoDate(sendAt) },
    });
  }

  async cancelScheduledMessage(clientId: string, deviceId: string, scheduleId: string): Promise<ScheduledTextMessage> {
    return this.request<ScheduledTextMessage>(`${this.devicePath(clientId, deviceId)}/messages/scheduled/${encodePathSegment(scheduleId)}`, { method: 'DELETE' });
  }

  async checkPhone(clientId: string, deviceId: string, phone: string): Promise<PhoneCheckResult> {
    return this.request<PhoneCheckResult>(`${this.devicePath(clientId, deviceId)}/contacts/check`, { query: { phone } });
  }

  async checkPhones(clientId: string, deviceId: string, phones: string[]): Promise<PhoneCheckResult[]> {
    return this.request<PhoneCheckResult[]>(`${this.devicePath(clientId, deviceId)}/contacts/check-bulk`, { method: 'POST', body: { phones } });
  }

  async getBlockedContacts(clientId: string, deviceId: string): Promise<string[]> {
    return this.request<string[]>(`${this.devicePath(clientId, deviceId)}/contacts/blocklist`);
  }

  async getProfilePicture(clientId: string, deviceId: string, jid: string): Promise<{ url: string | null }> {
    return this.request<{ url: string | null }>(`${this.devicePath(clientId, deviceId)}/contacts/${encodePathSegment(jid)}/profile-picture`);
  }

  async getContactStatus(clientId: string, deviceId: string, jid: string): Promise<ContactStatusInfo> {
    return this.request<ContactStatusInfo>(`${this.devicePath(clientId, deviceId)}/contacts/${encodePathSegment(jid)}/status`);
  }

  async blockContact(clientId: string, deviceId: string, jid: string): Promise<{ blocked: true }> {
    return this.request<{ blocked: true }>(`${this.devicePath(clientId, deviceId)}/contacts/${encodePathSegment(jid)}/block`, { method: 'POST' });
  }

  async unblockContact(clientId: string, deviceId: string, jid: string): Promise<{ unblocked: true }> {
    return this.request<{ unblocked: true }>(`${this.devicePath(clientId, deviceId)}/contacts/${encodePathSegment(jid)}/block`, { method: 'DELETE' });
  }

  async resolveLids(clientId: string, deviceId: string, jids: string[]): Promise<Record<string, string>> {
    return this.request<Record<string, string>>(`${this.devicePath(clientId, deviceId)}/contacts/resolve-lids`, { method: 'POST', body: { jids } });
  }

  async subscribePresence(clientId: string, deviceId: string, jid: string): Promise<{ subscribed: true }> {
    return this.request<{ subscribed: true }>(`${this.devicePath(clientId, deviceId)}/contacts/${encodePathSegment(jid)}/subscribe-presence`, { method: 'POST' });
  }

  async listChats(clientId: string, deviceId: string, options: ChatListOptions = {}): Promise<ChatsPage> {
    return this.request<ChatsPage>(`${this.devicePath(clientId, deviceId)}/chats`, {
      query: {
        kind: options.kind,
        hideUnnamed: options.hideUnnamed,
        q: options.q,
        limit: options.limit,
        offset: options.offset,
      },
    });
  }

  async archiveChat(clientId: string, deviceId: string, jid: string): Promise<{ archived: true }> {
    return this.request<{ archived: true }>(`${this.devicePath(clientId, deviceId)}/chats/${encodePathSegment(jid)}/archive`, { method: 'POST' });
  }

  async unarchiveChat(clientId: string, deviceId: string, jid: string): Promise<{ archived: false }> {
    return this.request<{ archived: false }>(`${this.devicePath(clientId, deviceId)}/chats/${encodePathSegment(jid)}/archive`, { method: 'DELETE' });
  }

  async muteChat(clientId: string, deviceId: string, jid: string, input: MuteChatInput): Promise<{ muted: boolean; duration: number }> {
    return this.request<{ muted: boolean; duration: number }>(`${this.devicePath(clientId, deviceId)}/chats/${encodePathSegment(jid)}/mute`, { method: 'POST', body: input });
  }

  async unmuteChat(clientId: string, deviceId: string, jid: string): Promise<{ muted: false }> {
    return this.request<{ muted: false }>(`${this.devicePath(clientId, deviceId)}/chats/${encodePathSegment(jid)}/mute`, { method: 'DELETE' });
  }

  async pinChat(clientId: string, deviceId: string, jid: string): Promise<{ pinned: true }> {
    return this.request<{ pinned: true }>(`${this.devicePath(clientId, deviceId)}/chats/${encodePathSegment(jid)}/pin`, { method: 'POST' });
  }

  async unpinChat(clientId: string, deviceId: string, jid: string): Promise<{ pinned: false }> {
    return this.request<{ pinned: false }>(`${this.devicePath(clientId, deviceId)}/chats/${encodePathSegment(jid)}/pin`, { method: 'DELETE' });
  }

  async markChatRead(clientId: string, deviceId: string, jid: string): Promise<{ read: true }> {
    return this.request<{ read: true }>(`${this.devicePath(clientId, deviceId)}/chats/${encodePathSegment(jid)}/read`, { method: 'POST' });
  }

  async deleteChat(clientId: string, deviceId: string, jid: string): Promise<{ deleted: true }> {
    return this.request<{ deleted: true }>(`${this.devicePath(clientId, deviceId)}/chats/${encodePathSegment(jid)}`, { method: 'DELETE' });
  }

  async setChatEphemeral(clientId: string, deviceId: string, jid: string, expiration: 0 | 86400 | 604800 | 7776000): Promise<{ expiration: number }> {
    return this.request<{ expiration: number }>(`${this.devicePath(clientId, deviceId)}/chats/${encodePathSegment(jid)}/ephemeral`, { method: 'PUT', body: { expiration } });
  }

  async listSubscribedGroups(clientId: string, deviceId: string): Promise<string[]> {
    return this.request<string[]>(`${this.devicePath(clientId, deviceId)}/groups/subscribed`);
  }

  async subscribeGroup(clientId: string, deviceId: string, jid: string): Promise<{ subscribed: true }> {
    return this.request<{ subscribed: true }>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/subscribe`, { method: 'POST' });
  }

  async unsubscribeGroup(clientId: string, deviceId: string, jid: string): Promise<{ subscribed: false }> {
    return this.request<{ subscribed: false }>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/subscribe`, { method: 'DELETE' });
  }

  async getGroupMetadata(clientId: string, deviceId: string, jid: string): Promise<GroupMetadata> {
    return this.request<GroupMetadata>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/metadata`);
  }

  async getGroupMembers(clientId: string, deviceId: string, jid: string): Promise<GroupMetadata['participants']> {
    return this.request<GroupMetadata['participants']>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/members`);
  }

  async createGroup(clientId: string, deviceId: string, input: CreateGroupInput): Promise<GroupCreatedResult> {
    return this.request<GroupCreatedResult>(`${this.devicePath(clientId, deviceId)}/groups`, { method: 'POST', body: input });
  }

  async updateGroupSubject(clientId: string, deviceId: string, jid: string, subject: string): Promise<{ updated: true }> {
    return this.request<{ updated: true }>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/subject`, { method: 'PUT', body: { subject } });
  }

  async updateGroupDescription(clientId: string, deviceId: string, jid: string, description: string): Promise<{ updated: true }> {
    return this.request<{ updated: true }>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/description`, { method: 'PUT', body: { description } });
  }

  async updateGroupParticipants(clientId: string, deviceId: string, jid: string, input: GroupParticipantsInput): Promise<ParticipantActionResult[]> {
    return this.request<ParticipantActionResult[]>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/participants`, { method: 'PUT', body: input });
  }

  async updateGroupSetting(clientId: string, deviceId: string, jid: string, setting: GroupSetting): Promise<{ updated: true }> {
    return this.request<{ updated: true }>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/settings`, { method: 'PUT', body: { setting } });
  }

  async leaveGroup(clientId: string, deviceId: string, jid: string): Promise<{ left: true }> {
    return this.request<{ left: true }>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/leave`, { method: 'POST' });
  }

  async getGroupInviteCode(clientId: string, deviceId: string, jid: string): Promise<{ inviteCode: string; inviteLink: string }> {
    return this.request<{ inviteCode: string; inviteLink: string }>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/invite-code`);
  }

  async revokeGroupInviteCode(clientId: string, deviceId: string, jid: string): Promise<{ inviteCode: string; inviteLink: string }> {
    return this.request<{ inviteCode: string; inviteLink: string }>(`${this.devicePath(clientId, deviceId)}/groups/${encodePathSegment(jid)}/invite-code/revoke`, { method: 'POST' });
  }

  async joinGroup(clientId: string, deviceId: string, inviteCode: string): Promise<{ jid: string }> {
    return this.request<{ jid: string }>(`${this.devicePath(clientId, deviceId)}/groups/join`, { method: 'POST', body: { inviteCode } });
  }

  async listBannedNumbers(clientId: string): Promise<string[]> {
    return this.request<string[]>(`${this.clientPath(clientId)}/banned-numbers`);
  }

  async addBannedNumber(clientId: string, phone: string): Promise<{ phone: string; banned: true }> {
    return this.request<{ phone: string; banned: true }>(`${this.clientPath(clientId)}/banned-numbers`, { method: 'POST', body: { phone } });
  }

  async removeBannedNumber(clientId: string, phone: string): Promise<{ phone: string; banned: false }> {
    return this.request<{ phone: string; banned: false }>(`${this.clientPath(clientId)}/banned-numbers/${encodePathSegment(phone)}`, { method: 'DELETE' });
  }

  async listAllowedNumbers(clientId: string): Promise<string[]> {
    return this.request<string[]>(`${this.clientPath(clientId)}/allowed-numbers`);
  }

  async addAllowedNumber(clientId: string, phone: string): Promise<{ phone: string; allowed: true }> {
    return this.request<{ phone: string; allowed: true }>(`${this.clientPath(clientId)}/allowed-numbers`, { method: 'POST', body: { phone } });
  }

  async removeAllowedNumber(clientId: string, phone: string): Promise<{ phone: string; allowed: false }> {
    return this.request<{ phone: string; allowed: false }>(`${this.clientPath(clientId)}/allowed-numbers/${encodePathSegment(phone)}`, { method: 'DELETE' });
  }

  async getAdminStats(): Promise<AdminStats> {
    return this.request<AdminStats>(`${this.apiBasePath}/admin/stats`);
  }

  async getAdminAudit(limit?: number): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>(`${this.apiBasePath}/admin/audit`, { query: { limit } });
  }

  async getAdminRuntime(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`${this.apiBasePath}/admin/runtime`);
  }

  private clientPath(clientId: string): string {
    return `${this.apiBasePath}/clients/${encodePathSegment(clientId)}`;
  }

  private controlPlanePath(): string {
    return `${this.apiBasePath}/control-plane`;
  }

  private devicePath(clientId: string, deviceId: string): string {
    return `${this.clientPath(clientId)}/devices/${encodePathSegment(deviceId)}`;
  }
}

export default WhatsAppGatewayClient;
