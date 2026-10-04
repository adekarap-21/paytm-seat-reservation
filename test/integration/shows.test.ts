process.env.ADMIN_TOKEN = 'test-admin';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';

describe('shows', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(3); await loadUsers(); });
  beforeEach(async () => {
    // Keep users; wipe shows + seats + reservations
    const { pool } = await import('../../src/db.js');
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('creates a show with admin token', async () => {
    const res = await request(createApp())
      .post('/shows')
      .set('X-Admin-Token', 'test-admin')
      .send({ name: 'f1', price_paise: 25000, per_user_limit: 4, seats: ['A1','A2','A3'] });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res.body.seats.length).toBe(3);
    expect(res.body.seats[0]).toEqual({ seat_id: 'A1', status: 'available' });
  });

  it('reconciles counts in GET', async () => {
    const create = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name: 'f2', price_paise: 100, per_user_limit: 2, seats: ['A1','A2','A3','A4','A5'] });
    const get = await request(createApp()).get(`/shows/${create.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.counts).toEqual({ available: 5, held: 0, confirmed: 0, total: 5 });
    expect(get.body.counts.available + get.body.counts.held + get.body.counts.confirmed)
      .toBe(get.body.counts.total);
  });

  it('rejects duplicate show name with 409', async () => {
    await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name: 'dupe', price_paise: 10, seats: ['A1'] });
    const r = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name: 'dupe', price_paise: 10, seats: ['A1'] });
    expect(r.status).toBe(409);
  });

  it('rejects empty seats with 400', async () => {
    const r = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name: 'empty', price_paise: 10, seats: [] });
    expect(r.status).toBe(400);
  });

  it('rejects duplicate seat ids in body with 400', async () => {
    const r = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name: 'dup-seats', price_paise: 10, seats: ['A1','A1','A2'] });
    expect(r.status).toBe(400);
  });

  // Review Focus #4
  it('test_create_show_requires_admin_token', async () => {
    const r = await request(createApp()).post('/shows')
      .send({ name: 'no-admin', price_paise: 10, seats: ['A1'] });
    expect(r.status).toBe(401);
    // Also verify no show was inserted
    const { pool } = await import('../../src/db.js');
    const [rows] = await pool.query<any[]>('SELECT COUNT(*) AS c FROM shows WHERE name=?', ['no-admin']);
    expect(rows[0].c).toBe(0);
  });

  it('404 on GET for unknown show id', async () => {
    const r = await request(createApp()).get('/shows/01ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(r.status).toBe(404);
  });
});
