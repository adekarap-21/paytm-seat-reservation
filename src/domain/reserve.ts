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
  if (input.seats.length !== 1) throw new ValidationError('single-seat only in this build'); // ponytail: temporary guard, Task 7 removes it
  const seat = input.seats[0]!;

  return withTx(async (conn) => {
    const [shows] = await conn.query<any[]>('SELECT id, price_paise FROM shows WHERE id=?', [input.show_id]);
    if (shows.length === 0) throw new NotFoundError('show not found');
    const price = shows[0].price_paise as number;

    const reservation_id = ulid();
    const [upd] = await conn.query<any>(
      `UPDATE seats SET status='confirmed', user_id=?, reservation_id=?
       WHERE show_id=? AND seat_id=? AND status='available'`,
      [input.user_id, reservation_id, input.show_id, seat],
    );
    if ((upd.affectedRows ?? 0) !== 1) {
      throw new ConflictError('seat_taken', 'seat already taken');
    }

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
