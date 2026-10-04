# Seat Reservation Service

Correctness-under-load take-home for Paytm Money. Single-tenant service that sells assigned seats with atomic per-seat locking, idempotent reservations, and a live observability dashboard. Deployed to Fly.io.

**Live URL:** (TBD — fill in after first deploy)
**Dashboard:** `https://<your-app>.fly.dev/dashboard?show=<SHOW_ID>`
**Metrics:** `https://<your-app>.fly.dev/metrics`
**Logs:** `fly logs --app paytm-seat-reservation`

---

## Local dev

### Prerequisites

- Docker + docker-compose
- Node.js 20+
- pnpm (`npm i -g pnpm`)

### Start

```bash
cp .env.example .env
docker-compose up --build -d

# Wait until healthy (readyz polls the DB)
until curl -sf http://localhost:8080/readyz; do sleep 1; done

# First-time DB init (creates tables + seeds 500 users)
DATABASE_URL=mysql://app:devpass@localhost:3307/seatres pnpm init-db

# Create a show (100 seats, ₹500 each, per-user limit 4)
curl -X POST http://localhost:8080/shows \
  -H 'X-Admin-Token: dev-admin' \
  -H 'Content-Type: application/json' \
  -d @seed/show.json
# copy the returned show id

# Open the dashboard
open "http://localhost:8080/dashboard?show=<SHOW_ID>"
```

### Stop

```bash
docker-compose down -v   # -v drops the MySQL volume too
```

---

## Tests

Unit + integration tests run against a live MySQL in Docker (same compose stack).

```bash
docker-compose up -d mysql

DATABASE_URL=mysql://app:devpass@localhost:3307/seatres \
  TOKEN_SECRET=t \
  ADMIN_TOKEN=test-admin \
  pnpm test
```

Expected output: **47 tests pass, 0 fail**.

---

## Burst load test

`burst.sh` drives three scenarios concurrently against any base URL: hot-seat contention, random-seat scatter, and idempotent replay. Exits non-zero if any 5xx is observed or the seat-count reconciliation invariant drifts.

```bash
# Against local stack (must be running)
./burst.sh http://localhost:8080

# Against the live Fly deployment
./burst.sh https://paytm-seat-reservation.fly.dev
```

Output includes per-scenario outcome distribution (`ok`, `seat_taken`, `per_user_limit`, `idempotent_replay`) and a final reconciliation check.

---

## Deploy to Fly.io (run these yourself)

> Prerequisites: [flyctl installed](https://fly.io/docs/hands-on/install-flyctl/).

```bash
# 1. Authenticate
fly auth login

# 2. Create the app (one-time)
fly apps create paytm-seat-reservation --org personal

# 3. Create a persistent volume for MySQL data (1 GB, Singapore region)
fly volumes create mysql_data --size 1 --region sin --app paytm-seat-reservation

# 4. Set secrets (never bake into the image)
fly secrets set \
  TOKEN_SECRET="$(openssl rand -hex 32)" \
  ADMIN_TOKEN="$(openssl rand -hex 16)" \
  --app paytm-seat-reservation

# 5. Deploy
fly deploy --app paytm-seat-reservation

# 6. Verify
curl -sf https://paytm-seat-reservation.fly.dev/readyz
# expected: {"ok":true}

# 7. Stream logs
fly logs --app paytm-seat-reservation

# 8. Initialize the DB on first deploy
fly ssh console --app paytm-seat-reservation \
  -C "DATABASE_URL=mysql://app:devpass@127.0.0.1:3306/seatres node dist/scripts/init-db.js"
```

After step 8, create a show via the API and update the **Live URL** at the top of this file.

---

## API summary

Full contract in `docs/superpowers/specs/2026-10-04-seat-reservation-prd.md` §4.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/readyz` | — | Health check (DB probe, 200/503) |
| `GET` | `/metrics` | — | Prometheus metrics |
| `POST` | `/shows` | Admin token | Create a show with seats |
| `GET` | `/shows/:id` | — | Show details + seat counts |
| `POST` | `/reserve` | User token | Reserve one or more seats (idempotent) |
| `DELETE` | `/reserve/:id` | User token (owner) | Cancel a reservation |
| `GET` | `/stream?show=:id` | — | SSE seat-state stream for dashboard |
| `GET` | `/dashboard` | — | Live browser dashboard |

All mutations require `Idempotency-Key: <uuid>` and `Authorization: Bearer <token>` headers (except admin routes which use `X-Admin-Token`).
