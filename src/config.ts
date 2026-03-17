// config.ts
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { DEFAULT_MODULES, MODULE_PROFILES, ModuleFlags, ModuleProfileName } from './modules';

const moduleProfileSchema = z.enum(['lite', 'standard', 'full']);

const moduleFlagsSchema = z.object({
  admin: z.boolean().optional(),
  audit: z.boolean().optional(),
  heartbeat: z.boolean().optional(),
  webhooks: z.boolean().optional(),
  scheduling: z.boolean().optional(),
  multiInstanceLeasing: z.boolean().optional(),
  ownerForwarding: z.boolean().optional(),
});

const moduleFileSchema = z.object({
  profile: moduleProfileSchema.optional(),
  modules: moduleFlagsSchema.optional(),
});

type ModuleFileConfig = z.infer<typeof moduleFileSchema>;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function loadModulesFromFile(configPath: string | undefined): ModuleFileConfig {
  if (!configPath || !existsSync(configPath)) return {};
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  return moduleFileSchema.parse(raw);
}

function resolveProfile(env: NodeJS.ProcessEnv, fileConfig: ModuleFileConfig): ModuleProfileName | null {
  const envProfile = env.MODULE_PROFILE;
  if (envProfile) return moduleProfileSchema.parse(envProfile);
  return fileConfig.profile ?? null;
}

function resolveModuleFlags(env: NodeJS.ProcessEnv): ModuleFlags {
  const fileConfig = loadModulesFromFile(env.MODULE_CONFIG_PATH);
  const fromFile = fileConfig.modules ?? {};
  const profile = resolveProfile(env, fileConfig);
  const profileModules = profile ? MODULE_PROFILES[profile] : DEFAULT_MODULES;
  const merged: ModuleFlags = {
    ...profileModules,
    ...fromFile,
    admin: parseBooleanEnv(env.MODULE_ADMIN_ENABLED) ?? fromFile.admin ?? profileModules.admin,
    audit: parseBooleanEnv(env.MODULE_AUDIT_ENABLED) ?? fromFile.audit ?? profileModules.audit,
    heartbeat: parseBooleanEnv(env.MODULE_HEARTBEAT_ENABLED) ?? fromFile.heartbeat ?? profileModules.heartbeat,
    webhooks: parseBooleanEnv(env.MODULE_WEBHOOKS_ENABLED) ?? fromFile.webhooks ?? profileModules.webhooks,
    scheduling: parseBooleanEnv(env.MODULE_SCHEDULING_ENABLED) ?? fromFile.scheduling ?? profileModules.scheduling,
    multiInstanceLeasing: parseBooleanEnv(env.MODULE_MULTI_INSTANCE_LEASING_ENABLED) ?? fromFile.multiInstanceLeasing ?? profileModules.multiInstanceLeasing,
    ownerForwarding: parseBooleanEnv(env.MODULE_OWNER_FORWARDING_ENABLED) ?? fromFile.ownerForwarding ?? profileModules.ownerForwarding,
  };
  if (!merged.multiInstanceLeasing) merged.ownerForwarding = false;
  if (!merged.admin) merged.audit = false;
  return merged;
}

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  API_KEY: z.string().min(1, 'API_KEY is required'),
  // Secret used to HMAC-sign per-client API keys before storing in Redis.
  // Changing this invalidates all existing client keys.
  KEY_SECRET: z.string().min(32, 'KEY_SECRET must be at least 32 chars'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  AUTH_BASE_DIR: z.string().default('/data/auth'),
  MODULE_CONFIG_PATH: z.string().optional(),
  MODULE_PROFILE: moduleProfileSchema.optional(),
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_API_KEY: z.string().min(1).optional(),
  PROXY_URL: z.string().optional(),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((val) => (val ? val.split(',').map((s) => s.trim()) : [])),
  ALLOWED_CONTACTS: z
    .string()
    .default('')
    .transform((val) => (val ? val.split(',').map((s) => s.trim()) : [])),
  HEARTBEAT_INTERVAL: z.coerce.number().default(300_000),
  DEVICE_START_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(3),
  DEVICE_START_BATCH_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1_500),
  RECONNECT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
  RECONNECT_MAX_DELAY_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  RECONNECT_ERROR_COOLDOWN_MS: z.coerce.number().int().min(5_000).max(900_000).default(300_000),
  INSTANCE_ID: z.string().default(process.env.HOSTNAME || `wgs-${Math.random().toString(36).slice(2, 10)}`),
  INSTANCE_BASE_URL: z.string().url().optional(),
  INSTANCE_REGISTRY_TTL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  INSTANCE_REGISTRY_RENEW_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  DEVICE_LEASE_TTL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  DEVICE_LEASE_RENEW_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  DEVICE_LEASE_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  SEND_THROTTLE_WINDOW_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  CLIENT_SENDS_PER_WINDOW: z.coerce.number().int().min(1).max(100_000).default(300),
  DEVICE_SENDS_PER_WINDOW: z.coerce.number().int().min(1).max(10_000).default(120),
  BROADCAST_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  ADMIN_USERNAME: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_SESSION_TTL_MS: z.coerce.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1000).default(8 * 60 * 60 * 1000),
  ADMIN_SESSION_COOKIE: z.string().default('wga_admin'),
  MODULE_ADMIN_ENABLED: z.string().optional(),
  MODULE_AUDIT_ENABLED: z.string().optional(),
  MODULE_HEARTBEAT_ENABLED: z.string().optional(),
  MODULE_WEBHOOKS_ENABLED: z.string().optional(),
  MODULE_SCHEDULING_ENABLED: z.string().optional(),
  MODULE_MULTI_INSTANCE_LEASING_ENABLED: z.string().optional(),
  MODULE_OWNER_FORWARDING_ENABLED: z.string().optional(),
  STATUS_EVENT_LOOP_P95_MS: z.coerce.number().min(10).max(5_000).default(250),
  STATUS_HEAP_PERCENT: z.coerce.number().min(10).max(99).default(85),
  STATUS_WEBHOOK_QUEUE_BACKLOG: z.coerce.number().int().min(1).max(1_000_000).default(500),
  STATUS_SCHEDULED_QUEUE_BACKLOG: z.coerce.number().int().min(1).max(1_000_000).default(500),
});

export type Config = z.infer<typeof envSchema> & { modules: ModuleFlags };

let _config: Config | null = null;

export function resetConfigForTests(): void {
  _config = null;
}

export function loadConfig(): Config {
  if (_config) return _config;
  const parsed = envSchema.parse(process.env);
  const modules = resolveModuleFlags(process.env);

  if ((modules.webhooks || modules.heartbeat) && (!parsed.WEBHOOK_URL || !parsed.WEBHOOK_API_KEY)) {
    throw new Error('WEBHOOK_URL and WEBHOOK_API_KEY are required when webhook or heartbeat modules are enabled');
  }
  if (modules.ownerForwarding && !parsed.INSTANCE_BASE_URL) {
    throw new Error('INSTANCE_BASE_URL is required when owner forwarding is enabled');
  }

  _config = { ...parsed, modules };
  return _config;
}
