import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { getRedis } from '../redis';
import { deviceManager } from '../core/device-manager';
import { AppError } from '../errors';
import { ErrorCode, ScheduledMessageStatus, ScheduledTextMessage, SendOptions } from '../types';
import { consumeSendQuota } from '../send-throttle';

interface CreateScheduledTextMessageInput {
  clientId: string;
  deviceId: string;
  targetJid: string;
  text: string;
  sendAt: number;
  options?: SendOptions;
}

interface RescheduleScheduledTextMessageInput {
  clientId: string;
  deviceId: string;
  scheduleId: string;
  sendAt: number;
}

interface ScheduledMessageJobPayload {
  scheduleId: string;
}

type ScheduledMessageJobController = {
  upsertDelayedJob: (scheduleId: string, delayMs: number) => Promise<void>;
  removeDelayedJob: (scheduleId: string) => Promise<void>;
};

const SCHEDULE_INDEX_KEY = 'wa:scheduled:index';
const PROCESSING_LOCK_TTL_MS = 60_000;

class ScheduledMessageService {
  private jobController: ScheduledMessageJobController | null = null;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;

  setJobController(controller: ScheduledMessageJobController): void {
    this.jobController = controller;
  }

  private scheduleKey(scheduleId: string): string {
    return `wa:scheduled:${scheduleId}`;
  }

  private deviceSchedulesKey(deviceId: string): string {
    return `wa:device:${deviceId}:scheduled`;
  }

  private processingLockKey(scheduleId: string): string {
    return `wa:scheduled:lock:${scheduleId}`;
  }

  private serialize(record: ScheduledTextMessage): string {
    return JSON.stringify(record);
  }

  private deserialize(raw: string | null): ScheduledTextMessage | null {
    if (!raw) return null;
    return JSON.parse(raw) as ScheduledTextMessage;
  }

  private async saveRecord(record: ScheduledTextMessage): Promise<void> {
    const redis = getRedis();
    const multi = redis.multi();
    multi.set(this.scheduleKey(record.id), this.serialize(record));
    multi.sadd(this.deviceSchedulesKey(record.deviceId), record.id);
    if (record.status === ScheduledMessageStatus.SCHEDULED) {
      multi.zadd(SCHEDULE_INDEX_KEY, record.sendAt, record.id);
    } else {
      multi.zrem(SCHEDULE_INDEX_KEY, record.id);
    }
    await multi.exec();
  }

  private async acquireProcessingLock(scheduleId: string): Promise<boolean> {
    const res = await getRedis().set(this.processingLockKey(scheduleId), '1', 'PX', PROCESSING_LOCK_TTL_MS, 'NX');
    return res === 'OK';
  }

  private async releaseProcessingLock(scheduleId: string): Promise<void> {
    await getRedis().del(this.processingLockKey(scheduleId));
  }

