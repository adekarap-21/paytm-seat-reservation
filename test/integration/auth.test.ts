process.env.ADMIN_TOKEN = 'test-admin';

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import express from 'express';
import { requireUser, requireAdmin } from '../../src/middleware/access.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

function echoApp() {
  const app = express();
  app.use(express.json());
  app.get('/me', requireUser, (req, res) => res.json({ user_id: req.userId }));
  app.post('/admin', requireAdmin, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe('auth', () => {
  beforeAll(async () => {
    await truncateAll();
    await seedTestUsers(3);
    await loadUsers();
  });

  it('rejects /me without token', async () => {
    const res = await request(echoApp()).get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });
  it('rejects /me with wrong token', async () => {
    const res = await request(echoApp()).get('/me').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });
  it('accepts /me with valid bearer', async () => {
    const res = await request(echoApp()).get('/me').set('Authorization', 'Bearer tok_user_2');
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(2);
  });
  it('rejects /admin without admin token', async () => {
    const res = await request(echoApp()).post('/admin');
    expect(res.status).toBe(401);
  });
  it('accepts /admin with correct admin token', async () => {
    process.env.ADMIN_TOKEN = 'test-admin';
    const res = await request(echoApp()).post('/admin').set('X-Admin-Token', 'test-admin');
    expect(res.status).toBe(200);
  });
});
