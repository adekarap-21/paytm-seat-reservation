import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';

describe('db', () => {
  beforeAll(async () => { await truncateAll(); });
  afterAll(async () => { await pool.end(); });

  it('seeds users and reads them back', async () => {
    const seeded = await seedTestUsers(3);
    const [rows] = await pool.query<any[]>('SELECT id, token FROM users ORDER BY id');
    expect(rows.length).toBe(3);
    expect(rows[0].token).toBe('tok_user_1');
    expect(seeded.length).toBe(3);
  });
});
