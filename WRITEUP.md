# Writeup — Seat Reservation at Scale

## 1. Atomic decision

Each seat is a row in the `seats` table with `PRIMARY KEY (show_id, seat_id)`. Reserving a seat is a single conditional UPDATE:

```sql
UPDATE seats
SET status = 'confirmed', user_id = ?, reservation_id = ?
WHERE show_id = ? AND seat_id = ? AND status = 'available'
```

followed by a check that `affectedRows === 1`. InnoDB takes a row-level X-lock on the primary key, so N concurrent attempts on the same seat serialize. Exactly one request sees `status = 'available'` and succeeds; every other sees `status = 'confirmed'` and gets `affectedRows = 0`. We throw `ConflictError('seat_taken', ...)`, which the error handler maps to a clean `409 Conflict`.

**Multi-seat deadlock avoidance.** For multi-seat requests we sort seat IDs lexicographically before acquiring locks, so two overlapping requests always acquire locks in the same global order — no deadlock cycle is possible. If InnoDB's lock-wait timeout fires (configured at 2 s), we catch `ER_LOCK_WAIT_TIMEOUT` and return `409 seat_taken`. From the user's perspective: "someone else is in the middle of taking it" — a semantic decline, not a server error.

**Belt-and-suspenders backstop.** `reservation_seats` has `UNIQUE (active_key)` where `active_key = CONCAT(show_id, ':', seat_id)` for non-cancelled rows (NULL for cancelled, so the unique constraint only fires on active reservations). If the conditional UPDATE had a logic bug and two users both passed it, the second INSERT into `reservation_seats` would fail on this unique index. We treat that as a bug-signal (logged at `error`), return the user a `409`, and preserve the correctness invariant. The hot `seats` table pays nothing for this backstop — the extra constraint is on the write-once `reservation_seats` table.

**Deadlock retry loop.** Under 10 k-request random burst, InnoDB gap locks inside multi-seat transactions occasionally caused `ER_LOCK_DEADLOCK`. Rather than change isolation level mid-flight, `withTx` (in `src/db.ts`) retries the entire transaction up to 5 times on deadlock, with the same sorted-lock-order invariant on each attempt. Correctness is preserved by the idempotency fast-path: if a retried transaction was already committed, the fast-path returns the original result immediately.

*ponytail: retry loop masks contention observability; upgrade path is READ COMMITTED isolation or a (show_id, seat_id, user_id) lock-ordering tuple — see "What I'd do next".*

---

## 2. Idempotency

Scope is `(user_id, idempotency_key)`, enforced by `UNIQUE KEY uniq_idem (user_id, idem_key)` on the `reservations` table. We also store `SHA-256(normalize(request_body))` as `body_hash`. The reserve algorithm has three paths:

1. **Fast-path replay.** At transaction start we `SELECT` by `(user_id, idem_key)`. If present and `body_hash` matches, we return the original reservation with `200 OK`. If present and `body_hash` differs (same key, different seats), we return `409 idempotency_body_mismatch`. The caller must either use a new key or resend the same body.

2. **Concurrent-insert race.** If two requests with the same `(user_id, idem_key)` arrive within the same millisecond and both pass the fast-path, exactly one `INSERT INTO reservations` succeeds; the other hits the unique constraint (`ER_DUP_ENTRY`). We catch it, roll back, re-read the winner outside the transaction, and return it as a replay. From the caller's perspective: both requests get `200` with the same reservation body.

3. **New insert.** The common case — no prior record exists, transaction proceeds normally.

Normalization = sort seat IDs + trim the idempotency key, so JSON field ordering cannot cause a false mismatch.

---

## 3. Holds & expiry

**Model chosen: cancel-only (no auto-expiry, no held state).**

`POST /reserve` produces `status: "confirmed"` immediately — matching the exercise's response-shape contract. A confirmed reservation remains held until the user explicitly calls `DELETE /reserve/:id`, which transitions seats back to `available` and sets `active_key = NULL` to release the unique-index guard.

Why no sweeper: sweeper-based expiry introduces clock drift, a background worker to operate, and a race between the sweep and a user's own cancel — three new failure modes for zero product benefit given the exercise's response shape. Cancel-only is simpler, correct, and composes cleanly with a future `held` state if the product ever requires abandoned-cart recovery (add `expires_at` + background job; the current invariant is unchanged).

---

## 4. Consistency vs availability under partition

**Current deployment:** single Fly machine, co-located MySQL on a persistent volume (`mysql_data`). There is no replication, so no "partition" in the Jepsen sense. If the machine is down, the service is down. This is a deliberate consistency-over-availability trade: no split-brain, no divergent writes, no reconciliation after merge. The `/readyz` endpoint probes the DB with a 500 ms timeout and returns `503` on failure, so load balancers know immediately.

