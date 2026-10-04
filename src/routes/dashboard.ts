import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/dashboard.html'));
});