  async createScheduledTextMessage(input: CreateScheduledTextMessageInput): Promise<ScheduledTextMessage> {
    deviceManager.assertManager(input.clientId, input.deviceId);

    if (input.sendAt <= Date.now()) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'sendAt must be in the future', 400, false, 'sendAt');
    }

    const now = Date.now();
    const record: ScheduledTextMessage = {
      id: randomUUID(),
      clientId: input.clientId,
      deviceId: input.deviceId,
      targetJid: input.targetJid,
      messageType: 'text',
      payload: {
        text: input.text,
        options: input.options,
      },
      status: ScheduledMessageStatus.SCHEDULED,
      sendAt: input.sendAt,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      cancelledAt: null,
      sentMessageId: null,
      lastError: null,
      attemptCount: 0,
    };

    await this.saveRecord(record);
    await this.jobController?.upsertDelayedJob(record.id, Math.max(0, record.sendAt - Date.now()));
    return record;
  }

  async getScheduledMessage(clientId: string, deviceId: string, scheduleId: string): Promise<ScheduledTextMessage> {
    const record = this.deserialize(await getRedis().get(this.scheduleKey(scheduleId)));
    if (!record || record.clientId !== clientId || record.deviceId !== deviceId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Scheduled message not found', 404, false);
    }
    return record;
  }

  async listScheduledMessages(clientId: string, deviceId: string, status?: ScheduledMessageStatus): Promise<ScheduledTextMessage[]> {
    deviceManager.assertManager(clientId, deviceId);

    const scheduleIds = await getRedis().smembers(this.deviceSchedulesKey(deviceId));
    if (scheduleIds.length === 0) return [];

    const records = (await getRedis().mget(scheduleIds.map((id) => this.scheduleKey(id))))
      .map((raw) => this.deserialize(raw))
      .filter((record): record is ScheduledTextMessage => !!record && record.clientId === clientId && record.deviceId === deviceId);

    return records
      .filter((record) => !status || record.status === status)
      .sort((left, right) => left.sendAt - right.sendAt);
  }

  async cancelScheduledMessage(clientId: string, deviceId: string, scheduleId: string): Promise<ScheduledTextMessage> {
    const record = await this.getScheduledMessage(clientId, deviceId, scheduleId);
    if (record.status === ScheduledMessageStatus.SENT) {
      throw new AppError(ErrorCode.CONFLICT, 'Scheduled message was already sent', 409, false);
    }
    if (record.status === ScheduledMessageStatus.CANCELLED) {
      return record;
    }
    if (record.status === ScheduledMessageStatus.PROCESSING) {
      throw new AppError(ErrorCode.CONFLICT, 'Scheduled message is currently being processed', 409, true);
    }

    const updated: ScheduledTextMessage = {
      ...record,
      status: ScheduledMessageStatus.CANCELLED,
      cancelledAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    };

    await this.saveRecord(updated);
    await this.jobController?.removeDelayedJob(scheduleId);
    return updated;
  }

  async rescheduleScheduledMessage(input: RescheduleScheduledTextMessageInput): Promise<ScheduledTextMessage> {
    const record = await this.getScheduledMessage(input.clientId, input.deviceId, input.scheduleId);
    if (record.status === ScheduledMessageStatus.SENT) {
      throw new AppError(ErrorCode.CONFLICT, 'Scheduled message was already sent', 409, false);
    }
    if (record.status === ScheduledMessageStatus.PROCESSING) {
      throw new AppError(ErrorCode.CONFLICT, 'Scheduled message is currently being processed', 409, true);
    }
    if (input.sendAt <= Date.now()) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'sendAt must be in the future', 400, false, 'sendAt');
    }

    const updated: ScheduledTextMessage = {
      ...record,
      sendAt: input.sendAt,
      status: ScheduledMessageStatus.SCHEDULED,
      cancelledAt: null,
      updatedAt: Date.now(),
      lastError: null,
    };

    await this.saveRecord(updated);
    await this.jobController?.upsertDelayedJob(updated.id, Math.max(0, updated.sendAt - Date.now()));
    return updated;
  }

  async purgeDeviceScheduledMessages(clientId: string, deviceId: string): Promise<number> {
    const redis = getRedis();
    const scheduleIds = await redis.smembers(this.deviceSchedulesKey(deviceId));
    if (scheduleIds.length === 0) return 0;

    const rawRecords = await redis.mget(scheduleIds.map((scheduleId) => this.scheduleKey(scheduleId)));
    const matchingIds = rawRecords
      .map((raw, index) => ({ record: this.deserialize(raw), scheduleId: scheduleIds[index] }))
      .filter(({ record }) => !!record && record.clientId === clientId && record.deviceId === deviceId)
      .map(({ scheduleId }) => scheduleId);

    if (matchingIds.length === 0) return 0;

    await Promise.all(matchingIds.map((scheduleId) => this.jobController?.removeDelayedJob(scheduleId)));

    const multi = redis.multi();
    for (const scheduleId of matchingIds) {
      multi.del(this.scheduleKey(scheduleId));
      multi.del(this.processingLockKey(scheduleId));
      multi.zrem(SCHEDULE_INDEX_KEY, scheduleId);
      multi.srem(this.deviceSchedulesKey(deviceId), scheduleId);
    }
    await multi.exec();
    return matchingIds.length;
  }

  async executeScheduledMessage(job: Job<ScheduledMessageJobPayload>): Promise<void> {
    const scheduleId = job.data.scheduleId;
    const locked = await this.acquireProcessingLock(scheduleId);
    if (!locked) return;

    try {
      const record = this.deserialize(await getRedis().get(this.scheduleKey(scheduleId)));
      if (!record) return;
      if (record.status !== ScheduledMessageStatus.SCHEDULED) return;

      if (record.sendAt > Date.now() + 1000) {
        await this.jobController?.upsertDelayedJob(record.id, Math.max(0, record.sendAt - Date.now()));
        return;
      }

      const processingRecord: ScheduledTextMessage = {
        ...record,
        status: ScheduledMessageStatus.PROCESSING,
        updatedAt: Date.now(),
      };
      await this.saveRecord(processingRecord);

      try {
        const manager = deviceManager.assertManager(processingRecord.clientId, processingRecord.deviceId);
        await consumeSendQuota(processingRecord.clientId, processingRecord.deviceId);
        const sent = await manager.sendTextMessage(processingRecord.targetJid, processingRecord.payload.text, processingRecord.payload.options);
        const sentRecord: ScheduledTextMessage = {
          ...processingRecord,
          status: ScheduledMessageStatus.SENT,
          updatedAt: Date.now(),
          sentAt: Date.now(),
          sentMessageId: sent.messageId,
          lastError: null,
          attemptCount: job.attemptsMade + 1,
        };
        await this.saveRecord(sentRecord);
      } catch (err) {
        const retryable = err instanceof AppError ? err.retryable : true;
        const message = err instanceof Error ? err.message : 'Unknown scheduled message failure';

        const failedRecord: ScheduledTextMessage = {
          ...processingRecord,
          status: retryable ? ScheduledMessageStatus.SCHEDULED : ScheduledMessageStatus.FAILED,
          updatedAt: Date.now(),
          lastError: message,
          attemptCount: job.attemptsMade + 1,
        };
        await this.saveRecord(failedRecord);

        if (retryable) throw err;
      }
    } finally {
      await this.releaseProcessingLock(scheduleId);
    }
  }

  async reconcileDueMessages(limit = 200): Promise<number> {
    const now = Date.now();
    const dueIds = await getRedis().zrangebyscore(SCHEDULE_INDEX_KEY, 0, now, 'LIMIT', 0, limit);
    if (dueIds.length === 0) return 0;
    await Promise.all(dueIds.map((scheduleId) => this.jobController?.upsertDelayedJob(scheduleId, 0)));
    return dueIds.length;
  }

  startReconciliationLoop(intervalMs = 60_000): void {
    if (this.reconciliationTimer) return;
    this.reconciliationTimer = setInterval(() => {
      this.reconcileDueMessages().catch(() => {});
    }, intervalMs);
    this.reconciliationTimer.unref();
  }

  stopReconciliationLoop(): void {
    if (!this.reconciliationTimer) return;
    clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = null;
  }
}

export const scheduledMessageService = new ScheduledMessageService();
export type { ScheduledMessageJobPayload };