# Seat Reservation at Scale — Design Spec

- **Author:** Apeksha Adekar
- **Date:** 2026-10-03
- **Status:** Draft rev 2 — switched datastore to MySQL 8 (was Postgres)
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

- Clean clone → `docker compose up` → working local service with MySQL on port **3307** (3306 is reserved on dev machine for an unrelated DB).
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
| C7 | `/readyz` fails closed when DB is unreachable. | Local test: stop MySQL container, hit `/readyz`, expect `503`. |
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
│  Fly.io machine — app (always-on, min=1)         │
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
│                     │ mysql2 (connection pool)    │
└─────────────────────┼───────────────────────────┘
                      │ Fly internal network
                      ▼
┌──────────────────────────────────────────────────┐
│  Fly.io machine — db                             │
│   mysql:8 on persistent volume /var/lib/mysql    │
│   bind 0.0.0.0:3306 (Fly private net only)       │
└──────────────────────────────────────────────────┘
```

**Topology notes:**
- Two Fly machines in the same region/private-net: `app` and `db`. Both covered by Fly's free allowance (shared-cpu-1x × up to 3 machines + 3GB persistent volume).
- MySQL is self-hosted on a persistent Fly volume so data survives machine restarts. No managed-MySQL free tier that meets both "always on" and "free forever" exists cleanly in 2026 — self-hosting on Fly is the simplest predictable choice.
- Horizontal scaling of the app is possible without changing correctness because *all* contention is resolved in the DB (row locks + `GET_LOCK`).
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
    { "label": "A2", "status": "held" }
  ]
}
```
Counts are computed in SQL; the `seats` array is optional via `?include=seats` to keep responses light under burst.

### 5.7 `GET /reservations/{id}`

Auth required, owner-only. Returns the reservation.

### 5.8 `GET /healthz`

Liveness. Returns `200 {"status":"ok"}` whenever the process is up. Does *not* check the DB.

### 5.9 `GET /readyz`

Readiness. Runs `SELECT 1` against MySQL with a 500ms timeout.
- Success → `200 {"status":"ready"}`
- Failure → `503 {"status":"not_ready","error":{"code":"db_unavailable"}}`

### 5.10 `GET /metrics`

Prometheus text exposition. See §12.

---

## 6. Data model

### 6.1 DDL (MySQL 8)

```sql
-- shows ------------------------------------------------------------
CREATE TABLE shows (
  id               VARCHAR(32)  NOT NULL PRIMARY KEY,         -- 'shw_' + ULID
  name             VARCHAR(255) NOT NULL,
  price_paise      BIGINT       NOT NULL CHECK (price_paise >= 0),
  per_user_limit   INT          NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
  hold_ttl_seconds INT          NOT NULL DEFAULT 120 CHECK (hold_ttl_seconds > 0),
  total_seats      INT          NOT NULL,
  created_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;

-- seats ------------------------------------------------------------
-- `held_or_confirmed_key` is a generated column that stores
--   CONCAT(show_id, '|', label) when status is non-available, else NULL.
-- A UNIQUE index on it enforces: for any (show, label) at most one row
-- can be in state 'held' or 'confirmed' at a time.
-- This is the MySQL equivalent of a Postgres partial unique index and
-- serves as the physical backstop against double-sell.
CREATE TABLE seats (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  show_id         VARCHAR(32)  NOT NULL,
  label           VARCHAR(16)  NOT NULL,
  status          ENUM('available','held','confirmed') NOT NULL DEFAULT 'available',
  held_by         VARCHAR(64)  NULL,                           -- user_id
  held_until      DATETIME(6)  NULL,
  reservation_id  VARCHAR(32)  NULL,                           -- weak ref (no FK)
  version         INT          NOT NULL DEFAULT 0,
  held_or_confirmed_key VARCHAR(64) GENERATED ALWAYS AS (
    CASE WHEN status IN ('held','confirmed')
         THEN CONCAT(show_id, '|', label)
         ELSE NULL
    END
  ) VIRTUAL,
  CONSTRAINT fk_seats_show FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE,
  UNIQUE KEY uq_seats_show_label (show_id, label),
  UNIQUE KEY uq_seats_held_or_confirmed (held_or_confirmed_key),
  KEY idx_seats_show_status (show_id, status)
) ENGINE=InnoDB;

-- reservations -----------------------------------------------------
CREATE TABLE reservations (
  id              VARCHAR(32)  NOT NULL PRIMARY KEY,           -- 'rsv_' + ULID
  show_id         VARCHAR(32)  NOT NULL,
  user_id         VARCHAR(64)  NOT NULL,
  status          ENUM('held','confirmed','cancelled','expired') NOT NULL,
  amount_paise    BIGINT       NOT NULL,
  expires_at      DATETIME(6)  NULL,                           -- NULL once confirmed/cancelled
  created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  confirmed_at    DATETIME(6)  NULL,
  cancelled_at    DATETIME(6)  NULL,
  CONSTRAINT fk_reservations_show FOREIGN KEY (show_id) REFERENCES shows(id),
  KEY idx_reservations_user_show_status (user_id, show_id, status)
) ENGINE=InnoDB;

-- reservation_seats (join) ----------------------------------------
CREATE TABLE reservation_seats (
  reservation_id  VARCHAR(32) NOT NULL,
  seat_id         BIGINT      NOT NULL,
  PRIMARY KEY (reservation_id, seat_id),
  CONSTRAINT fk_rs_reservation FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE,
  CONSTRAINT fk_rs_seat        FOREIGN KEY (seat_id)        REFERENCES seats(id),
  KEY idx_rs_seat (seat_id)
) ENGINE=InnoDB;

-- idempotency_keys ------------------------------------------------
CREATE TABLE idempotency_keys (
  user_id         VARCHAR(64)  NOT NULL,
  idem_key        VARCHAR(128) NOT NULL,                       -- `key` is a MySQL reserved word
  request_hash    CHAR(64)     NOT NULL,                       -- sha256 hex
  reservation_id  VARCHAR(32)  NULL,                           -- NULL only transiently
  created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, idem_key)
) ENGINE=InnoDB;
```

