process.env.ADMIN_TOKEN = 'test-admin';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

describe('per-user limit under concurrency', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(5); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('10 parallel reserves by same user on limit=4 show → at most 4 confirmed', async () => {
    const create = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name:'pul', price_paise:1, per_user_limit:4, seats: Array.from({length:10},(_,i)=>`S${i+1}`) });
    const sid = create.body.id;
    const app = createApp();
    const results = await Promise.all(Array.from({length:10}, (_,i) =>
      request(app).post(`/shows/${sid}/reserve`)
        .set('Authorization','Bearer tok_user_1')
        .send({ seats: [`S${i+1}`], idempotency_key: `k_${i}` })
    ));
    const ok = results.filter(r => r.status === 201).length;
    const over = results.filter(r => r.body?.error === 'per_user_limit').length;
    const srv = results.filter(r => r.status >= 500).length;
    expect(srv).toBe(0);
    expect(ok).toBeLessThanOrEqual(4);
    expect(ok + over).toBe(10);
    const g = await request(app).get(`/shows/${sid}`);
    expect(g.body.counts.confirmed).toBe(ok);
  }, 15000);
});
