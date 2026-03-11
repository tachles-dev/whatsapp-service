/**
 * cloud-api.stub.ts — Skeleton for the official WhatsApp Business Cloud API adapter.
 *
 * This file exists so the swap seam is real and type-checked today. Every method
 * body throws NotImplementedError. Replace them one by one when you have access to
 * a Meta Cloud API app (WABA ID + phone number ID + permanent token).
 *
 * HOW TO ACTIVATE:
 *   In core/device-manager.ts, change:
 *     const manager = new BaileysAdapter(deviceId, clientId, authDir, cache);
 *   to:
 *     const manager = new CloudApiAdapter(deviceId, clientId, { phoneNumberId, accessToken });
 *
 * Cloud API reference: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * KEY DIFFERENCES vs Baileys:
 *   - No persistent socket — the adapter is stateless between requests.
 *   - Auth is a long-lived access token (or system user token), not a QR scan.
 *   - Inbound events arrive as Meta webhooks to YOUR server (POST /webhooks/meta),
 *     not as in-process events — you'll need a new route + verification.
 *   - JIDs are plain phone numbers in E.164 format (no @s.whatsapp.net suffix).
 *   - Rate limits are enforced by Meta per phone number tier (Tier 1: 1k/day, etc.).
 */

import {
  ServiceStatus,
  IWhatsAppAdapter,
  ChatMetadata,
  GroupMember,
  GroupMetadata,
  GroupCreatedResult,
  ParticipantActionResult,
  PhoneCheckResult,
  ContactStatusInfo,
  OwnProfile,
  DeviceStatusData,
  MediaSource,
  SendOptions,
  SentMessage,
  LocationPayload,
  GroupSetting,
  PresenceType,
} from '../types';

class NotImplementedError extends Error {
  constructor(method: string) {
    super(`CloudApiAdapter.${method} is not yet implemented`);
    this.name = 'NotImplementedError';
  }
}

interface CloudApiAdapterOptions {
  /** Meta phone number ID (from WABA dashboard). */
  phoneNumberId: string;
  /** Permanent or system-user access token with whatsapp_business_messaging permission. */
  accessToken: string;
  /** Optional: Meta API version, e.g. 'v19.0'. Defaults to 'v19.0'. */
  apiVersion?: string;
}

