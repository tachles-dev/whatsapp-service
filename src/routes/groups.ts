// routes/groups.ts — Group management endpoints.
//
// Subscriptions:
//   GET    .../groups/subscribed                List groups the device is subscribed to
//   POST   .../groups/:jid/subscribe
//   DELETE .../groups/:jid/subscribe
//
// Metadata:
//   GET    .../groups/:jid/metadata
//   GET    .../groups/:jid/members
//
// CRUD:
//   POST   .../groups                           Create a group
//   PUT    .../groups/:jid/subject
//   PUT    .../groups/:jid/description
//
// Participants   (Layer 2 — bulk):
//   PUT    .../groups/:jid/participants         body: { action, participants[] }
//
// Settings & lifecycle:
//   PUT    .../groups/:jid/settings             body: { setting, value }
//   POST   .../groups/:jid/leave
//
// Invite:
//   GET    .../groups/:jid/invite-code
//   POST   .../groups/:jid/invite-code/revoke
//   POST   .../groups/join                      Layer 3 — join via invite link
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deviceManager } from '../core/device-manager';
import { ok, fail, sendError, validateJid } from './helpers';
import { GroupSetting } from '../types';

type DeviceParams = { clientId: string; deviceId: string };
type GroupParams = DeviceParams & { jid: string };

const createGroupSchema = z.object({
  subject: z.string().min(1).max(100),
  participants: z.array(z.string()).min(1),
});

const subjectSchema = z.object({ subject: z.string().min(1).max(100) });
const descriptionSchema = z.object({ description: z.string().max(500) });

const participantsSchema = z.object({
  action: z.enum(['add', 'remove', 'promote', 'demote']),
  participants: z.array(z.string()).min(1).max(256),
});

// GroupSetting enum encodes both the field and the value
// (e.g. GroupSetting.ANNOUNCE vs GroupSetting.NOT_ANNOUNCE).
const settingsSchema = z.object({
  setting: z.nativeEnum(GroupSetting),
});

const joinSchema = z.object({
  inviteCode: z.string().min(8),
});

export async function registerGroupRoutes(app: FastifyInstance, basePath = '/api'): Promise<void> {
  // ── Subscriptions ──────────────────────────────────────────────────────────

  // GET .../groups/subscribed
  app.get(`${basePath}/clients/:clientId/devices/:deviceId/groups/subscribed`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const groups = manager.getSubscribed().filter((j) => j.endsWith('@g.us'));
      return ok(groups);
    } catch (err) { sendError(err, reply); }
  });

  // POST .../groups/:jid/subscribe
  app.post(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/subscribe`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.subscribe(validateJid(jid));
      return ok({ subscribed: true });
    } catch (err) { sendError(err, reply); }
  });

  // DELETE .../groups/:jid/subscribe
  app.delete(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/subscribe`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.unsubscribe(validateJid(jid));
      return ok({ subscribed: false });
    } catch (err) { sendError(err, reply); }
  });

  // ── Metadata ───────────────────────────────────────────────────────────────

  // GET .../groups/:jid/metadata
  app.get(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/metadata`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const meta = await manager.getGroupMetadata(validateJid(jid));
      return ok(meta);
    } catch (err) { sendError(err, reply); }
  });

  // GET .../groups/:jid/members
  app.get(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/members`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const meta = await manager.getGroupMetadata(validateJid(jid));
      return ok(meta.participants);
    } catch (err) { sendError(err, reply); }
  });

  // ── CRUD ───────────────────────────────────────────────────────────────────

  // POST .../groups
  app.post(`${basePath}/clients/:clientId/devices/:deviceId/groups`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const group = await manager.createGroup(parsed.data.subject, parsed.data.participants);
      return reply.code(201).send(ok(group));
    } catch (err) { sendError(err, reply); }
  });

  // PUT .../groups/:jid/subject
  app.put(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/subject`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    const parsed = subjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.updateGroupSubject(validateJid(jid), parsed.data.subject);
      return ok({ updated: true });
    } catch (err) { sendError(err, reply); }
  });

  // PUT .../groups/:jid/description
  app.put(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/description`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    const parsed = descriptionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.updateGroupDescription(validateJid(jid), parsed.data.description);
      return ok({ updated: true });
    } catch (err) { sendError(err, reply); }
  });

  // ── Participants (Layer 2) ─────────────────────────────────────────────────

  // PUT .../groups/:jid/participants
  app.put(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/participants`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    const parsed = participantsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.updateGroupParticipants(validateJid(jid), parsed.data.participants, parsed.data.action);
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });

  // ── Settings & lifecycle ───────────────────────────────────────────────────

  // PUT .../groups/:jid/settings
  app.put(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/settings`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.updateGroupSettings(validateJid(jid), parsed.data.setting);
      return ok({ updated: true });
    } catch (err) { sendError(err, reply); }
  });

  // POST .../groups/:jid/leave
  app.post(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/leave`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.leaveGroup(validateJid(jid));
      return ok({ left: true });
    } catch (err) { sendError(err, reply); }
  });

  // ── Invite ─────────────────────────────────────────────────────────────────

  // GET .../groups/:jid/invite-code
  app.get(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/invite-code`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const code = await manager.getGroupInviteCode(validateJid(jid));
      return ok({ inviteCode: code, inviteLink: `https://chat.whatsapp.com/${code}` });
    } catch (err) { sendError(err, reply); }
  });

  // POST .../groups/:jid/invite-code/revoke
  app.post(`${basePath}/clients/:clientId/devices/:deviceId/groups/:jid/invite-code/revoke`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as GroupParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const code = await manager.revokeGroupInviteCode(validateJid(jid));
      return ok({ inviteCode: code, inviteLink: `https://chat.whatsapp.com/${code}` });
    } catch (err) { sendError(err, reply); }
  });

  // POST .../groups/join  — Layer 3
  app.post(`${basePath}/clients/:clientId/devices/:deviceId/groups/join`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = joinSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.joinGroupViaInviteCode(parsed.data.inviteCode);
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });
}
