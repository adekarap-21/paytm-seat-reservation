import { createHash } from 'node:crypto';
import { z } from 'zod';

const Schema = z.object({
  seats: z.array(z.string().min(1).max(16)).min(1).max(50)
    .refine((a) => new Set(a).size === a.length, 'duplicate seat ids'),
  idempotency_key: z.string().min(1).max(128),
});

// Re-exported as ReserveBody so src/routes/reserve.ts can pass it through to Task 6's unit test
export { Schema as ReserveBody };

export interface NormalizedBody { seats: string[]; idempotency_key: string; }

export function normalize(raw: unknown): NormalizedBody {
  const p = Schema.parse(raw);
  return { seats: [...p.seats].sort(), idempotency_key: p.idempotency_key.trim() };
}

export function hashBody(n: NormalizedBody): string {
  return createHash('sha256').update(JSON.stringify(n)).digest('hex');
}
