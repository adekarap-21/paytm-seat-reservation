# Seat Reservation at Scale — Design Spec

- **Author:** Apeksha Adekar
- **Date:** 2026-10-03
- **Status:** Draft — awaiting review
- **Context:** Paytm Money Backend Engineering take-home, "Deploy & Observe" round

---

## 1. Problem & goals

Build a JSON HTTP service that sells assigned seats for a show and lets authenticated users reserve them. The hard requirement is **correctness under contention**: at `t=0` on-sale, tens of thousands of buyers hit the same show, often fighting over the same handful of "good" seats. The service is the system of record that decides, atomically, who wins each seat.

Correctness is graded alongside **Deploy & Observe**: the running service must be reachable at a public URL, Dockerized, observable via Prometheus-style metrics and structured logs, with a one-command burst script that reproduces the stampede against the live URL.

### 1.1 Primary goals

1. **No double-sell.** A seat held or confirmed for one user can never be held or confirmed for another.
2. **No over-limit holds.** A user cannot hold more than `per_user_limit` seats for a show.
3. **Idempotent writes.** The same `(user, idempotency_key)` reserves exactly once; a replay returns the original reservation; a different body on the same key is a clean `409`.
4. **Zero 5xx under burst.** All declines are 4xx domain outcomes.
5. **Reconciliation invariant:** `available + held + confirmed == total_seats` holds at all times.
6. **Live and observable:** public URL, `/healthz`, `/readyz` (DB-checking), `/metrics` (Prometheus), structured logs with request IDs.

### 1.2 Secondary goals

- Clean clone → `docker compose up` → working local service with Postgres.
- Incremental commit history that shows the work was done in realistic steps.
- A `WRITEUP.md` that covers the atomic mechanism, idempotency, holds, CAP posture, observability, AI usage, and next steps.

---

## 2. Non-goals

- Real payment capture (reservations carry `amount_paise` but no PSP is called).
- Seat pricing tiers, promo codes, dynamic pricing.
- User signup / password flows — bearer tokens are pre-minted for the demo and burst harness.
- Multi-show search, catalog, discovery.
- Buyer-facing UI. (A tiny ops dashboard is optional and strictly budget-permitting; see §15.)
- Multi-region deploy / cross-region failover.
- Delivery of tickets (email/SMS).

---

## 3. Success criteria (how we know we're done)

When ~20,000 concurrent reservation attempts are fired at a fresh show, with a subset targeting the same "hot" seats and a subset replaying identical idempotency keys:

| # | Criterion | Measurement |
|---|---|---|
| C1 | Each hot seat has exactly one `201`; everyone else gets `409 seat_taken`. | Burst harness tallies response codes per seat; harness output asserts "unique winner". |
| C2 | Zero 5xx across the whole burst. | Harness aggregates response status; failure if any 5xx. |
| C3 | `available + held + confirmed == total_seats` continuously. | Harness polls `GET /shows/{id}` during and after the burst and checks the invariant each tick. |
| C4 | Same key, same body → one reservation. Same key, different body → `409 idempotency_key_conflict`. | Dedicated scenarios in the harness. |
| C5 | A user firing 10 parallel reserves on a `limit=4` show ends with ≤4 held. | Harness scenario + per-user tally. |
| C6 | Spoofed `user_id` in request body is ignored; a user cannot cancel another's reservation. | Integration test. |
| C7 | `/readyz` fails closed when DB is unreachable. | Local test: stop Postgres container, hit `/readyz`, expect `503`. |
| C8 | A clean clone + `docker compose up` yields a working service. | CI / local verification. |

---

## 4. Overall architecture

```
                 ┌───────────────────────────────┐
                 │        Burst Harness          │
                 │  (undici + concurrency pool)  │
                 └──────────────┬────────────────┘
                                │ HTTPS
                                ▼
┌──────────────────────────────────────────────────┐
│  Fly.io machine (always-on, min_machines=1)      │
│                                                  │
│  ┌───────────────────────────────────────────┐   │
│  │  Fastify (Node 20, TypeScript)            │   │
│  │  ├─ Auth MW (HMAC bearer verify)          │   │
│  │  ├─ Request ID MW (pino-http)             │   │
│  │  ├─ Routes:                               │   │
│  │  │    POST /shows            (admin)       │   │
│  │  │    POST /shows/:id/reserve              │   │
│  │  │    POST /reservations/:id/confirm       │   │
│  │  │    POST /reservations/:id/cancel        │   │
│  │  │    GET  /shows/:id                      │   │
│  │  │    GET  /reservations/:id               │   │
│  │  │    GET  /healthz   /readyz   /metrics  │   │
│  │  └─ Metrics (prom-client)                 │   │
│  └──────────────────┬────────────────────────┘   │
│                     │ pg (connection pool)        │
└─────────────────────┼───────────────────────────┘
                      │
                      ▼
            ┌──────────────────────┐
            │  Neon Postgres 16    │
            │  (built-in pooler)   │
            └──────────────────────┘
```

