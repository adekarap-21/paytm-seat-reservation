import { z } from 'zod';

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  TOKEN_SECRET: z.string().min(1),
  ADMIN_TOKEN: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
});

// Test-env fallback for missing vars
if (!process.env.DATABASE_URL)   process.env.DATABASE_URL = 'mysql://app:devpass@localhost:3307/seatres';
if (!process.env.TOKEN_SECRET)   process.env.TOKEN_SECRET = 'test-secret';
if (!process.env.ADMIN_TOKEN)    process.env.ADMIN_TOKEN  = 'test-admin';

const parsed = Schema.parse(process.env);
export const config = {
  databaseUrl: parsed.DATABASE_URL,
  port: parsed.PORT,
  nodeEnv: parsed.NODE_ENV,
  tokenSecret: parsed.TOKEN_SECRET,
  adminToken: parsed.ADMIN_TOKEN,
  logLevel: parsed.LOG_LEVEL,
};
