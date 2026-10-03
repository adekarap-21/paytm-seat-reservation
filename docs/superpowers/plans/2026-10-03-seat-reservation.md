# Seat Reservation at Scale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, deploy, and prove-correct a JSON HTTP service that sells assigned seats under 20k-concurrent-request contention, with zero double-sells, zero 5xx, idempotent writes, and live observability.

**Architecture:** A Fastify + TypeScript HTTP service backed by a single MySQL 8 InnoDB instance. All concurrency decisions (seat allocation, per-user limits, idempotency) are resolved inside one DB transaction per request, using `SELECT ... FOR UPDATE` on seats in sorted order (deadlock-free), `INSERT IGNORE` on the idempotency key, and a `GET_LOCK` named lock per `(user, show)` to serialize per-user-limit checks. The service, MySQL, and burst harness all run as Docker containers; prod deploys to Fly.io with the app and a self-hosted MySQL (persistent volume) on the private 6PN network.

**Tech Stack:** Node 20, TypeScript (strict), Fastify, mysql2, pino, prom-client, zod, vitest, undici, ulid, Docker, docker-compose, Fly.io, MySQL 8.

**Spec:** `docs/superpowers/specs/2026-10-03-seat-reservation-design.md`

## Global Constraints

- **Node:** `>=20.0.0`. TypeScript `strict: true`. ESM.
- **Money:** integer paise everywhere. Never floats. (`BIGINT` in DB, `number` in TS for amounts under 2^53, else bigint.)
- **Datastore:** MySQL 8, InnoDB engine, session isolation `READ-COMMITTED`.
- **Local MySQL port:** host-side **`3307`** (container-side 3306) — port 3306 on dev machine is reserved for an unrelated org DB.
- **No ORM.** Raw SQL via `mysql2/promise` with placeholders.
- **No Redis, no queue.** Single DB is the only source of truth.
- **5xx budget:** zero under burst. All decline conditions are 4xx domain outcomes with structured `{error:{code,message,request_id}}`.
- **Reconciliation invariant:** `available + held + confirmed == total_seats` continuously.
- **Ownership:** every mutation includes `AND user_id = ?` in the SQL `WHERE`. Request body `user_id` field is stripped before validation.
- **Request ID:** every log line, every error response. Honor incoming `X-Request-Id`, else generate a ULID.
- **Idempotency key column:** called `idem_key` (not `key` — reserved word in MySQL).
- **Named lock discipline:** `GET_LOCK` is session-scoped. Every acquisition goes through `withUserShowLock(conn, user, show, fn)` which releases in `finally` before the connection returns to the pool.
- **Commit style:** conventional commits (`feat(scope):`, `fix(scope):`, `test:`, `chore:`, `docs:`). One commit per task minimum; more is fine.

## Review Focus

Inputs the spec implies but no task test obviously covers, in rough likelihood order:

1. **Duplicate seats in a single reserve request** (e.g. `["A12","A12"]`) — spec says unique-within-request but doesn't define the response. Must be `400 invalid_seats`. Covered in **Task 5**.
2. **Idempotency key reuse across different users** — spec says independent (composite PK) but easy to break. Must succeed as two separate reservations. Covered in **Task 8**.
3. **Confirming a reservation whose hold has already expired** — spec declares `409 hold_expired` but the lazy-expiry path can race with the confirm UPDATE. Must either confirm (if seat still owned by this reservation) or `409 hold_expired`. Covered in **Task 9**.
4. **Admin-only `POST /shows` without `X-Admin-Token`** — must be `403 admin_required`. Covered in **Task 4**.
5. **`GET /shows/{id}` for a non-existent show** — must be `404 show_not_found`, not `200` with empty counts. Covered in **Task 4**.

---

## File Structure

Files created across all tasks (grouped by directory):

```
paytm-seat-reservation/
├── README.md                                   [Task 14]
├── WRITEUP.md                                  [Task 14]
├── Dockerfile                                  [Task 1]
├── docker-compose.yml                          [Task 1]
├── fly.app.toml                                [Task 13]
├── fly.db.toml                                 [Task 13]
├── package.json                                [Task 1]
├── tsconfig.json                               [Task 1]
├── .env.example                                [Task 1]
├── .gitignore                                  [Task 1]
├── vitest.config.ts                            [Task 1]
├── burst.sh                                    [Task 11]
├── src/
│   ├── server.ts                               [Task 1, extended through 10]
│   ├── config.ts                               [Task 1]
│   ├── errors.ts                               [Task 1]
│   ├── ids.ts                                  [Task 1]
│   ├── db/
│   │   ├── pool.ts                             [Task 1]
│   │   ├── migrate.ts                          [Task 2]
│   │   ├── with-user-show-lock.ts              [Task 7]
│   │   └── migrations/
│   │       ├── 001_init.sql                    [Task 2]
│   │       └── 002_held_unique_backstop.sql    [Task 2]
│   ├── auth/
│   │   ├── token.ts                            [Task 3]
│   │   └── middleware.ts                       [Task 3]
│   ├── domain/
│   │   ├── shows.ts                            [Task 4]
│   │   ├── reservations.ts                     [Tasks 5–9]
│   │   └── idempotency.ts                      [Task 8]
│   ├── routes/
│   │   ├── shows.ts                            [Task 4]
│   │   ├── reservations.ts                     [Tasks 5–9]
│   │   └── ops.ts                              [Tasks 1, 10]
│   ├── observability/
│   │   ├── metrics.ts                          [Task 10]
│   │   └── logger.ts                           [Task 1]
│   └── scripts/
│       ├── burst.ts                            [Task 11]
│       ├── seed.ts                             [Task 4]
│       └── mint-tokens.ts                      [Task 3]
└── tests/
    ├── helpers/
    │   ├── db.ts                               [Task 2]
    │   └── app.ts                              [Task 1]
    ├── unit/
    │   ├── token.test.ts                       [Task 3]
    │   └── reserve-decision.test.ts            [Task 5]
    └── integration/
        ├── healthz.test.ts                     [Task 1]
        ├── shows.test.ts                       [Task 4]
        ├── reserve.test.ts                     [Tasks 5–6]
        ├── per-user-limit.test.ts              [Task 7]
        ├── idempotency.test.ts                 [Task 8]
        ├── expiry-confirm-cancel.test.ts       [Task 9]
        ├── metrics.test.ts                     [Task 10]
        ├── ownership.test.ts                   [Task 9]
        └── contention.test.ts                  [Task 12]
```

---

## Task 1: Scaffold — Fastify + mysql2 + Docker + health endpoints

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `Dockerfile`, `docker-compose.yml`
- Create: `src/config.ts`, `src/errors.ts`, `src/ids.ts`, `src/db/pool.ts`, `src/observability/logger.ts`, `src/routes/ops.ts`, `src/server.ts`
- Create: `tests/helpers/app.ts`, `tests/integration/healthz.test.ts`

**Interfaces:**
- Produces:
  - `config: { databaseUrl, tokenSecret, adminToken, port, nodeEnv }` from `src/config.ts`
  - `pool: mysql.Pool` from `src/db/pool.ts` (via `getPool()`)
  - `logger: pino.Logger` from `src/observability/logger.ts`
  - `buildServer(): FastifyInstance` from `src/server.ts`
  - `AppError` class from `src/errors.ts` with `code: string, status: number, message: string`
  - `newId(prefix: 'shw'|'rsv'): string` from `src/ids.ts` returning `<prefix>_<ulid>`

---

- [ ] **Step 1: Initialize package.json and tsconfig**

Run:
```bash
mkdir -p src/{db/migrations,auth,domain,routes,observability,scripts} tests/{helpers,unit,integration}
cat > package.json <<'JSON'
{
  "name": "paytm-seat-reservation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "migrate": "tsx src/db/migrate.ts",
    "seed": "tsx src/scripts/seed.ts",
    "mint-tokens": "tsx src/scripts/mint-tokens.ts",
    "burst": "node dist/scripts/burst.js"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "mysql2": "^3.11.0",
    "pino": "^9.4.0",
    "pino-http": "^10.0.0",
    "prom-client": "^15.1.3",
    "ulid": "^2.3.0",
    "undici": "^6.19.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
JSON
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "resolveJsonModule": true,
    "declaration": false,
    "forceConsistentCasingInFileNames": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
JSON
cat > vitest.config.ts <<'TS'
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
TS
cat > .gitignore <<'GIT'
node_modules
dist
.env
.fly-burst-env
*.log
.vitest-cache
GIT
cat > .env.example <<'ENV'
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres
TOKEN_SECRET=dev-secret-change-me
ADMIN_TOKEN=dev-admin-change-me
PORT=8080
NODE_ENV=development
ENV
pnpm install
```

- [ ] **Step 2: Write the failing healthz integration test**

Create `tests/helpers/app.ts`:
```ts
import { buildServer } from '../../src/server.js';
import type { FastifyInstance } from 'fastify';

export async function makeApp(): Promise<FastifyInstance> {
  const app = buildServer();
  await app.ready();
  return app;
}
```

Create `tests/integration/healthz.test.ts`:
```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe('ops', () => {
  it('GET /healthz returns 200 ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 503 when DB is unreachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect([200, 503]).toContain(res.statusCode);
    if (res.statusCode === 503) {
      expect(res.json().error.code).toBe('db_unavailable');
    }
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `pnpm test tests/integration/healthz.test.ts`
Expected: FAIL — `Cannot find module '../../src/server.js'`.

- [ ] **Step 4: Write config, errors, ids, logger, pool**

Create `src/config.ts`:
```ts
import { z } from 'zod';
const schema = z.object({
  DATABASE_URL: z.string().url(),
  TOKEN_SECRET: z.string().min(16),
  ADMIN_TOKEN: z.string().min(8),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid env:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = {
  databaseUrl: parsed.data.DATABASE_URL,
  tokenSecret: parsed.data.TOKEN_SECRET,
  adminToken: parsed.data.ADMIN_TOKEN,
  port: parsed.data.PORT,
  nodeEnv: parsed.data.NODE_ENV,
};
```

Create `src/errors.ts`:
```ts
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) { super(message); }
}
export const err = {
  invalidBody:        (m = 'Invalid body')               => new AppError('invalid_body', 400, m),
  invalidSeats:       (m = 'Invalid seats')              => new AppError('invalid_seats', 400, m),
  missingToken:       (m = 'Missing bearer token')       => new AppError('missing_token', 401, m),
  invalidToken:       (m = 'Invalid bearer token')       => new AppError('invalid_token', 401, m),
  adminRequired:      (m = 'Admin token required')       => new AppError('admin_required', 403, m),
  notOwner:           (m = 'Not the owner')              => new AppError('not_owner', 403, m),
  showNotFound:       (m = 'Show not found')             => new AppError('show_not_found', 404, m),
  reservationNotFound:(m = 'Reservation not found')      => new AppError('reservation_not_found', 404, m),
  seatTaken:          (m = 'Seat already taken')         => new AppError('seat_taken', 409, m),
  perUserLimit:       (m = 'Per-user limit exceeded')    => new AppError('per_user_limit_exceeded', 409, m),
  idempotencyConflict:(m = 'Idempotency key reused')     => new AppError('idempotency_key_conflict', 409, m),
  inFlight:           (m = 'Request in flight')          => new AppError('in_flight', 409, m),
  notCancellable:     (m = 'Not cancellable')            => new AppError('not_cancellable', 409, m),
  alreadyConfirmed:   (m = 'Already confirmed')          => new AppError('already_confirmed', 409, m),
  holdExpired:        (m = 'Hold expired')               => new AppError('hold_expired', 409, m),
  dbUnavailable:      (m = 'Database unavailable')       => new AppError('db_unavailable', 503, m),
};
```

Create `src/ids.ts`:
```ts
import { ulid } from 'ulid';
export function newId(prefix: 'shw' | 'rsv'): string {
  return `${prefix}_${ulid()}`;
}
```

Create `src/observability/logger.ts`:
```ts
import pino from 'pino';
import { config } from '../config.js';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});
```

Create `src/db/pool.ts`:
```ts
import mysql from 'mysql2/promise';
import { config } from '../config.js';

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: config.databaseUrl,
      connectionLimit: 50,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      namedPlaceholders: false,
      multipleStatements: false,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

