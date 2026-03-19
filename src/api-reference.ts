import type { ModuleFlags } from './modules';

export const LEGACY_API_BASE = '/api';
export const VERSIONED_API_BASE = '/api/v1';

export type ApiAuthMode =
  | 'public'
  | 'master-key'
  | 'client-key-or-master-key'
  | 'admin-session-or-master-key';

export type ApiScope = 'system' | 'client' | 'device' | 'admin';
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ApiEndpoint {
  method: ApiMethod;
  path: string;
  summary: string;
  auth: ApiAuthMode;
  scope: ApiScope;
  description?: string;
  query?: string[];
  body?: string[];
  legacy?: boolean;
}

export interface ApiGroup {
  id: string;
  title: string;
  description: string;
  scope: ApiScope;
  requiresModule?: keyof ModuleFlags;
  endpoints: ApiEndpoint[];
}

export interface ApiReferenceDocument {
  service: {
    name: string;
    packageName: string;
    basePath: string;
    preferredBasePath: string;
    legacyBasePath: string;
  };
  links: {
    overview: string;
    reference: string;
    openapi: string;
    docs: string;
    legacyOverview: string;
  };
  auth: Array<{ mode: ApiAuthMode; description: string }>;
  totals: {
    groups: number;
    endpoints: number;
  };
  groups: ApiGroup[];
}

