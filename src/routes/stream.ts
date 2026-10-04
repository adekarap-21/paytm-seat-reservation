import { Router } from 'express';
import { pool } from '../db.js';
import { subscribe } from '../events.js';
import { sseSubscribersGauge } from '../metrics.js';
import { NotFoundError } from '../domain/errors.js';

export const streamRouter = Router();

streamRouter.get('/shows/:id/stream', async (req, res, next) => {
  try {
    const show_id = req.params.id;
    const [shows] = await pool.query<any[]>('SELECT id FROM shows WHERE id=?', [show_id]);
    if ((shows as any[]).length === 0) throw new NotFoundError('show not found');

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const [seats] = await pool.query<any[]>(
      'SELECT seat_id, status FROM seats WHERE show_id=? ORDER BY seat_id', [show_id],
    );
    const counts = { available: 0, held: 0, confirmed: 0, total: (seats as any[]).length };
    for (const s of seats as any[]) counts[s.status as 'available' | 'held' | 'confirmed']++;
    res.write(`data: ${JSON.stringify({ type: 'baseline', show_id, counts, seats })}\n\n`);

    sseSubscribersGauge.inc({ show_id });

    const unsub = subscribe(show_id, (ev) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const keep = setInterval(() => res.write(`: keepalive\n\n`), 20000);

    req.on('close', () => {
      clearInterval(keep);
      unsub();
      sseSubscribersGauge.dec({ show_id });
    });
  } catch (e) { next(e); }
});
