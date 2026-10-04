process.env.ADMIN_TOKEN = 'test-admin';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

async function createShow(seats: string[], per_user_limit = 4) {
  const r = await request(createApp()).post('/shows').set('X-Admin-Token', 'test-admin')
    .send({ name: `s_${Math.random().toString(36).slice(2, 8)}`, price_paise: 100, per_user_limit, seats });
  return r.body.id as string;
}

describe('reserve (single-seat)', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(5); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('reserves a single seat', async () => {
    const sid = await createShow(['A1', 'A2']);
    const r = await request(createApp()).post(`/shows/${sid}/reserve`)
      .set('Authorization', 'Bearer tok_user_1')
      .send({ seats: ['A1'], idempotency_key: 'k1' });
    expect(r.status).toBe(201);
    expect(r.body.seats).toEqual(['A1']);
    expect(r.body.status).toBe('confirmed');
    expect(r.body.user_id).toBe(1);
    expect(r.body.amount_paise).toBe(100);
    // reconciliation
    const g = await request(createApp()).get(`/shows/${sid}`);
    expect(g.body.counts).toMatchObject({ available: 1, confirmed: 1, total: 2 });
  });

  it('second reserve for same seat returns 409 seat_taken', async () => {
    const sid = await createShow(['A1']);
    await request(createApp()).post(`/shows/${sid}/reserve`)
      .set('Authorization', 'Bearer tok_user_1')
      .send({ seats: ['A1'], idempotency_key: 'k1' });
    const r = await request(createApp()).post(`/shows/${sid}/reserve`)
      .set('Authorization', 'Bearer tok_user_2')
      .send({ seats: ['A1'], idempotency_key: 'k2' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('seat_taken');
  });

  it('404 on unknown show', async () => {
    const r = await request(createApp()).post('/shows/01ABCDEFGHIJKLMNOPQRSTUVWX/reserve')
      .set('Authorization', 'Bearer tok_user_1')
      .send({ seats: ['A1'], idempotency_key: 'k1' });
    expect(r.status).toBe(404);
  });

  it('401 without token', async () => {
    const sid = await createShow(['A1']);
    const r = await request(createApp()).post(`/shows/${sid}/reserve`)
      .send({ seats: ['A1'], idempotency_key: 'k1' });
    expect(r.status).toBe(401);
  });

  it('ignores user_id in body (identity is token-derived)', async () => {
    const sid = await createShow(['A1']);
    const r = await request(createApp()).post(`/shows/${sid}/reserve`)
      .set('Authorization', 'Bearer tok_user_3')
      .send({ seats: ['A1'], idempotency_key: 'k1', user_id: 999 });
    expect(r.status).toBe(201);
    expect(r.body.user_id).toBe(3);
  });

  it('reserves multiple seats all-or-nothing (success)', async () => {
    const sid = await createShow(['A1','A2','A3']);
    const r = await request(createApp()).post(`/shows/${sid}/reserve`)
      .set('Authorization','Bearer tok_user_1').send({ seats:['A2','A1'], idempotency_key:'k1' });
    expect(r.status).toBe(201);
    expect(r.body.seats).toEqual(['A1','A2']);          // sorted by normalize
    expect(r.body.amount_paise).toBe(200);
  });

  it('rejects whole multi-seat request when one is taken (all-or-nothing)', async () => {
    const sid = await createShow(['A1','A2','A3']);
    await request(createApp()).post(`/shows/${sid}/reserve`)
      .set('Authorization','Bearer tok_user_1').send({ seats:['A2'], idempotency_key:'k1' });
    const r = await request(createApp()).post(`/shows/${sid}/reserve`)
      .set('Authorization','Bearer tok_user_2').send({ seats:['A1','A2','A3'], idempotency_key:'k2' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('seat_taken');
    // A1 and A3 should still be available
    const g = await request(createApp()).get(`/shows/${sid}`);
    const map = Object.fromEntries(g.body.seats.map((s:any)=>[s.seat_id, s.status]));
    expect(map).toEqual({ A1: 'available', A2: 'confirmed', A3: 'available' });
  });

  it('enforces per-user limit (sequential)', async () => {
    const sid = await createShow(['A1','A2','A3','A4','A5'], 2);
    const app = createApp();
    const r1 = await request(app).post(`/shows/${sid}/reserve`)
      .set('Authorization','Bearer tok_user_1').send({ seats:['A1'], idempotency_key:'k1' });
    const r2 = await request(app).post(`/shows/${sid}/reserve`)
      .set('Authorization','Bearer tok_user_1').send({ seats:['A2'], idempotency_key:'k2' });
    const r3 = await request(app).post(`/shows/${sid}/reserve`)
      .set('Authorization','Bearer tok_user_1').send({ seats:['A3'], idempotency_key:'k3' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r3.status).toBe(409);
    expect(r3.body.error).toBe('per_user_limit');
  });

  it('rejects multi-seat request that would exceed limit', async () => {
    const sid = await createShow(['A1','A2','A3','A4','A5'], 2);
    const r = await request(createApp()).post(`/shows/${sid}/reserve`)
      .set('Authorization','Bearer tok_user_1').send({ seats:['A1','A2','A3'], idempotency_key:'k1' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('per_user_limit');
  });
});
