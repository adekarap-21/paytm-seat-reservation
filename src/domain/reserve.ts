import { ulid } from 'ulid';
import { withTx } from '../db.js';
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
}