interface OpenApiSchema {
  type?: string;
  description?: string;
  enum?: string[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  components: {
    securitySchemes: Record<string, { type: string; in: string; name: string; description: string }>;
    schemas: Record<string, OpenApiSchema>;
  };
  security?: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, unknown>>;
}

const AUTH_DESCRIPTIONS: ApiReferenceDocument['auth'] = [
  { mode: 'public', description: 'No API key required.' },
  { mode: 'master-key', description: 'Requires the service master key in the x-api-key header.' },
  { mode: 'client-key-or-master-key', description: 'Accepts either the master key or the client-specific key for the target client scope.' },
  { mode: 'admin-session-or-master-key', description: 'Accepts either a valid admin session cookie or the master key.' },
];

const GROUPS: ApiGroup[] = [
  {
    id: 'service-status',
    title: 'Service Status',
    description: 'Runtime health, readiness, discovery, and contract export endpoints.',
    scope: 'system',
    endpoints: [
      { method: 'GET', path: '/api', summary: 'Get API overview and discovery links', auth: 'public', scope: 'system' },
      { method: 'GET', path: '/api/reference', summary: 'Get the machine-readable API reference', auth: 'public', scope: 'system' },
      { method: 'GET', path: '/api/openapi.json', summary: 'Download the OpenAPI 3.1 document', auth: 'public', scope: 'system' },
      { method: 'GET', path: '/api/status', summary: 'Get detailed runtime health snapshot', auth: 'public', scope: 'system' },
      { method: 'GET', path: '/api/status/live', summary: 'Liveness probe', auth: 'public', scope: 'system' },
      { method: 'GET', path: '/api/status/ready', summary: 'Readiness probe', auth: 'public', scope: 'system' },
      { method: 'GET', path: '/', summary: 'Open the generated HTML API reference', auth: 'public', scope: 'system' },
    ],
  },
  {
    id: 'client-configuration',
    title: 'Client Configuration',
    description: 'Tenant-level configuration and client API key lifecycle.',
    scope: 'client',
    endpoints: [
      { method: 'GET', path: '/api/clients/:clientId/config', summary: 'Read client configuration', auth: 'client-key-or-master-key', scope: 'client' },
      { method: 'PUT', path: '/api/clients/:clientId/config', summary: 'Patch client configuration', auth: 'master-key', scope: 'client', body: ['webhookUrl?: string | null', 'webhookApiKey?: string | null', 'events?: partial event toggles', 'chats?: partial chat defaults', 'maxDevices?: number'] },
      { method: 'DELETE', path: '/api/clients/:clientId/config', summary: 'Reset client configuration to defaults', auth: 'master-key', scope: 'client' },
      { method: 'POST', path: '/api/clients/:clientId/key', summary: 'Issue a new client API key', auth: 'master-key', scope: 'client', body: ['ttlDays?: number'] },
      { method: 'POST', path: '/api/clients/:clientId/key/rotate', summary: 'Rotate the current client API key', auth: 'client-key-or-master-key', scope: 'client', body: ['ttlDays?: number'] },
      { method: 'DELETE', path: '/api/clients/:clientId/key', summary: 'Revoke the active client API key', auth: 'master-key', scope: 'client' },
    ],
  },
  {
    id: 'devices',
    title: 'Devices',
    description: 'Device registration, connection lifecycle, profile, and presence.',
    scope: 'device',
    endpoints: [
      { method: 'GET', path: '/api/clients/:clientId/devices', summary: 'List devices for a client', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices', summary: 'Create a device', auth: 'master-key', scope: 'device', body: ['name: string'] },
      { method: 'DELETE', path: '/api/clients/:clientId/devices/:deviceId', summary: 'Delete a device', auth: 'master-key', scope: 'device' },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/status', summary: 'Get device status', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/auth/qr', summary: 'Get the current QR code', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/auth/reset', summary: 'Reset device auth state', auth: 'master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/disconnect', summary: 'Disconnect a device', auth: 'master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/reconnect', summary: 'Reconnect a device', auth: 'master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/cache/flush', summary: 'Flush cached chat state', auth: 'master-key', scope: 'device' },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/profile', summary: 'Get the device WhatsApp profile', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'PUT', path: '/api/clients/:clientId/devices/:deviceId/profile/name', summary: 'Update profile display name', auth: 'client-key-or-master-key', scope: 'device', body: ['name: string'] },
      { method: 'PUT', path: '/api/clients/:clientId/devices/:deviceId/profile/status', summary: 'Update profile status text', auth: 'client-key-or-master-key', scope: 'device', body: ['status: string'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/presence', summary: 'Send a presence update', auth: 'client-key-or-master-key', scope: 'device', body: ['presence: available | unavailable | composing | recording | paused', 'toJid?: string'] },
    ],
  },
  {
    id: 'messages',
    title: 'Messages',
    description: 'Send, delete, broadcast, and optionally schedule outbound messages.',
    scope: 'device',
    endpoints: [
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/send-text', summary: 'Send a text message', auth: 'client-key-or-master-key', scope: 'device', body: ['jid or phone', 'text: string', 'options?: quotedMessageId, mentionedJids'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/send-image', summary: 'Send an image message', auth: 'client-key-or-master-key', scope: 'device', body: ['jid or phone', 'media: { url | base64 }', 'caption?: string', 'options?: SendOptions'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/send-video', summary: 'Send a video message', auth: 'client-key-or-master-key', scope: 'device', body: ['jid or phone', 'media: { url | base64 }', 'caption?: string', 'options?: SendOptions'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/send-audio', summary: 'Send an audio message', auth: 'client-key-or-master-key', scope: 'device', body: ['jid or phone', 'media: { url | base64 }', 'ptt?: boolean', 'options?: SendOptions'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/send-document', summary: 'Send a document message', auth: 'client-key-or-master-key', scope: 'device', body: ['jid or phone', 'media: { url | base64 }', 'fileName?: string', 'mimeType?: string', 'options?: SendOptions'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/send-location', summary: 'Send a location message', auth: 'client-key-or-master-key', scope: 'device', body: ['jid or phone', 'latitude: number', 'longitude: number', 'name?: string', 'address?: string'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/send-reaction', summary: 'React to a message', auth: 'client-key-or-master-key', scope: 'device', body: ['jid or phone', 'targetMessageId: string', 'emoji: string'] },
      { method: 'DELETE', path: '/api/clients/:clientId/devices/:deviceId/messages/:messageId', summary: 'Delete a message', auth: 'client-key-or-master-key', scope: 'device', query: ['jid or phone', 'forEveryone?: boolean'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/broadcast', summary: 'Broadcast a text message to multiple JIDs', auth: 'client-key-or-master-key', scope: 'device', body: ['jids: string[]', 'text: string'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/send', summary: 'Legacy text send endpoint', auth: 'client-key-or-master-key', scope: 'device', body: ['jid or phone', 'text: string', 'quotedId?: string'], legacy: true },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/schedule-text', summary: 'Schedule a text message', auth: 'client-key-or-master-key', scope: 'device', body: ['jid or phone', 'text: string', 'sendAt: ISO date or timestamp', 'options?: SendOptions'] },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/messages/scheduled', summary: 'List scheduled messages', auth: 'client-key-or-master-key', scope: 'device', query: ['status?: SCHEDULED | PROCESSING | SENT | FAILED | CANCELLED'] },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/messages/scheduled/:scheduleId', summary: 'Get a scheduled message', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/messages/scheduled/:scheduleId/reschedule', summary: 'Reschedule a scheduled message', auth: 'client-key-or-master-key', scope: 'device', body: ['sendAt: ISO date or timestamp'] },
      { method: 'DELETE', path: '/api/clients/:clientId/devices/:deviceId/messages/scheduled/:scheduleId', summary: 'Cancel a scheduled message', auth: 'client-key-or-master-key', scope: 'device' },
    ],
  },
  {
    id: 'contacts',
    title: 'Contacts',
    description: 'Contact lookup, profile data, presence subscriptions, and blocking.',
    scope: 'device',
    endpoints: [
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/contacts/check', summary: 'Check if a phone number is on WhatsApp', auth: 'client-key-or-master-key', scope: 'device', query: ['phone: E.164 digits without +'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/contacts/check-bulk', summary: 'Check multiple phone numbers', auth: 'client-key-or-master-key', scope: 'device', body: ['phones: string[]'] },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/contacts/blocklist', summary: 'List blocked contacts', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/contacts/:jid/profile-picture', summary: 'Get a contact profile picture URL', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/contacts/:jid/status', summary: 'Get a contact status text', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/contacts/:jid/block', summary: 'Block a contact', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'DELETE', path: '/api/clients/:clientId/devices/:deviceId/contacts/:jid/block', summary: 'Unblock a contact', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/contacts/resolve-lids', summary: 'Resolve LID JIDs to phone JIDs', auth: 'client-key-or-master-key', scope: 'device', body: ['jids: string[]'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/contacts/:jid/subscribe-presence', summary: 'Subscribe to presence updates for a contact', auth: 'client-key-or-master-key', scope: 'device' },
    ],
  },
  {
    id: 'chats',
    title: 'Chats',
    description: 'Chat listing, archive, mute, pin, read state, deletion, and ephemeral mode.',
    scope: 'device',
    endpoints: [
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/chats', summary: 'List chats with search and pagination', auth: 'client-key-or-master-key', scope: 'device', query: ['kind?: all | individual | group', 'hideUnnamed?: boolean', 'q?: string', 'limit?: number', 'offset?: number'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/chats/:jid/archive', summary: 'Archive a chat', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'DELETE', path: '/api/clients/:clientId/devices/:deviceId/chats/:jid/archive', summary: 'Unarchive a chat', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/chats/:jid/mute', summary: 'Mute a chat', auth: 'client-key-or-master-key', scope: 'device', body: ['duration: seconds, 0 for manual-only'] },
      { method: 'DELETE', path: '/api/clients/:clientId/devices/:deviceId/chats/:jid/mute', summary: 'Unmute a chat', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/chats/:jid/pin', summary: 'Pin a chat', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'DELETE', path: '/api/clients/:clientId/devices/:deviceId/chats/:jid/pin', summary: 'Unpin a chat', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/chats/:jid/read', summary: 'Mark a chat as read', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'DELETE', path: '/api/clients/:clientId/devices/:deviceId/chats/:jid', summary: 'Delete local chat history', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'PUT', path: '/api/clients/:clientId/devices/:deviceId/chats/:jid/ephemeral', summary: 'Set disappearing message duration', auth: 'client-key-or-master-key', scope: 'device', body: ['expiration: 0 | 86400 | 604800 | 7776000'] },
    ],
  },
  {
    id: 'groups',
    title: 'Groups',
    description: 'Group subscriptions, metadata, participant management, settings, and invite flows.',
    scope: 'device',
    endpoints: [
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/groups/subscribed', summary: 'List subscribed groups', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/subscribe', summary: 'Subscribe to a group', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'DELETE', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/subscribe', summary: 'Unsubscribe from a group', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/metadata', summary: 'Get group metadata', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/members', summary: 'List group members', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/groups', summary: 'Create a group', auth: 'client-key-or-master-key', scope: 'device', body: ['subject: string', 'participants: string[]'] },
      { method: 'PUT', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/subject', summary: 'Update group subject', auth: 'client-key-or-master-key', scope: 'device', body: ['subject: string'] },
      { method: 'PUT', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/description', summary: 'Update group description', auth: 'client-key-or-master-key', scope: 'device', body: ['description: string'] },
      { method: 'PUT', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/participants', summary: 'Modify group participants', auth: 'client-key-or-master-key', scope: 'device', body: ['action: add | remove | promote | demote', 'participants: string[]'] },
      { method: 'PUT', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/settings', summary: 'Update group settings', auth: 'client-key-or-master-key', scope: 'device', body: ['setting: announcement | not_announcement | locked | unlocked'] },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/leave', summary: 'Leave a group', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'GET', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/invite-code', summary: 'Get a group invite code', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/groups/:jid/invite-code/revoke', summary: 'Revoke and replace the group invite code', auth: 'client-key-or-master-key', scope: 'device' },
      { method: 'POST', path: '/api/clients/:clientId/devices/:deviceId/groups/join', summary: 'Join a group by invite code', auth: 'client-key-or-master-key', scope: 'device', body: ['inviteCode: string'] },
    ],
  },
  {
    id: 'access-control',
    title: 'Access Control',
    description: 'Per-client allow and deny lists for phone numbers.',
    scope: 'client',
    endpoints: [
      { method: 'GET', path: '/api/clients/:clientId/banned-numbers', summary: 'List banned phone numbers', auth: 'client-key-or-master-key', scope: 'client' },
      { method: 'POST', path: '/api/clients/:clientId/banned-numbers', summary: 'Ban a phone number', auth: 'client-key-or-master-key', scope: 'client', body: ['phone: string'] },
      { method: 'DELETE', path: '/api/clients/:clientId/banned-numbers/:phone', summary: 'Remove a banned phone number', auth: 'client-key-or-master-key', scope: 'client' },
      { method: 'GET', path: '/api/clients/:clientId/allowed-numbers', summary: 'List allowed phone numbers', auth: 'client-key-or-master-key', scope: 'client' },
      { method: 'POST', path: '/api/clients/:clientId/allowed-numbers', summary: 'Allow a phone number', auth: 'client-key-or-master-key', scope: 'client', body: ['phone: string'] },
      { method: 'DELETE', path: '/api/clients/:clientId/allowed-numbers/:phone', summary: 'Remove an allowed phone number', auth: 'client-key-or-master-key', scope: 'client' },
    ],
  },
  {
    id: 'admin',
    title: 'Admin',
    description: 'Operational dashboard, runtime information, and audit visibility.',
    scope: 'admin',
    requiresModule: 'admin',
    endpoints: [
      { method: 'POST', path: '/api/admin/login', summary: 'Start an admin session', auth: 'public', scope: 'admin', body: ['username: string', 'password: string'] },
      { method: 'POST', path: '/api/admin/logout', summary: 'End the current admin session', auth: 'admin-session-or-master-key', scope: 'admin' },
      { method: 'GET', path: '/api/admin/stats', summary: 'Get admin dashboard stats', auth: 'admin-session-or-master-key', scope: 'admin' },
      { method: 'GET', path: '/api/admin/audit', summary: 'List audit log entries', auth: 'admin-session-or-master-key', scope: 'admin', query: ['limit?: number'] },
      { method: 'GET', path: '/api/admin/runtime', summary: 'Inspect runtime configuration and feature flags', auth: 'admin-session-or-master-key', scope: 'admin' },
      { method: 'GET', path: '/admin', summary: 'Open the HTML admin dashboard', auth: 'public', scope: 'admin' },
    ],
  },
];

function remapPath(path: string, basePath: string): string {
  if (!path.startsWith(LEGACY_API_BASE)) return path;
  return `${basePath}${path.slice(LEGACY_API_BASE.length)}`;
}

function filterEndpoints(group: ApiGroup, modules: ModuleFlags, basePath: string): ApiEndpoint[] {
  const filtered = group.endpoints
    .filter((endpoint) => group.id !== 'messages' || modules.scheduling || (!endpoint.path.includes('/messages/scheduled') && !endpoint.path.endsWith('/messages/schedule-text')))
    .map((endpoint) => ({
      ...endpoint,
      path: remapPath(endpoint.path, basePath),
    }));

  return filtered;
}

function buildReference(modules: ModuleFlags, basePath: string, preferredBasePath: string): ApiReferenceDocument {
  const groups = GROUPS
    .filter((group) => !group.requiresModule || modules[group.requiresModule])
    .map((group) => ({
      ...group,
      endpoints: filterEndpoints(group, modules, basePath),
    }));

  const endpoints = groups.reduce((sum, group) => sum + group.endpoints.length, 0);

  return {
    service: {
      name: 'WhatsApp Gateway Service',
      packageName: 'whatsapp-gateway-service',
      basePath,
      preferredBasePath,
      legacyBasePath: LEGACY_API_BASE,
    },
    links: {
      overview: basePath,
      reference: `${basePath}/reference`,
      openapi: `${basePath}/openapi.json`,
      docs: '/',
      legacyOverview: LEGACY_API_BASE,
    },
    auth: AUTH_DESCRIPTIONS,
    totals: {
      groups: groups.length,
      endpoints,
    },
    groups,
  };
}

export function getApiReference(modules: ModuleFlags, basePath = VERSIONED_API_BASE, preferredBasePath = VERSIONED_API_BASE): ApiReferenceDocument {
  return buildReference(modules, basePath, preferredBasePath);
}

export function getApiOverview(modules: ModuleFlags, basePath = VERSIONED_API_BASE, preferredBasePath = VERSIONED_API_BASE): Record<string, unknown> {
  const reference = buildReference(modules, basePath, preferredBasePath);
  return {
    service: reference.service,
    links: reference.links,
    totals: reference.totals,
    auth: reference.auth,
    groups: reference.groups.map((group) => ({
      id: group.id,
      title: group.title,
      description: group.description,
      scope: group.scope,
      endpoints: group.endpoints.length,
    })),
  };
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function extractPathParameters(path: string): string[] {
  return Array.from(path.matchAll(/:([A-Za-z0-9_]+)/g), (match) => match[1]);
}

function toSecurity(auth: ApiAuthMode): Array<Record<string, string[]>> | undefined {
  if (auth === 'public') return undefined;
  if (auth === 'admin-session-or-master-key') return [{ ApiKeyAuth: [] }, { AdminSessionCookie: [] }];
  return [{ ApiKeyAuth: [] }];
}

function inferSchema(description: string): OpenApiSchema {
  if (description.includes('string[]') || description.includes('JIDs')) {
    return { type: 'array', items: { type: 'string' }, description };
  }
  if (description.includes('boolean')) {
    return { type: 'boolean', description };
  }
  if (description.includes('number') || description.includes('timestamp') || description.includes('seconds')) {
    return { type: 'number', description };
  }
  if (description.includes('available | unavailable | composing | recording | paused')) {
    return {
      type: 'string',
      enum: ['available', 'unavailable', 'composing', 'recording', 'paused'],
      description,
    };
  }
  return { type: 'string', description };
}

function parseFieldName(description: string, fallback: string): string {
  const match = description.match(/^([A-Za-z0-9_]+)\??:/);
  if (match) return match[1];
  return fallback;
}

function buildRequestBody(body: string[] | undefined): Record<string, unknown> | undefined {
  if (!body || body.length === 0) return undefined;
  const properties: Record<string, OpenApiSchema> = {};
  const required: string[] = [];

  body.forEach((description, index) => {
    const fieldName = parseFieldName(description, `field${index + 1}`);
    properties[fieldName] = inferSchema(description);
    if (!description.includes('?')) required.push(fieldName);
  });

  return {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties,
          additionalProperties: true,
          ...(required.length > 0 ? { required } : {}),
        },
      },
    },
  };
}

function buildParameters(endpoint: ApiEndpoint): Array<Record<string, unknown>> {
  const parameters: Array<Record<string, unknown>> = [];

  for (const param of extractPathParameters(endpoint.path)) {
    parameters.push({
      name: param,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  }

  for (const description of endpoint.query ?? []) {
    const name = parseFieldName(description, description.split(' ')[0].replace(/[^A-Za-z0-9_]/g, '') || 'query');
    parameters.push({
      name,
      in: 'query',
      required: !description.includes('?'),
      schema: inferSchema(description),
      description,
    });
  }

  return parameters;
}

export function getOpenApiDocument(modules: ModuleFlags, basePath = VERSIONED_API_BASE, preferredBasePath = VERSIONED_API_BASE): OpenApiDocument {
  const reference = buildReference(modules, basePath, preferredBasePath);
  const paths: OpenApiDocument['paths'] = {};

  for (const group of reference.groups) {
    for (const endpoint of group.endpoints) {
      if (!endpoint.path.startsWith(basePath)) continue;
      const openApiPath = toOpenApiPath(endpoint.path);
      const methodKey = endpoint.method.toLowerCase();
      const pathItem = paths[openApiPath] ?? {};
      pathItem[methodKey] = {
        tags: [group.title],
        summary: endpoint.summary,
        description: endpoint.description,
        deprecated: endpoint.legacy ?? false,
        security: toSecurity(endpoint.auth),
        parameters: buildParameters(endpoint),
        requestBody: buildRequestBody(endpoint.body),
        responses: {
          200: {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiEnvelope' },
              },
            },
          },
          400: { description: 'Validation error' },
          401: { description: 'Unauthorized' },
          429: { description: 'Rate limited' },
          500: { description: 'Internal error' },
        },
      };
      paths[openApiPath] = pathItem;
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'WhatsApp Gateway Service API',
      version: '1.0.0',
      description: `Versioned WhatsApp gateway contract. Preferred base path is ${preferredBasePath}; ${LEGACY_API_BASE} remains available for compatibility.`,
    },
    servers: [{ url: '/', description: 'Service root' }],
    tags: reference.groups.map((group) => ({ name: group.title, description: group.description })),
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'Master or client API key, depending on the endpoint.',
        },
        AdminSessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'wga_admin',
          description: 'Admin session cookie for dashboard and admin JSON APIs.',
        },
      },
      schemas: {
        ApiEnvelope: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            timestamp: { type: 'number' },
            data: { type: 'object', additionalProperties: true },
            error: { type: 'object', additionalProperties: true },
          },
          additionalProperties: true,
        },
      },
    },
    paths,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderList(title: string, values?: string[]): string {
  if (!values || values.length === 0) return '';
  return `<div class="meta"><strong>${escapeHtml(title)}:</strong> ${values.map(escapeHtml).join(', ')}</div>`;
}