**Topology notes:**
- Single Fly machine for v1. Horizontal scale is possible without changing correctness because all contention is resolved in the DB.
- Neon's built-in pgbouncer-equivalent sits between Fly and Postgres so burst spikes don't exhaust direct connections.
- No Redis, no queue, no second datastore. One source of truth.

---

## 5. API contract

All request/response bodies are JSON. Money is **integer paise**; no floats appear anywhere. Timestamps are RFC 3339 UTC.

### 5.1 Common error shape

```json
{
  "error": {
    "code": "seat_taken",
    "message": "Seat A12 is already held or confirmed.",
    "request_id": "01HXYZ..."
  }
}
```

| HTTP | `code` values |
|---|---|
| 400 | `invalid_body`, `invalid_seats` |
| 401 | `missing_token`, `invalid_token` |
| 403 | `admin_required`, `not_owner` |
| 404 | `show_not_found`, `reservation_not_found` |
| 409 | `seat_taken`, `per_user_limit_exceeded`, `idempotency_key_conflict`, `in_flight`, `not_cancellable`, `already_confirmed`, `hold_expired` |
| 503 | `db_unavailable` (from `/readyz`) |

5xx responses are *bugs*; they must not appear in domain outcomes.

### 5.2 `POST /shows` — create a show (admin)

**Headers:** `X-Admin-Token: <shared-secret>`
**Body:**
```json
{
  "name": "friday-night",
  "seats": ["A1","A2","A3","A4","...","Z20"],
  "price_paise": 25000,
  "per_user_limit": 4,
  "hold_ttl_seconds": 120
}
```
`per_user_limit` defaults to 4; `hold_ttl_seconds` defaults to 120.

**201 response:**
```json
{
  "id": "shw_01HXYZ...",
  "name": "friday-night",
  "price_paise": 25000,
  "per_user_limit": 4,
  "hold_ttl_seconds": 120,
  "total_seats": 520,
  "available": 520,
  "held": 0,
  "confirmed": 0
}
```

**Validation:** `seats` must be non-empty, ≤5000 entries, unique within the request, each a string of 1–8 ASCII chars matching `/^[A-Z]{1,2}[0-9]{1,4}$/`.

### 5.3 `POST /shows/{id}/reserve` — reserve seats

**Headers:** `Authorization: Bearer <token>`; optional `Idempotency-Key: <key>` (also accepted inside body).
**Body:**
```json
{
  "seats": ["A12", "A13"],
  "idempotency_key": "cli-01HXYZ..."
}
```
Any `user_id` field in the body is **ignored**. Identity comes from the token.

**201 response:**
```json
{
  "reservation_id": "rsv_01HXYZ...",
  "show_id": "shw_01HXYZ...",
  "user_id": "usr_42",
  "seats": ["A12","A13"],
  "amount_paise": 50000,
  "status": "held",
  "expires_at": "2026-10-03T10:12:34Z"
}
```

**Idempotent replay (same key, same body):** returns the stored reservation with the original `201`.

**Decline matrix:**

| Condition | Code | `error.code` |
|---|---|---|
| Any requested seat already `held` or `confirmed` (by anyone else) | 409 | `seat_taken` |
| Adding these seats would push user's `held+confirmed` for this show above `per_user_limit` | 409 | `per_user_limit_exceeded` |
| Same `(user, idempotency_key)` with different `request_hash` | 409 | `idempotency_key_conflict` |
| Idempotency row exists but `reservation_id` is still NULL (very rare — original tx mid-flight or crashed) | 409 | `in_flight` |
| Show does not exist | 404 | `show_not_found` |
| Seats not part of the show, or malformed | 400 | `invalid_seats` |

### 5.4 `POST /reservations/{id}/confirm`

**Headers:** `Authorization: Bearer <token>`

Promotes the reservation from `held` → `confirmed`. Owner-only (enforced in SQL `WHERE`).

**200 response:** full reservation with `status: "confirmed"`.
**409:** `hold_expired`, `already_confirmed`, `not_cancellable` (reservation is cancelled).

### 5.5 `POST /reservations/{id}/cancel`

**Headers:** `Authorization: Bearer <token>`

Releases a `held` reservation; seats return to `available`. Owner-only.

**200 response:** `{ "reservation_id": "...", "status": "cancelled" }`
**409:** `not_cancellable` (confirmed or already cancelled). We deliberately do not leak ownership failures distinctly — a non-owner also sees `not_cancellable`.

### 5.6 `GET /shows/{id}`

Public. No auth required.