### 6.2 Why these shapes

- **`seats` as the mutable row of truth.** The atomic decision is a conditional UPDATE on this row. No derived state, no shadow table.
- **No FK from `seats.reservation_id` to `reservations.id`.** During a reserve transaction we set `seats.reservation_id` before the reservation row is inserted. We accept a weak reference to keep the critical section simple.
- **`version` column.** Monotonically bumped on each state change — useful for structured logs and future optimistic-concurrency extensions, cheap to maintain.
- **Generated column + UNIQUE as the double-sell backstop.** MySQL has no partial indexes, so we use `held_or_confirmed_key` (NULL when status='available', otherwise `show_id|label`). MySQL does not include NULL values in UNIQUE enforcement — so many `available` seats are fine, but at most one `held`/`confirmed` row can share a `(show, label)` key. This is a physical guarantee independent of application logic.
- **`idempotency_keys` is `(user_id, idem_key)` composite PK.** Prevents cross-user key collisions. Column renamed from `key` since `key` is reserved in MySQL.
- **`total_seats` cached on `shows`.** The reconciliation invariant checks against this; computing it from `seats` is possible but round-trippy under burst.
- **InnoDB everywhere.** Row-level locking, deadlock detection, transactional DDL — all required.

---

## 7. The atomic reserve algorithm (the critical section)

**Important MySQL-specific note:** `GET_LOCK` is **session-scoped**, not transaction-scoped. It must be released explicitly inside a `finally` block *before* the connection is returned to the pool. If the connection drops (socket close), MySQL releases automatically — but we never rely on that.

