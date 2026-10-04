import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  uri: config.databaseUrl,
  connectionLimit: 20,
  waitForConnections: true,
  queueLimit: 0,
  namedPlaceholders: false,
  timezone: 'Z',
  dateStrings: false,
});

export async function withTx<T>(fn: (conn: mysql.PoolConnection) => Promise<T>, retries = 5): Promise<T> {
  // ponytail: retry on deadlock up to 3 times; per-row lock ordering upgrade if throughput matters
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (e: any) {
      try { await conn.rollback(); } catch {}
      if (e?.code === 'ER_LOCK_DEADLOCK' && attempt < retries) { last = e; continue; }
      throw e;
    } finally {
      conn.release();
    }
  }
  throw last;
}