```json
{
  "id": "shw_01HXYZ...",
  "name": "friday-night",
  "price_paise": 25000,
  "per_user_limit": 4,
  "hold_ttl_seconds": 120,
  "total_seats": 520,
  "available": 480,
  "held": 15,
  "confirmed": 25,
  "seats": [
    { "label": "A1", "status": "confirmed" },
    { "label": "A2", "status": "held" },
    ...
  ]
}
```
Counts are computed in SQL; the `seats` array is optional via `?include=seats` to keep responses light under burst.

### 5.7 `GET /reservations/{id}`

Auth required, owner-only. Returns the reservation.

### 5.8 `GET /healthz`

Liveness. Returns `200 {"status":"ok"}` whenever the process is up. Does *not* check the DB.

### 5.9 `GET /readyz`

Readiness. Runs `SELECT 1` against the DB with a 500ms timeout.
- Success → `200 {"status":"ready"}`
- Failure → `503 {"status":"not_ready","error":{"code":"db_unavailable"}}`

### 5.10 `GET /metrics`

Prometheus text exposition. See §12.

---

## 6. Data model

### 6.1 DDL

```sql
-- Enums ------------------------------------------------------------
CREATE TYPE seat_status AS ENUM ('available', 'held', 'confirmed');
CREATE TYPE reservation_status AS ENUM ('held', 'confirmed', 'cancelled', 'expired');

-- shows ------------------------------------------------------------
CREATE TABLE shows (
  id               TEXT PRIMARY KEY,                 -- 'shw_' + ULID
  name             TEXT NOT NULL,
  price_paise      BIGINT NOT NULL CHECK (price_paise >= 0),
  per_user_limit   INT    NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
  hold_ttl_seconds INT    NOT NULL DEFAULT 120 CHECK (hold_ttl_seconds > 0),
  total_seats      INT    NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- seats ------------------------------------------------------------
CREATE TABLE seats (
  id              BIGSERIAL PRIMARY KEY,
  show_id         TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  status          seat_status NOT NULL DEFAULT 'available',
  held_by         TEXT,                              -- user_id
  held_until      TIMESTAMPTZ,
  reservation_id  TEXT,                              -- weak ref; no FK (reservation may not exist yet)
  version         INT  NOT NULL DEFAULT 0,
  UNIQUE (show_id, label)
);
CREATE INDEX seats_show_status_idx ON seats (show_id, status);

-- reservations -----------------------------------------------------
CREATE TABLE reservations (
  id              TEXT PRIMARY KEY,                  -- 'rsv_' + ULID
  show_id         TEXT NOT NULL REFERENCES shows(id),
  user_id         TEXT NOT NULL,
  status          reservation_status NOT NULL,
  amount_paise    BIGINT NOT NULL,
  expires_at      TIMESTAMPTZ,                       -- NULL once confirmed/cancelled
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ
);
CREATE INDEX reservations_user_show_status_idx
  ON reservations (user_id, show_id, status);

-- reservation_seats (join) ----------------------------------------
CREATE TABLE reservation_seats (
  reservation_id  TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  seat_id         BIGINT NOT NULL REFERENCES seats(id),
  PRIMARY KEY (reservation_id, seat_id)
);
CREATE INDEX reservation_seats_seat_idx ON reservation_seats (seat_id);

-- idempotency_keys ------------------------------------------------
CREATE TABLE idempotency_keys (
  user_id         TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,                     -- sha256 hex of (show_id || sorted(seats))
  reservation_id  TEXT,                              -- NULL only transiently
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
```

### 6.2 Why these shapes

- **`seats` as the mutable row of truth.** The atomic decision is a conditional UPDATE on this row. No derived state, no shadow table.
- **No FK from `seats.reservation_id` to `reservations.id`.** During a reserve transaction we set `seats.reservation_id` before the reservation row is inserted. We accept a weak reference to keep the critical section simple.
- **`version` column.** Monotonically bumped on each state change — useful for structured logs and future optimistic-concurrency extensions, cheap to maintain.
- **`idempotency_keys` is `(user_id, key)` composite PK.** Prevents cross-user key collisions and makes the atomic insert trivial.
- **`total_seats` cached on `shows`.** The reconciliation invariant checks against this; computing it from `seats` is possible but round-trippy under burst.

---

## 7. The atomic reserve algorithm (the critical section)

