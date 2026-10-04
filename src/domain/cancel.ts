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