**Horizontal scale path:** swap the co-located MySQL for a managed single-primary (PlanetScale, Aurora, or Fly's managed Postgres with the same DDL). The atomic reserve algorithm is unchanged — it relies only on InnoDB row-level locks, which work identically against a remote primary. The in-process `EventEmitter` SSE bus becomes Redis pub/sub so multiple app machines can fan events to all connected dashboard clients. The reserve algorithm gains nothing from this change; only the SSE delivery layer does.

---

## 5. Observability

Prometheus metrics (at `/metrics`) expose the reconciliation invariant live:

```
seats_available{show_id} + seats_confirmed{show_id} == seats_total{show_id}
```

The dashboard at `/dashboard?show=<id>` renders this in a browser via SSE — each seat-state change pushes a delta event; clients reconnect on drop and receive a fresh baseline snapshot.

During the burst you can watch:

- `reservations_total{outcome="seat_taken"}` climbing in lockstep with hot-seat contention
- `reservations_total{outcome="per_user_limit"}` tagging users who exceeded their per-show limit
- `reserve_latency_seconds` histogram showing p99 under contention
- `sse_subscribers` gauge rising as dashboard clients connect

**What I'd page on at 2am:**

| Alert | Condition | Why |
|-------|-----------|-----|
| Any 5xx | `http_requests_total{status=~"5.."}` > 0 for 1 min | Should be zero — every known error path maps to 4xx |
| DB unreachable | `/readyz` returning non-200 | All writes fail, service is effectively down |
| Latency spike | `reserve_latency_seconds p99 > 2 s` sustained | Lock-wait exhaustion or connection pool starvation |
| Reconciliation drift | seat gauge delta != 0 for > 30 s | Indicates a bug in state transitions (would require an audit worker — see "What I'd do next") |

---

## 6. AI usage

This project was built with Claude Opus 4.7 (1M context) in Claude Code, using the Superpowers plugin's brainstorm → spec → plan → parallel-subagent workflow.

**Directed by me (Apeksha) — I made the call, AI executed:**

- **Stack choice.** Node + MySQL + Fly.io. Reused the direction from a prior deleted spec iteration.
- **Dashboard = observability, not buyer flow.** The exercise says UI is not graded. I pointed the UI budget at something that visualizes correctness (seat-state reconciliation in real time) rather than a purchase funnel.
- **Hold model = cancel-only, no sweeper.** I rejected the AI's initial default (held state + background expiry) after it walked me through the trade-offs. Simpler, no clock-drift risk, matches the response-shape contract exactly.
- **Belt-and-suspenders via `UNIQUE (active_key)` on `reservation_seats`.** I chose to put the unique index on the write-once table rather than the hot `seats` table so the hot path pays nothing.
- **Subagent-driven execution, per-task review skipped by request.** I chose speed over checkpoint reviews for Tasks 4–14; the brief coded "SKIPPED BY USER" for each.

**Decided by AI (Claude Opus 4.7) — I reviewed and accepted:**

- **Full DDL** (column types, index coverage, generated column for `active_key`). I spot-checked constraints and the generated-column expression.
- **Atomic reserve pseudocode → TypeScript.** I reviewed the lock order, the `ER_DUP_ENTRY` catch, and the `_IdemRaceSignal` sentinel pattern that threads the concurrent-insert race result back out of the transaction.
- **Burst harness** — three scenarios, undici pool sizing, reconciliation assertion. I set the scenario parameters (concurrency, seat counts).
- **Deadlock-retry loop in `withTx` (Task 14).** The implementer added a 5-retry loop with exponential backoff to eliminate ~50 `ER_LOCK_DEADLOCK` 5xx under 10 k-request random burst. I accepted the deviation after reviewing the correctness argument (idempotency fast-path on retry means no double-confirm risk).
- **Per-user limit via `SELECT ... FOR UPDATE` on the `users` row (Task 8).** The plan's original `FOR UPDATE` on a COUNT subquery caused InnoDB gap-lock deadlocks under 10-way same-user contention. The implementer switched to locking the single `users` row (no gap locks). I accepted after reviewing the locking semantics.
- **Fly.toml tuning.** I set the region (`sin`), memory (256 MB), and volume size (1 GB); the rest was AI-generated.

The design decisions in the PRD §3 are mine. The AI accelerated correct implementation of those decisions and pushed back when I was about to default to something suboptimal. Every diff was reviewed before acceptance.

---

## 7. What I'd do next

1. **Evaluate READ COMMITTED isolation or deterministic lock ordering tuple.** The 5-retry deadlock loop in `withTx` works but masks contention observability. READ COMMITTED eliminates InnoDB gap-lock cycles at the source; alternatively, sorting all FOR UPDATE queries by `(show_id, seat_id, user_id)` removes cycle risk without changing isolation level. Either is a smaller diff than the retry loop and removes one class of hidden failure. (Task 14 action item.)

2. **Reconciliation worker.** Every 10 s, query actual seat counts from the DB and compare to the Prometheus gauges. Alert on drift. This is the "it's wrong but you don't know it" gap — the invariant is enforced by constraints, but a bug in a state transition could accumulate undetected without a periodic ground-truth check.

3. **Horizontal scale: Redis pub/sub for SSE.** Replace the in-process `EventEmitter` bus with Redis pub/sub. Run 2–3 app machines behind Fly's load balancer. The reserve algorithm is unchanged (row locks are server-side).

4. **`held` state + eager sweeper.** If product adds abandoned-cart recovery: add `status = 'held'` with `expires_at`, a background job that sweeps expired holds back to `available`, and a `POST /confirm` route for two-phase purchase. Composes with the current cancel-only invariant.

5. **Rate limiting per token.** A buggy client can currently hammer `/reserve` and consume connection pool slots. Token-bucket middleware (e.g. sliding-window in Redis, or in-memory per-machine as a first step) with a `429 Too Many Requests` response.

6. **Seat audit log.** On every state transition (`available → confirmed`, `confirmed → cancelled`) write a row to `seat_audit(show_id, seat_id, from_status, to_status, reservation_id, ts)`. Lets us re-derive state from events for forensics and replay.
