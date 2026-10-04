import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { requireUser } from '../middleware/access.js';
import { reserve } from '../domain/reserve.js';
import { ValidationError } from '../domain/errors.js';
import {
  reservationsCounter, reserveLatencyHistogram,
  seatsAvailableGauge, seatsConfirmedGauge,
} from '../metrics.js';
import { pool } from '../db.js';

export const ReserveBody = z.object({
  seats: z.array(z.string().min(1).max(16)).min(1).max(50)
    .refine((a) => new Set(a).size === a.length, 'duplicate seat ids'),
  idempotency_key: z.string().min(1).max(128),
});

// ponytail: inline helper; Task 9 replaces with import from src/domain/idempotency.ts
function normalizeAndHash(body: unknown): { normalized: { seats: string[]; idempotency_key: string }; hash: string } {
  const parsed = ReserveBody.parse(body);
  const normalized = { seats: [...parsed.seats].sort(), idempotency_key: parsed.idempotency_key.trim() };
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return { normalized, hash };
}

export const reserveRouter = Router();

reserveRouter.post('/shows/:id/reserve', requireUser, async (req, res, next) => {
  const t0 = process.hrtime.bigint();
  try {
    const { normalized, hash } = normalizeAndHash(req.body);
    const result = await reserve({
      show_id: req.params.id, user_id: req.userId!,
      seats: normalized.seats, idem_key: normalized.idempotency_key, body_hash: hash,
    });
    reservationsCounter.inc({ outcome: result.kind === 'replay' ? 'idempotent_replay' : 'confirmed', show_id: req.params.id });
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
    reserveLatencyHistogram.observe({ show_id: req.params.id }, elapsed);
    await refreshSeatGauges(req.params.id);
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
      reservationsCounter.inc({ outcome: 'validation_error', show_id: req.params.id });
      return next(new ValidationError(e.issues.map((i: any) => i.message).join('; ')));
    }
    if (e?.code && e?.status === 409) reservationsCounter.inc({ outcome: e.code, show_id: req.params.id });
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
