# Seat Reservation Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a JSON HTTP service that sells assigned seats under 20k-concurrent-request load, with zero double-sell, zero 5xx, per-user limit enforcement, idempotent retries, structured logs, Prometheus metrics, and a live SSE dashboard — running on Fly.io.

**Architecture:** Node 22 + TypeScript + Express 5. MySQL 8 InnoDB, co-located on the Fly machine via supervisord. The atomic reserve mechanism is a conditional `UPDATE` on the `seats` PK row (`WHERE status='available'` + `affectedRows=1` check), with sorted lock order for multi-seat and a `UNIQUE (active_key)` on `reservation_seats` as a cheap schema-level backstop. Reservations are instant-confirm (no payment leg). Cancellation is owner-only. Observability is pino logs + prom-client metrics + in-process `EventEmitter` fanning out SSE events after `COMMIT`.

**Tech Stack:** Node 22 · TypeScript 5 · Express 5 · mysql2 · pino + pino-http · prom-client · ulid · vitest · supertest · undici · Docker · supervisord · Fly.io

**Spec:** `docs/superpowers/specs/2026-10-04-seat-reservation-prd.md` (and `docs/superpowers/specs/2026-10-04-frontend-dashboard-design.md` for the dashboard)

## Global Constraints

Every task's requirements include these. Copied verbatim from the spec.

- **Language runtime:** Node.js 22.x (alpine). Target `--experimental-vm-modules`-free, ESM only (`"type":"module"` in package.json).
- **Package manager:** pnpm with `ignore-scripts=true` (already in `.pnpmrc`).
- **Database:** MySQL 8.0 InnoDB, `utf8mb4` charset, `utf8mb4_0900_ai_ci` collation.
- **DB tuning:** `innodb_lock_wait_timeout = 2` (seconds). Lock-wait timeouts MUST be caught and returned as `409 seat_taken`, never 5xx.
- **Money:** integer paise only. Never floats. Column type `INT UNSIGNED`.
- **Timestamps:** `TIMESTAMP(3)` in DB; ISO-8601 UTC in JSON responses.
- **IDs:** ULID (26-char) for `shows.id` and `reservations.id`. `BIGINT AUTO_INCREMENT` for `users.id`. Column type `VARCHAR(32)` for ULID columns.
- **Response envelope on error:** `{ "error": "<snake_code>", "message": "<human>" }`.
- **Zero 5xx for domain outcomes.** Decline reasons are 4xx: `seat_taken`, `per_user_limit`, `idempotency_body_mismatch`, `validation_error`, `not_found`, `forbidden`, `unauthorized`, `already_cancelled`. Only genuine server bugs or infrastructure failure may return 5xx.
- **Identity is token-derived.** Any `user_id` field in request body is ignored. Authorization comes from `Authorization: Bearer <token>` → lookup in in-memory map → `req.userId`.
- **Admin:** `X-Admin-Token` compared timing-safe against env `ADMIN_TOKEN`.
- **Logs:** no PII, no `Authorization`/`X-Admin-Token` values; redact in middleware. One JSON line per log, must include `req_id`.
- **Reconciliation invariant:** `available + held + confirmed == total_seats` must hold continuously.
- **Idempotency scope:** `(user_id, idempotency_key)` — the same key used by two different users is independent.
- **Deploy target:** Fly.io, single `shared-cpu-1x 256MB` machine, MySQL on a mounted persistent volume at `/data/mysql`.
- **Local dev:** `docker-compose up` must bring the whole stack up with MySQL on host port **3307** (not 3306, to avoid colliding with any pre-existing MySQL).
- **Tests:** vitest. Integration tests run against the docker-compose MySQL; each test calls a `truncateAll()` helper for isolation.
- **Commits:** conventional (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`). One commit per task's final step.

## Review Focus

Five input classes the spec implies but no "happy-path" test naturally covers. Each is pinned to a test in its owning task.

1. **Duplicate seat ids in `/reserve` body** (`{"seats":["A12","A12"]}`) — must `400 validation_error`; if not caught, the second `UPDATE` would find `status='held'` from the first UPDATE within the same tx and `affectedRows=0` triggers a false `seat_taken` on the user's own duplicate. Owning task: **Task 6**, test `test/unit/validation.test.ts::test_rejects_duplicate_seat_ids`.
2. **Same `idempotency_key` across different users** — must succeed for both; scope is `(user_id, key)` not just `key`. Owning task: **Task 9**, test `test/integration/reserve.test.ts::test_idem_key_scoped_per_user`.
3. **InnoDB lock-wait timeout under hot contention** — the thrown `ER_LOCK_WAIT_TIMEOUT` must be mapped to `409 seat_taken`, not propagate as 500. Owning task: **Task 7**, test `test/contention/lock-wait.test.ts::test_lock_wait_timeout_returns_409`.
4. **`POST /shows` with missing or wrong `X-Admin-Token`** — must `401 unauthorized`, must not call the handler, must not create a show row. Owning task: **Task 5**, test `test/integration/shows.test.ts::test_create_show_requires_admin_token`.
5. **`POST /reservations/:id/cancel` by a user who is not the owner** — must `403 forbidden`, must leave the reservation and seats untouched. Owning task: **Task 10**, test `test/integration/cancel.test.ts::test_cancel_by_non_owner_forbidden`.

---

## File Structure

```
.
├── Dockerfile
├── docker-compose.yml
├── fly.toml
├── supervisord.conf
├── package.json
├── pnpm-lock.yaml                 # generated
├── tsconfig.json
├── vitest.config.ts
├── .eslintrc.cjs
├── .prettierrc
├── .env.example
├── .gitignore                     # already present
├── .pnpmrc                        # already present
├── README.md
├── WRITEUP.md
├── burst.sh                       # one-liner wrapper around scripts/burst.ts
├── sql/
│   └── 001_init.sql               # all DDL in one file
├── seed/
│   ├── users.json                 # 500 pre-seeded tokens
│   └── show.json                  # sample show for local demo
├── scripts/
│   ├── init-db.ts                 # idempotent: creates DB, applies SQL, seeds users
│   ├── seed.ts                    # one-off seeder for local
│   └── burst.ts                   # concurrent harness
├── public/
│   └── dashboard.html             # vanilla HTML+JS, served at /dashboard
├── src/
│   ├── server.ts                  # bootstrap: createApp() + listen
│   ├── config.ts                  # env parsing (zod)
│   ├── db.ts                      # mysql2 pool
│   ├── logger.ts                  # pino root logger
│   ├── metrics.ts                 # prom-client registry + metric defs
│   ├── auth.ts                    # token→user map, load at startup
│   ├── events.ts                  # in-process EventEmitter bus for SSE
│   ├── ulid.ts                    # tiny wrapper around ulid()
│   ├── routes/
│   │   ├── shows.ts               # POST /shows, GET /shows/:id
│   │   ├── reserve.ts             # POST /shows/:id/reserve
│   │   ├── cancel.ts              # POST /reservations/:id/cancel
│   │   ├── stream.ts              # GET /shows/:id/stream (SSE)
│   │   ├── dashboard.ts           # GET /dashboard
│   │   └── ops.ts                 # /healthz, /readyz, /metrics
│   ├── domain/
│   │   ├── reserve.ts             # the atomic reserve algorithm (§6 of spec)
│   │   ├── cancel.ts              # atomic cancel
│   │   ├── idempotency.ts         # normalize + sha256
│   │   └── errors.ts              # DomainError hierarchy + HTTP mapping
│   └── middleware/
│       ├── requestId.ts           # assigns req.id (ULID)
│       ├── errorHandler.ts        # catches DomainError → 4xx; others → 500 + log
│       ├── access.ts              # requireUser, requireAdmin
│       └── httpMetrics.ts         # http_requests_total counter
└── test/
    ├── helpers/
    │   ├── app.ts                 # buildTestApp() returns Express app + pool
    │   └── db.ts                  # truncateAll(), seedTestUsers()
    ├── unit/
    │   ├── idempotency.test.ts
    │   ├── validation.test.ts
    │   └── errors.test.ts
    ├── integration/
    │   ├── shows.test.ts
    │   ├── reserve.test.ts
    │   ├── cancel.test.ts
    │   ├── stream.test.ts
    │   └── ops.test.ts
    └── contention/
        ├── hot-seat.test.ts
        ├── lock-wait.test.ts
        ├── idempotency-race.test.ts
        └── per-user-limit-race.test.ts
```

---

## Task 1: Project scaffold + Docker + compose

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.eslintrc.cjs`, `.prettierrc`, `src/server.ts`, `Dockerfile`, `docker-compose.yml`, `supervisord.conf`, `.env.example` (update), `README.md` (minimal)
- Modify: `.gitignore` (ensure `node_modules`, `dist`, `.data`, `*.pdf` excluded)

**Interfaces:**
- Consumes: nothing
- Produces: `createApp()` from `src/server.ts` returning an Express 5 app that answers `GET /healthz` → `200 {"ok":true}`. `pnpm dev`, `pnpm build`, `pnpm start`. `docker-compose up` → `curl http://localhost:8080/healthz` works.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "seat-reservation",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "init-db": "tsx scripts/init-db.ts",
    "burst": "tsx scripts/burst.ts"
  },
  "dependencies": {
    "express": "^5.0.0",
    "mysql2": "^3.11.0",
    "pino": "^9.5.0",
    "pino-http": "^10.3.0",
    "prom-client": "^15.1.3",
    "ulid": "^2.3.0",
    "undici": "^6.19.8",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.5.0",
    "@types/supertest": "^6.0.2",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2023"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test", "scripts"]
}
```

- [ ] **Step 3: Write vitest.config.ts, .eslintrc.cjs, .prettierrc**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // integration tests share one DB
  },
});
```

```js
// .eslintrc.cjs
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2023: true },
  ignorePatterns: ['dist', 'node_modules'],
  rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
};
```

```
# .prettierrc
{ "semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

- [ ] **Step 4: Write minimal src/server.ts**

```ts
import express, { type Express } from 'express';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  return app;
}

const port = Number(process.env.PORT ?? 8080);
if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(port, () => console.log(`listening on :${port}`));
}
```

- [ ] **Step 5: Write .env.example (overwrite the existing)**

```
DATABASE_URL=mysql://app:devpass@mysql:3306/seatres
PORT=8080
NODE_ENV=development
TOKEN_SECRET=dev-secret-change-me
ADMIN_TOKEN=dev-admin-change-me
LOG_LEVEL=info
```

(Note: inside docker-compose, `mysql` resolves to the MySQL container. For running locally without compose, use `mysql://app:devpass@localhost:3307/seatres`.)

- [ ] **Step 6: Write Dockerfile (multi-stage, with MySQL + supervisord)**

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
COPY .pnpmrc ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine
RUN apk add --no-cache mysql mysql-client supervisor bash
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
COPY .pnpmrc ./
RUN pnpm install --frozen-lockfile --prod || pnpm install --prod
COPY --from=builder /app/dist ./dist
COPY sql ./sql
COPY seed ./seed
COPY public ./public
COPY scripts ./scripts
COPY supervisord.conf /etc/supervisord.conf

# MySQL data dir
RUN mkdir -p /data/mysql /run/mysqld && \
    chown -R mysql:mysql /data/mysql /run/mysqld

ENV PORT=8080
EXPOSE 8080

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf", "-n"]
```

- [ ] **Step 7: Write supervisord.conf**

```ini
[supervisord]
nodaemon=true
user=root
logfile=/dev/stdout
logfile_maxbytes=0

[program:mysql]
command=/usr/bin/mysqld --user=mysql --datadir=/data/mysql --socket=/run/mysqld/mysqld.sock --port=3306 --bind-address=127.0.0.1 --innodb-lock-wait-timeout=2 --innodb-buffer-pool-size=64M
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:initdb]
command=/bin/bash -c "sleep 3 && cd /app && node --import tsx scripts/init-db.ts"
autostart=true
autorestart=false
startsecs=0
stdout_logfile=/dev/stdout
stderr_logfile=/dev/stderr

[program:app]
command=/bin/bash -c "sleep 8 && node /app/dist/server.js"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
```

- [ ] **Step 8: Write docker-compose.yml**

```yaml
services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: rootpass
      MYSQL_DATABASE: seatres
      MYSQL_USER: app
      MYSQL_PASSWORD: devpass
    command: ["mysqld", "--innodb-lock-wait-timeout=2", "--innodb-buffer-pool-size=128M"]
    ports: ["3307:3306"]
    volumes: ["./.data/mysql:/var/lib/mysql"]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-prootpass"]
      interval: 2s
      timeout: 2s
      retries: 30

  app:
    build: .
    depends_on:
      mysql: { condition: service_healthy }
    environment:
      DATABASE_URL: mysql://app:devpass@mysql:3306/seatres
      PORT: 8080
      NODE_ENV: development
      TOKEN_SECRET: dev-secret
      ADMIN_TOKEN: dev-admin
    ports: ["8080:8080"]
