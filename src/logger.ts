// logger.ts
import pino from 'pino';

export const loggerConfig: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
};

export const logger = pino(loggerConfig);
