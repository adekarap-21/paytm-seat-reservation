import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { pool, withTx } from '../db.js';
import { requireAdmin } from '../middleware/access.js';
import { ValidationError, NotFoundError, ConflictError } from '../domain/errors.js';
import { seatsAvailableGauge, seatsConfirmedGauge } from '../metrics.js';

const CreateBody = z.object({
  name: z.string().min(1).max(128),
  price_paise: z.number().int().positive(),
  per_user_limit: z.number().int().positive().max(100).default(4),
  seats: z.array(z.string().min(1).max(16)).min(1).max(10000),
});

export const showsRouter = Router();

showsRouter.post('/shows', requireAdmin, async (req, res, next) => {
  try {
    const body = CreateBody.parse(req.body);
    if (new Set(body.seats).size !== body.seats.length) {
      throw new ValidationError('duplicate seat ids in request body');
    }
    const id = ulid();
    await withTx(async (conn) => {
      try {
        await conn.query(
          'INSERT INTO shows (id, name, price_paise, per_user_limit, total_seats) VALUES (?, ?, ?, ?, ?)',
          [id, body.name, body.price_paise, body.per_user_limit, body.seats.length],
        );
      } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY') throw new ConflictError('conflict', 'show name already exists');
        throw e;
      }
      // Bulk insert seats
      const values = body.seats.map((s) => [id, s]);
      await conn.query('INSERT INTO seats (show_id, seat_id) VALUES ?', [values]);
    });
    seatsAvailableGauge.set({ show_id: id }, body.seats.length);
    seatsConfirmedGauge.set({ show_id: id }, 0);
    res.status(201).json({
      id, name: body.name, price_paise: body.price_paise, per_user_limit: body.per_user_limit,
      seats: body.seats.map((s) => ({ seat_id: s, status: 'available' })),
    });
  } catch (e) {
    if (e instanceof z.ZodError) return next(new ValidationError(e.issues.map(i => i.message).join('; ')));
    next(e);
  }
});

showsRouter.get('/shows/:id', async (req, res, next) => {
  try {
    const [shows] = await pool.query<any[]>('SELECT * FROM shows WHERE id=?', [req.params.id]);
    if (shows.length === 0) throw new NotFoundError('show not found');
    const show = shows[0];
    const [seats] = await pool.query<any[]>(
      'SELECT seat_id, status FROM seats WHERE show_id=? ORDER BY seat_id', [req.params.id],
    );
    const counts = { available: 0, held: 0, confirmed: 0, total: seats.length };
    for (const s of seats) counts[s.status as 'available'|'held'|'confirmed']++;
    res.json({
      id: show.id, name: show.name, price_paise: show.price_paise, per_user_limit: show.per_user_limit,
      counts, seats,
    });
  } catch (e) { next(e); }
});