```
reserve(show_id, user_id, seats[], idempotency_key, request_hash):
  with db.transaction(isolation=READ_COMMITTED) as tx:

    # 0. Serialize per-(user, show) attempts.
    # Required: without this, two parallel reserves from the same user on
    # DISJOINT seats both pass the per-user limit pre-count and both commit,
    # pushing the user over the limit. Advisory lock serializes cheaply
    # (in-memory on the DB side; auto-released at commit/rollback).
    tx.execute("""
      SELECT pg_advisory_xact_lock(
        hashtext($1 || ':' || $2)::bigint
      )
    """, user_id, show_id)

    # 1. Idempotency guard
    inserted = tx.execute("""
      INSERT INTO idempotency_keys (user_id, key, request_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, key) DO NOTHING
      RETURNING key
    """, user_id, idempotency_key, request_hash)

    if not inserted:
      row = tx.query_one("""
        SELECT request_hash, reservation_id
          FROM idempotency_keys
         WHERE user_id=$1 AND key=$2
      """, user_id, idempotency_key)
      if row.request_hash != request_hash:
        raise Conflict('idempotency_key_conflict')
      if row.reservation_id is None:
        raise Conflict('in_flight')
      return load_reservation(tx, row.reservation_id)

    # 2. Lazy sweep of expired holds on just these seats
    tx.execute("""
      UPDATE seats
         SET status='available', held_by=NULL, held_until=NULL, reservation_id=NULL,
             version=version+1
       WHERE show_id=$1 AND label = ANY($2)
         AND status='held' AND held_until < now()
    """, show_id, seats)

    # 3. Per-user limit (count current held+confirmed on this show)
    current = tx.query_scalar("""
      SELECT count(*)
        FROM reservation_seats rs
        JOIN reservations r ON r.id = rs.reservation_id
       WHERE r.show_id=$1 AND r.user_id=$2
         AND r.status IN ('held','confirmed')
    """, show_id, user_id)

    if current + len(seats) > show.per_user_limit:
      raise Conflict('per_user_limit_exceeded')

    # 4. Lock target seat rows in deterministic order
    locked = tx.query_all("""
      SELECT id, label, status
        FROM seats
       WHERE show_id=$1 AND label = ANY($2)
       ORDER BY label                     -- deterministic — deadlock-free
         FOR UPDATE
    """, show_id, seats)

    if len(locked) != len(seats):
      raise BadRequest('invalid_seats')   # some labels don't belong to this show

    for s in locked:
      if s.status != 'available':
        raise Conflict('seat_taken')

    # 5. Create reservation row (status=held)
    reservation_id = 'rsv_' + ulid()
    expires_at = now() + show.hold_ttl_seconds
    amount = show.price_paise * len(seats)

    tx.execute("""
      INSERT INTO reservations (id, show_id, user_id, status, amount_paise, expires_at)
      VALUES ($1, $2, $3, 'held', $4, $5)
    """, reservation_id, show_id, user_id, amount, expires_at)

    # 6. Conditional UPDATE each locked seat — belt-and-suspenders
    for s in locked:
      updated = tx.execute("""
        UPDATE seats
           SET status='held', held_by=$1, held_until=$2,
               reservation_id=$3, version=version+1
         WHERE id=$4 AND status='available'
      """, user_id, expires_at, reservation_id, s.id)
      if updated.rowcount != 1:
        # Impossible given the FOR UPDATE above, but defends against bugs.
        raise Conflict('seat_taken')

      tx.execute("""
        INSERT INTO reservation_seats (reservation_id, seat_id)
        VALUES ($1, $2)
      """, reservation_id, s.id)

    # 7. Close the idempotency loop
    tx.execute("""
      UPDATE idempotency_keys SET reservation_id=$1
       WHERE user_id=$2 AND key=$3
    """, reservation_id, user_id, idempotency_key)

    # commit
  return reservation(id=reservation_id, status='held', ...)
```

**Why this is correct under concurrency:**

- **Hot-seat races** between different users are decided by the conditional UPDATE's `WHERE status='available'` *inside* the row lock. No read-then-write window; losers get `rowCount=0` → clean `409`.
- **Multi-seat requests** order their row locks by `label` (ascending), so two concurrent `[A12,A13]` vs `[A13,A12]` reserves can never cycle-wait → no deadlock.
- **Idempotency atomicity:** the key row and the reservation row commit in the same transaction. There is no state where "key stored, reservation missing" is externally visible.
- **Per-user limit races** between parallel requests from the *same user* are serialized by the per-`(user, show)` advisory lock in step 0. Without that lock, two parallel reserves on disjoint seats could each read `current=3`, each add one, and both commit (user ends up at 5 on a `limit=4` show). The advisory lock closes that window cheaply.
- **Transient DB errors** (e.g. `40001` under extreme load) are caught at the request layer and retried once; a second failure maps to `409 seat_taken` or the appropriate domain code — never 5xx.

**Backstop:** a partial unique index makes a double-sell physically impossible even if the algorithm has a bug:

```sql
CREATE UNIQUE INDEX seats_held_unique
  ON seats (show_id, label)
  WHERE status IN ('held','confirmed');
```

(The regular `UNIQUE (show_id, label)` already enforces label uniqueness. This partial index is additional insurance that same-label two rows cannot both be non-available simultaneously — which can only happen if someone manually introduces duplicate rows.)

