// redis.ts
import { EventEmitter } from 'events';
import Redis from 'ioredis';
import { loadConfig } from './config';
import { logger } from './logger';

let redis: Redis | null = null;

type RedisValue =
  | { type: 'string'; value: string }
  | { type: 'set'; value: Set<string> }
  | { type: 'hash'; value: Map<string, string> }
  | { type: 'list'; value: string[] }
  | { type: 'zset'; value: Map<string, number> };

class InMemoryRedis extends EventEmitter {
  status = 'ready';
  private store = new Map<string, RedisValue>();
  private expirations = new Map<string, number>();

  private purgeExpired(key: string): void {
    const expiresAt = this.expirations.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.store.delete(key);
      this.expirations.delete(key);
    }
  }

  private setExpiration(key: string, ttlMs: number | null): void {
    if (ttlMs === null) {
      this.expirations.delete(key);
      return;
    }
    this.expirations.set(key, Date.now() + ttlMs);
  }

  private getString(key: string): string | null {
    this.purgeExpired(key);
    const existing = this.store.get(key);
    if (!existing || existing.type !== 'string') return null;
    return existing.value;
  }

  private ensureSet(key: string): Set<string> {
    this.purgeExpired(key);
    const existing = this.store.get(key);
    if (existing?.type === 'set') return existing.value;
    const next = new Set<string>();
    this.store.set(key, { type: 'set', value: next });
    return next;
  }

  private ensureHash(key: string): Map<string, string> {
    this.purgeExpired(key);
    const existing = this.store.get(key);
    if (existing?.type === 'hash') return existing.value;
    const next = new Map<string, string>();
    this.store.set(key, { type: 'hash', value: next });
    return next;
  }

  private ensureList(key: string): string[] {
    this.purgeExpired(key);
    const existing = this.store.get(key);
    if (existing?.type === 'list') return existing.value;
    const next: string[] = [];
    this.store.set(key, { type: 'list', value: next });
    return next;
  }

  private ensureZSet(key: string): Map<string, number> {
    this.purgeExpired(key);
    const existing = this.store.get(key);
    if (existing?.type === 'zset') return existing.value;
    const next = new Map<string, number>();
    this.store.set(key, { type: 'zset', value: next });
    return next;
  }

  async get(key: string): Promise<string | null> {
    return this.getString(key);
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    this.purgeExpired(key);
    let ttlMs: number | null = null;
    let nx = false;
    for (let index = 0; index < args.length; index += 1) {
      const token = String(args[index]).toUpperCase();
      if (token === 'NX') {
        nx = true;
        continue;
      }
      const rawTtl = args[index + 1];
      if (token === 'PX' && typeof rawTtl === 'number') {
        ttlMs = rawTtl;
        index += 1;
      } else if (token === 'EX' && typeof rawTtl === 'number') {
        ttlMs = rawTtl * 1000;
        index += 1;
      }
    }
    if (nx && this.store.has(key) && this.getString(key) !== null) {
      return null;
    }
    this.store.set(key, { type: 'string', value });
    this.setExpiration(key, ttlMs);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      this.purgeExpired(key);
      if (this.store.delete(key)) deleted += 1;
      this.expirations.delete(key);
    }
    return deleted;
  }

  async mget(keys: string[]): Promise<Array<string | null>> {
    return Promise.all(keys.map((key) => this.get(key)));
  }

  async pexpire(key: string, ttlMs: number): Promise<number> {
    this.purgeExpired(key);
    if (!this.store.has(key)) return 0;
    this.setExpiration(key, ttlMs);
    return 1;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    return this.pexpire(key, ttlSeconds * 1000);
  }

  async incrby(key: string, increment: number): Promise<number> {
    const current = Number(this.getString(key) ?? '0');
    const next = current + increment;
    this.store.set(key, { type: 'string', value: String(next) });
    return next;
  }

  async smembers(key: string): Promise<string[]> {
    return [...this.ensureSet(key)];
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.ensureSet(key);
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.ensureSet(key);
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    return removed;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.ensureHash(key).entries());
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const hash = this.ensureHash(key);
    const exists = hash.has(field);
    hash.set(field, value);
    return exists ? 0 : 1;
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.ensureList(key);
    list.unshift(...values.reverse());
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.ensureList(key);
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    const next = list.slice(start, normalizedStop + 1);
    list.splice(0, list.length, ...next);
    return 'OK';
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.ensureList(key);
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    return list.slice(start, normalizedStop + 1);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const zset = this.ensureZSet(key);
    const exists = zset.has(member);
    zset.set(member, score);
    return exists ? 0 : 1;
  }

  async zrem(key: string, member: string): Promise<number> {
    const zset = this.ensureZSet(key);
    return zset.delete(member) ? 1 : 0;
  }

  async zrangebyscore(key: string, min: number | string, max: number | string, ...args: Array<string | number>): Promise<string[]> {
    const zset = this.ensureZSet(key);
    const minScore = Number(min);
    const maxScore = Number(max);
    let offset = 0;
    let count = Number.MAX_SAFE_INTEGER;
    if (String(args[0]).toUpperCase() === 'LIMIT') {
      offset = Number(args[1] ?? 0);
      count = Number(args[2] ?? Number.MAX_SAFE_INTEGER);
    }
    return [...zset.entries()]
      .filter(([, score]) => score >= minScore && score <= maxScore)
      .sort((left, right) => left[1] - right[1])
      .slice(offset, offset + count)
      .map(([member]) => member);
  }

  multi() {
    const operations: Array<() => Promise<unknown>> = [];
    const chain = {
      set: (key: string, value: string, ...args: Array<string | number>) => {
        operations.push(() => this.set(key, value, ...args));
        return chain;
      },
      del: (...keys: string[]) => {
        operations.push(() => this.del(...keys));
        return chain;
      },
      sadd: (key: string, ...members: string[]) => {
        operations.push(() => this.sadd(key, ...members));
        return chain;
      },
      srem: (key: string, ...members: string[]) => {
        operations.push(() => this.srem(key, ...members));
        return chain;
      },
      zadd: (key: string, score: number, member: string) => {
        operations.push(() => this.zadd(key, score, member));
        return chain;
      },
      zrem: (key: string, member: string) => {
        operations.push(() => this.zrem(key, member));
        return chain;
      },
      lpush: (key: string, value: string) => {
        operations.push(() => this.lpush(key, value));
        return chain;
      },
      ltrim: (key: string, start: number, stop: number) => {
        operations.push(() => this.ltrim(key, start, stop));
        return chain;
      },
      incrby: (key: string, increment: number) => {
        operations.push(() => this.incrby(key, increment));
        return chain;
      },
      pexpire: (key: string, ttlMs: number) => {
        operations.push(() => this.pexpire(key, ttlMs));
        return chain;
      },
      hset: (key: string, field: string, value: string) => {
        operations.push(() => this.hset(key, field, value));
        return chain;
      },
      exec: async () => Promise.all(operations.map(async (operation) => [null, await operation()])),
    };
    return chain;
  }

  pipeline() {
    return this.multi();
  }

  async quit(): Promise<'OK'> {
    this.status = 'end';
    this.store.clear();
    this.expirations.clear();
    return 'OK';
  }
}

function shouldUseInMemoryRedis(): boolean {
  return process.env.WGA_IN_MEMORY_REDIS === '1' || process.env.NODE_ENV === 'test' || process.argv.includes('--test');
}

export function getRedis(): Redis {
  if (redis) return redis;

  if (shouldUseInMemoryRedis()) {
    redis = new InMemoryRedis() as unknown as Redis;
    return redis;
  }

  const config = loadConfig();
  redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    lazyConnect: true,
  });

  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  redis.on('connect', () => {
    logger.info('Redis connected');
  });

  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
