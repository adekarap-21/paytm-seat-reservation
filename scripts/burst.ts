import { Pool } from 'undici';
import { readFileSync } from 'node:fs';
import { ulid } from 'ulid';

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080';
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin';
const USERS = JSON.parse(readFileSync('seed/users.json', 'utf-8')) as Array<{ id: number; token: string }>;

const pool = new Pool(BASE, { connections: 100, pipelining: 1 });

async function req(
  path: string,
  opts: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown } = { method: 'GET' },
) {
  const res = await pool.request({
    path,
    method: opts.method,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.body.json().catch(() => ({}));
  return { status: res.statusCode, body: body as Record<string, unknown> };
}

async function createShow() {
  const seats: string[] = [];
  for (const row of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
    for (let i = 1; i <= 20; i++) seats.push(`${row}${i}`);
  }
  const r = await req('/shows', {
    method: 'POST',
    headers: { 'X-Admin-Token': ADMIN },
    body: { name: `burst_${Date.now()}`, price_paise: 25000, per_user_limit: 4, seats },
  });
  if (r.status !== 201) throw new Error(`create show failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id as string, seats };
}

async function hotSeatBurst(sid: string, seat: string, n: number) {
  return Promise.all(
    Array.from({ length: n }, (_, i) => {
      const u = USERS[i % USERS.length]!;
      return req(`/shows/${sid}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${u.token}` },
        body: { seats: [seat], idempotency_key: ulid() },
      });
    }),
  );
}

async function randomBurst(sid: string, seats: string[], n: number) {
  return Promise.all(
    Array.from({ length: n }, (_, i) => {
      const u = USERS[i % USERS.length]!;
      const s = seats[Math.floor(Math.random() * seats.length)]!;
      return req(`/shows/${sid}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${u.token}` },
        body: { seats: [s], idempotency_key: ulid() },
      });
    }),
  );
}

async function idemReplayBurst(sid: string, seat: string, n: number, key = ulid()) {
  const u = USERS[0]!;
  return Promise.all(
    Array.from({ length: n }, () =>
      req(`/shows/${sid}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${u.token}` },
        body: { seats: [seat], idempotency_key: key },
      }),
    ),
  );
}

function tally(results: Array<{ status: number; body: Record<string, unknown> }>) {
  const t: Record<string, number> = { confirmed_201: 0, replay_200: 0 };
  let srv = 0;
  for (const r of results) {
    if (r.status === 201) t.confirmed_201++;
    else if (r.status === 200) t.replay_200++;
    else if (r.status >= 500) {
      srv++;
      console.error('5xx:', r.status, r.body);
    } else {
      const key = `${r.status}_${(r.body?.error as string) ?? 'unknown'}`;
      t[key] = (t[key] ?? 0) + 1;
    }
  }
  return { tally: t, server_errors_5xx: srv };
}

async function main() {
  console.log(`burst against ${BASE}`);
  await req('/readyz');

  const { id: sid, seats } = await createShow();
  console.log(`show id: ${sid}, seats: ${seats.length}`);

  console.log('--- scenario 1: hot-seat storm (500 users on A1) ---');
  const hot = await hotSeatBurst(sid, 'A1', 500);
  const hotResult = tally(hot);
  console.log(JSON.stringify(hotResult, null, 2));

  // Pre-reserve J20 for user tok_user_1 before the random burst fills every seat.
  // This guarantees the idem replay (scenario 3) has a known confirmed reservation to replay.
  const idemSeat = 'J20';
  const preKey = ulid();
  await req(`/shows/${sid}/reserve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${USERS[0]!.token}` },
    body: { seats: [idemSeat], idempotency_key: preKey },
  });

  // ponytail: 10000 random reserves on 198 seats (A1 + J20 excluded); reduce to 2000 if needed
  const randomSeats = seats.filter((s) => s !== 'A1' && s !== idemSeat);
  console.log(`--- scenario 2: random burst (10000 reserves on ${randomSeats.length} seats) ---`);
  const rand = await randomBurst(sid, randomSeats, 10000);
  const randResult = tally(rand);
  console.log(JSON.stringify(randResult, null, 2));

  // Scenario 3: user tok_user_1 replays the same idempotency key → 1x201, 49x200
  console.log('--- scenario 3: idempotent replay (50 retries same key on J20) ---');
  const idem = await idemReplayBurst(sid, idemSeat, 50, preKey);
  const idemResult = tally(idem);
  console.log(JSON.stringify(idemResult, null, 2));

  const state = await req(`/shows/${sid}`);
  const c = state.body.counts as { available: number; held: number; confirmed: number; total: number };
  console.log('--- final reconciliation ---');
  console.log(JSON.stringify(c, null, 2));

  const allSrvErrors = hotResult.server_errors_5xx + randResult.server_errors_5xx + idemResult.server_errors_5xx;
  const balanced = c.available + c.held + c.confirmed === c.total;

  if (allSrvErrors > 0) {
    console.error(`FAIL: ${allSrvErrors} server errors (5xx)`);
  }
  if (!balanced) {
    console.error(`FAIL: seat count drift (available+held+confirmed=${c.available + c.held + c.confirmed} != total=${c.total})`);
  }

  if (balanced && allSrvErrors === 0) {
    console.log('OK reconciled, 0 server errors');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