---

## 8. Idempotency contract

| Scenario | Outcome |
|---|---|
| First request with `(user, key, body)` | New reservation created; row stored with `request_hash` + `reservation_id`. |
| Same `(user, key)`, identical body | `201` with the *same* reservation returned. Byte-for-byte if feasible, otherwise the current snapshot of that reservation. |
| Same `(user, key)`, different body (different seats or different show) | `409 idempotency_key_conflict`. |
| Different `user`, same `key` | Independent — composite PK means no collision. |
| Original tx crashed between INSERT and reservation creation | Transaction rolls back entirely; row never visible. Next retry gets a fresh shot. |
| Original tx in flight; replay arrives concurrently | Replay's `ON CONFLICT` sees the row, reads `reservation_id=NULL`, returns `409 in_flight`. Client retries after short backoff. In practice this window is sub-millisecond. |

**`request_hash` computation:** `sha256_hex(show_id + "\n" + sorted(seats).join(","))`. We deliberately do *not* include the token or request_id — those vary by retry and are not part of intent.

**TTL / cleanup:** keep idempotency rows for 24 hours; a daily cron (not v1) truncates older rows. For the exercise, we don't clean up — storage is negligible.

---

## 9. Hold lifecycle & expiry

### 9.1 States

```
             reserve()                 confirm()
 available ────────────▶  held  ────────────────▶  confirmed
     ▲                      │  cancel()
     │                      ├────────────────────▶  cancelled
     │                      │  held_until < now()
     └──────────────────────┘  (lazy on next reserve attempt)
```

Confirmed is terminal — never resurrectable to anything else.

### 9.2 Lazy expiry (primary)

Every reserve attempt starts with an UPDATE that flips `held → available` for the specific requested seats whose `held_until < now()`. Zero background infrastructure; the next buyer who wants the seat pays the tiny cost of cleaning it up.

### 9.3 Read-side freshness

`GET /shows/{id}`'s `held` count filters by `held_until > now()` so a stale `held` row still shows as effectively available to a UI. Example:

```sql
SELECT
  sum(CASE WHEN status='available'
           OR (status='held' AND held_until < now()) THEN 1 ELSE 0 END) AS available,
  sum(CASE WHEN status='held' AND held_until >= now()                   THEN 1 ELSE 0 END) AS held,
  sum(CASE WHEN status='confirmed'                                       THEN 1 ELSE 0 END) AS confirmed,
  count(*) AS total
FROM seats WHERE show_id=$1;
```

### 9.4 Expiry can never resurrect a confirmed seat

Every expiry UPDATE carries `WHERE status='held'`. Confirmed rows are filtered out at the SQL level — not at the application level. This is an invariant of the schema, not of the code.

---

## 10. Per-user limit enforcement

Enforced in-transaction. Steps (recap from §7):

1. Acquire `pg_advisory_xact_lock(hashtext(user_id || ':' || show_id))`. This serializes concurrent reserves from the same user on the same show.
2. Count the user's current `held` + `confirmed` seats for this show.
3. Reject with `409 per_user_limit_exceeded` if `current + requested > per_user_limit`.
4. Proceed to the seat-lock + UPDATE steps.

**Why the advisory lock is required (not optional):**

Without serialization, two parallel reserves from the same user on *disjoint* seats both read `current=3` (snapshot), each check `3+1 ≤ 4`, each lock a different seat row, and both commit — the user ends up with 5 holds on a `limit=4` show. Postgres won't raise a conflict because the writes don't overlap. REPEATABLE READ and even SERIALIZABLE don't help here cheaply (SERIALIZABLE catches it only via SSI predicate tracking, which gets expensive under 20k burst and raises `40001` broadly).

The advisory lock is purely in-memory on the DB side (hash → ticket), takes ~microseconds, and is auto-released at commit/rollback. It serializes only within `(user, show)` — different users and different shows do not contend. For the hot-seat scenario (500 *different* users on A12), it adds zero contention — each user's lock key is unique.

**Scope of the lock:** per-`(user, show)` only. Across users and across shows there is no serialization, so throughput remains fully parallel on the only axis that matters (unique seats × unique users).

---

## 11. Authentication & authorization

### 11.1 Token format

Opaque HMAC-signed bearer: `base64url(user_id) + "." + base64url(hmac_sha256(TOKEN_SECRET, user_id))`.

- Signed with `TOKEN_SECRET` from env.
- Verification is constant-time comparison; failures return `401 invalid_token`.
- No DB lookup — stays off the hot path.
- No `exp`, no `nbf`. Acceptable for the demo; documented as a known limitation.

### 11.2 Middleware

```
Authorization header missing  → 401 missing_token
Signature mismatch            → 401 invalid_token
Otherwise                     → req.user_id = decoded
```

