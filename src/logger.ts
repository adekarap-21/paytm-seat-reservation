import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { env: config.nodeEnv },
  redact: ['req.headers.authorization', 'req.headers["x-admin-token"]'],
});
