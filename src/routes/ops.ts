import { Router } from 'express';
import { pool } from '../db.js';
import { registry } from '../metrics.js';

export const opsRouter = Router();

opsRouter.get('/healthz', (_req, res) => res.json({ ok: true }));

opsRouter.get('/readyz', async (_req, res) => {
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('db_timeout')), 500));
    await Promise.race([pool.query('SELECT 1'), timeout]);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: 'db_unreachable' });
  }
});

opsRouter.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});