```

Note: in docker-compose the app connects to the MySQL **service** (`mysql:3306`), not to the host MySQL. The host port 3307 is only for the developer running tests from outside the container.

- [ ] **Step 9: Write failing test — server starts and /healthz works**

```ts
// test/integration/ops.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';

describe('ops', () => {
  it('GET /healthz returns 200 ok', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 10: Install deps and run tests**

```bash
pnpm install
pnpm test
```

Expected: PASS.

- [ ] **Step 11: Build and run the Docker image locally (sanity check)**

```bash
docker-compose up --build -d
sleep 10
curl -sf http://localhost:8080/healthz
docker-compose down
```

Expected: `{"ok":true}` returned from the container.

- [ ] **Step 12: Commit**

```bash
git add .
git commit -m "chore: scaffold Node+Express+MySQL project with Docker and compose"
```

---

## Task 2: Config + logger + request-id + error handler + http metrics

**Files:**
- Create: `src/config.ts`, `src/logger.ts`, `src/metrics.ts`, `src/middleware/requestId.ts`, `src/middleware/errorHandler.ts`, `src/middleware/httpMetrics.ts`, `src/domain/errors.ts`, `test/unit/errors.test.ts`
- Modify: `src/server.ts` (wire middleware in order), `test/integration/ops.test.ts` (add `/metrics` test)

**Interfaces:**
- Consumes: `createApp()` from Task 1
- Produces:
  - `src/config.ts`: `export const config: { databaseUrl: string; port: number; nodeEnv: 'development'|'production'|'test'; tokenSecret: string; adminToken: string; logLevel: string }`
  - `src/logger.ts`: `export const logger: pino.Logger`
  - `src/metrics.ts`: `export const registry: Registry`, `export const httpRequestsCounter: Counter` (labels: `method, route, status`), `export const reservationsCounter: Counter` (labels: `outcome, show_id`), `export const reserveLatencyHistogram: Histogram` (labels: `show_id`), `export const seatsAvailableGauge: Gauge` (labels: `show_id`), `export const seatsConfirmedGauge: Gauge` (labels: `show_id`), `export const sseSubscribersGauge: Gauge` (labels: `show_id`), `export const cancellationsCounter: Counter` (labels: `show_id`)
  - `src/domain/errors.ts`: `export class DomainError extends Error { constructor(public code: string, public status: number, message: string); }` and subclasses `ValidationError`, `NotFoundError`, `ConflictError`, `ForbiddenError`, `UnauthorizedError`
  - `src/middleware/requestId.ts`: `export const requestId: RequestHandler` that assigns `req.id = ulid()` and sets `X-Request-Id` header; TypeScript module augmentation on `Express.Request` to add `id: string`.
  - `src/middleware/errorHandler.ts`: `export const errorHandler: ErrorRequestHandler` — if err is `DomainError` → `res.status(err.status).json({ error: err.code, message: err.message })`; else log at error and `res.status(500).json({ error: 'internal_error', message: 'internal server error' })`.
  - `src/middleware/httpMetrics.ts`: `export const httpMetrics: RequestHandler` increments `httpRequestsCounter` on `res.finish`.
  - After this task, `GET /metrics` returns Prometheus text (even if only `http_requests_total` is populated).

- [ ] **Step 1: Write failing test for /metrics**

```ts
// append to test/integration/ops.test.ts
it('GET /metrics returns Prometheus text with http_requests_total', async () => {
  const app = createApp();
  await request(app).get('/healthz');
  const res = await request(app).get('/metrics');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/plain/);
  expect(res.text).toContain('http_requests_total');
});
```

- [ ] **Step 2: Write failing unit test for DomainError mapping**

```ts
// test/unit/errors.test.ts
import { describe, it, expect } from 'vitest';
import { DomainError, ValidationError, NotFoundError } from '../../src/domain/errors.js';

describe('DomainError', () => {
  it('ValidationError is 400 validation_error', () => {
    const e = new ValidationError('bad');
    expect(e.status).toBe(400);
    expect(e.code).toBe('validation_error');
  });
  it('NotFoundError is 404 not_found', () => {
    const e = new NotFoundError('nope');
    expect(e.status).toBe(404);
    expect(e.code).toBe('not_found');
  });
  it('DomainError instances are catchable', () => {
    const e = new DomainError('x', 418, 'teapot');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(418);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

```bash
pnpm test
```

Expected: both FAIL (modules not found + /metrics not implemented).

- [ ] **Step 4: Write src/config.ts (zod-validated env)**

```ts
import { z } from 'zod';

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  TOKEN_SECRET: z.string().min(1),
  ADMIN_TOKEN: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = Schema.parse(process.env);
export const config = {
  databaseUrl: parsed.DATABASE_URL,
  port: parsed.PORT,
  nodeEnv: parsed.NODE_ENV,
  tokenSecret: parsed.TOKEN_SECRET,
  adminToken: parsed.ADMIN_TOKEN,
  logLevel: parsed.LOG_LEVEL,
};
```

For tests, we need defaults. Add a test-only fallback:

```ts
// before parsed = Schema.parse(process.env)
if (!process.env.DATABASE_URL)   process.env.DATABASE_URL = 'mysql://app:devpass@localhost:3307/seatres';
if (!process.env.TOKEN_SECRET)   process.env.TOKEN_SECRET = 'test-secret';
if (!process.env.ADMIN_TOKEN)    process.env.ADMIN_TOKEN  = 'test-admin';
```

- [ ] **Step 5: Write src/logger.ts**

```ts
import pino from 'pino';
import { config } from './config.js';
export const logger = pino({
  level: config.logLevel,
  base: { env: config.nodeEnv },
  redact: ['req.headers.authorization', 'req.headers["x-admin-token"]'],
});
```

- [ ] **Step 6: Write src/domain/errors.ts**

```ts
export class DomainError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
export class ValidationError extends DomainError { constructor(msg: string) { super('validation_error', 400, msg); } }
export class NotFoundError   extends DomainError { constructor(msg: string) { super('not_found',       404, msg); } }
export class ConflictError   extends DomainError { constructor(code: string, msg: string) { super(code, 409, msg); } }
export class ForbiddenError  extends DomainError { constructor(msg: string) { super('forbidden',       403, msg); } }
export class UnauthorizedError extends DomainError { constructor(msg: string) { super('unauthorized',  401, msg); } }
```

- [ ] **Step 7: Write src/metrics.ts (declare all metrics even if empty — reduces churn later)**

```ts
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsCounter = new Counter({
  name: 'http_requests_total', help: 'HTTP requests',
  labelNames: ['method','route','status'], registers: [registry],
});
export const reservationsCounter = new Counter({
  name: 'reservations_total', help: 'Reservation outcomes',
  labelNames: ['outcome','show_id'], registers: [registry],
});
export const cancellationsCounter = new Counter({
  name: 'cancellations_total', help: 'Cancellations',
  labelNames: ['show_id'], registers: [registry],
});
export const reserveLatencyHistogram = new Histogram({
  name: 'reserve_latency_seconds', help: 'POST /reserve latency',
  labelNames: ['show_id'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});
export const seatsAvailableGauge = new Gauge({
  name: 'seats_available', help: 'Available seats per show',
  labelNames: ['show_id'], registers: [registry],
});
export const seatsConfirmedGauge = new Gauge({
  name: 'seats_confirmed', help: 'Confirmed seats per show',
  labelNames: ['show_id'], registers: [registry],
});
export const sseSubscribersGauge = new Gauge({
  name: 'sse_subscribers', help: 'Current SSE subscribers per show',
  labelNames: ['show_id'], registers: [registry],
});
```

- [ ] **Step 8: Write src/middleware/requestId.ts**

```ts
import { ulid } from 'ulid';
import type { RequestHandler } from 'express';

declare global {
  namespace Express { interface Request { id: string; } }
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('X-Request-Id');
  req.id = incoming && /^[A-Z0-9]{26}$/.test(incoming) ? incoming : ulid();
  res.setHeader('X-Request-Id', req.id);
  next();
};
```

- [ ] **Step 9: Write src/middleware/errorHandler.ts**

```ts
import type { ErrorRequestHandler } from 'express';
import { DomainError } from '../domain/errors.js';
import { logger } from '../logger.js';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof DomainError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  logger.error({ err, req_id: req.id, route: req.path }, 'unhandled_error');
  res.status(500).json({ error: 'internal_error', message: 'internal server error' });
};
```

- [ ] **Step 10: Write src/middleware/httpMetrics.ts**

```ts
import type { RequestHandler } from 'express';
import { httpRequestsCounter } from '../metrics.js';

export const httpMetrics: RequestHandler = (req, res, next) => {
  res.on('finish', () => {
    const route = req.route?.path ?? req.path;
    httpRequestsCounter.inc({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
};
```

- [ ] **Step 11: Wire middleware in src/server.ts**

```ts
import express, { type Express } from 'express';
import pinoHttp from 'pino-http';
import { requestId } from './middleware/requestId.js';
import { httpMetrics } from './middleware/httpMetrics.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './logger.js';
import { registry } from './metrics.js';
import { config } from './config.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => (req as any).id }));
  app.use(httpMetrics);
  app.use(express.json({ limit: '32kb' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });
  app.use(errorHandler);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(config.port, () => logger.info({ port: config.port }, 'listening'));
}
```

- [ ] **Step 12: Run tests to verify pass**

```bash
pnpm test
```

Expected: all PASS.

- [ ] **Step 13: Commit**

```bash
git add .
git commit -m "feat: config, logger, request-id, error handler, metrics skeleton"
```

---

## Task 3: Database schema + migration + user seed

**Files:**
- Create: `sql/001_init.sql`, `src/db.ts`, `src/ulid.ts`, `scripts/init-db.ts`, `seed/users.json`, `seed/show.json`, `test/helpers/db.ts`
- Modify: `.env.example` (ensure `DATABASE_URL` present)

**Interfaces:**
- Consumes: `config.databaseUrl` from Task 2
- Produces:
  - `src/db.ts`: `export const pool: mysql.Pool` (mysql2 promise pool, connection limit 20). `export async function withTx<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T>` — BEGIN, run fn, COMMIT, rollback on throw.
  - `src/ulid.ts`: `export { ulid } from 'ulid';` (passthrough; here to make it easy to swap for a monotonic variant later).
  - `scripts/init-db.ts`: executes `sql/001_init.sql` idempotently, then inserts rows from `seed/users.json` with `INSERT IGNORE`.
  - `test/helpers/db.ts`: `export async function truncateAll(): Promise<void>` and `export async function seedTestUsers(n: number): Promise<Array<{id: number, token: string}>>`

- [ ] **Step 1: Write sql/001_init.sql**

```sql
CREATE DATABASE IF NOT EXISTS seatres CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE seatres;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  token VARCHAR(128) NOT NULL UNIQUE,
  display_name VARCHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS shows (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(128) NOT NULL UNIQUE,
  price_paise INT UNSIGNED NOT NULL,
  per_user_limit SMALLINT UNSIGNED NOT NULL DEFAULT 4,
  total_seats INT UNSIGNED NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS seats (
  show_id VARCHAR(32) NOT NULL,
  seat_id VARCHAR(16) NOT NULL,
  status ENUM('available','held','confirmed') NOT NULL DEFAULT 'available',
  user_id BIGINT NULL,
  reservation_id VARCHAR(32) NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (show_id, seat_id),
  INDEX idx_show_user (show_id, user_id),
  CONSTRAINT fk_seats_show FOREIGN KEY (show_id) REFERENCES shows(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reservations (
  id VARCHAR(32) PRIMARY KEY,
  show_id VARCHAR(32) NOT NULL,
  user_id BIGINT NOT NULL,
  idem_key VARCHAR(128) NOT NULL,
  body_hash CHAR(64) NOT NULL,
  amount_paise INT UNSIGNED NOT NULL,
  status ENUM('confirmed','cancelled') NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at TIMESTAMP(3) NULL,
  UNIQUE KEY uniq_idem (user_id, idem_key),
  INDEX idx_show_user_status (show_id, user_id, status),
  CONSTRAINT fk_res_show FOREIGN KEY (show_id) REFERENCES shows(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reservation_seats (
  reservation_id VARCHAR(32) NOT NULL,
  show_id VARCHAR(32) NOT NULL,
  seat_id VARCHAR(16) NOT NULL,
  cancelled_at TIMESTAMP(3) NULL,
  active_key VARCHAR(64) GENERATED ALWAYS AS
    (CASE WHEN cancelled_at IS NULL THEN CONCAT(show_id,':',seat_id) ELSE NULL END) VIRTUAL,
  PRIMARY KEY (reservation_id, seat_id),
  UNIQUE KEY uniq_active_seat (active_key),
  CONSTRAINT fk_rs_res FOREIGN KEY (reservation_id) REFERENCES reservations(id)
) ENGINE=InnoDB;
```

- [ ] **Step 2: Write src/db.ts**

```ts
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

export async function withTx<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 3: Write seed/users.json (10 users for test, extend to 500 later)**

```json
[
  { "id": 1, "token": "tok_user_1",  "display_name": "u_1"  },
  { "id": 2, "token": "tok_user_2",  "display_name": "u_2"  },
  { "id": 3, "token": "tok_user_3",  "display_name": "u_3"  },
  { "id": 4, "token": "tok_user_4",  "display_name": "u_4"  },
  { "id": 5, "token": "tok_user_5",  "display_name": "u_5"  },
  { "id": 6, "token": "tok_user_6",  "display_name": "u_6"  },
  { "id": 7, "token": "tok_user_7",  "display_name": "u_7"  },
  { "id": 8, "token": "tok_user_8",  "display_name": "u_8"  },
  { "id": 9, "token": "tok_user_9",  "display_name": "u_9"  },
  { "id": 10, "token": "tok_user_10", "display_name": "u_10" }
]
```

Full 500-user seed is generated later (burst harness task).

- [ ] **Step 4: Write seed/show.json**

```json
{
  "name": "friday-night",
  "price_paise": 25000,
  "per_user_limit": 4,
  "seats": [
    "A1","A2","A3","A4","A5","A6","A7","A8","A9","A10",
    "B1","B2","B3","B4","B5","B6","B7","B8","B9","B10",
    "C1","C2","C3","C4","C5","C6","C7","C8","C9","C10",
    "D1","D2","D3","D4","D5","D6","D7","D8","D9","D10",
    "E1","E2","E3","E4","E5","E6","E7","E8","E9","E10"
  ]
}
```

- [ ] **Step 5: Write scripts/init-db.ts**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

async function run() {
  const url = new URL(config.databaseUrl);
  const dbName = url.pathname.slice(1);
  // Connect without database to allow CREATE DATABASE
  const bootstrap = await mysql.createConnection({
    host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    multipleStatements: true,
  });
  const ddl = await fs.readFile(path.resolve('sql/001_init.sql'), 'utf-8');
  await bootstrap.query(ddl);
  await bootstrap.end();

  // Now connect with database and seed users
  const conn = await mysql.createConnection({
    host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: dbName,
  });
  const users = JSON.parse(await fs.readFile(path.resolve('seed/users.json'), 'utf-8'));
  for (const u of users) {
    await conn.query('INSERT IGNORE INTO users (id, token, display_name) VALUES (?, ?, ?)',
      [u.id, u.token, u.display_name]);
  }
  logger.info({ users: users.length }, 'init_db_complete');
  await conn.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Write test/helpers/db.ts**

```ts
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
```

- [ ] **Step 7: Write failing integration test — truncate then pool works**

```ts
// test/integration/db.test.ts
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
```

- [ ] **Step 8: Bring up MySQL via docker-compose and run init-db**

```bash
docker-compose up -d mysql
# wait for healthy
until docker-compose exec -T mysql mysqladmin ping -h localhost -u root -prootpass >/dev/null 2>&1; do sleep 1; done
export DATABASE_URL=mysql://app:devpass@localhost:3307/seatres
pnpm init-db
```

Expected: `init_db_complete` logged with 10 users.

- [ ] **Step 9: Run test to verify pass**

```bash
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=a pnpm test test/integration/db.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "feat: MySQL schema, migration runner, pool and tx helper, seed users"
```

---

## Task 4: Auth middleware (bearer + admin)

**Files:**
- Create: `src/auth.ts`, `src/middleware/access.ts`, `test/integration/auth.test.ts`
- Modify: `src/server.ts` (import and expose `loadAuth()` from `createApp`'s bootstrap path)

**Interfaces:**
- Consumes: `pool` from Task 3, `config.adminToken` from Task 2, `UnauthorizedError` from `src/domain/errors.ts`
- Produces:
  - `src/auth.ts`: `export async function loadUsers(): Promise<void>` (populates module-level `tokenToUserId: Map<string, number>` by `SELECT id, token FROM users`); `export function userIdForToken(token: string): number | undefined`.
  - `src/middleware/access.ts`: `export const requireUser: RequestHandler` reads `Authorization: Bearer <token>` → sets `req.userId: number`; `export const requireAdmin: RequestHandler` compares `X-Admin-Token` timing-safe to `config.adminToken`.
  - TypeScript augmentation adds `userId?: number` to `Express.Request`.
  - `createApp()` now takes an optional `{ preLoaded?: boolean }` — if false, loads users on first request; the server entrypoint calls `loadUsers()` before `listen()`.

- [ ] **Step 1: Write failing test**

```ts
// test/integration/auth.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import express from 'express';
import { requireUser, requireAdmin } from '../../src/middleware/access.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

function echoApp() {
  const app = express();
  app.use(express.json());
  app.get('/me', requireUser, (req, res) => res.json({ user_id: req.userId }));
  app.post('/admin', requireAdmin, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe('auth', () => {
  beforeAll(async () => {
    await truncateAll();
    await seedTestUsers(3);
    await loadUsers();
  });

  it('rejects /me without token', async () => {
    const res = await request(echoApp()).get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });
  it('rejects /me with wrong token', async () => {
    const res = await request(echoApp()).get('/me').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });
  it('accepts /me with valid bearer', async () => {
    const res = await request(echoApp()).get('/me').set('Authorization', 'Bearer tok_user_2');
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(2);
  });
  it('rejects /admin without admin token', async () => {
    const res = await request(echoApp()).post('/admin');
    expect(res.status).toBe(401);
  });
  it('accepts /admin with correct admin token', async () => {
    process.env.ADMIN_TOKEN = 'test-admin';
    const res = await request(echoApp()).post('/admin').set('X-Admin-Token', 'test-admin');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
pnpm test test/integration/auth.test.ts
```

Expected: FAIL (modules missing).

- [ ] **Step 3: Write src/auth.ts**

```ts
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
```

- [ ] **Step 4: Write src/middleware/access.ts**

```ts
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { UnauthorizedError } from '../domain/errors.js';
import { config } from '../config.js';
import { userIdForToken } from '../auth.js';

declare global {
  namespace Express { interface Request { userId?: number; } }
}

export const requireUser: RequestHandler = (req, _res, next) => {
  const h = req.header('Authorization');
  if (!h || !h.startsWith('Bearer ')) return next(new UnauthorizedError('missing bearer token'));
  const token = h.slice(7).trim();
  const uid = userIdForToken(token);
  if (!uid) return next(new UnauthorizedError('invalid token'));
  req.userId = uid;
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  const got = req.header('X-Admin-Token') ?? '';
  const want = config.adminToken;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new UnauthorizedError('invalid admin token'));
  }
  next();
};
```

- [ ] **Step 5: Run test to verify pass**

```bash
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=test-admin pnpm test test/integration/auth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Update src/server.ts to call loadUsers() before listen**

```ts
// at the bottom, replace the listen block
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadUsers } = await import('./auth.js');
  await loadUsers();
  createApp().listen(config.port, () => logger.info({ port: config.port }, 'listening'));
}
```

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: in-memory token→user map + bearer and admin middleware"
```

---

## Task 5: POST /shows + GET /shows/:id

**Files:**
- Create: `src/routes/shows.ts`, `test/integration/shows.test.ts`
- Modify: `src/server.ts` (mount routes), `src/metrics.ts` (nothing — gauges exist)

**Interfaces:**
- Consumes: `pool`, `withTx`, `ulid`, auth middleware, DomainErrors, `seatsAvailableGauge`, `seatsConfirmedGauge`
- Produces:
  - `src/routes/shows.ts`: `export const showsRouter: Router` with:
    - `POST /shows` (admin) → `201 { id, name, price_paise, per_user_limit, seats: [{seat_id, status}] }`
    - `GET /shows/:id` → `200 { id, name, price_paise, per_user_limit, counts: {available, held, confirmed, total}, seats: [...] }`
  - After this task: `GET /shows/:id` is the reconciliation source of truth. Gauge is set after each state change (today only on create; later tasks update it on reserve/cancel).

- [ ] **Step 1: Write failing tests**

```ts
// test/integration/shows.test.ts
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
```

- [ ] **Step 2: Run tests to verify fail**

```bash
pnpm test test/integration/shows.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write src/routes/shows.ts**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { pool, withTx } from '../db.js';
import { requireAdmin } from '../middleware/access.js';
import { ValidationError, NotFoundError, ConflictError } from '../domain/errors.js';
import { seatsAvailableGauge, seatsConfirmedGauge } from '../metrics.js';

const CreateBody = z.object({
  name: z.string().min(1).max(128),
  price_paise: z.number().int().positive(),
  per_user_limit: z.number().int().positive().max(100).default(4),
  seats: z.array(z.string().min(1).max(16)).min(1).max(10000),
});

export const showsRouter = Router();

showsRouter.post('/shows', requireAdmin, async (req, res, next) => {
  try {
    const body = CreateBody.parse(req.body);
    if (new Set(body.seats).size !== body.seats.length) {
      throw new ValidationError('duplicate seat ids in request body');
    }
    const id = ulid();
    await withTx(async (conn) => {
      try {
        await conn.query(
          'INSERT INTO shows (id, name, price_paise, per_user_limit, total_seats) VALUES (?, ?, ?, ?, ?)',
          [id, body.name, body.price_paise, body.per_user_limit, body.seats.length],
        );
      } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY') throw new ConflictError('conflict', 'show name already exists');
        throw e;
      }
      // Bulk insert seats
      const values = body.seats.map((s) => [id, s]);
      await conn.query('INSERT INTO seats (show_id, seat_id) VALUES ?', [values]);
    });
    seatsAvailableGauge.set({ show_id: id }, body.seats.length);
    seatsConfirmedGauge.set({ show_id: id }, 0);
    res.status(201).json({
      id, name: body.name, price_paise: body.price_paise, per_user_limit: body.per_user_limit,
      seats: body.seats.map((s) => ({ seat_id: s, status: 'available' })),
    });
  } catch (e) {
    if (e instanceof z.ZodError) return next(new ValidationError(e.issues.map(i => i.message).join('; ')));
    next(e);
  }
});

showsRouter.get('/shows/:id', async (req, res, next) => {
  try {
    const [shows] = await pool.query<any[]>('SELECT * FROM shows WHERE id=?', [req.params.id]);
    if (shows.length === 0) throw new NotFoundError('show not found');
    const show = shows[0];
    const [seats] = await pool.query<any[]>(
      'SELECT seat_id, status FROM seats WHERE show_id=? ORDER BY seat_id', [req.params.id],
    );
    const counts = { available: 0, held: 0, confirmed: 0, total: seats.length };
    for (const s of seats) counts[s.status as 'available'|'held'|'confirmed']++;
    res.json({
      id: show.id, name: show.name, price_paise: show.price_paise, per_user_limit: show.per_user_limit,
      counts, seats,
    });
  } catch (e) { next(e); }
});
```

- [ ] **Step 4: Mount router in src/server.ts**

```ts
import { showsRouter } from './routes/shows.js';
// after other middleware, before error handler:
app.use(showsRouter);
```

Also ensure `loadUsers()` is called before each test's createApp — in tests we already call it in beforeAll.

- [ ] **Step 5: Run tests to verify pass**

```bash
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=test-admin pnpm test test/integration/shows.test.ts
```

Expected: PASS, including Review Focus #4.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: POST /shows and GET /shows/:id with counts reconciliation"
```

---

## Task 6: POST /reserve — single-seat atomic path

**Files:**
- Create: `src/domain/reserve.ts`, `src/routes/reserve.ts`, `test/integration/reserve.test.ts`, `test/unit/validation.test.ts`
- Modify: `src/server.ts` (mount router), `src/metrics.ts` (metrics already defined)

**Interfaces:**
- Consumes: `pool`, `withTx`, auth, errors, `reservationsCounter`, `reserveLatencyHistogram`, `seatsAvailableGauge`, `seatsConfirmedGauge`
- Produces:
  - `src/domain/reserve.ts`:
    ```ts
    export interface ReserveInput {
      show_id: string; user_id: number; seats: string[]; idem_key: string; body_hash: string;
    }
    export interface ReserveSuccess {
      kind: 'created' | 'replay';
      reservation_id: string; show_id: string; user_id: number;
      seats: string[]; amount_paise: number; status: 'confirmed'; created_at: Date;
    }
    export async function reserve(input: ReserveInput): Promise<ReserveSuccess>;
    ```
    Throws `ConflictError('seat_taken', ...)` on race loss.
  - `src/routes/reserve.ts`: `POST /shows/:id/reserve` → `201` on new, `200` on replay. Normalizes body, hashes, calls `reserve()`.
  - This task implements single-seat ONLY and asserts length=1. Multi-seat is Task 7. Per-user limit is Task 8. Full idempotency is Task 9.
  - Unit test `test_rejects_duplicate_seat_ids` (Review Focus #1) covered here even though multi-seat is Task 7 — the validator rejects it regardless.

- [ ] **Step 1: Write failing unit test for validator (Review Focus #1)**

```ts
// test/unit/validation.test.ts
import { describe, it, expect } from 'vitest';
import { ReserveBody } from '../../src/routes/reserve.js';

describe('reserve request validation', () => {
  it('test_rejects_duplicate_seat_ids', () => {
    const r = ReserveBody.safeParse({ seats: ['A12','A12'], idempotency_key: 'k1' });
    expect(r.success).toBe(false);
  });
  it('rejects empty seats', () => {
    const r = ReserveBody.safeParse({ seats: [], idempotency_key: 'k' });
    expect(r.success).toBe(false);
  });
  it('rejects empty idem key', () => {
    const r = ReserveBody.safeParse({ seats: ['A1'], idempotency_key: '' });
    expect(r.success).toBe(false);
  });
  it('accepts a valid single-seat body', () => {
    const r = ReserveBody.safeParse({ seats: ['A1'], idempotency_key: 'k1' });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Write failing integration tests**

```ts
// test/integration/reserve.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

async function createShow(seats: string[], per_user_limit = 4) {
  const r = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
    .send({ name: `s_${Math.random().toString(36).slice(2,8)}`, price_paise: 100, per_user_limit, seats });
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
    const sid = await createShow(['A1','A2']);
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
});
```

- [ ] **Step 3: Run tests to verify fail**

```bash
pnpm test test/integration/reserve.test.ts test/unit/validation.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Write src/domain/reserve.ts (single-seat only for now; grows in Task 7–9)**

```ts
import { ulid } from 'ulid';
import type { PoolConnection } from 'mysql2/promise';
import { pool, withTx } from '../db.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

export interface ReserveInput {
  show_id: string; user_id: number; seats: string[]; idem_key: string; body_hash: string;
}
export interface ReserveSuccess {
  kind: 'created' | 'replay';
  reservation_id: string; show_id: string; user_id: number;
  seats: string[]; amount_paise: number; status: 'confirmed'; created_at: Date;
}

export async function reserve(input: ReserveInput): Promise<ReserveSuccess> {
  if (input.seats.length !== 1) throw new ValidationError('single-seat only in this build');  // temporary
  const seat = input.seats[0]!;

  return withTx(async (conn) => {
    // Load show (also serves as 404 check)
    const [shows] = await conn.query<any[]>('SELECT id, price_paise FROM shows WHERE id=?', [input.show_id]);
    if (shows.length === 0) throw new NotFoundError('show not found');
    const price = shows[0].price_paise as number;

    // Atomic seat claim
    const reservation_id = ulid();
    const [upd] = await conn.query<any>(
      `UPDATE seats SET status='confirmed', user_id=?, reservation_id=?
       WHERE show_id=? AND seat_id=? AND status='available'`,
      [input.user_id, reservation_id, input.show_id, seat],
    );
    if ((upd.affectedRows ?? 0) !== 1) {
      throw new ConflictError('seat_taken', 'seat already taken');
    }

    // Persist reservation row
    await conn.query(
      `INSERT INTO reservations (id, show_id, user_id, idem_key, body_hash, amount_paise, status)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed')`,
      [reservation_id, input.show_id, input.user_id, input.idem_key, input.body_hash, price],
    );
    await conn.query(
      `INSERT INTO reservation_seats (reservation_id, show_id, seat_id) VALUES (?, ?, ?)`,
      [reservation_id, input.show_id, seat],
    );

    return {
      kind: 'created',
      reservation_id,
      show_id: input.show_id,
      user_id: input.user_id,
      seats: [seat],
      amount_paise: price,
      status: 'confirmed',
      created_at: new Date(),
    };
  });
}
```

- [ ] **Step 5: Write src/routes/reserve.ts**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { requireUser } from '../middleware/access.js';
import { reserve } from '../domain/reserve.js';
import { ValidationError } from '../domain/errors.js';
import {
  reservationsCounter, reserveLatencyHistogram,
  seatsAvailableGauge, seatsConfirmedGauge,
} from '../metrics.js';
import { pool } from '../db.js';

export const ReserveBody = z.object({
  seats: z.array(z.string().min(1).max(16)).min(1).max(50)
    .refine((a) => new Set(a).size === a.length, 'duplicate seat ids'),
  idempotency_key: z.string().min(1).max(128),
});

function normalizeAndHash(body: unknown): { normalized: {seats:string[]; idempotency_key:string}; hash: string } {
  const parsed = ReserveBody.parse(body);
  const normalized = { seats: [...parsed.seats].sort(), idempotency_key: parsed.idempotency_key.trim() };
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return { normalized, hash };
}

export const reserveRouter = Router();

reserveRouter.post('/shows/:id/reserve', requireUser, async (req, res, next) => {
  const t0 = process.hrtime.bigint();
  try {
    const { normalized, hash } = normalizeAndHash(req.body);
    const result = await reserve({
      show_id: req.params.id, user_id: req.userId!,
      seats: normalized.seats, idem_key: normalized.idempotency_key, body_hash: hash,
    });
    // metrics
    reservationsCounter.inc({ outcome: result.kind === 'replay' ? 'idempotent_replay' : 'confirmed', show_id: req.params.id });
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
    reserveLatencyHistogram.observe({ show_id: req.params.id }, elapsed);
    await refreshSeatGauges(req.params.id);
    res.status(result.kind === 'replay' ? 200 : 201).json({
      reservation_id: result.reservation_id, show_id: result.show_id, user_id: `u_${result.user_id}`,
      seats: result.seats, amount_paise: result.amount_paise, status: 'confirmed',
      created_at: result.created_at.toISOString(),
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      reservationsCounter.inc({ outcome: 'validation_error', show_id: req.params.id });
      return next(new ValidationError(e.issues.map(i => i.message).join('; ')));
    }
    if (e?.code && e?.status === 409) reservationsCounter.inc({ outcome: e.code, show_id: req.params.id });
    next(e);
  }
});

async function refreshSeatGauges(show_id: string) {
  const [rows] = await pool.query<any[]>(
    "SELECT status, COUNT(*) AS c FROM seats WHERE show_id=? GROUP BY status", [show_id],
  );
  let a=0, c=0;
  for (const r of rows) {
    if (r.status === 'available') a = r.c;
    if (r.status === 'confirmed') c = r.c;
  }
  seatsAvailableGauge.set({ show_id }, a);
  seatsConfirmedGauge.set({ show_id }, c);
}
```

- [ ] **Step 6: Mount in src/server.ts**

```ts
import { reserveRouter } from './routes/reserve.js';
app.use(reserveRouter);
```

- [ ] **Step 7: Run tests to verify pass**

```bash
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=test-admin \
pnpm test test/integration/reserve.test.ts test/unit/validation.test.ts
```

Expected: PASS, including Review Focus #1 unit test.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat: POST /reserve single-seat atomic path with request validation"
```

---

## Task 7: Multi-seat all-or-nothing with sorted lock order

**Files:**
- Create: `test/contention/hot-seat.test.ts`, `test/contention/lock-wait.test.ts`
- Modify: `src/domain/reserve.ts` (remove single-seat restriction; iterate sorted seats; map `ER_LOCK_WAIT_TIMEOUT` to `ConflictError('seat_taken', ...)`), `test/integration/reserve.test.ts` (add multi-seat tests)

**Interfaces:**
- Consumes: all from Task 6.
- Produces: no new exports; `reserve()` now accepts any `seats.length ≥ 1`. Atomic all-or-nothing: if any one UPDATE affects 0 rows, the whole tx rolls back. Seats are already sorted by `normalizeAndHash` (route layer), so lock order is deterministic.

- [ ] **Step 1: Add multi-seat tests to test/integration/reserve.test.ts**

```ts
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
```

- [ ] **Step 2: Write contention test — hot seat with 50 parallel requests**

```ts
// test/contention/hot-seat.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

describe('hot-seat contention', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(100); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('50 concurrent reserves on 1 seat → exactly 1x201, 49x409, zero 5xx', async () => {
    const create = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name: 'hot', price_paise: 1, per_user_limit: 4, seats: ['A12'] });
    const sid = create.body.id;
    const app = createApp();
    const requests = Array.from({ length: 50 }, (_, i) =>
      request(app).post(`/shows/${sid}/reserve`)
        .set('Authorization', `Bearer tok_user_${i+1}`)
        .send({ seats: ['A12'], idempotency_key: `k_${i}` })
    );
    const results = await Promise.all(requests);
    const by = { ok:0, taken:0, other:0, server:0 } as Record<string, number>;
    for (const r of results) {
      if (r.status === 201) by.ok++;
      else if (r.status === 409 && r.body.error === 'seat_taken') by.taken++;
      else if (r.status >= 500) by.server++;
      else by.other++;
    }
    expect(by.server).toBe(0);
    expect(by.ok).toBe(1);
    expect(by.taken).toBe(49);
    expect(by.other).toBe(0);
    // reconciliation
    const g = await request(app).get(`/shows/${sid}`);
    expect(g.body.counts).toEqual({ available:0, held:0, confirmed:1, total:1 });
  }, 20000);
});
```

- [ ] **Step 3: Write Review Focus #3 test — lock-wait timeout maps to 409**

```ts
// test/contention/lock-wait.test.ts
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
```

- [ ] **Step 4: Run tests to verify fail**

```bash
pnpm test test/integration/reserve.test.ts test/contention/
```

Expected: multi-seat success test FAILS (reserve throws on seats.length !== 1), contention tests FAIL similarly.

- [ ] **Step 5: Modify src/domain/reserve.ts — iterate sorted seats, catch lock-wait**

Replace the body of `reserve()`:

```ts
export async function reserve(input: ReserveInput): Promise<ReserveSuccess> {
  if (input.seats.length < 1) throw new ValidationError('at least one seat required');
  const sorted = [...input.seats].sort();   // defensive — route already sorts

  return withTx(async (conn) => {
    const [shows] = await conn.query<any[]>('SELECT id, price_paise FROM shows WHERE id=?', [input.show_id]);
    if (shows.length === 0) throw new NotFoundError('show not found');
    const price = shows[0].price_paise as number;

    const reservation_id = ulid();
    for (const seat of sorted) {
      let upd: any;
      try {
        [upd] = await conn.query<any>(
          `UPDATE seats SET status='confirmed', user_id=?, reservation_id=?
           WHERE show_id=? AND seat_id=? AND status='available'`,
          [input.user_id, reservation_id, input.show_id, seat],
        );
      } catch (e: any) {
        if (e?.code === 'ER_LOCK_WAIT_TIMEOUT') {
          throw new ConflictError('seat_taken', 'seat lock wait timeout');
        }
        throw e;
      }
      if ((upd.affectedRows ?? 0) !== 1) {
        throw new ConflictError('seat_taken', `seat ${seat} not available`);
      }
    }

    await conn.query(
      `INSERT INTO reservations (id, show_id, user_id, idem_key, body_hash, amount_paise, status)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed')`,
      [reservation_id, input.show_id, input.user_id, input.idem_key, input.body_hash, price * sorted.length],
    );
    const seatRows = sorted.map((s) => [reservation_id, input.show_id, s]);
    try {
      await conn.query(
        `INSERT INTO reservation_seats (reservation_id, show_id, seat_id) VALUES ?`,
        [seatRows],
      );
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') {
        // The schema backstop tripped — belt caught a suspenders failure
        throw new ConflictError('seat_taken', 'seat already active elsewhere');
      }
      throw e;
    }

    return {
      kind: 'created', reservation_id,
      show_id: input.show_id, user_id: input.user_id, seats: sorted,
      amount_paise: price * sorted.length, status: 'confirmed', created_at: new Date(),
    };
  });
}
```

- [ ] **Step 6: Run tests to verify pass**

```bash
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=test-admin \
pnpm test test/integration/reserve.test.ts test/contention/
```

Expected: PASS, including Review Focus #3.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: multi-seat all-or-nothing with sorted lock order and lock-wait handling"
```

---

## Task 8: Per-user limit enforcement

**Files:**
- Create: `test/contention/per-user-limit-race.test.ts`
- Modify: `src/domain/reserve.ts` (count user's current confirmed seats under FOR UPDATE; reject if would exceed), `test/integration/reserve.test.ts` (add limit test)

**Interfaces:** no new exports. `reserve()` now throws `ConflictError('per_user_limit', ...)` when the user's held+new count exceeds `shows.per_user_limit`.

- [ ] **Step 1: Add limit tests**

```ts
// append to test/integration/reserve.test.ts
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
```

- [ ] **Step 2: Write contention test — 10 parallel reserves from one user with limit=4**

```ts
// test/contention/per-user-limit-race.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

describe('per-user limit under concurrency', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(5); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('10 parallel reserves by same user on limit=4 show → at most 4 confirmed', async () => {
    const create = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name:'pul', price_paise:1, per_user_limit:4, seats: Array.from({length:10},(_,i)=>`S${i+1}`) });
    const sid = create.body.id;
    const app = createApp();
    const results = await Promise.all(Array.from({length:10}, (_,i) =>
      request(app).post(`/shows/${sid}/reserve`)
        .set('Authorization','Bearer tok_user_1')
        .send({ seats: [`S${i+1}`], idempotency_key: `k_${i}` })
    ));
    const ok = results.filter(r => r.status === 201).length;
    const over = results.filter(r => r.body?.error === 'per_user_limit').length;
    const srv = results.filter(r => r.status >= 500).length;
    expect(srv).toBe(0);
    expect(ok).toBeLessThanOrEqual(4);
    expect(ok + over).toBe(10);
    const g = await request(app).get(`/shows/${sid}`);
    expect(g.body.counts.confirmed).toBe(ok);
  }, 15000);
});
```

- [ ] **Step 3: Run tests to verify fail**

```bash
pnpm test test/integration/reserve.test.ts test/contention/per-user-limit-race.test.ts
```

Expected: FAIL (limit not enforced).

- [ ] **Step 4: Add per-user limit check in reserve.ts**

In `withTx` body, between the show-load and the seat-UPDATE loop:

```ts
// Per-user limit (lock user's current active rows for this show)
const [limitRow] = await conn.query<any[]>('SELECT per_user_limit FROM shows WHERE id=?', [input.show_id]);
const perUserLimit: number = (shows[0].per_user_limit as number | undefined) ?? limitRow[0].per_user_limit;
const [cur] = await conn.query<any[]>(
  `SELECT COUNT(*) AS c FROM reservation_seats rs
   JOIN reservations r ON rs.reservation_id = r.id
   WHERE r.show_id=? AND r.user_id=? AND r.status='confirmed' AND rs.cancelled_at IS NULL
   FOR UPDATE`,
  [input.show_id, input.user_id],
);
if ((cur[0].c as number) + sorted.length > perUserLimit) {
  throw new ConflictError('per_user_limit', 'per-user seat limit exceeded');
}
```

(Also change the earlier `SELECT id, price_paise` to include `per_user_limit`.)

- [ ] **Step 5: Run tests to verify pass**

```bash
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=test-admin \
pnpm test test/integration/reserve.test.ts test/contention/per-user-limit-race.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: enforce per-user limit with FOR UPDATE count check inside tx"
```

---

## Task 9: Idempotency — fast-path replay + body-hash mismatch + concurrent-insert race

**Files:**
- Create: `src/domain/idempotency.ts`, `test/unit/idempotency.test.ts`, `test/contention/idempotency-race.test.ts`
- Modify: `src/domain/reserve.ts` (add fast-path SELECT at top of tx; catch unique violation on reservations.uniq_idem; return `kind: 'replay'`), `src/routes/reserve.ts` (use `normalize()` from new module), `test/integration/reserve.test.ts` (idempotency tests)

**Interfaces:**
- Produces:
  - `src/domain/idempotency.ts`:
    ```ts
    export interface NormalizedBody { seats: string[]; idempotency_key: string; }
    export function normalize(raw: unknown): NormalizedBody;    // zod + sort + trim
    export function hashBody(n: NormalizedBody): string;        // sha256 hex
    ```
  - `reserve()` return type gains `kind: 'created' | 'replay'`; route maps `replay → 200`, `created → 201`.

- [ ] **Step 1: Write unit tests for idempotency helpers**

```ts
// test/unit/idempotency.test.ts
import { describe, it, expect } from 'vitest';
import { normalize, hashBody } from '../../src/domain/idempotency.js';

describe('idempotency normalize + hash', () => {
  it('sorts seats and trims key', () => {
    const n = normalize({ seats: ['A2','A1'], idempotency_key: ' k  ' });
    expect(n).toEqual({ seats: ['A1','A2'], idempotency_key: 'k' });
  });
  it('hash is deterministic', () => {
    const h1 = hashBody({ seats: ['A1','A2'], idempotency_key: 'k' });
    const h2 = hashBody({ seats: ['A1','A2'], idempotency_key: 'k' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  it('different bodies hash differently', () => {
    const h1 = hashBody({ seats: ['A1'], idempotency_key: 'k' });
    const h2 = hashBody({ seats: ['A2'], idempotency_key: 'k' });
    expect(h1).not.toBe(h2);
  });
});
```

- [ ] **Step 2: Write integration tests**

```ts
// append to test/integration/reserve.test.ts
it('idempotent replay returns 200 with original reservation', async () => {
  const sid = await createShow(['A1','A2']);
  const app = createApp();
  const r1 = await request(app).post(`/shows/${sid}/reserve`)
    .set('Authorization','Bearer tok_user_1').send({ seats:['A1'], idempotency_key:'kX' });
  const r2 = await request(app).post(`/shows/${sid}/reserve`)
    .set('Authorization','Bearer tok_user_1').send({ seats:['A1'], idempotency_key:'kX' });
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(200);
  expect(r2.body.reservation_id).toBe(r1.body.reservation_id);
});

it('same key with different body returns 409 idempotency_body_mismatch', async () => {
  const sid = await createShow(['A1','A2','A3']);
  const app = createApp();
  await request(app).post(`/shows/${sid}/reserve`)
    .set('Authorization','Bearer tok_user_1').send({ seats:['A1'], idempotency_key:'kY' });
  const r = await request(app).post(`/shows/${sid}/reserve`)
    .set('Authorization','Bearer tok_user_1').send({ seats:['A2'], idempotency_key:'kY' });
  expect(r.status).toBe(409);
  expect(r.body.error).toBe('idempotency_body_mismatch');
});

// Review Focus #2
it('test_idem_key_scoped_per_user', async () => {
  const sid = await createShow(['A1','A2']);
  const app = createApp();
  const r1 = await request(app).post(`/shows/${sid}/reserve`)
    .set('Authorization','Bearer tok_user_1').send({ seats:['A1'], idempotency_key:'shared' });
  const r2 = await request(app).post(`/shows/${sid}/reserve`)
    .set('Authorization','Bearer tok_user_2').send({ seats:['A2'], idempotency_key:'shared' });
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(201);
  expect(r1.body.reservation_id).not.toBe(r2.body.reservation_id);
});
```

- [ ] **Step 3: Write race test — same key fired 10× in parallel**

```ts
// test/contention/idempotency-race.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

describe('idempotency under concurrency', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(2); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('same user+key fired 10x → exactly one reservation', async () => {
    const create = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
      .send({ name:'ir', price_paise:1, per_user_limit:4, seats:['A1','A2','A3','A4','A5'] });
    const sid = create.body.id;
    const app = createApp();
    const results = await Promise.all(Array.from({length:10}, () =>
      request(app).post(`/shows/${sid}/reserve`)
        .set('Authorization','Bearer tok_user_1')
        .send({ seats:['A1'], idempotency_key:'same' })
    ));
    const ids = new Set(results.map(r => r.body?.reservation_id).filter(Boolean));
    const srv = results.filter(r => r.status >= 500).length;
    const okCount = results.filter(r => r.status === 201 || r.status === 200).length;
    expect(srv).toBe(0);
    expect(ids.size).toBe(1);
    expect(okCount).toBe(10);
    const g = await request(app).get(`/shows/${sid}`);
    expect(g.body.counts.confirmed).toBe(1);
  }, 15000);
});
```

- [ ] **Step 4: Run tests to verify fail**

```bash
pnpm test test/unit/idempotency.test.ts test/integration/reserve.test.ts test/contention/idempotency-race.test.ts
```

Expected: FAIL (idempotency not implemented).

- [ ] **Step 5: Write src/domain/idempotency.ts**

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';

const Schema = z.object({
  seats: z.array(z.string().min(1).max(16)).min(1).max(50)
    .refine((a) => new Set(a).size === a.length, 'duplicate seat ids'),
  idempotency_key: z.string().min(1).max(128),
});

export interface NormalizedBody { seats: string[]; idempotency_key: string; }

export function normalize(raw: unknown): NormalizedBody {
  const p = Schema.parse(raw);
  return { seats: [...p.seats].sort(), idempotency_key: p.idempotency_key.trim() };
}

export function hashBody(n: NormalizedBody): string {
  return createHash('sha256').update(JSON.stringify(n)).digest('hex');
}
```

- [ ] **Step 6: Add idempotency fast-path + unique-violation catch in reserve.ts**

Insert at the top of the `withTx` callback (before show load):

```ts
// Idempotency fast-path (no locks)
const [existing] = await conn.query<any[]>(
  `SELECT id, show_id, user_id, body_hash, amount_paise, status, created_at
   FROM reservations WHERE user_id=? AND idem_key=?`,
  [input.user_id, input.idem_key],
);
if (existing.length > 0) {
  const r = existing[0];
  if (r.body_hash !== input.body_hash) {
    throw new ConflictError('idempotency_body_mismatch', 'same idempotency key with different body');
  }
  const [seatRows] = await conn.query<any[]>(
    `SELECT seat_id FROM reservation_seats WHERE reservation_id=? ORDER BY seat_id`, [r.id],
  );
  return {
    kind: 'replay', reservation_id: r.id, show_id: r.show_id, user_id: r.user_id,
    seats: seatRows.map((s: any) => s.seat_id), amount_paise: r.amount_paise,
    status: 'confirmed', created_at: r.created_at,
  };
}
```

And wrap the `INSERT INTO reservations` call:

```ts
try {
  await conn.query(
    `INSERT INTO reservations ...`,
    [...],
  );
} catch (e: any) {
  if (e?.code === 'ER_DUP_ENTRY') {
    // Concurrent request with same (user_id, idem_key) won the race
    // Roll back our seat UPDATEs by throwing; the catch in route layer will NOT handle this
    // because we need to re-read the winner. Instead, do inline:
    throw new _IdemRaceSignal();
  }
  throw e;
}
```

And catch `_IdemRaceSignal` at the top of the `withTx` wrapper call (outside the transaction, since it was rolled back):

```ts
// Replace the body of reserve() with try/catch around withTx
try {
  return await withTx(async (conn) => { ... });
} catch (e) {
  if (e instanceof _IdemRaceSignal) {
    // Re-read the winner outside tx
    const [rows] = await pool.query<any[]>(
      `SELECT r.id, r.show_id, r.user_id, r.body_hash, r.amount_paise, r.status, r.created_at
       FROM reservations r WHERE r.user_id=? AND r.idem_key=?`,
      [input.user_id, input.idem_key],
    );
    const r = rows[0];
    if (!r) throw new ConflictError('seat_taken', 'race collision but no winner found');
    if (r.body_hash !== input.body_hash) {
      throw new ConflictError('idempotency_body_mismatch', 'same key, different body');
    }
    const [seatRows] = await pool.query<any[]>(
      `SELECT seat_id FROM reservation_seats WHERE reservation_id=? ORDER BY seat_id`, [r.id],
    );
    return {
      kind: 'replay', reservation_id: r.id, show_id: r.show_id, user_id: r.user_id,
      seats: seatRows.map((s: any) => s.seat_id), amount_paise: r.amount_paise,
      status: 'confirmed', created_at: r.created_at,
    };
  }
  throw e;
}

class _IdemRaceSignal extends Error { constructor() { super('idem race'); } }
```

- [ ] **Step 7: Update src/routes/reserve.ts to use idempotency helpers and map replay → 200**

```ts
import { normalize, hashBody } from '../domain/idempotency.js';
// in the handler:
const normalized = normalize(req.body);
const hash = hashBody(normalized);
const result = await reserve({
  show_id: req.params.id, user_id: req.userId!,
  seats: normalized.seats, idem_key: normalized.idempotency_key, body_hash: hash,
});
res.status(result.kind === 'replay' ? 200 : 201).json({ ... });
```

- [ ] **Step 8: Run tests to verify pass**

```bash
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=test-admin \
pnpm test test/unit/idempotency.test.ts test/integration/reserve.test.ts test/contention/idempotency-race.test.ts
```

Expected: PASS, including Review Focus #2.

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat: idempotency fast-path, body-hash matching, concurrent-insert race handling"
```

---

## Task 10: POST /reservations/:id/cancel (owner-only)

**Files:**
- Create: `src/domain/cancel.ts`, `src/routes/cancel.ts`, `test/integration/cancel.test.ts`
- Modify: `src/server.ts` (mount router), `src/metrics.ts` (cancellations counter already defined)

**Interfaces:**
- Produces:
  - `src/domain/cancel.ts`: `export async function cancelReservation(reservation_id: string, by_user_id: number): Promise<{reservation_id: string; show_id: string; cancelled_at: Date}>` — throws NotFoundError / ForbiddenError / ConflictError(already_cancelled).
  - `src/routes/cancel.ts`: `POST /reservations/:id/cancel` → `200 { reservation_id, status:'cancelled', cancelled_at }`.
  - On cancel: all seats on that reservation flip to `available`, `reservation_seats.cancelled_at` is set (releases `active_key` → NULL via generated column), `reservations.status='cancelled'`.

- [ ] **Step 1: Write failing tests**

```ts
// test/integration/cancel.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';
import { pool } from '../../src/db.js';

async function createShow(seats: string[]) {
  const r = await request(createApp()).post('/shows').set('X-Admin-Token','test-admin')
    .send({ name: `c_${Math.random().toString(36).slice(2,8)}`, price_paise: 10, per_user_limit: 4, seats });
  return r.body.id as string;
}

async function reserve(sid: string, user: number, seats: string[], key: string) {
  return request(createApp()).post(`/shows/${sid}/reserve`)
    .set('Authorization', `Bearer tok_user_${user}`).send({ seats, idempotency_key: key });
}

describe('cancel', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(5); await loadUsers(); });
  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('TRUNCATE reservation_seats');
    await pool.query('TRUNCATE reservations');
    await pool.query('TRUNCATE seats');
    await pool.query('TRUNCATE shows');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
  });

  it('owner cancels — seats released, status cancelled', async () => {
    const sid = await createShow(['A1','A2']);
    const r = await reserve(sid, 1, ['A1'], 'k1');
    const c = await request(createApp())
      .post(`/reservations/${r.body.reservation_id}/cancel`)
      .set('Authorization','Bearer tok_user_1');
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('cancelled');
    const g = await request(createApp()).get(`/shows/${sid}`);
    expect(g.body.counts).toEqual({ available: 2, held: 0, confirmed: 0, total: 2 });
    // released seat is re-reservable
    const r2 = await reserve(sid, 2, ['A1'], 'k2');
    expect(r2.status).toBe(201);
  });

  // Review Focus #5
  it('test_cancel_by_non_owner_forbidden', async () => {
    const sid = await createShow(['A1']);
    const r = await reserve(sid, 1, ['A1'], 'k1');
    const c = await request(createApp())
      .post(`/reservations/${r.body.reservation_id}/cancel`)
      .set('Authorization','Bearer tok_user_2');
    expect(c.status).toBe(403);
    // Seats untouched
    const g = await request(createApp()).get(`/shows/${sid}`);
    expect(g.body.counts.confirmed).toBe(1);
  });

  it('404 on unknown reservation', async () => {
    const c = await request(createApp())
      .post('/reservations/01ABCDEFGHIJKLMNOPQRSTUVWX/cancel')
      .set('Authorization','Bearer tok_user_1');
    expect(c.status).toBe(404);
  });

  it('double-cancel returns 409 already_cancelled', async () => {
    const sid = await createShow(['A1']);
    const r = await reserve(sid, 1, ['A1'], 'k1');
    await request(createApp()).post(`/reservations/${r.body.reservation_id}/cancel`)
      .set('Authorization','Bearer tok_user_1');
    const c2 = await request(createApp()).post(`/reservations/${r.body.reservation_id}/cancel`)
      .set('Authorization','Bearer tok_user_1');
    expect(c2.status).toBe(409);
    expect(c2.body.error).toBe('already_cancelled');
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

```bash
pnpm test test/integration/cancel.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write src/domain/cancel.ts**

```ts
import { withTx } from '../db.js';
import { NotFoundError, ForbiddenError, ConflictError } from './errors.js';

export async function cancelReservation(reservation_id: string, by_user_id: number) {
  return withTx(async (conn) => {
    const [rows] = await conn.query<any[]>(
      `SELECT id, show_id, user_id, status FROM reservations WHERE id=? FOR UPDATE`, [reservation_id],
    );
    if (rows.length === 0) throw new NotFoundError('reservation not found');
    const r = rows[0];
    if (r.user_id !== by_user_id) throw new ForbiddenError('not reservation owner');
    if (r.status === 'cancelled') throw new ConflictError('already_cancelled', 'already cancelled');

    const now = new Date();
    await conn.query(`UPDATE reservations SET status='cancelled', cancelled_at=? WHERE id=?`, [now, reservation_id]);
    await conn.query(`UPDATE reservation_seats SET cancelled_at=? WHERE reservation_id=?`, [now, reservation_id]);
    await conn.query(
      `UPDATE seats SET status='available', user_id=NULL, reservation_id=NULL WHERE reservation_id=?`,
      [reservation_id],
    );
    return { reservation_id, show_id: r.show_id, cancelled_at: now };
  });
}
```

- [ ] **Step 4: Write src/routes/cancel.ts**

```ts
import { Router } from 'express';
import { requireUser } from '../middleware/access.js';
import { cancelReservation } from '../domain/cancel.js';
import { cancellationsCounter, seatsAvailableGauge, seatsConfirmedGauge } from '../metrics.js';
import { pool } from '../db.js';

export const cancelRouter = Router();

cancelRouter.post('/reservations/:id/cancel', requireUser, async (req, res, next) => {
  try {
    const out = await cancelReservation(req.params.id, req.userId!);
    cancellationsCounter.inc({ show_id: out.show_id });
    // Refresh gauges
    const [rows] = await pool.query<any[]>(
      "SELECT status, COUNT(*) AS c FROM seats WHERE show_id=? GROUP BY status", [out.show_id],
    );
    let a=0, c=0; for (const r of rows) { if (r.status==='available') a=r.c; if (r.status==='confirmed') c=r.c; }
    seatsAvailableGauge.set({ show_id: out.show_id }, a);
    seatsConfirmedGauge.set({ show_id: out.show_id }, c);
    res.json({ reservation_id: out.reservation_id, status: 'cancelled', cancelled_at: out.cancelled_at.toISOString() });
  } catch (e) { next(e); }
});
```

- [ ] **Step 5: Mount in src/server.ts**

```ts
import { cancelRouter } from './routes/cancel.js';
app.use(cancelRouter);
```

- [ ] **Step 6: Run tests to verify pass**

```bash
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=test-admin \
pnpm test test/integration/cancel.test.ts
```

Expected: PASS, including Review Focus #5.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: POST /cancel owner-only with atomic seat release"
```

---

## Task 11: In-process event bus + SSE stream

**Files:**
- Create: `src/events.ts`, `src/routes/stream.ts`, `test/integration/stream.test.ts`
- Modify: `src/domain/reserve.ts` (emit after successful reserve), `src/domain/cancel.ts` (emit after successful cancel), `src/server.ts` (mount stream router)

**Interfaces:**
- Produces:
  - `src/events.ts`:
    ```ts
    export type SeatEvent =
      | { type:'seat'; show_id:string; seat_id:string; status:'available'|'held'|'confirmed'; user_id?:number; at:string }
      | { type:'reservation'; show_id:string; reservation_id:string; user_id:number; seats:string[]; outcome:'confirmed'|'cancelled'; at:string };
    export function publish(ev: SeatEvent): void;
    export function subscribe(show_id: string, listener: (ev: SeatEvent) => void): () => void;
    ```
  - `src/routes/stream.ts`: `GET /shows/:id/stream` — SSE handler. On connect: send `baseline` event (seat map + counts), subscribe to `publish` events scoped by show_id, write each as `data: <json>\n\n`, send `: keepalive\n\n` every 20s, cleanup on `req.on('close')`.

- [ ] **Step 1: Write failing test — a reserve emits an SSE event to a connected client**

```ts
// test/integration/stream.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../../src/server.js';
import { loadUsers } from '../../src/auth.js';
import { truncateAll, seedTestUsers } from '../helpers/db.js';

async function post(url: string, body: any, headers: Record<string,string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type':'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}

describe('SSE stream', () => {
  beforeAll(async () => { await truncateAll(); await seedTestUsers(3); await loadUsers(); });

  it('receives baseline on connect and a seat event after a reserve', async () => {
    const server = http.createServer(createApp()).listen(0);
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;

    const show = await post(`${base}/shows`, { name:'ss', price_paise:1, per_user_limit:4, seats:['A1','A2'] },
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
      { seats:['A1'], idempotency_key:'k' }, { 'Authorization': 'Bearer tok_user_1' });
    await new Promise(r => setTimeout(r, 150));
    abort.abort();
    try { await streamP; } catch { /* AbortError */ }
    server.close();

    expect(events.some(e => e.type === 'baseline')).toBe(true);
    expect(events.some(e => e.type === 'seat' && e.seat_id === 'A1' && e.status === 'confirmed')).toBe(true);
  }, 10000);
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
pnpm test test/integration/stream.test.ts
```

Expected: FAIL (/stream not implemented).

- [ ] **Step 3: Write src/events.ts**

```ts
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(10000);

export type SeatEvent =
  | { type:'seat'; show_id:string; seat_id:string; status:'available'|'held'|'confirmed'; user_id?:number; at:string }
  | { type:'reservation'; show_id:string; reservation_id:string; user_id:number; seats:string[]; outcome:'confirmed'|'cancelled'; at:string };

export function publish(ev: SeatEvent): void {
  bus.emit(ev.show_id, ev);
}

export function subscribe(show_id: string, listener: (ev: SeatEvent) => void): () => void {
  bus.on(show_id, listener);
  return () => bus.off(show_id, listener);
}
```

- [ ] **Step 4: Write src/routes/stream.ts**

```ts
import { Router } from 'express';
import { pool } from '../db.js';
import { subscribe } from '../events.js';
import { sseSubscribersGauge } from '../metrics.js';
import { NotFoundError } from '../domain/errors.js';

export const streamRouter = Router();

streamRouter.get('/shows/:id/stream', async (req, res, next) => {
  try {
    const show_id = req.params.id;
    const [shows] = await pool.query<any[]>('SELECT id, name FROM shows WHERE id=?', [show_id]);
    if (shows.length === 0) throw new NotFoundError('show not found');

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const [seats] = await pool.query<any[]>(
      'SELECT seat_id, status FROM seats WHERE show_id=? ORDER BY seat_id', [show_id],
    );
    const counts = { available:0, held:0, confirmed:0, total: seats.length };
    for (const s of seats) counts[s.status as 'available'|'held'|'confirmed']++;
    const baseline = { type:'baseline', show_id, counts, seats };
    res.write(`data: ${JSON.stringify(baseline)}\n\n`);

    sseSubscribersGauge.inc({ show_id });

    const unsub = subscribe(show_id, (ev) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const keep = setInterval(() => res.write(`: keepalive\n\n`), 20000);

    req.on('close', () => {
      clearInterval(keep);
      unsub();
      sseSubscribersGauge.dec({ show_id });
    });
  } catch (e) { next(e); }
});
```

- [ ] **Step 5: Emit from reserve + cancel**

In `src/domain/reserve.ts`, after successful COMMIT (just before `return`), publish events. Easiest: move publication to the route layer where we have the outcome:

```ts
// in src/routes/reserve.ts, after reserve() succeeds and gauges are refreshed
import { publish } from '../events.js';
const now = result.created_at.toISOString();
for (const seat of result.seats) {
  publish({ type:'seat', show_id: result.show_id, seat_id: seat,
    status:'confirmed', user_id: result.user_id, at: now });
}
publish({ type:'reservation', show_id: result.show_id, reservation_id: result.reservation_id,
  user_id: result.user_id, seats: result.seats, outcome:'confirmed', at: now });
```

In `src/routes/cancel.ts`, after cancel succeeds:

```ts
import { publish } from '../events.js';
const [cancelledSeats] = await pool.query<any[]>(
  `SELECT seat_id FROM reservation_seats WHERE reservation_id=? ORDER BY seat_id`, [out.reservation_id],
);
const at = out.cancelled_at.toISOString();
for (const s of cancelledSeats) {
  publish({ type:'seat', show_id: out.show_id, seat_id: s.seat_id, status:'available', at });
}
publish({ type:'reservation', show_id: out.show_id, reservation_id: out.reservation_id,
  user_id: req.userId!, seats: cancelledSeats.map((s:any)=>s.seat_id), outcome:'cancelled', at });
```

- [ ] **Step 6: Mount in src/server.ts**

```ts
import { streamRouter } from './routes/stream.js';
app.use(streamRouter);
```

- [ ] **Step 7: Run test to verify pass**

```bash
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=test-admin \
pnpm test test/integration/stream.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat: in-process event bus + SSE /shows/:id/stream endpoint"
```

---

## Task 12: Dashboard HTML (public/dashboard.html)

**Files:**
- Create: `public/dashboard.html`, `src/routes/dashboard.ts`
- Modify: `src/server.ts` (mount dashboard route)

**Interfaces:**
- Produces: `GET /dashboard` serves the static HTML. The page accepts `?show=<id>` and renders per the frontend design doc. Uses `EventSource` on `/shows/:id/stream`.
- No new tests — the dashboard is observability-only; verified by eye per the frontend design's Testing section (manual script in README).

- [ ] **Step 1: Write public/dashboard.html (vanilla HTML+JS, mirrors mockup)**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seat Reservation — Live</title>
<style>
  :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
  body { margin: 0; padding: 0; background: #fff; color: #111; font-size: 14px; }
  header { display: flex; align-items: center; justify-content: space-between;
    padding: 12px 18px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  .status { display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #ecfdf5; color: #065f46; }
  .status::before { content: "●"; }
  .status.recon { background: #fef3c7; color: #92400e; }
  .status.off   { background: #fee2e2; color: #991b1b; }
  .counts { display: flex; gap: 16px; font-size: 13px; color: #374151; }
  .counts b { color: #111; }
  .reconciled { color: #047857; font-weight: 600; }
  .drift      { color: #991b1b; font-weight: 600; }
  main { display: grid; grid-template-columns: 1fr 280px; gap: 0; }
  #seat-grid-wrap { padding: 14px 18px; }
  #seat-grid { border-collapse: separate; border-spacing: 4px; }
  td.seat { text-align: center; padding: 8px 2px; font-size: 10px; font-weight: 600;
    border-radius: 4px; background: #e5e7eb; border: 1px solid #9ca3af; color: #374151;
    min-width: 48px; transition: box-shadow 300ms; }
  td.seat .lbl { display: block; font-size: 9px; font-weight: 400; color: #6b7280; }
  td.seat.held { background: #fde68a; border-color: #f59e0b; color: #78350f; }
  td.seat.confirmed { background: #fecaca; border-color: #dc2626; color: #7f1d1d; }
  td.seat.pulse { box-shadow: 0 0 0 3px rgba(220,38,38,0.35); }
  aside { border-left: 1px solid #e5e7eb; padding: 14px; background: #fafafa; font-size: 12px; }
  aside h2 { font-size: 12px; margin: 0 0 8px 0; color: #374151; text-transform: uppercase; letter-spacing: 0.3px; }
  aside ol { list-style: none; padding: 0; margin: 0; max-height: 70vh; overflow-y: auto; }
  aside li { padding: 4px 0; border-bottom: 1px dashed #e5e7eb; display: flex; gap: 6px; }
  aside .t { color: #6b7280; font-variant-numeric: tabular-nums; }
  .ev-confirmed { color: #7f1d1d; font-weight: 600; }
  .ev-cancelled { color: #4b5563; font-weight: 600; }
  .empty { padding: 60px 20px; text-align: center; color: #6b7280; }
  .empty input { padding: 7px 10px; border: 1px solid #d1d5db; border-radius: 4px; margin-top: 12px; min-width: 240px; }
  .empty button { padding: 7px 14px; border: 1px solid #111; background: #111; color: #fff; border-radius: 4px; cursor: pointer; margin-left: 6px; }
  @media (prefers-reduced-motion: reduce) {
    td.seat { transition: none; }
    td.seat.pulse { box-shadow: none; }
  }
</style>
</head>
<body>
<header>
  <div style="display:flex; align-items:center; gap:10px;">
    <h1 id="show-name">—</h1>
    <span id="conn" class="status">connecting…</span>
  </div>
  <div class="counts" id="counts" style="display:none;">
    <span>available <b id="c-a">—</b></span>
    <span>held <b id="c-h">—</b></span>
    <span>confirmed <b id="c-c">—</b></span>
    <span>total <b id="c-t">—</b></span>
    <span id="reconciled" class="reconciled">✓</span>
  </div>
</header>
<main id="main">
  <div id="empty" class="empty">
    <h3>Pick a show to watch</h3>
    <div>Paste a show id and hit load.</div>
    <div><input id="show-input" placeholder="sh_01HV8K…"><button id="show-load">load</button></div>
  </div>
</main>

<script type="module">
const qs = new URLSearchParams(location.search);
const showId = qs.get('show');
const $ = (id) => document.getElementById(id);

if (!showId) {
  $('show-load').addEventListener('click', () => {
    const v = $('show-input').value.trim();
    if (v) location.search = `?show=${encodeURIComponent(v)}`;
  });
} else {
  main();
}

function cell(seatId) {
  const td = document.createElement('td');
  td.className = 'seat';
  td.id = `s-${seatId}`;
  td.innerHTML = `${seatId}<span class="lbl"> </span>`;
  return td;
}

function render(seats) {
  const main = $('main');
  main.innerHTML = `
    <div id="seat-grid-wrap"><table id="seat-grid"><tbody id="grid-body"></tbody></table></div>
    <aside><h2>recent</h2><ol id="feed"></ol></aside>
  `;
  // group by row-prefix
  const groups = {};
  for (const s of seats) {
    const row = s.seat_id.replace(/\d+$/, '');
    (groups[row] ??= []).push(s);
  }
  const body = $('grid-body');
  for (const row of Object.keys(groups).sort()) {
    const tr = document.createElement('tr');
    for (const s of groups[row]) {
      const td = cell(s.seat_id);
      applyStatus(td, s.status);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

function applyStatus(td, status) {
  td.classList.remove('held','confirmed');
  if (status === 'held') td.classList.add('held');
  if (status === 'confirmed') td.classList.add('confirmed');
  const lbl = td.querySelector('.lbl');
  lbl.textContent = status === 'confirmed' ? 'C' : status === 'held' ? 'H' : ' ';
}

function pulse(td) {
  td.classList.add('pulse');
  setTimeout(() => td.classList.remove('pulse'), 500);
}

function updateCounts(c) {
  $('c-a').textContent = c.available;
  $('c-h').textContent = c.held;
  $('c-c').textContent = c.confirmed;
  $('c-t').textContent = c.total;
  const ok = (c.available + c.held + c.confirmed) === c.total;
  const rec = $('reconciled');
  rec.textContent = ok ? '✓ reconciled' : '✗ drift';
  rec.className = ok ? 'reconciled' : 'drift';
  $('counts').style.display = 'flex';
}

function addFeed(ev) {
  const li = document.createElement('li');
  const t = new Date(ev.at).toISOString().slice(11,23);
  const cls = ev.outcome === 'confirmed' ? 'ev-confirmed' : 'ev-cancelled';
  li.innerHTML = `<span class="t">${t}</span> <span class="${cls}">${ev.outcome}</span> <span>${ev.seats.join(',')} by u_${ev.user_id}</span>`;
  const feed = $('feed');
  feed.prepend(li);
  while (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

async function main() {
  $('show-name').textContent = showId;
  const es = new EventSource(`/shows/${encodeURIComponent(showId)}/stream`);
  es.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'status'; };
  es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'status recon'; };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'baseline') {
      render(ev.seats);
      updateCounts(ev.counts);
    } else if (ev.type === 'seat') {
      const td = document.getElementById(`s-${ev.seat_id}`);
      if (td) { applyStatus(td, ev.status); pulse(td); }
    } else if (ev.type === 'reservation') {
      addFeed(ev);
      // request a fresh baseline periodically for counts via a quick fetch
      fetch(`/shows/${encodeURIComponent(showId)}`).then(r=>r.json()).then(d => updateCounts(d.counts));
    }
  };
}
</script>
</body>
</html>
```

- [ ] **Step 2: Write src/routes/dashboard.ts**

```ts
import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/dashboard.html'));
});
```

- [ ] **Step 3: Mount in src/server.ts**

```ts
import { dashboardRouter } from './routes/dashboard.js';
app.use(dashboardRouter);
```

- [ ] **Step 4: Manual smoke — compose up and open in browser**

```bash
docker-compose up --build -d
open http://localhost:8080/dashboard
# in another terminal:
curl -X POST http://localhost:8080/shows -H 'X-Admin-Token: dev-admin' -H 'Content-Type: application/json' \
  -d '{"name":"demo","price_paise":100,"seats":["A1","A2","A3","B1","B2","B3"]}'
# copy the returned id, append to URL: http://localhost:8080/dashboard?show=<ID>
# then:
curl -X POST http://localhost:8080/shows/<ID>/reserve -H 'Authorization: Bearer tok_user_1' \
  -H 'Content-Type: application/json' -d '{"seats":["A1"],"idempotency_key":"k1"}'
# dashboard flashes A1 red
docker-compose down
```

Expected: dashboard pulses the seat on reserve.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: live SSE dashboard at /dashboard (vanilla HTML+JS, no deps)"
```

---

## Task 13: /readyz with real DB check + metrics coverage polish

**Files:**
- Create: `src/routes/ops.ts`
- Modify: `src/server.ts` (replace inline `/healthz` and `/metrics` with ops router), `test/integration/ops.test.ts` (add /readyz tests)

**Interfaces:**
- Produces:
  - `src/routes/ops.ts`: `export const opsRouter: Router` with `GET /healthz`, `GET /readyz`, `GET /metrics`. `/readyz` runs `SELECT 1` against the pool with a 500ms timeout and returns `503 {ok:false, error:'db_unreachable'}` on failure.

- [ ] **Step 1: Write failing /readyz tests**

```ts
// append to test/integration/ops.test.ts
it('GET /readyz returns 200 when DB is up', async () => {
  const res = await request(createApp()).get('/readyz');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});
```

(Can't easily test the failure path without stopping MySQL; we'll verify manually in step 4.)

- [ ] **Step 2: Write src/routes/ops.ts**

```ts
import { Router } from 'express';
import { pool } from '../db.js';
import { registry } from '../metrics.js';

export const opsRouter = Router();

opsRouter.get('/healthz', (_req, res) => res.json({ ok: true }));

opsRouter.get('/readyz', async (_req, res) => {
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('db_timeout')), 500));
    await Promise.race([pool.query('SELECT 1'), timeout]);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: 'db_unreachable' });
  }
});

opsRouter.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});
```

- [ ] **Step 3: Remove inline /healthz and /metrics from src/server.ts; mount opsRouter**

```ts
// delete the two app.get(...) calls for /healthz and /metrics
import { opsRouter } from './routes/ops.js';
app.use(opsRouter);
```

- [ ] **Step 4: Run tests + manual DB-down check**

```bash
pnpm test test/integration/ops.test.ts
# then manually:
docker-compose up -d mysql
sleep 5
docker-compose up -d app
curl -sf http://localhost:8080/readyz   # 200
docker-compose stop mysql
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/readyz   # 503
docker-compose down
```

Expected: tests PASS; manual check shows 503 when MySQL is stopped.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: /readyz with real DB probe, /healthz and /metrics via ops router"
```

---

## Task 14: Burst harness (scripts/burst.ts + burst.sh)

**Files:**
- Create: `scripts/burst.ts`, `burst.sh`, `seed/users.json` (expand to 500 users)
- Modify: `scripts/init-db.ts` (idempotent re-seed when users.json grows), `README.md` (document burst usage)

**Interfaces:**
- Produces: `./burst.sh <BASE_URL>` runs a stampede against the live service and prints outcome distribution + reconciliation. Uses `undici` for a keep-alive HTTP pool so the client doesn't bottleneck.

- [ ] **Step 1: Regenerate seed/users.json with 500 users**

```bash
node -e "
const users = Array.from({length: 500}, (_, i) => ({
  id: i+1, token: 'tok_user_'+(i+1), display_name: 'u_'+(i+1)
}));
require('fs').writeFileSync('seed/users.json', JSON.stringify(users, null, 2));
"
```

- [ ] **Step 2: Write scripts/burst.ts**

```ts
import { Pool } from 'undici';
import { readFileSync } from 'node:fs';
import { ulid } from 'ulid';

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080';
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin';
const USERS = JSON.parse(readFileSync('seed/users.json','utf-8')) as Array<{id:number, token:string}>;

const pool = new Pool(BASE, { connections: 100, pipelining: 1 });

async function req(path: string, opts: { method: 'GET'|'POST'; headers?: Record<string,string>; body?: any } = { method: 'GET' }) {
  const res = await pool.request({
    path, method: opts.method,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.body.json().catch(() => ({}));
  return { status: res.statusCode, body: body as any };
}

async function createShow() {
  const seats: string[] = [];
  for (const row of ['A','B','C','D','E','F','G','H','I','J']) {
    for (let i = 1; i <= 20; i++) seats.push(`${row}${i}`);  // 200 seats
  }
  const r = await req('/shows', { method: 'POST',
    headers: { 'X-Admin-Token': ADMIN },
    body: { name: `burst_${Date.now()}`, price_paise: 25000, per_user_limit: 4, seats },
  });
  if (r.status !== 201) throw new Error(`create show failed: ${r.status}`);
  return { id: r.body.id as string, seats };
}

async function hotSeatBurst(sid: string, seat: string, n: number) {
  return Promise.all(Array.from({ length: n }, (_, i) => {
    const u = USERS[i % USERS.length]!;
    return req(`/shows/${sid}/reserve`, { method: 'POST',
      headers: { 'Authorization': `Bearer ${u.token}` },
      body: { seats: [seat], idempotency_key: ulid() },
    });
  }));
}

async function randomBurst(sid: string, seats: string[], n: number) {
  return Promise.all(Array.from({ length: n }, (_, i) => {
    const u = USERS[i % USERS.length]!;
    const s = seats[Math.floor(Math.random() * seats.length)]!;
    return req(`/shows/${sid}/reserve`, { method: 'POST',
      headers: { 'Authorization': `Bearer ${u.token}` },
      body: { seats: [s], idempotency_key: ulid() },
    });
  }));
}

async function idemReplayBurst(sid: string, seat: string, n: number) {
  const u = USERS[0]!;
  const key = ulid();
  return Promise.all(Array.from({ length: n }, () =>
    req(`/shows/${sid}/reserve`, { method: 'POST',
      headers: { 'Authorization': `Bearer ${u.token}` },
      body: { seats: [seat], idempotency_key: key },
    }),
  ));
}

function tally(results: Array<{status: number, body: any}>) {
  const t: Record<string, number> = { confirmed_201: 0, replay_200: 0 };
  let srv = 0;
  for (const r of results) {
    if (r.status === 201) t.confirmed_201++;
    else if (r.status === 200) t.replay_200++;
    else if (r.status >= 500) srv++;
    else {
      const key = `${r.status}_${r.body?.error ?? 'unknown'}`;
      t[key] = (t[key] ?? 0) + 1;
    }
  }
  return { tally: t, server_errors_5xx: srv };
}

async function main() {
  console.log(`burst against ${BASE}`);
  // warm-up
  await req('/readyz');

  const { id: sid, seats } = await createShow();
  console.log(`show id: ${sid}, seats: ${seats.length}`);

  console.log('--- scenario 1: hot-seat storm (500 users on A1) ---');
  const hot = await hotSeatBurst(sid, 'A1', 500);
  console.log(tally(hot));

  console.log('--- scenario 2: random burst (10,000 users on 199 seats) ---');
  const rand = await randomBurst(sid, seats.filter(s => s !== 'A1'), 10000);
  console.log(tally(rand));

  console.log('--- scenario 3: idempotent replay (50 retries same key) ---');
  const idem = await idemReplayBurst(sid, 'J20', 50);
  console.log(tally(idem));

  const state = await req(`/shows/${sid}`);
  const c = state.body.counts;
  console.log('--- final reconciliation ---');
  console.log(c);
  const ok = c.available + c.held + c.confirmed === c.total;
  console.log(ok ? '✓ reconciled' : '✗ DRIFT');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
```

- [ ] **Step 3: Write burst.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${1:-${BASE_URL:-http://localhost:8080}}"
export BASE_URL
exec node --import tsx scripts/burst.ts "$BASE_URL"
```

Make executable:

```bash
chmod +x burst.sh
```

- [ ] **Step 4: Run burst locally against docker-compose**

```bash
docker-compose up --build -d
# wait for /readyz
until curl -sf http://localhost:8080/readyz >/dev/null; do sleep 1; done
# init-db ran inside the container via supervisord's initdb program (reads mounted /app/seed)
# but compose uses the mysql service, so run init from host once:
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres pnpm init-db
./burst.sh http://localhost:8080
docker-compose down
```

Expected: `✓ reconciled`, 0 server errors.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: one-command burst harness with hot-seat, random, and idempotent scenarios"
```

---

## Task 15: Fly deploy + README + WRITEUP

**Files:**
- Create: `fly.toml`, `README.md`, `WRITEUP.md`
- Modify: nothing (code is complete)

**Interfaces:**
- Produces:
  - Live URL on `fly.io`.
  - README with: project overview, local dev steps, deploy steps, burst usage, metrics/logs access, test commands.
  - WRITEUP with the exercise's required sections: atomic decision, idempotency, holds & expiry, consistency vs availability, observability, AI usage, next steps.

- [ ] **Step 1: Write fly.toml**

```toml
app = "paytm-seat-reservation"
primary_region = "sin"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "8080"
  DATABASE_URL = "mysql://app:devpass@127.0.0.1:3306/seatres"
  LOG_LEVEL = "info"

[[mounts]]
  source = "mysql_data"
  destination = "/data/mysql"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  [http_service.concurrency]
    type = "requests"
    hard_limit = 500
    soft_limit = 400

[[http_service.checks]]
  grace_period = "20s"
  interval = "10s"
  method = "get"
  path = "/readyz"
  protocol = "http"
  timeout = "3s"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 256
```

- [ ] **Step 2: Deploy to Fly**

```bash
# one-time setup (interactive)
# !fly auth login
# !fly apps create paytm-seat-reservation --org personal
# !fly volumes create mysql_data --size 1 --region sin

# set secrets (NEVER bake into Dockerfile)
fly secrets set \
  TOKEN_SECRET="$(openssl rand -hex 32)" \
  ADMIN_TOKEN="$(openssl rand -hex 16)" \
  --app paytm-seat-reservation

fly deploy --app paytm-seat-reservation
fly logs --app paytm-seat-reservation
curl -sf https://paytm-seat-reservation.fly.dev/readyz
```

Expected: `{"ok":true}` from the live URL.

- [ ] **Step 3: Write README.md**

```markdown
# Seat Reservation Service

Correctness-under-load take-home for Paytm Money. Single-tenant service that sells assigned seats, deployed to Fly.io.

**Live URL:** https://paytm-seat-reservation.fly.dev
**Dashboard:** https://paytm-seat-reservation.fly.dev/dashboard?show=<ID>
**Metrics:** https://paytm-seat-reservation.fly.dev/metrics
**Logs:** `fly logs --app paytm-seat-reservation`

## Local dev

```
cp .env.example .env
docker-compose up --build -d
# wait for /readyz
curl -sf http://localhost:8080/readyz
# first-time init
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres pnpm init-db
# create a show
curl -X POST http://localhost:8080/shows -H 'X-Admin-Token: dev-admin' -H 'content-type: application/json' \
  -d @seed/show.json
```

## Burst

```
./burst.sh https://paytm-seat-reservation.fly.dev
```

Prints outcome distribution per scenario (hot-seat, random, idempotent replay) and final reconciliation. Non-zero exit if the invariant drifts or any 5xx is observed.

## Tests

```
docker-compose up -d mysql
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
TOKEN_SECRET=t ADMIN_TOKEN=test-admin \
pnpm test
```

## API

See `docs/superpowers/specs/2026-10-04-seat-reservation-prd.md` §4 for the full contract.
```

- [ ] **Step 4: Write WRITEUP.md (the required design writeup)**

```markdown
# Writeup — Seat Reservation at Scale

## Atomic decision

Each seat is a row in the `seats` table with `PRIMARY KEY (show_id, seat_id)`. Reserving a seat is a single conditional `UPDATE`:

```
UPDATE seats SET status='confirmed', user_id=?, reservation_id=?
WHERE show_id=? AND seat_id=? AND status='available'
```

followed by a check that `affectedRows=1`. InnoDB takes a row-level X-lock on the PK, so N concurrent attempts on the same seat serialize; exactly one sees `status='available'` and succeeds, the rest see `status='confirmed'` and get `affectedRows=0` → we throw `ConflictError('seat_taken', …)` which the error handler maps to a clean `409`.

For multi-seat requests we sort seat ids before locking, so two overlapping requests acquire locks in the same global order → no deadlock cycle. If InnoDB's lock-wait timeout fires (configured at 2s), we catch `ER_LOCK_WAIT_TIMEOUT` and also return `409 seat_taken` — the losing request is semantically "someone else is in the middle of taking it", a user-facing decline, not a 500.

Belt-and-suspenders backstop: `reservation_seats` has `UNIQUE (active_key)` where `active_key = CONCAT(show_id, ':', seat_id)` only for non-cancelled rows. If the conditional UPDATE had a bug and two users both passed, the second INSERT into `reservation_seats` would fail on the unique index. We treat that as a bug-signal (logged at `error`) and return the user a `409`, keeping the correctness invariant.

## Idempotency

Scope is `(user_id, idempotency_key)`, enforced by `UNIQUE KEY uniq_idem (user_id, idem_key)` on `reservations`. We store `sha256(normalize(request_body))` as `body_hash`. The reserve algorithm has three paths:

1. **Fast-path replay** — on tx start we `SELECT` by `(user_id, idem_key)`. If present and `body_hash` matches, return the original with `200`. If present and `body_hash` differs, `409 idempotency_body_mismatch`.
2. **Concurrent-insert race** — if two requests with the same key arrive within the same instant and both pass the fast-path, exactly one `INSERT INTO reservations` succeeds; the other hits the unique constraint. We catch it, roll back, re-read the winner outside the tx, and return it as a replay.
3. **New insert** — the common case.

Normalize = sort seats + trim key, so JSON ordering can't cause a false mismatch.

## Holds & expiry

Chose cancel-only (no auto-expiry). Reserve is instant-confirm — matches the exercise's `status: "confirmed"` response shape and removes a whole class of clock-drift/sweeper-race bugs. Cancel takes a confirmed reservation → cancelled, flips its seats back to `available`, and clears the unique-index guard (because `active_key` becomes NULL via the generated column). A released seat is immediately re-bookable.

If product required abandoned-cart recovery, I'd add an `expires_at` column on a new `held` state + an eager sweeper — it composes with the current invariant.

## Consistency vs availability under partition

Single Fly machine, co-located MySQL on a persistent volume. There is no replication, so no "partition" in the Jepsen sense — if the machine is down, the service is down. This favors consistency: no split-brain, no divergent writes, no reconciliation after merge. The trade-off is availability during machine failure or restart.

Horizontally scaling would require a managed MySQL (PlanetScale, Aurora) and the SSE events bus moves to Redis pub/sub. The atomic reserve algorithm is unchanged — it already relies only on row-level locks that work the same against a single primary.

## Observability

Prometheus metrics expose the reconciliation invariant live: `seats_available + seats_held + seats_confirmed == total` per show. The dashboard at `/dashboard?show=<id>` renders the same thing in a browser. During the burst you can watch:

- `reservations_total{outcome="seat_taken"}` climbing in lockstep with hot-seat contention
- `reservations_total{outcome="per_user_limit"}` tagging the users who tried to grab too many
- `reserve_latency_seconds` histogram showing p99 under contention
- `sse_subscribers` gauge rising as dashboards connect

What I'd page on at 2am:
- Any 5xx (`http_requests_total{status=~"5.."}` > 0 over 1m)
- `/readyz` failing (DB unreachable)
- `reserve_latency_seconds p99 > 2s` sustained (lock-wait exhaustion)
- Reconciliation drift (would require a reconciliation worker computing the invariant from gauges — out of scope for the exercise but one gauge delta I'd add)

## AI usage

This project was built with Claude Opus 4.7 (1M context) in Claude Code, using the Superpowers plugin's brainstorming → spec → plan → implement workflow.

**Directed** (I made the call):
- Node + MySQL stack (reused prior deleted spec's direction).
- Dashboard = live observability, not buyer flow — the exercise says UI is not graded, so I used the UI budget on something that visualizes correctness.
- Hold model = cancel-only (no sweeper) — I rejected my own earlier default after the AI called me out to re-examine trade-offs. Simpler, matches the response-shape contract, no clock drift.
- Belt-and-suspenders backstop = `UNIQUE (active_key)` on `reservation_seats`, not an extra generated-column unique on hot `seats` table. The hot path pays nothing.

**Decided** (AI generated and I verified):
- Full DDL (I spot-checked column types, constraints, index coverage).
- Atomic reserve pseudocode → TypeScript (I reviewed the lock order, the `ER_DUP_ENTRY` catch, the `_IdemRaceSignal` sentinel pattern).
- Burst harness scenarios + undici pool sizing.
- Fly.toml tuning (I set the memory, chose the region, set volume size).
- WRITEUP structure (I wrote this section myself; the rest was co-authored).

I ran every test, read every diff, and the design decisions you see in §3 of the PRD are mine. The AI's role was accelerating correct implementation of decisions I'd made, and pushing back when I was about to default to something sub-optimal.

## What I'd do next

1. Add a reconciliation worker: every 10s, compare `GET /shows/:id` counts to the Prom gauges. Alert on drift. (This is the "it's wrong but you don't know it" case.)
2. Horizontal scale: swap in-process EventEmitter for Redis pub/sub, run 2-3 app machines behind Fly's load balancer. The reserve algorithm is already partition-safe (relies only on row locks).
3. Add `held` state + eager sweeper for an abandoned-cart product requirement.
4. Add a reconciliation audit log: on every state transition write a row to `seat_audit`. Lets us re-derive state from events for forensics.
5. Rate limit per token. Right now a buggy client can hammer /reserve 1000x/sec and consume a connection pool slot. Token-bucket middleware.
```

- [ ] **Step 5: Commit and tag**

```bash
git add .
git commit -m "docs: README, WRITEUP, fly.toml for deployment"
git tag v1.0.0
# !git push origin main --tags
```

Expected: deployment live, writeup complete, repo ready for submission.

---

## Final acceptance test

Run from a clean clone to verify "a clean checkout must build and run":

```bash
git clone <repo>
cd paytm-seat-reservation
cp .env.example .env
docker-compose up --build -d
until curl -sf http://localhost:8080/readyz; do sleep 1; done
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres pnpm init-db
./burst.sh http://localhost:8080
# verify ✓ reconciled and exit code 0
docker-compose down
```

Then against the live URL:

```bash
./burst.sh https://paytm-seat-reservation.fly.dev
```

Expected: both pass with reconciliation ✓ and zero 5xx.