export function renderApiDocsHtml(modules: ModuleFlags, basePath = VERSIONED_API_BASE, preferredBasePath = VERSIONED_API_BASE): string {
  const reference = buildReference(modules, basePath, preferredBasePath);
  const nav = reference.groups
    .map((group) => `<a class="nav-link" href="#${escapeHtml(group.id)}">${escapeHtml(group.title)} <span>${group.endpoints.length}</span></a>`)
    .join('');

  const sections = reference.groups
    .map((group) => {
      const rows = group.endpoints
        .map((endpoint) => `
          <article class="endpoint">
            <div class="endpoint-top">
              <span class="method method-${endpoint.method.toLowerCase()}">${endpoint.method}</span>
              <code>${escapeHtml(endpoint.path)}</code>
            </div>
            <h3>${escapeHtml(endpoint.summary)}</h3>
            ${endpoint.description ? `<p>${escapeHtml(endpoint.description)}</p>` : ''}
            <div class="meta"><strong>Auth:</strong> ${escapeHtml(endpoint.auth)}</div>
            ${renderList('Query', endpoint.query)}
            ${renderList('Body', endpoint.body)}
            ${endpoint.legacy ? '<div class="legacy">Legacy compatibility endpoint</div>' : ''}
          </article>
        `)
        .join('');

      return `
        <section id="${escapeHtml(group.id)}" class="group">
          <div class="group-head">
            <div>
              <div class="eyebrow">${escapeHtml(group.scope)}</div>
              <h2>${escapeHtml(group.title)}</h2>
              <p>${escapeHtml(group.description)}</p>
            </div>
            <div class="count">${group.endpoints.length} endpoints</div>
          </div>
          <div class="endpoint-grid">${rows}</div>
        </section>
      `;
    })
    .join('');

  const authRows = reference.auth
    .map((item) => `<li><code>${escapeHtml(item.mode)}</code> ${escapeHtml(item.description)}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Gateway Service API</title>
<style>
  :root {
    --bg: #f5efe4;
    --panel: rgba(255, 251, 245, 0.88);
    --panel-strong: #fffaf2;
    --border: rgba(79, 53, 34, 0.12);
    --text: #1f1a17;
    --muted: #69594d;
    --accent: #0f766e;
    --accent-soft: rgba(15, 118, 110, 0.08);
    --green: #166534;
    --blue: #1d4ed8;
    --orange: #c2410c;
    --red: #b91c1c;
    --shadow: 0 24px 60px rgba(89, 66, 42, 0.12);
    font-family: Georgia, 'Times New Roman', serif;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    color: var(--text);
    background:
      radial-gradient(circle at top left, rgba(15, 118, 110, 0.14), transparent 28%),
      radial-gradient(circle at top right, rgba(194, 65, 12, 0.16), transparent 24%),
      linear-gradient(180deg, #fbf5ea 0%, #f4ebdd 100%);
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: 'Cascadia Code', Consolas, monospace;
    background: rgba(31, 26, 23, 0.06);
    padding: 0.18rem 0.42rem;
    border-radius: 999px;
    font-size: 0.85rem;
  }
  .layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100vh; }
  .sidebar {
    position: sticky; top: 0; height: 100vh; padding: 28px 22px;
    border-right: 1px solid var(--border); background: rgba(255, 248, 240, 0.78); backdrop-filter: blur(12px);
  }
  .brand { padding-bottom: 18px; border-bottom: 1px solid var(--border); margin-bottom: 18px; }
  .brand h1 { font-size: 1.3rem; line-height: 1.15; margin: 0 0 8px; }
  .brand p, .intro p, .group-head p, .endpoint p { color: var(--muted); }
  .intro { margin-bottom: 18px; font-size: 0.95rem; line-height: 1.6; }
  .nav-link {
    display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; margin-bottom: 6px;
    border-radius: 12px; color: var(--text); background: transparent;
  }
  .nav-link:hover { background: var(--accent-soft); text-decoration: none; }
  .nav-link span { font-size: 0.82rem; color: var(--muted); }
  .content { padding: 40px 42px 56px; }
  .hero { background: var(--panel); border: 1px solid var(--border); border-radius: 28px; padding: 28px; box-shadow: var(--shadow); margin-bottom: 26px; }
  .hero-top { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .hero h2 { margin: 0 0 10px; font-size: 2rem; line-height: 1; }
  .pill-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  .pill { padding: 8px 12px; border-radius: 999px; background: var(--panel-strong); border: 1px solid var(--border); font-size: 0.9rem; }
  .auth-box { margin-top: 20px; padding: 18px 20px; border-radius: 20px; background: rgba(255,255,255,0.52); border: 1px solid var(--border); }
  .auth-box ul { margin: 12px 0 0; padding-left: 20px; line-height: 1.7; }
  .group { margin-top: 24px; }
  .group-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
  .group-head h2 { margin: 4px 0 8px; font-size: 1.5rem; }
  .eyebrow { text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.72rem; color: var(--accent); font-weight: 700; }
  .count { white-space: nowrap; border: 1px solid var(--border); border-radius: 999px; padding: 9px 14px; background: var(--panel-strong); color: var(--muted); }
  .endpoint-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
  .endpoint { background: var(--panel); border: 1px solid var(--border); border-radius: 22px; padding: 18px; box-shadow: var(--shadow); }
  .endpoint h3 { margin: 14px 0 8px; font-size: 1.05rem; }
  .endpoint-top { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .method { display: inline-flex; min-width: 72px; justify-content: center; font-weight: 700; letter-spacing: 0.08em; font-size: 0.75rem; padding: 7px 10px; border-radius: 999px; color: white; }
  .method-get { background: var(--green); }
  .method-post { background: var(--blue); }
  .method-put { background: var(--orange); }
  .method-delete { background: var(--red); }
  .meta { margin-top: 8px; color: var(--muted); line-height: 1.55; font-size: 0.95rem; }
  .legacy { margin-top: 10px; font-size: 0.82rem; color: var(--orange); font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
  @media (max-width: 980px) {
    .layout { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
    .content { padding: 26px 18px 40px; }
  }
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="brand">
      <h1>WhatsApp Gateway Service</h1>
      <p>${reference.totals.endpoints} documented endpoints across ${reference.totals.groups} groups.</p>
    </div>
    <div class="intro">
      <p>Preferred integration path: <code>${escapeHtml(preferredBasePath)}</code>. Legacy <code>${escapeHtml(LEGACY_API_BASE)}</code> remains available for existing consumers.</p>
      <p>Discovery: <a href="${escapeHtml(reference.links.reference)}">reference JSON</a> · <a href="${escapeHtml(reference.links.openapi)}">OpenAPI 3.1</a></p>
    </div>
    <nav>${nav}</nav>
  </aside>
  <main class="content">
    <section class="hero">
      <div class="hero-top">
        <div>
          <div class="eyebrow">Public Contract</div>
          <h2>Versioned API Surface</h2>
          <p>The HTML docs, machine-readable reference, and OpenAPI export are generated from the same catalog. New consumers should target the versioned base path.</p>
        </div>
        <div class="pill-row">
          <div class="pill">Preferred ${escapeHtml(preferredBasePath)}</div>
          <div class="pill">Legacy ${escapeHtml(LEGACY_API_BASE)}</div>
          <div class="pill">OpenAPI ${escapeHtml(reference.links.openapi)}</div>
        </div>
      </div>
      <div class="auth-box">
        <strong>Authentication modes</strong>
        <ul>${authRows}</ul>
      </div>
    </section>
    ${sections}
  </main>
</div>
</body>
</html>`;
}
