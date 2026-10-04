process.env.ADMIN_TOKEN = 'test-admin';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

describe('hot-seat contention', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(100); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('50 concurrent reserves on 1 seat → exactly 1x201, 49x409, zero 5xx', async () => {
    const create = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name: 'hot', price_paise: 1, per_user_limit: 4, seats: ['A12'] });
    const sid = create.body.id;
    const app = createApp();
    const requests = Array.from({ length: 50 }, (_, i) =>
      request(app).post(`/shows/${sid}/reserve`)
        .set('Authorization', `Bearer tok_user_${i+1}`)
        .send({ seats: ['A12'], idempotency_key: `k_${i}` })
    );
    const results = await Promise.all(requests);
    const by = { ok:0, taken:0, other:0, server:0 } as Record<string, number>;
    for (const r of results) {
      if (r.status === 201) by.ok++;
      else if (r.status === 409 && r.body.error === 'seat_taken') by.taken++;
      else if (r.status >= 500) by.server++;
      else by.other++;
    }
    expect(by.server).toBe(0);
    expect(by.ok).toBe(1);
    expect(by.taken).toBe(49);
    expect(by.other).toBe(0);
    // reconciliation
    const g = await request(app).get(`/shows/${sid}`);
    expect(g.body.counts).toEqual({ available:0, held:0, confirmed:1, total:1 });
  }, 20000);
});
