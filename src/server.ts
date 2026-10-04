import express, { type Express } from 'express';
import pinoHttp from 'pino-http';
import { requestId } from './middleware/requestId.js';
import { httpMetrics } from './middleware/httpMetrics.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './logger.js';
import { registry } from './metrics.js';
import { config } from './config.js';
import { showsRouter } from './routes/shows.js';
import { reserveRouter } from './routes/reserve.js';
import { cancelRouter } from './routes/cancel.js';
import { streamRouter } from './routes/stream.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => (req as any).id }));
  app.use(httpMetrics);
  app.use(express.json({ limit: '32kb' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });
  app.use(showsRouter);
  app.use(reserveRouter);
  app.use(cancelRouter);
  app.use(streamRouter);
  app.use(errorHandler);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadUsers } = await import('./auth.js');
  await loadUsers();
  createApp().listen(config.port, () => logger.info({ port: config.port }, 'listening'));
}