```
reserve(show_id, user_id, seats[], idempotency_key, request_hash):

  with pool.acquire() as conn:                        # dedicated conn for the whole op
    conn.query("SET SESSION transaction_isolation = 'READ-COMMITTED'")
    lock_name = f"rsv:{user_id}:{show_id}"

    # 0. Serialize per-(user, show) attempts via a MySQL named lock.
    # Required: without this, two parallel reserves from the same user on
    # DISJOINT seats both pass the per-user limit pre-count and both commit,
    # pushing the user over the limit (writes don't overlap so InnoDB can't
    # catch it). Named lock is a cheap, in-memory mutex keyed by (user,show).
    got = conn.query_scalar("SELECT GET_LOCK(?, 5)", lock_name)
    if got != 1:
      raise Conflict('in_flight')                     # 5s wait timeout — treat as retryable

    try:
      conn.query("START TRANSACTION")

      # 1. Idempotency guard — INSERT IGNORE + check affectedRows
      conn.execute(
        "INSERT IGNORE INTO idempotency_keys (user_id, idem_key, request_hash) "
        "VALUES (?, ?, ?)",
        user_id, idempotency_key, request_hash
      )

      if conn.affected_rows() == 0:
        # Row already existed — this is a replay path.
        row = conn.query_one(
          "SELECT request_hash, reservation_id FROM idempotency_keys "
          " WHERE user_id=? AND idem_key=?",
          user_id, idempotency_key
        )
        if row.request_hash != request_hash:
          conn.query("ROLLBACK")
          raise Conflict('idempotency_key_conflict')
        if row.reservation_id is None:
          conn.query("ROLLBACK")
          raise Conflict('in_flight')
        result = load_reservation(conn, row.reservation_id)
        conn.query("COMMIT")
        return result

      # 2. Lazy sweep of expired holds on just these seats
      conn.execute(
        f"UPDATE seats "
        f"   SET status='available', held_by=NULL, held_until=NULL, "
        f"       reservation_id=NULL, version=version+1 "
        f" WHERE show_id=? AND label IN ({placeholders(seats)}) "
        f"   AND status='held' AND held_until < NOW(6)",
        show_id, *seats
      )

      # 3. Per-user limit (count current held+confirmed on this show)
      current = conn.query_scalar(
        "SELECT COUNT(*) "
        "  FROM reservation_seats rs "
        "  JOIN reservations r ON r.id = rs.reservation_id "
        " WHERE r.show_id=? AND r.user_id=? "
        "   AND r.status IN ('held','confirmed')",
        show_id, user_id
      )
      if current + len(seats) > show.per_user_limit:
        conn.query("ROLLBACK")
        raise Conflict('per_user_limit_exceeded')

      # 4. Lock target seat rows in deterministic order (sorted by label).
      # Sorting prevents cycle-wait deadlocks between concurrent multi-seat
      # requests on overlapping sets (e.g. [A12,A13] vs [A13,A12]).
      locked = conn.query_all(
        f"SELECT id, label, status "
        f"  FROM seats "
        f" WHERE show_id=? AND label IN ({placeholders(seats)}) "
        f" ORDER BY label "
        f"   FOR UPDATE",
        show_id, *seats
      )

      if len(locked) != len(seats):
        conn.query("ROLLBACK")
        raise BadRequest('invalid_seats')             # some labels don't belong to this show

      for s in locked:
        if s.status != 'available':
          conn.query("ROLLBACK")
          raise Conflict('seat_taken')

      # 5. Create reservation row (status=held)
      reservation_id = 'rsv_' + ulid()
      expires_at = now() + show.hold_ttl_seconds
      amount = show.price_paise * len(seats)

      conn.execute(
        "INSERT INTO reservations (id, show_id, user_id, status, amount_paise, expires_at) "
        "VALUES (?, ?, ?, 'held', ?, ?)",
        reservation_id, show_id, user_id, amount, expires_at
      )

      # 6. Conditional UPDATE each locked seat — belt-and-suspenders.
      # The generated-column UNIQUE on held_or_confirmed_key would also
      # fire (duplicate-key error) if two tx attempted to flip the same
      # seat concurrently — but the FOR UPDATE above already prevents it.
      for s in locked:
        conn.execute(
          "UPDATE seats "
          "   SET status='held', held_by=?, held_until=?, "
          "       reservation_id=?, version=version+1 "
          " WHERE id=? AND status='available'",
          user_id, expires_at, reservation_id, s.id
        )
        if conn.affected_rows() != 1:
          conn.query("ROLLBACK")
          raise Conflict('seat_taken')                # impossible given FOR UPDATE; defends against bugs

        conn.execute(
          "INSERT INTO reservation_seats (reservation_id, seat_id) VALUES (?, ?)",
          reservation_id, s.id
        )

      # 7. Close the idempotency loop
      conn.execute(
        "UPDATE idempotency_keys SET reservation_id=? "
        " WHERE user_id=? AND idem_key=?",
        reservation_id, user_id, idempotency_key
      )

      conn.query("COMMIT")
      return reservation(id=reservation_id, status='held', ...)

    finally:
      # Always release the named lock before returning the connection to the pool.
      conn.query("DO RELEASE_LOCK(?)", lock_name)
```