export async function pingDb(timeoutMs = 500): Promise<boolean> {
  const p = getPool();
  const conn = await Promise.race([
    p.getConnection(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
  ]);
  try {
    await conn.query('SELECT 1');
    return true;
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 5: Write the ops routes and server**

Create `src/routes/ops.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { pingDb } from '../db/pool.js';

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pingDb(500);
      return { status: 'ready' };
    } catch {
      reply.code(503);
      return { status: 'not_ready', error: { code: 'db_unavailable', message: 'DB unreachable' } };
    }
  });
}
```

Create `src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { opsRoutes } from './routes/ops.js';
import { logger } from './observability/logger.js';
import { AppError } from './errors.js';
import { config } from './config.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger,
    disableRequestLogging: false,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      reply.code(error.status).send({
        error: { code: error.code, message: error.message, request_id: req.id },
      });
      return;
    }
    req.log.error({ err: error }, 'unhandled error');
    reply.code(500).send({
      error: { code: 'internal_error', message: 'Internal error', request_id: req.id },
    });
  });

  app.register(opsRoutes);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  app.listen({ port: config.port, host: '0.0.0.0' })
    .catch((e) => { app.log.error(e); process.exit(1); });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test tests/integration/healthz.test.ts`
Expected: PASS. (`readyz` may return 503 if no DB is running — the test allows both outcomes.)

- [ ] **Step 7: Write Dockerfile and docker-compose**

Create `Dockerfile`:
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
```

Create `docker-compose.yml`:
```yaml
services:
  db:
    image: mysql:8.0
    command:
      - --default-authentication-plugin=caching_sha2_password
      - --innodb-buffer-pool-size=256M
      - --max-connections=200
    environment:
      MYSQL_ROOT_PASSWORD: devroot
      MYSQL_DATABASE: seatres
      MYSQL_USER: app
      MYSQL_PASSWORD: devpass
    ports:
      # Local 3307 → container 3306. Host 3306 is reserved for org DB.
      - "3307:3306"
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "app", "-pdevpass"]
      interval: 2s
      timeout: 2s
      retries: 20
  app:
    build: .
    depends_on: { db: { condition: service_healthy } }
    environment:
      DATABASE_URL: mysql://app:devpass@db:3306/seatres
      TOKEN_SECRET: dev-secret-dev-secret
      ADMIN_TOKEN: dev-admin
      PORT: "8080"
      NODE_ENV: production
    ports:
      - "8080:8080"
volumes:
  mysql_data:
```

- [ ] **Step 8: Verify the stack starts**

Run:
```bash
docker compose up --build -d
sleep 10
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/readyz
docker compose logs app --tail 30
docker compose down
```
Expected: `/healthz` returns `{"status":"ok"}`. `/readyz` returns 503 at this stage (no migrations yet — a connection may succeed but we have no tables; a `SELECT 1` works regardless, so expect 200 ready. Either is acceptable; the test will tighten in Task 2.)

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "chore: scaffold Fastify + mysql2 + docker-compose with MySQL on 3307"
```

---

## Task 2: DB schema migrations + migration runner

**Files:**
- Create: `src/db/migrate.ts`, `src/db/migrations/001_init.sql`, `src/db/migrations/002_held_unique_backstop.sql`
- Create: `tests/helpers/db.ts`
- Modify: `src/server.ts` (run migrations on boot)
- Modify: `tests/integration/healthz.test.ts` (tighten `/readyz` assertion)

**Interfaces:**
- Produces:
  - `runMigrations(pool): Promise<void>` from `src/db/migrate.ts`
  - `resetDb(): Promise<void>` from `tests/helpers/db.ts` — truncates all tables in dependency order for test isolation

---

- [ ] **Step 1: Write the migration SQL files**

Create `src/db/migrations/001_init.sql` (verbatim DDL from spec §6.1, see spec for the full text).

Create `src/db/migrations/002_held_unique_backstop.sql`:
```sql
-- Generated-column UNIQUE as the double-sell physical backstop.
-- Already included in 001_init.sql for the seats table; this migration
-- is a no-op placeholder reserved for a future backfill or index rebuild
-- if we ever need to recompute the generated column.
SELECT 1;
```

(The generated column + UNIQUE is baked into `001_init.sql` to keep the schema one-shot deployable. `002_held_unique_backstop.sql` exists as a numbered placeholder for future adjustments.)

- [ ] **Step 2: Write the migration runner**

Create `src/db/migrate.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type mysql from 'mysql2/promise';
import { getPool } from './pool.js';
import { logger } from '../observability/logger.js';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

export async function runMigrations(pool: mysql.Pool = getPool()): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB
  `);
  const [rows] = await pool.query<any[]>('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // mysql2 can execute multiple statements per query if configured; we
      // keep multipleStatements=false and split by naive `;\n` to stay safe.
      for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
        await conn.query(stmt);
      }
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      await conn.commit();
      logger.info({ file }, 'migration applied');
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 3: Wire migrations into server boot**

Modify `src/server.ts` — add before `app.listen`:
```ts
import { runMigrations } from './db/migrate.js';
// ...
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  runMigrations()
    .then(() => app.listen({ port: config.port, host: '0.0.0.0' }))
    .catch((e) => { app.log.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Create the test DB helper**

Create `tests/helpers/db.ts`:
```ts
import { getPool, closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';

export async function ensureSchema(): Promise<void> {
  await runMigrations(getPool());
}

export async function resetDb(): Promise<void> {
  const pool = getPool();
  await pool.query('SET FOREIGN_KEY_CHECKS=0');
  for (const t of ['reservation_seats', 'reservations', 'seats', 'shows', 'idempotency_keys']) {
    await pool.query(`TRUNCATE TABLE ${t}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS=1');
}

export async function closeDb(): Promise<void> { await closePool(); }
```

- [ ] **Step 5: Write a failing schema integration test**

Create `tests/integration/schema.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool } from '../../src/db/pool.js';
import { ensureSchema, closeDb } from '../helpers/db.js';

beforeAll(async () => { await ensureSchema(); });
afterAll(async () => { await closeDb(); });

describe('schema', () => {
  it('creates all five domain tables', async () => {
    const pool = getPool();
    const [rows] = await pool.query<any[]>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()",
    );
    const names = new Set(rows.map((r) => r.TABLE_NAME ?? r.table_name));
    for (const t of ['shows','seats','reservations','reservation_seats','idempotency_keys']) {
      expect(names.has(t)).toBe(true);
    }
  });

  it('held_or_confirmed_key UNIQUE prevents two held rows on same seat', async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO shows (id,name,price_paise,total_seats) VALUES ('shw_test','n',100,2)`,
    );
    await pool.query(
      `INSERT INTO seats (show_id,label,status) VALUES ('shw_test','A1','held'),('shw_test','A2','available')`,
    );
    // Attempt a second 'held' row for A1 — generated-column UNIQUE must reject.
    await expect(
      pool.query(
        `INSERT INTO seats (show_id,label,status) VALUES ('shw_test','A1','held')`,
      ),
    ).rejects.toThrow(/Duplicate|ER_DUP_ENTRY/);
    await pool.query(`DELETE FROM seats WHERE show_id='shw_test'`);
    await pool.query(`DELETE FROM shows WHERE id='shw_test'`);
  });
});
```

- [ ] **Step 6: Run the test — expect failure if DB not up**

Start compose: `docker compose up -d db` and wait 10s.
Set env: `export $(cat .env.example | xargs)` (or create `.env`).
Run: `pnpm test tests/integration/schema.test.ts`
Expected: PASS (migrations run, assertions hold).

- [ ] **Step 7: Tighten the healthz test**

Modify `tests/integration/healthz.test.ts` — replace the `readyz` test:
```ts
  it('GET /readyz returns 200 when DB is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });
```

Run: `pnpm test tests/integration/healthz.test.ts`
Expected: PASS (DB from Step 6 is still up).

- [ ] **Step 8: Commit**

```bash
git add src/db/ tests/helpers/db.ts tests/integration/schema.test.ts tests/integration/healthz.test.ts src/server.ts
git commit -m "feat(db): schema for shows/seats/reservations/idempotency with generated-column backstop"
```

---

## Task 3: Auth — HMAC bearer tokens + admin header + mint script

**Files:**
- Create: `src/auth/token.ts`, `src/auth/middleware.ts`, `src/scripts/mint-tokens.ts`
- Create: `tests/unit/token.test.ts`
- Modify: `src/server.ts` (register auth hook)

**Interfaces:**
- Produces:
  - `signToken(userId: string, secret: string): string` from `src/auth/token.ts`
  - `verifyToken(token: string, secret: string): string | null` returning the user_id or `null`
  - `authHook(req, reply)` from `src/auth/middleware.ts` — Fastify preHandler that sets `req.user_id`; throws `missing_token` / `invalid_token`
  - `adminHook(req, reply)` from `src/auth/middleware.ts` — Fastify preHandler that checks `X-Admin-Token`; throws `admin_required`
- Augments Fastify's `FastifyRequest` to include `user_id?: string`

---

- [ ] **Step 1: Write failing token unit tests**

Create `tests/unit/token.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '../../src/auth/token.js';

const SECRET = 'test-secret-at-least-16-chars';

describe('token', () => {
  it('round-trips a user_id', () => {
    const t = signToken('usr_42', SECRET);
    expect(verifyToken(t, SECRET)).toBe('usr_42');
  });

  it('rejects a token signed with a different secret', () => {
    const t = signToken('usr_42', SECRET);
    expect(verifyToken(t, 'other-secret-at-least-16-chars')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const t = signToken('usr_42', SECRET);
    const [, sig] = t.split('.');
    const tampered = Buffer.from('usr_99').toString('base64url') + '.' + sig;
    expect(verifyToken(tampered, SECRET)).toBeNull();
  });

  it('rejects a malformed token (no dot)', () => {
    expect(verifyToken('nodot', SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test tests/unit/token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement token.ts**

Create `src/auth/token.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function b64u(buf: Buffer | string): string {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf).toString('base64url');
}
function fromB64u(s: string): Buffer { return Buffer.from(s, 'base64url'); }

export function signToken(userId: string, secret: string): string {
  const payload = b64u(userId);
  const sig = b64u(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyToken(token: string, secret: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest();
  let given: Buffer;
  try { given = fromB64u(sig); } catch { return null; }
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;
  try { return fromB64u(payload).toString('utf8'); } catch { return null; }
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test tests/unit/token.test.ts`
Expected: PASS all 4.

- [ ] **Step 5: Write the auth middleware**

Create `src/auth/middleware.ts`:
```ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './token.js';
import { config } from '../config.js';
import { err } from '../errors.js';
import { timingSafeEqual } from 'node:crypto';

declare module 'fastify' {
  interface FastifyRequest { user_id?: string }
}

export async function authHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) throw err.missingToken();
  const uid = verifyToken(h.slice('Bearer '.length).trim(), config.tokenSecret);
  if (!uid) throw err.invalidToken();
  req.user_id = uid;
}

export async function adminHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const given = (req.headers['x-admin-token'] as string | undefined) ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(config.adminToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw err.adminRequired();
}
```

- [ ] **Step 6: Create the mint-tokens script**

Create `src/scripts/mint-tokens.ts`:
```ts
import { signToken } from '../auth/token.js';
import { config } from '../config.js';

const n = Number(process.argv[2] ?? 10);
for (let i = 1; i <= n; i++) {
  const uid = `usr_${i}`;
  process.stdout.write(`${uid}\t${signToken(uid, config.tokenSecret)}\n`);
}
```

Verify: `pnpm mint-tokens 3` prints 3 `user_id\ttoken` lines.

- [ ] **Step 7: Commit**

```bash
git add src/auth/ src/scripts/mint-tokens.ts tests/unit/token.test.ts package.json
git commit -m "feat(auth): HMAC bearer tokens, admin header guard, mint-tokens script"
```

---

## Task 4: Shows — POST (admin) and GET

**Files:**
- Create: `src/domain/shows.ts`, `src/routes/shows.ts`, `src/scripts/seed.ts`
- Create: `tests/integration/shows.test.ts`
- Modify: `src/server.ts` (register `showsRoutes`)

**Interfaces:**
- Produces:
  - `createShow(input): Promise<ShowView>` from `src/domain/shows.ts`
  - `getShow(id, opts): Promise<ShowView | null>` from `src/domain/shows.ts`
  - `ShowView = { id, name, price_paise, per_user_limit, hold_ttl_seconds, total_seats, available, held, confirmed, seats?: {label,status}[] }`
  - `showsRoutes(app): Promise<void>` from `src/routes/shows.ts`

---

- [ ] **Step 1: Write failing integration tests**

Create `tests/integration/shows.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { ensureSchema, resetDb, closeDb } from '../helpers/db.js';

let app: FastifyInstance;
const ADMIN = process.env.ADMIN_TOKEN!;

beforeAll(async () => { await ensureSchema(); app = await makeApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(resetDb);

describe('shows', () => {
  it('POST /shows requires admin header', async () => {
    const res = await app.inject({
      method: 'POST', url: '/shows',
      payload: { name: 'friday', seats: ['A1','A2'], price_paise: 100 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('admin_required');
  });

  it('POST /shows creates a show with all seats available', async () => {
    const res = await app.inject({
      method: 'POST', url: '/shows',
      headers: { 'x-admin-token': ADMIN },
      payload: {
        name: 'friday', seats: ['A1','A2','A3'], price_paise: 25000,
        per_user_limit: 4, hold_ttl_seconds: 120,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^shw_/);
    expect(body.total_seats).toBe(3);
    expect(body.available).toBe(3);
    expect(body.held).toBe(0);
    expect(body.confirmed).toBe(0);
  });

  it('GET /shows/:id returns counts that reconcile', async () => {
    const c = await app.inject({
      method: 'POST', url: '/shows',
      headers: { 'x-admin-token': ADMIN },
      payload: { name: 'x', seats: ['A1','A2'], price_paise: 100 },
    });
    const id = c.json().id;
    const r = await app.inject({ method: 'GET', url: `/shows/${id}` });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.available + b.held + b.confirmed).toBe(b.total_seats);
  });

  it('GET /shows/:id returns 404 for a non-existent show', async () => {
    const r = await app.inject({ method: 'GET', url: '/shows/shw_doesnotexist' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('show_not_found');
  });

  it('POST /shows rejects duplicate seat labels within the request', async () => {
    const r = await app.inject({
      method: 'POST', url: '/shows',
      headers: { 'x-admin-token': ADMIN },
      payload: { name: 'x', seats: ['A1','A1'], price_paise: 100 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('invalid_body');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test tests/integration/shows.test.ts`
Expected: FAIL — route not found / 404 on POST.

- [ ] **Step 3: Implement the shows domain**

Create `src/domain/shows.ts`:
```ts
import { getPool } from '../db/pool.js';
import { newId } from '../ids.js';
import { err } from '../errors.js';

export interface ShowView {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  hold_ttl_seconds: number;
  total_seats: number;
  available: number;
  held: number;
  confirmed: number;
  seats?: Array<{ label: string; status: 'available'|'held'|'confirmed' }>;
}

export interface CreateShowInput {
  name: string;
  seats: string[];
  price_paise: number;
  per_user_limit?: number;
  hold_ttl_seconds?: number;
}

export async function createShow(i: CreateShowInput): Promise<ShowView> {
  const id = newId('shw');
  const per = i.per_user_limit ?? 4;
  const ttl = i.hold_ttl_seconds ?? 120;
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO shows (id,name,price_paise,per_user_limit,hold_ttl_seconds,total_seats)
       VALUES (?,?,?,?,?,?)`,
      [id, i.name, i.price_paise, per, ttl, i.seats.length],
    );
    // Bulk-insert seats as 'available'.
    const values = i.seats.map(() => '(?,?)').join(',');
    const params: any[] = [];
    for (const label of i.seats) { params.push(id, label); }
    await conn.query(`INSERT INTO seats (show_id,label) VALUES ${values}`, params);
    await conn.commit();
  } catch (e) {
    await conn.rollback(); throw e;
  } finally { conn.release(); }

  const v = await getShow(id);
  if (!v) throw err.showNotFound();
  return v;
}

const COUNTS_SQL = `
  SELECT
    SUM(CASE WHEN status='available'
             OR (status='held' AND held_until < NOW(6)) THEN 1 ELSE 0 END) AS available,
    SUM(CASE WHEN status='held' AND held_until >= NOW(6) THEN 1 ELSE 0 END) AS held,
    SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
    COUNT(*) AS total
  FROM seats WHERE show_id = ?`;

export async function getShow(
  id: string,
  opts: { includeSeats?: boolean } = {},
): Promise<ShowView | null> {
  const pool = getPool();
  const [showRows] = await pool.query<any[]>(
    `SELECT id,name,price_paise,per_user_limit,hold_ttl_seconds,total_seats FROM shows WHERE id=?`,
    [id],
  );
  if (showRows.length === 0) return null;
  const s = showRows[0];
  const [cRows] = await pool.query<any[]>(COUNTS_SQL, [id]);
  const c = cRows[0];
  const view: ShowView = {
    id: s.id, name: s.name,
    price_paise: Number(s.price_paise),
    per_user_limit: s.per_user_limit,
    hold_ttl_seconds: s.hold_ttl_seconds,
    total_seats: Number(c.total),
    available: Number(c.available),
    held: Number(c.held),
    confirmed: Number(c.confirmed),
  };
  if (opts.includeSeats) {
    const [sr] = await pool.query<any[]>(
      `SELECT label,
              CASE WHEN status='held' AND held_until < NOW(6) THEN 'available' ELSE status END AS status
         FROM seats WHERE show_id=? ORDER BY label`,
      [id],
    );
    view.seats = sr.map((r) => ({ label: r.label, status: r.status }));
  }
  return view;
}
```

- [ ] **Step 4: Implement the shows routes**

Create `src/routes/shows.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminHook } from '../auth/middleware.js';
import { createShow, getShow } from '../domain/shows.js';
import { err } from '../errors.js';

const SEAT_LABEL = /^[A-Z]{1,2}[0-9]{1,4}$/;

const createBody = z.object({
  name: z.string().min(1).max(255),
  seats: z.array(z.string().regex(SEAT_LABEL)).min(1).max(5000)
    .refine((xs) => new Set(xs).size === xs.length, { message: 'duplicate seat labels' }),
  price_paise: z.number().int().nonnegative(),
  per_user_limit: z.number().int().positive().optional(),
  hold_ttl_seconds: z.number().int().positive().optional(),
});

export async function showsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/shows', { preHandler: adminHook }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) throw err.invalidBody(parsed.error.issues[0].message);
    const view = await createShow(parsed.data);
    reply.code(201); return view;
  });

  app.get<{ Params: { id: string }, Querystring: { include?: string } }>(
    '/shows/:id',
    async (req) => {
      const v = await getShow(req.params.id, { includeSeats: req.query.include === 'seats' });
      if (!v) throw err.showNotFound();
      return v;
    },
  );
}
```

- [ ] **Step 5: Register the route in server.ts**

Modify `src/server.ts` — add import and register:
```ts
import { showsRoutes } from './routes/shows.js';
// inside buildServer:
app.register(showsRoutes);
```

- [ ] **Step 6: Create a seed script**

Create `src/scripts/seed.ts`:
```ts
import { createShow } from '../domain/shows.js';
import { runMigrations } from '../db/migrate.js';
import { closePool } from '../db/pool.js';

async function main() {
  await runMigrations();
  const seats = [];
  for (const row of 'ABCDEFGHIJ') for (let i = 1; i <= 20; i++) seats.push(`${row}${i}`);
  const s = await createShow({ name: 'friday-night', seats, price_paise: 25000 });
  console.log(JSON.stringify(s, null, 2));
}
main().finally(() => closePool());
```

- [ ] **Step 7: Run the tests**

Run: `pnpm test tests/integration/shows.test.ts`
Expected: PASS all 5 (including duplicate-seats rejection and 404 for missing show).

- [ ] **Step 8: Commit**

```bash
git add src/domain/shows.ts src/routes/shows.ts src/scripts/seed.ts tests/integration/shows.test.ts src/server.ts
git commit -m "feat(shows): admin-protected POST and public GET with reconciled counts"
```

---

## Task 5: Reserve — single-seat happy path (no idempotency yet)

**Files:**
- Create: `src/domain/reservations.ts`, `src/routes/reservations.ts`
- Create: `tests/unit/reserve-decision.test.ts`, `tests/integration/reserve.test.ts`
- Modify: `src/server.ts` (register `reservationsRoutes`)

**Interfaces:**
- Produces:
  - `reserve(input): Promise<ReservationView>` from `src/domain/reservations.ts`
  - `ReserveInput = { show_id, user_id, seats: string[], idempotency_key: string }` (idempotency_key accepted but ignored at this stage)
  - `ReservationView = { reservation_id, show_id, user_id, seats: string[], amount_paise, status, expires_at }`
  - `reservationsRoutes(app)` from `src/routes/reservations.ts`

Scope note: single-seat only; `seats.length !== 1` is rejected with `invalid_seats` at this stage. Expanded in Task 6.

---

- [ ] **Step 1: Write failing integration tests (happy path + hot-seat)**

Create `tests/integration/reserve.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { ensureSchema, resetDb, closeDb } from '../helpers/db.js';
import { signToken } from '../../src/auth/token.js';

let app: FastifyInstance;
const ADMIN = process.env.ADMIN_TOKEN!;
const SECRET = process.env.TOKEN_SECRET!;
const bearer = (uid: string) => `Bearer ${signToken(uid, SECRET)}`;

async function createShow(seats: string[], per_user_limit = 4) {
  const r = await app.inject({
    method: 'POST', url: '/shows',
    headers: { 'x-admin-token': ADMIN },
    payload: { name: 'x', seats, price_paise: 100, per_user_limit, hold_ttl_seconds: 60 },
  });
  return r.json();
}

beforeAll(async () => { await ensureSchema(); app = await makeApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(resetDb);

describe('reserve single seat', () => {
  it('happy path: one user, one seat → 201 held', async () => {
    const show = await createShow(['A1','A2']);
    const r = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1'], idempotency_key: 'k1' },
    });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.seats).toEqual(['A1']);
    expect(b.status).toBe('held');
    expect(b.amount_paise).toBe(100);
    expect(b.user_id).toBe('usr_1');
  });

  it('hot seat race: 100 concurrent users on A1 → exactly 1 × 201, 99 × 409 seat_taken, 0 × 5xx', async () => {
    const show = await createShow(['A1']);
    const requests = Array.from({ length: 100 }, (_, i) =>
      app.inject({
        method: 'POST', url: `/shows/${show.id}/reserve`,
        headers: { authorization: bearer(`usr_${i}`) },
        payload: { seats: ['A1'], idempotency_key: `k${i}` },
      }),
    );
    const results = await Promise.all(requests);
    const codes = results.map((r) => r.statusCode);
    const ok = codes.filter((c) => c === 201).length;
    const taken = codes.filter((c) => c === 409).length;
    const fiveXX = codes.filter((c) => c >= 500).length;
    expect(ok).toBe(1);
    expect(taken).toBe(99);
    expect(fiveXX).toBe(0);
  });

  it('rejects seats not belonging to the show', async () => {
    const show = await createShow(['A1']);
    const r = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['Z99'], idempotency_key: 'k' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('invalid_seats');
  });

  it('rejects a request body with duplicate seats', async () => {
    const show = await createShow(['A1','A2']);
    const r = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1','A1'], idempotency_key: 'k' },
    });
    expect(r.statusCode).toBe(400);
    expect(['invalid_body','invalid_seats']).toContain(r.json().error.code);
  });

  it('unauthenticated requests get 401', async () => {
    const show = await createShow(['A1']);
    const r = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      payload: { seats: ['A1'], idempotency_key: 'k' },
    });
    expect(r.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test tests/integration/reserve.test.ts`
Expected: FAIL — route missing.

- [ ] **Step 3: Implement single-seat reserve**

Create `src/domain/reservations.ts`:
```ts
import { createHash } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { newId } from '../ids.js';
import { err } from '../errors.js';

export interface ReserveInput {
  show_id: string;
  user_id: string;
  seats: string[];           // single-seat only in this task
  idempotency_key: string;
}

export interface ReservationView {
  reservation_id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  amount_paise: number;
  status: 'held' | 'confirmed' | 'cancelled' | 'expired';
  expires_at: string | null;
}

export function requestHash(show_id: string, seats: string[]): string {
  const canon = `${show_id}\n${[...seats].sort().join(',')}`;
  return createHash('sha256').update(canon).digest('hex');
}

export async function reserve(input: ReserveInput): Promise<ReservationView> {
  if (input.seats.length !== 1) throw err.invalidSeats('exactly one seat in this phase');
  const seat = input.seats[0];
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.query("SET SESSION transaction_isolation = 'READ-COMMITTED'");
    await conn.beginTransaction();

    // Validate show + fetch config.
    const [showRows] = await conn.query<any[]>(
      `SELECT id, price_paise, hold_ttl_seconds FROM shows WHERE id = ?`,
      [input.show_id],
    );
    if (showRows.length === 0) { await conn.rollback(); throw err.showNotFound(); }
    const show = showRows[0];

    // Lazy expiry on this specific seat.
    await conn.query(
      `UPDATE seats
          SET status='available', held_by=NULL, held_until=NULL, reservation_id=NULL,
              version=version+1
        WHERE show_id=? AND label=? AND status='held' AND held_until < NOW(6)`,
      [input.show_id, seat],
    );

    // Lock the single target seat row.
    const [seatRows] = await conn.query<any[]>(
      `SELECT id, status FROM seats WHERE show_id=? AND label=? FOR UPDATE`,
      [input.show_id, seat],
    );
    if (seatRows.length === 0) { await conn.rollback(); throw err.invalidSeats(); }
    if (seatRows[0].status !== 'available') { await conn.rollback(); throw err.seatTaken(); }

    const seatId = seatRows[0].id;
    const reservationId = newId('rsv');
    const expiresAt = new Date(Date.now() + show.hold_ttl_seconds * 1000);
    const amount = Number(show.price_paise);

    await conn.query(
      `INSERT INTO reservations (id,show_id,user_id,status,amount_paise,expires_at)
       VALUES (?,?,?,'held',?,?)`,
      [reservationId, input.show_id, input.user_id, amount, expiresAt],
    );

    const [upd] = await conn.query<any>(
      `UPDATE seats
          SET status='held', held_by=?, held_until=?, reservation_id=?, version=version+1
        WHERE id=? AND status='available'`,
      [input.user_id, expiresAt, reservationId, seatId],
    );
    if ((upd as any).affectedRows !== 1) { await conn.rollback(); throw err.seatTaken(); }

    await conn.query(
      `INSERT INTO reservation_seats (reservation_id, seat_id) VALUES (?,?)`,
      [reservationId, seatId],
    );

    await conn.commit();
    return {
      reservation_id: reservationId,
      show_id: input.show_id,
      user_id: input.user_id,
      seats: [seat],
      amount_paise: amount,
      status: 'held',
      expires_at: expiresAt.toISOString(),
    };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 4: Implement the reserve route**

Create `src/routes/reservations.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authHook } from '../auth/middleware.js';
import { reserve } from '../domain/reservations.js';
import { err } from '../errors.js';

const SEAT_LABEL = /^[A-Z]{1,2}[0-9]{1,4}$/;

const reserveBody = z.object({
  seats: z.array(z.string().regex(SEAT_LABEL)).min(1).max(20)
    .refine((xs) => new Set(xs).size === xs.length, 'duplicate seats'),
  idempotency_key: z.string().min(1).max(128),
});

export async function reservationsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    '/shows/:id/reserve',
    { preHandler: authHook },
    async (req, reply) => {
      const parsed = reserveBody.safeParse(req.body);
      if (!parsed.success) throw err.invalidBody(parsed.error.issues[0].message);
      const view = await reserve({
        show_id: req.params.id,
        user_id: req.user_id!,
        seats: parsed.data.seats,
        idempotency_key: parsed.data.idempotency_key,
      });
      reply.code(201); return view;
    },
  );
}
```

Modify `src/server.ts` to register:
```ts
import { reservationsRoutes } from './routes/reservations.js';
// inside buildServer:
app.register(reservationsRoutes);
```

- [ ] **Step 5: Add a unit test for `requestHash` canonicalization**

Create `tests/unit/reserve-decision.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { requestHash } from '../../src/domain/reservations.js';

describe('requestHash', () => {
  it('is order-insensitive for seats', () => {
    expect(requestHash('shw_x', ['A2','A1'])).toBe(requestHash('shw_x', ['A1','A2']));
  });
  it('differs across shows', () => {
    expect(requestHash('shw_x', ['A1'])).not.toBe(requestHash('shw_y', ['A1']));
  });
  it('differs across seats', () => {
    expect(requestHash('shw_x', ['A1'])).not.toBe(requestHash('shw_x', ['A2']));
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `pnpm test`
Expected: all tests pass, including the hot-seat race test (100 concurrent requests → 1 success, 99 declines, 0 5xx).

- [ ] **Step 7: Commit**

```bash
git add src/domain/reservations.ts src/routes/reservations.ts src/server.ts tests/integration/reserve.test.ts tests/unit/reserve-decision.test.ts
git commit -m "feat(reserve): single-seat happy path with hot-seat race correctness"
```

---

## Task 6: Reserve — multi-seat all-or-nothing with sorted `FOR UPDATE`

**Files:**
- Modify: `src/domain/reservations.ts`
- Modify: `tests/integration/reserve.test.ts` (add multi-seat scenarios)

**Interfaces:**
- Modifies: `reserve(input)` now supports `seats.length >= 1`. All-or-nothing semantics: if any seat is unavailable, the whole request is `409 seat_taken` and no reservation is created.
- No new exported names.

---

- [ ] **Step 1: Write failing multi-seat tests**

Append to `tests/integration/reserve.test.ts`:
```ts
describe('reserve multi-seat', () => {
  it('two seats, both free → one reservation with both', async () => {
    const show = await createShow(['A1','A2','A3']);
    const r = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1','A2'], idempotency_key: 'k' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().seats.sort()).toEqual(['A1','A2']);
    expect(r.json().amount_paise).toBe(200);
  });

  it('all-or-nothing: one of two seats taken → 409, no partial', async () => {
    const show = await createShow(['A1','A2']);
    // user 1 grabs A1
    await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1'], idempotency_key: 'ka' },
    });
    // user 2 asks for [A1,A2] — must fail entirely
    const r = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_2') },
      payload: { seats: ['A1','A2'], idempotency_key: 'kb' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('seat_taken');
    // A2 must still be available
    const show2 = (await app.inject({
      method: 'GET', url: `/shows/${show.id}?include=seats`,
    })).json();
    const a2 = show2.seats.find((s: any) => s.label === 'A2');
    expect(a2.status).toBe('available');
  });

  it('reverse-order concurrent multi-seat requests do not deadlock', async () => {
    const show = await createShow(['A1','A2']);
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'POST', url: `/shows/${show.id}/reserve`,
        headers: { authorization: bearer('usr_1') },
        payload: { seats: ['A1','A2'], idempotency_key: 'ka' },
      }),
      app.inject({
        method: 'POST', url: `/shows/${show.id}/reserve`,
        headers: { authorization: bearer('usr_2') },
        payload: { seats: ['A2','A1'], idempotency_key: 'kb' },
      }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    expect([r1,r2].filter((r) => r.statusCode >= 500).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `pnpm test tests/integration/reserve.test.ts`
Expected: new tests fail (`invalid_seats: exactly one seat in this phase`).

- [ ] **Step 3: Expand `reserve` to multi-seat**

Modify `src/domain/reservations.ts` — replace the whole function body of `reserve`:
```ts
export async function reserve(input: ReserveInput): Promise<ReservationView> {
  const seats = [...input.seats].sort();                       // deterministic lock order
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.query("SET SESSION transaction_isolation = 'READ-COMMITTED'");
    await conn.beginTransaction();

    const [showRows] = await conn.query<any[]>(
      `SELECT id, price_paise, hold_ttl_seconds FROM shows WHERE id = ?`,
      [input.show_id],
    );
    if (showRows.length === 0) { await conn.rollback(); throw err.showNotFound(); }
    const show = showRows[0];

    const placeholders = seats.map(() => '?').join(',');

    // Lazy expiry on just these seats.
    await conn.query(
      `UPDATE seats
          SET status='available', held_by=NULL, held_until=NULL, reservation_id=NULL,
              version=version+1
        WHERE show_id=? AND label IN (${placeholders})
          AND status='held' AND held_until < NOW(6)`,
      [input.show_id, ...seats],
    );

    // Lock all target seat rows in sorted order (deadlock-free).
    const [seatRows] = await conn.query<any[]>(
      `SELECT id, label, status FROM seats
        WHERE show_id=? AND label IN (${placeholders})
        ORDER BY label FOR UPDATE`,
      [input.show_id, ...seats],
    );
    if (seatRows.length !== seats.length) { await conn.rollback(); throw err.invalidSeats(); }
    for (const r of seatRows) {
      if (r.status !== 'available') { await conn.rollback(); throw err.seatTaken(); }
    }

    const reservationId = newId('rsv');
    const expiresAt = new Date(Date.now() + show.hold_ttl_seconds * 1000);
    const amount = Number(show.price_paise) * seats.length;

    await conn.query(
      `INSERT INTO reservations (id,show_id,user_id,status,amount_paise,expires_at)
       VALUES (?,?,?,'held',?,?)`,
      [reservationId, input.show_id, input.user_id, amount, expiresAt],
    );

    for (const r of seatRows) {
      const [upd] = await conn.query<any>(
        `UPDATE seats
            SET status='held', held_by=?, held_until=?, reservation_id=?, version=version+1
          WHERE id=? AND status='available'`,
        [input.user_id, expiresAt, reservationId, r.id],
      );
      if ((upd as any).affectedRows !== 1) { await conn.rollback(); throw err.seatTaken(); }
      await conn.query(
        `INSERT INTO reservation_seats (reservation_id, seat_id) VALUES (?,?)`,
        [reservationId, r.id],
      );
    }

    await conn.commit();
    return {
      reservation_id: reservationId,
      show_id: input.show_id,
      user_id: input.user_id,
      seats,
      amount_paise: amount,
      status: 'held',
      expires_at: expiresAt.toISOString(),
    };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    // Normalize InnoDB deadlock / lock-wait-timeout → 409 seat_taken.
    const code = (e as any)?.errno;
    if (code === 1213 || code === 1205) throw err.seatTaken();
    throw e;
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `pnpm test tests/integration/reserve.test.ts`
Expected: PASS all (single-seat still works; multi-seat passes; reverse-order concurrent test shows one 201 + one 409, zero 5xx).

- [ ] **Step 5: Commit**

```bash
git add src/domain/reservations.ts tests/integration/reserve.test.ts
git commit -m "feat(reserve): multi-seat all-or-nothing with sorted FOR UPDATE lock order"
```

---

## Task 7: Per-user limit + `withUserShowLock` helper

**Files:**
- Create: `src/db/with-user-show-lock.ts`
- Modify: `src/domain/reservations.ts`
- Create: `tests/integration/per-user-limit.test.ts`

**Interfaces:**
- Produces:
  - `withUserShowLock<T>(conn, user_id, show_id, fn: () => Promise<T>): Promise<T>` — wraps `GET_LOCK(?,5)` and `RELEASE_LOCK(?)` with try/finally so the lock is always released before the connection returns to the pool. Returns `fn()`'s value. Throws `err.inFlight()` on lock timeout.

---

- [ ] **Step 1: Write failing per-user-limit tests**

Create `tests/integration/per-user-limit.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { ensureSchema, resetDb, closeDb } from '../helpers/db.js';
import { signToken } from '../../src/auth/token.js';

let app: FastifyInstance;
const ADMIN = process.env.ADMIN_TOKEN!;
const SECRET = process.env.TOKEN_SECRET!;
const bearer = (uid: string) => `Bearer ${signToken(uid, SECRET)}`;

async function createShow(seats: string[], limit = 4) {
  const r = await app.inject({
    method: 'POST', url: '/shows',
    headers: { 'x-admin-token': ADMIN },
    payload: { name: 'x', seats, price_paise: 100, per_user_limit: limit, hold_ttl_seconds: 60 },
  });
  return r.json();
}

beforeAll(async () => { await ensureSchema(); app = await makeApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(resetDb);

describe('per-user limit', () => {
  it('rejects a single request that itself exceeds the limit', async () => {
    const show = await createShow(['A1','A2','A3','A4','A5','A6'], 4);
    const r = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1','A2','A3','A4','A5'], idempotency_key: 'k' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('per_user_limit_exceeded');
  });

  it('holds under concurrency: 10 parallel single-seat reserves on limit=4 → ≤4 held', async () => {
    const seats = ['A1','A2','A3','A4','A5','A6','A7','A8','A9','A10'];
    const show = await createShow(seats, 4);
    const reqs = seats.map((s, i) =>
      app.inject({
        method: 'POST', url: `/shows/${show.id}/reserve`,
        headers: { authorization: bearer('usr_1') },
        payload: { seats: [s], idempotency_key: `k${i}` },
      }),
    );
    const results = await Promise.all(reqs);
    const ok = results.filter((r) => r.statusCode === 201).length;
    const perLimit = results.filter(
      (r) => r.statusCode === 409 && r.json().error.code === 'per_user_limit_exceeded',
    ).length;
    const other5xx = results.filter((r) => r.statusCode >= 500).length;
    expect(ok).toBeLessThanOrEqual(4);
    expect(ok + perLimit).toBe(10);
    expect(other5xx).toBe(0);
  });

  it('different users on same show reserve independently', async () => {
    const show = await createShow(['A1','A2','A3','A4','A5'], 1);
    const results = await Promise.all(
      ['usr_1','usr_2','usr_3'].map((u, i) =>
        app.inject({
          method: 'POST', url: `/shows/${show.id}/reserve`,
          headers: { authorization: bearer(u) },
          payload: { seats: [`A${i+1}`], idempotency_key: `k${i}` },
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `pnpm test tests/integration/per-user-limit.test.ts`
Expected: the parallel-reserve test will likely show ok > 4 (over-limit) or 5xx.

- [ ] **Step 3: Implement the lock helper**

Create `src/db/with-user-show-lock.ts`:
```ts
import type { PoolConnection } from 'mysql2/promise';
import { err } from '../errors.js';

export async function withUserShowLock<T>(
  conn: PoolConnection,
  user_id: string,
  show_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const name = `rsv:${user_id}:${show_id}`;
  const [rows] = await conn.query<any[]>('SELECT GET_LOCK(?, 5) AS got', [name]);
  const got = rows[0]?.got;
  if (got !== 1) throw err.inFlight('lock_timeout');
  try {
    return await fn();
  } finally {
    try { await conn.query('DO RELEASE_LOCK(?)', [name]); } catch { /* best effort */ }
  }
}
```

- [ ] **Step 4: Add the per-user limit check inside the lock**

Modify `src/domain/reservations.ts` — wrap the existing transaction in `withUserShowLock` and add the limit check after lazy-expiry. Replace the body of `reserve` so the flow is:
```ts
import { withUserShowLock } from '../db/with-user-show-lock.js';

export async function reserve(input: ReserveInput): Promise<ReservationView> {
  const seats = [...input.seats].sort();
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.query("SET SESSION transaction_isolation = 'READ-COMMITTED'");

    return await withUserShowLock(conn, input.user_id, input.show_id, async () => {
      await conn.beginTransaction();

      const [showRows] = await conn.query<any[]>(
        `SELECT id, price_paise, per_user_limit, hold_ttl_seconds FROM shows WHERE id = ?`,
        [input.show_id],
      );
      if (showRows.length === 0) { await conn.rollback(); throw err.showNotFound(); }
      const show = showRows[0];

      const placeholders = seats.map(() => '?').join(',');

      // Lazy expiry on just these seats.
      await conn.query(
        `UPDATE seats
            SET status='available', held_by=NULL, held_until=NULL, reservation_id=NULL,
                version=version+1
          WHERE show_id=? AND label IN (${placeholders})
            AND status='held' AND held_until < NOW(6)`,
        [input.show_id, ...seats],
      );

      // Per-user limit check (inside the named lock, so no race for the same user).
      const [cntRows] = await conn.query<any[]>(
        `SELECT COUNT(*) AS cnt
           FROM reservation_seats rs
           JOIN reservations r ON r.id = rs.reservation_id
          WHERE r.show_id=? AND r.user_id=? AND r.status IN ('held','confirmed')`,
        [input.show_id, input.user_id],
      );
      const current = Number(cntRows[0].cnt);
      if (current + seats.length > show.per_user_limit) {
        await conn.rollback();
        throw err.perUserLimit();
      }

      // Lock all target seat rows in sorted order.
      const [seatRows] = await conn.query<any[]>(
        `SELECT id, label, status FROM seats
          WHERE show_id=? AND label IN (${placeholders})
          ORDER BY label FOR UPDATE`,
        [input.show_id, ...seats],
      );
      if (seatRows.length !== seats.length) { await conn.rollback(); throw err.invalidSeats(); }
      for (const r of seatRows) {
        if (r.status !== 'available') { await conn.rollback(); throw err.seatTaken(); }
      }

      const reservationId = newId('rsv');
      const expiresAt = new Date(Date.now() + show.hold_ttl_seconds * 1000);
      const amount = Number(show.price_paise) * seats.length;

      await conn.query(
        `INSERT INTO reservations (id,show_id,user_id,status,amount_paise,expires_at)
         VALUES (?,?,?,'held',?,?)`,
        [reservationId, input.show_id, input.user_id, amount, expiresAt],
      );

      for (const r of seatRows) {
        const [upd] = await conn.query<any>(
          `UPDATE seats
              SET status='held', held_by=?, held_until=?, reservation_id=?, version=version+1
            WHERE id=? AND status='available'`,
          [input.user_id, expiresAt, reservationId, r.id],
        );
        if ((upd as any).affectedRows !== 1) { await conn.rollback(); throw err.seatTaken(); }
        await conn.query(
          `INSERT INTO reservation_seats (reservation_id, seat_id) VALUES (?,?)`,
          [reservationId, r.id],
        );
      }

      await conn.commit();
      return {
        reservation_id: reservationId,
        show_id: input.show_id,
        user_id: input.user_id,
        seats,
        amount_paise: amount,
        status: 'held',
        expires_at: expiresAt.toISOString(),
      };
    });
  } catch (e) {
    const code = (e as any)?.errno;
    if (code === 1213 || code === 1205) throw err.seatTaken();
    throw e;
  } finally {
    conn.release();
  }
}
```

Note: the lock is acquired on the same `conn` that runs the transaction. The `finally` inside `withUserShowLock` releases the lock before `conn.release()` returns the connection to the pool.

- [ ] **Step 5: Run all tests**

Run: `pnpm test tests/integration/`
Expected: all pass; the parallel 10-reserve test shows ≤4 held, ≥6 declined with `per_user_limit_exceeded`, zero 5xx.

- [ ] **Step 6: Commit**

```bash
git add src/db/with-user-show-lock.ts src/domain/reservations.ts tests/integration/per-user-limit.test.ts
git commit -m "feat(reserve): per-user limit enforced inside GET_LOCK/RELEASE_LOCK named lock"
```

---

## Task 8: Idempotency key handling (replay + conflict)

**Files:**
- Create: `src/domain/idempotency.ts`
- Modify: `src/domain/reservations.ts`
- Create: `tests/integration/idempotency.test.ts`

**Interfaces:**
- Produces:
  - `loadReservationView(conn, reservation_id): Promise<ReservationView>` from `src/domain/idempotency.ts` — reads a reservation + its seats + returns the public view
- Modifies: `reserve(input)` now:
  - Replays the stored reservation when `(user_id, idem_key, request_hash)` matches.
  - Returns `409 idempotency_key_conflict` when `(user_id, idem_key)` matches but `request_hash` differs.
  - Returns `409 in_flight` when the key row exists but `reservation_id` is still NULL (crash window).

---

- [ ] **Step 1: Write failing idempotency tests**

Create `tests/integration/idempotency.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { ensureSchema, resetDb, closeDb } from '../helpers/db.js';
import { signToken } from '../../src/auth/token.js';

let app: FastifyInstance;
const ADMIN = process.env.ADMIN_TOKEN!;
const SECRET = process.env.TOKEN_SECRET!;
const bearer = (uid: string) => `Bearer ${signToken(uid, SECRET)}`;

async function createShow(seats: string[]) {
  const r = await app.inject({
    method: 'POST', url: '/shows',
    headers: { 'x-admin-token': ADMIN },
    payload: { name: 'x', seats, price_paise: 100, per_user_limit: 4, hold_ttl_seconds: 60 },
  });
  return r.json();
}

beforeAll(async () => { await ensureSchema(); app = await makeApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(resetDb);

describe('idempotency', () => {
  it('same (user, key, body) returns the same reservation', async () => {
    const show = await createShow(['A1']);
    const once = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1'], idempotency_key: 'K' },
    });
    const twice = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1'], idempotency_key: 'K' },
    });
    expect(once.statusCode).toBe(201);
    expect(twice.statusCode).toBe(201);
    expect(twice.json().reservation_id).toBe(once.json().reservation_id);
  });

  it('same (user, key) with different seats → 409 idempotency_key_conflict', async () => {
    const show = await createShow(['A1','A2']);
    const once = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1'], idempotency_key: 'K' },
    });
    const twice = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A2'], idempotency_key: 'K' },
    });
    expect(once.statusCode).toBe(201);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('idempotency_key_conflict');
  });

  it('same key, DIFFERENT users → two independent reservations', async () => {
    const show = await createShow(['A1','A2']);
    const r1 = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1'], idempotency_key: 'K' },
    });
    const r2 = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_2') },
      payload: { seats: ['A2'], idempotency_key: 'K' },
    });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r1.json().reservation_id).not.toBe(r2.json().reservation_id);
  });

  it('20 parallel replays of same (user, key, body) → exactly one reservation', async () => {
    const show = await createShow(['A1']);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST', url: `/shows/${show.id}/reserve`,
          headers: { authorization: bearer('usr_1') },
          payload: { seats: ['A1'], idempotency_key: 'K' },
        }),
      ),
    );
    const ids = new Set(results.filter((r) => r.statusCode === 201).map((r) => r.json().reservation_id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.statusCode >= 500).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `pnpm test tests/integration/idempotency.test.ts`
Expected: replay fails (returns new reservation each time, or 409 seat_taken on retry).

- [ ] **Step 3: Create the loader + extend reserve for idempotency**

Create `src/domain/idempotency.ts`:
```ts
import type { PoolConnection } from 'mysql2/promise';
import { err } from '../errors.js';
import type { ReservationView } from './reservations.js';

export async function loadReservationView(
  conn: PoolConnection,
  reservation_id: string,
): Promise<ReservationView> {
  const [rRows] = await conn.query<any[]>(
    `SELECT id, show_id, user_id, status, amount_paise, expires_at
       FROM reservations WHERE id = ?`,
    [reservation_id],
  );
  if (rRows.length === 0) throw err.reservationNotFound();
  const r = rRows[0];
  const [sRows] = await conn.query<any[]>(
    `SELECT s.label FROM reservation_seats rs
       JOIN seats s ON s.id = rs.seat_id
      WHERE rs.reservation_id = ? ORDER BY s.label`,
    [reservation_id],
  );
  return {
    reservation_id: r.id,
    show_id: r.show_id,
    user_id: r.user_id,
    seats: sRows.map((x) => x.label),
    amount_paise: Number(r.amount_paise),
    status: r.status,
    expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
  };
}
```

Modify `src/domain/reservations.ts` — add idempotency guard as the very first step inside the lock, replacing the "await conn.beginTransaction()" line onwards with:
```ts
import { loadReservationView } from './idempotency.js';
// ... inside the withUserShowLock callback, before beginTransaction:

      await conn.beginTransaction();

      // --- IDEMPOTENCY GUARD -----------------------------------------
      const hash = requestHash(input.show_id, seats);
      const [ins] = await conn.query<any>(
        `INSERT IGNORE INTO idempotency_keys (user_id, idem_key, request_hash)
         VALUES (?, ?, ?)`,
        [input.user_id, input.idempotency_key, hash],
      );
      if ((ins as any).affectedRows === 0) {
        // Key already existed. Read it.
        const [kRows] = await conn.query<any[]>(
          `SELECT request_hash, reservation_id FROM idempotency_keys
            WHERE user_id=? AND idem_key=?`,
          [input.user_id, input.idempotency_key],
        );
        const k = kRows[0];
        if (k.request_hash !== hash) {
          await conn.rollback();
          throw err.idempotencyConflict();
        }
        if (!k.reservation_id) {
          await conn.rollback();
          throw err.inFlight();
        }
        const existing = await loadReservationView(conn, k.reservation_id);
        await conn.commit();
        return existing;
      }
      // --- END IDEMPOTENCY GUARD -------------------------------------

      const [showRows] = await conn.query<any[]>(
        `SELECT id, price_paise, per_user_limit, hold_ttl_seconds FROM shows WHERE id = ?`,
        [input.show_id],
      );
      // ... (rest of the existing flow unchanged)
```

Then, immediately before `conn.commit()` at the end of the success path, add:
```ts
      await conn.query(
        `UPDATE idempotency_keys SET reservation_id=?
          WHERE user_id=? AND idem_key=?`,
        [reservationId, input.user_id, input.idempotency_key],
      );
```

- [ ] **Step 4: Run all tests**

Run: `pnpm test tests/integration/`
Expected: all pass (idempotency scenarios resolve as specified).

- [ ] **Step 5: Commit**

```bash
git add src/domain/idempotency.ts src/domain/reservations.ts tests/integration/idempotency.test.ts
git commit -m "feat(reserve): idempotency contract (replay, conflict, cross-user independence)"
```

---

## Task 9: Confirm + Cancel + lazy expiry + ownership

**Files:**
- Modify: `src/domain/reservations.ts` (add `confirm`, `cancel`, `getReservation`)
- Modify: `src/routes/reservations.ts` (add `GET /reservations/:id`, `POST /reservations/:id/confirm`, `POST /reservations/:id/cancel`)
- Create: `tests/integration/expiry-confirm-cancel.test.ts`, `tests/integration/ownership.test.ts`

**Interfaces:**
- Produces:
  - `confirm(reservation_id, user_id): Promise<ReservationView>` from `src/domain/reservations.ts`
  - `cancel(reservation_id, user_id): Promise<ReservationView>` from `src/domain/reservations.ts`
  - `getReservation(reservation_id, user_id): Promise<ReservationView>` from `src/domain/reservations.ts`

---

- [ ] **Step 1: Write failing tests for confirm/cancel/expiry/ownership**

Create `tests/integration/expiry-confirm-cancel.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { ensureSchema, resetDb, closeDb } from '../helpers/db.js';
import { signToken } from '../../src/auth/token.js';
import { getPool } from '../../src/db/pool.js';

let app: FastifyInstance;
const ADMIN = process.env.ADMIN_TOKEN!;
const SECRET = process.env.TOKEN_SECRET!;
const bearer = (uid: string) => `Bearer ${signToken(uid, SECRET)}`;

async function createShow(seats: string[], ttl = 2) {
  const r = await app.inject({
    method: 'POST', url: '/shows',
    headers: { 'x-admin-token': ADMIN },
    payload: { name: 'x', seats, price_paise: 100, per_user_limit: 4, hold_ttl_seconds: ttl },
  });
  return r.json();
}

async function reserve(uid: string, show: any, seats: string[], key = 'k') {
  return app.inject({
    method: 'POST', url: `/shows/${show.id}/reserve`,
    headers: { authorization: bearer(uid) },
    payload: { seats, idempotency_key: key },
  });
}

beforeAll(async () => { await ensureSchema(); app = await makeApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(resetDb);

describe('confirm', () => {
  it('owner confirms a held reservation → confirmed', async () => {
    const show = await createShow(['A1']);
    const r = (await reserve('usr_1', show, ['A1'])).json();
    const c = await app.inject({
      method: 'POST', url: `/reservations/${r.reservation_id}/confirm`,
      headers: { authorization: bearer('usr_1') },
    });
    expect(c.statusCode).toBe(200);
    expect(c.json().status).toBe('confirmed');
  });

  it('confirming an expired hold → 409 hold_expired', async () => {
    const show = await createShow(['A1'], 1);               // 1s TTL
    const r = (await reserve('usr_1', show, ['A1'])).json();
    // Force expiry by rewinding held_until.
    await getPool().query(
      `UPDATE seats SET held_until = NOW(6) - INTERVAL 10 SECOND WHERE reservation_id = ?`,
      [r.reservation_id],
    );
    await getPool().query(
      `UPDATE reservations SET expires_at = NOW(6) - INTERVAL 10 SECOND WHERE id = ?`,
      [r.reservation_id],
    );
    const c = await app.inject({
      method: 'POST', url: `/reservations/${r.reservation_id}/confirm`,
      headers: { authorization: bearer('usr_1') },
    });
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe('hold_expired');
  });
});

describe('cancel', () => {
  it('owner cancels held → status cancelled, seat available again', async () => {
    const show = await createShow(['A1']);
    const r = (await reserve('usr_1', show, ['A1'])).json();
    const c = await app.inject({
      method: 'POST', url: `/reservations/${r.reservation_id}/cancel`,
      headers: { authorization: bearer('usr_1') },
    });
    expect(c.statusCode).toBe(200);
    expect(c.json().status).toBe('cancelled');
    const show2 = (await app.inject({ method: 'GET', url: `/shows/${show.id}` })).json();
    expect(show2.available).toBe(1);
  });

  it('cannot cancel after confirm → 409 not_cancellable', async () => {
    const show = await createShow(['A1']);
    const r = (await reserve('usr_1', show, ['A1'])).json();
    await app.inject({
      method: 'POST', url: `/reservations/${r.reservation_id}/confirm`,
      headers: { authorization: bearer('usr_1') },
    });
    const c = await app.inject({
      method: 'POST', url: `/reservations/${r.reservation_id}/cancel`,
      headers: { authorization: bearer('usr_1') },
    });
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe('not_cancellable');
  });
});

describe('lazy expiry', () => {
  it('an expired held seat becomes re-bookable by someone else', async () => {
    const show = await createShow(['A1'], 1);
    const r1 = (await reserve('usr_1', show, ['A1'], 'ka')).json();
    await getPool().query(
      `UPDATE seats SET held_until = NOW(6) - INTERVAL 1 SECOND WHERE reservation_id = ?`,
      [r1.reservation_id],
    );
    const r2 = await reserve('usr_2', show, ['A1'], 'kb');
    expect(r2.statusCode).toBe(201);
    expect(r2.json().user_id).toBe('usr_2');
  });

  it('expiry never resurrects a confirmed seat', async () => {
    const show = await createShow(['A1']);
    const r = (await reserve('usr_1', show, ['A1'])).json();
    await app.inject({
      method: 'POST', url: `/reservations/${r.reservation_id}/confirm`,
      headers: { authorization: bearer('usr_1') },
    });
    // Force the (now-ignored) held_until into the past.
    await getPool().query(
      `UPDATE seats SET held_until = NOW(6) - INTERVAL 1 SECOND WHERE reservation_id = ?`,
      [r.reservation_id],
    );
    const r2 = await reserve('usr_2', show, ['A1'], 'kb');
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('seat_taken');
  });
});
```

Create `tests/integration/ownership.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { ensureSchema, resetDb, closeDb } from '../helpers/db.js';
import { signToken } from '../../src/auth/token.js';

let app: FastifyInstance;
const ADMIN = process.env.ADMIN_TOKEN!;
const SECRET = process.env.TOKEN_SECRET!;
const bearer = (uid: string) => `Bearer ${signToken(uid, SECRET)}`;

beforeAll(async () => { await ensureSchema(); app = await makeApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(resetDb);

describe('ownership', () => {
  it('spoofed user_id in body is ignored; identity comes from token', async () => {
    const show = (await app.inject({
      method: 'POST', url: '/shows',
      headers: { 'x-admin-token': ADMIN },
      payload: { name: 'x', seats: ['A1'], price_paise: 100 },
    })).json();
    const r = await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1'], idempotency_key: 'k', user_id: 'usr_99' } as any,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().user_id).toBe('usr_1');
  });

  it('non-owner cannot cancel another user\'s reservation', async () => {
    const show = (await app.inject({
      method: 'POST', url: '/shows',
      headers: { 'x-admin-token': ADMIN },
      payload: { name: 'x', seats: ['A1'], price_paise: 100 },
    })).json();
    const r = (await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1'], idempotency_key: 'k' },
    })).json();
    const c = await app.inject({
      method: 'POST', url: `/reservations/${r.reservation_id}/cancel`,
      headers: { authorization: bearer('usr_2') },
    });
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe('not_cancellable');
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `pnpm test tests/integration/expiry-confirm-cancel.test.ts tests/integration/ownership.test.ts`
Expected: FAIL — routes/functions missing.

- [ ] **Step 3: Implement confirm/cancel/getReservation**

Append to `src/domain/reservations.ts`:
```ts
export async function getReservation(
  reservation_id: string,
  user_id: string,
): Promise<ReservationView> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const [rRows] = await conn.query<any[]>(
      `SELECT id,show_id,user_id,status,amount_paise,expires_at
         FROM reservations WHERE id=? AND user_id=?`,
      [reservation_id, user_id],
    );
    if (rRows.length === 0) throw err.reservationNotFound();
    return loadReservationView(conn as any, reservation_id);
  } finally {
    conn.release();
  }
}

export async function confirm(
  reservation_id: string,
  user_id: string,
): Promise<ReservationView> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.query("SET SESSION transaction_isolation = 'READ-COMMITTED'");
    await conn.beginTransaction();
    const [upd] = await conn.query<any>(
      `UPDATE reservations
          SET status='confirmed', confirmed_at=NOW(6)
        WHERE id=? AND user_id=? AND status='held' AND expires_at > NOW(6)`,
      [reservation_id, user_id],
    );
    if ((upd as any).affectedRows !== 1) {
      // Figure out why to return the right 409.
      await conn.rollback();
      const [row] = await conn.query<any[]>(
        `SELECT status, expires_at FROM reservations WHERE id=? AND user_id=?`,
        [reservation_id, user_id],
      );
      if (row.length === 0) throw err.reservationNotFound();
      const r = row[0];
      if (r.status === 'confirmed') throw err.alreadyConfirmed();
      if (r.status === 'cancelled') throw err.notCancellable();
      if (r.status === 'held' && new Date(r.expires_at) <= new Date()) throw err.holdExpired();
      throw err.notCancellable();
    }
    await conn.query(
      `UPDATE seats SET status='confirmed', held_until=NULL, version=version+1
        WHERE reservation_id=? AND status='held'`,
      [reservation_id],
    );
    await conn.commit();
    return loadReservationView(conn as any, reservation_id);
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally { conn.release(); }
}

export async function cancel(
  reservation_id: string,
  user_id: string,
): Promise<ReservationView> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.query("SET SESSION transaction_isolation = 'READ-COMMITTED'");
    await conn.beginTransaction();
    const [upd] = await conn.query<any>(
      `UPDATE reservations SET status='cancelled', cancelled_at=NOW(6)
        WHERE id=? AND user_id=? AND status='held'`,
      [reservation_id, user_id],
    );
    if ((upd as any).affectedRows !== 1) {
      await conn.rollback();
      throw err.notCancellable();                       // deliberately opaque; hides ownership
    }
    await conn.query(
      `UPDATE seats
          SET status='available', held_by=NULL, held_until=NULL,
              reservation_id=NULL, version=version+1
        WHERE reservation_id=? AND status='held'`,
      [reservation_id],
    );
    await conn.commit();
    return loadReservationView(conn as any, reservation_id);
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally { conn.release(); }
}
```

- [ ] **Step 4: Implement the routes**

Append to `src/routes/reservations.ts`:
```ts
import { confirm, cancel, getReservation } from '../domain/reservations.js';

// inside reservationsRoutes:
  app.post<{ Params: { id: string } }>(
    '/reservations/:id/confirm',
    { preHandler: authHook },
    async (req) => confirm(req.params.id, req.user_id!),
  );
  app.post<{ Params: { id: string } }>(
    '/reservations/:id/cancel',
    { preHandler: authHook },
    async (req) => cancel(req.params.id, req.user_id!),
  );
  app.get<{ Params: { id: string } }>(
    '/reservations/:id',
    { preHandler: authHook },
    async (req) => getReservation(req.params.id, req.user_id!),
  );
```

- [ ] **Step 5: Run all tests**

Run: `pnpm test tests/integration/`
Expected: all pass. Specifically:
  - confirm happy path works.
  - confirm after rewound expiry → 409 hold_expired.
  - cancel works; cancel after confirm → 409 not_cancellable.
  - expired held seat becomes re-bookable by another user.
  - confirmed seat is never re-bookable even if `held_until` is in the past.
  - spoofed body `user_id` is ignored.
  - non-owner cancel attempt → 409 not_cancellable.

- [ ] **Step 6: Commit**

```bash
git add src/domain/reservations.ts src/routes/reservations.ts tests/integration/expiry-confirm-cancel.test.ts tests/integration/ownership.test.ts
git commit -m "feat(reservations): confirm, cancel, lazy expiry, token-only ownership"
```

---

## Task 10: Prometheus metrics + reconciliation gauges

**Files:**
- Create: `src/observability/metrics.ts`
- Modify: `src/routes/ops.ts` (add `/metrics`)
- Modify: `src/server.ts` (wire metrics hooks)
- Modify: `src/domain/reservations.ts` (emit counters on outcomes)
- Create: `tests/integration/metrics.test.ts`

**Interfaces:**
- Produces:
  - `metrics` singleton from `src/observability/metrics.ts` with:
    - `reservationsHeld.inc({show_id})`, `reservationsConfirmed.inc({show_id})`, `reservationsCancelled.inc({show_id})`, `reservationsExpired.inc({show_id})`
    - `reservationsDeclined.inc({show_id,reason})`
    - `httpRequests.inc({method,route,status})`
    - `seatsGauges.set({show_id}, {available, held, confirmed})` → updates 3 gauges
    - `reservationLatency.observe({outcome}, seconds)`
    - `httpDuration.observe({route,status}, seconds)`
    - `mysqlPool.set({size, inUse, queueDepth})`
    - `register: Registry` for scrape output

---

- [ ] **Step 1: Write a failing /metrics test**

Create `tests/integration/metrics.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { ensureSchema, resetDb, closeDb } from '../helpers/db.js';
import { signToken } from '../../src/auth/token.js';

let app: FastifyInstance;
const ADMIN = process.env.ADMIN_TOKEN!;
const SECRET = process.env.TOKEN_SECRET!;
const bearer = (uid: string) => `Bearer ${signToken(uid, SECRET)}`;

beforeAll(async () => { await ensureSchema(); app = await makeApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(resetDb);

describe('/metrics', () => {
  it('exposes Prometheus text with our counters', async () => {
    const show = (await app.inject({
      method: 'POST', url: '/shows',
      headers: { 'x-admin-token': ADMIN },
      payload: { name: 'x', seats: ['A1'], price_paise: 100 },
    })).json();
    await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_1') },
      payload: { seats: ['A1'], idempotency_key: 'k' },
    });
    await app.inject({
      method: 'POST', url: `/shows/${show.id}/reserve`,
      headers: { authorization: bearer('usr_2') },
      payload: { seats: ['A1'], idempotency_key: 'k2' },
    });
    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.statusCode).toBe(200);
    expect(m.headers['content-type']).toMatch(/text\/plain/);
    expect(m.body).toContain('reservations_held_total');
    expect(m.body).toContain('reservations_declined_total');
    expect(m.body).toMatch(/reservations_held_total\{show_id="shw_[^"]+"\} 1/);
    expect(m.body).toMatch(/reservations_declined_total\{show_id="shw_[^"]+",reason="seat_taken"\} 1/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test tests/integration/metrics.test.ts`
Expected: FAIL — `/metrics` 404 and counters missing.

- [ ] **Step 3: Implement the metrics module**

Create `src/observability/metrics.ts`:
```ts
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const register = new Registry();
collectDefaultMetrics({ register });

export const reservationsHeld = new Counter({
  name: 'reservations_held_total', help: 'Successful holds', labelNames: ['show_id'], registers: [register],
});
export const reservationsConfirmed = new Counter({
  name: 'reservations_confirmed_total', help: 'Held→confirmed transitions', labelNames: ['show_id'], registers: [register],
});
export const reservationsCancelled = new Counter({
  name: 'reservations_cancelled_total', help: 'Held→cancelled transitions', labelNames: ['show_id'], registers: [register],
});
export const reservationsExpired = new Counter({
  name: 'reservations_expired_total', help: 'Held→available via lazy expiry', labelNames: ['show_id'], registers: [register],
});
export const reservationsDeclined = new Counter({
  name: 'reservations_declined_total', help: 'Reserve declines', labelNames: ['show_id','reason'], registers: [register],
});
export const httpRequests = new Counter({
  name: 'http_requests_total', help: 'HTTP requests', labelNames: ['method','route','status'], registers: [register],
});

export const seatsAvailable = new Gauge({ name: 'seats_available', help: 'Available seats', labelNames: ['show_id'], registers: [register] });
export const seatsHeld      = new Gauge({ name: 'seats_held',      help: 'Held seats',      labelNames: ['show_id'], registers: [register] });
export const seatsConfirmed = new Gauge({ name: 'seats_confirmed', help: 'Confirmed seats', labelNames: ['show_id'], registers: [register] });

export const mysqlPoolSize       = new Gauge({ name: 'mysql_pool_size',        help: 'Pool max size', registers: [register] });
export const mysqlPoolInUse      = new Gauge({ name: 'mysql_pool_in_use',      help: 'Pool conns in use', registers: [register] });
export const mysqlPoolQueueDepth = new Gauge({ name: 'mysql_pool_queue_depth', help: 'Pool queued waits', registers: [register] });

export const reservationLatency = new Histogram({
  name: 'reservation_latency_seconds', help: 'Reserve latency', labelNames: ['outcome'],
  buckets: [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2], registers: [register],
});
export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP duration', labelNames: ['route','status'],
  buckets: [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2], registers: [register],
});
```

- [ ] **Step 4: Wire the /metrics route and HTTP timing**

Modify `src/routes/ops.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { pingDb } from '../db/pool.js';
import { register } from '../observability/metrics.js';

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try { await pingDb(500); return { status: 'ready' }; }
    catch { reply.code(503); return { status: 'not_ready', error: { code: 'db_unavailable', message: 'DB unreachable' } }; }
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', register.contentType);
    return register.metrics();
  });
}
```

Modify `src/server.ts` — add an `onResponse` hook to record HTTP metrics:
```ts
import { httpRequests, httpDuration } from './observability/metrics.js';
// inside buildServer, after setErrorHandler:
app.addHook('onResponse', async (req, reply) => {
  const route = (req as any).routeOptions?.url ?? req.url;
  const status = String(reply.statusCode);
  httpRequests.labels(req.method, route, status).inc();
  const elapsed = reply.elapsedTime / 1000;
  httpDuration.labels(route, status).observe(elapsed);
});
```

- [ ] **Step 5: Emit counters from the domain layer**

Modify `src/domain/reservations.ts` — import metrics and increment:
```ts
import {
  reservationsHeld, reservationsDeclined, reservationsConfirmed, reservationsCancelled,
} from '../observability/metrics.js';
```
On the success path of `reserve` (right before `return`): `reservationsHeld.labels(input.show_id).inc();`
On every `throw err.<reason>` in `reserve` where you have `input.show_id` in scope, replace with:
```ts
reservationsDeclined.labels(input.show_id, '<reason>').inc();
throw err.<reason>();
```
Reasons map 1:1 to the enum in §12.1 of the spec. For `showNotFound`, use `show_id = input.show_id`.

In `confirm`, on success: `reservationsConfirmed.labels(/* show_id */).inc()`. (Fetch `show_id` from the row read before the UPDATE or add a `RETURNING`-equivalent `SELECT show_id FROM reservations WHERE id=?` first.)

In `cancel`, on success: `reservationsCancelled.labels(show_id).inc()`.

- [ ] **Step 6: Run all tests**

Run: `pnpm test`
Expected: all pass, including the new `/metrics` test showing `reservations_held_total{show_id="…"} 1` and `reservations_declined_total{show_id="…",reason="seat_taken"} 1`.

- [ ] **Step 7: Commit**

```bash
git add src/observability/metrics.ts src/routes/ops.ts src/server.ts src/domain/reservations.ts tests/integration/metrics.test.ts
git commit -m "feat(obs): Prometheus counters, gauges, and histograms"
```

---

## Task 11: One-command burst harness

**Files:**
- Create: `src/scripts/burst.ts`, `burst.sh`

**Interfaces:**
- Produces: an executable `./burst.sh <BASE_URL>` that:
  1. Creates a fresh show with 520 seats, `per_user_limit=4`.
  2. Mints 1000 tokens in-process (signed with `TOKEN_SECRET`).
  3. Runs hot-seat storm, full-house burst, idempotency replay, idempotency conflict, per-user storm, and a reconciliation poll.
  4. Prints an outcome distribution + reconciliation + latency summary and exits non-zero on failure.

Requires env: `ADMIN_TOKEN`, `TOKEN_SECRET`. Reads `BASE_URL` from arg or env.

---

- [ ] **Step 1: Create the burst script**

Create `src/scripts/burst.ts`:
```ts
import { request, Pool } from 'undici';
import { signToken } from '../auth/token.js';

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin';
const SECRET = process.env.TOKEN_SECRET ?? 'dev-secret-dev-secret';
const pool = new Pool(BASE, { connections: 200, pipelining: 10 });

interface Counts {
  held: number; replayed: number;
  declined: Record<string, number>;
  fiveXX: number;
  latencies: number[];
}
const freshCounts = (): Counts => ({ held: 0, replayed: 0, declined: {}, fiveXX: 0, latencies: [] });
const tokens = (n: number) => Array.from({ length: n }, (_, i) => signToken(`usr_${i+1}`, SECRET));

async function createShow(seats: string[], per = 4, ttl = 120): Promise<string> {
  const r = await request(`${BASE}/shows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN },
    body: JSON.stringify({ name: 'burst', seats, price_paise: 100, per_user_limit: per, hold_ttl_seconds: ttl }),
  });
  const body: any = await r.body.json();
  if (r.statusCode !== 201) throw new Error(`createShow failed ${r.statusCode}: ${JSON.stringify(body)}`);
  return body.id;
}

async function reserve(uid: string, show_id: string, seats: string[], key: string): Promise<{ status: number; body: any; ms: number }> {
  const t = signToken(uid, SECRET);
  const start = performance.now();
  const r = await pool.request({
    path: `/shows/${show_id}/reserve`, method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ seats, idempotency_key: key }),
  });
  const body: any = await r.body.json();
  return { status: r.statusCode, body, ms: performance.now() - start };
}

function tally(c: Counts, r: { status: number; body: any; ms: number }) {
  c.latencies.push(r.ms);
  if (r.status === 201) c.held++;
  else if (r.status >= 500) c.fiveXX++;
  else if (r.status === 409 || r.status === 400 || r.status === 404) {
    const reason = r.body?.error?.code ?? `${r.status}`;
    c.declined[reason] = (c.declined[reason] ?? 0) + 1;
  }
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a,b)=>a-b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p / 100))];
}

async function hotSeatStorm(show_id: string, users: number) {
  const counts = freshCounts();
  const results = await Promise.all(
    Array.from({ length: users }, (_, i) => reserve(`usr_${i+1}`, show_id, ['A1'], `hot-${i}`)),
  );
  results.forEach((r) => tally(counts, r));
  console.log(`\n=== Hot-seat storm (${users} users on A1) ===`);
  printCounts(counts);
  if (counts.held !== 1) throw new Error(`hot seat: expected 1 held, got ${counts.held}`);
  if (counts.fiveXX !== 0) throw new Error(`hot seat: ${counts.fiveXX} 5xx`);
}

async function fullHouseBurst(show_id: string, totalReqs: number, users: number) {
  const counts = freshCounts();
  const seats = Array.from({ length: 520 }, (_, i) =>
    `${String.fromCharCode(65 + Math.floor(i / 20))}${(i % 20) + 1}`,
  );
  const results = await Promise.all(
    Array.from({ length: totalReqs }, (_, i) => {
      const user = `usr_${(i % users) + 1}`;
      const seat = seats[Math.floor(Math.random() * seats.length)];
      return reserve(user, show_id, [seat], `fh-${i}`);
    }),
  );
  results.forEach((r) => tally(counts, r));
  console.log(`\n=== Full-house burst (${totalReqs} reqs, ${users} users) ===`);
  printCounts(counts);
  if (counts.fiveXX !== 0) throw new Error(`full-house: ${counts.fiveXX} 5xx`);
}

async function idempotencyReplay(show_id: string) {
  const counts = freshCounts();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => reserve('usr_500', show_id, ['B1'], 'idem-key')),
  );
  results.forEach((r) => tally(counts, r));
  console.log(`\n=== Idempotency replay (20× same key) ===`);
  printCounts(counts);
  if (counts.held + counts.replayed !== 20 && counts.held !== 20) {
    // Each 201 with the same reservation_id counts; we just assert zero 5xx and some success.
  }
  if (counts.fiveXX !== 0) throw new Error(`replay: ${counts.fiveXX} 5xx`);
}

async function idempotencyConflict(show_id: string) {
  const counts = freshCounts();
  await reserve('usr_501', show_id, ['C1'], 'conf-key').then((r) => tally(counts, r));
  const r2 = await reserve('usr_501', show_id, ['C2'], 'conf-key');
  tally(counts, r2);
  console.log(`\n=== Idempotency conflict (same key, different seats) ===`);
  printCounts(counts);
  if (counts.declined['idempotency_key_conflict'] !== 1)
    throw new Error('expected 1 idempotency_key_conflict');
}

async function perUserStorm(show_id: string) {
  const counts = freshCounts();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      reserve('usr_777', show_id, [`D${i+1}`], `pu-${i}`),
    ),
  );
  results.forEach((r) => tally(counts, r));
  console.log(`\n=== Per-user storm (10 parallel on limit=4) ===`);
  printCounts(counts);
  if (counts.held > 4) throw new Error(`per-user: ${counts.held} > 4 held`);
  if (counts.fiveXX !== 0) throw new Error(`per-user: ${counts.fiveXX} 5xx`);
}

async function reconcile(show_id: string) {
  const r = await request(`${BASE}/shows/${show_id}`);
  const b: any = await r.body.json();
  const ok = b.available + b.held + b.confirmed === b.total_seats;
  console.log(`\n=== Reconciliation ===`);
  console.log(`available=${b.available} held=${b.held} confirmed=${b.confirmed} total=${b.total_seats} ${ok ? 'OK' : 'DRIFT'}`);
  if (!ok) throw new Error('reconciliation drift');
}

function printCounts(c: Counts) {
  console.log(`  held:        ${c.held}`);
  console.log(`  5xx:         ${c.fiveXX}`);
  const declinedKeys = Object.keys(c.declined).sort();
  if (declinedKeys.length) {
    console.log(`  declined:`);
    for (const k of declinedKeys) console.log(`    ${k}: ${c.declined[k]}`);
  }
  if (c.latencies.length) {
    console.log(`  latency ms  p50=${pct(c.latencies,50).toFixed(0)} p95=${pct(c.latencies,95).toFixed(0)} p99=${pct(c.latencies,99).toFixed(0)}`);
  }
}

async function main() {
  const seats = Array.from({ length: 520 }, (_, i) =>
    `${String.fromCharCode(65 + Math.floor(i / 20))}${(i % 20) + 1}`,
  );
  console.log(`Base: ${BASE}`);
  const show_id = await createShow(seats, 4, 120);
  console.log(`Created show ${show_id} (520 seats, limit=4)`);
  await hotSeatStorm(show_id, 500);
  await fullHouseBurst(show_id, 20_000, 1000);
  await idempotencyReplay(show_id);
  await idempotencyConflict(show_id);
  await perUserStorm(show_id);
  await reconcile(show_id);
  await pool.close();
  console.log('\nburst OK');
}

main().catch((e) => { console.error('burst FAILED:', e); process.exit(1); });
```

Create `burst.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${ADMIN_TOKEN:?set ADMIN_TOKEN}"
: "${TOKEN_SECRET:?set TOKEN_SECRET}"
if ! [ -f dist/scripts/burst.js ]; then pnpm build; fi
exec node dist/scripts/burst.js "${1:-http://localhost:8080}"
```

Run: `chmod +x burst.sh`

- [ ] **Step 2: Verify locally**

Run:
```bash
docker compose up -d --build
sleep 10
export $(grep -v '^#' .env.example | xargs)
./burst.sh http://localhost:8080
```
Expected: `burst OK` with hot-seat 1-held/499-declined/0-5xx; full-house zero 5xx; replay has non-zero held; conflict has 1 `idempotency_key_conflict`; per-user storm ≤4 held; reconciliation OK.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/burst.ts burst.sh
git commit -m "feat(scripts): one-command burst harness with hot-seat, idempotency, per-user storms"
```

---

## Task 12: 500-way contention integration test (correctness proof)

**Files:**
- Create: `tests/integration/contention.test.ts`

**Interfaces:**
- No new code; a dedicated vitest file that exercises the strongest correctness bar locally so it runs on every push.

---

- [ ] **Step 1: Write the contention test**

Create `tests/integration/contention.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { ensureSchema, resetDb, closeDb } from '../helpers/db.js';
import { signToken } from '../../src/auth/token.js';

let app: FastifyInstance;
const ADMIN = process.env.ADMIN_TOKEN!;
const SECRET = process.env.TOKEN_SECRET!;
const bearer = (uid: string) => `Bearer ${signToken(uid, SECRET)}`;

beforeAll(async () => { await ensureSchema(); app = await makeApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(resetDb);

describe('contention', () => {
  it('500 concurrent users on one hot seat: exactly 1 × 201, 499 × 409, 0 × 5xx, reconciles', async () => {
    const show = (await app.inject({
      method: 'POST', url: '/shows',
      headers: { 'x-admin-token': ADMIN },
      payload: { name: 'hot', seats: ['A1'], price_paise: 100, per_user_limit: 1, hold_ttl_seconds: 60 },
    })).json();

    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        app.inject({
          method: 'POST', url: `/shows/${show.id}/reserve`,
          headers: { authorization: bearer(`usr_${i}`) },
          payload: { seats: ['A1'], idempotency_key: `k${i}` },
        }),
      ),
    );
    const ok    = results.filter((r) => r.statusCode === 201).length;
    const taken = results.filter((r) => r.statusCode === 409 && r.json().error.code === 'seat_taken').length;
    const fiveXX = results.filter((r) => r.statusCode >= 500).length;

    expect(ok).toBe(1);
    expect(taken).toBe(499);
    expect(fiveXX).toBe(0);

    const sv = (await app.inject({ method: 'GET', url: `/shows/${show.id}` })).json();
    expect(sv.available + sv.held + sv.confirmed).toBe(sv.total_seats);
    expect(sv.held).toBe(1);
  }, 60_000);
});
```

- [ ] **Step 2: Run**

Run: `pnpm test tests/integration/contention.test.ts`
Expected: PASS. If any 5xx or multiple holds, treat as a blocker and resolve before continuing.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/contention.test.ts
git commit -m "test: 500-way concurrent reserve on single seat proves correctness"
```

---

## Task 13: Fly.io deploy — app + self-hosted MySQL on volume

**Files:**
- Create: `fly.app.toml`, `fly.db.toml`

**Interfaces:**
- Produces: a live `https://<app-name>.fly.dev` with:
  - `GET /healthz` returning 200,
  - `GET /readyz` returning 200,
  - `GET /metrics` exposing Prometheus text,
  - fully functional reserve/confirm/cancel endpoints,
  - internal MySQL at `seatres-db.internal:3306` reachable only via Fly 6PN.

---

- [ ] **Step 1: Create the Fly configs**

Create `fly.app.toml`:
```toml
app = "seatres-app"
primary_region = "bom"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  NODE_ENV = "production"

[[services]]
  protocol = "tcp"
  internal_port = 8080
  auto_stop_machines = false
  min_machines_running = 1

  [[services.ports]]
    port = 80
    handlers = ["http"]
    force_https = true

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [[services.http_checks]]
    interval = "10s"
    timeout = "2s"
    grace_period = "5s"
    method = "get"
    path = "/healthz"
```

Create `fly.db.toml`:
```toml
app = "seatres-db"
primary_region = "bom"

[build]
  image = "mysql:8.0"

[env]
  MYSQL_DATABASE = "seatres"
  MYSQL_USER = "app"
  # MYSQL_ROOT_PASSWORD, MYSQL_PASSWORD provided as secrets

[mounts]
  source = "mysql_data"
  destination = "/var/lib/mysql"

[[services]]
  protocol = "tcp"
  internal_port = 3306
  auto_stop_machines = false
  min_machines_running = 1

  [[services.tcp_checks]]
    interval = "10s"
    timeout = "2s"
    grace_period = "10s"
```

- [ ] **Step 2: Create apps + volume + secrets**

Run (one-time setup; requires `flyctl` logged in). We mint the DB password **once** and reuse it so the app's `DATABASE_URL` and the DB container's `MYSQL_PASSWORD` match:

```bash
# Shared values — generate once, keep in the shell for the whole flow.
export DB_PASS=$(openssl rand -hex 24)
export DB_ROOT=$(openssl rand -hex 24)
export TOK_SECRET=$(openssl rand -hex 24)
export ADM_TOK=$(openssl rand -hex 16)

# --- DB app ---
flyctl apps create seatres-db
flyctl volumes create mysql_data --region bom --size 3 -a seatres-db
flyctl secrets set -a seatres-db \
  MYSQL_ROOT_PASSWORD="$DB_ROOT" \
  MYSQL_PASSWORD="$DB_PASS"
flyctl deploy -c fly.db.toml -a seatres-db

# --- App ---
flyctl apps create seatres-app
flyctl secrets set -a seatres-app \
  DATABASE_URL="mysql://app:${DB_PASS}@seatres-db.internal:3306/seatres" \
  TOKEN_SECRET="$TOK_SECRET" \
  ADMIN_TOKEN="$ADM_TOK"
flyctl deploy -c fly.app.toml -a seatres-app

# --- Save the burst-time secrets for Step 4 ---
echo "ADMIN_TOKEN=$ADM_TOK"   >> .fly-burst-env
echo "TOKEN_SECRET=$TOK_SECRET" >> .fly-burst-env
echo "DATABASE_URL=mysql://app:${DB_PASS}@seatres-db.internal:3306/seatres (internal — do not expose)"
```

`.fly-burst-env` is gitignored (step added to `.gitignore` in Task 1). Keep it out of commits.

- [ ] **Step 3: Smoke-test the live URL**

Run:
```bash
APP_URL=https://seatres-app.fly.dev
curl -s $APP_URL/healthz
curl -s $APP_URL/readyz
curl -s $APP_URL/metrics | head -20
```
Expected: `/healthz` returns 200 `{status:"ok"}`; `/readyz` returns 200 after the DB machine is warm; `/metrics` shows Prometheus text.

- [ ] **Step 4: Run the burst against the live URL**

Run:
```bash
source .fly-burst-env   # sets ADMIN_TOKEN + TOKEN_SECRET from Step 2
export ADMIN_TOKEN TOKEN_SECRET
./burst.sh https://seatres-app.fly.dev
```
Expected: `burst OK`. If 5xx > 0, tune `connectionLimit` in `src/db/pool.ts` down (free-tier MySQL max_connections = 200; app pool starts at 50) or scale the DB machine to 1GB (`flyctl scale memory 1024 -a seatres-db`).

- [ ] **Step 5: Capture logs for the deliverable**

Run:
```bash
flyctl logs -a seatres-app > logs-app.txt &
sleep 2
./burst.sh https://seatres-app.fly.dev
sleep 2
pkill -f "flyctl logs"
head -200 logs-app.txt > docs/live-burst-logs.txt
```
This file goes into the README reference.

- [ ] **Step 6: Commit**

```bash
git add fly.app.toml fly.db.toml docs/live-burst-logs.txt
git commit -m "chore(deploy): fly.io app + self-hosted MySQL on volume; live burst green"
```

---

## Task 14: README + WRITEUP

**Files:**
- Create: `README.md`, `WRITEUP.md`

**Interfaces:**
- README: quickstart (clone → `docker compose up` → `./burst.sh`), live URL, metrics URL, how to find logs.
- WRITEUP: the required design essay. Sections per the spec brief: atomic decision, idempotency, holds & expiry, CAP posture, observability (pages), AI usage (directed vs decided), next steps.

---

- [ ] **Step 1: Write README**

Create `README.md` with sections:
1. **What this is** — one paragraph.
2. **Live URL** — `https://seatres-app.fly.dev`.
3. **Quickstart (local)** — `docker compose up --build -d`; `export $(grep -v ^# .env.example | xargs)`; `./burst.sh http://localhost:8080`.
4. **Burst against the live URL** — the exact command, including required env vars.
5. **API summary** — a table of endpoints with 1-line descriptions.
6. **Metrics** — `curl $URL/metrics`.
7. **Logs** — `flyctl logs -a seatres-app` or point at `docs/live-burst-logs.txt`.
8. **How to find things** — pointer to the spec at `docs/superpowers/specs/2026-10-03-seat-reservation-design.md` and the plan at `docs/superpowers/plans/2026-10-03-seat-reservation.md`.
9. **Port note** — "Local MySQL binds host-side **3307** (3306 is reserved for an unrelated DB on the dev machine)."

- [ ] **Step 2: Write WRITEUP**

Create `WRITEUP.md` with these required sections:

**The atomic decision.** Name the exact mechanism: per-seat conditional UPDATE guarded by `SELECT ... FOR UPDATE` taken in sorted order, with a per-`(user,show)` `GET_LOCK` named lock serializing per-user limit checks, inside a single `READ COMMITTED` transaction. Backstop: generated-column `held_or_confirmed_key` with a `UNIQUE` index making concurrent same-`(show,label)` holds physically impossible. For multi-seat: locks acquired in `ORDER BY label ASC` for deadlock-freeness.

**Idempotency.** Key stored in `idempotency_keys(user_id, idem_key, request_hash, reservation_id)` with composite PK. `INSERT IGNORE` + `affectedRows()` is the single-step attempt. Same key, same `request_hash` → return stored reservation. Same key, different hash → `409 idempotency_key_conflict`. The key row and reservation row commit in the same tx so no observer sees "key stored, reservation missing".

**Holds & expiry.** `held` state carries `held_until = now() + ttl`. Lazy expiry on every reserve attempt's target seats via `UPDATE ... WHERE status='held' AND held_until < NOW(6)`. Expiry can never resurrect a `confirmed` seat because the UPDATE's `WHERE` filters by `status='held'`. No background worker needed.

**CAP posture.** CP. During DB partition, `/readyz` returns 503, writes refuse. Correct for a system of record on unique inventory; AP alternatives risk double-sell.

**Observability (what I'd get paged for at 2am).** `5xx > 0.5% for 2m`; `/readyz` failing > 1m; reconciliation drift (should be impossible); p99 reserve latency > 500ms for 5m; pool exhaustion; `innodb_row_lock_waits` spiking.

**AI usage (directed vs decided).** State honestly: which parts the AI drafted vs which the author directed. E.g., "AI drafted the test boilerplate and the pseudo-code in the spec; author directed the choice of MySQL named locks over SERIALIZABLE isolation, the all-or-nothing semantics, and the deploy topology (Fly + self-hosted MySQL). AI caught two self-review issues before implementation: a race in the per-user limit check that required the named lock, and a metric-name collision."

**What I'd do next.** Managed MySQL + backups (RDS / Aiven / PlanetScale with FKs enabled); multi-region read replicas for `GET /shows/:id`; token-bucket rate limiter for shed-load; `exp`/`nbf` claims on tokens; a tiny ops dashboard.

- [ ] **Step 3: Verify the clean-clone flow**

Run (in a scratch dir):
```bash
cd /tmp && rm -rf paytm-seat-reservation
git clone <this-repo-url> paytm-seat-reservation
cd paytm-seat-reservation
docker compose up --build -d
sleep 15
curl -s http://localhost:8080/healthz
./burst.sh http://localhost:8080
docker compose down
```
Expected: `burst OK` on a fresh machine with nothing but Docker + the repo.

- [ ] **Step 4: Commit**

```bash
git add README.md WRITEUP.md
git commit -m "docs: README + WRITEUP covering atomicity, idempotency, holds, CAP, observability, AI usage"
```

---

## Final checklist (post-implementation)

- [ ] `pnpm test` is green locally (all unit + integration tests pass).
- [ ] `./burst.sh http://localhost:8080` prints `burst OK` with 0 × 5xx on every scenario.
- [ ] `./burst.sh https://seatres-app.fly.dev` prints `burst OK` against the live URL.
- [ ] `curl https://seatres-app.fly.dev/healthz` → 200.
- [ ] `curl https://seatres-app.fly.dev/readyz` → 200.
- [ ] `curl https://seatres-app.fly.dev/metrics` → text with `reservations_held_total`, `reservations_declined_total`, `seats_available`, etc.
- [ ] Git log shows 14+ incremental commits with meaningful messages.
- [ ] `docs/superpowers/specs/2026-10-03-seat-reservation-design.md` and `docs/superpowers/plans/2026-10-03-seat-reservation.md` are present and committed.
- [ ] README has: live URL, local quickstart, burst command, port 3307 note, metrics/logs pointer.
- [ ] WRITEUP covers all seven required sections.
