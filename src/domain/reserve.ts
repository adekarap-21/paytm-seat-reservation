import { ulid } from 'ulid';
import { withTx, pool } from '../db.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

class _IdemRaceSignal extends Error { constructor() { super('idem race'); } }

export interface ReserveInput {
  show_id: string; user_id: number; seats: string[]; idem_key: string; body_hash: string;
}
export interface ReserveSuccess {
  kind: 'created' | 'replay';
  reservation_id: string; show_id: string; user_id: number;
  seats: string[]; amount_paise: number; status: 'confirmed'; created_at: Date;
}

export async function reserve(input: ReserveInput): Promise<ReserveSuccess> {
  if (input.seats.length < 1) throw new ValidationError('at least one seat required');
  const sorted = [...input.seats].sort();   // defensive — route already sorts

  try {
    return await withTx(async (conn) => {
      // Idempotency fast-path — plain snapshot read (no lock needed; handles serial replays)
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

      const [shows] = await conn.query<any[]>('SELECT id, price_paise, per_user_limit FROM shows WHERE id=?', [input.show_id]);
      if (shows.length === 0) throw new NotFoundError('show not found');
      const price = shows[0].price_paise as number;
      const perUserLimit = shows[0].per_user_limit as number;

      // Serialize same-user transactions: lock the user row to prevent concurrent limit over-run
      // ponytail: global per-user lock; per-(user,show) lock if cross-show throughput matters
      try {
        await conn.query('SELECT id FROM users WHERE id=? FOR UPDATE', [input.user_id]);
      } catch (e: any) {
        if (e?.code === 'ER_LOCK_WAIT_TIMEOUT' || e?.code === 'ER_LOCK_DEADLOCK') {
          // Could be idempotency race: another concurrent same-key request may have committed
          throw new _IdemRaceSignal();
        }
        throw e;
      }

      // Per-user limit: count user's current confirmed seats for this show (FOR UPDATE = current read)
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
          if (e?.code === 'ER_LOCK_WAIT_TIMEOUT' || e?.code === 'ER_LOCK_DEADLOCK') {
            throw new ConflictError('seat_taken', 'seat lock contention');
          }
          throw e;
        }
        if ((upd.affectedRows ?? 0) !== 1) {
          // Seat not available — check if this (user, idem_key) already has a reservation.
          // FOR UPDATE = current read, bypasses REPEATABLE READ snapshot (winner has committed
          // and released the users FOR UPDATE lock before we got here).
          // ponytail: FOR UPDATE on a committed row avoids pool exhaustion vs pool.query inside tx
          const [raceWinner] = await conn.query<any[]>(
            `SELECT id, show_id, user_id, body_hash, amount_paise, created_at
             FROM reservations WHERE user_id=? AND idem_key=? FOR UPDATE`,
            [input.user_id, input.idem_key],
          );
          if (raceWinner.length > 0) {
            const w = raceWinner[0];
            if (w.body_hash !== input.body_hash) {
              throw new ConflictError('idempotency_body_mismatch', 'same idempotency key with different body');
            }
            const [wSeats] = await conn.query<any[]>(
              `SELECT seat_id FROM reservation_seats WHERE reservation_id=? ORDER BY seat_id`, [w.id],
            );
            return {
              kind: 'replay', reservation_id: w.id, show_id: w.show_id, user_id: w.user_id,
              seats: wSeats.map((s: any) => s.seat_id), amount_paise: w.amount_paise,
              status: 'confirmed', created_at: w.created_at,
            };
          }
          throw new ConflictError('seat_taken', `seat ${seat} not available`);
        }
      }

      try {
        await conn.query(
          `INSERT INTO reservations (id, show_id, user_id, idem_key, body_hash, amount_paise, status)
           VALUES (?, ?, ?, ?, ?, ?, 'confirmed')`,
          [reservation_id, input.show_id, input.user_id, input.idem_key, input.body_hash, price * sorted.length],
        );
      } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY') {
          // Concurrent request with same (user_id, idem_key) won the race; escape tx to re-read
          throw new _IdemRaceSignal();
        }
        throw e;
      }

      const seatRows = sorted.map((s) => [reservation_id, input.show_id, s]);
      try {
        await conn.query(
          `INSERT INTO reservation_seats (reservation_id, show_id, seat_id) VALUES ?`,
          [seatRows],
        );
      } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY') {
          // ponytail: belt+suspenders backstop — schema uniq_active_seat tripped after UPDATE missed it
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
  } catch (e) {
    if (e instanceof _IdemRaceSignal) {
      // Re-read the winner outside the rolled-back tx
      const [rows] = await pool.query<any[]>(
        `SELECT r.id, r.show_id, r.user_id, r.body_hash, r.amount_paise, r.status, r.created_at
         FROM reservations r WHERE r.user_id=? AND r.idem_key=?`,
        [input.user_id, input.idem_key],
      );
      const r = rows[0];
      if (!r) {
        // Lock timeout was genuine per-user-limit contention, not an idem race
        throw new ConflictError('per_user_limit', 'per-user seat limit contention');
      }
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
}