**Why this is correct under concurrency:**

- **Hot-seat races** between different users are decided by the conditional UPDATE's `WHERE status='available'` *inside* the row lock from `SELECT ... FOR UPDATE`. No read-then-write window; losers get `affectedRows=0` → clean `409`.
- **Multi-seat requests** acquire their row locks via `ORDER BY label` + `FOR UPDATE` (ascending), so two concurrent `[A12,A13]` vs `[A13,A12]` reserves can never cycle-wait → no deadlock.
- **Idempotency atomicity:** the key row and the reservation row commit in the same transaction. There is no state where "key stored, reservation missing" is externally visible to any observer who waits for commit.
- **Per-user limit races** between parallel requests from the *same user* are serialized by the per-`(user, show)` named lock in step 0. Without it, two parallel reserves on disjoint seats could each read `current=3`, each add one, and both commit (user ends up at 5 on a `limit=4` show). InnoDB would not raise a conflict because the writes don't overlap on any locked row.
- **Transient DB errors** — InnoDB deadlock (error 1213) or lock-wait timeout (error 1205) — are caught at the request layer and retried once; a second failure maps to `409 seat_taken` or `409 in_flight` as appropriate. Never 5xx.
- **The `held_or_confirmed_key` UNIQUE** is a physical backstop: even if application logic ever managed to try two concurrent transitions on the same seat without going through the SELECT FOR UPDATE path, MySQL would reject the second INSERT/UPDATE with a duplicate-key error (1062). The app treats 1062 on seats as `409 seat_taken`.

---

## 8. Idempotency contract

| Scenario | Outcome |
|---|---|
| First request with `(user, key, body)` | New reservation created; row stored with `request_hash` + `reservation_id`. |
| Same `(user, key)`, identical body | `201` with the *same* reservation returned (byte-for-byte if feasible, otherwise the current snapshot of that reservation). |
| Same `(user, key)`, different body (different seats or different show) | `409 idempotency_key_conflict`. |
| Different `user`, same `key` | Independent — composite PK means no collision. |
| Original tx crashed between INSERT IGNORE and reservation creation | Transaction rolls back entirely; row never visible. Next retry gets a fresh shot. |
| Original tx in flight; replay arrives concurrently | Replay's `GET_LOCK` on the same `(user, show)` blocks until the first commits; then the replay sees the stored `reservation_id` and returns it. In the (vanishingly rare) case the lock timed out, replay sees the row but with `reservation_id=NULL` → `409 in_flight`. |

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

Every reserve attempt starts with an UPDATE that flips `held → available` for the specific requested seats whose `held_until < NOW(6)`. Zero background infrastructure; the next buyer who wants the seat pays the tiny cost of cleaning it up.

### 9.3 Read-side freshness

`GET /shows/{id}` filters by `held_until > NOW(6)` so a stale `held` row still shows as effectively available to a UI. Example:

```sql
SELECT
  SUM(CASE WHEN status='available'
           OR (status='held' AND held_until < NOW(6)) THEN 1 ELSE 0 END) AS available,
  SUM(CASE WHEN status='held' AND held_until >= NOW(6)                   THEN 1 ELSE 0 END) AS held,
  SUM(CASE WHEN status='confirmed'                                       THEN 1 ELSE 0 END) AS confirmed,
  COUNT(*) AS total
FROM seats WHERE show_id = ?;
```

### 9.4 Expiry can never resurrect a confirmed seat

Every expiry UPDATE carries `WHERE status='held'`. Confirmed rows are filtered out at the SQL level — not at the application level. This is an invariant of the schema, not of the code.

---

## 10. Per-user limit enforcement

Enforced in-transaction. Steps (recap from §7):

1. Acquire `GET_LOCK('rsv:' || user_id || ':' || show_id, 5)` (5-second wait). On failure returns 0 → return `409 in_flight`.
2. Count the user's current `held` + `confirmed` seats for this show.
3. Reject with `409 per_user_limit_exceeded` if `current + requested > per_user_limit`.
4. Proceed to the seat-lock + UPDATE steps.
5. In `finally`, call `DO RELEASE_LOCK('rsv:...')` before returning the connection to the pool.

