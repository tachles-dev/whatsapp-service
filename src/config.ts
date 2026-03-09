// config.ts
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  API_KEY: z.string().min(1, 'API_KEY is required'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  AUTH_DIR: z.string().default('/data/auth'),
  WEBHOOK_URL: z.string().url(),
  WEBHOOK_API_KEY: z.string().min(1),
  ALLOWED_CONTACTS: z
    .string()
    .default('')
    .transform((val) => (val ? val.split(',').map((s) => s.trim()) : [])),
  HEARTBEAT_INTERVAL: z.coerce.number().default(300_000),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  _config = envSchema.parse(process.env);
  return _config;
}
