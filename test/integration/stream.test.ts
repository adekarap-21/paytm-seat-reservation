process.env.ADMIN_TOKEN = 'test-admin';
import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';

async function post(url: string, body: any, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}

describe('SSE stream', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(3); await loadUsers(); });

  it('receives baseline on connect and a seat event after a reserve', async () => {
    const server = http.createServer(createApp()).listen(0);
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;

    const show = await post(`${base}/shows`, { name: 'ss', price_paise: 1, per_user_limit: 4, seats: ['A1', 'A2'] },
      { 'X-Admin-Token': 'test-admin' });
    const sid = show.body.id;

    const events: any[] = [];
    const abort = new AbortController();
    const streamP = (async () => {
      const res = await fetch(`${base}/shows/${sid}/stream`, { signal: abort.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const p of parts) {
          const line = p.split('\n').find(l => l.startsWith('data:'));
          if (line) events.push(JSON.parse(line.slice(5).trim()));
        }
      }
    })();

    // give baseline a moment, then reserve
    await new Promise(r => setTimeout(r, 100));
    await post(`${base}/shows/${sid}/reserve`,
      { seats: ['A1'], idempotency_key: 'k' }, { 'Authorization': 'Bearer tok_user_1' });
    await new Promise(r => setTimeout(r, 150));
    abort.abort();
    try { await streamP; } catch { /* AbortError */ }
    server.close();

    expect(events.some(e => e.type === 'baseline')).toBe(true);
    expect(events.some(e => e.type === 'seat' && e.seat_id === 'A1' && e.status === 'confirmed')).toBe(true);
  }, 10000);
});