### 11.3 Admin token

Admin endpoints (`POST /shows`) require `X-Admin-Token: <ADMIN_TOKEN>` matching an env secret. Simple shared secret, constant-time compare.

### 11.4 Ownership

Every endpoint that mutates a reservation includes `AND user_id = $req.user_id` in the SQL `WHERE`. The DB enforces ownership — the application cannot act on behalf of another user even if the body says otherwise.

The `user_id` field is explicitly stripped from request bodies before validation to make this obvious in logs.

### 11.5 Token minting

A small script `scripts/mint-tokens.ts` generates N tokens (`usr_1`..`usr_N`) + prints them one per line. Used by the burst harness. Not an HTTP endpoint.

---

## 12. Observability

### 12.1 Metrics (`/metrics`, Prometheus text format)

```
# Counters
reservations_held_total{show_id}                                # successful reserves (new hold created)
reservations_confirmed_total{show_id}                           # transitions held → confirmed
reservations_cancelled_total{show_id}                           # held → cancelled (owner-initiated)
reservations_expired_total{show_id}                             # held → available via lazy expiry
reservations_declined_total{show_id,reason}                     # reason ∈ {seat_taken, per_user_limit, idempotency_conflict, idempotent_replay, show_not_found, invalid_seats, in_flight, hold_expired, already_confirmed, not_cancellable}
http_requests_total{method,route,status}

# Gauges
seats_available{show_id}
seats_held{show_id}
seats_confirmed{show_id}
db_pool_size
db_pool_in_use

# Histograms
reservation_latency_seconds{outcome}                            # outcome ∈ {held, declined, replayed}
http_request_duration_seconds{route,status}
```

Gauges are refreshed on a 500ms interval worker (or recomputed on scrape). The brief says "Metrics must reconcile with the API state"; both come from the same DB queries.

### 12.2 Logs (pino, JSON to stdout)

Every request emits one line on entry and one on exit:

```json
{"level":"info","time":"2026-10-03T10:12:33.123Z","request_id":"01HXYZ...","method":"POST","route":"/shows/:id/reserve","status":201,"duration_ms":12,"user_id":"usr_42","show_id":"shw_...","outcome":"held","seats":["A12","A13"],"reservation_id":"rsv_...","idempotency_key":"cli-..."}
```

- `request_id`: ULID generated per request, honored from incoming `X-Request-Id` if present.
- No PII beyond `user_id`.
- Fly's log viewer is reachable with the submitter's token; we'll include the URL (or a 60s screen recording) in the README.

### 12.3 Health endpoints

- `/healthz` — process is up. Never touches dependencies.
- `/readyz` — `SELECT 1` against DB with 500ms timeout. On failure returns `503` so the platform can take the instance out of rotation.

### 12.4 What I'd page on at 2am (goes into WRITEUP)

| Alert | Why |
|---|---|
| `5xx rate > 0.5% over 2m` | Any sustained 5xx = correctness bar broken. |
| `/readyz` failing > 1m | DB is unreachable; we're refusing writes, which is correct, but needs human attention. |
| `seats_available + seats_held + seats_confirmed != total_seats` | Reconciliation drift — should be *impossible*. If it fires, there's a bug. |
| `p99 reservation_latency > 500ms over 5m` | Load above design envelope; investigate pool / DB. |
| `db_pool_in_use == db_pool_size for 30s` | Pool exhaustion imminent. |

---

## 13. Deployment topology

### 13.1 Fly.io config (`fly.toml`)

