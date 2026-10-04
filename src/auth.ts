import { pool } from './db.js';

const tokenToUserId = new Map<string, number>();

export async function loadUsers(): Promise<void> {
  tokenToUserId.clear();
  const [rows] = await pool.query<any[]>('SELECT id, token FROM users');
  for (const r of rows) tokenToUserId.set(r.token, r.id);
}

export function userIdForToken(token: string): number | undefined {
  return tokenToUserId.get(token);
}
