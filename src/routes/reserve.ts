import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../middleware/access.js';
import { reserve } from '../domain/reserve.js';
import { ValidationError } from '../domain/errors.js';
import { normalize, hashBody, ReserveBody } from '../domain/idempotency.js';
import {
  reservationsCounter, reserveLatencyHistogram,
  seatsAvailableGauge, seatsConfirmedGauge,
} from '../metrics.js';
import { pool } from '../db.js';
import { publish } from '../events.js';

export { ReserveBody };

export const reserveRouter = Router();

reserveRouter.post('/shows/:id/reserve', requireUser, async (req, res, next) => {
  const t0 = process.hrtime.bigint();
  const showId = req.params.id as string;
  try {
    const normalized = normalize(req.body);
    const hash = hashBody(normalized);
    const result = await reserve({
      show_id: showId, user_id: req.userId!,
      seats: normalized.seats, idem_key: normalized.idempotency_key, body_hash: hash,
    });
    reservationsCounter.inc({ outcome: result.kind === 'replay' ? 'idempotent_replay' : 'confirmed', show_id: showId });
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
    reserveLatencyHistogram.observe({ show_id: showId }, elapsed);
    await refreshSeatGauges(showId);
    if (result.kind === 'created') {
      const now = result.created_at.toISOString();
      for (const seat of result.seats) {
        publish({ type: 'seat', show_id: result.show_id, seat_id: seat, status: 'confirmed', user_id: result.user_id, at: now });
      }
      publish({ type: 'reservation', show_id: result.show_id, reservation_id: result.reservation_id, user_id: result.user_id, seats: result.seats, outcome: 'confirmed', at: now });
    }
    res.status(result.kind === 'replay' ? 200 : 201).json({
      reservation_id: result.reservation_id,
      show_id: result.show_id,
      user_id: result.user_id,
      seats: result.seats,
      amount_paise: result.amount_paise,
      status: 'confirmed',
      created_at: result.created_at.toISOString(),
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      reservationsCounter.inc({ outcome: 'validation_error', show_id: showId });
      return next(new ValidationError(e.issues.map((i: any) => i.message).join('; ')));
    }
    if (e?.code && e?.status === 409) reservationsCounter.inc({ outcome: e.code, show_id: showId });
    next(e);
  }
});

async function refreshSeatGauges(show_id: string) {
  const [rows] = await pool.query<any[]>(
    'SELECT status, COUNT(*) AS c FROM seats WHERE show_id=? GROUP BY status',
    [show_id],
  );
  let a = 0, c = 0;
  for (const r of rows) {
    if (r.status === 'available') a = Number(r.c);
    if (r.status === 'confirmed') c = Number(r.c);
  }
  seatsAvailableGauge.set({ show_id }, a);
  seatsConfirmedGauge.set({ show_id }, c);
}
