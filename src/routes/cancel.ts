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
    // Refresh gauges outside tx (pool, after cancelReservation returns)
    const [rows] = await pool.query<any[]>(
      "SELECT status, COUNT(*) AS c FROM seats WHERE show_id=? GROUP BY status", [out.show_id],
    );
    let a = 0, c = 0;
    for (const r of rows) { if (r.status === 'available') a = r.c; if (r.status === 'confirmed') c = r.c; }
    seatsAvailableGauge.set({ show_id: out.show_id }, a);
    seatsConfirmedGauge.set({ show_id: out.show_id }, c);
    res.json({ reservation_id: out.reservation_id, status: 'cancelled', cancelled_at: out.cancelled_at.toISOString() });
  } catch (e) { next(e); }
});