- Region: `bom` (ap-south, close to Neon's Mumbai/Singapore).
- Machine: shared-cpu-1x, 256MB.
- `min_machines_running = 1` — no cold start on reviewer's first hit.
- Internal port 8080, forced HTTPS.
- `[[services.http_checks]]` → `/healthz` every 10s.
- Secrets: `DATABASE_URL`, `TOKEN_SECRET`, `ADMIN_TOKEN`.

### 13.2 Neon

- Free tier, single project, single branch.
- Pooled connection string (`?sslmode=require&pgbouncer=true`) used by the app so burst spikes don't exhaust direct connections.
- Separate direct connection string for the migrations script.

### 13.3 Dockerfile

Multi-stage, final image is `node:20-alpine`:

```
Stage builder:
  COPY package.json pnpm-lock.yaml
  pnpm install --frozen-lockfile
  COPY src tsconfig.json
  pnpm build  # tsc → dist/
Stage runner:
  COPY --from=builder /app/node_modules
  COPY --from=builder /app/dist
  USER node
  EXPOSE 8080
  CMD ["node", "dist/server.js"]
```

### 13.4 `docker-compose.yml` (local dev)

```yaml
services:
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: devpass }
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
  app:
    build: .
    depends_on: { db: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgres://postgres:devpass@db:5432/postgres
      TOKEN_SECRET: dev-secret
      ADMIN_TOKEN: dev-admin
    ports: ["8080:8080"]
```

A single `docker compose up` after a clean clone brings the full stack online with migrations auto-applied on boot.

### 13.5 Migrations

Plain SQL files in `src/db/migrations/`, applied in filename order by a tiny bootstrap routine on process start. No ORM, no migration framework. For a 1-day project this is simplest and auditable.

---

## 14. Burst harness design

**Entry point:** `./burst.sh <BASE_URL>` → runs `node dist/scripts/burst.js <BASE_URL>`.

**Scenarios (all run in sequence, with a short pause between):**

1. **Setup.** `POST /shows` with 520 seats, `per_user_limit=4`. Mint 1000 user tokens.
2. **Hot-seat storm.** 500 users each attempt to reserve seat `A12`. Expect exactly 1 × `201`, 499 × `409 seat_taken`, 0 × 5xx.
3. **Full-house burst.** 20,000 reservation attempts targeting random seats across the hall, distributed over 1000 users with per-user concurrency = 20.
4. **Idempotency replay.** 100 users send the *same* `(user, key, body)` 20 times each. Expect 100 reservations total, with every retry returning the stored one.
5. **Idempotency conflict.** Same key as above, different seats → expect `409 idempotency_key_conflict`.
6. **Per-user-limit stress.** One user fires 10 parallel reserves on `limit=4` → expect ≤4 held after the dust settles.
7. **Reconciliation check.** Poll `GET /shows/{id}` every 100ms during the burst; assert `available + held + confirmed == total` at every tick.
8. **Final report.** Print:
   ```
   confirmed:        1842
   declined:
     seat_taken:     17891
     per_user_limit: 267
     ...
   5xx:              0
   reconciliation:   OK (available=342 held=135 confirmed=43 total=520)
   latency p50/p95/p99: 8ms / 38ms / 92ms
   ```

**Concurrency driver:** `undici.Pool` with 200 concurrent sockets × 10 pipelined requests ≈ 2000 in-flight; the loop fires 20k over ~10 seconds. Tunable via CLI flags.

**Why Node (not k6 / vegeta):** zero extra toolchain for the reviewer; `node dist/scripts/burst.js` runs anywhere Node runs.

---

## 15. Repository layout

```
paytm-seat-reservation/
├── README.md
├── WRITEUP.md
├── Dockerfile
├── docker-compose.yml
├── fly.toml
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── .env.example
├── burst.sh                                # thin wrapper: node dist/scripts/burst.js
├── src/
│   ├── server.ts                           # Fastify bootstrap
│   ├── config.ts                           # env parsing (zod)
│   ├── db/
│   │   ├── pool.ts
│   │   ├── migrate.ts
│   │   └── migrations/
│   │       ├── 001_init.sql
│   │       └── 002_partial_unique_index.sql
│   ├── auth/
│   │   ├── token.ts                        # HMAC sign/verify
│   │   └── middleware.ts
│   ├── domain/
│   │   ├── shows.ts
│   │   ├── reservations.ts                 # the atomic reserve logic
│   │   └── idempotency.ts
│   ├── routes/
│   │   ├── shows.ts
│   │   ├── reservations.ts
│   │   └── ops.ts                          # /healthz, /readyz, /metrics
│   ├── observability/
│   │   ├── metrics.ts
│   │   └── logger.ts
│   └── scripts/
│       ├── burst.ts
│       ├── seed.ts
│       └── mint-tokens.ts
└── tests/
    ├── unit/
    │   ├── token.test.ts
    │   ├── idempotency.test.ts
    │   └── reserve-decision.test.ts
    └── integration/
        ├── contention.test.ts              # 500-way race on single seat
        ├── per-user-limit.test.ts
        ├── idempotency.test.ts
        ├── expiry.test.ts
        └── ownership.test.ts               # spoofed body cannot act as another user
```

---

## 16. Build order (incremental commits, ~1 day)

Each row ends with a git commit — the reviewer should see realistic progress.

| # | Step | Est. | Commit message |
|---|---|---|---|
| 1 | Scaffold: tsconfig, Fastify, pino, pg, Dockerfile, docker-compose, migrations runner, `/healthz`, `/readyz` | 45m | `chore: scaffold Fastify + pg + docker-compose` |
| 2 | DB schema (001_init.sql) + partial unique index (002) | 30m | `feat(db): schema for shows/seats/reservations/idempotency` |
| 3 | `POST /shows` (admin) + `GET /shows/:id` + seed script + integration test | 30m | `feat(shows): create + read` |
| 4 | Auth: HMAC token sign/verify, middleware, admin header, mint-tokens script | 20m | `feat(auth): HMAC bearer tokens and admin guard` |
| 5 | `POST /shows/:id/reserve` single-seat happy path (no idempotency yet) + unit test | 45m | `feat(reserve): single-seat happy path` |
| 6 | Multi-seat all-or-nothing with sorted locking + integration test | 30m | `feat(reserve): multi-seat with deterministic lock order` |
| 7 | Per-user limit enforcement + test | 20m | `feat(reserve): per-user limit` |
| 8 | Idempotency key handling (replay + conflict) + tests | 45m | `feat(reserve): idempotency contract` |
| 9 | Hold TTL + lazy expiry + `cancel` + `confirm` endpoints + tests | 45m | `feat(reservations): confirm, cancel, lazy expiry` |
| 10 | prom-client metrics + reconciliation gauges | 30m | `feat(obs): prometheus metrics` |
| 11 | Burst script with all scenarios | 60m | `feat(scripts): one-command burst harness` |
| 12 | Local contention test (500-way race) proves correctness | 45m | `test: 500-way concurrent reserve on single seat` |
| 13 | Dockerfile prod build + Fly deploy + Neon DB + env/secrets | 60m | `chore(deploy): fly.io + neon` |
| 14 | Live burst against deployed URL; tune pool sizes until zero 5xx | 45m | `fix(perf): tune pool for 20k burst` |
| 15 | WRITEUP.md + README polish | 45m | `docs: README + WRITEUP` |
| **stretch** | Ops dashboard served at `/` | ≤120m | `feat(ui): live ops dashboard` |

Total P0: ~8h30. Dashboard is additive and skippable.

---

## 17. Trade-offs made (pointers)

Full trade-off discussion was in the brainstorming chat; summarized decisions below.

| Decision | Chosen | Why |
|---|---|---|
| Atomic mechanism | Conditional UPDATE + partial unique index backstop | Cleanest single-step decision for user-named seats. |
| Store | Postgres only | One source of truth; idempotency + seat state + per-user count all in one tx. |
| Hold model | TTL + two-step confirm | Realistic for payments; non-trivial `/confirm` is good interview surface area. |
| Multi-seat | All-or-nothing | Trivial to document and defend; invariant easy to prove under concurrency. |
| Expiry | Lazy, in-band | Zero background infra; correctness comes from SQL, not a worker. |
| Auth | HMAC opaque bearer | No DB round-trip on hot path; 20 lines of code. |
| Deploy | Fly.io + Neon | Always-on free tier + Postgres with built-in pooling. |
| CAP | CP | Correct for a system of record on unique inventory. |

---

## 18. CAP posture

During a partition where the app cannot reach the DB:
- `/readyz` returns `503` → platform removes the instance from rotation.
- In-flight requests fail with `503 db_unavailable`.
- No writes are accepted.

We trade **availability** for **correctness**, deliberately. Any AP alternative risks double-selling unique inventory, which is unacceptable for the domain.

---

## 19. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Connection pool exhaustion under 20k burst | Use Neon's built-in pooler; cap `max` pool size to Neon's limit; keep per-request DB time short. |
| Postgres `40001` serialization failures under heavy contention | Catch and retry once at request layer; if second attempt fails, return `409 seat_taken`. Never 500. |
| Fly cold start fails deploy-check | `min_machines_running=1`; `/healthz` returns 200 within 2s of boot. |
| Partial-success ambiguity | All-or-nothing explicitly documented in README + WRITEUP; integration test enforces it. |
| Idempotency "key stored, reservation missing" window | Both committed in the same tx. Replay during that window sees `reservation_id=NULL` → `409 in_flight`, extremely rare. |
| Reviewer tests from a distant region | Deploy in region close to Neon; accept one-time latency difference. |
| Fly / Neon free-tier limits hit mid-review | Monitor allowance; have fallback plan documented. |

---

## 20. Open questions / future work

- **Confirm step authentication.** v1 lets any token-holder of the owning user confirm. A real payments flow would require a payment-intent cryptographic hand-off from the PSP. Out of scope.
- **Multi-region.** Single Postgres is a single region. For a real on-sale at scale we'd move to Postgres read replicas for `GET /shows/:id` and keep the primary for writes.
- **Reservation TTL cleanup for `idempotency_keys`.** v1 keeps all keys. A daily `DELETE WHERE created_at < now() - interval '24 hours'` is a trivial follow-up.
- **Backpressure.** Under truly extreme load we'd add a token-bucket limiter at the Fastify layer to shed load gracefully with `429` instead of growing the pool queue.
- **Seat holds you can extend.** Not in scope. A `PATCH /reservations/:id/extend-hold` would be a natural follow-up.

---

## 21. Review gate

This spec is complete and ready for review. On approval, the next step is to invoke the `writing-plans` skill to produce an implementation plan broken into independently reviewable tasks.