**Why the named lock is required (not optional):**

Without serialization, two parallel reserves from the same user on *disjoint* seats both read `current=3` (snapshot), each check `3+1 ≤ 4`, each lock a different seat row, and both commit — the user ends up with 5 holds on a `limit=4` show. InnoDB won't raise a conflict because the writes don't overlap on any locked row. REPEATABLE READ in MySQL doesn't close this window either; the `COUNT(*)` is a snapshot read that neither acquires locks nor conflicts with disjoint INSERTs.

`GET_LOCK` is a MySQL named-lock primitive: cheap (in-memory mutex on the server), keyed by an application-chosen string, serializes only threads asking for the *same* name. It takes a wait-timeout argument (we use 5s). For the hot-seat scenario (500 *different* users on A12), each user's lock name is unique → zero added contention. For the per-user storm (one user firing 10 parallel reserves), the lock name is identical → the 10 attempts serialize cleanly through the critical section one at a time.

**Scope of the lock:** per-`(user, show)` only. Across users and across shows there is no serialization — throughput remains fully parallel on the only axis that matters (unique seats × unique users).

**Lifecycle discipline:** named locks are session-scoped. The `finally` block *must* release the lock before the connection returns to the pool, or the next request routed to that connection will inherit it. The implementation wraps this in a `withUserShowLock(conn, user, show, fn)` helper so no code path can forget.

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
mysql_pool_size
mysql_pool_in_use
mysql_pool_queue_depth

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
- `/readyz` — `SELECT 1` against MySQL with 500ms timeout. On failure returns `503` so the platform can take the instance out of rotation.

### 12.4 What I'd page on at 2am (goes into WRITEUP)

| Alert | Why |
|---|---|
| `5xx rate > 0.5% over 2m` | Any sustained 5xx = correctness bar broken. |
| `/readyz` failing > 1m | DB is unreachable; we're refusing writes (correct) but needs human attention. |
| `seats_available + seats_held + seats_confirmed != total_seats` | Reconciliation drift — should be *impossible*. If it fires, there's a bug. |
| `p99 reservation_latency > 500ms over 5m` | Load above design envelope; investigate pool / DB. |
| `mysql_pool_in_use == mysql_pool_size for 30s` | Pool exhaustion imminent. |
| `innodb_row_lock_waits spiking` | Hot-seat contention or lock discipline issue. |

---

## 13. Deployment topology

### 13.1 Fly.io config

**App machine (`fly.toml` for the app):**
- Region: `bom` (ap-south).
- Machine: shared-cpu-1x, 256MB.
- `min_machines_running = 1` — no cold start on reviewer's first hit.
- Internal port 8080, forced HTTPS.
- `[[services.http_checks]]` → `/healthz` every 10s.
- Secrets: `DATABASE_URL`, `TOKEN_SECRET`, `ADMIN_TOKEN`.

