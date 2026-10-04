import { pool } from '../../src/db.js';

export async function truncateAll(): Promise<void> {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  await pool.query('TRUNCATE TABLE reservation_seats');
  await pool.query('TRUNCATE TABLE reservations');
  await pool.query('TRUNCATE TABLE seats');
  await pool.query('TRUNCATE TABLE shows');
  await pool.query('TRUNCATE TABLE users');
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
}

export async function seedTestUsers(n: number): Promise<Array<{id:number, token:string}>> {
  const rows: Array<{id:number, token:string}> = [];
  for (let i = 1; i <= n; i++) {
    const token = `tok_user_${i}`;
    rows.push({ id: i, token });
    await pool.query('INSERT INTO users (id, token, display_name) VALUES (?, ?, ?)',
      [i, token, `u_${i}`]);
  }
  return rows;
}
