process.env.ADMIN_TOKEN = 'test-admin';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool, withTx } from '../../src/db.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { reserve } from '../../src/domain/reserve.js';
import { loadUsers } from '../../src/auth.js';
import { ConflictError } from '../../src/domain/errors.js';
import request from 'supertest';
import { createApp } from '../../src/server.js';

describe('lock-wait timeout', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(3); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('test_lock_wait_timeout_returns_409', async () => {
    const create = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name: 'lw', price_paise: 1, per_user_limit: 4, seats: ['A1'] });
    const sid = create.body.id;

    // Hold a lock on seat A1 for > 2s inside a tx (innodb_lock_wait_timeout=2 globally)
    const held = withTx(async (conn) => {
      await conn.query(`UPDATE seats SET updated_at=NOW(3) WHERE show_id=? AND seat_id='A1'`, [sid]);
      await new Promise((r) => setTimeout(r, 2500));
    });
    // While lock is held, another reserve attempt should hit lock-wait and come back as 409 seat_taken
    await new Promise((r) => setTimeout(r, 100));
    const r = await request(createApp()).post(`/shows/${sid}/reserve`)
      .set('Authorization','Bearer tok_user_1')
      .send({ seats: ['A1'], idempotency_key: 'lw1' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('seat_taken');
    await held;
  }, 10000);
});
