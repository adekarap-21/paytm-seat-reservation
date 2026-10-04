import express, { type Express } from 'express';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  return app;
}

const port = Number(process.env.PORT ?? 8080);
if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(port, () => console.log(`listening on :${port}`));
}
