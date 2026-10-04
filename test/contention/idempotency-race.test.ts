process.env.ADMIN_TOKEN = 'test-admin';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

describe('idempotency under concurrency', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(2); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('same user+key fired 10x → exactly one reservation', async () => {
    const create = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name:'ir', price_paise:1, per_user_limit:4, seats:['A1','A2','A3','A4','A5'] });
    const sid = create.body.id;
    const app = createApp();
    const results = await Promise.all(Array.from({length:10}, () =>
      request(app).post(`/shows/${sid}/reserve`)
        .set('Authorization','Bearer tok_user_1')
        .send({ seats:['A1'], idempotency_key:'same' })
    ));
    const ids = new Set(results.map(r => r.body?.reservation_id).filter(Boolean));
    const srv = results.filter(r => r.status >= 500).length;
    const okCount = results.filter(r => r.status === 201 || r.status === 200).length;
    expect(srv).toBe(0);
    expect(ids.size).toBe(1);
    expect(okCount).toBe(10);
    const g = await request(app).get(`/shows/${sid}`);
    expect(g.body.counts.confirmed).toBe(1);
  }, 15000);
});