export class CloudApiAdapter implements IWhatsAppAdapter {
  readonly deviceId: string;
  readonly clientId: string;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(deviceId: string, clientId: string, _opts: CloudApiAdapterOptions) {
    this.deviceId = deviceId;
    this.clientId = clientId;
    // TODO: store phoneNumberId, accessToken, build base URL
    // this.baseUrl = `https://graph.facebook.com/${opts.apiVersion ?? 'v19.0'}/${opts.phoneNumberId}`;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> { throw new NotImplementedError('start'); }
  async close(): Promise<void> { throw new NotImplementedError('close'); }
  async resetAuth(): Promise<void> { throw new NotImplementedError('resetAuth'); }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(): ServiceStatus { throw new NotImplementedError('getStatus'); }
  getStatusData(): DeviceStatusData { throw new NotImplementedError('getStatusData'); }
  getConnectedPhone(): string | null { throw new NotImplementedError('getConnectedPhone'); }
  getQr(): string | null { return null; } // Cloud API has no QR code
  setPhoneVerifier(_cb: (phone: string) => Promise<boolean>): void { /* no-op */ }

  // ── Messaging ──────────────────────────────────────────────────────────────

  /** @deprecated Use sendTextMessage */
  async sendMessage(_jid: string, _text: string, _quotedId?: string): Promise<string> {
    throw new NotImplementedError('sendMessage');
  }

  async sendTextMessage(_jid: string, _text: string, _options?: SendOptions): Promise<SentMessage> {
    throw new NotImplementedError('sendTextMessage');
  }

  async sendImageMessage(_jid: string, _media: MediaSource, _options?: SendOptions & { caption?: string }): Promise<SentMessage> {
    throw new NotImplementedError('sendImageMessage');
  }

  async sendVideoMessage(_jid: string, _media: MediaSource, _options?: SendOptions & { caption?: string }): Promise<SentMessage> {
    throw new NotImplementedError('sendVideoMessage');
  }

  async sendAudioMessage(_jid: string, _media: MediaSource, _options?: SendOptions & { ptt?: boolean }): Promise<SentMessage> {
    throw new NotImplementedError('sendAudioMessage');
  }

  async sendDocumentMessage(_jid: string, _media: MediaSource, _options?: SendOptions & { fileName?: string; mimeType?: string }): Promise<SentMessage> {
    throw new NotImplementedError('sendDocumentMessage');
  }

  async sendLocationMessage(_jid: string, _location: LocationPayload, _options?: SendOptions): Promise<SentMessage> {
    throw new NotImplementedError('sendLocationMessage');
  }

  async sendReactionMessage(_jid: string, _targetMessageId: string, _emoji: string): Promise<void> {
    throw new NotImplementedError('sendReactionMessage');
  }

  async deleteMessage(_jid: string, _messageId: string, _forEveryone: boolean): Promise<void> {
    throw new NotImplementedError('deleteMessage');
  }

  // ── Contacts ───────────────────────────────────────────────────────────────

  async checkPhone(_phone: string): Promise<PhoneCheckResult> {
    throw new NotImplementedError('checkPhone');
  }

  async getProfilePicture(_jid: string): Promise<string | null> {
    throw new NotImplementedError('getProfilePicture');
  }

  async getContactStatus(_jid: string): Promise<ContactStatusInfo> {
    throw new NotImplementedError('getContactStatus');
  }

  async blockContact(_jid: string): Promise<void> { throw new NotImplementedError('blockContact'); }
  async unblockContact(_jid: string): Promise<void> { throw new NotImplementedError('unblockContact'); }
  async getBlocklist(): Promise<string[]> { throw new NotImplementedError('getBlocklist'); }

  // ── Chats ──────────────────────────────────────────────────────────────────

  async getChats(_query?: string, _kind?: 'CONTACT' | 'GROUP', _hideUnnamed?: boolean): Promise<ChatMetadata[]> {
    throw new NotImplementedError('getChats');
  }

  async archiveChat(_jid: string, _archive: boolean): Promise<void> { throw new NotImplementedError('archiveChat'); }
  async muteChat(_jid: string, _muteDurationMs: number | null): Promise<void> { throw new NotImplementedError('muteChat'); }
  async pinChat(_jid: string, _pin: boolean): Promise<void> { throw new NotImplementedError('pinChat'); }
  async markRead(_jid: string, _messageIds: string[]): Promise<void> { throw new NotImplementedError('markRead'); }
  async deleteChat(_jid: string): Promise<void> { throw new NotImplementedError('deleteChat'); }
  async setEphemeralExpiration(_jid: string, _expirationSeconds: number): Promise<void> { throw new NotImplementedError('setEphemeralExpiration'); }

  // ── Groups ─────────────────────────────────────────────────────────────────

  async getGroupMembers(_jid: string): Promise<GroupMember[]> { throw new NotImplementedError('getGroupMembers'); }
  async getGroupMetadata(_jid: string): Promise<GroupMetadata> { throw new NotImplementedError('getGroupMetadata'); }
  async createGroup(_subject: string, _participantJids: string[]): Promise<GroupCreatedResult> { throw new NotImplementedError('createGroup'); }
  async updateGroupSubject(_jid: string, _subject: string): Promise<void> { throw new NotImplementedError('updateGroupSubject'); }
  async updateGroupDescription(_jid: string, _description: string): Promise<void> { throw new NotImplementedError('updateGroupDescription'); }

  async updateGroupParticipants(
    _jid: string,
    _participants: string[],
    _action: 'add' | 'remove' | 'promote' | 'demote',
  ): Promise<ParticipantActionResult[]> {
    throw new NotImplementedError('updateGroupParticipants');
  }

  async updateGroupSettings(_jid: string, _setting: GroupSetting): Promise<void> { throw new NotImplementedError('updateGroupSettings'); }
  async leaveGroup(_jid: string): Promise<void> { throw new NotImplementedError('leaveGroup'); }
  async getGroupInviteCode(_jid: string): Promise<string> { throw new NotImplementedError('getGroupInviteCode'); }
  async revokeGroupInviteCode(_jid: string): Promise<string> { throw new NotImplementedError('revokeGroupInviteCode'); }
  async joinGroupViaInviteCode(_code: string): Promise<GroupMetadata> { throw new NotImplementedError('joinGroupViaInviteCode'); }

  // ── Presence ───────────────────────────────────────────────────────────────

  async sendPresence(_presence: PresenceType, _toJid?: string): Promise<void> { throw new NotImplementedError('sendPresence'); }
  async subscribeToPresence(_jid: string): Promise<void> { throw new NotImplementedError('subscribeToPresence'); }

  // ── Profile ────────────────────────────────────────────────────────────────

  async getOwnProfile(): Promise<OwnProfile> { throw new NotImplementedError('getOwnProfile'); }
  async updateDisplayName(_name: string): Promise<void> { throw new NotImplementedError('updateDisplayName'); }
  async updateStatusText(_status: string): Promise<void> { throw new NotImplementedError('updateStatusText'); }

  // ── Subscriptions (webhook event routing) ─────────────────────────────────

  async subscribe(_jid: string): Promise<void> { throw new NotImplementedError('subscribe'); }
  async unsubscribe(_jid: string): Promise<void> { throw new NotImplementedError('unsubscribe'); }
  getSubscribed(): string[] { throw new NotImplementedError('getSubscribed'); }
}
