process.env.ADMIN_TOKEN = 'test-admin';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

async function createShow(seats: string[]) {
  const r = await request(createApp()).post('/shows').set('X-Admin-Token', 'test-admin')
    .send({ name: `c_${Math.random().toString(36).slice(2, 8)}`, price_paise: 10, per_user_limit: 4, seats });
  return r.body.id as string;
}

async function reserve(sid: string, user: number, seats: string[], key: string) {
  return request(createApp()).post(`/shows/${sid}/reserve`)
    .set('Authorization', `Bearer tok_user_${user}`).send({ seats, idempotency_key: key });
}

describe('cancel', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(5); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('owner cancels — seats released, status cancelled', async () => {
    const sid = await createShow(['A1', 'A2']);
    const r = await reserve(sid, 1, ['A1'], 'k1');
    const c = await request(createApp())
      .post(`/reservations/${r.body.reservation_id}/cancel`)
      .set('Authorization', 'Bearer tok_user_1');
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('cancelled');
    const g = await request(createApp()).get(`/shows/${sid}`);
    expect(g.body.counts).toEqual({ available: 2, held: 0, confirmed: 0, total: 2 });
    // released seat is re-reservable
    const r2 = await reserve(sid, 2, ['A1'], 'k2');
    expect(r2.status).toBe(201);
  });

  // Review Focus #5
  it('test_cancel_by_non_owner_forbidden', async () => {
    const sid = await createShow(['A1']);
    const r = await reserve(sid, 1, ['A1'], 'k1');
    const c = await request(createApp())
      .post(`/reservations/${r.body.reservation_id}/cancel`)
      .set('Authorization', 'Bearer tok_user_2');
    expect(c.status).toBe(403);
    // Seats untouched
    const g = await request(createApp()).get(`/shows/${sid}`);
    expect(g.body.counts.confirmed).toBe(1);
  });

  it('404 on unknown reservation', async () => {
    const c = await request(createApp())
      .post('/reservations/01ABCDEFGHIJKLMNOPQRSTUVWX/cancel')
      .set('Authorization', 'Bearer tok_user_1');
    expect(c.status).toBe(404);
  });

  it('double-cancel returns 409 already_cancelled', async () => {
    const sid = await createShow(['A1']);
    const r = await reserve(sid, 1, ['A1'], 'k1');
    await request(createApp()).post(`/reservations/${r.body.reservation_id}/cancel`)
      .set('Authorization', 'Bearer tok_user_1');
    const c2 = await request(createApp()).post(`/reservations/${r.body.reservation_id}/cancel`)
      .set('Authorization', 'Bearer tok_user_1');
    expect(c2.status).toBe(409);
    expect(c2.body.error).toBe('already_cancelled');
  });
});