**DB machine (separate Fly app `seatres-db`):**
- Region: same (`bom`).
- Machine: shared-cpu-1x, 512MB (MySQL needs more than the app).
- 3GB persistent volume mounted at `/var/lib/mysql`.
- Not exposed to the public internet — bound to Fly's private 6PN network.
- `my.cnf` tuned for small instance: `innodb_buffer_pool_size=256M`, `max_connections=200`, `innodb_flush_log_at_trx_commit=1` (default — safety over speed; we're not benchmarking raw TPS).
- Healthcheck: `mysqladmin ping` every 10s.

### 13.2 Connection string

`DATABASE_URL=mysql://app:<password>@seatres-db.internal:3306/seatres`

The internal `.internal` hostname resolves via Fly 6PN DNS. TLS is optional on the private network; we leave it off to keep things simple. Pool size tuned to 50 (well under MySQL's `max_connections`).

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
      # Local 3307 → container 3306 (host 3306 is reserved for the org DB)
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
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL: mysql://app:devpass@db:3306/seatres
      TOKEN_SECRET: dev-secret
      ADMIN_TOKEN: dev-admin
    ports:
      - "8080:8080"

volumes:
  mysql_data:
```

A single `docker compose up` after a clean clone brings the full stack online with migrations auto-applied on boot. The host-side port `3307` is intentional — on the dev machine, `3306` is reserved for an unrelated org MySQL instance.

### 13.5 Migrations

Plain SQL files in `src/db/migrations/`, applied in filename order by a tiny bootstrap routine on process start. No ORM, no migration framework. For a 1-day project this is simplest and auditable.

A `schema_migrations(filename VARCHAR(255) PRIMARY KEY, applied_at DATETIME(6))` table tracks what's been applied. The bootstrap runs each not-yet-applied `.sql` file in a transaction, then inserts the filename.

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
├── fly.app.toml                             # app machine
├── fly.db.toml                              # db machine
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── .env.example
├── burst.sh                                 # thin wrapper: node dist/scripts/burst.js
├── src/
│   ├── server.ts                            # Fastify bootstrap
│   ├── config.ts                            # env parsing (zod)
│   ├── db/
│   │   ├── pool.ts                          # mysql2 pool
│   │   ├── with-user-show-lock.ts           # GET_LOCK / RELEASE_LOCK helper
│   │   ├── migrate.ts
│   │   └── migrations/
│   │       ├── 001_init.sql
│   │       └── 002_held_unique_backstop.sql  # the generated-column + UNIQUE
│   ├── auth/
│   │   ├── token.ts                         # HMAC sign/verify
│   │   └── middleware.ts
│   ├── domain/
│   │   ├── shows.ts
│   │   ├── reservations.ts                  # the atomic reserve logic
│   │   └── idempotency.ts
│   ├── routes/
│   │   ├── shows.ts
│   │   ├── reservations.ts
│   │   └── ops.ts                           # /healthz, /readyz, /metrics
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
        ├── contention.test.ts               # 500-way race on single seat
        ├── per-user-limit.test.ts
        ├── idempotency.test.ts
        ├── expiry.test.ts
        └── ownership.test.ts                # spoofed body cannot act as another user
```

---

## 16. Build order (incremental commits, ~1 day)

Each row ends with a git commit — the reviewer should see realistic progress.

| # | Step | Est. | Commit message |
|---|---|---|---|
| 1 | Scaffold: tsconfig, Fastify, pino, mysql2, Dockerfile, docker-compose (MySQL on 3307), migrations runner, `/healthz`, `/readyz` | 45m | `chore: scaffold Fastify + mysql2 + docker-compose` |
| 2 | DB schema (001_init.sql) + generated-column UNIQUE backstop (002) | 30m | `feat(db): schema for shows/seats/reservations/idempotency` |
| 3 | `POST /shows` (admin) + `GET /shows/:id` + seed script + integration test | 30m | `feat(shows): create + read` |
| 4 | Auth: HMAC token sign/verify, middleware, admin header, mint-tokens script | 20m | `feat(auth): HMAC bearer tokens and admin guard` |
| 5 | `POST /shows/:id/reserve` single-seat happy path (no idempotency yet) + unit test | 45m | `feat(reserve): single-seat happy path` |
| 6 | Multi-seat all-or-nothing with sorted locking + integration test | 30m | `feat(reserve): multi-seat with deterministic lock order` |
| 7 | Per-user limit enforcement with `GET_LOCK` helper + test | 30m | `feat(reserve): per-user limit via named lock` |
| 8 | Idempotency key handling (replay + conflict) + tests | 45m | `feat(reserve): idempotency contract` |
| 9 | Hold TTL + lazy expiry + `cancel` + `confirm` endpoints + tests | 45m | `feat(reservations): confirm, cancel, lazy expiry` |
| 10 | prom-client metrics + reconciliation gauges | 30m | `feat(obs): prometheus metrics` |
| 11 | Burst script with all scenarios | 60m | `feat(scripts): one-command burst harness` |
| 12 | Local contention test (500-way race) proves correctness | 45m | `test: 500-way concurrent reserve on single seat` |
| 13 | Dockerfile prod build + Fly deploy (app + db machines, volume) + secrets | 75m | `chore(deploy): fly.io app + self-hosted mysql on volume` |
| 14 | Live burst against deployed URL; tune pool sizes until zero 5xx | 45m | `fix(perf): tune pool for 20k burst` |
| 15 | WRITEUP.md + README polish | 45m | `docs: README + WRITEUP` |
| **stretch** | Ops dashboard served at `/` | ≤120m | `feat(ui): live ops dashboard` |

Total P0: ~9 hours. Dashboard is additive and skippable.

---

## 17. Trade-offs made (pointers)

Full trade-off discussion was in the brainstorming chat; summarized decisions below.

| Decision | Chosen | Why |
|---|---|---|
| Atomic mechanism | Conditional UPDATE + generated-column UNIQUE backstop | Cleanest single-step decision for user-named seats; MySQL's partial-index-equivalent via generated column. |
| Store | MySQL 8 (InnoDB) | User choice. All concurrency primitives we need (row locks via `FOR UPDATE`, named locks via `GET_LOCK`, generated columns + UNIQUE) are present. |
| Per-user serialization | `GET_LOCK` named lock | MySQL's equivalent to a Postgres advisory lock. Session-scoped so we release in `finally`. |
| Hold model | TTL + two-step confirm | Realistic for payments; non-trivial `/confirm` is good interview surface area. |
| Multi-seat | All-or-nothing | Trivial to document and defend; invariant easy to prove under concurrency. |
| Expiry | Lazy, in-band | Zero background infra; correctness comes from SQL, not a worker. |
| Auth | HMAC opaque bearer | No DB round-trip on hot path; 20 lines of code. |
| Deploy | Fly.io app + self-hosted MySQL on Fly volume | Always-on free tier; standard MySQL semantics (no PlanetScale / TiDB protocol quirks); no managed MySQL free tier worth using in 2026. |
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
| Connection pool exhaustion under 20k burst | `mysql2` pool sized to 50 against MySQL's `max_connections=200`; keep per-request DB time short; queue-depth gauge for visibility. |
| InnoDB deadlock (1213) or lock-wait timeout (1205) under heavy contention | Catch and retry once at request layer; if second attempt fails, return `409 seat_taken` or `409 in_flight`. Never 5xx. |
| `GET_LOCK` not released due to code path bug | Centralized `withUserShowLock(conn, ...)` helper puts `RELEASE_LOCK` in a `finally` block. Connection drop also releases it. Metric for in-flight locks aids debugging. |
| Fly cold start fails deploy-check | `min_machines_running=1` on the app; DB volume persists across machine restarts; `/healthz` returns 200 within 2s of boot. |
| DB machine OOM under burst | MySQL on 512MB instance with `innodb_buffer_pool_size=256M`; verify under local burst before deploy. Fallback: upsize to 1GB machine (still within free allowance). |
| Partial-success ambiguity | All-or-nothing explicitly documented in README + WRITEUP; integration test enforces it. |
| Idempotency "key stored, reservation missing" window | Both committed in the same tx; replay during that window sees `reservation_id=NULL` → `409 in_flight`, extremely rare because `GET_LOCK` serializes. |
| Self-hosted MySQL has no managed backups | Out of scope for a 1-day exercise; documented in open questions. For prod we'd move to a managed MySQL or run `mysqldump` to Fly volume on cron. |
| Local dev MySQL collides with org DB on 3306 | Compose binds host-side `3307:3306`; documented in README. |

---

## 20. Open questions / future work

- **Confirm step authentication.** v1 lets any token-holder of the owning user confirm. A real payments flow would require a payment-intent cryptographic hand-off from the PSP. Out of scope.
- **Multi-region.** Single MySQL is a single region. For a real on-sale at scale we'd move to MySQL read replicas for `GET /shows/:id` and keep the primary for writes.
- **Managed MySQL / backups.** v1 uses self-hosted MySQL on a Fly volume with no backup strategy. A real deploy would use a managed MySQL offering (AWS RDS / PlanetScale / Aiven) with PITR.
- **TTL cleanup for `idempotency_keys`.** v1 keeps all keys. A daily `DELETE WHERE created_at < NOW(6) - INTERVAL 1 DAY` is a trivial follow-up.
- **Backpressure.** Under truly extreme load we'd add a token-bucket limiter at the Fastify layer to shed load gracefully with `429` instead of growing the pool queue.
- **Seat holds you can extend.** Not in scope. A `PATCH /reservations/:id/extend-hold` would be a natural follow-up.

---

## 21. Review gate

This spec is complete and ready for review. On approval, the next step is to invoke the `writing-plans` skill to produce an implementation plan broken into independently reviewable tasks.
